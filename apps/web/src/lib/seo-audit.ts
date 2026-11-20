import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { after } from "next/server";
import { and, asc, desc, eq, gt } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { aiCall, intakeFile, pagePlanPage, seoAudit, siteImport } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { SEO_AUDIT_JOB, seoAuditJobId } from "@tawd/core/queue";
import { costOf, formatCost } from "@tawd/core/mockups";
import { isPrivateAddress, publicOnlyLookup } from "@tawd/core/public-address";
import { auditBand, leftOutUrls, mergeRedirects, parseSitemap, pathOf, redirectMap, type RankedPage, type RedirectRow } from "@tawd/core/site";
import { getQueue } from "@/lib/mockups";
import { addProjectAddon, listAddons, projectAddons } from "@/lib/pricing";
import { SeoDataError, dataForSeoCall, getSeoLimit, seoSetup, seoSpendThisMonth } from "@/lib/seo-data";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  SEO audits of the client's current website (Jason, 26 September 2026).

  The "Don't lose it" check is included for every project with a website:
  it runs by itself when the intake's current website is saved. It reads
  the sitemap (free), asks DataForSEO which pages rank (a small lookup,
  within the SEO data cap), and maps each old address to its new page.

  The full audit is a paid add-on priced by the site's size: TAWD counts
  the pages from the sitemap (free) and suggests the band. It crawls the
  site with DataForSEO's On-Page API (estimate first, within the SEO cap),
  asks Google PageSpeed (free), adds the rankings and the redirect map, and
  the Senior SEO agent writes the report. A Screaming Frog export is
  optional extra evidence; the audit never waits for one.
*/

type Db = Database;

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

/* DataForSEO's prices as TAWD understands them (check before going live): On-Page per page crawled, Labs ranked keywords per request and per result. */
export const AUDIT_PRICES = { crawlPerPage: 0.000125, rankedPerRequest: 0.01, rankedPerItem: 0.0001, rankedItems: 1000 };
export const AUDIT_REPORT_GUESS = { inputTokens: 25_000, outputTokens: 5_000 };
const MAX_PAGES = 2000;

/* ---------- fetching from the client's site ---------- */

type Fetch = typeof fetch;
let siteFetch: Fetch | null = null;
let pageSpeedFetch: Fetch | null = null;
let waitFor: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lookup: (host: string) => Promise<string[]> = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Tests pass stand-ins for the client's site, PageSpeed and the clock. */
export function setAuditStandInsForTesting(stand: { site?: Fetch | null; pageSpeed?: Fetch | null; wait?: (ms: number) => Promise<void>; lookup?: (host: string) => Promise<string[]> } | null): void {
  siteFetch = stand?.site ?? null;
  pageSpeedFetch = stand?.pageSpeed ?? null;
  waitFor = stand?.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  lookup = stand?.lookup ?? (async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address));
}

const MAX_TEXT_BYTES = 5_000_000;

/* True when TAWD won't open this address: only public web addresses, never the server's own network. */
async function refusePrivate(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  return addresses.length === 0 || addresses.some(isPrivateAddress);
}

type Answer = { status: number; location: string | null; read: () => Promise<string>; close: () => void };

/* A stand-in's answer (tests): the body up to MAX_TEXT_BYTES. */
function fromResponse(response: Response): Answer {
  return {
    status: response.status,
    location: response.headers.get("location"),
    read: async () => {
      if (!response.body) return "";
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= MAX_TEXT_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      return Buffer.concat(chunks).toString("utf8").slice(0, MAX_TEXT_BYTES);
    },
    close: () => void response.body?.cancel().catch(() => undefined),
  };
}

/*
  A compressed answer unpacked (node:http doesn't, unlike fetch); an
  encoding TAWD can't unpack is read as it came.
*/
export function unpacked(response: http.IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(zlib.createGunzip());
  if (encoding === "deflate") return response.pipe(zlib.createInflate());
  if (encoding === "br") return response.pipe(zlib.createBrotliDecompress());
  return response;
}

