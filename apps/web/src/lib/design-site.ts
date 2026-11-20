import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import { claimSiteBuild } from "@tawd/core/paid-starts";
import { callCost, costOf, formatCost, modelLabel } from "@tawd/core/mockups";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { SITE_BUILD_JOB, siteBuildJobId } from "@tawd/core/queue";
import { aiCall, designCopy, designFinding, designPage, designReview, figmaDesign, netlifySite, previewDecision, project, siteBuild, siteDeploy, styleKit } from "@tawd/core/schema";
import { estimateDesignReview, factsStatus, homeFrameImage, loadDesignReview } from "@/lib/design-review";
import { getStorage } from "@tawd/core/intake/storage";
import type { DesignBuildOptions, SiteVideo } from "@tawd/core/site";
import type { StyleKit } from "@tawd/core/style-kit/kit";
import { reusableDesignAnswers } from "@tawd/core/saved-answers";
import { stepModelConfig } from "@tawd/core/step-models";
import { pagesFor } from "@/lib/exact-design";
import { designSourceWords } from "@/lib/figma";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Lane 2, simply (Jason, 29 September 2026): Upload design, then Build site
  (estimate first, the home page first by default), then Preview (each
  design page beside its built page, the check's notes, the search listing,
  feedback that reworks only its page, or approve), then launch. The
  exact-copy tools stay for admins only.
*/

type Db = ServiceContext["db"];

export class DesignSiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSiteError";
  }
}

/* First guesses until real builds are measured: a page's pictures and words in, its HTML and CSS out. */
export const DESIGN_PARTS_GUESS = { inputTokens: 14_000, outputTokens: 9_000 };
export const DESIGN_PAGE_GUESS = { inputTokens: 16_000, outputTokens: 25_000 };
export const DESIGN_REWORK_GUESS = { inputTokens: 30_000, outputTokens: 25_000 };

/*
  One call's price for a step, learned from what the latest real calls cost
  (Jason, 29 September 2026: "estimates that learn from actual costs"): the
  last 20 first-round calls on the model the step uses now, so a change of
  model or of price shows at once; else the first guess.
*/
async function perCall(db: Db, step: string, guess: { inputTokens: number; outputTokens: number }): Promise<{ cost: number; measured: boolean; model: string }> {
  const config = await stepModelConfig(db, step);
  const calls = await db.select().from(aiCall).where(and(eq(aiCall.step, step), eq(aiCall.round, 1), eq(aiCall.model, config.model))).orderBy(desc(aiCall.createdAt)).limit(20);
  if (calls.length) return { cost: calls.reduce((n, c) => n + costOf(c, config), 0) / calls.length, measured: true, model: config.model };
  return { cost: costOf(guess, config), measured: false, model: config.model };
}

export interface DesignEstimate {
  cost: number;
  label: string;
  aiPages: number;
  filledPages: number;
  /** Calls answered from a build that didn't finish, for $0. */
  reused: number;
}

