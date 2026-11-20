import { and, eq } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { homeWordsFromKeptPage, type CurrentSiteResult } from "@tawd/core/mockups";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SiteReadJobData } from "@tawd/core/queue";
import { project, siteImport } from "@tawd/core/schema";
import { SiteImportError, blockedSiteMessage, botCheck, noAnswerMessage, crawlSite, importRecords, type BlockedRoute, type FetchedText, type ImportedPageSummary, type SiteFetch } from "@tawd/core/site";
import { AFTER_STEP, KEPT_ARTICLE_LIMIT, ROUTE_SPEND_LABELS, applySitePrefill, keepSiteUrl, readHost, syncKeptPlan } from "@tawd/core/site-read";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { storable } from "@tawd/core/text-safe";

import { paidRoutesFor, type PaidRoutes, type RouteContext } from "./blocked-routes";
import { LOOK_TIMEOUT_MS, lookAtUrl, type HomeLooker } from "./home-look";
import { refusePrivate } from "./liked-sites";
import { IMPORT_MAX_BYTES, pinnedRequest, readLimited, type RawAnswer, type Requester } from "./read-limited";

/*
  One read of the current site (Jason, 7 October 2026;
  docs/plans/flow-a-one-read.md). When the intake's Website section is
  saved with an address, every project (both lanes, every content choice)
  gets one free read, no AI:

  1. the home page by a plain request (a bot check or refusal goes to the
     blocked-route seam, blockedRouteFor, which answers null until Part D);
  2. the home page in the shared browser (one tab, 30 s at most): its
     sections, menu, phones and testimonials, its colours and fonts, and a
     first-screen screenshot in R2; saved at once so Intake shows it before
     the pages finish. A failure here isn't fatal;
  3. every page (up to the tier's limit): one plain request at a time with
     a pause, each address and redirect checked public first, 20 s and
     6 MB at most per answer; each page's own words go to R2;
  4. then the empty intake answers the site proves are filled, and a keep
     project's page plan makes itself (core site/site-read.ts).

  The site's words are the client's own content: data, never instructions.
  Everything goes under the project's folder in R2, so deleting the
  project removes it.
*/

export { IMPORT_MAX_BYTES, type RawAnswer, type Requester };
const TIMEOUT_MS = 20_000;
/** Once a site is known to block TAWD, live asks wait less: a host that holds connections mustn't stall a route's read. */
export const BLOCKED_TIMEOUT_MS = 8_000;
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- TAWD's browser name (user agent), not a user name
const USER_AGENT = "TAWD site check (Velocity Media Lab)";
/** The pages came back without words: a site drawn only by JavaScript. */
export const JS_ONLY_REASON = "The pages opened but no words could be read from them: the site draws its words with JavaScript (like some Wix sites).";
/** The pages opened and held nothing at all: no title, words, headings or pictures. (Not a JavaScript site: that one has at least a title.) */
export const EMPTY_PAGES_REASON = "The pages opened but were empty: no title, words or pictures were found on them. Check that the address is the live site.";
/** Every page on the list was a gap: none could be read, by the site or by a route. */
export const NO_PAGE_READ_REASON = "None of the site's pages could be read.";

/* Why a read that found no words failed, by what was actually found (F-033). */
export function noWordsReason(pages: { extracted: { title: string; wordCount: number; blocks: unknown[]; images: unknown[] } }[], readCount: number): string {
  if (readCount === 0) return NO_PAGE_READ_REASON;
  const nothing = pages.length > 0 && pages.every((p) => p.extracted.wordCount === 0 && !p.extracted.title.trim() && p.extracted.blocks.length === 0 && p.extracted.images.length === 0);
  return nothing ? EMPTY_PAGES_REASON : JS_ONLY_REASON;
}

export { LOOK_TIMEOUT_MS, type HomeLooker };

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
let waitImpl: ((ms: number) => Promise<void>) | null = null;
let lookImpl: HomeLooker | null = null;
let routeImpl: BlockedRoute | null | undefined = undefined;