/*
  One request, no redirects followed, connected only to the addresses
  publicOnlyLookup checked (no second DNS answer between the check and the
  connection), the body unpacked and read up to MAX_TEXT_BYTES (counted
  after unpacking) and cut there.
*/
function openOnce(url: string): Promise<Answer> {
  const parsed = new URL(url);
  const get = parsed.protocol === "https:" ? https.get : http.get;
  return new Promise((resolve, reject) => {
    const request = get(parsed, { lookup: publicOnlyLookup, signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "TAWD site check (Velocity Media Lab)" } }, (response) => {
      const location = response.headers.location ?? null;
      resolve({
        status: response.statusCode ?? 0,
        location,
        read: () =>
          new Promise<string>((done, fail) => {
            const body = unpacked(response);
            const chunks: Buffer[] = [];
            let size = 0;
            body.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              size += chunk.length;
              if (size >= MAX_TEXT_BYTES) {
                response.destroy();
                if (body !== response) (body as zlib.Gunzip).destroy();
                done(Buffer.concat(chunks).toString("utf8").slice(0, MAX_TEXT_BYTES));
              }
            });
            body.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
            body.on("error", (error: Error) => {
              response.destroy();
              fail(error);
            });
            response.on("error", fail);
          }),
        close: () => response.destroy(),
      });
    });
    request.on("error", reject);
  });
}

/*
  A page from the client's site. Redirects are followed here, at most five,
  and every hop is checked public before it's opened (13 October 2026, the
  whole-code review: before, only the first address was checked).
*/
async function getText(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (await refusePrivate(current)) return null;
    let answer: Answer;
    try {
      answer = siteFetch
        ? fromResponse(await siteFetch(current, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "TAWD site check (Velocity Media Lab)" } }))
        : await openOnce(current);
    } catch {
      return null;
    }
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      answer.close();
      try {
        current = new URL(answer.location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) {
      answer.close();
      return null;
    }
    try {
      return await answer.read();
    } catch {
      return null;
    }
  }
  return null;
}

function siteRoot(url: string): { origin: string; host: string } | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return { origin: parsed.origin, host: parsed.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/* The site's pages from its sitemap(s), same site only; the home page's links if it has none. */
export async function sitemapPages(siteUrl: string): Promise<{ url: string }[]> {
  const root = siteRoot(siteUrl);
  if (!root) return [];
  const sameSite = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "") === root.host;
    } catch {
      return false;
    }
  };
  const robots = (await getText(`${root.origin}/robots.txt`)) ?? "";
  const queue = [...new Set([...[...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]!), `${root.origin}/sitemap.xml`, `${root.origin}/sitemap_index.xml`])];
  const urls = new Set<string>();
  const read = new Set<string>();
  while (queue.length && read.size < 12 && urls.size < MAX_PAGES) {
    const next = queue.shift()!;
    if (read.has(next) || !sameSite(next)) continue;
    read.add(next);
    const xml = await getText(next);
    if (!xml) continue;
    const found = parseSitemap(xml);
    queue.push(...found.sitemaps);
    for (const url of found.urls) if (sameSite(url) && urls.size < MAX_PAGES) urls.add(url.split("#")[0]!);
  }
  if (urls.size === 0) {
    const home = await getText(`${root.origin}/`);
    if (home === null) return [];
    urls.add(`${root.origin}/`);
    for (const m of home.matchAll(/href=["']([^"'#]+)["']/gi)) {
      try {
        const url = new URL(m[1]!, `${root.origin}/`).toString();
        if (sameSite(url) && !/\.(jpg|jpeg|png|gif|svg|pdf|css|js|webp|ico)$/i.test(url)) urls.add(url.split("#")[0]!);
      } catch {
        // Not an address.
      }
    }
  }
  return [...urls].map((url) => ({ url }));
}

/* ---------- rankings ---------- */

interface RankedItem {
  keyword_data?: { keyword?: string; keyword_info?: { search_volume?: number | null } };
  ranked_serp_element?: { serp_item?: { url?: string; rank_absolute?: number; etv?: number | null } };
}

