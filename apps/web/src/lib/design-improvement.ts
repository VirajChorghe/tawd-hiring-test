import { callCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  aiCall,
  concept,
  conceptVersion,
  designChange,
  designCopy,
  designFinding,
  designImprovement,
  designReview,
  mockupRun,
  project,
  user as userTable,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import {
  planDecisions,
  type ChangeDecision,
  type DecidedChange,
  type DecisionsPlan,
  type DesignReviewQuestion,
  type StoredDesignReview,
} from "@tawd/core/figma";
import { getStorage } from "@tawd/core/intake/storage";
import { DESIGNER_CONCEPT, costOf, formatCost, getModelConfig } from "@tawd/core/mockups";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { DESIGN_DECISIONS_JOB, DESIGN_IMPROVE_JOB, designDecisionsJobId, designImproveJobId } from "@tawd/core/queue";
import { firstNameOf } from "@tawd/core/slack";
import { notifySlack } from "@/lib/slack-notify";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import { personLabel, type ServiceContext } from "@/lib/users";

/*
  Lane 2, Option B, 4c: the improved design. The fixes ticked in the
  Creative Director's review, made on the faithful copy one section at a
  time and tracked change by change, then re-scored. Paid: the estimate is
  shown before anything is spent.
*/

type Db = ServiceContext["db"];

export class DesignImprovementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignImprovementError";
  }
}

/*
  First guesses until a real improvement has run: one section edit (the
  section's markup, its styles and a picture in; the section out), up to
  six sections, and the re-score (the page's pictures in, eight scores out).
*/
export const IMPROVE_SECTION_GUESS = { inputTokens: 12_000, outputTokens: 9_000 };
export const RESCORE_GUESS = { inputTokens: 40_000, outputTokens: 6_000 };

/* The fixes that go in: ticked Must-fix and Should-fix. */
const APPLIED_GRADES = ["must_fix", "should_fix"];

export async function estimateDesignImprovement(
  db: Db,
  tickedFixes: number,
): Promise<{ cost: number; label: string; measured: boolean }> {
  const config = await stepModelConfig(db, "design_improve");
  const calls = await db.select().from(aiCall).where(inArray(aiCall.step, ["design_improve", "design_rescore"]));
  const byRun = new Map<string, number>();
  for (const call of calls) byRun.set(call.runId, (byRun.get(call.runId) ?? 0) + costOf(call, config));
  const rescore = costOf(RESCORE_GUESS, config);
  if (byRun.size > 0) {
    const cost = [...byRun.values()].reduce((a, b) => a + b, 0) / byRun.size;
    return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}, from the improvements so far (the re-score is part of it)`, measured: true };
  }
  const sections = Math.max(1, Math.min(tickedFixes, 6));
  const cost = sections * costOf(IMPROVE_SECTION_GUESS, config) + rescore;
  return {
    cost,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}: the fixes, one section at a time, then the Creative Director's re-score (about ${formatCost(rescore)}); a first guess until one has run`,
    measured: false,
  };
}

/* What the improvement would start from: the newest review and copy, both finished, and the ticked fixes. */
export async function improvementInputs(db: Db, projectId: string) {
  const [review] = await db
    .select()
    .from(designReview)
    .where(eq(designReview.projectId, projectId))
    .orderBy(desc(designReview.createdAt))
    .limit(1);
  const [copy] = await db
    .select()
    .from(designCopy)
    .where(eq(designCopy.projectId, projectId))
    .orderBy(desc(designCopy.createdAt))
    .limit(1);
  const ticked =
    review?.status === "done"
      ? await db
          .select({ id: designFinding.id })
          .from(designFinding)
          .where(and(eq(designFinding.reviewId, review.id), eq(designFinding.ticked, true), inArray(designFinding.grade, APPLIED_GRADES)))
      : [];
  return {
    review: review?.status === "done" ? review : null,
    copy: copy?.status === "done" && copy.sourceKey ? copy : null,
    tickedFixes: ticked.length,
  };
}

