import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  activityLog,
  aiCall,
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptStep,
  conceptVersion,
  mockupRun,
  pipelineSteps,
  project as projectTable,
} from "@tawd/core/schema";
import { lastWorkerActivity, sweepStuckWork } from "@tawd/core/stuck-work";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { runStatusLabel } from "@/lib/mockup-labels";
import { getLatestRun, setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { loadSpendReport } from "@/lib/spend";
import { resolvePeriod } from "@/lib/spend-report";
import { describeChanges } from "@/lib/timeline-text";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  Runs and Request changes the worker will never finish (it was down, or
  lost the job) are settled when the Design screen or Spend opens: after
  an hour with nothing happening on them and nothing from the worker
  anywhere. Nothing that is merely waiting its turn is touched.
*/

let h: Harness;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-25T18:00:00Z");
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);

beforeEach(async () => {
  h = await createHarness();
  seededAdmin = null;
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

let seededAdmin: Awaited<ReturnType<typeof seedAdmin>> | null = null;

async function seedProject(name = "Dale Rowan") {
  seededAdmin ??= await seedAdmin(h);
  const admin = seededAdmin;
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: name,
    trade: "well_and_pump",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 2,
    status: "intake",
    memberUserIds: [],
  });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  return { admin, projectId };
}

/* A run and its concepts, as the web app leaves them, with nothing from the worker. */
async function seedRun(
  projectId: string,
  userId: string,
  createdAt: Date,
  options: { status?: string; concepts?: Record<string, string> } = {},
) {
  const concepts = options.concepts ?? { A: "queued", B: "queued" };
  const [run] = await h.db
    .insert(mockupRun)
    .values({
      projectId,
      conceptCount: Object.keys(concepts).length,
      status: options.status ?? "queued",
      model: "claude-opus-5-5",
      startedByUserId: userId,
      createdAt,
    })
    .returning();
  const ids: Record<string, string> = {};
  for (const [label, status] of Object.entries(concepts)) {
    const [row] = await h.db
      .insert(concept)
      .values({ runId: run!.id, projectId, label, direction: "rugged_craftsman", skillId: "impeccable", status })
      .returning();
    ids[label] = row!.id;
    await h.db
      .insert(conceptStep)
      .values(pipelineSteps.map((step) => ({ conceptId: row!.id, step, status: "waiting" })));
  }
  return { runId: run!.id, ids };
}

const runRow = async (runId: string) => (await h.db.select().from(mockupRun).where(eq(mockupRun.id, runId)))[0]!;

