import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveIntakeSection } from "@tawd/core/intake/service";
import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  concept,
  conceptStep,
  conceptVersion,
  mockupRun,
  pipelineSteps,
  project as projectTable,
} from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { setSlackFetchForTesting } from "@tawd/core/slack";
import { addComment, recordClientDecision, requestChanges } from "@/lib/concept-review";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject, updateProject } from "@/lib/projects";
import { connectSlack, setSlackComments, slackWarningFor } from "@/lib/slack-settings";
import { settleSlackPosts } from "@/lib/slack-notify";

import { runChangesJob } from "../../../worker/src/changes";
import { finalizeRun } from "../../../worker/src/pipeline";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, PAGE, fakeBrowser, fakeClaude, review } from "./worker-fakes";

/*
  3d: which events reach Slack, what they say, and that a failing Slack
  never stops or undoes the action that triggered it.
*/

const WEBHOOK = "https://hooks.slack.com/services/T0AAA1/B0BBB2/abcdefGHIJKLmnop1234x9Kq";

let h: Harness;
let r2: FakeR2;
let posts: string[];
let slackUp: boolean;

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  setEncryptionKeyForTesting(randomBytes(32));
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
  posts = [];
  slackUp = true;
  setSlackFetchForTesting(async (_url, init) => {
    posts.push((JSON.parse(String(init.body)) as { text: string }).text);
    return slackUp
      ? { ok: true, status: 200, text: async () => "ok" }
      : { ok: false, status: 500, text: async () => "internal_error" };
  });
});

afterEach(async () => {
  setSlackFetchForTesting(null);
  setEncryptionKeyForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function seed({ connect = true } = {}) {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Plumbing",
    trade: "plumbing",
    tier: "growth",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 2,
    status: "intake",
    memberUserIds: [],
  });
  if (connect) await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);
  return { admin, projectId };
}

async function seedReadyRun(projectId: string, userId: string, flagB = false) {
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  const [run] = await h.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 2, status: "running", model: "m", startedByUserId: userId })
    .returning();
  const ids: Record<string, string> = {};
  for (const label of ["A", "B"]) {
    const [row] = await h.db
      .insert(concept)
      .values({ runId: run!.id, projectId, label, direction: "modern_clean", skillId: "impeccable", status: "ready" })
      .returning();
    ids[label] = row!.id;
    await h.db.insert(conceptStep).values(pipelineSteps.map((step) => ({ conceptId: row!.id, step, status: "done" })));
    const base = `projects/${projectId}/concepts/${row!.id}/v2`;
    await h.db.insert(conceptVersion).values({
      conceptId: row!.id,
      version: 2,
      htmlKey: `${base}/page.html`,
      pngKey: `${base}/full.png`,
      checks: { passed: true, issues: [], stage: "cd_improve" },
      review: { passes: [], ...(flagB && label === "B" ? { needsPmReview: true } : {}) },
    });
    await r2.put(`${base}/source.html`, Buffer.from(PAGE));
  }
  return { runId: run!.id, ids };
}

describe("Slack events", () => {
  it("a finished run posts concepts ready, and Needs PM review when a concept is flagged", async () => {
    const { admin, projectId } = await seed();
    const { runId } = await seedReadyRun(projectId, admin.viewer.id, true);
    await finalizeRun(runId);

    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatch(/^\*Test Plumbing\*: 2 concepts ready for team review\. <.*\/mockups\|Open Design>$/);
    expect(posts[1]).toContain("Concept B still scored under 3 after a rebuild and needs a PM's look");
  });

  it("a stage change posts where the project moved", async () => {
    const { admin, projectId } = await seed();
    // The one item nothing skips (30 September 2026).
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    await updateProject(
      h.ctx,
      admin.viewer,
      projectId,
      {
        clientName: "Test Plumbing",
        trade: "plumbing",
        tier: "growth",
        lane: "lane_1",
        laneOption: null,
        conceptCount: 2,
        status: "mockups",
        memberUserIds: [],
      },
      { overrideReason: "Client asked us to start while they find the rest" },
    );
    await settleSlackPosts();
    expect(posts).toEqual([expect.stringContaining("*Test Plumbing* moved from Intake to Design.")]);
  });

  it("the client's decision posts who recorded it and the outcome, never what the client said", async () => {
    const { admin, projectId } = await seed();
    const { ids } = await seedReadyRun(projectId, admin.viewer.id);
    await recordClientDecision(h.ctx, admin.viewer, {
      conceptId: ids.B!,
      channel: "phone",
      changesRequested: false,
      clientSaid: "Mrs Jones at 916-555-0147 loves it",
    });
    await settleSlackPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("recorded the client's decision: Concept B v2 approved. Moved to Content.");
    // The link's address holds the project's random id, which can itself contain "555" (a red run on PR #6): only the words are checked.
    expect(posts[0]!.replace(/<[^|>]*\|/g, "<")).not.toMatch(/Jones|555|loves/);
  });

  it("a new version from requested changes posts with a link to the concept", async () => {
    const { admin, projectId } = await seed();
    const { ids } = await seedReadyRun(projectId, admin.viewer.id);
    await h.db.update(mockupRun).set({ status: "succeeded" });
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "Bigger phone", includeComments: false });
    const { client } = fakeClaude(() => [review(["A"], {}, false)]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());

    // The newest version: v3, or later if automatic fix rounds followed it.
    expect(posts.at(-1)).toMatch(/Concept A v[3-5] is ready, with the requested changes. </);
    expect(posts.at(-1)).toContain(`/mockups/${ids.A}|Open Concept A>`);
  });

  it("comments post only when switched on, only new threads, and never the text", async () => {
    const { admin, projectId } = await seed();
    const { ids } = await seedReadyRun(projectId, admin.viewer.id);
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Secret client detail" });
    await settleSlackPosts();
    expect(posts).toHaveLength(0);

    await setSlackComments(h.ctx, admin.viewer, projectId, true);
    const first = await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Secret client detail" });
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "A reply", parentId: first });
    await settleSlackPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/commented on Concept A\./);
    expect(posts[0]).not.toContain("Secret");
  });

  it("nothing is posted for a project without Slack", async () => {
    const { admin, projectId } = await seed({ connect: false });
    const { runId } = await seedReadyRun(projectId, admin.viewer.id);
    await finalizeRun(runId);
    expect(posts).toHaveLength(0);
  });

  it("when Slack is down, the action still happens and the project shows a warning", async () => {
    const { admin, projectId } = await seed();
    const { ids } = await seedReadyRun(projectId, admin.viewer.id);
    slackUp = false;

    const result = await recordClientDecision(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      channel: "email",
      changesRequested: false,
      clientSaid: "A please",
    });
    await settleSlackPosts();

    expect(result.movedToContent).toBe(true);
    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, projectId));
    expect(row!.status).toBe("content");
    expect(await slackWarningFor(h.db, projectId)).toMatch(/Slack answered with an error \(500: internal_error\)/);
  });
});