/* Queues the improved design. Paid: the estimate was shown first. */
export async function startDesignImprovement(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db
    .select({ lane: project.lane, laneOption: project.laneOption })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw new DesignImprovementError("That project no longer exists.");
  if (row.lane !== "lane_2" || row.laneOption !== "b") {
    throw new DesignImprovementError("The improved design is only for Lane 2, Option B (review and improve).");
  }
  const inputs = await improvementInputs(ctx.db, projectId);
  if (!inputs.review) throw new DesignImprovementError("Review the design first: the fixes come from the Creative Director's review.");
  if (!inputs.copy) throw new DesignImprovementError("Build the faithful copy first: the fixes are made on it.");
  if (inputs.copy.figmaVersion !== inputs.review.figmaVersion) {
    throw new DesignImprovementError("The review and the copy are of different imports of the design. Review it or build the copy again first.");
  }
  if (inputs.tickedFixes === 0) throw new DesignImprovementError("Tick at least one fix in the review first.");
  const [running] = await ctx.db
    .select({ id: designImprovement.id })
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), inArray(designImprovement.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new DesignImprovementError("The improved design is already being built.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateDesignImprovement(ctx.db, inputs.tickedFixes)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new DesignImprovementError(error.message);
    throw error;
  }

  const estimate = await estimateDesignImprovement(ctx.db, inputs.tickedFixes);
  const [improvement] = await ctx.db
    .insert(designImprovement)
    .values({ projectId, copyId: inputs.copy.id, reviewId: inputs.review.id, startedByUserId: actor.id })
    .returning({ id: designImprovement.id });
  try {
    await getQueue().add(
      DESIGN_IMPROVE_JOB,
      { improvementId: improvement!.id, projectId },
      { jobId: designImproveJobId(improvement!.id), attempts: 1 },
    );
  } catch {
    await ctx.db.delete(designImprovement).where(eq(designImprovement.id, improvement!.id));
    throw new DesignImprovementError("The improved design couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.improve_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: {
      fixes: `${inputs.tickedFixes} ticked fix${inputs.tickedFixes === 1 ? "" : "es"}`,
      estimate: estimate.label,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return improvement!.id;
}

/* ---------- what the screens read ---------- */

export interface DesignChangeView {
  number: number;
  kind: "fix" | "contrast" | "font";
  sectionNumber: number;
  sectionName: string;
  what: string;
  why: string;
  /** The review findings it answers: number and title. */
  findings: { number: number; title: string }[];
  beforeUrl: string | null;
  afterUrl: string | null;
  /** The designer's answer: accepted or pushed back, by whom, with the note. */
  decision: ChangeDecision | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/* The version with the designer's decisions, when one has been asked for. */
export interface DecisionsVersionView {
  id: string;
  status: "queued" | "working" | "done" | "failed";
  detail: string | null;
  failureReason: string | null;
  finishedAt: Date | null;
  startedBy: string | null;
  cost: number;
  imageUrl: string | null;
  reverted: number[];
  edited: number[];
  notEdited: { section: number; reason: string }[];
  fontsKept: number[];
  accepted: number;
  pushedBack: number;
  /** Decisions changed since it was made: it no longer matches them. */
  outOfDate: boolean;
}

export interface DesignImprovementView {
  id: string;
  status: "queued" | "working" | "done" | "failed";
  detail: string | null;
  failureReason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  startedBy: string | null;
  cost: number;
  /** The review's scores (before) and the re-score (after), question by question. */
  before: StoredDesignReview | null;
  after: StoredDesignReview | null;
  rescoreFailure: string | null;
  changes: DesignChangeView[];
  notApplied: { fix: number; title: string; reason: string }[];
  issues: { id: string; severity: string; message: string }[];
  /** A newer review or copy exists, so this was built from older ones. */
  outOfDate: boolean;
  copyImageUrl: string | null;
  improvedImageUrl: string | null;
  /** What the decisions mean so far: what would be put back, edited, or still needs an answer. */
  plan: DecisionsPlan;
  decisionsVersion: DecisionsVersionView | null;
}

export async function loadDesignImprovement(db: Db, projectId: string): Promise<DesignImprovementView | null> {
  const [row] = await db
    .select()
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), eq(designImprovement.kind, "fixes")))
    .orderBy(desc(designImprovement.createdAt))
    .limit(1);
  if (!row) return null;
  const storage = getStorage();
  const config = getModelConfig();

  const [review] = await db.select().from(designReview).where(eq(designReview.id, row.reviewId)).limit(1);
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, row.copyId)).limit(1);
  const findings = await db
    .select({ number: designFinding.number, title: designFinding.title })
    .from(designFinding)
    .where(eq(designFinding.reviewId, row.reviewId));
  const titles = new Map(findings.map((f) => [f.number, f.title]));
  const changes = await db
    .select()
    .from(designChange)
    .where(eq(designChange.improvementId, row.id))
    .orderBy(asc(designChange.number));
  const calls = await db.select().from(aiCall).where(eq(aiCall.runId, row.id));
  const latest = await improvementInputs(db, projectId);
  const deciders = [...new Set(changes.map((c) => c.decidedByUserId).filter((id): id is string => Boolean(id)))];
  const people = new Map<string, string>();
  for (const id of deciders) {
    const [person] = await db.select({ name: userTable.name, deletedAt: userTable.deletedAt }).from(userTable).where(eq(userTable.id, id)).limit(1);
    const label = person ? personLabel(person.name, person.deletedAt) : null;
    if (label) people.set(id, label);
  }

  let startedBy: string | null = null;
  if (row.startedByUserId) {
    const [person] = await db
      .select({ name: userTable.name, deletedAt: userTable.deletedAt })
      .from(userTable)
      .where(eq(userTable.id, row.startedByUserId))
      .limit(1);
    startedBy = person ? personLabel(person.name, person.deletedAt) : null;
  }
  const sign = async (key: string | null, name: string) => (key ? await storage.signDownload(key, name) : null);
  const checks = (row.checks as { issues?: DesignImprovementView["issues"]; rescoreFailure?: string | null } | null) ?? {};

  return {
    id: row.id,
    status: row.status as DesignImprovementView["status"],
    detail: row.detail,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    startedBy,
    cost: calls.reduce((n, c) => n + callCost(c, config), 0),
    before: (review?.review as StoredDesignReview | null) ?? null,
    after: (row.rescore as StoredDesignReview | null) ?? null,
    rescoreFailure: checks.rescoreFailure ?? null,
    changes: await Promise.all(
      changes.map(async (c) => ({
        number: c.number,
        kind: c.kind as DesignChangeView["kind"],
        sectionNumber: c.sectionNumber,
        sectionName: c.sectionName,
        what: c.what,
        why: c.why,
        findings: ((c.findingNumbers as number[] | null) ?? []).map((n) => ({ number: n, title: titles.get(n) ?? `Finding ${n}` })),
        beforeUrl: await sign(c.beforeImageKey, `change-${c.number}-before.jpg`),
        afterUrl: await sign(c.afterImageKey, `change-${c.number}-after.jpg`),
        decision: (c.decision as ChangeDecision | null) ?? null,
        decisionNote: c.decisionNote,
        decidedBy: c.decidedByUserId ? (people.get(c.decidedByUserId) ?? null) : null,
        decidedAt: c.decidedAt,
      })),
    ),
    notApplied: (row.notApplied as DesignImprovementView["notApplied"] | null) ?? [],
    issues: (checks.issues ?? []).filter((i) => i.severity === "fail" && !NOT_FOR_A_DESIGN.has(i.id)),
    outOfDate: Boolean((latest.review && latest.review.id !== row.reviewId) || (latest.copy && latest.copy.id !== row.copyId)),
    copyImageUrl: await sign(copy?.pngKey ?? null, "faithful-copy.png"),
    improvedImageUrl: await sign(row.pngKey, "improved-design.png"),
    plan: planDecisions(changes.map(toDecided)),
    decisionsVersion: await loadDecisionsVersion(db, row.id, changes),
  };
}

