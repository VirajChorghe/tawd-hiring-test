import { and, desc, eq, gte, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { Database } from "../db";
import {
  aiCall,
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptStep,
  conceptVersion,
  designCopy,
  designImprovement,
  designReview,
  figmaDesign,
  mockupRun,
  siteBuild,
} from "../db/schema";
import { markFigmaImportFailed } from "./figma/service";
import { actorFields, recordActivity } from "./activity";
import { SYSTEM_ACTOR } from "./permissions";

/*
  Work that will never finish on its own: a run left "Queued" or "Running",
  or a Request changes left waiting, because the worker was down, restarted
  mid-job or lost the job.

  Stuck means both: nothing has happened on it for an hour, and the worker
  has done nothing anywhere for an hour. The worker takes one job at a time
  for every project, so a run can wait its turn for over an hour while the
  worker is busy elsewhere; that is not stuck.

  The web app runs this when the Design screen or Spend opens (the worker
  cannot: when it is down, nothing it runs would run). A run with no
  concept built becomes Failed ("Failed to start" when no AI was spent); a
  run with some concepts built keeps them and becomes "Review didn't
  finish", so the review can be run again. Both keep their history.
*/

export const STUCK_AFTER_MS = 60 * 60 * 1000;

/*
  A design job the worker started within the hour is running, not stuck
  (13 October 2026, the whole-code review): after a worker restart a job
  picked up late is mid-way through its first AI call, which leaves no
  trace until it ends; marking it failed invited a second, paid try.
*/
const startedBefore = (startedAt: AnyPgColumn, cutoff: Date) => or(isNull(startedAt), lt(startedAt, cutoff));

const latest = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);

