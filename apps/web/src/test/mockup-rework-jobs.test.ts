import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import {
  aiCall,
  concept,
  conceptStep,
  conceptVersion,
  intakeFile,
  likedSiteShot,
  mockupRun,
  photoTextCheck,
  pipelineSteps,
  polishPass,
} from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { homeWords, wireframe } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { CONCEPT_JOB, PHOTO_TEXT_JOB, POLISH_JOB, REFERENCE_STUDY_JOB } from "@tawd/core/queue";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";
import { getObservedPerConcept, planRun, setQueueForTesting, startRun } from "@/lib/mockups";
import { loadPhotoTextCheck, loadReferenceStudy, startPhotoTextCheck, startReferenceStudy } from "@/lib/mockup-inputs";
import { loadPolish, startPolish } from "@/lib/polish";

import { runReferenceStudyJob } from "../../../worker/src/reference-study";
import { runPhotoTextJob } from "../../../worker/src/photo-text";
import { runPolishJob } from "../../../worker/src/polish";
import { runReviewJob } from "../../../worker/src/review";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, messagesText, review, turn } from "./worker-fakes";

/*
  The mockup rework's jobs (27 September 2026), end to end against the test
  database, with stand-ins for Claude, Chromium and R2: no AI money.
*/

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: never }[];

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
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function seedProject(status: "intake" | "mockups" = "mockups") {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Harbor Pest Control",
    trade: "pest_control",
    tier: "growth",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 1,
    status,
    memberUserIds: [],
  });
  // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
  // The Home page words, used, so Generate isn't blocked (1 October 2026).
  await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });
  // Growth: the wireframe, approved, so Generate isn't blocked (3 October 2026).
  await h.db.insert(wireframe).values({ projectId, sections: [{ id: "header-1", kind: "header", name: "Header", lines: [], note: "" }, { id: "hero-2", kind: "hero", name: "Hero", lines: [], note: "" }, { id: "footer-3", kind: "footer", name: "Footer", lines: [], note: "" }], approvedAt: new Date() });
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
    name: "Harbor Pest Control",
    phone: "(530) 555-0199",
    city: "Grass Valley",
    streetAddress: "1100 Melody Ln, Suite 2017",
  });
  return { admin, projectId };
}

async function seedShot(projectId: string, url: string) {
  const key = `projects/${projectId}/intake/liked-sites/${url.length}.jpg`;
  await r2.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x6a, 0x70, 0x67]));
  const [row] = await h.db
    .insert(likedSiteShot)
    .values({ projectId, url, status: "done", imageKey: key, outline: { bands: [{ kind: "hero", heading: "x", images: 1, cards: 0 }], hero: { headline: "x", hasImage: true, calls: [] }, trustSignals: ["a guarantee"], serviceLayout: null, images: 1 } })
    .returning();
  return row!;
}

const BRIEF = JSON.stringify({
  sectionOrder: ["hero with a team photo", "trust bar", "services grid", "contact form", "footer"],
  heroPattern: "Photo right, headline and phone left",
  trustElements: ["licence badges"],
  serviceLayout: "Six cards with icons",
  craftNotes: ["Generous spacing"],
  closestDirection: "classic_trust",
});

