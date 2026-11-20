import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  activityLog,
  aiCall,
  concept,
  conceptStep,
  conceptVersion,
  mockupRun,
  pipelineSteps,
} from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";
import { runCosts } from "@/lib/mockups";
import { describeChanges } from "@/lib/timeline-text";
import { DESIGNER_CONCEPT, getModelConfig } from "@tawd/core/mockups";

// The worker's own code, run against the test database with a scripted
// stand-in for Claude and a minimal stand-in for Chromium.
import { markReviewFailed, runReviewJob } from "../../../worker/src/review";
import { sourceKeyFor } from "../../../worker/src/pipeline";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, PAGE, fakeBrowser, fakeClaude, messageText, messagesText, review, turn } from "./worker-fakes";

/*
  The Creative Director, end to end.

  What these prove is the part that must never go wrong: the sequence is
  bounded. One review, one improvement round, one re-score, at most one
  rebuild, and then a flag for the PM - never a loop, whatever the reviewer
  says. And every call lands in the ledger with its step.
*/

/* ---------- setup ---------- */

let h: Harness;
let r2: FakeR2;

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
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

async function seedRun(labels: string[], checksFor: Record<string, unknown> = {}) {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Dale Rowan",
    trade: "well_and_pump",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: labels.length,
    status: "mockups",
    memberUserIds: [],
  });
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
      status: "running",
      model: "claude-opus-5-5",
      startedByUserId: admin.viewer.id,
    })
    .returning();

  const directions = ["rugged_craftsman", "classic_trust", "warm_local"];
  const skills = ["impeccable", "ui_ux_pro_max", "taste"];
  const ids: Record<string, string> = {};

  for (const [index, label] of labels.entries()) {
    const [row] = await h.db
      .insert(concept)
      .values({
        runId: run!.id,
        projectId,
        label,
        direction: directions[index]!,
        skillId: skills[index]!,
        status: "ready",
      })
      .returning();
    ids[label] = row!.id;

    await h.db.insert(conceptStep).values(
      pipelineSteps.map((step) => ({
        conceptId: row!.id,
        step,
        status: step === "build" || step === "checks" ? "done" : "waiting",
      })),
    );

    const base = `projects/${projectId}/concepts/${row!.id}/v1`;
    await h.db.insert(conceptVersion).values({
      conceptId: row!.id,
      version: 1,
      htmlKey: `${base}/page.html`,
      pngKey: `${base}/full.png`,
      foldPngKey: `${base}/fold.png`,
      checks: checksFor[label] ?? { passed: true, issues: [], stage: "build" },
    });
    await r2.put(`${base}/page.html`, Buffer.from(PAGE));
    await r2.put(`${base}/source.html`, Buffer.from(PAGE));
  }

  return { admin, projectId, runId: run!.id, ids };
}

/* The text of the user message a call ended with. */
function lastUserText(params: Record<string, unknown>): string {
  const last = (params.messages as { content: unknown }[]).at(-1)!;
  return typeof last.content === "string"
    ? last.content
    : (last.content as { text?: string }[]).map((b) => b.text ?? "").join("");
}

async function runStatus(runId: string) {
  const [row] = await h.db.select().from(mockupRun).where(eq(mockupRun.id, runId));
  return row!;
}

async function versionsOf(conceptId: string) {
  return h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
}

/* ---------- the tests ---------- */