function whenPacific(value: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(value)} PT`;
}

/*
  The last time the worker did anything at all, on any project. Only what
  the worker alone writes counts; this sweep never stamps a step's finish
  time, so it cannot make a dead worker look alive.
*/
export async function lastWorkerActivity(db: Database): Promise<Date | null> {
  const [calls] = await db.select({ at: max(aiCall.createdAt) }).from(aiCall);
  const [steps] = await db
    .select({ started: max(conceptStep.startedAt), finished: max(conceptStep.finishedAt) })
    .from(conceptStep);
  const [versions] = await db.select({ at: max(conceptVersion.createdAt) }).from(conceptVersion);
  return latest(calls?.at, steps?.started, steps?.finished, versions?.at);
}

export interface SweptRun {
  runId: string;
  projectId: string;
  status: "failed" | "review_incomplete";
  reason: string;
}

export async function sweepStuckWork(
  db: Database,
  now: Date = new Date(),
): Promise<{
  runs: SweptRun[];
  requests: string[];
  imports: string[];
  designReviews: string[];
  designCopies: string[];
  designImprovements: string[];
}> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const swept = {
    runs: [] as SweptRun[],
    requests: [] as string[],
    imports: [] as string[],
    designReviews: [] as string[],
    designCopies: [] as string[],
    designImprovements: [] as string[],
  };

  const candidates = await db
    .select()
    .from(mockupRun)
    .where(and(inArray(mockupRun.status, ["queued", "running"]), lt(mockupRun.createdAt, cutoff)));
  const waitingRequests = await db
    .select()
    .from(conceptChangeRequest)
    .where(
      and(inArray(conceptChangeRequest.status, ["queued", "working"]), lt(conceptChangeRequest.createdAt, cutoff)),
    );
  const waitingImports = await db
    .select({ projectId: figmaDesign.projectId, status: figmaDesign.importStatus })
    .from(figmaDesign)
    .where(and(inArray(figmaDesign.importStatus, ["queued", "working"]), lt(figmaDesign.importQueuedAt, cutoff)));
  const waitingReviews = await db
    .select({ id: designReview.id, projectId: designReview.projectId, status: designReview.status })
    .from(designReview)
    .where(and(inArray(designReview.status, ["queued", "working"]), lt(designReview.createdAt, cutoff), startedBefore(designReview.startedAt, cutoff)));
  const waitingCopies = await db
    .select({ id: designCopy.id, projectId: designCopy.projectId, status: designCopy.status })
    .from(designCopy)
    .where(and(inArray(designCopy.status, ["queued", "working"]), lt(designCopy.createdAt, cutoff), startedBefore(designCopy.startedAt, cutoff)));
  const waitingImprovements = await db
    .select({ id: designImprovement.id, projectId: designImprovement.projectId, status: designImprovement.status })
    .from(designImprovement)
    .where(and(inArray(designImprovement.status, ["queued", "working"]), lt(designImprovement.createdAt, cutoff), startedBefore(designImprovement.startedAt, cutoff)));
  if (
    candidates.length === 0 &&
    waitingRequests.length === 0 &&
    waitingImports.length === 0 &&
    waitingReviews.length === 0 &&
    waitingCopies.length === 0 &&
    waitingImprovements.length === 0
  ) {
    return swept;
  }

  // The worker is alive and busy: whatever is waiting is waiting its turn.
  const workerLast = await lastWorkerActivity(db);
  if (workerLast && workerLast >= cutoff) return swept;

  for (const run of candidates) {
    const concepts = await db.select().from(concept).where(eq(concept.runId, run.id));
    const conceptIds = concepts.map((c) => c.id);

    let startedAt: Date | null = null;
    let lastAt: Date | null = run.createdAt;
    let spent = false;
    if (conceptIds.length > 0) {
      const [steps] = await db
        .select({ started: max(conceptStep.startedAt), finished: max(conceptStep.finishedAt) })
        .from(conceptStep)
        .where(inArray(conceptStep.conceptId, conceptIds));
      const [versions] = await db
        .select({ at: max(conceptVersion.createdAt) })
        .from(conceptVersion)
        .where(inArray(conceptVersion.conceptId, conceptIds));
      startedAt = steps?.started ?? null;
      lastAt = latest(lastAt, steps?.started, steps?.finished, versions?.at);
    }
    const [calls] = await db.select({ at: max(aiCall.createdAt) }).from(aiCall).where(eq(aiCall.runId, run.id));
    if (calls?.at) {
      spent = true;
      lastAt = latest(lastAt, calls.at);
    }
    if (lastAt && lastAt >= cutoff) continue;

    const reason =
      run.status === "queued" || !startedAt
        ? `The worker never picked this run up: nothing happened for over an hour after it was queued${spent ? "" : ", and no AI was spent"}. Start a new run when the worker is back.`
        : `The worker stopped working on this run at ${whenPacific(lastAt!)} and nothing happened for over an hour after that. Start a new run, or run the review again if concepts were built.`;

    const built = concepts.filter((c) => c.status === "ready");
    const status: SweptRun["status"] = built.length > 0 ? "review_incomplete" : "failed";
    const unfinished = concepts.filter((c) => c.status === "queued" || c.status === "running");

    await db
      .update(mockupRun)
      .set({ status, failureReason: reason, finishedAt: now })
      .where(and(eq(mockupRun.id, run.id), inArray(mockupRun.status, ["queued", "running"])));
    if (unfinished.length > 0) {
      const ids = unfinished.map((c) => c.id);
      await db.update(concept).set({ status: "failed", failureReason: reason }).where(inArray(concept.id, ids));
      await db
        .update(conceptStep)
        .set({ status: "failed", detail: "Stopped: the worker did not finish it" })
        .where(and(inArray(conceptStep.conceptId, ids), inArray(conceptStep.status, ["waiting", "working"])));
    }
    // A built concept whose review never came: its unsettled steps say so.
    for (const c of built) {
      await db
        .update(conceptStep)
        .set({ status: "failed", detail: "Review didn't finish: the worker stopped" })
        .where(and(eq(conceptStep.conceptId, c.id), eq(conceptStep.status, "working")));
    }

    await recordActivity(db, {
      action: "mockups.run_stuck",
      entityType: "project",
      entityId: run.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueBefore: { status: run.status },
      valueAfter: {
        runId: run.id,
        status,
        concepts: concepts.map((c) => c.label).sort(),
        built: built.map((c) => c.label).sort(),
        reason,
      },
      ipAddress: null,
      userAgent: null,
    });
    swept.runs.push({ runId: run.id, projectId: run.projectId, status, reason });
  }

  for (const request of waitingRequests) {
    const [calls] = await db
      .select({ at: max(aiCall.createdAt) })
      .from(aiCall)
      .where(and(eq(aiCall.conceptId, request.conceptId), gte(aiCall.createdAt, request.createdAt)));
    const [versions] = await db
      .select({ at: max(conceptVersion.createdAt) })
      .from(conceptVersion)
      .where(and(eq(conceptVersion.conceptId, request.conceptId), gte(conceptVersion.createdAt, request.createdAt)));
    const lastAt = latest(request.createdAt, calls?.at, versions?.at);
    if (lastAt && lastAt >= cutoff) continue;

    await failChangeRequest(
      db,
      request.id,
      request.status === "queued"
        ? "The worker never picked this up: nothing happened for over an hour after it was asked for. Ask for the changes again when the worker is back."
        : `The worker stopped making these changes at ${whenPacific(lastAt!)} and nothing happened for over an hour after that. Ask for the changes again.`,
    );
    swept.requests.push(request.id);
  }

  // A Figma import takes seconds; one still waiting after an hour with the worker idle never ran.
  for (const waiting of waitingImports) {
    await markFigmaImportFailed(
      db,
      waiting.projectId,
      waiting.status === "queued"
        ? "The worker never picked up the import: nothing happened for over an hour. Import again when the worker is back."
        : "The worker stopped part-way through the import. Import again.",
    );
    swept.imports.push(waiting.projectId);
  }

  // A design review is one call; one still waiting after an hour with the worker idle never ran.
  for (const waiting of waitingReviews) {
    const reason =
      waiting.status === "queued"
        ? "The worker never picked up the review: nothing happened for over an hour. Review the design again when the worker is back."
        : "The worker stopped part-way through the review. Review the design again.";
    await db
      .update(designReview)
      .set({ status: "failed", failureReason: reason, finishedAt: now })
      .where(eq(designReview.id, waiting.id));
    await recordActivity(db, {
      action: "design.review_failed",
      entityType: "project",
      entityId: waiting.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { reason },
      ipAddress: null,
      userAgent: null,
    });
    swept.designReviews.push(waiting.id);
  }

  // The faithful copy is one call; one still waiting after an hour with the worker idle never ran.
  for (const waiting of waitingCopies) {
    const reason =
      waiting.status === "queued"
        ? "The worker never picked up the copy: nothing happened for over an hour. Build it again when the worker is back."
        : "The worker stopped part-way through the copy. Build it again.";
    await db.update(designCopy).set({ status: "failed", failureReason: reason, finishedAt: now }).where(eq(designCopy.id, waiting.id));
    await recordActivity(db, {
      action: "design.copy_failed",
      entityType: "project",
      entityId: waiting.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { reason },
      ipAddress: null,
      userAgent: null,
    });
    swept.designCopies.push(waiting.id);
  }

  // The improved design: one still waiting after an hour with the worker idle never ran, or stopped part-way.
  for (const waiting of waitingImprovements) {
    const reason =
      waiting.status === "queued"
        ? "The worker never picked up the improved design: nothing happened for over an hour. Build it again when the worker is back."
        : "The worker stopped part-way through the improved design. Build it again.";
    await db
      .update(designImprovement)
      .set({ status: "failed", detail: null, failureReason: reason, finishedAt: now })
      .where(eq(designImprovement.id, waiting.id));
    await recordActivity(db, {
      action: "design.improve_failed",
      entityType: "project",
      entityId: waiting.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { reason },
      ipAddress: null,
      userAgent: null,
    });
    swept.designImprovements.push(waiting.id);
  }

  return swept;
}

/*
  Site builds a stopped worker left "working" (audit F-006, 12 November
  2026). A running build stamps heartbeatAt every minute (site-build.ts);
  one with no stamp for ten minutes is not running, because the worker that
  had it stopped (it restarts on every merge to main). Before this, the row
  stayed "working" for ever and every new build was refused as "already
  being built". The worker runs this when it starts and every five minutes;
  a build from before heartbeats existed counts from when it was created.
  The build is marked failed, never retried: a retry would spend again
  without anyone deciding to.
*/
export const BUILD_STALLED_AFTER_MS = 10 * 60 * 1000;

export async function sweepStalledSiteBuilds(db: Database, now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - BUILD_STALLED_AFTER_MS);
  const reason = `The worker stopped part-way through this build (it restarts when TAWD is updated) and it didn't finish. Nothing more will be spent on it; what was spent is on Spend. Build again.`;
  const stalled = await db
    .update(siteBuild)
    .set({ status: "failed", step: null, failureReason: reason, finishedAt: now })
    // The time goes as ISO text cast by Postgres: a Date beside a sql`` left side reaches postgres-js unencoded and the query throws (live, 12 Nov: the sweep failed every five minutes).
    .where(and(eq(siteBuild.status, "working"), lt(sql`coalesce(${siteBuild.heartbeatAt}, ${siteBuild.createdAt})`, sql`${cutoff.toISOString()}::timestamptz`)))
    .returning({ id: siteBuild.id, projectId: siteBuild.projectId, version: siteBuild.version });
  for (const build of stalled) {
    await recordActivity(db, {
      action: "site.build_stalled",
      entityType: "project",
      entityId: build.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { version: build.version, reason },
      ipAddress: null,
      userAgent: null,
    });
  }
  return stalled.map((b) => b.id);
}

