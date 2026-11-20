import { and, asc, desc, eq, gt } from "drizzle-orm";

import { activityLog, keywordResearch, pageDraft, pagePlanPage, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, can, type Viewer } from "@tawd/core/permissions";
import { formatCost } from "@tawd/core/mockups";
import { projectTypeFor, usesSuppliedHome } from "@tawd/core/site-read";
import { ContentError, estimateDraft, estimateLabel, startDrafts } from "@/lib/content-drafts";
import { estimateKeywordResearch, makePagePlan, startKeywordResearch } from "@/lib/seo-data";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Prepare the content (Jason, 7 October 2026; flow redesign Part C,
  0.100.0): one consent for the paid parts of Everything new (and the
  client's own words): keyword research, then the page plan (code, free),
  then the Home page's draft. One page first (rules 2, 8 and 9): the rest
  are drafted together once the Home page is checked, from Draft and
  approve each page. TAWD runs the steps in order by itself: the plan and
  the Home draft follow the research as soon as it finishes.
*/

type Db = ServiceContext["db"];

export interface PrepareView {
  /** Keyword research is part of the run (not done yet, and DataForSEO can be asked). */
  research: { included: boolean; line: string; usd: number; why: string | null; ticked: boolean };
  /** The Home page's draft, and the plan before it when there's none. Null when the home page is the supplied design, which keeps its own words. */
  homeLine: string | null;
  planLine: string;
  total: string;
  cheaper: string;
  usable: string;
  /** Pages in the plan after the Home page (0 before the plan exists). */
  rest: number;
}

const homeOf = <T extends { kind: string }>(pages: T[]) => pages.find((p) => p.kind === "home") ?? pages[0] ?? null;

const planPages = (db: Db, projectId: string) => db.select({ id: pagePlanPage.id }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));

/* What Prepare the content would do now, or null when it isn't for this project or the Home page already has words. */
export async function loadPrepareView(db: Db, viewer: Viewer, projectId: string): Promise<PrepareView | null> {
  const [proj] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  // Lane 2 takes its words from the design (Fable's review M1).
  if (!proj || proj.lane === "lane_2") return null;
  const type = await projectTypeFor(db, projectId);
  if (type !== "everything_new" && type !== "client_words" && type !== null) return null;
  /*
    A supplied homepage (17 November 2026) keeps its own words: its Home page
    is never drafted, so this step never asks for that draft. What is left of
    it is the keyword research, and the plan that follows. With no research to
    decide on there is nothing paid here at all, and the card goes: the page
    plan has its own step, and the other pages are drafted from Page drafts.
  */
  const suppliedHome = await usesSuppliedHome(db, projectId);
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  const home = homeOf(pages);
  if (home) {
    const [draft] = await db.select({ id: pageDraft.id }).from(pageDraft).where(eq(pageDraft.pageId, home.id)).limit(1);
    if (draft) return null;
  }
  const [lastResearch] = await db.select({ status: keywordResearch.status }).from(keywordResearch).where(eq(keywordResearch.projectId, projectId)).orderBy(desc(keywordResearch.createdAt)).limit(1);
  const researchDone = lastResearch?.status === "done";
  const estimate = researchDone ? null : await estimateKeywordResearch(db, viewer, projectId);
  const canResearch = Boolean(estimate && !estimate.blocked && can(viewer, "seo.research"));
  const usd = canResearch && estimate && !estimate.sandbox ? estimate.estimateUsd : 0;
  const draft = await estimateDraft(db);
  const research = researchDone
    ? { included: false, line: "Keyword research: done already.", usd: 0, why: null, ticked: false }
    : canResearch
      ? {
          included: true,
          line: `Keyword research: ${estimate!.keywords} keywords in ${estimate!.places.length} place${estimate!.places.length === 1 ? "" : "s"}, ${estimate!.sandbox ? "free (DataForSEO's sandbox test data)" : `about $${usd.toFixed(2)} of DataForSEO lookups`}.`,
          usd,
          // On the sandbox (8 October 2026): its numbers are made up, so it starts unticked and says why.
          why: estimate!.sandbox ? "Left out for now: DataForSEO is on its free sandbox, whose numbers are test data, not real searches. The plan then uses the intake's words." : null,
          ticked: !estimate!.sandbox,
        }
      : { included: false, line: "Keyword research: skipped.", usd: 0, why: estimate?.blocked ?? "Only the SEO team or an admin starts keyword research.", ticked: false };
  if (suppliedHome && !research.included) return null;
  return {
    research,
    planLine: pages.length
      ? `Page plan: ${pages.length} page${pages.length === 1 ? "" : "s"} already planned (kept as they are; Make the page plan again on its step works new keywords in).`
      : suppliedHome
        ? "Page plan: made by code from the menu of the design the client approved (free)."
        : "Page plan: made by code from the tier, the intake and the keywords (free).",
    homeLine: suppliedHome ? null : `The Home page's draft: ${estimateLabel(draft, 1)}`,
    total: `About ${formatCost(research.usd + (suppliedHome ? 0 : draft.perPage))} in all.`,
    cheaper: suppliedHome
      ? "The cheaper way: leave keyword research out (the plan is made from the design's menu either way, free), or put Page drafts on Sonnet 5 on Spend."
      : "The cheaper way: leave keyword research out (the plan then uses the intake's words, free), or put Page drafts on Sonnet 5 on Spend.",
    usable: suppliedHome
      ? "The home page keeps the supplied design's own words, so it is not drafted here and nothing is paid for it. The other pages are drafted together from the next step; nothing reaches the client before it's approved."
      : "The Home page comes back for Content's review in a few minutes; nothing reaches the client before it's approved. The other pages are drafted together after that, from the next step.",
    rest: Math.max(0, pages.length - 1),
  };
}