/* Which of the site's pages rank, from DataForSEO Labs (one request). */
async function rankings(run: Parameters<typeof dataForSeoCall>[0], host: string): Promise<RankedPage[]> {
  const answer = await dataForSeoCall(run, "ranked_keywords", "/v3/dataforseo_labs/google/ranked_keywords/live", [{ target: host, location_name: "United States", language_name: "English", limit: AUDIT_PRICES.rankedItems }]);
  const items = ((answer.tasks?.[0]?.result?.[0] as { items?: RankedItem[] } | undefined)?.items ?? []) as RankedItem[];
  const byUrl = new Map<string, RankedPage & { topVolume: number }>();
  for (const item of items) {
    const url = item.ranked_serp_element?.serp_item?.url;
    if (!url) continue;
    const entry = byUrl.get(url) ?? { url, keywords: 0, bestPosition: null, traffic: 0, topKeyword: null, topVolume: -1 };
    entry.keywords += 1;
    const position = item.ranked_serp_element?.serp_item?.rank_absolute ?? null;
    if (position !== null && (entry.bestPosition === null || position < entry.bestPosition)) entry.bestPosition = position;
    entry.traffic += Math.round(item.ranked_serp_element?.serp_item?.etv ?? 0);
    const volume = item.keyword_data?.keyword_info?.search_volume ?? 0;
    if (volume > entry.topVolume) {
      entry.topVolume = volume;
      entry.topKeyword = item.keyword_data?.keyword ?? null;
    }
    byUrl.set(url, entry);
  }
  return [...byUrl.values()].map((entry) => ({ url: entry.url, keywords: entry.keywords, bestPosition: entry.bestPosition, traffic: entry.traffic, topKeyword: entry.topKeyword })).sort((a, b) => b.traffic - a.traffic || b.keywords - a.keywords);
}

/* ---------- starting ---------- */

async function siteOf(db: Db, viewer: Viewer, projectId: string): Promise<string> {
  const intake = await loadIntake(db, viewer, projectId);
  const url = intake?.data.website.currentWebsiteUrl.trim();
  if (!url) throw new AuditError("The intake has no current website to check (Website section).");
  return url;
}

async function withinSeoCap(db: Db, estimateUsd: number): Promise<void> {
  const setup = seoSetup();
  if (!setup.configured) throw new AuditError(`DataForSEO isn't set up yet: an admin adds ${setup.missing.join(" and ")} in Coolify.`);
  if (setup.sandbox) return;
  const [spent, limit] = await Promise.all([seoSpendThisMonth(db), getSeoLimit(db)]);
  if (spent + estimateUsd > limit.dollars) throw new AuditError(`This would go over the monthly SEO data cap ($${spent.toFixed(2)} of $${limit.dollars.toFixed(2)} used). An admin can raise it on Spend.`);
}

const pending = new Set<Promise<unknown>>();

