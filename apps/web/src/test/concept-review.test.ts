import path from "node:path";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  activityLog,
  aiCall,
  clientDecision,
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptStep,
  conceptVersion,
  mockupRun,
  pipelineSteps,
  project as projectTable,
  sectionExample,
} from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { addSectionExamples, examplesFor, seedSectionLibrary } from "@tawd/core/section-library";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { PermissionError } from "@tawd/core/permissions";
import { CHANGES_JOB, REVIEW_JOB, changesJobId } from "@tawd/core/queue";
import {
  bandIndexAt,
  bandsOnImage,
  buildSectionEditPrompt,
  describeChangeRequest,
  describePinPosition,
  examplesSection,
} from "@tawd/core/mockups";
import {
  addComment,
  buildClientPack,
  openUnsentComments,
  recordClientDecision,
  conceptsMissingReview,
  estimateChanges,
  requestChanges,
  rerunReview,
  retryNotDone,
  setCommentResolved,
  setSendToClient,
  showHeldConcept,
} from "@/lib/concept-review";
import { MockupError, setQueueForTesting, type JobQueue } from "@/lib/mockups";
import { ProjectDeleteError, deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { setMonthlyLimit } from "@/lib/spend";
import { describeChanges } from "@/lib/timeline-text";

import { markChangesFailed, placePin, runChangesJob } from "../../../worker/src/changes";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, PAGE, fakeBrowser, fakeClaude, messagesText, review } from "./worker-fakes";

/*
  Phase 3c underneath the screens: team comments, Request changes (from the
  web app's rules to the worker's new version and its score), the client's
  decision, the client pack, and project deletion taking all of it away.
*/

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: unknown; options?: { jobId?: string } }[];
let queueFails: boolean;

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
  queued = [];
  queueFails = false;
  const queue: JobQueue = {
    add: async (name, data, options) => {
      if (queueFails) throw new Error("Redis is down");
      queued.push({ name, data, options });
    },
    getJob: async () => null,
  };
  setQueueForTesting(queue);
});

afterEach(async () => {
  delete process.env.TAWD_SECTION_LIBRARY;
  setQueueForTesting(null);
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

async function seed(labels: string[] = ["A", "B"]) {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Dale Rowan",
    trade: "well_and_pump",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: labels.length,
    status: "intake",
    memberUserIds: [],
  });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
    name: "Example Well & Pump",
    phone: "(530) 555-0199",
    city: "Grass Valley",
  });

  const [run] = await h.db
    .insert(mockupRun)
    .values({
      projectId,
      conceptCount: labels.length,
      status: "succeeded",
      model: "claude-opus-5-5",
      startedByUserId: admin.viewer.id,
    })
    .returning();

  const ids: Record<string, string> = {};
  for (const [index, label] of labels.entries()) {
    const [row] = await h.db
      .insert(concept)
      .values({
        runId: run!.id,
        projectId,
        label,
        direction: ["rugged_craftsman", "classic_trust", "warm_local"][index]!,
        skillId: ["impeccable", "ui_ux_pro_max", "taste"][index]!,
        status: "ready",
      })
      .returning();
    ids[label] = row!.id;
    await h.db.insert(conceptStep).values(
      pipelineSteps.map((step) => ({ conceptId: row!.id, step, status: "done" })),
    );
    const base = `projects/${projectId}/concepts/${row!.id}/v2`;
    await h.db.insert(conceptVersion).values({
      conceptId: row!.id,
      version: 2,
      htmlKey: `${base}/page.html`,
      pngKey: `${base}/full.png`,
      foldPngKey: `${base}/fold.png`,
      checks: { passed: true, issues: [], stage: "cd_improve" },
    });
    await r2.put(`${base}/page.html`, Buffer.from(PAGE));
    await r2.put(`${base}/source.html`, Buffer.from(PAGE));
    await r2.put(`${base}/full.png`, Buffer.from(`png-${label}`));
  }

  return { admin, projectId, runId: run!.id, ids };
}

async function requestRow(id: string) {
  const [row] = await h.db
    .select()
    .from(conceptChangeRequest)
    .where(eq(conceptChangeRequest.id, id));
  return row!;
}

async function commentsOf(conceptId: string) {
  return h.db.select().from(conceptComment).where(eq(conceptComment.conceptId, conceptId));
}

/* ---------- comments ---------- */

describe("team comments", () => {
  it("pins a comment to a spot on a version, and replies join its thread unpinned", async () => {
    const { admin, ids } = await seed();
    const pinned = await addComment(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      version: 2,
      body: "Headline wraps to four lines.",
      pinX: 12.5,
      pinY: 8,
    });
    const reply = await addComment(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      version: 2,
      body: "Agreed",
      pinX: 50,
      pinY: 50,
      parentId: pinned,
    });
    // A reply to a reply still belongs to the first comment.
    const nested = await addComment(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      version: 2,
      body: "Me too",
      parentId: reply,
    });

    const rows = await commentsOf(ids.A!);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(pinned)).toMatchObject({ pinX: 12.5, pinY: 8, version: 2, parentId: null });
    expect(byId.get(reply)).toMatchObject({ parentId: pinned, pinX: null, pinY: null });
    expect(byId.get(nested)!.parentId).toBe(pinned);
  });

  it("anyone on the team can comment, but an empty comment or an off-page pin is refused", async () => {
    const { admin, ids } = await seed();
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await addComment(h.ctx, seo.viewer, { conceptId: ids.A!, version: 2, body: "Looks good" });

    await expect(
      addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "   " }),
    ).rejects.toThrow(/Write the comment/);
    await expect(
      addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "x", pinX: 120, pinY: 5 }),
    ).rejects.toBeInstanceOf(MockupError);
  });

  it("resolves and reopens, and resolved comments are not sent", async () => {
    const { admin, ids } = await seed();
    const id = await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Fix the phone" });
    await setCommentResolved(h.ctx, admin.viewer, id, true);
    expect(await openUnsentComments(h.db, ids.A!)).toHaveLength(0);
    await setCommentResolved(h.ctx, admin.viewer, id, false);
    expect(await openUnsentComments(h.db, ids.A!)).toHaveLength(1);
  });
});

