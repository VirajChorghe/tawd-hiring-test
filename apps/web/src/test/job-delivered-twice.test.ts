import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
  Work a worker restart leaves behind (audit F-006 and F-007, 12 November
  2026). The worker restarts on every merge to main, and BullMQ delivers a
  job again after a stall:
  - a site build was left "working" for ever, and every new build was
    refused as "already being built", with nothing in the app to clear it;
  - a concept job delivered twice built the concept twice: its versions
    written again and every AI call paid again.
*/

import { setDbForTesting, type Database } from "@tawd/core/db";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { activityLog, aiCall, concept, conceptStep, conceptVersion, homeWords, siteBuild } from "@tawd/core/schema";
import { BUILD_STALLED_AFTER_MS, sweepStalledSiteBuilds } from "@tawd/core/stuck-work";
import { claimSiteBuild } from "@tawd/core/paid-starts";
import { planRun, setQueueForTesting, startRun } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import type { WorkerConfig } from "../../../worker/src/config";
import { CONCEPT_STALLED_AFTER_MS, runConceptJob } from "../../../worker/src/pipeline";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, review } from "./worker-fakes";

let h: Harness;
let queued: { name: string; data: Record<string, unknown> }[];
const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

beforeEach(async () => {
  seeded = null;
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async () => null });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

let seeded: Awaited<ReturnType<typeof seedAdmin>> | null = null;
async function project(status = "build") {
  const admin = seeded ?? (seeded = await seedAdmin(h));
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Synthetic Plumbing Co", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status, memberUserIds: [] } as never);
  return { admin, id };
}

describe("a site build a stopped worker left working", () => {
  it("is marked failed after ten minutes without a heartbeat, so a new build can start; a running one is left alone", async () => {
    const { id } = await project();
    const now = new Date("2026-11-12T12:00:00Z");
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    await h.db.insert(siteBuild).values([
      { projectId: id, version: 1, status: "done", createdAt: minutesAgo(300) },
      // Left behind: its last heartbeat eleven minutes ago.
      { projectId: id, version: 2, status: "working", step: "Building page 3 of 9", createdAt: minutesAgo(40), heartbeatAt: minutesAgo(11) },
    ] as never);
    const [other] = await h.db.select().from(siteBuild).where(eq(siteBuild.version, 2));
    expect(await claimSiteBuild(h.db as Database, id, {})).toBeNull();

    // A second project's build, still running: a heartbeat a minute ago, though it started an hour ago.
    const busy = await project();
    await h.db.insert(siteBuild).values({ projectId: busy.id, version: 1, status: "working", createdAt: minutesAgo(60), heartbeatAt: minutesAgo(1) } as never);

    expect(BUILD_STALLED_AFTER_MS).toBe(10 * 60_000);
    const swept = await sweepStalledSiteBuilds(h.db as Database, now);
    expect(swept).toEqual([other!.id]);
    const [after] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, other!.id));
    expect(after).toMatchObject({ status: "failed", step: null });
    expect(after!.failureReason).toContain("The worker stopped part-way through this build");
    expect(after!.failureReason).toContain("Build again.");
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, busy.id)))[0]!.status).toBe("working");
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.build_stalled"))).map((a) => a.entityId)).toEqual([id]);

    // The way forward: a new build is accepted.
    expect(await claimSiteBuild(h.db as Database, id, {})).toMatchObject({ version: 3 });
    // Sweeping again changes nothing.
    expect(await sweepStalledSiteBuilds(h.db as Database, now)).toEqual([]);
  });

  it("counts a build from before heartbeats existed from when it was created", async () => {
    const { id } = await project();
    const now = new Date("2026-11-12T12:00:00Z");
    await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "working", createdAt: new Date(now.getTime() - 3 * 86_400_000) } as never);
    expect(await sweepStalledSiteBuilds(h.db as Database, now)).toHaveLength(1);
  });
});