/** For tests: wait for audits started outside a request. */
export async function settleAudits(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

function background(task: () => Promise<unknown>): void {
  const safe = () => task().catch((error: unknown) => console.error(`SEO audit failed: ${error instanceof Error ? error.message : "unknown"}`));
  try {
    after(safe);
  } catch {
    const running = safe().finally(() => pending.delete(running));
    pending.add(running);
  }
}

export const QUICK_ESTIMATE_USD = AUDIT_PRICES.rankedPerRequest + AUDIT_PRICES.rankedPerItem * AUDIT_PRICES.rankedItems;

/*
  The "Don't lose it" check. Included for every project with a website:
  started by itself when the website is saved (auto), or again by hand.
*/
export async function startQuickCheck(ctx: ServiceContext, actor: Viewer, projectId: string, options: { auto?: boolean } = {}): Promise<string | null> {
  assertCan(actor, "intake.edit");
  const siteUrl = await siteOf(ctx.db, actor, projectId).catch((error: unknown) => {
    if (options.auto) return null;
    throw error;
  });
  if (!siteUrl) return null;
  if (options.auto) {
    const [last] = await ctx.db.select().from(seoAudit).where(and(eq(seoAudit.projectId, projectId), eq(seoAudit.kind, "quick"))).orderBy(desc(seoAudit.createdAt)).limit(1);
    if (last && last.siteUrl === siteUrl && last.status !== "failed") return null;
    if (!seoSetup().configured) return null;
  }
  await withinSeoCap(ctx.db, QUICK_ESTIMATE_USD);
  const [audit] = await ctx.db
    .insert(seoAudit)
    .values({ projectId, kind: "quick", status: "working", step: "Reading the sitemap", siteUrl, sandbox: seoSetup().sandbox, estimateUsd: seoSetup().sandbox ? 0 : QUICK_ESTIMATE_USD, startedByUserId: actor.id })
    .returning({ id: seoAudit.id });
  await recordActivity(ctx.db, {
    action: "seo.site_check_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { site: siteUrl, automatic: Boolean(options.auto) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  background(() => gather(ctx.db, audit!.id, false));
  return audit!.id;
}

/* The page count and the band it falls in, free (the sitemap only). Admins see the price. */
export async function countSitePages(ctx: ServiceContext, actor: Viewer, projectId: string) {
  assertCan(actor, "intake.edit");
  const siteUrl = await siteOf(ctx.db, actor, projectId);
  const pages = await sitemapPages(siteUrl);
  if (pages.length === 0) throw new AuditError(`Couldn't read any pages from ${siteUrl}. Check the address, or that the site is up.`);
  const band = auditBand(pages.length);
  const addon = (await listAddons(ctx.db)).find((a) => a.key === band)!;
  return { siteUrl, pageCount: pages.length, band, bandName: addon.name, priceCents: addon.priceCents, quoted: addon.quoted };
}

/* Ticking the full audit: the band's add-on goes on the project's price (logged). */
export async function addFullAudit(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  const counted = await countSitePages(ctx, actor, projectId);
  const existing = (await projectAddons(ctx.db, projectId)).find((a) => a.addonKey.startsWith("seo_audit_"));
  if (existing) return existing.name;
  await addProjectAddon(ctx, actor, projectId, counted.band);
  return counted.bandName;
}

export async function estimateFullAudit(db: Db, pageCount: number): Promise<{ dataUsd: number; aiUsd: number; label: string }> {
  const config = await stepModelConfig(db, "seo_audit_report");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "seo_audit_report"));
  const ai = calls.length ? calls.reduce((n, c) => n + costOf(c, config), 0) / new Set(calls.map((c) => c.runId)).size : costOf(AUDIT_REPORT_GUESS, config);
  const data = seoSetup().sandbox ? 0 : Math.min(pageCount, MAX_PAGES) * AUDIT_PRICES.crawlPerPage + QUICK_ESTIMATE_USD;
  return {
    dataUsd: data,
    aiUsd: ai,
    label: `About ${formatCost(data)} of DataForSEO${seoSetup().sandbox ? " (the sandbox is free)" : ""} and ${formatCost(ai)} of AI on ${modelLabel(config.model)} for the report. PageSpeed is free.`,
  };
}

/* The full audit: paid, so the estimate was shown first; needs the add-on on the project. */
export async function startFullAudit(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "seo.research");
  const siteUrl = await siteOf(ctx.db, actor, projectId);
  if (!(await projectAddons(ctx.db, projectId)).some((a) => a.addonKey.startsWith("seo_audit_"))) throw new AuditError("Add the full SEO audit to the project first: it's a paid add-on.");
  const [running] = await ctx.db.select().from(seoAudit).where(and(eq(seoAudit.projectId, projectId), eq(seoAudit.kind, "full"))).orderBy(desc(seoAudit.createdAt)).limit(1);
  if (running && ["queued", "crawling", "working"].includes(running.status)) throw new AuditError("The full audit is already running.");
  const pageCount = (await sitemapPages(siteUrl)).length;
  const estimate = await estimateFullAudit(ctx.db, pageCount);
  await withinSeoCap(ctx.db, estimate.dataUsd);
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.aiUsd });
  } catch (error) {
    if (error instanceof SpendError) throw new AuditError(error.message);
    throw error;
  }
  const [audit] = await ctx.db
    .insert(seoAudit)
    .values({ projectId, kind: "full", status: "crawling", step: "Reading the sitemap", siteUrl, sandbox: seoSetup().sandbox, estimateUsd: estimate.dataUsd, startedByUserId: actor.id })
    .returning({ id: seoAudit.id });
  await recordActivity(ctx.db, {
    action: "seo.audit_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { site: siteUrl, pages: pageCount, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  background(() => gather(ctx.db, audit!.id, true));
  return audit!.id;
}

/* ---------- gathering (in the background) ---------- */

async function planTargets(db: Db, projectId: string) {
  return (await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position))).map((p) => ({ name: p.name, slug: p.slug, mainKeyword: p.mainKeyword }));
}