/** Tests pass a stand-in site, pause, browser look and blocked route; nothing in the tests reaches the internet or opens a browser. */
export function setSiteReadStandInsForTesting(stand: { fetch?: Fetch | null; wait?: ((ms: number) => Promise<void>) | null; look?: HomeLooker | null; route?: BlockedRoute | null } | null): void {
  fetchImpl = stand?.fetch ?? null;
  waitImpl = stand?.wait ?? null;
  lookImpl = stand?.look ?? null;
  routeImpl = stand && "route" in stand ? stand.route : undefined;
}

/*
  The one plug for sites that block TAWD's server (docs/plans/flow-a-one-read.md
  section 4): Part D's paid routes behind it (blocked-routes.ts: Jina
  Reader, then Zyte), each only with its key, under its monthly cap and
  under the $1 estimate. null: no route can run, and the read fails with
  the plain message, why each route is off, and the ways forward.
*/
export async function blockedRouteFor(url: string, ctx: RouteContext): Promise<PaidRoutes> {
  const none = { off: () => [], needsConsent: null, spent: () => ({ jina: { calls: 0, costUsd: 0 }, zyte: { calls: 0, costUsd: 0 } }) };
  if (routeImpl !== undefined) return { ...none, route: routeImpl };
  if (!url) return { ...none, route: null };
  return paidRoutesFor(ctx);
}

/* One address, following at most five redirects itself, each one checked public before it's opened. */
export async function followPolitely(url: string, request: Requester): Promise<FetchedText | null> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (await refusePrivate(current)) return null;
    let answer: RawAnswer;
    try {
      answer = await request(current);
    } catch {
      return null;
    }
    const location = answer.header("location");
    if (answer.status >= 300 && answer.status < 400 && location) {
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    const contentType = answer.header("content-type") ?? "";
    // Pictures, PDFs and the like aren't read.
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) return { url: current, status: answer.status, contentType, text: "" };
    const text = await answer.body().catch(() => null);
    if (text === null) return null;
    return { url: current, status: answer.status, contentType, text };
  }
  return null;
}

const READ_HEADERS = { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.5" };

/* The real reads connect only to the address that was checked (pinnedRequest); tests answer through their stand-in fetch. */
const plainRequest = (timeoutMs: number): Requester => {
  if (!fetchImpl) return pinnedRequest(timeoutMs, READ_HEADERS);
  const stand = fetchImpl;
  return async (url) => {
    const response = await stand(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: READ_HEADERS });
    return { status: response.status, header: (name) => response.headers.get(name), body: () => readLimited(response) };
  };
};

export const politeFetch: SiteFetch = (url) => followPolitely(url, plainRequest(TIMEOUT_MS));
const blockedFetch: SiteFetch = (url) => followPolitely(url, plainRequest(BLOCKED_TIMEOUT_MS));

function lookFailure(error: unknown): string {
  if (error instanceof SiteImportError) return error.message;
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) return `The home page didn't finish loading in the browser within ${LOOK_TIMEOUT_MS / 1000} seconds.`;
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return "No website answers at that address.";
  return "The browser couldn't open the home page.";
}

/* The home page from the pages read (no browser look): its kept words as sections. */
function homeFromPages(summaries: ImportedPageSummary[], markdown: string | null): CurrentSiteResult | null {
  const home = summaries.find((p) => p.path === "/" && !p.gap);
  if (!home || !markdown) return null;
  const words = homeWordsFromKeptPage(markdown);
  if (!words.sections.length) return null;
  return {
    title: home.title,
    menu: [],
    sections: words.sections.map((s, i) => ({ kind: i === 0 ? "hero" : "other", heading: s.name === "Hero" ? "" : s.name, words: s.words })),
    phones: home.phones,
    testimonials: words.testimonials.map((t) => t.text),
  };
}

/* ---------- the job ---------- */

