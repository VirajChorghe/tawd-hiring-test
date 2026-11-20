import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PIPELINE_3A,
  PIPELINE_3B,
  REVIEW_JSON_SCHEMA,
  REVIEW_QUESTIONS,
  RERUNNABLE_STEPS,
  SETTLED_STEPS,
  UNSETTLED_STEPS,
  ReviewFormatError,
  allNotes,
  buildReviewUserText,
  checkDesignLog,
  decideAfterRescore,
  estimateFromObserved,
  estimateRun,
  conceptLetter,
  failingQuestions,
  htmlForReview,
  readReviewAnswer,
  reviewJsonSchemaFor,
  validateReview,
} from "@tawd/core/mockups";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { aiCall, clientDecision, concept, conceptVersion, designLogEntry, mockupRun, project as projectTable } from "@tawd/core/schema";
import { createProject } from "@/lib/projects";
import { getDesignLogNeighbours } from "@/lib/mockups";
import { createHarness, seedAdmin, type Harness } from "./harness";

/* The Creative Director's rules on their own, and the ledger's backfill. */

function answer(labels: string[], score: (label: string, q: number) => number | null = () => 4) {
  return {
    concepts: labels.map((label) => ({
      label,
      summary: "",
      safetyAdvice: [],
      earlierNotes: [],
      questions: REVIEW_QUESTIONS.map((q) => ({
        question: q.id,
        score: score(label, q.id),
        reason: "",
        notes: [{ section: "Hero", problem: "p", change: "c" }],
      })),
    })),
  };
}

