import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The Mockups page picks one of three screens from where the latest run is:
  set up, generating, or the concepts. These render the real page over the
  test database and check each screen says what it should.
*/

const state: { user: unknown } = { user: null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  clientDecision,
  concept,
  conceptComment,
  conceptStep,
  conceptVersion,
  mockupRun,
  pipelineSteps,
  project as projectTable,
} from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import { estimateMinutes, getObservedMinutesPerConcept } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

async function seedProject() {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Plumbing",
    trade: "plumbing",
    tier: "growth",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "intake",
    memberUserIds: [],
  });
  // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
    name: "Tulemark Plumbing",
    phone: "(916) 555-0147",
    city: "Sacramento",
  });
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "brand", { moodWords: ["honest", "fast"] });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  return { admin, projectId };
}

async function seedRun(projectId: string, userId: string, status: string, conceptStatus: string) {
  const [run] = await h.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 2, status, model: "claude-opus-5-5", startedByUserId: userId, finishedAt: status === "running" ? null : new Date() })
    .returning();
  const ids: string[] = [];
  for (const label of ["A", "B"]) {
    const [row] = await h.db
      .insert(concept)
      .values({ runId: run!.id, projectId, label, direction: label === "A" ? "bold_emergency" : "modern_clean", skillId: label === "A" ? "ui_ux_pro_max" : "impeccable", status: conceptStatus })
      .returning();
    ids.push(row!.id);
    await h.db.insert(conceptStep).values(
      pipelineSteps.map((step, i) => ({
        conceptId: row!.id,
        step,
        status: conceptStatus === "ready" ? "done" : i === 0 ? "working" : "waiting",
        detail: i === 0 && conceptStatus !== "ready" ? "Designing the page" : null,
      })),
    );
    if (conceptStatus === "ready") {
      await h.db.insert(conceptVersion).values({
        conceptId: row!.id,
        version: 2,
        pngKey: `k/${row!.id}/full.png`,
        htmlKey: `k/${row!.id}/page.html`,
        placeholderCount: 4,
        summary: `Concept ${label} signature line`,
        checks: { passed: true, issues: [], stage: "cd_improve" },
        review: { passes: [{ pass: "after", average: 4.5, lowest: 4, questions: [], summary: "", safetyAdvice: [], earlierNotes: [], reviewedAt: "" }] },
      });
    }
  }
  return { runId: run!.id, ids };
}