/* ---------- Request changes, the web app's side ---------- */

describe("Request changes", () => {
  it("queues one job with the notes and the open pinned comments, which are then no longer open", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Bigger phone", pinX: 80, pinY: 3 });
    const resolved = await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Old" });
    await setCommentResolved(h.ctx, admin.viewer, resolved, true);

    const requestId = await requestChanges(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      notes: "Use the brand blue #1F4E79.",
      includeComments: true,
    });

    expect(queued).toEqual([
      {
        name: CHANGES_JOB,
        data: { requestId, conceptId: ids.A, projectId },
        options: { jobId: changesJobId(requestId), attempts: 1 },
      },
    ]);
    const request = await requestRow(requestId);
    expect(request).toMatchObject({ source: "team", baseVersion: 2, status: "queued" });

    const rows = await commentsOf(ids.A!);
    expect(rows.find((r) => r.body === "Bigger phone")!.changeRequestId).toBe(requestId);
    expect(rows.find((r) => r.body === "Old")!.changeRequestId).toBeNull();

    const [log] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mockups.changes_requested"));
    expect(log!.valueAfter).toMatchObject({ concept: "A", baseVersion: 2, comments: 1 });
  });

  it("leaves the comments out when asked, and needs notes or a comment", async () => {
    const { admin, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Pin" });
    await expect(
      requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "  ", includeComments: false }),
    ).rejects.toThrow(/Write what should change/);

    await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "Tighter hero", includeComments: false });
    expect((await openUnsentComments(h.db, ids.A!)).map((c) => c.body)).toEqual(["Pin"]);
  });

  it("is for PMs and admins only", async () => {
    const { admin, ids } = await seed();
    const designer = await seedUser(h, admin.viewer, { email: "dee@velocitymedialab.com", roles: ["web_designer"] });
    await expect(
      requestChanges(h.ctx, designer.viewer, { conceptId: ids.A!, notes: "x", includeComments: false }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("allows one at a time per concept, and none while concepts are generating", async () => {
    const { admin, runId, ids } = await seed();
    await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "One", includeComments: false });
    await expect(
      requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "Two", includeComments: false }),
    ).rejects.toThrow(/already being made/);
    // Another concept is fine.
    await requestChanges(h.ctx, admin.viewer, { conceptId: ids.B!, notes: "Other", includeComments: false });

    await h.db.update(mockupRun).set({ status: "running" }).where(eq(mockupRun.id, runId));
    await h.db.update(conceptChangeRequest).set({ status: "done" });
    await expect(
      requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "Three", includeComments: false }),
    ).rejects.toThrow(/still generating/);
  });

  it("is blocked by the monthly AI limit, like Generate", async () => {
    const { admin, projectId, runId, ids } = await seed();
    await setMonthlyLimit(h.ctx, admin.viewer, 1);
    await h.db.insert(aiCall).values({
      projectId,
      runId,
      conceptId: ids.A!,
      step: "build",
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens: 50_000,
    });

    const attempt = requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: false });
    await expect(attempt).rejects.toThrow(/Spend page/);
    expect(queued).toHaveLength(0);
    expect(await h.db.select().from(conceptChangeRequest)).toHaveLength(0);
  });

  it("only while the project is at Design", async () => {
    const { admin, projectId, ids } = await seed();
    await h.db.update(projectTable).set({ status: "content" }).where(eq(projectTable.id, projectId));
    await expect(
      requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: false }),
    ).rejects.toThrow(/at Design/);
  });

  it("puts the comments back to Not sent if the queue refuses", async () => {
    const { admin, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Pin" });
    queueFails = true;
    await expect(
      requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: true }),
    ).rejects.toThrow(/could not be queued/);
    expect(await openUnsentComments(h.db, ids.A!)).toHaveLength(1);
    const [request] = await h.db.select().from(conceptChangeRequest);
    expect(request!.status).toBe("failed");
  });
});

/* ---------- Request changes, the worker's side ---------- */