describe("the reference study", () => {
  it("studies each reference site in one call, estimate first, structure and craft only", async () => {
    const { admin, projectId } = await seedProject("intake");
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { likedWebsites: ["https://a.example", "https://b.example"] });
    await seedShot(projectId, "https://a.example");
    await seedShot(projectId, "https://b.example");
    expect((await loadReferenceStudy(h.db, projectId)).estimateLine).toContain("for 2 sites (a first guess");

    expect(await startReferenceStudy(h.ctx, admin.viewer, projectId)).toBe(2);
    expect(queued.map((q) => q.name)).toEqual([REFERENCE_STUDY_JOB]);
    await expect(startReferenceStudy(h.ctx, admin.viewer, projectId)).rejects.toThrow("already being studied");

    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        prompts.push(`${JSON.stringify(params.system)}\n${messagesText(params)}`);
        return turn(BRIEF, "end_turn");
      },
    });
    await runReferenceStudyJob(queued[0]!.data, config, claude.client as never);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Never copy identity");
    expect(prompts[0]).toContain('"trustSignals"');
    const rows = await h.db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));
    expect(rows.every((r) => r.briefStatus === "done" && (r.brief as { closestDirection: string }).closestDirection === "classic_trust")).toBe(true);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "reference_study"))).toHaveLength(2);

    // The proposal now reads the references: both point at Classic Trust.
    const plan = await planRun(admin.viewer, projectId, 3);
    expect(plan.plan.concepts[0]!.direction).toBe("classic_trust");
    expect(plan.plan.notes.join(" ")).toContain("2 of the 2 reference sites are closest to Classic Trust");
  });

  it("is part of every run: sites not studied yet go first, in the estimate, and polish is on unless skipped", async () => {
    const { admin, projectId } = await seedProject();
    await seedShot(projectId, "https://a.example");
    const plan = await planRun(admin.viewer, projectId, 1);
    expect(plan.referenceSitesToStudy).toBe(1);
    expect(plan.estimates[1].costLabel).toMatch(/^Around \$\d+ to \$\d+$/);
    expect(plan.polishPerConcept).toBeGreaterThan(0);

    const runId = await startRun(h.ctx, admin.viewer, { projectId, concepts: plan.plan.concepts.slice(0, 1), polish: false });
    expect(queued.map((q) => q.name)).toEqual([REFERENCE_STUDY_JOB, CONCEPT_JOB]);
    const [run] = await h.db.select().from(mockupRun).where(eq(mockupRun.id, runId));
    expect(run!.polish).toBe(false);
  });
});

describe("the measured cost per concept", () => {
  it("leaves polish and the client's change requests out, so polish isn't counted twice (30 September 2026)", async () => {
    const { admin, projectId } = await seedProject();
    const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
    await h.db.insert(concept).values({ runId: run!.id, projectId, label: "A", direction: "modern_clean", skillId: "impeccable", status: "ready" });
    const call = (step: string, outputTokens: number) => ({ projectId, runId: run!.id, step, model: "claude-opus-5-5", inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await h.db.insert(aiCall).values([call("build", 30_000), call("review", 5_000), call("polish", 9_000), call("polish_critique", 2_500), call("changes", 40_000)] as never);
    const observed = await getObservedPerConcept();
    expect(observed!.outputTokens).toBe(35_000);
  });
});

describe("the photo text check", () => {
  it("reads the text in the photos in one call and flags what contradicts the intake", async () => {
    const { admin, projectId } = await seedProject("intake");
    const key = `projects/${projectId}/intake/team.jpg`;
    await r2.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x6a, 0x70, 0x67]));
    await h.db.insert(intakeFile).values({ projectId, kind: "photo", storageKey: key, fileName: "team.jpg", contentType: "image/jpeg", caption: "Our team", status: "ready" });

    await startPhotoTextCheck(h.ctx, admin.viewer, projectId);
    expect(queued.map((q) => q.name)).toEqual([PHOTO_TEXT_JOB]);
    const claude = fakeClaude(() => [], { builder: () => turn('{"photos":[{"photo":1,"texts":["530A","HARBOR PEST CONTROL"]}]}', "end_turn") });
    await runPhotoTextJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    const [check] = await h.db.select().from(photoTextCheck).where(eq(photoTextCheck.projectId, projectId));
    expect(check!.status).toBe("done");
    const view = await loadPhotoTextCheck(h.db, projectId, 1);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]!.problem).toContain('Shows "530A", which isn\'t in the intake address (1100 Melody Ln, Suite 2017, Grass Valley)');
    expect(await h.db.select().from(aiCall).where(eq(aiCall.step, "photo_text"))).toHaveLength(1);
  });
});

/* A concept with a reviewed version, ready for the polish. */
const PAGE2 = `<!doctype html><html lang="en"><head><title>Pest control in Grass Valley</title>
<meta name="description" content="Harbor Pest Control treats homes across Grass Valley."></head>
<body><header><a href="tel:+15305550199">(530) 555-0199</a></header>
<section><h1>Pest control in Grass Valley</h1><p>Harbor Pest Control</p></section>
<section><form><label for="n">Name</label><input id="n" type="text"><button type="submit">Call me back</button></form></section>
<footer><p>Harbor Pest Control, Grass Valley</p></footer></body></html>`;