async function pageSpeed(url: string): Promise<Record<string, unknown> | null> {
  const key = process.env.PAGESPEED_API_KEY?.trim();
  const query = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (key) query.set("key", key);
  try {
    const response = await (pageSpeedFetch ?? fetch)(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query.toString()}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) return { url, error: `PageSpeed answered ${response.status}` };
    const body = (await response.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, { displayValue?: string }> };
      loadingExperience?: { overall_category?: string };
    };
    const audits = body.lighthouseResult?.audits ?? {};
    return {
      url,
      performance: body.lighthouseResult?.categories?.performance?.score ?? null,
      lcp: audits["largest-contentful-paint"]?.displayValue ?? null,
      cls: audits["cumulative-layout-shift"]?.displayValue ?? null,
      tbt: audits["total-blocking-time"]?.displayValue ?? null,
      fieldData: body.loadingExperience?.overall_category ?? null,
    };
  } catch {
    return { url, error: "PageSpeed didn't answer" };
  }
}

async function gather(db: Db, auditId: string, full: boolean): Promise<void> {
  const [audit] = await db.select().from(seoAudit).where(eq(seoAudit.id, auditId)).limit(1);
  if (!audit) return;
  const run = { projectId: audit.projectId, runId: audit.id, sandbox: audit.sandbox, startedByUserId: audit.startedByUserId };
  const step = (text: string, status?: string) => db.update(seoAudit).set({ step: text, ...(status ? { status } : {}) }).where(eq(seoAudit.id, auditId));
  try {
    const pages = await sitemapPages(audit.siteUrl);
    if (pages.length === 0) throw new AuditError(`Couldn't read any pages from ${audit.siteUrl}. Check the address, or that the site is up.`);
    await step("Finding which pages rank");
    const root = siteRoot(audit.siteUrl)!;
    const ranked = await rankings(run, root.host);
    const redirects = redirectMap(pages, ranked, await planTargets(db, audit.projectId));
    await db.update(seoAudit).set({ pages: pages.map((p) => ({ url: p.url, path: pathOf(p.url) })), pageCount: pages.length, rankings: ranked, redirects }).where(eq(seoAudit.id, auditId));

    if (!full) {
      await db.update(seoAudit).set({ status: "done", step: null, finishedAt: new Date() }).where(eq(seoAudit.id, auditId));
      await recordActivity(db, { action: "seo.site_checked", entityType: "project", entityId: audit.projectId, actorUserId: audit.startedByUserId, valueAfter: { pages: pages.length, ranking: ranked.length, redirects: redirects.length } });
      return;
    }

    await step("Crawling the site (DataForSEO)", "crawling");
    const posted = await dataForSeoCall(run, "on_page_task", "/v3/on_page/task_post", [{ target: root.host, max_crawl_pages: Math.min(pages.length, MAX_PAGES), load_resources: false, enable_javascript: false }], pages.length);
    const taskId = (posted.tasks?.[0] as { id?: string } | undefined)?.id;
    if (!taskId) throw new AuditError("DataForSEO didn't start the crawl.");
    await db.update(seoAudit).set({ onPageTaskId: taskId }).where(eq(seoAudit.id, auditId));
    let summary: Record<string, unknown> | null = null;
    for (let i = 0; i < 120; i += 1) {
      const answer = await dataForSeoCall(run, "on_page_summary", `/v3/on_page/summary/${taskId}`, undefined, 0, "GET");
      summary = (answer.tasks?.[0]?.result?.[0] ?? null) as Record<string, unknown> | null;
      if (summary?.crawl_progress === "finished") break;
      await step(`Crawling the site (DataForSEO): ${String((summary?.crawl_status as { pages_crawled?: number } | undefined)?.pages_crawled ?? 0)} of ${pages.length} pages`);
      await waitFor(10_000);
    }
    if (summary?.crawl_progress !== "finished") throw new AuditError("The crawl took too long. Try the audit again later.");
    const pagesAnswer = await dataForSeoCall(run, "on_page_pages", "/v3/on_page/pages", [{ id: taskId, limit: 200 }]);
    const crawledPages = ((pagesAnswer.tasks?.[0]?.result?.[0] as { items?: Record<string, unknown>[] } | undefined)?.items ?? []).map((p) => ({
      url: p.url,
      status: p.status_code,
      score: p.onpage_score,
      title: (p.meta as { title?: string } | undefined)?.title ?? null,
      description: (p.meta as { description?: string } | undefined)?.description ?? null,
      problems: Object.entries((p.checks as Record<string, boolean> | undefined) ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    }));
    await step("Measuring speed (PageSpeed)", "working");
    const speedTargets = [`${root.origin}/`, ...ranked.slice(0, 2).map((r) => r.url)].filter((u, i, all) => all.indexOf(u) === i);
    const speeds = [];
    for (const url of speedTargets) speeds.push(await pageSpeed(url));
    const metrics = summary.page_metrics as { onpage_score?: number; checks?: unknown } | undefined;
    await db
      .update(seoAudit)
      .set({ crawl: { summary: { onpageScore: metrics?.onpage_score ?? null, checks: metrics?.checks ?? null }, pages: crawledPages }, pageSpeed: speeds, step: "Writing the report" })
      .where(eq(seoAudit.id, auditId));
    try {
      await getQueue().add(SEO_AUDIT_JOB, { auditId, projectId: audit.projectId }, { jobId: seoAuditJobId(auditId), attempts: 1 });
    } catch {
      throw new AuditError("The report couldn't be queued: the job queue isn't answering. Run the audit again in a minute.");
    }
  } catch (error) {
    const known = error instanceof AuditError || error instanceof SeoDataError;
    if (!known) console.error("SEO audit:", error instanceof Error ? error.message : error);
    await db
      .update(seoAudit)
      .set({ status: "failed", step: null, failureReason: known ? (error as Error).message : "The audit stopped unexpectedly. Try again.", finishedAt: new Date() })
      .where(eq(seoAudit.id, auditId));
  }
}

/* ---------- what the Content page shows ---------- */

/* The one done audit the build also reads (site-build.ts): the most recent with pages, any kind. Edits and
   the display must use this exact row, or a correction could land on an audit the build never reads (#6). */
async function latestDoneAudit(db: Db, projectId: string) {
  const [row] = await db.select().from(seoAudit).where(and(eq(seoAudit.projectId, projectId), gt(seoAudit.pageCount, 0))).orderBy(desc(seoAudit.createdAt)).limit(1);
  return row ?? null;
}

export async function loadAudits(db: Db, viewer: Viewer, projectId: string) {
  const intake = await loadIntake(db, viewer, projectId);
  const siteUrl = intake?.data.website.currentWebsiteUrl.trim() || null;
  const [quick] = await db.select().from(seoAudit).where(and(eq(seoAudit.projectId, projectId), eq(seoAudit.kind, "quick"))).orderBy(desc(seoAudit.createdAt)).limit(1);
  const [full] = await db.select().from(seoAudit).where(and(eq(seoAudit.projectId, projectId), eq(seoAudit.kind, "full"))).orderBy(desc(seoAudit.createdAt)).limit(1);
  const plan = await planTargets(db, projectId);
  const done = await latestDoneAudit(db, projectId);
  // #5: the dropped/skipped/over-limit old URLs from the site read join the audit's pages, so every
  // old address gets a 301 even when the paid audit never ran.
  const [importRow] = await db.select({ notImported: siteImport.notImported, skipped: siteImport.skipped, failed: siteImport.failed }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const oldPages = [...((done?.pages as { url: string }[] | null) ?? []), ...leftOutUrls(importRow).map((url) => ({ url }))];
  // The map follows the plan as it is now, not as it was when the site was checked. #6: the team's
  // saved corrections (edited rows) overlay the recompute, so the screen shows exactly what ships.
  const validTargets = new Set<string>(["/", ...plan.filter((p) => p.slug).map((p) => `/${p.slug}/`)]);
  const recomputed = oldPages.length ? redirectMap(oldPages, (done?.rankings as RankedPage[] | null) ?? [], plan) : [];
  const redirects = mergeRedirects(recomputed, (done?.redirects as RedirectRow[] | null) ?? [], validTargets);
  const addon = (await projectAddons(db, projectId)).find((a) => a.addonKey.startsWith("seo_audit_")) ?? null;
  const exports = await db.select().from(intakeFile).where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "seo_crawl_export")));
  // The plan's pages, for the redirect-target dropdown (#6): the only valid places a redirect can point.
  const targets = [{ path: "/", name: "Home" }, ...plan.filter((p) => p.slug).map((p) => ({ path: `/${p.slug}/`, name: p.name }))];
  // A target can only be changed when there's a done audit to store the edit on (#6); without one the
  // redirects still show (from the site read), but read-only — so the dropdown never errors on save.
  return { siteUrl, quick: quick ?? null, full: full ?? null, redirects, targets, canEditRedirects: Boolean(done), rankings: (done?.rankings as RankedPage[] | undefined) ?? [], addon, exports, setup: seoSetup() };
}