describe("the changes job", () => {
  it("makes the next version from the notes and pins, checks it, and scores it once", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Bigger phone number", pinX: 80, pinY: 3 });
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    const requestId = await requestChanges(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      notes: "Use the brand blue #1F4E79.",
      includeComments: true,
    });

    const { client, calls } = fakeClaude(() => [review(["A"], {}, false)]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());

    /*
      A small call to find the parts the written notes are about, one edit
      of only those parts, and one scoring pass. No improvement round, no
      rebuild.
    */
    expect(calls.map((c) => c.kind)).toEqual(["builder", "builder", "review"]);

    const locate = messagesText(calls[0]!.params);
    expect(locate).toContain("Which bands does the request change?");
    expect(locate).toContain("Use the brand blue #1F4E79.");
    expect(locate).not.toContain("<!doctype");

    const prompt = messagesText(calls[1]!.params);
    expect(prompt).toContain("Use the brand blue #1F4E79.");
    expect(prompt).toContain("Bigger phone number");
    expect(prompt).toContain("near the top");
    expect(prompt).toContain("Warmer photos overall");
    // Only the part it is about (band 1, the phone link), never the whole page.
    expect(prompt).toContain('<tawd-section id="1">');
    expect(prompt).not.toContain("<form");
    expect(prompt).not.toContain("<!doctype");

    /*
      Only this concept was reviewed - and question 2 is still SCORED,
      because the run has two concepts (Jason's run, 10 November 2026).

      This test used to assert the opposite, and it was asserting the
      fault: a changes pass reviews one concept on its own, and it told the
      reviewer that one concept WAS the run, so Direction fit came back
      "Not applicable: this run has only one concept to compare" on a
      two-concept run. Both of a client's concepts read "4 to N/A".
    */
    const reviewText = messagesText(calls[2]!.params);
    expect(reviewText).toContain("Concept A");
    expect(reviewText).not.toContain("Concept B:");
    // The reviewer is told why it cannot compare them here, rather than that there is nothing to compare.
    expect(reviewText).toContain("not shown in this pass");

    const versions = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids.A!));
    const v3 = versions.find((v) => v.version === 3)!;
    expect((v3.checks as { stage: string }).stage).toBe("changes");
    const passes = (v3.review as { passes: { pass: string; questions: { question: number; notApplicable: boolean }[] }[] }).passes;
    expect(passes.map((p) => p.pass)).toEqual(["changes"]);
    expect(passes[0]!.questions.find((q) => q.question === 2)!.notApplicable).toBe(false);

    const request = await requestRow(requestId);
    expect(request).toMatchObject({ status: "done", resultVersion: 3 });
    expect((await commentsOf(ids.A!)).every((c) => c.sentInVersion === 3)).toBe(true);

    // The ledger credits the person who asked, under its own step.
    const calls_ = await h.db.select().from(aiCall).where(eq(aiCall.projectId, projectId));
    expect(calls_.map((c) => `${c.step}:${c.scope}`).sort()).toEqual(["changes:locate", "changes:sections", "review:null"]);
    expect(calls_.every((c) => c.startedByUserId === admin.viewer.id)).toBe(true);

    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.changes_finished"));
    expect(log!.valueAfter).toMatchObject({ concept: "A", version: 3 });
  });

  it("places a pinned comment on the band it sits on, with no call to find it, and changes only that band", async () => {
    const { admin, projectId, ids } = await seed();
    // 35% down the page: the second band (20% to 50% on the measured page).
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Make this link a button", pinX: 50, pinY: 35 });
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });

    const { client, calls } = fakeClaude(() => [review(["A"], {}, false)]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());

    expect(calls.map((c) => c.kind)).toEqual(["builder", "review"]);
    const first = messagesText({ messages: [(calls[0]!.params.messages as { content: unknown }[])[0]!] });
    expect(first).toContain("Make this link a button");
    expect(first).toContain(`<tawd-section id="1">`);
    expect(first).not.toContain(`<tawd-section id="0">`);
    expect(first).not.toContain("<form");

    const v3 = (await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids.A!))).find(
      (v) => v.version === 3,
    )!;
    const source = r2.objects.get(v3.htmlKey!.replace(/page\.html$/, "source.html"))!.toString("utf8");
    expect(source).toContain(`<a data-edited href="tel:+15305550199">`);
    expect(source).toContain("<form><label");

    const ledger = await h.db.select().from(aiCall).where(eq(aiCall.step, "changes"));
    expect(ledger.map((c) => c.scope)).toEqual(["sections"]);
  });

  it("if no changed part comes back, the request fails and the comments go back to Not sent", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Pin", pinX: 10, pinY: 10 });
    const requestId = await requestChanges(h.ctx, admin.viewer, {
      conceptId: ids.A!,
      notes: "x",
      includeComments: true,
    });

    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: "text", text: "Sorry, no page." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        }),
      },
    } as never;

    await expect(
      runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser()),
    ).rejects.toThrow(/^The changes were not made: /);
    await markChangesFailed(requestId, "The changes were not made.");

    expect((await requestRow(requestId)).status).toBe("failed");
    expect(await openUnsentComments(h.db, ids.A!)).toHaveLength(1);
    const versions = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids.A!));
    expect(versions.map((v) => v.version)).toEqual([2]);
  });

  it("does nothing for a request that is no longer waiting", async () => {
    const { admin, projectId, ids } = await seed();
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: false });
    await h.db.update(conceptChangeRequest).set({ status: "failed" });
    const { client, calls } = fakeClaude(() => []);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());
    expect(calls).toHaveLength(0);
  });
});

/* ---------- the client's decision ---------- */