describe("reading the reviewer's answer", () => {
  it("accepts a complete answer and averages the scores", () => {
    const reviews = validateReview(
      answer(["A", "B"], (l, q) => (l === "A" && q === 1 ? 2 : 4)),
      ["A", "B"],
      "first",
    );
    expect(reviews.get("A")!.average).toBe(3.8);
    expect(reviews.get("A")!.lowest).toBe(2);
    expect(reviews.get("B")!.average).toBe(4);
  });

  it("refuses an answer that leaves out a concept", () => {
    expect(() => validateReview(answer(["A"]), ["A", "B"], "first")).toThrow(
      ReviewFormatError,
    );
  });

  it("refuses a score outside 1 to 5", () => {
    for (const bad of [0, 6, null]) {
      expect(() =>
        validateReview(answer(["A", "B"], (_l, q) => (q === 3 ? bad : 4)), ["A", "B"], "first"),
      ).toThrow(/must be 1 to 5/);
    }
  });

  it("refuses a missing question", () => {
    const raw = answer(["A", "B"]);
    raw.concepts[0]!.questions = raw.concepts[0]!.questions.filter((q) => q.question !== 5);
    expect(() => validateReview(raw, ["A", "B"], "first")).toThrow(/left out question 5/);
  });

  it("refuses something that is not the right shape at all", () => {
    expect(() => validateReview({ scores: [1, 2, 3] }, ["A"], "first")).toThrow(ReviewFormatError);
  });

  it("with one concept, marks direction fit not applicable whatever the score, and averages without it", () => {
    const reviews = validateReview(
      answer(["A"], (_l, q) => (q === 2 ? 1 : 5)),
      ["A"],
      "first",
    );
    const a = reviews.get("A")!;
    expect(a.questions.find((q) => q.question === 2)).toMatchObject({
      notApplicable: true,
      score: null,
      notes: [],
    });
    expect(a.average).toBe(5);
    expect(failingQuestions(a)).toEqual([]);
  });

  it("keeps direction fit on a rebuild pass that scores one of several concepts", () => {
    const reviews = validateReview(answer(["B"], () => 4), ["B"], "rebuild", new Date(), 2);
    expect(reviews.get("B")!.questions.find((q) => q.question === 2)!.notApplicable).toBe(false);
  });

  /*
    A polish or a changes pass reviews one concept on its own (Jason's run,
    10 November 2026). Both passed that one concept as the whole run, so
    Direction fit came back "Not applicable: this run has only one concept
    to compare" on a run that had two: untrue, and one of the eleven
    questions lost on every polished concept - it read "4 to N/A" on both
    of a client's.
  */
  it("keeps direction fit when the run has other concepts this pass doesn't show", () => {
    const reviews = validateReview(answer(["A"], () => 4), ["A"], "changes", new Date(), 2);
    const q2 = reviews.get("A")!.questions.find((q) => q.question === 2)!;
    expect(q2.notApplicable).toBe(false);
    expect(q2.score).toBe(4);
  });

  it("tells the reviewer to score the half it can answer, and never claims the run has one concept", () => {
    const one = (conceptsInRun: number) =>
      buildReviewUserText({
        pass: "changes",
        concepts: [{ label: "A", direction: "classic_trust", checksSummary: "All passed", html: "<p>x</p>" }],
        factsKnown: "- A business",
        factsMissing: "- nothing",
        conceptsInRun,
      });

    const hidden = one(2);
    expect(hidden).toContain("not shown in this pass");
    expect(hidden).toContain("feels like its own chosen direction");
    expect(hidden).not.toContain("only one concept in this run");

    // A run that really has one concept still says so.
    const alone = one(1);
    expect(alone).toContain("only one concept in this run");
    expect(alone).not.toContain("not shown in this pass");
  });

  /* CodeRabbit on PR #75 (12 November 2026), checked against the code first. */
  it("does not call the siblings hidden when they are on the page side by side", () => {
    const text = buildReviewUserText({
      pass: "first",
      concepts: (["A", "B"] as const).map((label) => ({ label, direction: "classic_trust" as const, checksSummary: "All passed", html: "<p>x</p>" })),
      factsKnown: "- A business",
      factsMissing: "- nothing",
    });
    expect(text).not.toContain("not shown in this pass");
  });

  it("never says the other concepts are shown as small images when none are", () => {
    for (const pass of ["first", "after", "rebuild"] as const) {
      const text = buildReviewUserText({
        pass,
        concepts: [{ label: "B", direction: "classic_trust", checksSummary: "All passed", html: "<p>x</p>" }],
        factsKnown: "- A business",
        factsMissing: "- nothing",
        others: [],
        conceptsInRun: 2,
      });
      expect(text, pass).not.toContain("small first-screen images");
      expect(text, pass).toContain("not shown in this pass");
    }
    // With the images, it still says so.
    const shown = buildReviewUserText({
      pass: "first",
      concepts: [{ label: "B", direction: "classic_trust", checksSummary: "All passed", html: "<p>x</p>" }],
      factsKnown: "- A business",
      factsMissing: "- nothing",
      others: [{ label: "A", direction: "warm_local" }],
      conceptsInRun: 2,
    });
    expect(shown).toContain("small first-screen images");
  });

  /*
    "Didn't finish" on a run that finished (Jason's run, 10 November 2026).

    The checks step was written as "failed" whenever a page still had
    something to fix, and the generating screen prints "failed" as "Didn't
    finish" - so both of a client's concepts said it, on a run that
    produced two finished, reviewed pages. The step did finish; what it
    found was fixes outstanding, which is the team's decision to make.

    It needed its own state rather than "done": "failed" is also what let
    the team run that step again, and a page with failing checks has not
    passed.
  */
  it("counts a step with checks outstanding as finished, and still lets it be re-run", () => {
    expect(SETTLED_STEPS).toContain("needs_fixes");
    expect(RERUNNABLE_STEPS).toContain("needs_fixes");
    // Not "done": the page has not passed its checks.
    expect(SETTLED_STEPS).toContain("done");
    expect(RERUNNABLE_STEPS).not.toContain("done");
    // And the two states keep their old meanings.
    expect(RERUNNABLE_STEPS).toContain("failed");
    expect(UNSETTLED_STEPS).toEqual(["waiting", "working"]);
  });

  /*
    A ratchet, because the two places that write this step have no test
    harness of their own: running the build job needs a browser, an AI
    client and R2, and nothing in the suite does it today. So this reads
    the source instead and holds the one line that mattered.

    Both writes must say "needs_fixes" for a page with fixes outstanding.
    Written as "failed" - which is what they said until 11 November 2026 -
    the generating screen prints "Didn't finish" about a page that is
    finished, built and reviewed, which is what Jason saw on both of New
    Dawn's concepts.
  */
  it("no step is written as a failure just because the page has fixes outstanding", () => {
    const sources = ["../../../worker/src/pipeline.ts", "../../../worker/src/review.ts"].map((file) =>
      fs.readFileSync(path.join(__dirname, file), "utf8"),
    );
    for (const source of sources) {
      expect(source).not.toContain('passed ? "done" : "failed"');
    }
    // And both do write the state that says what actually happened.
    expect(sources.filter((source) => source.includes('passed ? "done" : "needs_fixes"'))).toHaveLength(2);
  });

  it("asks for JSON the API can enforce: every object closed", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties as object));
      }
      Object.values(obj).forEach(walk);
    };
    walk(REVIEW_JSON_SCHEMA);
  });
});