/*
  The team corrects a redirect target (#6, 7 November 2026): the saved row is marked `edited` so the
  build (mergeRedirects) and the Content screen (loadAudits) both honour it over the recompute. Stored
  on the latest done audit; the target must be a page the plan actually has (same guard the build uses).
*/
export async function saveRedirect(ctx: ServiceContext, actor: Viewer, projectId: string, from: string, to: string): Promise<void> {
  assertCan(actor, "content.plan");
  const plan = await planTargets(ctx.db, projectId);
  const validTargets = new Set<string>(["/", ...plan.filter((p) => p.slug).map((p) => `/${p.slug}/`)]);
  if (!validTargets.has(to)) throw new SeoDataError(`The new site has no page at ${to}. Pick a page that's in the plan.`);
  if (validTargets.has(from)) throw new SeoDataError(`${from} is a page the new site serves, so it isn't redirected.`);
  const pageName = plan.find((p) => (p.slug ? `/${p.slug}/` : "/") === to)?.name ?? "";
  // The whole read-modify-write is in one transaction that locks the audit row (FOR UPDATE), so two
  // people editing different redirects at once can't overwrite each other's change (#6). The audit is
  // chosen inside the lock and is the same one the build reads (latestDoneAudit).
  await ctx.db.transaction(async (tx) => {
    const done = await latestDoneAudit(tx, projectId);
    if (!done) throw new SeoDataError("Run the site check first (the “Don’t lose it” check), then you can change a redirect.");
    const [locked] = await tx.select().from(seoAudit).where(eq(seoAudit.id, done.id)).for("update");
    const saved = (locked!.redirects as RedirectRow[] | null) ?? [];
    const rows = saved.some((r) => r.from === from)
      ? saved.map((r) => (r.from === from ? { ...r, to, pageName, reason: "Changed by the team", edited: true } : r))
      : [...saved, { from, to, pageName, reason: "Changed by the team", unmatchedTraffic: false, edited: true }];
    await tx.update(seoAudit).set({ redirects: rows }).where(eq(seoAudit.id, done.id));
    // The append-only log entry is written in the same transaction as the edit, so the two commit or
    // roll back together — a stored edit is never left without its activity record (CodeRabbit, PR #46).
    await recordActivity(tx, { action: "seo.redirect_edited", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { from, to }, ipAddress: null, userAgent: null });
  });
}