const toDecided = (c: typeof designChange.$inferSelect): DecidedChange => ({
  number: c.number,
  kind: c.kind as DecidedChange["kind"],
  sectionNumber: c.sectionNumber,
  what: c.what,
  why: c.why,
  decision: (c.decision as ChangeDecision | null) ?? null,
});

async function loadDecisionsVersion(
  db: Db,
  parentId: string,
  changes: (typeof designChange.$inferSelect)[],
): Promise<DecisionsVersionView | null> {
  const [row] = await db
    .select()
    .from(designImprovement)
    .where(and(eq(designImprovement.parentId, parentId), eq(designImprovement.kind, "decisions")))
    .orderBy(desc(designImprovement.createdAt))
    .limit(1);
  if (!row) return null;
  const config = getModelConfig();
  const calls = await db.select().from(aiCall).where(eq(aiCall.runId, row.id));
  const checks = (row.checks as Partial<Pick<DecisionsVersionView, "reverted" | "edited" | "notEdited" | "fontsKept" | "accepted" | "pushedBack">> | null) ?? {};
  let startedBy: string | null = null;
  if (row.startedByUserId) {
    const [person] = await db.select({ name: userTable.name, deletedAt: userTable.deletedAt }).from(userTable).where(eq(userTable.id, row.startedByUserId)).limit(1);
    startedBy = person ? personLabel(person.name, person.deletedAt) : null;
  }
  const lastDecision = changes.reduce<Date | null>((latest, c) => (c.decidedAt && (!latest || c.decidedAt > latest) ? c.decidedAt : latest), null);
  return {
    id: row.id,
    status: row.status as DecisionsVersionView["status"],
    detail: row.detail,
    failureReason: row.failureReason,
    finishedAt: row.finishedAt,
    startedBy,
    cost: calls.reduce((n, c) => n + callCost(c, config), 0),
    imageUrl: row.pngKey ? await getStorage().signDownload(row.pngKey, "designers-decisions.png") : null,
    reverted: checks.reverted ?? [],
    edited: checks.edited ?? [],
    notEdited: checks.notEdited ?? [],
    fontsKept: checks.fontsKept ?? [],
    accepted: checks.accepted ?? 0,
    pushedBack: checks.pushedBack ?? 0,
    outOfDate: Boolean(lastDecision && lastDecision > row.createdAt),
  };
}