async function render(projectId: string, query: Record<string, string> = {}) {
  const node = await MockupsPage({ params: Promise.resolve({ id: projectId }), searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(node as React.ReactElement);
}

describe("the Mockups page", () => {
  it("sets up the concepts when there is no run, with the estimate and what happens next", async () => {
    const { projectId } = await seedProject();
    const html = await render(projectId);
    expect(html).toContain("Set up the concepts");
    expect(html).toContain("emergency trade");
    expect(html).toContain("mood &quot;honest, fast&quot;");
    expect(html).toContain("Generate 3 concepts");
    expect(html).toContain("What happens next");
    expect(html).toMatch(/About \d+ minutes/);
    expect(html).toMatch(/Around \$\d+ to \$\d+/);
    // The model with the estimate (standing rule 2; 13 October 2026).
    expect(html).toMatch(/<dt>Model<\/dt><dd>[^<]+<\/dd>/);
    expect(html).toContain("held, with the reason; an admin can show it anyway.");
    expect(html).not.toContain("email");
  });

  it("shows live progress while a run is working, with who started it", async () => {
    const { admin, projectId } = await seedProject();
    await seedRun(projectId, admin.viewer.id, "running", "running");
    const html = await render(projectId);
    expect(html).toContain("Generating 2 concepts");
    expect(html).toContain("Started just now by");
    expect(html).toContain("Designing the page");
    expect(html).toContain("2 Quality checks");
    expect(html).toContain("Stop");
  });

  it("shows the concepts once ready, with the badges, comments and the three steps", async () => {
    const { admin, projectId } = await seedProject();
    const { ids } = await seedRun(projectId, admin.viewer.id, "succeeded", "ready");
    await h.db.insert(conceptComment).values({ projectId, conceptId: ids[0]!, version: 2, authorUserId: admin.viewer.id, body: "x", pinX: 1, pinY: 1 });

    const html = await render(projectId);
    expect(html).toContain("2 concepts ready for team review");
    expect(html).toContain("1 team comment is open");
    expect(html).toContain("Concept A signature line");
    expect(html).toContain("4 placeholders");
    expect(html).toContain("All checks passed");
    expect(html).toContain("Send to client");
    expect(html).toContain("Download client pack");
    expect(html).toContain("Record client decision");
    expect(html).toContain("Regenerate concepts");
    expect(html).toContain(`/projects/${projectId}/mockups/${ids[0]}`);
  });

  it("says why the Creative Director review stopped, in plain words for Anthropic's limit", async () => {
    const { admin, projectId } = await seedProject();
    const { runId } = await seedRun(projectId, admin.viewer.id, "review_incomplete", "ready");
    await h.db
      .update(mockupRun)
      .set({ failureReason: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}' })
      .where(eq(mockupRun.id, runId));
    const html = await render(projectId);
    expect(html).toContain("Why the review stopped:");
    expect(html).toContain("spending limit or credit balance was reached");
    expect(html).toContain("Your credit balance is too low to access the Anthropic API.");
  });

  it("offers Run the review again only for concepts still missing a review", async () => {
    const { admin, projectId } = await seedProject();
    const { runId, ids } = await seedRun(projectId, admin.viewer.id, "review_incomplete", "ready");
    await h.db.update(mockupRun).set({ failureReason: "Concept B: The review could not be used." }).where(eq(mockupRun.id, runId));
    await h.db.update(conceptVersion).set({ review: null }).where(eq(conceptVersion.conceptId, ids[1]!));

    const html = await render(projectId);
    expect(html).toContain("Run the review again");

    // With every review in, there is nothing to run again.
    await h.db
      .update(conceptVersion)
      .set({ review: { passes: [{ pass: "after", average: 4, lowest: 4, questions: [], summary: "", safetyAdvice: [], earlierNotes: [], reviewedAt: "" }] } })
      .where(eq(conceptVersion.conceptId, ids[1]!));
    expect(await render(projectId)).not.toContain("Run the review again");
  });

  it("goes back to setup on Regenerate, keeping the current run under Earlier runs", async () => {
    const { admin, projectId } = await seedProject();
    await seedRun(projectId, admin.viewer.id, "succeeded", "ready");
    const html = await render(projectId, { setup: "1" });
    expect(html).toContain("Set up the concepts");
    expect(html).toContain("Earlier runs");
  });

  it("says plainly when the last run produced nothing", async () => {
    const { admin, projectId } = await seedProject();
    const { ids } = await seedRun(projectId, admin.viewer.id, "failed", "failed");
    await h.db.update(concept).set({ failureReason: "The model is not available." }).where(eq(concept.id, ids[0]!));
    const html = await render(projectId);
    expect(html).toContain("The last run didn&#x27;t produce concepts");
    expect(html).toContain("not available to this account");
  });

  it("is read-only once the client approved, with the decision on top", async () => {
    const { admin, projectId } = await seedProject();
    const { ids } = await seedRun(projectId, admin.viewer.id, "succeeded", "ready");
    await h.db.update(projectTable).set({ status: "content" }).where(eq(projectTable.id, projectId));
    await h.db.insert(clientDecision).values({ projectId, conceptId: ids[1]!, version: 2, channel: "email", changesRequested: false, clientSaid: "B please", recordedByUserId: admin.viewer.id });

    const html = await render(projectId);
    expect(html).toContain("The client approved Concept B v2");
    // The client's pick stands out; the others fade.
    expect(html).toContain("Client’s pick");
    expect(html.match(/concept-card is-picked/g)).toHaveLength(1);
    expect(html.match(/concept-card is-faded/g)).toHaveLength(1);
    expect(html).not.toContain("Record client decision");
    expect(html).not.toContain("Send to client");
  });

  it("hides the team's controls from people who cannot run it", async () => {
    const { admin, projectId } = await seedProject();
    await seedRun(projectId, admin.viewer.id, "succeeded", "ready");
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    state.user = seo.viewer;
    const html = await render(projectId);
    expect(html).not.toContain("Record client decision");
    expect(html).not.toContain("Download client pack");
    expect(html).toContain("Open");
  });
});

describe("the time estimate", () => {
  it("is five minutes a concept plus the review until real runs exist, then uses them", async () => {
    expect(estimateMinutes(3, null)).toBe(20);
    expect(estimateMinutes(1, null)).toBe(10);
    expect(estimateMinutes(2, 7.4)).toBe(15);

    const { admin, projectId } = await seedProject();
    expect(await getObservedMinutesPerConcept(h.db)).toBeNull();
    const start = new Date("2026-09-24T10:00:00Z");
    await h.db.insert(mockupRun).values({ projectId, conceptCount: 2, status: "succeeded", model: "m", startedByUserId: admin.viewer.id, createdAt: start, finishedAt: new Date(start.getTime() + 24 * 60_000) });
    expect(await getObservedMinutesPerConcept(h.db)).toBeCloseTo(12);
  });

  it("ignores a run whose finish time moved when its review was run again, and takes the middle run", async () => {
    const { admin, projectId } = await seedProject();
    const run = (minutesPerConcept: number, concepts = 3) => {
      const start = new Date("2026-09-24T10:00:00Z");
      return {
        projectId,
        conceptCount: concepts,
        status: "succeeded",
        model: "m",
        startedByUserId: admin.viewer.id,
        createdAt: start,
        finishedAt: new Date(start.getTime() + minutesPerConcept * concepts * 60_000),
      };
    };
    // Built in 10 and 14 minutes a concept; the third had its review run again a day later.
    await h.db.insert(mockupRun).values([run(10), run(14), run((24 * 60) / 3)]);
    expect(await getObservedMinutesPerConcept(h.db)).toBeCloseTo(12);
    expect(estimateMinutes(3, await getObservedMinutesPerConcept(h.db))).toBe(35);

    await h.db.insert(mockupRun).values(run(9));
    // 9, 10 and 14: the middle one, not pulled up by the slow run.
    expect(await getObservedMinutesPerConcept(h.db)).toBeCloseTo(10);
  });
});