describe("recording the client's decision", () => {
  it("approved as is moves the project to Content and logs who, what and how", async () => {
    const { admin, projectId, ids } = await seed();
    const result = await recordClientDecision(h.ctx, admin.viewer, {
      conceptId: ids.B!,
      channel: "phone",
      changesRequested: false,
      clientSaid: "Loves B as it is.",
    });
    expect(result).toEqual({ changeRequestId: null, movedToContent: true });

    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, projectId));
    expect(row!.status).toBe("content");
    const [decision] = await h.db.select().from(clientDecision);
    expect(decision).toMatchObject({ conceptId: ids.B, version: 2, channel: "phone", changesRequested: false });

    const actions = (await h.db.select().from(activityLog)).map((l) => l.action);
    expect(actions).toContain("mockups.client_decision");
    expect(actions).toContain("project.status_changed");
    expect(queued).toHaveLength(0);
    expect(decision!.logoApproved).toBe(false);
  });

  it("records the 'Logo approved by the client' tick with the decision and on the timeline", async () => {
    const { admin, ids } = await seed();
    await recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.A!, channel: "meeting", changesRequested: false, clientSaid: "A, and the logo is right.", logoApproved: true });
    const [decision] = await h.db.select().from(clientDecision);
    expect(decision!.logoApproved).toBe(true);
    const [log] = (await h.db.select().from(activityLog)).filter((l) => l.action === "mockups.client_decision");
    expect(log!.valueAfter).toMatchObject({ logoApproved: true });
  });

  it("changes requested keeps the project in Mockups and makes a new version from what the client said", async () => {
    const { admin, projectId, ids } = await seed();
    const result = await recordClientDecision(h.ctx, admin.viewer, {
      conceptId: ids.B!,
      channel: "email",
      changesRequested: true,
      clientSaid: "Likes B, wants the phone number bigger.",
    });
    expect(result.movedToContent).toBe(false);
    const request = await requestRow(result.changeRequestId!);
    expect(request).toMatchObject({ source: "client", notes: "Likes B, wants the phone number bigger." });
    expect(queued).toHaveLength(1);

    const [row] = await h.db.select().from(projectTable).where(eq(projectTable.id, projectId));
    expect(row!.status).toBe("mockups");
  });

  it("needs how it came in and what the client said, and a PM or admin", async () => {
    const { admin, ids } = await seed();
    await expect(
      recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.A!, channel: "fax", changesRequested: false, clientSaid: "OK then" }),
    ).rejects.toThrow(/how the decision came in/);
    await expect(
      recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.A!, channel: "phone", changesRequested: false, clientSaid: "" }),
    ).rejects.toThrow(/what the client said/);

    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(
      recordClientDecision(h.ctx, seo.viewer, { conceptId: ids.A!, channel: "phone", changesRequested: false, clientSaid: "OK then" }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("changes requested is blocked by the monthly limit too", async () => {
    const { admin, projectId, runId, ids } = await seed();
    await setMonthlyLimit(h.ctx, admin.viewer, 1);
    await h.db.insert(aiCall).values({
      projectId, runId, conceptId: ids.A!, step: "build", model: "claude-opus-5-5", inputTokens: 0, outputTokens: 50_000,
    });
    await expect(
      recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.A!, channel: "phone", changesRequested: true, clientSaid: "Bigger phone" }),
    ).rejects.toThrow(/Spend page/);
    expect(await h.db.select().from(clientDecision)).toHaveLength(0);
  });
});

/* ---------- Run the review again ---------- */

describe("Run the review again", () => {
  const scoredAfter = { passes: [{ pass: "after", average: 4, lowest: 4, questions: [], summary: "", safetyAdvice: [], earlierNotes: [], reviewedAt: "" }] };

  it("queues a review-only job for the concepts missing a review, and shows it running", async () => {
    const { admin, projectId, runId, ids } = await seed();
    await h.db.update(mockupRun).set({ status: "review_incomplete" }).where(eq(mockupRun.id, runId));
    // A finished its review; B did not.
    await h.db.update(conceptVersion).set({ review: scoredAfter }).where(eq(conceptVersion.conceptId, ids.A!));
    expect((await conceptsMissingReview(h.db, runId)).map((c) => c.label)).toEqual(["B"]);

    const result = await rerunReview(h.ctx, admin.viewer, runId);
    expect(result.concepts).toEqual(["B"]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ name: REVIEW_JOB, data: { runId, projectId, retry: true } });
    expect(queued[0]!.options!.jobId!.startsWith(`review-${runId}-retry-`)).toBe(true);

    const [run] = await h.db.select().from(mockupRun).where(eq(mockupRun.id, runId));
    expect(run!.status).toBe("running");
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.review_rerun"));
    expect(log!.valueAfter).toEqual({ concepts: ["B"] });
  });

  it("refuses when every review finished, while running, for non-PMs, and at the monthly limit", async () => {
    const { admin, projectId, runId, ids } = await seed();
    for (const id of [ids.A!, ids.B!]) {
      await h.db.update(conceptVersion).set({ review: scoredAfter }).where(eq(conceptVersion.conceptId, id));
    }
    await expect(rerunReview(h.ctx, admin.viewer, runId)).rejects.toThrow(/already has its review/);

    await h.db.update(conceptVersion).set({ review: null }).where(eq(conceptVersion.conceptId, ids.B!));
    await h.db.update(mockupRun).set({ status: "running" }).where(eq(mockupRun.id, runId));
    await expect(rerunReview(h.ctx, admin.viewer, runId)).rejects.toThrow(/already running/);
    await h.db.update(mockupRun).set({ status: "review_incomplete" }).where(eq(mockupRun.id, runId));

    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(rerunReview(h.ctx, seo.viewer, runId)).rejects.toBeInstanceOf(PermissionError);

    await setMonthlyLimit(h.ctx, admin.viewer, 1);
    await h.db.insert(aiCall).values({ projectId, runId, conceptId: ids.A!, step: "build", model: "claude-opus-5-5", inputTokens: 0, outputTokens: 50_000 });
    await expect(rerunReview(h.ctx, admin.viewer, runId)).rejects.toThrow(/Spend page/);
    expect(queued).toHaveLength(0);
  });
});