/*
  The ABC Plumbers review (25 September 2026) was thrown away as "left out
  Concept A" when the answer was labeled "Concept A". These are the ways
  an answer may be worded and still be read, and the ways it never is.
*/
describe("reading an answer that is worded differently", () => {
  it("finds the concept letter however the label is written, and never guesses", () => {
    for (const label of ["A", "a", " Concept A ", "concept-a", "Concept A: Bold Emergency", "Concept A (Bold Emergency)", "Concept #A"]) {
      expect(conceptLetter(label)).toBe("A");
    }
    for (const label of ["Bold Emergency", "", "Concept", "AB", "A1"]) {
      expect(conceptLetter(label)).toBeNull();
    }
  });

  it("accepts \"Concept A\" as A, and records how it was read", () => {
    const raw = answer(["Concept A"]);
    const a = validateReview(raw, ["A"], "first", new Date(), 1).get("A")!;
    expect(a.average).toBe(4);
    expect(a.readAs).toEqual([`the label "Concept A" read as A`]);
  });

  it("records nothing when the label was exactly right", () => {
    expect(validateReview(answer(["A"]), ["A"], "first", new Date(), 1).get("A")!.readAs).toBeUndefined();
  });

  it("in a one-concept call, reads a lone entry that names no concept as that concept", () => {
    const b = validateReview(answer(["Bold Emergency"]), ["B"], "first", new Date(), 2).get("B")!;
    expect(b.readAs).toEqual([`the only entry, labeled "Bold Emergency", read as B`]);
  });

  it("refuses an entry about a different concept, and the retry says what was wrong", () => {
    try {
      validateReview(answer(["A"]), ["B"], "first", new Date(), 2);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewFormatError);
      const e = error as ReviewFormatError;
      expect(e.message).toBe(`The review left out Concept B: its entries were labeled "A".`);
      expect(e.retryHint).toContain(`this call reviews Concept B`);
      expect(e.retryHint).toContain(`set label to exactly "B"`);
    }
  });

  it("never reads a lone unnamed entry as a concept when several were asked for", () => {
    expect(() => validateReview(answer(["Bold Emergency"]), ["A", "B"], "first")).toThrow(/left out Concept A/);
  });

  it("names an empty answer as empty", () => {
    expect(() => validateReview({ concepts: [] }, ["A"], "first", new Date(), 1)).toThrow(
      "The review left out Concept A: it had no entries.",
    );
  });

  it("gives a missing question and a bad score a retry hint that names the question", () => {
    const missing = answer(["A"]);
    missing.concepts[0]!.questions = missing.concepts[0]!.questions.filter((q) => q.question !== 5);
    expect(() => validateReview(missing, ["A"], "first", new Date(), 1)).toThrow(
      expect.objectContaining({ retryHint: expect.stringMatching(/left out question 5 .*all eleven questions/) }),
    );
    expect(() => validateReview(answer(["A"], (_l, q) => (q === 3 ? 7 : 4)), ["A"], "first", new Date(), 1)).toThrow(
      expect.objectContaining({ retryHint: expect.stringMatching(/Question 3 .* was given score 7/) }),
    );
  });

  it("reads the JSON out of a code fence or a sentence around it, and says so", () => {
    const json = JSON.stringify(answer(["A"]));
    for (const text of ["```json\n" + json + "\n```", `Here is my review:\n${json}\nThanks.`]) {
      const a = readReviewAnswer(text, "A", "first", 1);
      expect(a.average).toBe(4);
      expect(a.readAs).toEqual(["the JSON read from inside surrounding text"]);
    }
  });

  it("reads plain JSON with nothing recorded", () => {
    expect(readReviewAnswer(JSON.stringify(answer(["A"])), "A", "first", 1).readAs).toBeUndefined();
  });

  it("refuses text with no JSON in it, and the retry quotes how it began", () => {
    expect(() => readReviewAnswer("I cannot score this page.", "A", "first", 1)).toThrow(
      expect.objectContaining({
        message: "The answer was not valid JSON.",
        retryHint: expect.stringContaining(`(it began: "I cannot score this page.")`),
      }),
    );
    expect(() => readReviewAnswer("", "A", "first", 1)).toThrow(
      expect.objectContaining({ retryHint: expect.stringContaining("(it was empty)") }),
    );
  });

  it("asks each call for its own letter only, in a schema the API can still enforce", () => {
    const schema = reviewJsonSchemaFor(["B"]);
    const item = (schema.properties as { concepts: { items: { properties: { label: unknown } } } }).concepts.items;
    expect(item.properties.label).toEqual({ type: "string", enum: ["B"] });
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties as object));
      }
      Object.values(obj).forEach(walk);
    };
    walk(schema);
    // The shared schema is left as it was.
    expect((REVIEW_JSON_SCHEMA.properties as { concepts: { items: { properties: { label: unknown } } } }).concepts.items.properties.label).toEqual({ type: "string" });
  });
});

