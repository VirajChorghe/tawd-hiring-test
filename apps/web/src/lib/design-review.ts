import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { aiCall, designFinding, designReview, figmaDesign, intakePrefill, project, user as userTable } from "@tawd/core/schema";
import { callCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { StoredDesignReview } from "@tawd/core/figma";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { getStorage } from "@tawd/core/intake/storage";
import { costOf, describeCallCosts, formatCost, getModelConfig } from "@tawd/core/mockups";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { DESIGN_REVIEW_JOB, designReviewJobId } from "@tawd/core/queue";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import { personLabel, type ServiceContext } from "@/lib/users";

/*
  Lane 2, Option B, stop 4b: the Creative Director's review of the
  designer's homepage, and the PM choosing which fixes go into the improved
  version. The review is the only paid step here, and its estimate is shown
  before anything is spent.
*/

type Db = ServiceContext["db"];

export class DesignReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignReviewError";
  }
}

/*
  A first guess until real reviews exist: about six images of the page, the
  layer list and the profile in; out, the reviewer's thinking (billed as
  output) and a long answer. The first real review (26 September 2026) had
  39 findings and 16 facts and cost about twice the old guess of 9,000
  tokens out, so the guess now allows for an answer that size.
*/
export const DESIGN_REVIEW_GUESS = { inputTokens: 32_000, outputTokens: 26_000 };

/* What one review costs: the average of past reviews once there are some, otherwise the guess. */
export async function estimateDesignReview(db: Db): Promise<{ cost: number; label: string; measured: boolean }> {
  const config = await stepModelConfig(db, "design_review");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "design_review"));
  const byReview = new Map<string, number>();
  for (const call of calls) byReview.set(call.runId, (byReview.get(call.runId) ?? 0) + costOf(call, config));
  if (byReview.size > 0) {
    const cost = [...byReview.values()].reduce((a, b) => a + b, 0) / byReview.size;
    return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}, from the reviews so far`, measured: true };
  }
  const cost = costOf(DESIGN_REVIEW_GUESS, config);
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} (a first guess until a real review has run)`, measured: false };
}

async function requireOptionB(db: Db, projectId: string): Promise<void> {
  const [row] = await db
    .select({ lane: project.lane, laneOption: project.laneOption })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw new DesignReviewError("That project no longer exists.");
  if (row.lane !== "lane_2" || row.laneOption !== "b") {
    throw new DesignReviewError("A design review is only for Lane 2, Option B (review and improve).");
  }
}