describe("the Creative Director review", () => {
  it("reviews each concept in its own call, improves once, re-scores, and succeeds", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    const first = review(["A", "B"], { A: { 1: 3 }, B: { 7: 3 } });
    const after = review(["A", "B"], {}, false);
    // Calls in order: first A, first B, then the re-scores of A and B.
    const { client, calls } = fakeClaude(() => [first, first, after, after]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const reviewCalls = calls.filter((c) => c.kind === "review");
    const builderCalls = calls.filter((c) => c.kind === "builder");
    // One call per concept for the first score, and one each to re-score.
    expect(reviewCalls).toHaveLength(4);
    // One improvement round per concept with notes, and no rebuild.
    expect(builderCalls).toHaveLength(2);

    // Each call scores one concept at full size, with the other small.
    const firstContent = (reviewCalls[0]!.params.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
    const text = firstContent.map((b) => b.text ?? "").join("\n");
    expect(text).toContain("Score only: Concept A.");
    expect(text).toContain("Concept B (for comparison only): its first screen, small.");
    expect(text).toContain("do not score them");
    // Its own first screen and page slices, plus one small image of B.
    expect(firstContent.filter((b) => b.type === "image").length).toBeGreaterThanOrEqual(3);
    // Plenty of room for eight questions and notes in one answer.
    expect(reviewCalls[0]!.params.max_tokens).toBe(32_000);

    // Before on v1, after on v2 (the improved version).
    const a = await versionsOf(ids.A!);
    expect(a.map((v) => v.version).sort()).toEqual([1, 2]);
    const v1 = a.find((v) => v.version === 1)!.review as { passes: { pass: string }[] };
    const v2 = a.find((v) => v.version === 2)!;
    expect(v1.passes.map((p) => p.pass)).toEqual(["first"]);
    expect((v2.review as { passes: { pass: string }[] }).passes.map((p) => p.pass)).toEqual(["after"]);
    expect((v2.checks as { stage: string }).stage).toBe("cd_improve");

    expect((await runStatus(runId)).status).toBe("succeeded");
  });

  it("stores the score and notes for every question, before and after", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    const { client } = fakeClaude(() => [
      review(["A", "B"], { A: { 3: 3 } }),
      review(["A", "B"], { A: { 3: 5 } }, false),
    ]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const all = await versionsOf(ids.A!);
    const passes = all.flatMap((v) => ((v.review as { passes?: unknown[] } | null)?.passes ?? []) as {
      pass: string;
      questions: { question: number; score: number; notes: unknown[] }[];
    }[]);
    const first = passes.find((p) => p.pass === "first")!;
    const after = passes.find((p) => p.pass === "after")!;
    expect(first.questions).toHaveLength(11);
    expect(first.questions.find((q) => q.question === 3)).toMatchObject({ score: 3 });
    expect(first.questions.find((q) => q.question === 3)!.notes).toHaveLength(1);
    expect(after.questions.find((q) => q.question === 3)).toMatchObject({ score: 5 });
  });

  // Jason, 8 October 2026: shown only at 4.5 or above; one rewrite, never a rebuild; under that, held.
  it("holds a concept still under 4.5 after one rewrite - no rebuild, never a loop - and shows the other", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    // The reviewer never relents on B's conversion path; A comes back clean after its rewrite.
    const first = review(["A", "B"], { B: { 4: 2 } });
    const after = review(["A", "B"], { B: { 4: 2 } }, false);
    // Calls in order: first A, first B, then the re-scores of A (clean) and B (still 2 on question 4).
    const { client, calls } = fakeClaude(() => [first, first, after, after]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    // A first and after, B first and after: no rebuild pass.
    expect(calls.filter((c) => c.kind === "review")).toHaveLength(4);
    // Two rewrites (A and B), no rebuild.
    expect(calls.filter((c) => c.kind === "builder")).toHaveLength(2);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "rebuild"))).toHaveLength(0);

    const [a] = await h.db.select().from(concept).where(eq(concept.id, ids.A!));
    const [b] = await h.db.select().from(concept).where(eq(concept.id, ids.B!));
    expect(a!.status).toBe("ready");
    expect(b!.status).toBe("held");
    expect(b!.failureReason).toMatch(/^scored 4\.7 of the 4\.5 needed, but a question is under 3; lowest: Conversion path 2/);

    const steps = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.B!));
    const finalChecks = steps.find((s) => s.step === "final_checks")!;
    expect(finalChecks.status).toBe("failed");
    expect(finalChecks.detail).toMatch(/^Held: scored/);

    // A was shown, so the run isn't a failure; B waits for an admin.
    expect((await runStatus(runId)).status).not.toBe("failed");
  });

  it("shows a concept at 4.5 or above on its first score with no rewrite at all", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client, calls } = fakeClaude(() => [review(["A"], { A: { 3: 4 } }, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());
    expect(calls.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "builder")).toHaveLength(0);
    const [a] = await h.db.select().from(concept).where(eq(concept.id, ids.A!));
    expect(a!.status).toBe("ready");
    const steps = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.A!));
    expect(steps.find((s) => s.step === "improve")).toMatchObject({ status: "skipped" });
  });

  it("holds every concept and says so when none reaches 4.5", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], { A: { 7: 2 } })]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());
    const [a] = await h.db.select().from(concept).where(eq(concept.id, ids.A!));
    expect(a!.status).toBe("held");
    expect((await runStatus(runId)).status).toBe("needs_pm_review");
  });

  it("marks direction fit not applicable in a one-concept run, and leaves it out of the average", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    // The reviewer scores question 2 anyway, low; it must be ignored.
    const { client, calls } = fakeClaude(() => [
      review(["A"], { A: { 2: 1, 1: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 4, 10: 4, 11: 4 } }, false),
    ]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    // The 1 on question 2 does not count; the 4s are under 4.5, so one rewrite (never a rebuild).
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "rebuild"))).toHaveLength(0);

    const [v1] = await versionsOf(ids.A!);
    const first = (v1!.review as { passes: { questions: { question: number; notApplicable: boolean; score: number | null }[]; average: number }[] }).passes[0]!;
    expect(first.questions.find((q) => q.question === 2)).toMatchObject({
      notApplicable: true,
      score: null,
    });
    expect(first.average).toBe(4);

    // And the reviewer was told so up front.
    const text = (
      (calls[0]!.params.messages as { content: { type: string; text?: string }[] }[])[0]!.content
    )
      .map((b) => b.text ?? "")
      .join("\n");
    expect(text).toContain("There is only one concept in this run");
  });

  it("keeps safety advice apart, for the content team, rather than as fact", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], {}, false, { safety: true })]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const [v1] = await versionsOf(ids.A!);
    const first = (v1!.review as { passes: { safetyAdvice: { text: string }[] }[] }).passes[0]!;
    expect(first.safetyAdvice[0]!.text).toMatch(/shut-off valve/);

    // The reviewer's instructions forbid adding facts.
    const system = (await import("@tawd/core/mockups")).buildReviewerSystemPrompt("cd", "profile");
    expect(system).toContain("You never add facts");
    expect(system).toContain("safetyAdvice");
  });

  it("keeps Concept A's review when Concept B's fails, and retries only B, once", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    // Every answer is about Concept A only, so Concept B's call never works.
    const { client, calls } = fakeClaude(() => [review(["A"])]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const reviewCalls = calls.filter((c) => c.kind === "review");
    const scored = reviewCalls.map((c) =>
      /Score only: Concept (\w)\./.exec(
        ((c.params.messages as { content: { text?: string }[] }[])[0]!.content).map((b) => b.text ?? "").join(""),
      )?.[1],
    );
    // A once, B twice (one retry), then only A is re-scored.
    expect(scored).toEqual(["A", "B", "B", "A"]);

    // A went through the whole review; B kept its built version.
    const a = await versionsOf(ids.A!);
    expect(a.flatMap((v) => ((v.review as { passes?: { pass: string }[] } | null)?.passes ?? []).map((p) => p.pass)).sort()).toEqual([
      "after",
      "first",
    ]);
    const b = await versionsOf(ids.B!);
    expect(b).toHaveLength(1);
    expect((b[0]!.review as { failed?: { pass: string; reason: string } }).failed).toMatchObject({
      pass: "first",
      reason: expect.stringMatching(/left out Concept B/),
    });

    const run = await runStatus(runId);
    expect(run.status).toBe("review_incomplete");
    expect(run.failureReason).toMatch(/^Concept B: The review could not be used: .*left out Concept B/);

    const steps = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.B!));
    expect(steps.find((s) => s.step === "review")!.detail).toMatch(/^Review didn't finish: /);
  });

  // B4 (audit F-017): a perfect score does not show a concept that still breaks a house rule.
  it("holds a concept that still breaks a house rule after its fix rounds, whatever its score", async () => {
    const invented = { id: "house.phone.invented", severity: "fail", evidence: "(916) 555-0000", message: "not the intake's" };
    const { runId, projectId, ids } = await seedRun(["A", "B"], { B: { passed: false, issues: [invented], stage: "build" } });
    // A clean 5.0 for both: no rewrite, so B's newest version is the one with the invented phone number.
    const { client } = fakeClaude(() => [review(["A", "B"], {}, false)]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const [a] = await h.db.select().from(concept).where(eq(concept.id, ids.A!));
    const [b] = await h.db.select().from(concept).where(eq(concept.id, ids.B!));
    expect(a!.status).toBe("ready");
    expect(b!.status).toBe("held");
    expect(b!.failureReason).toBe("breaks a house rule: a phone number not in the intake.");
  });

  it("Run the review again reviews only the concept that is missing one, and never builds twice", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    // First time round, B's call keeps failing; A is fully reviewed.
    const broken = fakeClaude(() => [review(["A"])]);
    await runReviewJob({ runId, projectId }, config, broken.client, fakeBrowser());
    expect((await runStatus(runId)).status).toBe("review_incomplete");
    // B4: a concept with no review is not shown as ready; it waits for the review to be run again.
    const [unreviewed] = await h.db.select().from(concept).where(eq(concept.id, ids.B!));
    expect(unreviewed!.status).toBe("held");
    expect(unreviewed!.failureReason).toMatch(/^wasn't reviewed: the review didn't finish \(.+\)\. Run the review again\.$/);

    const fixed = fakeClaude(() => [review(["A", "B"], { B: { 1: 3 } }), review(["A", "B"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, fixed.client, fakeBrowser());

    const scored = fixed.calls
      .filter((c) => c.kind === "review")
      .map((c) =>
        /Score only: Concept (\w)\./.exec(
          ((c.params.messages as { content: { text?: string }[] }[])[0]!.content).map((b) => b.text ?? "").join(""),
        )?.[1],
      );
    // Only B: its first score, then its re-score. A is not paid for again.
    expect(scored).toEqual(["B", "B"]);
    // B's one improvement round; no build, no rebuild.
    expect(fixed.calls.filter((c) => c.kind === "builder")).toHaveLength(1);
    const steps = (await h.db.select().from(aiCall).where(eq(aiCall.runId, runId))).map((c) => c.step);
    expect(steps).not.toContain("build");
    expect(steps).not.toContain("rebuild");

    const b = await versionsOf(ids.B!);
    expect(b.flatMap((v) => ((v.review as { passes?: { pass: string }[] } | null)?.passes ?? []).map((p) => p.pass)).sort()).toEqual([
      "after",
      "first",
    ]);
    expect((await runStatus(runId)).status).toBe("succeeded");
    // Reviewed now, and it passed: the hold is lifted.
    const [reviewed] = await h.db.select().from(concept).where(eq(concept.id, ids.B!));
    expect(reviewed!.status).toBe("ready");
    expect(reviewed!.failureReason).toBeNull();
  });

  it("Run the review again holds a concept still under 4.5 instead of rebuilding it", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const broken = fakeClaude(() => ["not json"]);
    await runReviewJob({ runId, projectId }, config, broken.client, fakeBrowser());

    // The reviewer never relents on the conversion path.
    const stubborn = fakeClaude(() => [review(["A"], { A: { 4: 2 } })]);
    await runReviewJob({ runId, projectId, retry: true }, config, stubborn.client, fakeBrowser());

    const ledger = (await h.db.select().from(aiCall).where(eq(aiCall.runId, runId))).map((c) => c.step);
    expect(ledger).not.toContain("rebuild");
    const [a] = await h.db.select().from(concept).where(eq(concept.id, ids.A!));
    expect(a!.status).toBe("held");
    const finalChecks = (await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.A!))).find(
      (s) => s.step === "final_checks",
    )!;
    expect(finalChecks.detail).toMatch(/^Held: /);
    expect((await runStatus(runId)).status).toBe("needs_pm_review");
  });

  it("Run the review again only re-scores a concept that was already improved", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    // The first score and the improvement worked; only the re-score failed.
    const partly = fakeClaude(() => [review(["A"], { A: { 1: 3 } }), "not json"]);
    await runReviewJob({ runId, projectId }, config, partly.client, fakeBrowser());
    const before = await versionsOf(ids.A!);
    expect(before.length).toBeGreaterThan(1);

    const rescore = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, rescore.client, fakeBrowser());
    expect(rescore.calls.map((c) => c.kind)).toEqual(["review"]);
    expect((await versionsOf(ids.A!)).length).toBe(before.length);
    expect((await runStatus(runId)).status).toBe("succeeded");
  });

  it("still marks the whole run when the review job itself fails", async () => {
    const { runId } = await seedRun(["A"]);
    await markReviewFailed(runId, "Something outside the reviewer broke.");
    const run = await runStatus(runId);
    expect(run.status).toBe("review_incomplete");
    expect(run.failureReason).toBe("Something outside the reviewer broke.");
  });

  it("does nothing if the run was stopped before the review started", async () => {
    const { runId, projectId } = await seedRun(["A"]);
    await h.db.update(mockupRun).set({ status: "stopped" }).where(eq(mockupRun.id, runId));
    const { client, calls } = fakeClaude(() => [review(["A"])]);

    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());
    expect(calls).toHaveLength(0);
    expect((await runStatus(runId)).status).toBe("stopped");
  });
});