describe("what happens after a score", () => {
  const scored = (low: number) =>
    validateReview(answer(["A", "B"], (_l, q) => (q === 4 ? low : 4)), ["A", "B"], "after").get("A")!;

  it("is done when nothing is under 3", () => {
    expect(decideAfterRescore(scored(3), false)).toEqual({ kind: "done" });
  });

  it("rebuilds once when something is under 3", () => {
    expect(decideAfterRescore(scored(2), false)).toEqual({ kind: "rebuild" });
  });

  it("flags for the PM, never rebuilds again, once already rebuilt", () => {
    const decision = decideAfterRescore(scored(2), true);
    expect(decision.kind).toBe("flag");
    if (decision.kind === "flag") expect(decision.failing.map((q) => q.question)).toEqual([4]);
  });

  it("turns notes into builder instructions with the section, problem and change", () => {
    const notes = allNotes(scored(2));
    // No band in this answer: the improvement round places it by its section name.
    expect(notes[0]).toEqual({ question: "1. 5-second test", note: "Hero: p Change: c", band: null, section: "Hero" });
  });
});

describe("what the reviewer is shown", () => {
  it("names every concept, the questions and the facts, and asks for only the ones to score", () => {
    const text = buildReviewUserText({
      pass: "rebuild",
      scoreOnly: ["B"],
      factsKnown: "- Phone number: 530",
      factsMissing: "- Opening hours",
      concepts: [
        { label: "A", direction: "rugged_craftsman", checksSummary: "All passed", html: "<p>a</p>" },
        { label: "B", direction: "classic_trust", checksSummary: "All passed", html: "<p>b</p>" },
      ],
    });
    expect(text).toContain("Score only: Concept B.");
    expect(text).toContain("## Concept A: Rugged Craftsman");
    expect(text).toContain("8. Above the fold");
    expect(text).toContain("- Phone number: 530");
    expect(text).not.toContain("Not applicable");
    expect(text).toContain(`Each entry's label is the concept's letter alone: "B".`);
  });

  it("gets the page without megabytes of inlined images", () => {
    const html = `<img src="data:image/jpeg;base64,${"A".repeat(5000)}" alt="x">`;
    expect(htmlForReview(html)).toBe(`<img src="data:image-omitted" alt="x">`);
  });
});

describe("the design-log check", () => {
  const neighbour = (over = {}) => ({
    projectId: "p2",
    projectName: "Sierra Pumps",
    direction: "rugged_craftsman",
    paletteFamily: "green",
    ...over,
  });

  it("says no clash when nothing nearby matches", () => {
    expect(
      checkDesignLog({
        direction: "classic_trust",
        paletteFamily: "blue",
        city: "Grass Valley",
        neighbours: [neighbour()],
      }),
    ).toEqual({ clash: false, message: "No clash nearby", projects: [] });
  });

  it("names the project that already has the direction", () => {
    const result = checkDesignLog({
      direction: "rugged_craftsman",
      paletteFamily: "blue",
      city: "Grass Valley",
      neighbours: [neighbour()],
    });
    expect(result.clash).toBe(true);
    expect(result.message).toBe("Sierra Pumps nearby already uses Rugged Craftsman.");
  });

  it("names a palette clash too, and a deleted project as such", () => {
    const result = checkDesignLog({
      direction: "classic_trust",
      paletteFamily: "green",
      city: "Grass Valley",
      neighbours: [neighbour({ projectName: null })],
    });
    expect(result.message).toBe("a deleted project nearby has a green palette too.");
  });

  it("says so when there is no city to compare", () => {
    expect(
      checkDesignLog({ direction: "classic_trust", paletteFamily: null, city: null, neighbours: [] })
        .message,
    ).toMatch(/No city/);
  });
});