/*
  A Request changes that did not finish. If the new version was already
  made (only the scoring failed), the comments did go into it and stay
  "Sent"; otherwise they go back to Not sent.
*/
export async function failChangeRequest(db: Database, requestId: string, message: string): Promise<void> {
  const [request] = await db
    .select()
    .from(conceptChangeRequest)
    .where(eq(conceptChangeRequest.id, requestId))
    .limit(1);
  if (!request) return;

  const [made] = await db
    .select({ version: conceptVersion.version })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, request.conceptId))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  const madeVersion = made && made.version > request.baseVersion ? request.baseVersion + 1 : null;

  await db
    .update(conceptChangeRequest)
    .set({
      status: "failed",
      failureReason: message,
      resultVersion: madeVersion,
      finishedAt: new Date(),
    })
    .where(eq(conceptChangeRequest.id, requestId));
  await db
    .update(conceptComment)
    .set(
      madeVersion
        ? { sentInVersion: madeVersion }
        : /*
            Not sent after all, so this send does not count as a try. A
            second try keeps the version it was first sent in (one this
            request didn't make), so it can be tried again; a first send had none.
          */
          {
            changeRequestId: null,
            tries: sql`greatest(${conceptComment.tries} - 1, 0)`,
            sentInVersion: sql`case when ${conceptComment.sentInVersion} <= ${request.baseVersion} then ${conceptComment.sentInVersion} else null end`,
          },
    )
    .where(eq(conceptComment.changeRequestId, requestId));

  const [row] = await db
    .select({ label: concept.label })
    .from(concept)
    .where(eq(concept.id, request.conceptId))
    .limit(1);

  await recordActivity(db, {
    action: "mockups.changes_failed",
    entityType: "project",
    entityId: request.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { concept: row?.label ?? null, reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