describe("the ledger", () => {
  it("records every call with its step, and charges each review call to its concept", async () => {
    const { runId, projectId, ids } = await seedRun(["A", "B"]);
    const first = review(["A", "B"], { A: { 1: 3 } });
    const after = review(["A", "B"], {}, false);
    const { client } = fakeClaude(() => [first, first, after, after]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const rows = await h.db.select().from(aiCall).where(eq(aiCall.runId, runId));
    const reviews = rows.filter((r) => r.step === "review");
    expect(reviews).toHaveLength(4);
    expect(reviews.filter((r) => r.conceptId === ids.A)).toHaveLength(2);
    expect(reviews.filter((r) => r.conceptId === ids.B)).toHaveLength(2);
    expect(rows.filter((r) => r.step === "improve")).toHaveLength(2);

    const config55 = { ...getModelConfig(), inputPricePerMTok: 4, outputPricePerMTok: 20 };
    const costs = (await runCosts([runId], config55)).get(runId)!;
    const a = costs.perConcept.get(ids.A!)!;
    const b = costs.perConcept.get(ids.B!)!;
    // Each concept carries its own improve call and its own two reviews.
    expect(a.inputTokens).toBe(10_000 + 2 * 30_000);
    expect(b.inputTokens).toBe(10_000 + 2 * 30_000);
    expect(a.cost + b.cost).toBeCloseTo(costs.total);
  });

  it("outlives the project it describes", async () => {
    const { admin, runId, projectId } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());
    const before = await h.db.select().from(aiCall).where(eq(aiCall.projectId, projectId));
    expect(before.length).toBeGreaterThan(0);

    await deleteProject(h.ctx, admin.viewer, projectId, {
      confirmName: "Dale Rowan",
      reason: "Test project, no longer needed",
    });

    const after = await h.db.select().from(aiCall).where(eq(aiCall.projectId, projectId));
    expect(after).toHaveLength(before.length);
  });
});