describe("the estimate, with the Creative Director", () => {
  const config = { model: "claude-opus-5-5", inputPricePerMTok: 4, outputPricePerMTok: 20 };

  it("costs more with the review than without", () => {
    expect(estimateRun(3, config, PIPELINE_3B).high).toBeGreaterThan(
      estimateRun(3, config, PIPELINE_3A).high,
    );
  });

  it("is the default from 3b", () => {
    expect(estimateRun(2, config)).toEqual(estimateRun(2, config, PIPELINE_3B));
  });

  it("adds the guessed review to a measured build until a measured review exists", () => {
    const observed = {
      concepts: 2,
      inputTokens: 50_000,
      outputTokens: 40_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const without = estimateFromObserved(1, config, observed);
    const withReview = estimateFromObserved(1, config, observed, { addGuessedReview: true });
    expect(withReview.high).toBeGreaterThan(without.high);
  });
});

/* ---------- the database parts ---------- */

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});

afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

const lane1 = {
  trade: "well_and_pump" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 2,
  status: "mockups" as const,
  memberUserIds: [] as string[],
};

describe("nearby projects for the design log", () => {
  it("finds other projects in the same trade and city, ignoring case, but never this project", async () => {
    const admin = await seedAdmin(h);
    const mine = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Dale Rowan" });
    const rival = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Sierra Pumps" });
    const elsewhere = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Reno Wells" });

    // A look counts once a client picked it (8 October 2026), so each entry gets a concept and a decision.
    const picked = async (projectId: string, direction: string) => {
      const [run] = await h.db.insert(mockupRun).values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
      const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId, label: "A", direction, skillId: "impeccable", status: "ready" }).returning();
      await h.db.insert(clientDecision).values({ projectId, conceptId: c!.id, version: 1, channel: "phone", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
      return c!.id;
    };
    await h.db.insert(designLogEntry).values([
      { projectId: mine, conceptId: await picked(mine, "classic_trust"), trade: "well_and_pump", city: "Grass Valley", direction: "classic_trust" },
      { projectId: rival, conceptId: await picked(rival, "rugged_craftsman"), trade: "well_and_pump", city: "grass valley ", direction: "rugged_craftsman" },
      { projectId: elsewhere, conceptId: await picked(elsewhere, "warm_local"), trade: "well_and_pump", city: "Reno", direction: "warm_local" },
    ]);

    const found = await getDesignLogNeighbours(mine, "well_and_pump", "Grass Valley");
    expect(found.map((f) => f.projectName)).toEqual(["Sierra Pumps"]);
  });

  it("counts only looks a client picked, on real projects (the official run, 8 October 2026)", async () => {
    const admin = await seedAdmin(h);
    const mine = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Sample Plumbing Co." });
    const test = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "ABC Plumbers" });
    const [run] = await h.db.insert(mockupRun).values({ projectId: test, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id }).returning();
    const [unpicked] = await h.db.insert(concept).values({ runId: run!.id, projectId: test, label: "A", direction: "bold_emergency", skillId: "impeccable", status: "ready" }).returning();
    await h.db.insert(designLogEntry).values({ projectId: test, conceptId: unpicked!.id, trade: "well_and_pump", city: "Grass Valley", direction: "bold_emergency" });
    expect(await getDesignLogNeighbours(mine, "well_and_pump", "Grass Valley")).toEqual([]);

    // Picked, but a test project: still not counted.
    await h.db.insert(clientDecision).values({ projectId: test, conceptId: unpicked!.id, version: 1, channel: "phone", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    await h.db.update(projectTable).set({ isTest: true }).where(eq(projectTable.id, test));
    expect(await getDesignLogNeighbours(mine, "well_and_pump", "Grass Valley")).toEqual([]);
    await h.db.update(projectTable).set({ isTest: false }).where(eq(projectTable.id, test));
    expect((await getDesignLogNeighbours(mine, "well_and_pump", "Grass Valley")).map((f) => f.projectName)).toEqual(["ABC Plumbers"]);
  });
});