/* ---------- the client pack ---------- */

describe("the client pack", () => {
  it("zips the ticked concepts as Concept A.png and so on, and logs it", async () => {
    const { admin, projectId, ids } = await seed(["A", "B", "C"]);
    await setSendToClient(h.ctx, admin.viewer, ids.B!, false);

    const pack = await buildClientPack(h.ctx, admin.viewer, projectId);
    expect(pack.fileName).toBe("Dale Rowan concepts.zip");
    expect(pack.labels).toEqual(["A", "C"]);

    const files = unzipSync(pack.body);
    expect(Object.keys(files).sort()).toEqual(["Concept A.png", "Concept C.png"]);
    expect(Buffer.from(files["Concept A.png"]!).toString()).toBe("png-A");

    const actions = (await h.db.select().from(activityLog)).map((l) => l.action);
    expect(actions).toContain("mockups.client_pack_downloaded");
    expect(actions).toContain("mockups.send_to_client_changed");
  });

  it("says so when nothing is ticked", async () => {
    const { admin, projectId, ids } = await seed(["A"]);
    await setSendToClient(h.ctx, admin.viewer, ids.A!, false);
    await expect(buildClientPack(h.ctx, admin.viewer, projectId)).rejects.toThrow(/Tick Send to client/);
  });
});

/* ---------- the 4.5 gate: Show it anyway (8 October 2026) ---------- */

describe("a held concept", () => {
  it("is left out of the client pack, and only an admin can show it anyway, which is logged", async () => {
    const { admin, projectId, ids } = await seed(["A", "B"]);
    await h.db.update(concept).set({ status: "held", failureReason: "scored 4.1 of the 4.5 needed; lowest: Pop and rhythm 3." }).where(eq(concept.id, ids.B!));

    // Not in the pack while held.
    expect((await buildClientPack(h.ctx, admin.viewer, projectId)).labels).toEqual(["A"]);

    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(showHeldConcept(h.ctx, pm.viewer, ids.B!)).rejects.toBeInstanceOf(PermissionError);
    await expect(showHeldConcept(h.ctx, admin.viewer, ids.A!)).rejects.toThrow(/isn't held/);

    await showHeldConcept(h.ctx, admin.viewer, ids.B!);
    const [b] = await h.db.select().from(concept).where(eq(concept.id, ids.B!));
    expect(b).toMatchObject({ status: "ready", failureReason: null });
    expect((await buildClientPack(h.ctx, admin.viewer, projectId)).labels).toEqual(["A", "B"]);

    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.concept_shown_anyway"));
    expect(logged!.valueBefore).toMatchObject({ concept: "B", held: "scored 4.1 of the 4.5 needed; lowest: Pop and rhythm 3." });
  });
});

/* ---------- the approved-section library (8 October 2026) ---------- */

const LIBRARY_PAGE = `<!doctype html><html><head><title>Example</title><style>
.hero{background:#1f4e79;color:#fff;padding:80px}.hero h1{font-size:56px}
.cards{display:grid;grid-template-columns:repeat(3,1fr)}.card{border-radius:16px}
@media (max-width:600px){.cards{grid-template-columns:1fr}}
:root{--brand:#1f4e79}
</style></head><body>
<header><a href="tel:+15305550199">(530) 555-0199</a></header>
<main>
<section class="hero"><h1>Example Well & Pump in Grass Valley</h1><img src="tawd-asset:photo-1" alt="The crew"><a href="tel:+15305550199">Call (530) 555-0199</a></section>
<section class="services"><h2>Our services</h2><div class="cards"><div class="card">Well drilling</div></div></section>
<section class="why"><h2>Why choose Example Well & Pump</h2><p>Email us at hello@examplewell.com</p></section>
<section><h2>Call us today</h2><p>Call (530) 555-0199.</p></section>
</main><footer>Example Well & Pump</footer></body></html>`;

describe("the approved-section library", () => {
  /*
    Off unless switched on (audit F-001, 12 November 2026): the scrub misses
    licence numbers, owners' names, customer quotes, prices and ratings, so
    one client's approved page must not reach another client's prompt.
  */
  it("is off by default: a client's pick adds nothing, nothing is seeded, and no build is shown another client's sections", async () => {
    const { admin, projectId, ids } = await seed(["A", "B"]);
    const [v] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids.B!));
    await r2.put(v!.htmlKey!, Buffer.from(LIBRARY_PAGE));
    await h.db.update(conceptVersion).set({ review: { passes: [{ pass: "after", average: 4.6 }] } }).where(eq(conceptVersion.id, v!.id));

    await recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.B!, channel: "phone", changesRequested: false, clientSaid: "B as it is." });
    expect(await h.db.select().from(sectionExample)).toHaveLength(0);
    expect(await seedSectionLibrary(h.db as Database, r2)).toBe(0);

    // Rows already stored from before the switch existed are never read while it is off.
    await h.db.insert(sectionExample).values({ projectId, conceptId: ids.B!, version: 1, bandIndex: 0, direction: "classic_trust", trade: "well_and_pump", kind: "hero", html: "<section><h1>Licence #123456, owner Sam Example</h1></section>", css: "", score: 46 });
    expect(await examplesFor(h.db as Database, "classic_trust")).toEqual([]);
  });

  it("copies an approved pick's sections, without the client's name, phone, email or photos, and a build is shown them", async () => {
    process.env.TAWD_SECTION_LIBRARY = "on";
    const { admin, ids } = await seed(["A", "B"]);
    const [v] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids.B!));
    await r2.put(v!.htmlKey!, Buffer.from(LIBRARY_PAGE));
    await h.db.update(conceptVersion).set({ review: { passes: [{ pass: "after", average: 4.6 }] } }).where(eq(conceptVersion.id, v!.id));

    await recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.B!, channel: "phone", changesRequested: false, clientSaid: "B as it is." });

    const rows = await h.db.select().from(sectionExample);
    expect(rows.map((r) => r.kind).sort()).toEqual(["contact", "hero", "services", "why"]);
    const hero = rows.find((r) => r.kind === "hero")!;
    expect(hero).toMatchObject({ direction: "classic_trust", trade: "well_and_pump", score: 46 });
    expect(hero.html).toContain("{Business} in Grass Valley");
    expect(hero.html).toContain("Call {Phone}");
    expect(hero.html).toContain("tel:{Phone}");
    expect(hero.html).not.toContain("tawd-asset:");
    expect(hero.css).toContain(".hero{background:#1f4e79");
    expect(hero.css).not.toContain("--brand");
    expect(rows.find((r) => r.kind === "why")!.html).toContain("{Email}");

    const shown = await examplesFor(h.db as Database, "classic_trust");
    expect(shown.map((r) => r.kind)).toEqual(["hero", "services", "why", "contact"]);
    const prompt = examplesSection(shown);
    expect(prompt).toContain("never take their words, names, numbers");
    expect(prompt).toContain('<approved_section n="1" kind="hero" direction="classic_trust">');

    // Adding the same version again adds nothing twice.
    expect(await addSectionExamples(h.db as Database, r2, ids.B!)).toBe(0);
    expect(await h.db.select().from(sectionExample)).toHaveLength(4);
  });

  it("starts from past picks scoring 4.0 or above, and goes with its project", async () => {
    process.env.TAWD_SECTION_LIBRARY = "on";
    const { admin, projectId, ids } = await seed(["A", "B"]);
    for (const [label, average] of [["A", 3.6], ["B", 4.4]] as const) {
      const [v] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, ids[label]!));
      await r2.put(v!.htmlKey!, Buffer.from(LIBRARY_PAGE));
      await h.db.update(conceptVersion).set({ review: { passes: [{ pass: "after", average }] } }).where(eq(conceptVersion.id, v!.id));
    }
    // A decision from before the library existed: changes asked, then the newest version kept.
    await h.db.insert(clientDecision).values({ projectId, conceptId: ids.B!, version: 2, channel: "phone", changesRequested: true, clientSaid: "B, greener", recordedByUserId: admin.viewer.id });

    expect(await seedSectionLibrary(h.db as Database, r2)).toBe(4);
    // Only once: a library with rows isn't seeded again.
    expect(await seedSectionLibrary(h.db as Database, r2)).toBe(0);

    await deleteProject(h.ctx, admin.viewer, projectId, { confirmName: "Dale Rowan", reason: "Client cancelled before the build" });
    expect(await h.db.select().from(sectionExample)).toHaveLength(0);
  });
});

