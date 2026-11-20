import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, pagePlanPage, seoGoLiveCheck, siteBuild } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { claimSeoGoLiveCheck } from "@tawd/core/paid-starts";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { SEO_GOLIVE_JOB, seoGoLiveJobId } from "@tawd/core/queue";
import { costOf, formatCost } from "@tawd/core/mockups";
import { pagePath, type SeoFinding } from "@tawd/core/site";
import { META_LIMIT, TITLE_LIMIT, fitTo } from "@/lib/seo-plan";
import { createEditRequest } from "@/lib/edits";
import { getQueue } from "@/lib/mockups";
import { pacificToday } from "@/lib/spend-report";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  The Senior SEO Manager's check before go-live (Jason, 26 September
  2026): run on the latest build (paid AI, estimate first); its safe fixes
  made for the team (titles and descriptions in the page plan at once,
  content fixes as a monthly-edit request to make and put into the site);
  then the SEO team signs off that version, which go-live needs.
*/

type Db = Database;

export class SeoCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoCheckError";
  }
}

export const GOLIVE_GUESS = { inputTokens: 15_000, outputTokens: 3_000 };

export async function estimateSeoGoLive(db: Db): Promise<{ cost: number; label: string }> {
  const config = await stepModelConfig(db, "seo_golive_check");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "seo_golive_check"));
  const runs = new Set(calls.map((c) => c.runId)).size;
  const cost = runs ? calls.reduce((n, c) => n + costOf(c, config), 0) / runs : costOf(GOLIVE_GUESS, config);
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}${runs ? ", from the checks so far" : " (a first guess until a real check has run)"}. PageSpeed is free.` };
}

async function latestBuild(db: Db, projectId: string) {
  const [build] = await db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  return build ?? null;
}

export async function startSeoGoLiveCheck(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "seo.research");
  const build = await latestBuild(ctx.db, projectId);
  if (!build) throw new SeoCheckError("Build the site first: the check reads the built pages.");
  const [running] = await ctx.db.select().from(seoGoLiveCheck).where(eq(seoGoLiveCheck.projectId, projectId)).orderBy(desc(seoGoLiveCheck.createdAt)).limit(1);
  if (running && (running.status === "queued" || running.status === "working")) throw new SeoCheckError("The SEO check is already running.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateSeoGoLive(ctx.db)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new SeoCheckError(error.message);
    throw error;
  }
  const estimate = await estimateSeoGoLive(ctx.db);
  // Two clicks together start one paid check (13 October 2026, the whole-code review).
  const check = await claimSeoGoLiveCheck(ctx.db, projectId, { buildId: build.id, version: build.version, startedByUserId: actor.id });
  if (!check) throw new SeoCheckError("The SEO check is already running.");
  try {
    await getQueue().add(SEO_GOLIVE_JOB, { checkId: check!.id, projectId }, { jobId: seoGoLiveJobId(check!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(seoGoLiveCheck).where(eq(seoGoLiveCheck.id, check!.id));
    throw new SeoCheckError("The check couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "seo.golive_check_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: build.version, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  The safe fixes: titles and descriptions are shortened (or written) in
  the page plan now, free, and go into the next build; content fixes go
  into one monthly-edit request for the pages involved, which the team
  makes (AI, estimate first) and puts into the site as usual.
*/
export async function applySafeFixes(ctx: ServiceContext, actor: Viewer, projectId: string, checkId: string): Promise<{ planFixes: number; editPages: number }> {
  assertCan(actor, "content.plan");
  const [check] = await ctx.db.select().from(seoGoLiveCheck).where(and(eq(seoGoLiveCheck.id, checkId), eq(seoGoLiveCheck.projectId, projectId))).limit(1);
  if (!check || check.status !== "done") throw new SeoCheckError("There is no finished check to fix.");
  const findings = check.findings as SeoFinding[];
  const plan = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const pageAt = (path: string) => plan.find((p) => pagePath(p.slug) === path);
  let planFixes = 0;
  for (const f of findings.filter((x) => x.safe && x.via === "plan" && !x.fixed)) {
    const page = pageAt(f.page);
    if (!page) continue;
    const next = f.key.startsWith("title")
      ? { title: fitTo(page.title || `${page.name}`, TITLE_LIMIT) }
      : { metaDescription: fitTo(page.metaDescription || `${page.h1 || page.name}.`, META_LIMIT) };
    await ctx.db.update(pagePlanPage).set({ ...next, updatedAt: new Date() }).where(eq(pagePlanPage.id, page.id));
    f.fixed = true;
    planFixes += 1;
  }
  const edits = findings.filter((x) => x.safe && x.via === "edit" && !x.fixed && pageAt(x.page));
  const pageIds = [...new Set(edits.map((x) => pageAt(x.page)!.id))];
  let editRequestId: string | null = check.editRequestId;
  if (pageIds.length) {
    editRequestId = await createEditRequest(ctx, actor, projectId, {
      kind: "edit",
      clientWords: `SEO check before go-live: ${edits.map((x) => `${x.page}: ${x.fix}`).join(" ")}`.slice(0, 3900),
      teamNote: "From the Senior SEO Manager's check; safe fixes only.",
      requestedOn: pacificToday(),
      pageIds,
    });
    for (const f of edits) f.fixed = true;
  }
  await ctx.db.update(seoGoLiveCheck).set({ findings, editRequestId }).where(eq(seoGoLiveCheck.id, check.id));
  await recordActivity(ctx.db, {
    action: "seo.safe_fixes_applied",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { safeFixesInPlan: planFixes, pagesSentToEdit: pageIds.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { planFixes, editPages: pageIds.length };
}

/* The SEO team signs off one version of the built site. Go-live needs it. */
export async function signOffSeo(ctx: ServiceContext, actor: Viewer, projectId: string, checkId: string, note: string): Promise<void> {
  assertCan(actor, "seo.signoff");
  const [check] = await ctx.db.select().from(seoGoLiveCheck).where(and(eq(seoGoLiveCheck.id, checkId), eq(seoGoLiveCheck.projectId, projectId))).limit(1);
  if (!check || check.status !== "done") throw new SeoCheckError("Run the SEO check first.");
  const build = await latestBuild(ctx.db, projectId);
  if (!build || build.id !== check.buildId) throw new SeoCheckError("A newer build exists: run the SEO check on it, then sign off.");
  await ctx.db.update(seoGoLiveCheck).set({ signedOffByUserId: actor.id, signedOffAt: new Date(), signOffNote: note.trim().slice(0, 2000) || null }).where(eq(seoGoLiveCheck.id, check.id));
  await recordActivity(ctx.db, {
    action: "seo.golive_signed_off",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: check.version, note: note.trim().slice(0, 500) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function loadSeoGoLive(db: Db, projectId: string) {
  const [check] = await db.select().from(seoGoLiveCheck).where(eq(seoGoLiveCheck.projectId, projectId)).orderBy(desc(seoGoLiveCheck.createdAt)).limit(1);
  const build = await latestBuild(db, projectId);
  return {
    check: check ?? null,
    latestVersion: build?.version ?? null,
    /** Signed off for the latest build: what go-live needs. */
    signedOff: Boolean(check?.signedOffAt && build && check.buildId === build.id),
    estimate: await estimateSeoGoLive(db),
  };
}