// Only what the designer drew is on the page: the uploads aren't used, as with the copy.
const NOT_FOR_A_DESIGN = new Set(["images.photos.unused"]);

/* The improved design as a page, for "Open the page": the newest finished one (or the decisions version). */
export async function designImprovementPage(db: Db, projectId: string, kind: "fixes" | "decisions" = "fixes"): Promise<string | null> {
  const [row] = await db
    .select({ htmlKey: designImprovement.htmlKey })
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), eq(designImprovement.status, "done"), eq(designImprovement.kind, kind)))
    .orderBy(desc(designImprovement.createdAt))
    .limit(1);
  if (!row?.htmlKey) return null;
  const body = await getStorage().get(row.htmlKey);
  return body ? body.toString("utf8") : null;
}

/* The questions side by side: the design's score and the improved page's. */
export function scoresSideBySide(
  before: StoredDesignReview | null,
  after: StoredDesignReview | null,
): { question: number; title: string; before: number | null; after: number | null; reason: string }[] {
  const questions: DesignReviewQuestion[] = after?.questions ?? before?.questions ?? [];
  return questions
    .filter((q) => !q.notApplicable)
    .map((q) => ({
      question: q.question,
      title: q.title,
      before: before?.questions.find((b) => b.question === q.question)?.score ?? null,
      after: after?.questions.find((a) => a.question === q.question)?.score ?? null,
      reason: after?.questions.find((a) => a.question === q.question)?.reason ?? "",
    }));
}

/* ---------- the designer's decisions (4c-2) ---------- */

/* A first guess for one "take out the pushed-back changes" edit: the section and a picture in, the section out. */
export const UNDO_SECTION_GUESS = { inputTokens: 8_000, outputTokens: 6_000 };