/* ---------- deleting the project ---------- */

describe("deleting a project", () => {
  it("removes its comments, change requests and client decisions", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Pin", pinX: 1, pinY: 1 });
    await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: true });
    await recordClientDecision(h.ctx, admin.viewer, { conceptId: ids.B!, channel: "meeting", changesRequested: true, clientSaid: "Bigger" });

    // The change request is still queued, so deletion waits for it.
    const input = { confirmName: "Dale Rowan", reason: "Client cancelled before the build" };
    await expect(deleteProject(h.ctx, admin.viewer, projectId, input)).rejects.toThrow(ProjectDeleteError);
    await h.db.update(conceptChangeRequest).set({ status: "failed" }).where(eq(conceptChangeRequest.projectId, projectId));

    await deleteProject(h.ctx, admin.viewer, projectId, input);

    expect(await h.db.select().from(conceptComment)).toHaveLength(0);
    expect(await h.db.select().from(conceptChangeRequest)).toHaveLength(0);
    expect(await h.db.select().from(clientDecision)).toHaveLength(0);
  });
});

/* ---------- the words ---------- */

describe("the words", () => {
  it("describes a pin's position in terms of the page", () => {
    expect(describePinPosition(80, 3)).toBe("right, in the first screen, near the top (about 80% across and 3% down)");
    expect(describePinPosition(10, 95)).toMatch(/^left, near the bottom/);
  });

  it("tells the builder not to invent what a change asks for", () => {
    const prompt = buildSectionEditPrompt({
      kind: "changes",
      clientName: "Example Well & Pump",
      directionLabel: "Rugged Craftsman",
      request: describeChangeRequest({ source: "client", notes: "Add their license number", pins: [], general: [] }),
      sections: [{ index: 1, html: "<section><h1>Hi</h1></section>" }],
      factsKnown: "- Phone number: (530) 555-0199",
    });
    expect(prompt).toContain("Changes the client asked for");
    expect(prompt).toContain("[PLACEHOLDER");
  });

  it("History reads the new entries in plain words", () => {
    const people = new Map<string, string>();
    expect(
      describeChanges("mockups.changes_requested", {}, { concept: "B", baseVersion: 2, source: "team", notes: "Bigger phone", comments: 2 }, people),
    ).toEqual(["Concept B v2, from the team and 2 pinned comments", "Bigger phone"]);
    expect(
      describeChanges("mockups.client_decision", {}, { concept: "B", version: 3, channel: "phone call", changesRequested: false, clientSaid: "Loves it" }, people),
    ).toEqual(["Concept B v3, by phone call: approved as is", "Loves it"]);
  });
});