describe("filling the ledger from what already exists", () => {
  it("splits each concept's running totals into the build and each fix round", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Dale Rowan" });
    const [run] = await h.db
      .insert(mockupRun)
      .values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id })
      .returning();
    const [row] = await h.db
      .insert(concept)
      .values({ runId: run!.id, projectId, label: "A", direction: "rugged_craftsman", skillId: "impeccable", status: "ready" })
      .returning();
    await h.db.insert(conceptVersion).values([
      { conceptId: row!.id, version: 1, inputTokens: 10_000, outputTokens: 30_000, cacheWriteTokens: 9_000 },
      { conceptId: row!.id, version: 2, inputTokens: 40_000, outputTokens: 55_000, cacheWriteTokens: 9_000, cacheReadTokens: 8_000 },
      { conceptId: row!.id, version: 3, inputTokens: 75_000, outputTokens: 80_000, cacheWriteTokens: 9_000, cacheReadTokens: 16_000 },
    ]);

    // The migration's own statement, run against this data.
    const sqlFile = fs.readFileSync(
      path.join(__dirname, "..", "..", "drizzle", "0005_spend_ledger.sql"),
      "utf8",
    );
    const statements = sqlFile.split("--> statement-breakpoint");
    const backfill = statements.find((s) => s.includes('FROM "concept_version" v'))!;
    await (h.db as unknown as { execute: (q: string) => Promise<unknown> }).execute(backfill);

    const rows = (await h.db.select().from(aiCall).where(eq(aiCall.conceptId, row!.id))).sort(
      (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );
    expect(rows.map((r) => [r.step, r.round, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens])).toEqual([
      ["build", null, 10_000, 30_000, 0, 9_000],
      ["fix", 1, 30_000, 25_000, 8_000, 0],
      ["fix", 2, 35_000, 25_000, 8_000, 0],
    ]);
    expect(rows.every((r) => r.backfilled && r.startedByUserId === admin.viewer.id)).toBe(true);
    // The totals still add up to what the concept cost.
    expect(rows.reduce((n, r) => n + r.outputTokens, 0)).toBe(80_000);
  });

  it("marks past calls whole page or sections only, for the before and after on Spend", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Dale Rowan" });
    const [run] = await h.db
      .insert(mockupRun)
      .values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id })
      .returning();
    const at = (iso: string) => ({ projectId, runId: run!.id, model: "claude-opus-5-5", createdAt: new Date(iso) });
    await h.db.insert(aiCall).values([
      { ...at("2026-09-24T10:00:00Z"), step: "build" },
      { ...at("2026-09-24T10:05:00Z"), step: "fix", round: 1 },
      { ...at("2026-09-24T22:00:00Z"), step: "fix", round: 1 },
      { ...at("2026-09-24T22:10:00Z"), step: "improve" },
      { ...at("2026-09-24T23:00:00Z"), step: "changes" },
      { ...at("2026-09-24T23:05:00Z"), step: "review" },
    ]);

    // The migration's own statements (not the column, which already exists here).
    const sqlFile = fs.readFileSync(path.join(__dirname, "..", "..", "drizzle", "0010_ai_call_scope.sql"), "utf8");
    for (const statement of sqlFile.split("--> statement-breakpoint").filter((s) => s.includes("UPDATE"))) {
      await (h.db as unknown as { execute: (q: string) => Promise<unknown> }).execute(statement);
    }

    const rows = (await h.db.select().from(aiCall).where(eq(aiCall.runId, run!.id))).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    expect(rows.map((r) => `${r.step}:${r.scope}`)).toEqual([
      "build:null",
      // Before 0.14.0 went live, a fix round sent the whole page; after, only sections.
      "fix:page",
      "fix:sections",
      "improve:page",
      "changes:page",
      "review:null",
    ]);
  });
});