export async function runSiteReadJob(job: SiteReadJobData): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [row] = await db.select().from(siteImport).where(eq(siteImport.id, job.importId)).limit(1);
  if (!row || row.status !== "queued") return;
  // Still this read? The address may change (a new row) while the site is read: nothing is written for an old one.
  const still = async () => {
    const [now] = await db.select({ url: siteImport.url }).from(siteImport).where(eq(siteImport.id, row.id)).limit(1);
    // Another site always gets a new row (this one deleted); the same site at another spelling keeps the row and this read stands (Fable H2).
    return Boolean(now) && readHost(now!.url) === readHost(row.url);
  };
  const beat = (step: string | null) => db.update(siteImport).set({ step, heartbeatAt: new Date() }).where(eq(siteImport.id, row.id));
  await db.update(siteImport).set({ status: "working", step: "Reading the home page", heartbeatAt: new Date(), failureReason: null }).where(eq(siteImport.id, row.id));
  const [proj] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, row.projectId)).limit(1);
  const intake = await loadIntake(db, SYSTEM_ACTOR, row.projectId);
  const cities = [...(intake?.data.serviceAreas.cities ?? []), ...(intake?.data.serviceAreas.counties ?? [])];
  const prefix = `${projectStoragePrefix(row.projectId)}site-import/${row.id}/`;
  // A makeover reads its blog articles on top of the tier's limit (0.98.0).
  const extraArticles = (await keepSiteUrl(db, row.projectId)) ? KEPT_ARTICLE_LIMIT : 0;
  let homeSaved = false;
  let routeOff: (() => string[]) | null = null;
  try {
    let start: URL;
    try {
      start = new URL(/^https?:\/\//i.test(row.url.trim()) ? row.url.trim() : `https://${row.url.trim()}`);
    } catch {
      throw new SiteImportError("The current website's address isn't a web address.");
    }
    // 1. The home page, by a plain request.
    const home = await politeFetch(`${start.origin}/`);
    const check = home ? botCheck(home) : null;
    // No answer at all from a public address: a host that drops servers' connections looks like this (Fable's review M5).
    const silent = !home && !(await refusePrivate(`${start.origin}/`)) ? noAnswerMessage(row.url) : null;
    const blockedWords = check ? blockedSiteMessage(row.url, check) : silent;
    const paid = blockedWords ? await blockedRouteFor(row.url, { db, projectId: row.projectId, readId: row.id, pageLimit: row.pageLimit + extraArticles, consentUsd: row.consentUsd }) : null;
    const route = paid?.route ?? null;
    // Over $1: the read waits with the estimate for a person's go on Intake (Fable's review M6), never a failure.
    if (blockedWords && !route && paid?.needsConsent) {
      if (!(await still())) return;
      await db.update(siteImport).set({ status: "needs_consent", step: null, failureReason: blockedWords, consentEstimateUsd: paid.needsConsent.estimateUsd, consentRoute: paid.needsConsent.route, finishedAt: new Date() }).where(eq(siteImport.id, row.id));
      return;
    }
    // Why each route is off, with what to do; "not set up" only when some route is (Part A's wording otherwise).
    const offWords = () => {
      const reasons = paid?.off() ?? [];
      return reasons.every((o) => /isn't set up/.test(o)) ? [] : reasons;
    };
    if (blockedWords && !route) throw new SiteImportError([blockedWords, ...offWords()].join(" "), true);
    routeOff = offWords;

    // 2. The look, only when the plain request proved the site readable (or the route can give it).
    if (home && !check && home.status >= 200 && home.status < 300) {
      await beat("Looking at the home page");
      try {
        const saveShot = async (jpeg: Buffer) => {
          const key = `${prefix}home.jpg`;
          await storage.put(key, jpeg, "image/jpeg");
          return key;
        };
        const look = storable(await (lookImpl ?? lookAtUrl)(home.url, saveShot));
        if (!(await still())) return;
        if (look.sections.length) {
          await db.update(siteImport).set({ home: look, homeFailure: null, homeReadAt: new Date() }).where(eq(siteImport.id, row.id));
          homeSaved = true;
        } else {
          await db.update(siteImport).set({ homeFailure: "The home page opened in the browser but no words could be read from it.", homeReadAt: new Date() }).where(eq(siteImport.id, row.id));
        }
      } catch (error) {
        if (!(await still())) return;
        await db.update(siteImport).set({ homeFailure: lookFailure(error), homeReadAt: new Date() }).where(eq(siteImport.id, row.id));
      }
    } else if (route?.look) {
      await beat(`Reading the home page through ${route.label}`);
      const saveShot = async (image: Buffer, contentType: string) => {
        const key = `${prefix}home.${/png/i.test(contentType) ? "png" : "jpg"}`;
        await storage.put(key, image, contentType);
        return key;
      };
      const look = storable(await route.look(`${start.origin}/`, saveShot).catch(() => null));
      if (look?.sections.length && (await still())) {
        await db.update(siteImport).set({ home: look, homeFailure: null, homeReadAt: new Date() }).where(eq(siteImport.id, row.id));
        homeSaved = true;
      }
    }

    // 3. Every page.
    // Everything scraped is made storable at once (F-033): a NUL byte or half an emoji would make the database refuse the write, every time.
    const crawl = storable(await crawlSite(row.url, {
      fetch: politeFetch,
      maxPages: row.pageLimit,
      extraArticles,
      wait: waitImpl ?? undefined,
      home,
      fallback: route,
      noAnswerBlocked: silent,
      liveStopAfter: 3,
      blockedLiveFetch: blockedFetch,
      onProgress: async (step) => {
        await beat(step);
      },
    }));
    await beat("Keeping the pages' words");
    const { summaries, files } = importRecords(crawl, { keyFor: (n) => `${prefix}${n}.json`, cities, siteName: intake?.data.business.name || proj?.clientName || "" });
    if (!(await still())) return;
    for (const file of files) await storage.put(file.key, Buffer.from(JSON.stringify(file.page), "utf8"), "application/json");
    const words = summaries.reduce((n, p) => n + p.wordCount, 0);
    const done = summaries.some((p) => !p.gap) && words > 0;
    // No look: the home page's sections from its kept words.
    const fallbackHome = !homeSaved && done ? homeFromPages(summaries, files.find((f) => f.page.path === "/")?.page.markdown ?? null) : null;
    if (!(await still())) return;
    await db
      .update(siteImport)
      .set({
        status: done ? "done" : "failed",
        // Done: the intake and the plan come next, and the Intake panel keeps refreshing until they're made (0.97.0).
        step: done ? AFTER_STEP : null,
        source: crawl.source,
        pages: summaries,
        skipped: crawl.skipped,
        notImported: crawl.notImported,
        failed: crawl.failed,
        brokenLinks: crawl.brokenLinks,
        menu: crawl.menu,
        requests: crawl.requests,
        failureReason: done ? null : noWordsReason(crawl.pages, summaries.filter((p) => !p.gap).length),
        finishedAt: new Date(),
        ...(fallbackHome ? { home: fallbackHome, homeReadAt: new Date() } : {}),
      })
      .where(eq(siteImport.id, row.id));

    // What reading a blocked site cost, by route (Spend has each call).
    if (paid?.route) {
      const spent = paid.spent();
      const lines = (Object.keys(spent) as (keyof typeof spent)[]).filter((k) => spent[k].calls > 0).map((k) => ({ route: ROUTE_SPEND_LABELS[k], calls: spent[k].calls, costUsd: Math.round(spent[k].costUsd * 10_000) / 10_000 }));
      if (lines.length) await recordActivity(db, { action: "content.blocked_site_read", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { url: row.url, routes: lines, pages: summaries.filter((p) => !p.gap).length, gaps: summaries.filter((p) => p.gap).length }, ipAddress: null, userAgent: null }).catch(() => undefined);
    }

    // 4. After: the intake answers the site proves, and a keep project's plan. Free; a failure here leaves the read done.
    if (done) {
      await applySitePrefill(db, row.projectId, summaries, row.url).catch((error: unknown) => console.error("Site read, filling the intake:", error instanceof Error ? error.message : error));
      await syncKeptPlan(db, row.projectId).catch((error: unknown) => console.error("Site read, the page plan:", error instanceof Error ? error.message : error));
      await db.update(siteImport).set({ step: null }).where(and(eq(siteImport.id, row.id), eq(siteImport.step, AFTER_STEP)));
    }
  } catch (error) {
    // A route that stopped mid-read says why, with what to do (Fable's review H3).
    const routeWords = error instanceof SiteImportError && error.blocked && routeOff ? routeOff().filter((o) => !error.message.includes(o)) : [];
    const reason = error instanceof SiteImportError ? [error.message, ...routeWords].join(" ") : "Reading the site stopped unexpectedly. Read again.";
    if (!(error instanceof SiteImportError)) console.error("Site read:", error instanceof Error ? error.message : error);
    if (!(await still())) return;
    await db.update(siteImport).set({ status: "failed", step: null, failureReason: reason, finishedAt: new Date() }).where(eq(siteImport.id, row.id));
  }
}
