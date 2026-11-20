import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { claimSiteBuild } from "@tawd/core/paid-starts";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, clientDecision, contentDecision, designCopy, designPage, figmaDesign, pageDraft, pagePlanPage, project, siteBuild } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { SITE_BUILD_JOB, siteBuildJobId } from "@tawd/core/queue";
import { costOf, formatCost } from "@tawd/core/mockups";
import { builtCountLine, planStages, stagePageTokens, stageSlugKey, stageStates, type ChecklistItem, type StageBuildOptions, type StageState } from "@tawd/core/site";
import { isKeptLineage, pageReadyForBuild, projectTypeFor, usesSuppliedHome } from "@tawd/core/site-read";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";
import type { SiteStagesProps } from "@/components/build/site-card";

/*
  Build A, 8a (26 September 2026): starting a site build and showing it.
  The build itself runs in the worker (site-build.ts). Paid AI: one call
  for the shared parts and one per page, with the estimate first and the
  monthly AI limit checked.
*/

type Db = Database;

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

/** First guesses until real builds have run: the design system is sent once and cached, so pages after the first cost less. */
export const SITE_PARTS_GUESS = { inputTokens: 30_000, outputTokens: 6_000 };
export const SITE_PAGE_GUESS = { inputTokens: 8_000, outputTokens: 7_000, cacheReadTokens: 25_000 };