/* ---------- the homepage review fixes (2 October 2026) ---------- */

describe("comments tied to sections, Done or Not done, and the second try", () => {
  const BANDS = {
    passed: true,
    issues: [],
    stage: "cd_improve",
    heightPx: 3000,
    imageHeightPx: 3000,
    bands: [
      { top: 0, bottom: 600, label: "Header" },
      { top: 600, bottom: 1500, label: "Well drilling in Grass Valley" },
      { top: 1500, bottom: 3000, label: "Footer" },
    ],
  };

  function reviewWith(earlierNotes: { note: string; addressed: boolean }[]) {
    const answer = review(["A"], {}, false);
    answer.concepts[0]!.earlierNotes = earlierNotes as never;
    return answer;
  }

  it("keeps a pin's section, shows the editor the section with the pin drawn, and records Done or Not done", async () => {
    const { admin, projectId, ids } = await seed();
    await h.db.update(conceptVersion).set({ checks: BANDS }).where(eq(conceptVersion.conceptId, ids.A!));
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Make this link a button", pinX: 50, pinY: 35, band: 1 });
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    expect((await commentsOf(ids.A!)).find((c) => c.pinX !== null)!.band).toBe(1);

    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    expect((await commentsOf(ids.A!)).every((c) => c.tries === 1)).toBe(true);

    const { client, calls } = fakeClaude(() => [
      reviewWith([
        { note: "Make this link a button", addressed: true },
        { note: "Warmer photos overall", addressed: false },
      ]),
    ]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());

    // The general comment needs the locate call; the pin needs none, and its picture goes with the edit.
    expect(calls.map((c) => c.kind)).toEqual(["builder", "builder", "review"]);
    const edit = (calls[1]!.params.messages as { content: unknown }[])[0]!.content as { type: string; text?: string }[];
    expect(Array.isArray(edit)).toBe(true);
    expect(edit.filter((b) => b.type === "image")).toHaveLength(1);
    expect(edit.some((b) => b.text?.includes('Section 1 (<tawd-section id="1">), "Well drilling in Grass Valley": comment 1.'))).toBe(true);

    const rows = await commentsOf(ids.A!);
    const byBody = new Map(rows.map((r) => [r.body, r]));
    expect(byBody.get("Make this link a button")).toMatchObject({ outcome: "done", outcomeVersion: 3, resolvedAt: null });
    expect(byBody.get("Warmer photos overall")).toMatchObject({ outcome: "not_done", outcomeVersion: 3, resolvedAt: null });
    expect((await requestRow(requestId)).detail).toContain("1 of 2 comments done");
  });

  it("sends only the not-done comments again when asked, marked as a second try, and never a third time", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Bigger phone number in the header" });
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    const first = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    await runChangesJob(
      { requestId: first, conceptId: ids.A!, projectId },
      config,
      fakeClaude(() => [
        reviewWith([
          { note: "Bigger phone number in the header", addressed: true },
          { note: "Warmer photos overall", addressed: false },
        ]),
      ]).client,
      fakeBrowser(),
    );

    const second = await retryNotDone(h.ctx, admin.viewer, { conceptId: ids.A! });
    const after = new Map((await commentsOf(ids.A!)).map((r) => [r.body, r]));
    expect(after.get("Warmer photos overall")).toMatchObject({ changeRequestId: second, sentInVersion: 3, tries: 2 });
    expect(after.get("Bigger phone number in the header")!.changeRequestId).toBe(first);
    expect(queued.at(-1)).toMatchObject({ name: CHANGES_JOB, options: { jobId: changesJobId(second) } });

    const { client, calls } = fakeClaude(() => [reviewWith([{ note: "Warmer photos overall", addressed: false }])]);
    await runChangesJob({ requestId: second, conceptId: ids.A!, projectId }, config, client, fakeBrowser());
    expect(messagesText(calls.find((c) => c.kind === "builder")!.params)).toContain(
      "Warmer photos overall (Asked before and not done in v3: make sure this change is clearly visible this time.)",
    );
    expect(new Map((await commentsOf(ids.A!)).map((r) => [r.body, r])).get("Warmer photos overall")).toMatchObject({
      outcome: "not_done",
      outcomeVersion: 4,
      tries: 2,
    });

    // Two tries is the limit: nothing waits for a third.
    await expect(retryNotDone(h.ctx, admin.viewer, { conceptId: ids.A! })).rejects.toThrow(/No comment is waiting/);
  });

  it("a send that made nothing does not count as a try", async () => {
    const { admin, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Pin", pinX: 10, pinY: 10 });
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    expect((await commentsOf(ids.A!))[0]!.tries).toBe(1);
    await markChangesFailed(requestId, "The changes were not made.");
    expect((await commentsOf(ids.A!))[0]).toMatchObject({ tries: 0, changeRequestId: null });
  });

  it("estimates a round from the rounds so far, in cents rather than dollars", async () => {
    const { admin, projectId, runId, ids } = await seed();
    const guess = await estimateChanges(h.db);
    expect(guess.label).toMatch(/a first guess until a round has run/);
    expect(guess.cost).toBeLessThan(1);

    const id = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "x", includeComments: false });
    const during = new Date(Date.now() + 1_000);
    const call = { projectId, runId, conceptId: ids.A!, model: "claude-opus-5-5", createdAt: during };
    await h.db.insert(aiCall).values([
      { ...call, step: "changes", inputTokens: 10_000, outputTokens: 2_000 },
      // Its fix round counts too; another concept's call, or one outside the round, does not.
      { ...call, step: "fix", inputTokens: 10_000, outputTokens: 2_000 },
      { ...call, conceptId: ids.B!, step: "changes", inputTokens: 900_000, outputTokens: 900_000 },
      { ...call, step: "changes", createdAt: new Date(Date.now() + 60_000), inputTokens: 900_000, outputTokens: 900_000 },
    ]);
    await h.db
      .update(conceptChangeRequest)
      .set({ status: "done", finishedAt: new Date(Date.now() + 2_000) })
      .where(eq(conceptChangeRequest.id, id));
    const measured = await estimateChanges(h.db);
    expect(measured.label).toMatch(/from the 1 round so far/);
    // Two calls of 10,000 in and 2,000 out on Opus 5.5 ($0.08 each) plus one scoring pass, not the far-off calls.
    expect(measured.cost).toBeGreaterThan(0.16);
    expect(measured.cost).toBeLessThan(0.5);
  });

  it("keeps a pin's own section number when hidden sections are skipped, and on a second try when the sections match", () => {
    const latest = {
      version: 3,
      imageHeight: 3000,
      bands: [
        { top: 0, bottom: 600, label: "Header" },
        // A closed phone menu: no height, so not on the picture, but still section 1 to the editor.
        { top: 600, bottom: 600, label: "menu" },
        { top: 600, bottom: 1500, label: "Hero" },
        { top: 1500, bottom: 3000, label: "Services" },
      ],
    };
    const onImage = bandsOnImage(latest.bands, latest.imageHeight);
    expect(onImage.map((b) => b.index)).toEqual([0, 2, 3]);
    expect(bandIndexAt(80, onImage)).toBe(3);

    // A pin on the latest version: its kept section, or the one under it.
    expect(placePin({ version: 3, band: 3, y: 80 }, latest, onImage, undefined)).toEqual({ band: 3, yPx: 2400 });
    expect(placePin({ version: 3, band: null, y: 80 }, latest, onImage, undefined)).toEqual({ band: 3, yPx: 2400 });
    // The kept section has no height any more: placed by where it sits.
    expect(placePin({ version: 3, band: 1, y: 30 }, latest, onImage, undefined)).toEqual({ band: 2, yPx: 900 });

    // A pin on v2 (a second try): same sections, so the same section, at the same place within it.
    const v2 = { imageHeight: 2000, bands: [...latest.bands.slice(0, 3), { top: 1000, bottom: 2000, label: "Services" }] };
    expect(placePin({ version: 2, band: 3, y: 75 }, latest, onImage, v2)).toEqual({ band: 3, yPx: 2250 });
    // Different sections: measured instead, with no picture.
    expect(placePin({ version: 2, band: 3, y: 75 }, latest, onImage, { imageHeight: 2000, bands: v2.bands.slice(1) })).toEqual({
      band: null,
      yPx: null,
    });
  });

  it("a second try that fails keeps the comment's sent version, and it can be tried again", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    const first = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    await runChangesJob(
      { requestId: first, conceptId: ids.A!, projectId },
      config,
      fakeClaude(() => [reviewWith([{ note: "Warmer photos overall", addressed: false }])]).client,
      fakeBrowser(),
    );

    const second = await retryNotDone(h.ctx, admin.viewer, { conceptId: ids.A! });
    expect((await commentsOf(ids.A!))[0]).toMatchObject({ sentInVersion: 3, changeRequestId: second, tries: 2 });
    await markChangesFailed(second, "The changes were not made.");

    expect((await commentsOf(ids.A!))[0]).toMatchObject({ sentInVersion: 3, changeRequestId: null, tries: 1, outcome: "not_done" });
    // Not swallowed by the next ordinary round; it waits for Try again.
    expect(await openUnsentComments(h.db, ids.A!)).toHaveLength(0);
    await expect(retryNotDone(h.ctx, admin.viewer, { conceptId: ids.A! })).resolves.toBeTruthy();
  });

  it("numbers each comment as the screen does, in the notes and the review (Fable's A10)", async () => {
    const { admin, projectId, ids } = await seed();
    // Comment 1 was resolved earlier and never sent; only comment 2 goes in.
    const first = await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "An old note" });
    await setCommentResolved(h.ctx, admin.viewer, first, true);
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    const { client, calls } = fakeClaude(() => [reviewWith([])]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());
    expect(messagesText(calls.find((c) => c.kind === "review")!.params)).toContain("- (Comment 2) Warmer photos overall");
  });

  it("asks the Creative Director to copy each requested change word for word", async () => {
    const { admin, projectId, ids } = await seed();
    await addComment(h.ctx, admin.viewer, { conceptId: ids.A!, version: 2, body: "Warmer photos overall" });
    const requestId = await requestChanges(h.ctx, admin.viewer, { conceptId: ids.A!, notes: "", includeComments: true });
    const { client, calls } = fakeClaude(() => [reviewWith([])]);
    await runChangesJob({ requestId, conceptId: ids.A!, projectId }, config, client, fakeBrowser());
    const reviewText = messagesText(calls.find((c) => c.kind === "review")!.params);
    expect(reviewText).toContain("the note copied word for word");
    expect(reviewText).toContain("- (Comment 1) Warmer photos overall");
  });
});