async function seedReviewedConcept(projectId: string, userId: string, polish: boolean) {
  const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "running", model: "claude-opus-5-5", startedByUserId: userId, polish }).returning();
  const [row] = await h.db.insert(concept).values({ runId: run!.id, projectId, label: "A", direction: "classic_trust", skillId: "ui_ux_pro_max", status: "ready" }).returning();
  await h.db.insert(conceptStep).values(pipelineSteps.map((step) => ({ conceptId: row!.id, step, status: step === "build" || step === "checks" ? "done" : "waiting" })));
  const base = `projects/${projectId}/concepts/${row!.id}/v1`;
  const stored = { pass: "first", questions: [], average: 3.6, lowest: 3, summary: "Solid but plain.", safetyAdvice: [], earlierNotes: [], reviewedAt: new Date().toISOString() };
  await h.db.insert(conceptVersion).values({
    conceptId: row!.id,
    version: 1,
    htmlKey: `${base}/page.html`,
    pngKey: `${base}/full.png`,
    checks: { passed: true, issues: [], stage: "build" },
    review: polish ? null : { passes: [stored] },
  });
  await r2.put(`${base}/page.html`, Buffer.from(PAGE2));
  await r2.put(`${base}/source.html`, Buffer.from(PAGE2));
  return { runId: run!.id, conceptId: row!.id };
}

const CRITIQUE = JSON.stringify({ fixes: [{ band: 1, area: "type scale", problem: "The headline and body are too close in size.", fix: "Set the headline to 56px." }], summary: "Tighten the type." });

/* Claude for the polish: the critique (asked with Impeccable's critique), then the band edit, then the scoring. */
function polishClaude(scores = review(["A"])) {
  return fakeClaude(() => [scores], {
    builder: (params) => {
      const system = JSON.stringify(params.system ?? "");
      if (system.includes("impeccable_critique")) return turn(CRITIQUE, "end_turn");
      return turn(`<tawd-section id="1"><section><h1 style="font-size:56px">Pest control in Grass Valley</h1><p>Harbor Pest Control</p></section></tawd-section>`, "end_turn");
    },
  });
}