/* Run it: the research (when asked), then the plan when there's none, then the Home page's draft. */
export async function prepareContent(ctx: ServiceContext, actor: Viewer, projectId: string, input: { keywords: boolean }): Promise<"research" | "drafting" | "planned"> {
  assertCan(actor, "content.plan");
  const view = await loadPrepareView(ctx.db, actor, projectId);
  if (!view) {
    // Say which it is: before this, a supplied homepage reached the engine, which refused the draft with "Choose at least one page to draft."
    if (await usesSuppliedHome(ctx.db, projectId)) throw new ContentError("The home page keeps the supplied design's own words, so there is nothing to prepare here. Make the page plan on its own step, and draft the other pages from Page drafts.");
    throw new ContentError("The Home page already has words, or this project's words don't come from TAWD's drafts.");
  }
  const suppliedHome = view.homeLine === null;
  const withResearch = input.keywords && view.research.included;
  /*
    No button that does nothing (a review of the first version): with the home
    page supplied, the plan already made and the research left out, pressing
    Start would have made no plan, drafted nothing, and left the card where it
    was. It says so, and names both ways forward.
  */
  if (suppliedHome && !withResearch && view.rest + 1 > 0 && (await planPages(ctx.db, projectId)).length > 0) {
    throw new ContentError("There is nothing left to prepare: the page plan is made, and the home page keeps the supplied design's own words. Tick keyword research to run it, or draft the other pages from Draft and approve each page.");
  }
  const planAndHome = async () => {
    let pages = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
    if (pages.length === 0) {
      await makePagePlan(ctx, actor, projectId);
      pages = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
    }
    const home = homeOf(pages);
    if (!home) throw new ContentError("The page plan came out empty.");
    if (suppliedHome) return;
    await startDrafts(ctx, actor, projectId, { pageIds: [home.id] });
  };
  // The Home page's draft is checked against the monthly AI limit now, at the consent, not minutes later (Fable's review M3).
  if (!suppliedHome) {
    const draft = await estimateDraft(ctx.db);
    try {
      await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: draft.perPage });
    } catch (error) {
      if (error instanceof SpendError) throw new ContentError(error.message);
      throw error;
    }
  }
  const logStarted = () =>
    recordActivity(ctx.db, {
      action: "content.prepare_started",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueAfter: { keywords: withResearch, steps: [withResearch ? view.research.line : null, view.planLine, view.homeLine].filter(Boolean), estimate: withResearch ? view.total : view.homeLine },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  if (withResearch) {
    // After the research: the plan and the Home draft. A failure there is logged, and Content shows it on the words step.
    await startKeywordResearch(ctx, actor, projectId, {
      then: () =>
        planAndHome().catch((error: unknown) =>
          recordActivity(ctx.db, {
            action: "content.prepare_stopped",
            entityType: "project",
            entityId: projectId,
            ...actorFields(SYSTEM_ACTOR),
            valueAfter: { reason: error instanceof Error ? error.message : "unknown" },
            ipAddress: null,
            userAgent: null,
          }),
        ),
    });
    await logStarted();
    return "research";
  }
  await planAndHome();
  await logStarted();
  return suppliedHome ? "planned" : "drafting";
}

/* Why Prepare the content stopped after the research, when it did and nothing has been drafted since (shown on the words step). */
export async function prepareStopped(db: Db, projectId: string): Promise<string | null> {
  const [stopped] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, projectId), eq(activityLog.action, "content.prepare_stopped"))).orderBy(desc(activityLog.occurredAt)).limit(1);
  if (!stopped) return null;
  const [drafted] = await db.select({ id: pageDraft.id }).from(pageDraft).where(and(eq(pageDraft.projectId, projectId), gt(pageDraft.createdAt, stopped.occurredAt))).limit(1);
  if (drafted) return null;
  const reason = (stopped.valueAfter as { reason?: string } | null)?.reason ?? "unknown";
  return `Prepare the content stopped after the keyword research: ${reason} Draft the Home page from this step, or make the plan first.`;
}