export async function estimateSiteBuild(db: Db, pageCount: number): Promise<{ cost: number; label: string; measured: boolean }> {
  const config = await stepModelConfig(db, "site_page");
  const calls = await db.select().from(aiCall).where(inArray(aiCall.step, ["site_parts", "site_page"]));
  const byBuild = new Map<string, { cost: number; pages: number }>();
  for (const call of calls) {
    const entry = byBuild.get(call.runId) ?? { cost: 0, pages: 0 };
    entry.cost += costOf(call, config);
    if (call.step === "site_page" && (call.round ?? 1) === 1) entry.pages += 1;
    byBuild.set(call.runId, entry);
  }
  const measured = [...byBuild.values()].filter((b) => b.pages > 0);
  const cost = measured.length
    ? (measured.reduce((sum, b) => sum + b.cost / b.pages, 0) / measured.length) * pageCount
    : costOf(SITE_PARTS_GUESS, config) + costOf({ ...SITE_PAGE_GUESS, cacheWriteTokens: 0 }, config) * pageCount;
  return {
    cost,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${pageCount} page${pageCount === 1 ? "" : "s"} and the shared header and footer${measured.length ? ", from the builds so far" : " (a first guess until a real build has run)"}.`,
    measured: measured.length > 0,
  };
}

/*
  Lane 2, Option A (28 September 2026): the site is the approved design's
  own pages, so what a build needs is every page copied, not a page plan
  and approved drafts. Null for every other project.
*/
async function exactReadiness(db: Db, projectId: string) {
  const [row] = await db.select({ lane: project.lane, laneOption: project.laneOption }).from(project).where(eq(project.id, projectId)).limit(1);
  if (row?.lane !== "lane_2" || row.laneOption !== "a") return null;
  const [figma] = await db.select({ version: figmaDesign.importedVersion }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const pages = figma?.version ? await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, figma.version))) : [];
  const copies = pages.length ? await db.select({ frameId: designCopy.frameId, status: designCopy.status }).from(designCopy).where(and(eq(designCopy.projectId, projectId), eq(designCopy.status, "done"))) : [];
  return { pageCount: pages.length, waiting: pages.filter((p) => !copies.some((c) => c.frameId === p.frameId)).map((p) => p.name) };
}

/* What a build needs, and what is still missing. */
export async function siteReadiness(db: Db, projectId: string) {
  const exact = await exactReadiness(db, projectId);
  const [mockup] = await db
    .select()
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  const drafts = pages.length ? await db.select().from(pageDraft).where(inArray(pageDraft.pageId, pages.map((p) => p.id))).orderBy(desc(pageDraft.version)) : [];
  const designOnly = (await projectTypeFor(db, projectId)) === "design_only";
  // A supplied homepage keeps its own words, so the home page's copy is never waited for (W5).
  const suppliedHome = await usesSuppliedHome(db, projectId);
  const waiting = pages.filter((p) => !(suppliedHome && p.kind === "home") && !pageReadyForBuild(drafts.filter((d) => d.pageId === p.id), designOnly)).map((p) => p.name);
  const [copy] = await db.select().from(contentDecision).where(eq(contentDecision.projectId, projectId)).orderBy(desc(contentDecision.createdAt)).limit(1);
  if (exact) {
    // The design's words are the approved copy; the client approved the design itself.
    return { mockupApproved: Boolean(mockup), pageCount: exact.pageCount, waiting: exact.waiting, clientApprovedCopy: true, exact: true, ready: Boolean(mockup) && exact.pageCount > 0 && exact.waiting.length === 0 };
  }
  return {
    mockupApproved: Boolean(mockup),
    pageCount: pages.length,
    waiting,
    // Design only: the words are the client's own, so there's no copy for them to approve.
    // A supplied home page alone has no copy to approve either: the client approved the page itself.
    clientApprovedCopy: designOnly || copy?.outcome === "approved" || (suppliedHome && pages.length > 0 && pages.every((p) => p.kind === "home")),
    designOnly,
    exact: false,
    // The client approved a homepage the team supplied: the build keeps its words as the home page (so it needs a Home page in the plan, and the AI writes one page fewer).
    suppliedHome,
    hasHomePage: pages.some((p) => p.kind === "home"),
    ready: Boolean(mockup) && pages.length > 0 && waiting.length === 0 && !(suppliedHome && !pages.some((p) => p.kind === "home")),
  };
}

/* A full build (paid AI), or with editRequestId a rebuild with one edit from the saved sources (no AI). */
/*
  "Speed up this build" (1 October 2026): the latest finished build through
  the speed pass, as a new version. Free (no AI), so no spending check.
*/
export async function startSpeedUp(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const [done] = await ctx.db
    .select({ version: siteBuild.version })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  if (!done) throw new SiteError("Build the site first.");
  const build = await claimSiteBuild(ctx.db, projectId, { startedByUserId: actor.id, options: { kind: "speed", from: done.version } });
  if (!build) throw new SiteError("The site is already being built.");
  const { version } = build;
  try {
    await getQueue().add(SITE_BUILD_JOB, { buildId: build!.id, projectId }, { jobId: siteBuildJobId(build!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(siteBuild).where(eq(siteBuild.id, build!.id));
    throw new SiteError("The job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, { action: "site.build_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { version, speedUpFrom: done.version }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function startSiteBuild(ctx: ServiceContext, actor: Viewer, projectId: string, options: { editRequestId?: string } = {}): Promise<string> {
  assertCan(actor, "project.edit");
  const readiness = await siteReadiness(ctx.db, projectId);
  // Lane 2 builds from the design on Mockups (29 September 2026); the exact build from the copies is an admin's tool.
  if (readiness.exact && !can(actor, "money.manage") && !options.editRequestId) throw new SiteError("Build this site from its design on Design (Build site).");
  if (!readiness.mockupApproved) throw new SiteError(readiness.exact ? "Record the client's approval of the design first (Design)." : "The client hasn't approved a mockup yet: the site is built from the approved one.");
  if (readiness.pageCount === 0) throw new SiteError(readiness.exact ? "Confirm the design's pages first (Design)." : "Make the page plan first.");
  if (readiness.waiting.length)
    throw new SiteError(
      readiness.exact
        ? `These pages aren't copied yet: ${readiness.waiting.join(", ")}.`
        : "designOnly" in readiness && readiness.designOnly
          ? `These pages have no words from the current site yet: ${readiness.waiting.join(", ")}. Add their words on Content, or remove them from the plan.`
          : `These pages aren't approved by Content yet: ${readiness.waiting.join(", ")}.`,
    );
  // A supplied homepage is kept as the plan's Home page; with no Home page in the plan its sections would be used nowhere.
  if ("suppliedHome" in readiness && readiness.suppliedHome && !readiness.hasHomePage) throw new SiteError("The client approved the homepage you supplied, but the page plan has no Home page to keep it as. Add a Home page to the plan on Content.");
  const [running] = await ctx.db
    .select({ id: siteBuild.id })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), inArray(siteBuild.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new SiteError("The site is already being built.");
  // A makeover's kept articles after the first are filled by code (0.98.0).
  // The supplied home page is kept as it is: no AI call, so no price.
  const keptSuppliedHome = "suppliedHome" in readiness && readiness.suppliedHome ? 1 : 0;
  const aiPages = readiness.exact ? readiness.pageCount : readiness.pageCount - keptSuppliedHome - (await splitKeptArticles(ctx.db, projectId, (await ctx.db.select({ slug: pagePlanPage.slug }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId))).map((p) => stageSlugKey(p.slug)), false)).byCode;
  if (!options.editRequestId) {
    try {
      await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateSiteBuild(ctx.db, aiPages)).cost });
    } catch (error) {
      if (error instanceof SpendError) throw new SiteError(error.message);
      throw error;
    }
  }
  const estimate = options.editRequestId
    ? { label: "Free: the saved pages with the edit, no AI." }
    : readiness.exact
      ? { label: "Free: the approved design's pages, used exactly, no AI." }
      : await estimateSiteBuild(ctx.db, aiPages);
  const build = await claimSiteBuild(ctx.db, projectId, { startedByUserId: actor.id, editRequestId: options.editRequestId ?? null, options: readiness.exact && !options.editRequestId ? { exact: true } : null });
  if (!build) throw new SiteError("The site is already being built.");
  const { version } = build;
  try {
    await getQueue().add(SITE_BUILD_JOB, { buildId: build!.id, projectId }, { jobId: siteBuildJobId(build!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(siteBuild).where(eq(siteBuild.id, build!.id));
    throw new SiteError("The build couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "site.build_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version, pages: readiness.pageCount, estimate: estimate.label, clientApprovedCopy: readiness.clientApprovedCopy, ...(options.editRequestId ? { editRequestId: options.editRequestId } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return build!.id;
}

export interface BuiltPage {
  pageId: string;
  name: string;
  path: string;
  shotKey: string | null;
  placeholders: string[];
  /** Staged builds (6 October 2026): the version that built the page. */
  builtIn?: number;
}

/*
  A makeover's kept articles (0.98.0): the first is built by the AI, every
  other is filled into its layout by code (site-build.ts, kept-article.ts).
  Of these page keys, the ones the AI builds and how many code fills; an
  article already built (layoutBuilt) means none of them needs the AI.
*/
export async function splitKeptArticles(db: Db, projectId: string, keys: string[], layoutBuilt: boolean): Promise<{ ai: string[]; byCode: number }> {
  // Kept the way the worker sees it: an article page with a draft kept from the current site.
  const plan = await db.select({ id: pagePlanPage.id, slug: pagePlanPage.slug }).from(pagePlanPage).where(and(eq(pagePlanPage.projectId, projectId), eq(pagePlanPage.kind, "article")));
  if (plan.length === 0) return { ai: keys, byCode: 0 };
  const drafts = await db.select({ pageId: pageDraft.pageId, version: pageDraft.version, source: pageDraft.source }).from(pageDraft).where(inArray(pageDraft.pageId, plan.map((p) => p.id)));
  const kept = new Set(plan.filter((p) => isKeptLineage(drafts.filter((d) => d.pageId === p.id))).map((p) => p.id));
  const articles = new Set(plan.filter((p) => kept.has(p.id)).map((p) => stageSlugKey(p.slug)));
  let layout = layoutBuilt;
  const ai: string[] = [];
  let byCode = 0;
  for (const key of keys) {
    if (!articles.has(key)) ai.push(key);
    else if (layout) byCode += 1;
    else {
      ai.push(key);
      layout = true;
    }
  }
  return { ai, byCode };
}

const byCodeWords = (n: number) => (n ? ` ${n} more blog article${n === 1 ? " is" : "s are"} filled into the first article's layout by code: free.` : "");

/*
  The supplied home page's words are kept as the team uploaded them: Build A
  never sends the page to the AI, so it is never priced (Jason, 17 November 2026:
  "supply all of that... and then pay for it too. Doesn't make sense").

  The start path has always left it out, and the estimate the screen shows
  never did: the Home stage read "About $0.79 of AI on Opus 5.5 for 1 page
  and the shared header and footer" when the only AI in that stage is the
  header and footer. Both paths call this now, so they cannot drift apart
  again.
*/
export async function withoutKeptHome(db: Db, projectId: string, keys: string[]): Promise<{ keys: string[]; keptHome: boolean }> {
  if (!(await usesSuppliedHome(db, projectId))) return { keys, keptHome: false };
  const plan = await db.select({ kind: pagePlanPage.kind, slug: pagePlanPage.slug }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const homeKeys = new Set(plan.filter((p) => p.kind === "home").map((p) => stageSlugKey(p.slug)));
  const left = keys.filter((k) => !homeKeys.has(k));
  return { keys: left, keptHome: left.length !== keys.length };
}

/** Said beside the estimate, so a stage that costs less says why. */
const keptHomeWords = (kept: boolean) => (kept ? " The home page is the design the team supplied: its words are kept as they were uploaded, never sent to the AI, and there is nothing to pay for it." : "");

/* ---------- staged builds (Jason, 6 October 2026) ---------- */

/*
  Lane 1 sites are built in stages (standing rules 2 and 8; core
  stages.ts): Home first (with the header and footer), each other main
  page alone, then each group's first page alone and the rest as one
  bundle. Each stage is a new version with every page built so far; the
  pages not built yet are "Coming soon" pages. Go-live waits until every
  planned page is built.
*/

export interface StageEstimate {
  cost: number;
  label: string;
  measured: boolean;
  /** How many pages the AI actually writes in this stage: a kept page is not one of them. */
  aiPages?: number;
  /** True when a page was left out because it is the home page the team supplied. Not the same as aiPages === 0: a stage of kept blog articles has no AI page either. */
  keptHome?: boolean;
}

/* What these pages cost, each scaled by its copy's length, from the last 20 page calls on the step's model (else a first guess). */
export async function estimateStage(db: Db, pages: { copyChars: number }[], makesParts: boolean): Promise<StageEstimate> {
  const config = await stepModelConfig(db, "site_page");
  // The shared header and footer are their own step, on their own model (Spend).
  const partsConfig = makesParts ? await stepModelConfig(db, "site_parts") : null;
  const history = await db
    .select({ inputTokens: aiCall.inputTokens, outputTokens: aiCall.outputTokens, cacheReadTokens: aiCall.cacheReadTokens })
    .from(aiCall)
    .where(and(eq(aiCall.step, "site_page"), eq(aiCall.round, 1), eq(aiCall.model, config.model)))
    .orderBy(desc(aiCall.createdAt))
    .limit(20);
  const tokens = pages.map((p) => stagePageTokens(p.copyChars, history.map((c) => ({ inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens ?? 0 }))));
  let cost = tokens.reduce((n, t) => n + costOf(t, config), 0);
  if (partsConfig) {
    const parts = await db.select().from(aiCall).where(and(eq(aiCall.step, "site_parts"), eq(aiCall.round, 1), eq(aiCall.model, partsConfig.model))).orderBy(desc(aiCall.createdAt)).limit(20);
    cost += parts.length ? parts.reduce((n, c) => n + costOf(c, partsConfig), 0) / parts.length : costOf(SITE_PARTS_GUESS, partsConfig);
  } else if (pages.length) {
    // A stage hours after the last one writes the cached system prompt again (once per stage).
    cost += costOf({ inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: tokens[0]!.cacheReadTokens }, config);
  }
  const n = pages.length;
  return {
    cost,
    measured: history.length > 0,
    /*
      With a supplied home page the Home stage builds no page at all: only
      the shared header and footer. "0 pages ... scaled by each page's copy"
      would be nonsense, so the sentence says what is actually being made.
      Every penny of that cost is the shared-parts step, so the model named
      is that step's, not the page step's: the two are set separately on
      Spend and need not be the same (CodeRabbit on #108).
    */
    label:
      n === 0 && partsConfig
        ? `About ${formatCost(cost)} of AI on ${modelLabel(partsConfig.model)} for the shared header and footer${history.length ? ", from the builds so far" : " (a first guess until a page has been built)"}.`
        : `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${n} page${n === 1 ? "" : "s"}${makesParts ? " and the shared header and footer" : ""}, scaled by each page's copy${history.length ? ", from the builds so far" : " (a first guess until a page has been built)"}.`,
  };
}

const keyOfPath = (p: string) => p.replace(/^\/+|\/+$/g, "") || "home";

export interface StagesView {
  states: StageState[];
  count: { built: number; total: number; line: string };
  /** The next stage's pages and estimate; null when every page is built. */
  next: { stage: StageState; estimate: StageEstimate } | null;
  /** Every page not built yet, once Home is (rule 8); null otherwise. */
  remaining: { pages: number; estimate: StageEstimate } | null;
  /** Build the whole site again, once every page is built. */
  whole: StageEstimate | null;
  homeBuilt: boolean;
  allBuilt: boolean;
}

/* The stages against the latest finished version. Null for Lane 2 (its own home-first build) and before there is a page plan. */
export async function loadStages(db: Db, projectId: string): Promise<StagesView | null> {
  const [row] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row || row.lane === "lane_2") return null;
  const plan = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (plan.length === 0) return null;
  const drafts = await db
    .select({ pageId: pageDraft.pageId, body: pageDraft.body, approvedAt: pageDraft.approvedAt })
    .from(pageDraft)
    .where(inArray(pageDraft.pageId, plan.map((p) => p.id)))
    .orderBy(desc(pageDraft.version));
  const copyChars = new Map(plan.map((p) => [stageSlugKey(p.slug), (drafts.find((d) => d.pageId === p.id && d.approvedAt) ?? drafts.find((d) => d.pageId === p.id))?.body?.length ?? 0]));
  const [done] = await db.select().from(siteBuild).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done"))).orderBy(desc(siteBuild.version)).limit(1);
  const built = new Map<string, number>(((done?.pages ?? []) as BuiltPage[]).map((p) => [keyOfPath(p.path), p.builtIn ?? done!.version]));
  const states = stageStates(planStages(plan.map((p) => ({ name: p.name, kind: p.kind, slug: p.slug }))), built);
  const sized = (keys: string[]) => keys.map((k) => ({ copyChars: copyChars.get(k) ?? 0 }));
  const nextStage = states.find((s) => s.status === "next") ?? null;
  const homeBuilt = states[0]?.status === "built";
  const left = states.flatMap((s) => s.toBuild);
  const articleBuilt = plan.some((p) => p.kind === "article" && built.has(stageSlugKey(p.slug)));
  // Kept articles after the first cost nothing (0.98.0): only the AI's pages are estimated.
  const estimateFor = async (keys: string[], makesParts: boolean) => {
    const split = await splitKeptArticles(db, projectId, keys, articleBuilt);
    // The supplied home page is kept, never built: it was priced here and is not any more.
    const home = await withoutKeptHome(db, projectId, split.ai);
    const estimate = await estimateStage(db, sized(home.keys), makesParts);
    // aiPages is what the AI actually writes, which is what the confirmation before spending must say.
    return { ...estimate, aiPages: home.keys.length, keptHome: home.keptHome, label: `${estimate.label}${byCodeWords(split.byCode)}${keptHomeWords(home.keptHome)}` };
  };
  return {
    states,
    count: builtCountLine(states),
    next: nextStage ? { stage: nextStage, estimate: await estimateFor(nextStage.toBuild, nextStage.makesParts) } : null,
    remaining: homeBuilt && left.length ? { pages: left.length, estimate: await estimateFor(left, false) } : null,
    whole: left.length === 0 ? await estimateFor(states.flatMap((s) => s.slugs), true) : null,
    homeBuilt,
    allBuilt: left.length === 0,
  };
}

/* The "Build the site" card's stages, in words. */
export function stagesCardProps(view: StagesView): SiteStagesProps {
  const names = (list: string[]) => (list.length <= 1 ? "" : list.length <= 4 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`);
  const built = view.states.filter((s) => s.status === "built");
  const last = built.reduce<StageState | null>((a, s) => (!a || (s.builtIn ?? 0) >= (a.builtIn ?? 0) ? s : a), null);
  return {
    countLine: view.count.line,
    allBuilt: view.allBuilt,
    homeBuilt: view.homeBuilt,
    rows: view.states.map((s) => ({ key: s.key, label: s.label, pagesLine: names(s.names), status: s.status, builtIn: s.builtIn, makesParts: s.makesParts })),
    next: view.next ? { label: view.next.stage.label, button: view.next.stage.button, estimateLine: view.next.estimate.label, makesParts: view.next.stage.makesParts, pages: view.next.stage.toBuild.length, aiPages: view.next.estimate.aiPages ?? view.next.stage.toBuild.length, keptHome: view.next.estimate.keptHome ?? false } : null,
    lastBuilt: view.next && last ? `${last.label} (version ${last.builtIn})` : null,
    remaining: view.remaining ? { pages: view.remaining.pages, estimateLine: view.remaining.estimate.label } : null,
    wholeEstimateLine: view.whole?.label ?? null,
  };
}

/* The go-live checklist's line: every planned page built (staged builds); null where stages don't apply. */
export function stagesChecklistItem(view: StagesView | null): ChecklistItem | null {
  if (!view) return null;
  const waiting = view.states.filter((s) => s.status !== "built");
  return {
    key: "all-pages-built",
    label: "Every planned page built",
    ok: view.allBuilt,
    detail: view.allBuilt
      ? `All ${view.count.total} pages`
      : `${view.count.line}; still to build: ${waiting.slice(0, 4).map((s) => s.label).join(", ")}${waiting.length > 4 ? `, and ${waiting.length - 4} more stages` : ""} (Build)`,
    blocksGoLive: true,
  };
}

/*
  Starts a stage (paid AI, the estimate first): "next" the next stage,
  "remaining" every page not built yet, "whole" every page again with a
  new header and footer. The last two only once Home is built (rule 8).
*/
export async function startStageBuild(ctx: ServiceContext, actor: Viewer, projectId: string, which: "next" | "remaining" | "whole"): Promise<string> {
  assertCan(actor, "project.edit");
  const readiness = await siteReadiness(ctx.db, projectId);
  if (readiness.exact) throw new SiteError("Build this site from its design on Design (Build site).");
  if (!readiness.mockupApproved) throw new SiteError("The client hasn't approved a mockup yet: the site is built from the approved one.");
  if (readiness.pageCount === 0) throw new SiteError("Make the page plan first.");
  if (readiness.waiting.length) throw new SiteError(`These pages aren't approved by Content yet: ${readiness.waiting.join(", ")}.`);
  const view = await loadStages(ctx.db, projectId);
  if (!view) throw new SiteError("This project's site is built from its design (Design).");
  const [running] = await ctx.db.select({ id: siteBuild.id }).from(siteBuild).where(and(eq(siteBuild.projectId, projectId), inArray(siteBuild.status, ["queued", "working"]))).limit(1);
  if (running) throw new SiteError("The site is already being built.");
  if (which !== "next" && !view.homeBuilt) throw new SiteError(`Build ${view.states[0]?.label ?? "the home page"} first: one page first, then the rest.`);
  let only: string[];
  let stage: string;
  let makesParts = false;
  if (which === "next") {
    if (!view.next) throw new SiteError("Every planned page is built.");
    only = view.next.stage.toBuild;
    stage = view.next.stage.label;
    makesParts = view.next.stage.makesParts;
  } else if (which === "remaining") {
    only = view.states.flatMap((s) => s.toBuild);
    if (only.length === 0) throw new SiteError("Every planned page is built.");
    stage = `Every remaining page (${only.length})`;
  } else {
    only = view.states.flatMap((s) => s.slugs);
    stage = `The whole site again (${only.length} pages)`;
    makesParts = true;
  }
  const plan = await ctx.db.select({ id: pagePlanPage.id, slug: pagePlanPage.slug, kind: pagePlanPage.kind }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const drafts = await ctx.db
    .select({ pageId: pageDraft.pageId, body: pageDraft.body, approvedAt: pageDraft.approvedAt })
    .from(pageDraft)
    .where(inArray(pageDraft.pageId, plan.map((p) => p.id)))
    .orderBy(desc(pageDraft.version));
  const articleBuilt = view.states.some((s) => s.status === "built" && s.slugs.some((k) => plan.some((p) => p.kind === "article" && stageSlugKey(p.slug) === k)));
  const split = await splitKeptArticles(ctx.db, projectId, only, articleBuilt);
  // The supplied home page is kept as it is (no AI call), so it is not priced. Same helper as the screen's estimate, so the two cannot disagree.
  const sized = (await withoutKeptHome(ctx.db, projectId, split.ai)).keys.map((k) => {
    const page = plan.find((p) => stageSlugKey(p.slug) === k);
    return { copyChars: drafts.find((d) => d.pageId === page?.id && d.approvedAt)?.body?.length ?? 0 };
  });
  const estimate = await estimateStage(ctx.db, sized, makesParts);
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new SiteError(error.message);
    throw error;
  }
  const options: StageBuildOptions = { kind: "stage", only, estimate: estimate.cost, stage };
  const build = await claimSiteBuild(ctx.db, projectId, { startedByUserId: actor.id, options });
  if (!build) throw new SiteError("The site is already being built.");
  const { version } = build;
  try {
    await getQueue().add(SITE_BUILD_JOB, { buildId: build!.id, projectId }, { jobId: siteBuildJobId(build!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(siteBuild).where(eq(siteBuild.id, build!.id));
    throw new SiteError("The build couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "site.build_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version, stage, pages: only.length, estimate: estimate.label, clientApprovedCopy: readiness.clientApprovedCopy },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return build!.id;
}

/* A whole build's estimate: a makeover's kept articles after the first are filled by code (0.98.0). */
async function wholeEstimate(db: Db, projectId: string, pageCount: number) {
  const keys = (await db.select({ slug: pagePlanPage.slug }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId))).map((p) => stageSlugKey(p.slug));
  const byCode = (await splitKeptArticles(db, projectId, keys, false)).byCode;
  const estimate = await estimateSiteBuild(db, Math.max(pageCount - byCode, 1));
  return { ...estimate, label: `${estimate.label}${byCodeWords(byCode)}` };
}

export async function loadSiteView(db: Db, projectId: string) {
  const builds = await db.select().from(siteBuild).where(eq(siteBuild.projectId, projectId)).orderBy(desc(siteBuild.version));
  const readiness = await siteReadiness(db, projectId);
  return {
    latest: builds[0] ?? null,
    lastDone: builds.find((b) => b.status === "done") ?? null,
    builds,
    readiness,
    estimate: readiness.exact ? { cost: 0, label: "Free: the approved design's pages, used exactly, no AI.", measured: false } : await wholeEstimate(db, projectId, readiness.pageCount - ("suppliedHome" in readiness && readiness.suppliedHome ? 1 : 0)),
  };
}

/* Where a built file lives in R2, for the viewer route. Only paths inside the build. */
export function siteFileKey(projectPrefix: string, version: number, segments: string[]): string | null {
  let clean: string[];
  try {
    clean = segments.map((s) => decodeURIComponent(s));
  } catch {
    // A malformed % (F-048): refused, not a 500.
    return null;
  }
  // A segment is one name: no slash (an encoded %2F decodes to one), backslash, dot-dot or NUL, before or after decoding.
  if ([...segments, ...clean].some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\") || s.includes("\0"))) return null;
  const rel = clean.join("/");
  const file = rel === "" ? "index.html" : /\.[a-z0-9]+$/i.test(rel) ? rel : `${rel.replace(/\/$/, "")}/index.html`;
  return `${projectPrefix}site/v${version}/${file}`;
}

/*
  A built page seen inside TAWD: its absolute links ("/site.css",
  "/drain-cleaning/") point at the same build under the viewer's address.
*/
export function rebaseSiteFile(text: string, base: string): string {
  return (
    text
      .replace(/(href|src|action)=(["'])\/(?!\/)/g, `$1=$2${base}/`)
      .replace(/url\((["']?)\/(?!\/)/g, `url($1${base}/`)
      // The speed pass's picture sizes (5 October 2026): every address in a srcset, or the browser asks TAWD's own /assets/ and the picture breaks.
      .replace(/\b(srcset|imagesrcset)=(["'])([^"']*)\2/gi, (_, attr: string, q: string, list: string) =>
        `${attr}=${q}${list.replace(/(^|,)(\s*)\/(?!\/)/g, `$1$2${base}/`)}${q}`,
      )
  );
}