/*
  Every answer the model gives is paid for, so it is kept before anything
  reads it, and "Run the review again" reads what was kept before it pays
  for anything new.
*/
describe("keeping every paid answer", () => {
  it("saves every review and builder answer in the project's folder, and the ledger points to it", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], { A: { 1: 3 } }), review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const rows = await h.db.select().from(aiCall).where(eq(aiCall.runId, runId));
    expect(rows.map((r) => r.step).sort()).toEqual(["improve", "review", "review"]);
    const [v1] = (await versionsOf(ids.A!)).filter((v) => v.version === 1);

    for (const row of rows) {
      expect(row.responseKey).toBe(`projects/${projectId}/ai-responses/${row.id}.json`);
      const saved = JSON.parse(r2.objects.get(row.responseKey!)!.toString("utf8"));
      expect(saved).toMatchObject({ callId: row.id, step: row.step, conceptId: ids.A, model: "claude-opus-5-5" });
      expect(saved.turns[0].content[0].type).toBe("text");
    }
    const firstScore = rows.find((r) => r.step === "review" && r.round === 1)!;
    const saved = JSON.parse(r2.objects.get(firstScore.responseKey!)!.toString("utf8"));
    expect(saved).toMatchObject({ versionId: v1!.id, label: "A", round: 1 });
  });

  it("keeps working, and still charges the call, when the answer cannot be saved", async () => {
    const { runId, projectId } = await seedRun(["A"]);
    const put = r2.put.bind(r2);
    r2.put = async (key: string, body: Buffer) => {
      if (key.includes("/ai-responses/")) throw new Error("R2 is down");
      return put(key, body);
    };
    const { client } = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    expect((await runStatus(runId)).status).toBe("succeeded");
    const rows = await h.db.select().from(aiCall).where(eq(aiCall.runId, runId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.responseKey === null)).toBe(true);
  });

  it(`uses an answer labeled "Concept A" at once, with no second call (ABC Plumbers)`, async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const labeled = review(["A"], {}, false);
    labeled.concepts[0]!.label = "Concept A";
    const { client, calls } = fakeClaude(() => [labeled]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    // One call, no retry: a clean first score at 4.5 or above needs no rewrite or re-score.
    expect(calls.filter((c) => c.kind === "review")).toHaveLength(1);
    expect((await runStatus(runId)).status).toBe("succeeded");
    const [v1] = await versionsOf(ids.A!);
    const first = (v1!.review as { passes: { pass: string; readAs?: string[] }[] }).passes.find((p) => p.pass === "first")!;
    expect(first.readAs).toEqual([`the label "Concept A" read as A`]);
    // And each call is asked for its own letter.
    const format = (calls[0]!.params.output_config as { format: { schema: Record<string, unknown> } }).format;
    const items = (format.schema.properties as { concepts: { items: { properties: { label: unknown } } } }).concepts.items;
    expect(items.properties.label).toEqual({ type: "string", enum: ["A"] });
  });

  it("retries once, saying exactly what was wrong rather than asking the same thing again", async () => {
    const { runId, projectId } = await seedRun(["A", "B"]);
    const { client, calls } = fakeClaude(() => [review(["A"])]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const retryOfB = calls.filter((c) => c.kind === "review")[2]!;
    const hint = lastUserText(retryOfB.params);
    expect(hint).toContain(`The answer's entries were labeled "A", but this call reviews Concept B.`);
    expect(hint).toContain(`set label to exactly "B"`);
  });

  it("gives an answer that ran out of room twice the room on its retry", async () => {
    const { runId, projectId } = await seedRun(["A"]);
    const { client, calls } = fakeClaude(() => [turn(`{"concepts": [`, "max_tokens"), review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const reviews = calls.filter((c) => c.kind === "review");
    expect(reviews[0]!.params.max_tokens).toBe(32_000);
    expect(reviews[1]!.params.max_tokens).toBe(64_000);
    expect(lastUserText(reviews[1]!.params)).toContain("ran out of room");
    expect((await runStatus(runId)).status).toBe("succeeded");
  });

  it("charges and saves a builder answer that was refused, though it was never used", async () => {
    const { runId, projectId } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], { A: { 1: 3 } })], {
      builder: () => turn("I can't help with that.", "refusal"),
    });
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser()).catch(() => undefined);

    const [improve] = await h.db.select().from(aiCall).where(eq(aiCall.step, "improve"));
    expect(improve).toMatchObject({ runId, inputTokens: 10_000 });
    const saved = JSON.parse(r2.objects.get(improve!.responseKey!)!.toString("utf8"));
    expect(saved.turns[0]).toMatchObject({ stopReason: "refusal" });
  });

  /* The re-score failed; later, the reader learns to read that answer. */
  async function rescoreFailed() {
    const seeded = await seedRun(["A"]);
    const partly = fakeClaude(() => [review(["A"], { A: { 1: 3 } }), "Sorry, no review this time."]);
    await runReviewJob({ runId: seeded.runId, projectId: seeded.projectId }, config, partly.client, fakeBrowser());
    expect((await runStatus(seeded.runId)).status).toBe("review_incomplete");

    const failed = await h.db.select().from(aiCall).where(eq(aiCall.round, 2));
    expect(failed).toHaveLength(2);
    // Answers that a better reader can now make sense of.
    for (const row of failed) {
      const saved = JSON.parse(r2.objects.get(row.responseKey!)!.toString("utf8"));
      saved.turns[0].content[0].text = `Here is my review:\n${JSON.stringify(review(["A"], {}, false))}`;
      await r2.put(row.responseKey!, Buffer.from(JSON.stringify(saved)));
    }
    return { ...seeded, failed };
  }

  /*
    CodeRabbit on PR #75 (12 November 2026), checked against the code
    first. An Option B run has the designer's concept and one alternative;
    the designer's never takes this review, so the first and after passes
    saw ONE concept and marked Direction fit "Not applicable: this run has
    only one concept to compare", while polish and changes - which count
    the whole run - required a score. All four now count the run.
  */
  async function optionBRun() {
    const seeded = await seedRun(["A", "B"]);
    await h.db.update(concept).set({ skillId: DESIGNER_CONCEPT }).where(eq(concept.id, seeded.ids.A!));
    return seeded;
  }
  const directionFit = async (conceptId: string, stage: string) =>
    (await versionsOf(conceptId))
      .flatMap((v) => ((v.review as { passes?: { pass: string; questions: { question: number; notApplicable: boolean; score: number | null; reason: string }[] }[] } | null)?.passes ?? []))
      .find((p) => p.pass === stage)!
      .questions.find((q) => q.question === 2)!;

  it("counts the whole run for Direction fit on an Option B run, and says the other concept is not shown", async () => {
    const { runId, projectId, ids } = await optionBRun();
    const { client, calls } = fakeClaude(() => [review(["B"], { B: { 1: 3 } }), review(["B"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    expect(await directionFit(ids.B!, "first")).toMatchObject({ notApplicable: false, score: 4 });
    expect(await directionFit(ids.B!, "after")).toMatchObject({ notApplicable: false, score: 5 });
    const prompt = messagesText(calls.find((c) => c.kind === "review")!.params);
    expect(prompt).toContain("not shown in this pass");
    expect(prompt).not.toContain("small first-screen images");
    expect(prompt).not.toContain("only one concept in this run");
  });

  it("Run the review again still reads a saved answer that left Direction fit unscored, with no new call", async () => {
    const { runId, projectId, ids } = await optionBRun();
    const partly = fakeClaude(() => [review(["B"], { B: { 1: 3 } }), "Sorry, no review this time."]);
    await runReviewJob({ runId, projectId }, config, partly.client, fakeBrowser());
    expect((await runStatus(runId)).status).toBe("review_incomplete");

    // The answers paid for, as the reviewer gave them when this pass counted one concept: question 2 null.
    for (const row of await h.db.select().from(aiCall).where(eq(aiCall.round, 2))) {
      const saved = JSON.parse(r2.objects.get(row.responseKey!)!.toString("utf8"));
      const answer = review(["B"], {}, false) as { concepts: { questions: { question: number; score: number | null; reason: string }[] }[] };
      Object.assign(answer.concepts[0]!.questions.find((q) => q.question === 2)!, { score: null, reason: "Not applicable" });
      saved.turns[0].content[0].text = JSON.stringify(answer);
      await r2.put(row.responseKey!, Buffer.from(JSON.stringify(saved)));
    }
    const again = fakeClaude(() => [review(["B"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());

    expect(again.calls).toHaveLength(0);
    expect(await directionFit(ids.B!, "after")).toMatchObject({
      notApplicable: true,
      score: null,
      reason: "Not scored in the saved answer this was read from.",
    });
  });

  it("Run the review again reads an answer already paid for, and makes no new call", async () => {
    const { runId, projectId, ids } = await rescoreFailed();
    const again = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());

    expect(again.calls).toHaveLength(0);
    expect((await runStatus(runId)).status).toBe("succeeded");
    const passes = (await versionsOf(ids.A!)).flatMap(
      (v) => (v.review as { passes?: { pass: string; readAs?: string[] }[] } | null)?.passes ?? [],
    );
    expect(passes.find((p) => p.pass === "after")!.readAs).toEqual([
      "the JSON read from inside surrounding text",
      "read again from the saved answer, with no new call",
    ]);
  });

  it("never moves a saved score onto a page it did not see", async () => {
    const { runId, projectId, failed } = await rescoreFailed();
    for (const row of failed) {
      const saved = JSON.parse(r2.objects.get(row.responseKey!)!.toString("utf8"));
      saved.versionId = crypto.randomUUID();
      await r2.put(row.responseKey!, Buffer.from(JSON.stringify(saved)));
    }
    const again = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());
    expect(again.calls.map((c) => c.kind)).toEqual(["review"]);
  });

  it("Run the review again only re-scores when fix rounds followed the improvement", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const partly = fakeClaude(() => [review(["A"], { A: { 1: 3 } }), "not json"]);
    await runReviewJob({ runId, projectId }, config, partly.client, fakeBrowser());
    // A fix version after the improved one: the newest is not the improved one.
    const newest = (await versionsOf(ids.A!)).sort((x, y) => y.version - x.version)[0]!;
    await h.db.insert(conceptVersion).values({
      conceptId: ids.A!,
      version: newest.version + 1,
      htmlKey: newest.htmlKey,
      pngKey: newest.pngKey,
      foldPngKey: newest.foldPngKey,
      checks: { passed: true, issues: [], stage: "fix" },
    });

    const again = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());
    expect(again.calls.map((c) => c.kind)).toEqual(["review"]);
    expect((await runStatus(runId)).status).toBe("succeeded");
  });

  it("Run the review again runs the free checks again first, clearing an old false alarm, and logs it", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const broken = fakeClaude(() => ["not json"]);
    await runReviewJob({ runId, projectId }, config, broken.client, fakeBrowser());
    // What an older checker said about the same page.
    const stale = { id: "house.phone.invented", severity: "fail", message: "An invented phone number" };
    await h.db
      .update(conceptVersion)
      .set({ checks: { passed: false, issues: [stale], stage: "build" } })
      .where(eq(conceptVersion.conceptId, ids.A!));

    const again = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());

    const [v1] = await versionsOf(ids.A!);
    expect(v1!.checks).toMatchObject({ passed: true, issues: [], stage: "build", recheckedAt: expect.any(String) });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.checks_rerun"));
    expect(logged!.valueAfter).toEqual({ concepts: [{ concept: "A", before: 1, after: 0, codeFixes: [] }] });
    expect(describeChanges("mockups.checks_rerun", null, logged!.valueAfter, new Map())).toEqual([
      "Concept A: 1 failing before, 0 now",
    ]);
    expect(
      describeChanges(
        "mockups.checks_rerun",
        null,
        { concepts: [{ concept: "B", before: 2, after: 0, codeFixes: ["contrast"] }] },
        new Map(),
      ),
    ).toEqual(["Concept B: 2 failing before, 0 now; fixed by code: contrast"]);
  });

  it("leaves an old version with no kept source unchecked, rather than judging a broken page", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const broken = fakeClaude(() => ["not json"]);
    await runReviewJob({ runId, projectId }, config, broken.client, fakeBrowser());
    const [v1] = await versionsOf(ids.A!);
    await r2.remove(v1!.htmlKey!.replace(/page\.html$/, "source.html"));

    const again = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId, retry: true }, config, again.client, fakeBrowser());
    const [after] = await versionsOf(ids.A!);
    expect((after!.checks as { recheckedAt?: string }).recheckedAt).toBeUndefined();
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "mockups.checks_rerun"))).toHaveLength(0);
  });

  it("goes with the project when it is deleted, while the spend stays", async () => {
    const { admin, runId, projectId } = await seedRun(["A"]);
    const { client } = fakeClaude(() => [review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());
    expect([...r2.objects.keys()].some((k) => k.includes("/ai-responses/"))).toBe(true);

    await deleteProject(h.ctx, admin.viewer, projectId, {
      confirmName: "Dale Rowan",
      reason: "Test project, no longer needed",
    });

    expect([...r2.objects.keys()].some((k) => k.includes("/ai-responses/"))).toBe(false);
    const rows = await h.db.select().from(aiCall).where(eq(aiCall.projectId, projectId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.responseKey === null)).toBe(true);
  });
});