describe("a concept job delivered twice", () => {
  it("builds once: the second delivery claims nothing, writes no version and makes no AI call", async () => {
    const { admin, id } = await project("mockups");
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Synthetic Plumbing Co", phone: "(555) 555-0142", city: "Springfield", state: "CA", streetAddress: "1 Test Way" });
    await h.db.insert(homeWords).values({ projectId: id, source: "tawd", sections: [{ name: "Hero", words: "Synthetic words for the test." }], approvedAt: new Date() });
    const plan = await planRun(admin.viewer, id, 1);
    await startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1), polish: false } as never);
    const job = queued.find((q) => q.name === "build-concept")!;
    const claude = fakeClaude(() => [review(["A"], {}, false)]);
    const browser = fakeBrowser();
    const data = job.data as { conceptId: string };

    expect(await runConceptJob(job.data as never, config, claude.client as never, browser as never)).toBe(true);
    const versions = async () => (await h.db.select({ v: conceptVersion.version }).from(conceptVersion).where(eq(conceptVersion.conceptId, data.conceptId))).map((r) => r.v).sort();
    const firstVersions = await versions();
    const firstCalls = (await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).length;
    expect(firstVersions.length).toBeGreaterThan(0);

    // The same job again, as BullMQ delivers a stalled one.
    expect(await runConceptJob(job.data as never, config, claude.client as never, browser as never)).toBe(false);
    expect(await versions()).toEqual(firstVersions);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).length).toBe(firstCalls);
    expect((await h.db.select().from(concept).where(eq(concept.id, data.conceptId)))[0]!.status).toBe("ready");
  }, 120_000);
});

describe("a concept a stopped worker left running", () => {
  async function queuedConcept() {
    const { admin, id } = await project("mockups");
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Synthetic Plumbing Co", phone: "(555) 555-0142", city: "Springfield", state: "CA", streetAddress: "1 Test Way" });
    await h.db.insert(homeWords).values({ projectId: id, source: "tawd", sections: [{ name: "Hero", words: "Synthetic words for the test." }], approvedAt: new Date() });
    const plan = await planRun(admin.viewer, id, 1);
    await startRun(h.ctx, admin.viewer, { projectId: id, concepts: plan.plan.concepts.slice(0, 1), polish: false } as never);
    const job = queued.find((q) => q.name === "build-concept")!;
    return { id, job, conceptId: (job.data as { conceptId: string }).conceptId };
  }
  const versionsOf = async (conceptId: string) => (await h.db.select({ v: conceptVersion.version }).from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId))).map((r) => r.v).sort();

  it("is taken over when its heartbeat is eleven minutes old: partial work cleared, built again, noted in the activity log", async () => {
    const { id, job, conceptId } = await queuedConcept();
    // What the stopped worker left: running, an old heartbeat, a version and a half-done step.
    await h.db.update(concept).set({ status: "running", heartbeatAt: new Date(Date.now() - 11 * 60_000) }).where(eq(concept.id, conceptId));
    await h.db.insert(conceptVersion).values({ conceptId, version: 1, summary: "the stopped worker" });
    await h.db.update(conceptStep).set({ status: "working", detail: "Designing the page" }).where(eq(conceptStep.conceptId, conceptId));
    expect(await versionsOf(conceptId)).toEqual([1]);

    const claude = fakeClaude(() => [review(["A"], {}, false)]);
    expect(CONCEPT_STALLED_AFTER_MS).toBe(10 * 60_000);
    expect(await runConceptJob(job.data as never, config, claude.client as never, fakeBrowser() as never)).toBe(true);

    const versions = await versionsOf(conceptId);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(versions.length);
    expect((await h.db.select().from(conceptVersion).where(eq(conceptVersion.summary, "the stopped worker"))).length).toBe(0);
    expect((await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, conceptId))).every((r) => r.detail !== "Designing the page" || r.status !== "working")).toBe(true);
    const [row] = await h.db.select().from(concept).where(eq(concept.id, conceptId));
    expect(row!.status).toBe("ready");
    const resumed = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.concept_resumed"));
    expect(resumed.map((a) => a.entityId)).toEqual([id]);
  }, 120_000);

  it("is left alone when its heartbeat is one minute old", async () => {
    const { id, job, conceptId } = await queuedConcept();
    const beat = new Date(Date.now() - 60_000);
    await h.db.update(concept).set({ status: "running", heartbeatAt: beat }).where(eq(concept.id, conceptId));
    const claude = fakeClaude(() => [review(["A"], {}, false)]);
    expect(await runConceptJob(job.data as never, config, claude.client as never, fakeBrowser() as never)).toBe(false);
    const [row] = await h.db.select().from(concept).where(eq(concept.id, conceptId));
    expect(row).toMatchObject({ status: "running" });
    expect(row!.heartbeatAt!.getTime()).toBe(beat.getTime());
    expect(await versionsOf(conceptId)).toEqual([]);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).length).toBe(0);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.concept_resumed"))).toEqual([]);
  }, 120_000);
});