/*
  The Web Designer (or an admin) accepts or pushes back on one change, with
  an optional note; null clears the answer. Logged every time. When the last
  open change gets its answer, Slack hears that the decisions are done.
*/
export async function setChangeDecision(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  changeNumber: number,
  decision: ChangeDecision | null,
  note: string,
): Promise<void> {
  assertCan(actor, "design.decide");
  const [improvement] = await ctx.db
    .select()
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), eq(designImprovement.kind, "fixes")))
    .orderBy(desc(designImprovement.createdAt))
    .limit(1);
  if (!improvement || improvement.status !== "done") throw new DesignImprovementError("There is no finished improved design to decide on.");
  const changes = await ctx.db.select().from(designChange).where(eq(designChange.improvementId, improvement.id));
  const change = changes.find((c) => c.number === changeNumber);
  if (!change) throw new DesignImprovementError("That change no longer exists.");
  const trimmed = note.trim().slice(0, 2000);
  if (change.decision === decision && (change.decisionNote ?? "") === trimmed) return;
  const wasOpen = changes.some((c) => c.decision === null);

  await ctx.db
    .update(designChange)
    .set({
      decision,
      decisionNote: decision && trimmed ? trimmed : null,
      decidedByUserId: decision ? actor.id : null,
      decidedAt: decision ? new Date() : null,
    })
    .where(eq(designChange.id, change.id));
  await recordActivity(ctx.db, {
    action: "design.change_decided",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { decision: change.decision, note: change.decisionNote },
    valueAfter: { number: change.number, section: change.sectionName, what: change.what, decision, note: decision && trimmed ? trimmed : null },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  const now = changes.map((c) => (c.id === change.id ? { ...c, decision } : c));
  if (wasOpen && decision !== null && now.every((c) => c.decision !== null)) {
    notifySlack(ctx.db, projectId, {
      kind: "design_decisions_done",
      by: await firstNameOf(ctx.db, actor.id),
      accepted: now.filter((c) => c.decision === "accepted").length,
      pushedBack: now.filter((c) => c.decision === "pushed_back").length,
    });
  }
}

/* What making the decisions version costs: free when every pushed-back change can simply be put back. */
export async function estimateDecisionsVersion(db: Db, plan: DecisionsPlan): Promise<{ cost: number; label: string; free: boolean }> {
  if (plan.edit.length === 0) {
    return { cost: 0, free: true, label: "Free: no AI needed" };
  }
  const config = await stepModelConfig(db, "design_decisions");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "design_decisions"));
  const perEdit = calls.length > 0 ? calls.reduce((n, c) => n + costOf(c, config), 0) / calls.length : costOf(UNDO_SECTION_GUESS, config);
  const cost = perEdit * plan.edit.length;
  const edits = `${plan.edit.length} section${plan.edit.length === 1 ? "" : "s"} with accepted and pushed-back changes, one small edit each`;
  return {
    cost,
    free: false,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}: ${edits}${calls.length > 0 ? "" : " (a first guess)"}`,
  };
}

/* Makes the version with the designer's decisions. Once every change has an answer; paid only for mixed sections. */
export async function startDecisionsVersion(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  if (!can(actor, "design.decide") && !can(actor, "project.edit")) assertCan(actor, "design.decide");
  const [improvement] = await ctx.db
    .select()
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), eq(designImprovement.kind, "fixes")))
    .orderBy(desc(designImprovement.createdAt))
    .limit(1);
  if (!improvement || improvement.status !== "done") throw new DesignImprovementError("Build the improved design first.");
  const changes = await ctx.db.select().from(designChange).where(eq(designChange.improvementId, improvement.id));
  const plan = planDecisions(changes.map(toDecided));
  if (plan.undecided.length > 0) {
    throw new DesignImprovementError(
      `${plan.undecided.length} change${plan.undecided.length === 1 ? " still needs" : "s still need"} the designer's decision.`,
    );
  }
  const [running] = await ctx.db
    .select({ id: designImprovement.id })
    .from(designImprovement)
    .where(and(eq(designImprovement.projectId, projectId), inArray(designImprovement.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new DesignImprovementError("A version is already being made.");
  const estimate = await estimateDecisionsVersion(ctx.db, plan);
  if (!estimate.free) {
    try {
      await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.cost });
    } catch (error) {
      if (error instanceof SpendError) throw new DesignImprovementError(error.message);
      throw error;
    }
  }

  const [version] = await ctx.db
    .insert(designImprovement)
    .values({
      projectId,
      kind: "decisions",
      parentId: improvement.id,
      copyId: improvement.copyId,
      reviewId: improvement.reviewId,
      startedByUserId: actor.id,
    })
    .returning({ id: designImprovement.id });
  try {
    await getQueue().add(
      DESIGN_DECISIONS_JOB,
      { improvementId: version!.id, projectId },
      { jobId: designDecisionsJobId(version!.id), attempts: 1 },
    );
  } catch {
    await ctx.db.delete(designImprovement).where(eq(designImprovement.id, version!.id));
    throw new DesignImprovementError("The version couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.decisions_version_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: {
      plan: `${changes.filter((c) => c.decision === "accepted").length} accepted, ${changes.filter((c) => c.decision === "pushed_back").length} pushed back`,
      estimate: estimate.label,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return version!.id;
}

/* ---------- Concept 1 on the concept board (26 September 2026) ---------- */

/*
  The final version of the designer's design (the version with the
  designer's decisions when there is one, otherwise the improved design)
  becomes a real Concept 1: in the client pack, open to comments and
  Request changes, and a possible pick for the client. No AI: its files are
  copied into a concept version. Done again later, it becomes Concept 1's
  next version, so its comments stay.
*/
export async function putDesignOnBoard(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ conceptId: string; version: number }> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) assertCan(actor, "project.edit");
  const improvement = await loadDesignImprovement(ctx.db, projectId);
  if (!improvement || improvement.status !== "done") throw new DesignImprovementError("Build the improved design first.");
  const decisions = improvement.decisionsVersion?.status === "done" ? improvement.decisionsVersion : null;
  const [source] = await ctx.db
    .select()
    .from(designImprovement)
    .where(eq(designImprovement.id, decisions?.id ?? improvement.id))
    .limit(1);
  if (!source?.sourceKey || !source.htmlKey || !source.pngKey) throw new DesignImprovementError("The final version's files are missing. Build it again.");

  const storage = getStorage();
  const [sourceHtml, pageHtml, png] = await Promise.all([storage.get(source.sourceKey), storage.get(source.htmlKey), storage.get(source.pngKey)]);
  if (!sourceHtml || !pageHtml || !png) throw new DesignImprovementError("The final version's files are missing. Build it again.");

  // The run it goes in: the latest (alternatives) run, or a run of its own.
  const [latestRun] = await ctx.db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.projectId, projectId))
    .orderBy(desc(mockupRun.createdAt))
    .limit(1);
  const runId =
    latestRun?.id ??
    (
      await ctx.db
        .insert(mockupRun)
        .values({ projectId, conceptCount: 1, status: "succeeded", startedByUserId: actor.id, model: DESIGNER_CONCEPT, finishedAt: new Date() })
        .returning({ id: mockupRun.id })
    )[0]!.id;

  const [existing] = await ctx.db
    .select()
    .from(concept)
    .where(and(eq(concept.projectId, projectId), eq(concept.skillId, DESIGNER_CONCEPT)))
    .limit(1);
  const conceptId =
    existing?.id ??
    (
      await ctx.db
        .insert(concept)
        .values({ runId, projectId, label: "1", direction: DESIGNER_CONCEPT, skillId: DESIGNER_CONCEPT, status: "ready" })
        .returning({ id: concept.id })
    )[0]!.id;
  if (existing && existing.runId !== runId) await ctx.db.update(concept).set({ runId, status: "ready" }).where(eq(concept.id, conceptId));

  const [last] = await ctx.db
    .select({ version: conceptVersion.version })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  const version = (last?.version ?? 0) + 1;
  const base = `projects/${projectId}/concepts/${conceptId}/v${version}`;
  await storage.put(`${base}/page.html`, pageHtml, "text/html");
  await storage.put(`${base}/source.html`, sourceHtml, "text/html");
  await storage.put(`${base}/full.png`, png, "image/png");
  // No browser here: the full picture stands in for the first screen (shown cropped to the top).
  await storage.put(`${base}/fold.png`, png, "image/png");

  const checks = (source.checks as { passed?: boolean; issues?: unknown[] } | null) ?? {};
  const accepted = improvement.changes.filter((c) => c.decision === "accepted").length;
  await ctx.db.insert(conceptVersion).values({
    conceptId,
    version,
    htmlKey: `${base}/page.html`,
    pngKey: `${base}/full.png`,
    foldPngKey: `${base}/fold.png`,
    checks: { passed: checks.passed ?? true, issues: checks.issues ?? [], stage: "designer" },
    summary: decisions
      ? `The designer's design with the ${accepted} change${accepted === 1 ? "" : "s"} the designer accepted.`
      : `The designer's design with ${improvement.changes.length} tracked change${improvement.changes.length === 1 ? "" : "s"} (not decided by the designer yet).`,
    placeholderCount: (sourceHtml.toString("utf8").match(/\[PLACEHOLDER/gi) ?? []).length,
  });

  await recordActivity(ctx.db, {
    action: "design.put_on_board",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version, from: decisions ? "the version with the designer's decisions" : "the improved design" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  notifySlack(ctx.db, projectId, { kind: "design_on_board", conceptId, version });
  return { conceptId, version };
}

/* Concept 1 on the board, if it is there: its newest version. */
export async function designConceptOnBoard(db: Db, projectId: string): Promise<{ conceptId: string; version: number; at: Date } | null> {
  const [row] = await db
    .select({ id: concept.id })
    .from(concept)
    .where(and(eq(concept.projectId, projectId), eq(concept.skillId, DESIGNER_CONCEPT)))
    .limit(1);
  if (!row) return null;
  const [last] = await db
    .select({ version: conceptVersion.version, at: conceptVersion.createdAt })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, row.id))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  return last ? { conceptId: row.id, version: last.version, at: last.at } : null;
}