/*
  The improvement round edits only the bands the notes are about (Jason,
  25 September 2026): the reviewer sees the bands numbered, each note names
  one, and only those go to the AI and come back.
*/
describe("improving part by part", () => {
  /* What the call was asked: its first message (the reply is appended to the same list afterwards). */
  const promptOf = (params: Record<string, unknown>) => {
    const first = (params.messages as { content: unknown }[])[0]!;
    return messageText(first.content);
  };

  /* A first score with notes on every question, all about `band`. */
  function notesOn(band: number | undefined, section = "Hero") {
    const first = review(["A"], { A: { 1: 3 } });
    for (const q of first.concepts[0]!.questions) {
      q.notes = q.notes.map((n) => ({ ...n, section, ...(band === undefined ? {} : { band }) }));
    }
    return first;
  }

  async function improvedSource(conceptId: string): Promise<string> {
    const improved = (await versionsOf(conceptId)).find((v) => (v.checks as { stage?: string }).stage === "cd_improve")!;
    return r2.objects.get(sourceKeyFor(improved.htmlKey!))!.toString("utf8");
  }

  it("shows the reviewer the bands numbered, and sends only the band the notes name", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client, calls } = fakeClaude(() => [notesOn(2), review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const reviewPrompt = JSON.stringify(calls.find((c) => c.kind === "review")!.params.messages);
    expect(reviewPrompt).toContain("<!-- band 0 -->");
    expect(reviewPrompt).toContain("<!-- band 2 -->");

    const builders = calls.filter((c) => c.kind === "builder");
    expect(builders).toHaveLength(1);
    const prompt = promptOf(builders[0]!.params);
    expect(prompt).toContain(`<tawd-section id="2">`);
    expect(prompt).toContain("Call me back");
    expect(prompt).not.toContain("<h1");
    expect(prompt).not.toContain("<!doctype");
    // No skill tools and a smaller ceiling for an edit.
    expect(builders[0]!.params.tools).toBeUndefined();
    expect(builders[0]!.params.max_tokens).toBe(32_000);

    // Only the form changed; the rest of the page is as it was.
    const page = await improvedSource(ids.A!);
    expect(page).toContain("<form data-edited>");
    expect(page).toContain("<h1>Well drilling in Grass Valley</h1>");
    expect(page).toContain(`<a href="tel:+15305550199">`);

    const ledger = await h.db.select().from(aiCall).where(eq(aiCall.step, "improve"));
    expect(ledger.map((c) => c.scope)).toEqual(["sections"]);
    expect((await runStatus(runId)).status).toBe("succeeded");
  });

  it("finds the band with one small call when a note does not say, then edits only that", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client, calls } = fakeClaude(() => [notesOn(undefined, "Trust signals"), review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const builders = calls.filter((c) => c.kind === "builder").map((c) => promptOf(c.params));
    expect(builders).toHaveLength(2);
    expect(builders[0]).toContain("Which bands does the request change?");
    expect(builders[0]).toContain("0. <h1> Well drilling in Grass Valley");
    expect(builders[1]).toContain(`<tawd-section id="1">`);
    expect(await improvedSource(ids.A!)).toContain(`<a data-edited href="tel:+15305550199">`);

    const ledger = await h.db.select().from(aiCall).where(eq(aiCall.step, "improve"));
    expect(ledger.map((c) => c.scope).sort()).toEqual(["locate", "sections"]);
  });

  it("sends the style sheet for a page-wide note", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const styled = PAGE.replace("</head>", "<style>body { color: #333; }</style></head>");
    const [v1] = await versionsOf(ids.A!);
    await r2.put(sourceKeyFor(v1!.htmlKey!), Buffer.from(styled));
    const { client, calls } = fakeClaude(() => [notesOn(-1, "Whole page"), review(["A"], {}, false)]);
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const prompt = promptOf(calls.find((c) => c.kind === "builder")!.params);
    expect(prompt).toContain(`<tawd-section id="styles">`);
    expect(prompt).toContain("The page's style sheet is included");
    expect(await improvedSource(ids.A!)).toContain("<style data-edited>body { color: #333; }</style>");
  });

  it("says so when nothing comes back, and still re-scores the page as it was", async () => {
    const { runId, projectId, ids } = await seedRun(["A"]);
    const { client, calls } = fakeClaude(() => [notesOn(2), review(["A"], {}, false)], {
      builder: () => turn("I made the changes.", "end_turn"),
    });
    await runReviewJob({ runId, projectId }, config, client, fakeBrowser());

    const steps = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, ids.A!));
    expect(steps.find((s) => s.step === "improve")).toMatchObject({
      status: "failed",
      detail: "The improvement was not made: The AI did not return any changed part.",
    });
    expect(calls.filter((c) => c.kind === "review")).toHaveLength(2);
    expect(await versionsOf(ids.A!)).toHaveLength(1);
  });
});