describe("settling work the worker will never finish", () => {
  it("marks the three old Dale Rowan runs from 23 September as Failed to start, and keeps them", async () => {
    const { admin, projectId } = await seedProject();
    const runs = [];
    for (const hour of ["09", "10", "14"]) {
      runs.push(await seedRun(projectId, admin.viewer.id, new Date(`2026-09-23T${hour}:00:00Z`)));
    }

    const swept = await sweepStuckWork(h.db, NOW);
    expect(swept.runs).toHaveLength(3);

    for (const { runId, ids } of runs) {
      const run = await runRow(runId);
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe(
        "The worker never picked this run up: nothing happened for over an hour after it was queued, and no AI was spent. Start a new run when the worker is back.",
      );
      expect(runStatusLabel(run.status, false)).toBe("Failed to start");
      const concepts = await h.db.select().from(concept).where(eq(concept.runId, runId));
      expect(concepts.map((c) => c.status)).toEqual(["failed", "failed"]);
      const steps = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.A!));
      expect(steps.every((s) => s.status === "failed" && s.finishedAt === null)).toBe(true);
    }
    // Kept, not deleted, and on History in plain words.
    expect(await h.db.select().from(mockupRun).where(eq(mockupRun.projectId, projectId))).toHaveLength(3);
    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.run_stuck"));
    expect(logged).toHaveLength(3);
    expect(describeChanges("mockups.run_stuck", logged[0]!.valueBefore, logged[0]!.valueAfter, new Map())[0]).toBe(
      "Failed to start",
    );

    // Settled once: a second sweep changes nothing.
    expect((await sweepStuckWork(h.db, NOW)).runs).toHaveLength(0);
  });

  it("leaves a run waiting its turn while the worker is busy on another project", async () => {
    const { admin, projectId } = await seedProject();
    const { runId } = await seedRun(projectId, admin.viewer.id, ago(3 * HOUR));
    const other = await seedProject("Other Client");
    const busy = await seedRun(other.projectId, other.admin.viewer.id, ago(4 * HOUR), {
      status: "running",
      concepts: { A: "running" },
    });
    await h.db
      .update(conceptStep)
      .set({ status: "working", startedAt: ago(10 * 60 * 1000) })
      .where(eq(conceptStep.conceptId, busy.ids.A!));

    expect(await sweepStuckWork(h.db, NOW)).toEqual({ runs: [], requests: [], imports: [], designReviews: [], designCopies: [], designImprovements: [] });
    expect((await runRow(runId)).status).toBe("queued");
  });

  it("leaves a run started under an hour ago alone, even with the worker idle", async () => {
    const { admin, projectId } = await seedProject();
    const { runId } = await seedRun(projectId, admin.viewer.id, ago(40 * 60 * 1000));
    expect((await sweepStuckWork(h.db, NOW)).runs).toHaveLength(0);
    expect((await runRow(runId)).status).toBe("queued");
  });

  it("keeps the concepts a stalled run did build, so the review can be run again", async () => {
    const { admin, projectId } = await seedProject();
    const { runId, ids } = await seedRun(projectId, admin.viewer.id, ago(5 * HOUR), {
      status: "running",
      concepts: { A: "ready", B: "running" },
    });
    const stalledAt = ago(3 * HOUR);
    await h.db
      .update(conceptStep)
      .set({ status: "working", startedAt: stalledAt })
      .where(eq(conceptStep.conceptId, ids.B!));
    await h.db.insert(aiCall).values({
      projectId,
      runId,
      conceptId: ids.A!,
      model: "claude-opus-5-5",
      step: "build",
      inputTokens: 10,
      outputTokens: 10,
      createdAt: ago(4 * HOUR),
    });

    await sweepStuckWork(h.db, NOW);

    const run = await runRow(runId);
    expect(run.status).toBe("review_incomplete");
    // 3 hours before 18:00 UTC is 8:00 am in California.
    expect(run.failureReason).toBe(
      "The worker stopped working on this run at Sep 25, 2026, 8:00 AM PT and nothing happened for over an hour after that. Start a new run, or run the review again if concepts were built.",
    );
    const concepts = await h.db.select().from(concept).where(eq(concept.runId, runId));
    expect(Object.fromEntries(concepts.map((c) => [c.label, c.status]))).toEqual({ A: "ready", B: "failed" });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.run_stuck"));
    expect(describeChanges("mockups.run_stuck", null, logged!.valueAfter, new Map())[0]).toBe(
      "Concept A kept; the review can be run again",
    );
  });

  it("settles a Request changes the worker never picked up, and its comments go back to Not sent", async () => {
    const { admin, projectId } = await seedProject();
    const { ids } = await seedRun(projectId, admin.viewer.id, ago(30 * HOUR), {
      status: "succeeded",
      concepts: { A: "ready" },
    });
    await h.db.insert(conceptVersion).values({ conceptId: ids.A!, version: 1, checks: {}, createdAt: ago(29 * HOUR) });
    const [request] = await h.db
      .insert(conceptChangeRequest)
      .values({
        projectId,
        conceptId: ids.A!,
        source: "team",
        notes: "Bigger phone number",
        requestedByUserId: admin.viewer.id,
        baseVersion: 1,
        createdAt: ago(2 * HOUR),
      })
      .returning();
    await h.db.insert(conceptComment).values({
      projectId,
      conceptId: ids.A!,
      version: 1,
      body: "Phone too small",
      authorUserId: admin.viewer.id,
      changeRequestId: request!.id,
      sentInVersion: 2,
    });

    expect((await sweepStuckWork(h.db, NOW)).requests).toEqual([request!.id]);

    const [after] = await h.db.select().from(conceptChangeRequest).where(eq(conceptChangeRequest.id, request!.id));
    expect(after).toMatchObject({ status: "failed", resultVersion: null });
    expect(after!.failureReason).toMatch(/^The worker never picked this up/);
    const [comment] = await h.db.select().from(conceptComment).where(eq(conceptComment.conceptId, ids.A!));
    expect(comment).toMatchObject({ changeRequestId: null, sentInVersion: null });
  });

  it("never makes a dead worker look alive by its own writes", async () => {
    const { admin, projectId } = await seedProject();
    await seedRun(projectId, admin.viewer.id, ago(3 * HOUR));
    const before = await lastWorkerActivity(h.db);
    await sweepStuckWork(h.db, NOW);
    expect(await lastWorkerActivity(h.db)).toEqual(before);
  });

  it("runs when the Design screen and Spend open", async () => {
    const { admin, projectId } = await seedProject();
    const real = new Date();
    const first = await seedRun(projectId, admin.viewer.id, ago(2 * HOUR, real));
    expect((await getLatestRun(admin.viewer, projectId))!.status).toBe("failed");

    const second = await seedRun(projectId, admin.viewer.id, ago(2 * HOUR, real));
    // The run's own month in California: two hours ago can still be last month just after midnight on the 1st.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(real.getTime() - 2 * HOUR));
    const { report } = await loadSpendReport(
      h.db,
      admin.viewer,
      resolvePeriod({ kind: "month", month: today.slice(0, 7) }, today),
    );
    expect((await runRow(second.runId)).status).toBe("failed");
    expect(report.runs.find((r) => r.id === second.runId)!.status).toBe("Failed to start");
    expect((await runRow(first.runId)).status).toBe("failed");
  });
});