/* What building these pages costs: the header and footer (the first time), one AI pass per page, nothing for pages filled by code. */
export async function estimateDesignBuild(db: Db, projectId: string, slugs: string[]): Promise<DesignEstimate> {
  const plan = await pagesOf(db, projectId);
  const chosen = plan.pages.filter((p) => slugs.includes(p.key));
  const filled = chosen.filter((p) => p.filledFrom && (slugs.includes(p.filledFrom.key) || p.filledFrom.built));
  const ai = chosen.length - filled.length;
  const parts = plan.partsBuilt ? null : await perCall(db, "design_site_parts", DESIGN_PARTS_GUESS);
  const page = await perCall(db, "design_site_page", DESIGN_PAGE_GUESS);
  // Answers a build that didn't finish already paid for: reused for $0 (the worker checks the question is the same).
  const saved = await reusableDesignAnswers(db, getStorage(), projectId);
  const has = (step: string, label: string) => saved.some((a) => a.step === step && a.label === label);
  const partsReused = Boolean(parts) && has("design_site_parts", "The header and footer");
  const aiChosen = chosen.filter((p) => !filled.includes(p));
  const pagesReused = aiChosen.filter((p) => has("design_site_page", p.name));
  const reused = (partsReused ? 1 : 0) + pagesReused.length;
  const cost = (parts && !partsReused ? parts.cost : 0) + page.cost * (ai - pagesReused.length);
  if (reused > 0 && cost === 0) {
    const what = [partsReused ? "the header and footer" : null, ...pagesReused.map((p) => p.name)].filter(Boolean).join(" and ");
    return { cost, aiPages: ai, filledPages: filled.length, reused, label: `$0, reusing saved answers: ${what}, from the build that didn't finish.` };
  }
  const bits = [
    parts ? `the header and footer${partsReused ? " (reused, $0)" : ""}` : null,
    `${ai} page${ai === 1 ? "" : "s"} built from ${ai === 1 ? "its" : "their"} design${pagesReused.length ? ` (${pagesReused.length} reused, $0)` : ""}`,
    filled.length ? `${filled.length} filled by code from a page with the same layout ($0)` : null,
  ].filter(Boolean);
  return {
    cost,
    aiPages: ai,
    filledPages: filled.length,
    reused,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(page.model)}: ${bits.join(", ")}${page.measured ? ", from the builds so far" : " (a first guess until a page has been built)"}.`,
  };
}

interface PlanPage {
  id: string;
  key: string;
  name: string;
  slug: string;
  isHome: boolean;
  frameId: string;
  built: boolean;
  filledFrom: { key: string; name: string; built: boolean } | null;
}

async function pagesOf(db: Db, projectId: string): Promise<{ version: string | null; pages: PlanPage[]; partsBuilt: boolean; lastDesignBuild: typeof siteBuild.$inferSelect | null }> {
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const version = figma?.importedVersion ?? null;
  const rows = version ? await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, version))).orderBy(asc(designPage.position)) : [];
  const builds = await db.select().from(siteBuild).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done"))).orderBy(desc(siteBuild.version));
  const last = builds.find((b) => (b.options as DesignBuildOptions | null)?.kind === "design") ?? null;
  const builtPaths = new Set(((last?.pages as { path: string }[] | null) ?? []).map((p) => p.path));
  const [kitRow] = version
    ? await db.select({ kit: styleKit.kit }).from(styleKit).where(and(eq(styleKit.projectId, projectId), eq(styleKit.status, "done"), eq(styleKit.designVersion, version))).orderBy(desc(styleKit.createdAt)).limit(1)
    : [];
  const groups = ((kitRow?.kit as StyleKit | null)?.sharedLayouts ?? []);
  const key = (r: { isHome: boolean; slug: string }) => (r.isHome ? "home" : r.slug);
  const pages = rows.map((r) => {
    const group = groups.find((g) => g.pages.includes(r.frameId) && g.pages[0] !== r.frameId);
    const t = group ? rows.find((x) => x.frameId === group.pages[0]) : undefined;
    const path = r.isHome ? "/" : `/${r.slug}/`;
    return {
      id: r.id,
      key: key(r),
      name: r.name,
      slug: r.slug,
      isHome: r.isHome,
      frameId: r.frameId,
      built: builtPaths.has(path),
      filledFrom: t ? { key: key(t), name: t.name, built: builtPaths.has(t.isHome ? "/" : `/${t.slug}/`) } : null,
    };
  });
  return { version, pages, partsBuilt: Boolean(last), lastDesignBuild: last };
}

function canRun(actor: Viewer): boolean {
  return can(actor, "project.edit") || can(actor, "design.decide");
}

async function queueBuild(ctx: ServiceContext, actor: Viewer, projectId: string, options: DesignBuildOptions, estimate: { cost: number; label: string }): Promise<string> {
  const [running] = await ctx.db.select({ id: siteBuild.id }).from(siteBuild).where(and(eq(siteBuild.projectId, projectId), inArray(siteBuild.status, ["queued", "working"]))).limit(1);
  if (running) throw new DesignSiteError("The site is already being built.");
  if (estimate.cost > 0) {
    try {
      await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.cost });
    } catch (error) {
      if (error instanceof SpendError) throw new DesignSiteError(error.message);
      throw error;
    }
  }
  // The estimate goes with the build: it stops itself at twice it.
  const build = await claimSiteBuild(ctx.db, projectId, { startedByUserId: actor.id, options: estimate.cost > 0 ? { ...options, estimate: estimate.cost } : options });
  if (!build) throw new DesignSiteError("The site is already being built.");
  const { version } = build;
  try {
    await getQueue().add(SITE_BUILD_JOB, { buildId: build!.id, projectId }, { jobId: siteBuildJobId(build!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(siteBuild).where(eq(siteBuild.id, build!.id));
    throw new DesignSiteError("The build couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "site.build_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version, from: "the design", ...(options.only ? { pages: options.only } : {}), ...(options.rework ? { rework: options.rework } : {}), estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return build!.id;
}

/* Builds the chosen pages from the design (paid, the estimate shown first); the rest are kept from the last build. */
export async function startDesignBuild(ctx: ServiceContext, actor: Viewer, projectId: string, slugs: string[]): Promise<string> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const plan = await pagesOf(ctx.db, projectId);
  if (!plan.version || plan.pages.length === 0) throw new DesignSiteError("Upload the design first: its pages are what the site is built from.");
  const chosen = slugs.filter((s) => plan.pages.some((p) => p.key === s));
  if (chosen.length === 0) throw new DesignSiteError("Choose at least one page to build.");
  await assertReviewStepDone(ctx.db, projectId, Boolean(plan.lastDesignBuild));
  const estimate = await estimateDesignBuild(ctx.db, projectId, chosen);
  return queueBuild(ctx, actor, projectId, { kind: "design", only: chosen }, estimate);
}

/*
  The free check before a paid build (Jason, 29 September 2026: "a free dry
  run before any paid run"): the same build, with stand-ins for the AI,
  nothing kept or deployed. It says what the real build would ask the AI,
  what it would reuse for $0, and whether the pictures and pages are ready.
*/
export async function checkDesignBuild(ctx: ServiceContext, actor: Viewer, projectId: string, slugs: string[]): Promise<string> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const plan = await pagesOf(ctx.db, projectId);
  if (!plan.version || plan.pages.length === 0) throw new DesignSiteError("Upload the design first: its pages are what the site is built from.");
  const chosen = slugs.filter((s) => plan.pages.some((p) => p.key === s));
  if (chosen.length === 0) throw new DesignSiteError("Choose at least one page to check.");
  const real = await estimateDesignBuild(ctx.db, projectId, chosen);
  return queueBuild(ctx, actor, projectId, { kind: "design", only: chosen, dryRun: true, estimate: real.cost }, { cost: 0, label: `Free check (no AI) of a build estimated at: ${real.label}` });
}

/* Feedback on one built page: only that page goes back to the AI, with its design and the feedback. */
export async function reworkDesignPage(ctx: ServiceContext, actor: Viewer, projectId: string, key: string, feedback: string): Promise<string> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const words = feedback.trim();
  if (words.length < 5) throw new DesignSiteError("Say what should change on the page.");
  const plan = await pagesOf(ctx.db, projectId);
  const page = plan.pages.find((p) => p.key === key);
  if (!page?.built) throw new DesignSiteError("Build that page first; then say what should change.");
  const price = await perCall(ctx.db, "design_site_rework", DESIGN_REWORK_GUESS);
  return queueBuild(ctx, actor, projectId, { kind: "design", rework: { slug: key, feedback: words.slice(0, 2000) } }, { cost: price.cost, label: `About ${formatCost(price.cost)} of AI on ${modelLabel(price.model)} to rework ${page.name}.` });
}

/* The site put together again from the last build, with the approved search listings and the videos: no AI, $0. */
export async function refreshDesignSite(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const plan = await pagesOf(ctx.db, projectId);
  if (!plan.lastDesignBuild) throw new DesignSiteError("Build the site first.");
  return queueBuild(ctx, actor, projectId, { kind: "design", only: ["-"] }, { cost: 0, label: "Free: the pages as built, with the changes, no AI." });
}

/* One build's spend against its estimate: "Version 3 cost $0.73 of AI (estimated $0.40); 2 answers reused, $0." */
export async function costOfBuild(db: Db, build: typeof siteBuild.$inferSelect): Promise<string> {
  const calls = await db.select().from(aiCall).where(eq(aiCall.runId, build.id));
  const spent = calls.reduce((n, c) => n + callCost(c), 0);
  const estimate = (build.options as DesignBuildOptions | null)?.estimate;
  const notes = ((build.pages as { notes?: string[] }[] | null) ?? []).flatMap((p) => p.notes ?? []);
  const reused = notes.filter((n) => /reused \(\$0\)/.test(n)).length;
  return `Version ${build.version} cost ${formatCost(spent)} of AI${estimate ? ` (estimated ${formatCost(estimate)})` : calls.length === 0 ? " (no AI)" : ""}${reused ? `; ${reused} saved answer${reused === 1 ? "" : "s"} reused, $0` : ""}.`;
}

function checkLine(build: typeof siteBuild.$inferSelect): { state: "running" | "passed" | "failed"; line: string } {
  if (build.status === "queued" || build.status === "working") return { state: "running", line: `Checking the build for free${build.step ? `: ${build.step}` : ""}...` };
  if (build.status === "failed") return { state: "failed", line: `The free check found a problem, so a paid build would have failed too: ${build.failureReason ?? "unknown reason"} Nothing was spent.` };
  const r = ((build.checks as { dryRun?: { calls: number; reused: number; pictures: number; originals: number; trimmed: number; pages: string[] } } | null) ?? {}).dryRun;
  if (!r) return { state: "passed", line: "The free check passed." };
  const estimate = (build.options as DesignBuildOptions | null)?.estimate;
  const paid = r.calls - r.reused;
  return {
    state: "passed",
    line: `The free check passed: the build would ask the AI ${paid} time${paid === 1 ? "" : "s"}${r.reused ? ` and reuse ${r.reused} saved answer${r.reused === 1 ? "" : "s"} ($0)` : ""}${estimate !== undefined ? `, about ${formatCost(estimate)}` : ""}${r.pages.length ? ` (${r.pages.join(", ")})` : ""}. ${r.pictures} picture${r.pictures === 1 ? "" : "s"} ready${r.originals ? `, ${r.originals} from the intake's originals` : ""}${r.trimmed ? `, ${r.trimmed} trimmed of design marks` : ""}. Nothing was spent.`,
  };
}

export async function estimateRework(db: Db): Promise<string> {
  const price = await perCall(db, "design_site_rework", DESIGN_REWORK_GUESS);
  return `About ${formatCost(price.cost)} of AI on ${modelLabel(price.model)} for the page.`;
}

/* An admin tool (Jason, 29 September 2026: "undo the kit repair"): the repaired and filled copies taken away, the originals shown again. */
export async function undoKitRepair(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "money.manage");
  const rows = await ctx.db
    .select({ id: designCopy.id, name: designCopy.frameName })
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), or(isNotNull(designCopy.repairOf), isNotNull(designCopy.filledFrom))));
  if (rows.length) await ctx.db.delete(designCopy).where(inArray(designCopy.id, rows.map((r) => r.id)));
  await recordActivity(ctx.db, { action: "design.kit_repair_undone", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { removed: rows.map((r) => r.name) }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return rows.length;
}

/* ---------- Option B's first step: the review and its suggestions (Jason, 29 September 2026) ---------- */

export interface ReviewSuggestion {
  id: string;
  number: number;
  grade: string;
  gradeLabel: string;
  title: string;
  problem: string;
  change: string;
  where: string | null;
  pin: { x: number; y: number } | null;
  /** Must-fix suggestions start accepted; the rest wait for a yes or a no. */
  decision: "accepted" | "rejected" | "open";
  byDefault: boolean;
}

export interface ReviewStep {
  status: "none" | "queued" | "working" | "done" | "failed";
  failure: string | null;
  estimate: { cost: number; label: string };
  skipped: boolean;
  outOfDate: boolean;
  summary: string | null;
  average: number | null;
  suggestions: ReviewSuggestion[];
  facts: { title: string; problem: string }[];
  unconfirmedFacts: number;
  designUrl: string | null;
  /** Build is open: the review is done, or skipped, or the site was built already. */
  done: boolean;
}

const GRADE_LABEL: Record<string, string> = { must_fix: "Must-fix", should_fix: "Should-fix", recommendation: "Suggestion" };

/* The suggestion's state from its tick: ticked = accepted; unticked by a person = rejected; unticked and untouched = open. */
function decisionOf(f: typeof designFinding.$inferSelect): { decision: ReviewSuggestion["decision"]; byDefault: boolean } {
  if (f.ticked) return { decision: "accepted", byDefault: !f.tickedByUserId };
  return { decision: f.tickedByUserId ? "rejected" : "open", byDefault: false };
}

async function loadReviewStep(db: Db, projectId: string, figma: typeof figmaDesign.$inferSelect | undefined, built: boolean): Promise<ReviewStep> {
  const review = await loadDesignReview(db, projectId);
  const estimate = await estimateDesignReview(db);
  const findings = review?.findings ?? [];
  const home = await homeFrameImage(db, projectId);
  const facts = await factsStatus(db, projectId);
  return {
    status: review ? review.status : "none",
    failure: review?.failureReason ?? null,
    estimate: { cost: estimate.cost, label: estimate.label },
    skipped: Boolean(figma?.reviewSkippedAt),
    outOfDate: review?.outOfDate ?? false,
    summary: review?.review?.summary ?? null,
    average: review?.review?.average ?? null,
    suggestions: findings
      .filter((f) => f.grade !== "confirm_fact")
      .map((f) => ({
        id: f.id,
        number: f.number,
        grade: f.grade,
        gradeLabel: GRADE_LABEL[f.grade] ?? f.grade,
        title: f.title,
        problem: f.problem,
        change: f.change,
        where: f.layerName,
        pin: f.pinX != null && f.pinY != null ? { x: f.pinX, y: f.pinY } : null,
        ...decisionOf(f),
      })),
    facts: findings.filter((f) => f.grade === "confirm_fact").map((f) => ({ title: f.title, problem: f.problem })),
    unconfirmedFacts: facts.unconfirmed,
    designUrl: home?.imageUrl ?? null,
    done: review?.status === "done" || Boolean(figma?.reviewSkippedAt) || built,
  };
}

async function newestReview(db: Db, projectId: string) {
  const [latest] = await db.select().from(designReview).where(eq(designReview.projectId, projectId)).orderBy(desc(designReview.createdAt)).limit(1);
  return latest ?? null;
}

/* Accept or reject one suggestion of the newest review (any grade but the facts). Logged, before and after. */
export async function decideSuggestion(ctx: ServiceContext, actor: Viewer, projectId: string, findingId: string, decision: "accepted" | "rejected"): Promise<void> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const [finding] = await ctx.db.select().from(designFinding).where(and(eq(designFinding.id, findingId), eq(designFinding.projectId, projectId))).limit(1);
  if (!finding || finding.grade === "confirm_fact") throw new DesignSiteError("That suggestion no longer exists.");
  const latest = await newestReview(ctx.db, projectId);
  if (latest?.id !== finding.reviewId) throw new DesignSiteError("This review has been replaced by a newer one. Refresh the page.");
  const before = decisionOf(finding).decision;
  if (before === decision) return;
  await ctx.db.update(designFinding).set({ ticked: decision === "accepted", tickedByUserId: actor.id, tickedAt: new Date() }).where(eq(designFinding.id, findingId));
  await recordActivity(ctx.db, {
    action: "design.suggestion_decided",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { decision: before },
    valueAfter: { number: finding.number, title: finding.title, grade: finding.grade, decision },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Accept or reject every suggestion still open, in one go; one log entry. */
export async function decideOpenSuggestions(ctx: ServiceContext, actor: Viewer, projectId: string, decision: "accepted" | "rejected"): Promise<number> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const latest = await newestReview(ctx.db, projectId);
  if (!latest || latest.status !== "done") throw new DesignSiteError("There is no finished review to decide on.");
  const open = (await ctx.db.select().from(designFinding).where(eq(designFinding.reviewId, latest.id))).filter((f) => f.grade !== "confirm_fact" && decisionOf(f).decision === "open");
  if (open.length === 0) return 0;
  await ctx.db.update(designFinding).set({ ticked: decision === "accepted", tickedByUserId: actor.id, tickedAt: new Date() }).where(inArray(designFinding.id, open.map((f) => f.id)));
  await recordActivity(ctx.db, {
    action: "design.suggestion_decided",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { decision, count: open.length, numbers: open.map((f) => f.number), all: true },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return open.length;
}

/* Build without the review ($0): who and when are kept, and logged. */
export async function skipDesignReview(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!canRun(actor)) assertCan(actor, "project.edit");
  const [figma] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma) throw new DesignSiteError("Upload the design first.");
  if (figma.reviewSkippedAt) return;
  await ctx.db.update(figmaDesign).set({ reviewSkippedAt: new Date(), reviewSkippedByUserId: actor.id }).where(eq(figmaDesign.projectId, projectId));
  await recordActivity(ctx.db, { action: "design.review_skipped", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { skipped: true }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

async function assertReviewStepDone(db: Db, projectId: string, built: boolean): Promise<void> {
  const [row] = await db.select({ laneOption: project.laneOption }).from(project).where(eq(project.id, projectId)).limit(1);
  if (row?.laneOption !== "b" || built) return;
  const [figma] = await db.select({ skipped: figmaDesign.reviewSkippedAt }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const latest = await newestReview(db, projectId);
  if (figma?.skipped || latest?.status === "done") return;
  throw new DesignSiteError("Review the design first (or skip the review); then build the site.");
}

export interface DesignFlowView {
  optionB: boolean;
  review: ReviewStep | null;
  step: "review" | "design" | "build" | "preview";
  design: { ready: boolean; pages: number; source: string };
  pages: { id: string; key: string; name: string; slug: string; isHome: boolean; built: boolean; filledFrom: string | null }[];
  videos: string;
  estimates: { home: DesignEstimate; all: DesignEstimate };
  reworkLabel: string;
  building: { status: string; step: string | null; failure: string | null; cost: string | null } | null;
  /** What the last builds cost against their estimates, for the team (29 September 2026). */
  costLine: string | null;
  /** The latest free check: running, what it found, or what stopped it. */
  check: { state: "running" | "passed" | "failed"; line: string } | null;
  preview: {
    version: number;
    pages: {
      key: string;
      name: string;
      path: string;
      designUrl: string | null;
      shotUrl: string | null;
      notes: string[];
      listing: { title: string; description: string; h1: string; alts: { src: string; alt: string }[]; approved: boolean } | null;
      pageId: string;
    }[];
  } | null;
  /** privateWarning: Netlify refused a signed-out visitor (its visibility setting); what to change. */
  site: { url: string | null; deploying: boolean; deployFailed: string | null; privateWarning: string | null };
  approved: boolean;
  canRun: boolean;
  isAdmin: boolean;
}

export async function loadDesignFlow(db: Db, projectId: string, viewer: Viewer): Promise<DesignFlowView | null> {
  const [row] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (row?.lane !== "lane_2") return null;
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  // The design's pages, proposed from its frames the first time.
  if (figma?.importStatus === "done" && figma.importedVersion) await pagesFor(db, projectId, figma);
  const plan = await pagesOf(db, projectId);
  const storage = getStorage();
  const [current] = await db.select().from(siteBuild).where(eq(siteBuild.projectId, projectId)).orderBy(desc(siteBuild.version)).limit(1);
  const isCheck = (b: typeof siteBuild.$inferSelect | undefined) => Boolean((b?.options as DesignBuildOptions | null)?.dryRun);
  const building = current && !isCheck(current) && (current.status === "queued" || current.status === "working" || current.status === "failed") && (current.options as DesignBuildOptions | null)?.kind === "design"
    ? { status: current.status, step: current.step, failure: current.failureReason, cost: await costOfBuild(db, current) }
    : null;
  const last = plan.lastDesignBuild;
  const rows = plan.version ? await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, plan.version))) : [];
  const preview = last
    ? {
        version: last.version,
        pages: await Promise.all(
          ((last.pages as { pageId: string; name: string; path: string; designKey?: string | null; fullShotKey?: string | null; shotKey?: string | null; notes?: string[] }[] | null) ?? []).map(async (p) => {
            const dp = rows.find((r) => r.id === p.pageId);
            type Seo = { title: string; description: string; h1: string; alts: { src: string; alt: string }[] };
            const seo = (dp?.seo as { suggested?: Seo; approved?: Seo } | null) ?? null;
            const from = seo?.approved ?? seo?.suggested;
            const listing = from ? { title: from.title, description: from.description, h1: from.h1, alts: from.alts ?? [], approved: Boolean(seo?.approved) } : null;
            return {
              key: p.path === "/" ? "home" : p.path.replace(/\//g, ""),
              name: p.name,
              path: p.path,
              designUrl: p.designKey ? await storage.signDownload(p.designKey, `${p.name} design.png`) : null,
              shotUrl: p.fullShotKey ? await storage.signDownload(p.fullShotKey, `${p.name}.jpg`) : p.shotKey ? await storage.signDownload(p.shotKey, `${p.name}.jpg`) : null,
              notes: p.notes ?? [],
              listing,
              pageId: p.pageId,
            };
          }),
        ),
      }
    : null;
  const [site] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  const [deploy] = await db.select().from(siteDeploy).where(eq(siteDeploy.projectId, projectId)).orderBy(desc(siteDeploy.createdAt)).limit(1);
  const [decision] = await db.select().from(previewDecision).where(eq(previewDecision.projectId, projectId)).orderBy(desc(previewDecision.createdAt)).limit(1);
  const ready = Boolean(figma?.importStatus === "done" && plan.pages.length);
  const videos = ((row.videos as SiteVideo[] | null) ?? []).map((v) => (v.title ? `${v.url} | ${v.title}` : v.url)).join("\n");
  const homeKey = plan.pages.find((p) => p.isHome)?.key ?? plan.pages[0]?.key ?? "home";
  const optionB = row.laneOption === "b";
  const review = optionB && ready ? await loadReviewStep(db, projectId, figma, Boolean(last) || Boolean(building)) : null;
  return {
    optionB,
    review,
    step: !ready ? "design" : review && !review.done ? "review" : preview ? "preview" : "build",
    design: { ready, pages: plan.pages.length, source: figma ? designSourceWords(figma) : "Figma" },
    pages: plan.pages.map((p) => ({ id: p.id, key: p.key, name: p.name, slug: p.slug, isHome: p.isHome, built: p.built, filledFrom: p.filledFrom?.name ?? null })),
    videos,
    // "All": the pages not built yet once some are (else every page).
    estimates: {
      home: await estimateDesignBuild(db, projectId, [homeKey]),
      all: await estimateDesignBuild(db, projectId, (plan.pages.some((p) => p.built) ? plan.pages.filter((p) => !p.built) : plan.pages).map((p) => p.key)),
    },
    reworkLabel: await estimateRework(db),
    costLine: last ? await costOfBuild(db, last) : null,
    check: current && isCheck(current) ? checkLine(current) : null,
    building,
    preview,
    site: {
      // The share link only once a deploy has finished, and that deploy's own address (the plain site address can say "Site not found" before).
      url: deploy?.state === "ready" ? (deploy.url ?? site?.url ?? null) : null,
      deploying: deploy?.state === "uploading",
      deployFailed: deploy?.state === "failed" ? deploy.error : null,
      privateWarning: deploy?.state === "ready" ? deploy.accessWarning : null,
    },
    approved: decision?.outcome === "approved",
    canRun: canRun(viewer),
    isAdmin: can(viewer, "money.manage"),
  };
}
