import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import type { Tier } from "@tawd/core/enums";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { PREFILL_LABELS, type PrefillKey } from "@tawd/core/figma";
import { describeCurrentSite, type SiteHome } from "@tawd/core/mockups";
import { SYSTEM_ACTOR, assertCan, can, type Viewer } from "@tawd/core/permissions";
import { SITE_READ_JOB, siteReadJobId } from "@tawd/core/queue";
import { deletedProject, serviceHeartbeat, intakePrefill, pageComment, pageDraft, pagePlanPage, project, siteImport, siteReadCall } from "@tawd/core/schema";
import { PLACEHOLDER_RE } from "@tawd/core/content";
import { archiveDate, articleAddress, currentSiteSuggestions, isBlockedMessage, isOldCopy, openingHoursSpecification, planSitePrefill, slugFromPath, tawdDoesBetter, waysForwardFor, type ImportedPageSummary, type SuggestionGroup } from "@tawd/core/site";
import { AFTER_STEP, AFTER_STEP_MS, ROUTE_LABELS, ROUTE_SPEND_LABELS, getRouteCap, routeSpentThisMonth, setRouteCapValue, type BlockedRouteName, KEPT_SOURCE, savedImportBotCheck, homeOfRow, keepSiteUrl, readHost, readIsStale, replaceWithKeptPages, syncKeptPlan, workWords, type KeptPlanNote, type PlanWork } from "@tawd/core/site-read";
import { formatWhen } from "@/lib/labels";
import { getQueue } from "@/lib/mockups";
import { TIER_MAX_PAGES } from "@/lib/seo-plan";
import type { ServiceContext } from "@/lib/users";

export { KEPT_LABEL, KEPT_SOURCE, archiveNote } from "@tawd/core/site-read";

/*
  One read of the current site (Jason, 7 October 2026;
  docs/plans/flow-a-one-read.md). Saving the intake's Website section with
  an address starts one free read (no AI) for every project: the home page
  as a browser sees it, every page's words, then the empty intake answers
  the site proves, and, for "Keep all content as is", the page plan made
  by itself. The result shows on Intake; Content shows the pages.

  Changes after the read: the same site at a slightly different address
  (http or https, www or not, a trailing slash) isn't read again; another
  site is, and a plan with work is never replaced without the team's one
  decision. "No current website" or an empty address removes the read and
  its files; the plan and drafts stay.
*/

type Db = Database;
type ReadRow = typeof siteImport.$inferSelect;

export class SiteReadServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteReadServiceError";
  }
}

export function pageLimitFor(tier: string): number {
  return TIER_MAX_PAGES[(tier as Tier) in TIER_MAX_PAGES ? (tier as Tier) : "starter"];
}

async function siteUrlOf(db: Db, projectId: string): Promise<string> {
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  return intake?.data.website.noCurrentWebsite ? "" : (intake?.data.website.currentWebsiteUrl ?? "").trim();
}

async function removeFiles(projectId: string, importId: string): Promise<void> {
  const storage = getStorage();
  const prefix = `${projectStoragePrefix(projectId)}site-import/${importId}/`;
  try {
    for (const key of await storage.list(prefix)) await storage.remove(key);
  } catch {
    // Left for project deletion, which removes everything under the project's folder.
  }
}