describe("critique then polish", () => {
  it("runs one bounded pass on a reviewed concept, the estimate first, and keeps the before and after", async () => {
    const { admin, projectId } = await seedProject();
    const { conceptId } = await seedReviewedConcept(projectId, admin.viewer.id, false);
    expect((await loadPolish(h.db, conceptId)).estimateLine).toContain("a first guess");

    // Two clicks together start one paid polish (13 October 2026, the whole-code review).
    const both = await Promise.allSettled([startPolish(h.ctx, admin.viewer, conceptId), startPolish(h.ctx, admin.viewer, conceptId)]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect(queued.map((q) => q.name)).toEqual([POLISH_JOB]);
    await expect(startPolish(h.ctx, admin.viewer, conceptId)).rejects.toThrow("already being polished");

    const claude = polishClaude();
    await runPolishJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    const view = await loadPolish(h.db, conceptId);
    expect(view.status).toBe("done");
    expect(view.critique).toHaveLength(1);
    expect(view.before).toMatchObject({ version: 1, average: 3.6 });
    expect(view.after!.version).toBeGreaterThan(1);
    expect(view.after!.average).toBe(4);
    const versions = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
    expect(versions.some((v) => (v.checks as { stage?: string }).stage === "polish")).toBe(true);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.step, "polish_critique"))).length).toBe(1);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.step, "polish"))).length).toBeGreaterThanOrEqual(1);
  });

  /*
    The cost lever (Jason's spend screen, 10 November 2026): the Creative
    Director was 42% of the run's cost at an 11% cache rate, while its
    system prompt - the one block already marked cacheable - read far
    higher. The reference screens are the same pictures in every call of a
    run and the largest block in the message, so the last of them closes a
    cached prefix.
  */
  it("marks the reference pictures as the cached prefix of the reviewer's message", async () => {
    const { admin, projectId } = await seedProject();
    // Two reference sites with screens: the pictures that repeat in every call of the run.
    await seedShot(projectId, "https://reference-one.example/");
    await seedShot(projectId, "https://reference-two.example/");
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", {
      noCurrentWebsite: true,
      likedWebsites: ["https://reference-one.example/", "https://reference-two.example/"],
    });
    const { conceptId } = await seedReviewedConcept(projectId, admin.viewer.id, false);
    await startPolish(h.ctx, admin.viewer, conceptId);
    const claude = polishClaude();
    await runPolishJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    const review = claude.calls.find((c) => c.kind === "review")!;
    const content = (review.params as { messages: { content: { type: string; cache_control?: unknown }[] }[] }).messages[0]!.content;
    const images = content.filter((block) => block.type === "image");
    expect(images.length, "the reviewer saw no pictures at all").toBeGreaterThan(0);
    const cached = content.filter((block) => block.cache_control);
    // Exactly one breakpoint in the message, and it is on a picture, not on the concept's own page text.
    expect(cached).toHaveLength(1);
    expect(cached[0]!.type).toBe("image");
    // It is the LAST reference picture: everything before it is identical in every call of the run.
    expect(content.indexOf(cached[0]!)).toBeLessThan(content.indexOf(images.at(-1)!));
  });

  /*
    Direction fit on a polished concept (Jason's run, 10 November 2026).

    A polish pass scores one concept on its own, and it told the reviewer
    that one concept WAS the run - so question 2 was forced to "Not
    applicable: this run has only one concept to compare" on a run with
    two, and both of a client's concepts read "4 to N/A". One of the eleven
    questions, thrown away by the pass that was supposed to improve them.
  */
  it("scores direction fit on a polished concept when the run has another", async () => {
    const { admin, projectId } = await seedProject();
    const { conceptId, runId } = await seedReviewedConcept(projectId, admin.viewer.id, false);
    // A sibling in the same run: the thing the old code could not see.
    await h.db.insert(concept).values({ runId, projectId, label: "B", direction: "bright_friendly", skillId: "ui_ux_pro_max", status: "ready" });

    await startPolish(h.ctx, admin.viewer, conceptId);
    const claude = polishClaude();
    await runPolishJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    /*
      The polish's own score lands on the newest version it leaves behind
      (its fix round's), not on the version marked "polish": so the review
      is read the way the screen reads it - the newest one that has one.
    */
    const versions = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId)).orderBy(conceptVersion.version);
    const scored = versions.filter((v) => v.review !== null).at(-1)!;
    const passes = (scored.review as { passes: { pass: string; questions: { question: number; score: number | null; notApplicable: boolean }[] }[] }).passes;
    const changes = passes.find((pp) => pp.pass === "changes")!;
    const q2 = changes.questions.find((q) => q.question === 2)!;
    expect(q2.notApplicable, "direction fit was thrown away on a two-concept run").toBe(false);
    expect(q2.score).not.toBeNull();
    // And the reviewer was told the truth about why it cannot compare them here.
    const asked = JSON.stringify(claude.calls.filter((c) => c.kind === "review").map((c) => c.params));
    expect(asked).toContain("not shown in this pass");
    expect(asked).not.toContain("only one concept in this run");
  });

  it("runs by itself once per concept after the review when the run has it on, and not when skipped", async () => {
    const { admin, projectId } = await seedProject();
    const on = await seedReviewedConcept(projectId, admin.viewer.id, true);
    // Scored clean after the polish, so it is shown (8 October 2026: under 4.5 it would be held).
    const claude = polishClaude(review(["A"], {}, false));
    await runReviewJob({ runId: on.runId, projectId }, config, claude.client as never, fakeBrowser());
    const passes = await h.db.select().from(polishPass).where(eq(polishPass.conceptId, on.conceptId));
    expect(passes).toHaveLength(1);
    expect(passes[0]!.status).toBe("done");
    const [step] = await h.db.select().from(conceptStep).where(eq(conceptStep.conceptId, on.conceptId)).then((rows) => rows.filter((r) => r.step === "final_checks"));
    expect(step!.detail).toContain("polished in v");

    // Deleting the project removes the new tables' rows.
    await seedShot(projectId, "https://a.example");
    await h.db.insert(photoTextCheck).values({ projectId, status: "done" });
    await deleteProject(h.ctx, admin.viewer, projectId, { reason: "Test data only, remove it", confirmName: "Harbor Pest Control" });
    expect(await h.db.select().from(polishPass)).toHaveLength(0);
    expect(await h.db.select().from(photoTextCheck)).toHaveLength(0);
    expect(await h.db.select().from(likedSiteShot)).toHaveLength(0);
  });

  it("is skipped when the PM turned it off for the run", async () => {
    const { admin, projectId } = await seedProject();
    const off = await seedReviewedConcept(projectId, admin.viewer.id, false);
    await h.db.update(conceptVersion).set({ review: null }).where(eq(conceptVersion.conceptId, off.conceptId));
    const claude = polishClaude();
    await runReviewJob({ runId: off.runId, projectId }, config, claude.client as never, fakeBrowser());
    expect(await h.db.select().from(polishPass).where(eq(polishPass.conceptId, off.conceptId))).toHaveLength(0);
  });
});