/* Queues the review of the imported homepage frame. Paid: the estimate was shown first. */
export async function startDesignReview(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  await requireOptionB(ctx.db, projectId);

  const [figma] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const home = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome);
  if (!figma || figma.importStatus !== "done" || !home?.imageKey || !figma.importedVersion) {
    throw new DesignReviewError("Import the designer's design first; the review works from the imported homepage.");
  }
  const [running] = await ctx.db
    .select({ id: designReview.id })
    .from(designReview)
    .where(and(eq(designReview.projectId, projectId), inArray(designReview.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new DesignReviewError("The design is already being reviewed.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateDesignReview(ctx.db)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new DesignReviewError(error.message);
    throw error;
  }

  const estimate = await estimateDesignReview(ctx.db);
  const [review] = await ctx.db
    .insert(designReview)
    .values({
      projectId,
      figmaVersion: figma.importedVersion,
      frameId: home.id,
      frameName: home.name,
      startedByUserId: actor.id,
      estimatedInputTokens: DESIGN_REVIEW_GUESS.inputTokens,
      estimatedOutputTokens: DESIGN_REVIEW_GUESS.outputTokens,
    })
    .returning({ id: designReview.id });

  try {
    await getQueue().add(DESIGN_REVIEW_JOB, { reviewId: review!.id, projectId }, { jobId: designReviewJobId(review!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(designReview).where(eq(designReview.id, review!.id));
    throw new DesignReviewError("The review couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }

  await recordActivity(ctx.db, {
    action: "design.review_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { frame: home.name, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return review!.id;
}

/* A PM ticks (or unticks) a Must-fix or Should-fix to go into the improved version. Logged each time. */
export async function setFindingTicked(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  findingId: string,
  ticked: boolean,
): Promise<void> {
  assertCan(actor, "project.edit");
  const [finding] = await ctx.db
    .select()
    .from(designFinding)
    .where(and(eq(designFinding.id, findingId), eq(designFinding.projectId, projectId)))
    .limit(1);
  if (!finding) throw new DesignReviewError("That finding no longer exists.");
  if (finding.grade === "recommendation") {
    throw new DesignReviewError("Recommendations are suggestions only; they are never applied.");
  }
  const [latest] = await ctx.db
    .select({ id: designReview.id })
    .from(designReview)
    .where(eq(designReview.projectId, projectId))
    .orderBy(desc(designReview.createdAt))
    .limit(1);
  if (latest?.id !== finding.reviewId) throw new DesignReviewError("This review has been replaced by a newer one.");
  if (finding.ticked === ticked) return;

  await ctx.db
    .update(designFinding)
    .set({ ticked, tickedByUserId: actor.id, tickedAt: new Date() })
    .where(eq(designFinding.id, findingId));
  await recordActivity(ctx.db, {
    action: "design.fix_ticked",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { ticked: finding.ticked },
    valueAfter: { number: finding.number, title: finding.title, grade: finding.grade, ticked },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  Tick all, or untick all, of one group of the newest review (Must-fix,
  Should-fix, or the facts to confirm). One log entry for the group, not
  one per finding. Recommendations have no ticks.
*/
export async function setGroupTicked(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  grade: "must_fix" | "should_fix" | "confirm_fact",
  ticked: boolean,
): Promise<number> {
  assertCan(actor, "project.edit");
  const [latest] = await ctx.db
    .select({ id: designReview.id, status: designReview.status })
    .from(designReview)
    .where(eq(designReview.projectId, projectId))
    .orderBy(desc(designReview.createdAt))
    .limit(1);
  if (!latest || latest.status !== "done") throw new DesignReviewError("There is no finished review to change.");
  const changing = await ctx.db
    .select({ id: designFinding.id })
    .from(designFinding)
    .where(and(eq(designFinding.reviewId, latest.id), eq(designFinding.grade, grade), eq(designFinding.ticked, !ticked)));
  if (changing.length === 0) return 0;

  await ctx.db
    .update(designFinding)
    .set({ ticked, tickedByUserId: actor.id, tickedAt: new Date() })
    .where(inArray(designFinding.id, changing.map((f) => f.id)));
  await recordActivity(ctx.db, {
    action: "design.fix_ticked",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { grade, ticked, count: changing.length, all: true },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return changing.length;
}

/* How far the PM is with the facts: whether the intake was pre-filled, and how many facts still wait. */
export async function factsStatus(db: Db, projectId: string): Promise<{ prefilled: boolean; filled: number; unconfirmed: number }> {
  const [figma] = await db
    .select({ prefillResult: figmaDesign.prefillResult })
    .from(figmaDesign)
    .where(eq(figmaDesign.projectId, projectId))
    .limit(1);
  const rows = await db.select({ status: intakePrefill.status }).from(intakePrefill).where(eq(intakePrefill.projectId, projectId));
  return {
    prefilled: Boolean(figma?.prefillResult),
    filled: rows.length,
    unconfirmed: rows.filter((r) => r.status === "pending").length,
  };
}

/* ---------- what the screens read ---------- */

export interface DesignReviewView {
  id: string;
  status: "queued" | "working" | "done" | "failed";
  failureReason: string | null;
  frameName: string;
  createdAt: Date;
  finishedAt: Date | null;
  startedBy: string | null;
  review: StoredDesignReview | null;
  /** The design was imported again since this review, so it reviewed an older version. */
  outOfDate: boolean;
  cost: number;
  /** "1 call; 31,200 tokens in ($0.12); ...": where the money went. */
  costSplit: string;
  findings: (typeof designFinding.$inferSelect)[];
}

/* The newest review of a project's design, with its findings. */
export async function loadDesignReview(db: Db, projectId: string): Promise<DesignReviewView | null> {
  const [row] = await db
    .select()
    .from(designReview)
    .where(eq(designReview.projectId, projectId))
    .orderBy(desc(designReview.createdAt))
    .limit(1);
  if (!row) return null;

  const [figma] = await db
    .select({ importedVersion: figmaDesign.importedVersion })
    .from(figmaDesign)
    .where(eq(figmaDesign.projectId, projectId))
    .limit(1);
  const findings = await db
    .select()
    .from(designFinding)
    .where(eq(designFinding.reviewId, row.id))
    .orderBy(asc(designFinding.number));
  const config = getModelConfig();
  const calls = await db.select().from(aiCall).where(eq(aiCall.runId, row.id));

  let startedBy: string | null = null;
  if (row.startedByUserId) {
    const [person] = await db
      .select({ name: userTable.name, deletedAt: userTable.deletedAt })
      .from(userTable)
      .where(eq(userTable.id, row.startedByUserId))
      .limit(1);
    startedBy = person ? personLabel(person.name, person.deletedAt) : null;
  }

  return {
    id: row.id,
    status: row.status as DesignReviewView["status"],
    failureReason: row.failureReason,
    frameName: row.frameName,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    startedBy,
    review: row.review as StoredDesignReview | null,
    outOfDate: Boolean(figma?.importedVersion && figma.importedVersion !== row.figmaVersion),
    cost: calls.reduce((n, c) => n + callCost(c, config), 0),
    costSplit: describeCallCosts(calls, config),
    findings,
  };
}

/* The homepage frame's picture, for the pins. */
export async function homeFrameImage(db: Db, projectId: string): Promise<(ImportedFrame & { imageUrl: string | null }) | null> {
  const [figma] = await db.select({ frames: figmaDesign.frames }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const home = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome);
  if (!home) return null;
  return { ...home, imageUrl: home.imageKey ? await getStorage().signDownload(home.imageKey, `${home.name}.png`) : null };
}