/*
  A new read replaces the old row (its job then finds nothing and stops).
  The same site keeps its link to the plan (so a re-read adds to it); a
  different site starts unlinked (its plan, if any, isn't from this read).
*/
async function queueRead(ctx: ServiceContext, actor: Viewer, projectId: string, url: string, auto: boolean): Promise<void> {
  const [proj] = await ctx.db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  const [old] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const sameSite = old && readHost(old.url) === readHost(url);
  if (old) {
    await ctx.db.delete(siteImport).where(eq(siteImport.id, old.id));
    await removeFiles(projectId, old.id);
  }
  const pageLimit = pageLimitFor(proj?.tier ?? "starter");
  const carry = sameSite ? { usedAt: old!.usedAt, usedByUserId: old!.usedByUserId, keptPlan: old!.keptPlan } : {};
  const [row] = await ctx.db.insert(siteImport).values({ projectId, url, pageLimit, startedByUserId: auto ? null : actor.id, ...carry }).returning({ id: siteImport.id });
  try {
    await getQueue().add(SITE_READ_JOB, { projectId, importId: row!.id }, { jobId: siteReadJobId(row!.id, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(siteImport).set({ status: "failed", failureReason: "The job queue isn't answering. Read again in a minute." }).where(eq(siteImport.id, row!.id));
    if (!auto) throw new SiteReadServiceError("The read couldn't be queued: the job queue isn't answering. Try again in a minute.");
    return;
  }
  await recordActivity(ctx.db, {
    action: "content.site_import_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(auto ? SYSTEM_ACTOR : actor),
    valueAfter: { url, pageLimit, ...(auto ? { auto: true } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* After the Website section is saved: a new address (another site) is read by itself; no address removes the read. Free. */
export async function syncSiteRead(ctx: ServiceContext, projectId: string): Promise<void> {
  const url = await siteUrlOf(ctx.db, projectId);
  const [row] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!url) {
    if (row) {
      await ctx.db.delete(siteImport).where(eq(siteImport.id, row.id));
      await removeFiles(projectId, row.id);
    }
    return;
  }
  if (row && readHost(row.url) === readHost(url)) {
    if (row.url !== url) await ctx.db.update(siteImport).set({ url }).where(eq(siteImport.id, row.id));
    return;
  }
  await queueRead(ctx, SYSTEM_ACTOR, projectId, url, true);
}

/* After the Content section is saved: changed to "Keep all content as is" with a done read, the plan makes itself now. */
export async function syncKeepChoice(ctx: ServiceContext, projectId: string): Promise<void> {
  await syncKeptPlan(ctx.db, projectId);
  // A read made before the choice was keep left blog articles over the limit: a makeover keeps them, so it reads again (0.98.0).
  const url = await keepSiteUrl(ctx.db, projectId);
  const [row] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (url && row && row.status === "done" && row.notImported.some((u) => articleAddress(new URL(u, "https://x.invalid").pathname))) await queueRead(ctx, SYSTEM_ACTOR, projectId, row.url, true);
}

/* After the tier is raised: a read that left pages over the old limit reads again (free), adding them by the plan's rules. */
export async function syncAfterTierChange(ctx: ServiceContext, projectId: string): Promise<void> {
  const [row] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const [proj] = await ctx.db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row || !proj || row.status !== "done" || row.notImported.length === 0 || pageLimitFor(proj.tier) <= row.pageLimit) return;
  await queueRead(ctx, SYSTEM_ACTOR, projectId, row.url, true);
}

/* "Read again" on Intake (the PM, SEO and Content: intake.edit or content.plan). Free. */
export async function readSiteAgain(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!can(actor, "intake.edit")) assertCan(actor, "content.plan");
  const url = await siteUrlOf(ctx.db, projectId);
  if (!url) throw new SiteReadServiceError("There's no current website in the intake (Website section).");
  const [row] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (row && (row.status === "queued" || row.status === "working") && !readIsStale(row)) throw new SiteReadServiceError("The site is being read now.");
  await queueRead(ctx, actor, projectId, url, false);
}

/* A keep project whose done read hasn't made its plan yet (a read from before 0.96.0): made now, by the same rules. */
export async function ensureKeptPlan(db: Db, projectId: string): Promise<void> {
  const [row] = await db.select({ status: siteImport.status, usedAt: siteImport.usedAt }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!row || row.status !== "done" || row.usedAt) return;
  await syncKeptPlan(db, projectId).catch((error: unknown) => console.error(`The kept page plan: ${error instanceof Error ? error.message : "unknown"}`));
}

/* The decision on Content: replace a plan that has work with the current site's pages. */
export async function replacePlanWithSite(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "content.plan");
  if (!(await keepSiteUrl(ctx.db, projectId))) throw new SiteReadServiceError("The project type isn't Design only or Design + content.");
  try {
    return await replaceWithKeptPages(ctx.db, projectId, actor, { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  } catch (error) {
    throw new SiteReadServiceError(error instanceof Error ? error.message : "The plan couldn't be replaced.");
  }
}

/* ---------- a blocked site's paid read over $1: the go (Fable's review M6) ---------- */

/* Who may give the go for a paid read: the PM (intake) and the SEO team (paid lookups); admins. */
export function canGiveReadGo(viewer: Viewer): boolean {
  return can(viewer, "intake.edit") || can(viewer, "seo.research");
}

/*
  "Read it for about $X": the read waiting with its estimate carries on,
  allowed up to that estimate (the monthly cap still applies). Logged.
*/
export async function approvePaidRead(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!canGiveReadGo(actor)) assertCan(actor, "intake.edit");
  const [row] = await ctx.db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!row || row.status !== "needs_consent" || row.consentEstimateUsd === null) throw new SiteReadServiceError("No paid read is waiting for a go on this project.");
  const estimate = row.consentEstimateUsd;
  await ctx.db.update(siteImport).set({ status: "queued", consentUsd: estimate, consentByUserId: actor.id, failureReason: null, finishedAt: null, heartbeatAt: new Date() }).where(eq(siteImport.id, row.id));
  try {
    await getQueue().add(SITE_READ_JOB, { projectId, importId: row.id }, { jobId: siteReadJobId(row.id, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(siteImport).set({ status: "needs_consent" }).where(eq(siteImport.id, row.id));
    throw new SiteReadServiceError("The read couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "content.blocked_read_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { url: row.url, route: ROUTE_SPEND_LABELS[(row.consentRoute ?? "jina") as BlockedRouteName] ?? row.consentRoute, estimateUsd: estimate },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- what the screens show ---------- */

export interface SiteReadView {
  id: string;
  url: string;
  host: string;
  /** needs_consent: a blocked site whose paid read is estimated over $1 waits for a person's go. */
  status: "queued" | "working" | "done" | "failed" | "needs_consent";
  /** needs_consent: the route and its estimate. */
  consent: { route: string; estimateUsd: number } | null;
  /** A blocked site read through a paid route: the routes used and this read's cost (site_read_call); null when nothing was paid. */
  paid: { routes: string[]; costUsd: number; estimated: boolean } | null;
  step: string | null;
  failure: string | null;
  /** The site blocks TAWD's server: Read again isn't offered as a way forward. */
  blocked: boolean;
  /** What to do when the read failed, in order. */
  waysForward: string[];
  /** The pages came back without words (a JavaScript-only site); the home page may still have been read. */
  jsOnly: boolean;
  pageLimit: number;
  /** "sitemap", "menu", "fallback-list"; "home-only" for a home page read from before 0.96.0. */
  source: string | null;
  pages: ImportedPageSummary[];
  skipped: { url: string; reason: string }[];
  notImported: string[];
  failed: { url: string; reason: string }[];
  brokenLinks: { from: string; to: string; status: number | null }[];
  requests: number;
  finishedAt: Date | null;
  usedAt: Date | null;
  usedByUserId: string | null;
  /** The plan was made from this read and still has its pages. */
  inPlan: boolean;
  keptPlan: KeptPlanNote | null;
  suggestions: SuggestionGroup[];
  better: string[];
  /** The home page as the browser saw it. */
  home: SiteHome | null;
  /** "6 sections, a menu of 7 links (...), the phone (916) 555-0142, ...". */
  homeLine: string | null;
  homeFailure: string | null;
  homeReadAt: Date | null;
  screenshotUrl: string | null;
}

export interface SiteReadPanel {
  /** Keep all content as is, a current website, Lane 1: the plan comes from the read. */
  keep: boolean;
  read: SiteReadView | null;
  /** Fields filled from the site (labels), and what was found but not filled. */
  filled: string[];
  notes: string[];
}

export async function loadSiteRead(db: Db, projectId: string, options: { signShot?: boolean } = {}): Promise<SiteReadPanel> {
  const keep = Boolean(await keepSiteUrl(db, projectId));
  if (keep) await ensureKeptPlan(db, projectId);
  const [row] = await db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  if (!row) return { keep, read: null, filled: [], notes: [] };
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const marks = await db.select().from(intakePrefill).where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.origin, "site")));
  const filled = marks.filter((m) => m.status !== "corrected").map((m) => PREFILL_LABELS[m.fieldKey as PrefillKey] ?? m.fieldKey);
  const stale = readIsStale(row);
  const blockedSaved = savedImportBotCheck(row);
  const pages = blockedSaved ? [] : (row.pages as ImportedPageSummary[]);
  const status: SiteReadView["status"] = stale || blockedSaved ? "failed" : (row.status as SiteReadView["status"]);
  const failure = blockedSaved ?? (stale ? "The read was cut off before it finished. Read again." : row.failureReason);
  const business = intake?.data.business;
  const done = status === "done";
  const notes = done && intake ? planSitePrefill(intake.data, pages, new Set(marks.filter((m) => m.status === "corrected").map((m) => m.fieldKey))).notes : [];
  const suggestions = done
    ? currentSiteSuggestions({
        pages: pages.filter((p) => !p.gap),
        brokenLinks: row.brokenLinks as SiteReadView["brokenLinks"],
        notImported: row.notImported,
        facts: {
          name: business?.name ?? "",
          phone: business?.phone ?? "",
          city: business?.city ?? "",
          cities: [...(intake?.data.serviceAreas.cities ?? []), ...(intake?.data.serviceAreas.counties ?? [])],
          services: (intake?.data.services.items ?? []).map((s) => s.name),
        },
      })
    : [];
  const plan = await db.select({ slug: pagePlanPage.slug }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const slugs = new Set(plan.map((p) => p.slug));
  const saved = homeOfRow(row);
  // A look that found no menu (a read from before 0.97.0 picked a "Skip to content" nav) shows the menu the page reader found.
  const home = saved && !saved.menu.length && (row.menu as { label: string; url: string }[]).length
    ? { ...saved, menu: (row.menu as { label: string; url: string }[]).slice(0, 20).map((m) => ({ label: m.label, href: m.url })) }
    : saved;
  const paid = await paidReadOf(db, row.id);
  const shotKey = home?.look?.screenshotKey ?? null;
  return {
    keep,
    filled,
    notes,
    read: {
      id: row.id,
      url: row.url,
      host: readHost(row.url),
      status,
      step: row.step,
      failure,
      blocked: (status === "failed" || status === "needs_consent") && isBlockedMessage(failure),
      waysForward: status === "failed" || status === "needs_consent" ? waysForwardFor(failure) : [],
      paid,
      consent: status === "needs_consent" && row.consentEstimateUsd !== null ? { route: ROUTE_LABELS[(row.consentRoute ?? "jina") as BlockedRouteName] ?? row.consentRoute ?? "", estimateUsd: row.consentEstimateUsd } : null,
      jsOnly: status === "failed" && /draws its words with JavaScript/.test(failure ?? ""),
      pageLimit: row.pageLimit,
      source: row.source,
      pages,
      skipped: row.skipped as SiteReadView["skipped"],
      notImported: row.notImported,
      failed: row.failed as SiteReadView["failed"],
      brokenLinks: row.brokenLinks as SiteReadView["brokenLinks"],
      requests: row.requests,
      finishedAt: row.finishedAt,
      usedAt: row.usedAt,
      usedByUserId: row.usedByUserId,
      // A gap page the team removed from the plan doesn't make the read unused again.
      inPlan: Boolean(row.usedAt) && pages.filter((p) => !p.gap).every((p) => slugs.has(p.kind === "home" ? "" : slugFromPath(p.path))),
      keptPlan: (row.keptPlan as KeptPlanNote | null) ?? null,
      suggestions,
      better: done ? tawdDoesBetter(pages.filter((p) => !p.gap), { hasHours: openingHoursSpecification(intake?.data.business.hours).length > 0 }) : [],
      home,
      homeLine: home ? describeCurrentSite(home) : null,
      homeFailure: row.homeFailure,
      homeReadAt: row.homeReadAt,
      screenshotUrl: shotKey && options.signShot ? await getStorage().signDownload(shotKey, "home.jpg").catch(() => null) : null,
    },
  };
}

/* What this read paid its routes (every Jina and Zyte call is a site_read_call row with the read's id). */
async function paidReadOf(db: Db, readId: string): Promise<SiteReadView["paid"]> {
  const calls = await db
    .select({ route: siteReadCall.route, costUsd: sql<number>`sum(${siteReadCall.costUsd})`, estimated: sql<boolean>`bool_or(${siteReadCall.estimated})` })
    .from(siteReadCall)
    .where(eq(siteReadCall.readId, readId))
    .groupBy(siteReadCall.route);
  if (!calls.length) return null;
  const order: BlockedRouteName[] = ["jina", "zyte"];
  const routes = [...calls].sort((a, b) => order.indexOf(a.route as BlockedRouteName) - order.indexOf(b.route as BlockedRouteName)).map((c) => ROUTE_LABELS[c.route as BlockedRouteName] ?? c.route);
  return { routes, costUsd: calls.reduce((sum, c) => sum + Number(c.costUsd ?? 0), 0), estimated: calls.some((c) => Boolean(c.estimated)) };
}

/* " through Jina Reader for $0.30 (no AI)", or ", free (no AI)" when no route was paid: the title's ending. */
export function costWords(paid: SiteReadView["paid"]): string {
  if (!paid) return ", free (no AI)";
  const amount = `$${paid.costUsd < 0.01 && paid.costUsd > 0 ? "0.01" : paid.costUsd.toFixed(2)}`;
  return ` through ${paid.routes.join(" and ")} for ${paid.estimated ? "about " : ""}${amount} (no AI)`;
}

/* ---------- the panel's and the card's lines ---------- */

/* Where the page list came from, truthfully. */
export function listSourceWords(source: string | null): string {
  if (source === "menu") return "its menu: there's no sitemap";
  if (source === "fallback-list") return "the blocked route's list of its pages";
  if (source === "archive-list") return "the Internet Archive's list of its pages";
  return "its sitemap";
}

/* "Read 23 pages from finleypest.com, free (no AI)", "... through Jina Reader for $0.30 (no AI)" and the like: the Intake panel's title. */
export function readTitle(read: Pick<SiteReadView, "status" | "host" | "pages" | "source" | "home" | "jsOnly" | "consent" | "paid">): string {
  const pages = read.pages.filter((p) => !p.gap).length;
  const cost = costWords(read.paid ?? null);
  // While reading, a blocked site may still turn to a paid route: "free" only once it's known.
  if (read.status === "queued" || read.status === "working") return read.paid ? `Reading ${read.host}${cost}` : `Reading ${read.host} (no AI)`;
  if (read.status === "needs_consent") return `${read.host} blocks TAWD's server: reading it needs a go`;
  if (read.status === "done" && read.source === "home-only") return `Read the home page of ${read.host}${cost}`;
  if (read.status === "done") return `Read ${pages} page${pages === 1 ? "" : "s"} from ${read.host}${cost}`;
  if (read.jsOnly && read.home) return `Read the home page of ${read.host} only${cost}`;
  return `Couldn't read ${read.host}`;
}

/* The plan's line on Content: "In the page plan since Oct 7, 2026, 3:20 PM PT (TAWD, automatically)." */
export function planLine(read: Pick<SiteReadView, "usedAt" | "usedByUserId" | "inPlan" | "keptPlan">, people: Map<string, string>): string | null {
  if (!read.usedAt) return null;
  const who = read.usedByUserId ? (people.get(read.usedByUserId) ?? "a team member") : "TAWD, automatically";
  return read.inPlan ? `In the page plan since ${formatWhen(read.usedAt)} (${who}): Content reviews and approves each page under Page drafts.` : `Made the page plan ${formatWhen(read.usedAt)} (${who}), but the plan has changed since.`;
}

/* The decision's words: "Replace the plan with the current site's 23 pages" and what it deletes. */
export function decisionWords(read: Pick<SiteReadView, "pages">, work: PlanWork | null): { button: string; deletes: string } {
  const n = read.pages.length;
  return { button: `Replace the plan with the current site's ${n} page${n === 1 ? "" : "s"}`, deletes: work ? workWords(work) : "" };
}

export interface FallbackView {
  /** "28 pages from the Internet Archive's copy of finleypest.com (...). Free. 3 read from the live site." */
  summary: string;
  /** Per page: Live, or where the copy came from and its date; old when over 6 months. */
  from: Map<string, { label: string; old: boolean }>;
  /** Pages nothing could read, by path. */
  gaps: string[];
}

/* Pages read through a blocked route (or 0.94.0's Internet Archive): where each came from. null: the site was read as usual. */
export function fallbackView(read: Pick<SiteReadView, "host" | "pages">, at = Date.now()): FallbackView | null {
  const readPages = read.pages.filter((p) => !p.gap);
  const copies = readPages.filter((p) => p.readFrom === "archive" || p.readFrom === "fallback");
  const gaps = read.pages.filter((p) => p.gap).map((p) => p.path);
  if (!copies.length && !gaps.length && !readPages.some((p) => p.readFrom === "site")) return null;
  const label = (p: ImportedPageSummary) => (p.readFrom === "archive" ? "the Internet Archive" : p.via === "jina" ? "Jina Reader" : p.via === "zyte" ? "Zyte" : (p.via ?? "another source"));
  const sources = [...new Set(copies.map(label))];
  const dates = copies.flatMap((p) => (p.snapshotAt ? [p.snapshotAt] : [])).sort();
  const old = copies.filter((p) => isOldCopy(p.snapshotAt, at)).length;
  const live = readPages.filter((p) => p.readFrom === "site").length;
  const range = dates.length ? (archiveDate(dates[0]!, "short") === archiveDate(dates.at(-1)!, "short") ? ` (a copy of ${archiveDate(dates[0]!, "short")})` : ` (copies from ${archiveDate(dates[0]!, "short")} to ${archiveDate(dates.at(-1)!, "short")})`) : "";
  const summary = `${copies.length} page${copies.length === 1 ? "" : "s"} read through ${sources.join(" and ") || "another source"} for ${read.host}${range}${old ? `; ${old} ${old === 1 ? "is" : "are"} over 6 months old` : ""}.${live ? ` ${live} read from the live site.` : ""}`;
  const from = new Map<string, { label: string; old: boolean }>();
  for (const p of readPages) {
    if (p.readFrom === "archive" || p.readFrom === "fallback") from.set(p.path, { label: `${p.readFrom === "archive" ? "Archive" : label(p)}${p.snapshotAt ? ` ${archiveDate(p.snapshotAt, "short")}` : ""}`, old: isOldCopy(p.snapshotAt, at) });
    else if (p.readFrom === "site") from.set(p.path, { label: "Live", old: false });
  }
  return { summary, from, gaps };
}

/* ---------- blocked sites: what the paid routes spent, and their caps ---------- */

/* An admin changes a route's monthly cap; logged with before and after. */
export async function setRouteCap(ctx: ServiceContext, actor: Viewer, route: BlockedRouteName, dollars: number): Promise<void> {
  assertCan(actor, "settings.manage");
  if (route !== "jina" && route !== "zyte") throw new SiteReadServiceError("That isn't a blocked-site route.");
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000) throw new SiteReadServiceError(`Enter a monthly ${ROUTE_LABELS[route]} cap in dollars, above $0.`);
  const rounded = Math.round(dollars * 100) / 100;
  const before = await getRouteCap(ctx.db, route);
  if (!before.isDefault && before.dollars === rounded) return;
  await setRouteCapValue(ctx.db, route, rounded, actorFields(actor).actorUserId);
  await recordActivity(ctx.db, {
    action: "settings.blocked_route_cap_changed",
    entityType: "setting",
    entityId: `blocked_route_cap_${route}`,
    ...actorFields(actor),
    valueBefore: { route: ROUTE_SPEND_LABELS[route], dollars: before.dollars, default: before.isDefault },
    valueAfter: { route: ROUTE_SPEND_LABELS[route], dollars: rounded },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Spend's "Blocked-site reads" card: each route this month against its cap, and the period's calls by project. */
export async function loadBlockedSiteSpend(db: Db, viewer: Viewer, period: { from: string; to: string }) {
  assertCan(viewer, "spend.view");
  // The keys live on the worker only: its own report (the heartbeat's names and yes/no), never the web app's settings (Fable's review M3).
  const [beat] = await db.select({ env: serviceHeartbeat.env }).from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
  const workerEnv = (beat?.env as Record<string, boolean> | undefined) ?? null;
  const routes = await Promise.all(
    (["jina", "zyte"] as const).map(async (route) => ({
      route,
      label: ROUTE_SPEND_LABELS[route],
      cap: await getRouteCap(db, route),
      monthSpent: await routeSpentThisMonth(db, route),
      /** null: the worker hasn't reported its settings yet. */
      configured: workerEnv ? Boolean(workerEnv[route === "jina" ? "JINA_API_KEY" : "ZYTE_API_KEY"]) : null,
    })),
  );
  const day = sql<string>`to_char((${siteReadCall.createdAt} at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD')`;
  const rows = await db.select().from(siteReadCall).where(and(gte(day, period.from), lte(day, period.to)));
  const ids = [...new Set(rows.map((r) => r.projectId))];
  const names = new Map<string, { name: string; deleted: boolean }>();
  if (ids.length) {
    for (const p of await db.select({ id: project.id, name: project.clientName }).from(project).where(inArray(project.id, ids))) names.set(p.id, { name: p.name, deleted: false });
    for (const p of await db.select({ id: deletedProject.id, name: deletedProject.clientName }).from(deletedProject).where(inArray(deletedProject.id, ids))) if (!names.has(p.id)) names.set(p.id, { name: p.name, deleted: true });
  }
  const byProject = new Map<string, { name: string; deleted: boolean; route: string; calls: number; tokens: number; estimated: boolean; total: number }>();
  for (const r of rows) {
    const key = `${r.projectId}:${r.route}`;
    const entry = byProject.get(key) ?? { ...(names.get(r.projectId) ?? { name: "Unknown project", deleted: true }), route: ROUTE_SPEND_LABELS[r.route as BlockedRouteName] ?? r.route, calls: 0, tokens: 0, estimated: false, total: 0 };
    entry.calls += 1;
    entry.tokens += r.tokens;
    entry.estimated ||= r.estimated;
    entry.total += r.costUsd;
    byProject.set(key, entry);
  }
  return { routes, total: rows.reduce((n, r) => n + r.costUsd, 0), calls: rows.length, failed: rows.filter((r) => !r.ok).length, byProject: [...byProject.values()].sort((a, b) => b.total - a.total) };
}

/* ---------- approving kept pages ---------- */

/* The kept pages waiting for Content's approval: their latest version is the kept one, unchanged and unapproved. */
async function keptWaiting(db: Db, projectId: string) {
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (pages.length === 0) return [];
  const rows = await db.select().from(pageDraft).where(inArray(pageDraft.pageId, pages.map((p) => p.id))).orderBy(desc(pageDraft.version));
  const latest = new Map<string, typeof pageDraft.$inferSelect>();
  for (const row of rows) if (!latest.has(row.pageId)) latest.set(row.pageId, row);
  const open = new Set((await db.select({ pageId: pageComment.pageId }).from(pageComment).where(and(eq(pageComment.projectId, projectId), isNull(pageComment.resolvedAt)))).map((c) => c.pageId));
  return pages.flatMap((page) => {
    const last = latest.get(page.id);
    // A page with a [PLACEHOLDER] (a page nothing could read) waits for its own review: its words are pasted first.
    return last && last.source === KEPT_SOURCE && last.status === "done" && last.body && !last.approvedAt && !open.has(page.id) && !new RegExp(PLACEHOLDER_RE.source, "i").test(last.body) ? [{ page, draft: last }] : [];
  });
}

export async function countKeptWaiting(db: Db, projectId: string): Promise<number> {
  return (await keptWaiting(db, projectId)).length;
}

/*
  "Approve all kept pages" (Content and admins), after a confirmation: each
  kept page still exactly as it came from the current site is approved by
  this person, one recorded approval per page, as if approved one by one.
  An edited page, or one with open comments, is left for its own review.
*/
export async function approveKeptPages(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "content.approve");
  const waiting = await keptWaiting(ctx.db, projectId);
  if (waiting.length === 0) throw new SiteReadServiceError("No kept page is waiting for approval.");
  const at = new Date();
  for (const { page, draft } of waiting) {
    await ctx.db.update(pageDraft).set({ approvedByUserId: actor.id, approvedAt: at }).where(eq(pageDraft.id, draft.id));
    await recordActivity(ctx.db, {
      action: "content.page_approved",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueAfter: { page: page.name, version: draft.version, placeholders: 0, kept: true, all: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
  return waiting.length;
}

export type { ReadRow };

/* ---------- the Intake panel's view (plain values for the client component) ---------- */

export interface SiteReadPanelView {
  url: string;
  host: string;
  status: SiteReadView["status"];
  title: string;
  step: string | null;
  /** Done, and the worker is still filling the intake and making the plan (AFTER_STEP, at most AFTER_STEP_MS): the panel keeps refreshing. */
  settling: boolean;
  failure: string | null;
  blocked: boolean;
  waysForward: string[];
  jsOnly: boolean;
  /** A home page read from before 0.96.0, before TAWD read every page. */
  homeOnly: boolean;
  pagesRead: number;
  /** "Home page: 6 sections, ... Read Oct 7, 2026, 3:20 PM PT." */
  homeLine: string | null;
  homeFailure: string | null;
  screenshotUrl: string | null;
  colours: string[];
  fonts: string[];
  words: { menu: { label: string }[]; sections: { heading: string; words: string }[]; testimonials: string[] } | null;
  filled: string[];
  notes: string[];
  /** PMs, SEO and Content (intake.edit or content.plan). */
  canReadAgain: boolean;
  /** needs_consent: "Jina Reader", about $2.10; and whether this person may give the go. */
  consent: { route: string; estimateUsd: number } | null;
  canConsent: boolean;
}

export function sitePanelView(panel: SiteReadPanel, viewer?: Viewer): SiteReadPanelView | null {
  const read = panel.read;
  if (!read) return null;
  const when = read.finishedAt ?? read.homeReadAt;
  return {
    url: read.url,
    host: read.host,
    status: read.status,
    title: readTitle(read),
    step: read.step,
    settling: read.status === "done" && read.step === AFTER_STEP && Boolean(read.finishedAt) && Date.now() - read.finishedAt!.getTime() < AFTER_STEP_MS,
    failure: read.failure,
    blocked: read.blocked,
    waysForward: read.waysForward,
    jsOnly: read.jsOnly,
    homeOnly: read.source === "home-only",
    pagesRead: read.pages.filter((p) => !p.gap).length,
    homeLine: read.homeLine ? `Home page: ${read.homeLine}.${when ? ` Read ${formatWhen(when)}.` : ""}` : null,
    homeFailure: read.homeFailure,
    screenshotUrl: read.screenshotUrl,
    colours: read.home?.look?.colours ?? [],
    fonts: read.home?.look?.fonts ?? [],
    words: read.home ? { menu: read.home.menu.map((m) => ({ label: m.label })), sections: read.home.sections.map((s) => ({ heading: s.heading, words: s.words })), testimonials: read.home.testimonials } : null,
    filled: panel.filled,
    notes: panel.notes,
    canReadAgain: viewer ? can(viewer, "intake.edit") || can(viewer, "content.plan") : false,
    consent: read.consent,
    canConsent: viewer ? canGiveReadGo(viewer) : false,
  };
}
