import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, concept, conceptVersion, polishPass, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { claimPolishPass } from "@tawd/core/paid-starts";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { POLISH_JOB, polishJobId } from "@tawd/core/queue";
import { HTML_HOMEPAGE_CONCEPT, POLISH_GUESS, costOf, formatCost, scoringPassCost } from "@tawd/core/mockups";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Critique then polish (27 September 2026): after the Creative Director's
  review, one bounded Impeccable pass on a concept, the estimate first. It
  makes a new version; the pass keeps the critique and the before and
  after (version, review scores, what is measured, checks).
*/

type Db = Database;

export async function estimatePolish(db: Db): Promise<{ cost: number; label: string }> {
  const config = await stepModelConfig(db, "polish");
  // One Creative Director scoring pass, at the review step's own model (it priced a whole review cycle before, 3 October 2026).
  const scoring = scoringPassCost(await stepModelConfig(db, "review"));
  const calls = await db.select().from(aiCall).where(inArray(aiCall.step, ["polish_critique", "polish"]));
  const passes = new Set(calls.map((c) => c.runId)).size;
  if (passes > 0) {
    // The measured critique and polish, plus the scoring pass, which is recorded as a review.
    const cost = calls.reduce((n, c) => n + costOf(c, config), 0) / passes + scoring;
    return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}, from the passes so far (the critique, the polish, the fix rounds if needed and one scoring).` };
  }
  const cost = costOf(POLISH_GUESS.critique, config) + costOf(POLISH_GUESS.polish, config) + scoring;
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} (a first guess until a real pass has run): the critique, the polish and one scoring.` };
}

export async function startPolish(ctx: ServiceContext, actor: Viewer, conceptId: string): Promise<string> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db
    .select({ id: concept.id, skillId: concept.skillId, projectId: concept.projectId, label: concept.label, status: concept.status, projectStatus: project.status })
    .from(concept)
    .innerJoin(project, eq(project.id, concept.projectId))
    .where(eq(concept.id, conceptId))
    .limit(1);
  if (!row) throw new MockupError("That concept no longer exists.");
  if (row.projectStatus !== "mockups") throw new MockupError("This project is no longer at Design.");
  if (row.status !== "ready") throw new MockupError("Only a finished concept can be polished.");
  if (row.skillId === HTML_HOMEPAGE_CONCEPT) throw new MockupError("This is the homepage file the team supplied: TAWD does not critique or polish it with AI.");
  const [latest] = await ctx.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, row.id)).orderBy(desc(conceptVersion.version)).limit(1);
  if (!latest) throw new MockupError("This concept has no version yet.");
  const reviewed = ((latest.review as { passes?: unknown[] } | null)?.passes ?? []).length > 0;
  if (!reviewed) throw new MockupError("The critique and polish come after the Creative Director's review. Run the review first.");
  const [running] = await ctx.db
    .select()
    .from(polishPass)
    .where(and(eq(polishPass.conceptId, row.id), inArray(polishPass.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new MockupError("This concept is already being polished.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId: row.projectId, estimate: (await estimatePolish(ctx.db)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  const estimate = await estimatePolish(ctx.db);
  // Two clicks together start one polish (13 October 2026, the whole-code review).
  const pass = await claimPolishPass(ctx.db, row.projectId, row.id, { fromVersion: latest.version, estimate: estimate.label, requestedByUserId: actor.id });
  if (!pass) throw new MockupError("This concept is already being polished.");
  try {
    await getQueue().add(POLISH_JOB, { passId: pass!.id, projectId: row.projectId, conceptId: row.id }, { jobId: polishJobId(pass!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(polishPass).where(eq(polishPass.id, pass!.id));
    throw new MockupError("The polish couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "mockups.polish_started",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueAfter: { concept: row.label, version: latest.version, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return pass!.id;
}

export interface PolishSnapshot {
  version: number;
  average: number | null;
  lowest: number | null;
  richness: string;
  checksPassed: boolean | null;
}

export interface PolishView {
  status: "none" | "queued" | "working" | "done" | "failed";
  fromVersion: number | null;
  toVersion: number | null;
  critique: { band: number; area: string; problem: string; fix: string }[];
  before: PolishSnapshot | null;
  after: PolishSnapshot | null;
  failureReason: string | null;
  estimateLine: string;
}

export async function loadPolish(db: Db, conceptId: string): Promise<PolishView> {
  const [row] = await db.select().from(polishPass).where(eq(polishPass.conceptId, conceptId)).orderBy(desc(polishPass.createdAt)).limit(1);
  return {
    status: (row?.status as PolishView["status"]) ?? "none",
    fromVersion: row?.fromVersion ?? null,
    toVersion: row?.toVersion ?? null,
    critique: (row?.critique as PolishView["critique"] | null) ?? [],
    before: (row?.before as PolishSnapshot | null) ?? null,
    after: (row?.after as PolishSnapshot | null) ?? null,
    failureReason: row?.failureReason ?? null,
    estimateLine: (await estimatePolish(db)).label,
  };
}
