import { describe, expect, it } from "vitest";

import {
  buildReviewUserText,
  describeRunNote,
  mergeRunNotes,
  readRunNotes,
  runNote,
  runNotesForReviewer,
  RUN_NOTES_KEPT,
  type RunNote,
} from "@tawd/core/mockups";

/*
  Run notes: what TAWD's own code changed (stage 1 of docs/plans/self-check.md).

  The fault being fixed is not that code substitutes things - it has to, and
  it is free - but that it did so silently. The Creative Director then wrote
  fixes the builder could not make, every round of that review was paid for,
  and the score could not move. These tests hold the two promises: nothing
  code changed goes unsaid, and the reviewer is told not to ask for it back.
*/

const icon: RunNote = {
  step: "icons",
  action: "substituted",
  what: '"retractable awnings"',
  with: "a plain dot",
  why: "TAWD's icon set has no icon for that word",
};

describe("a run note", () => {
  it("needs something to report: no what, or no why, is not a note", () => {
    expect(runNote({ ...icon, what: "   " })).toBeNull();
    expect(runNote({ ...icon, why: "" })).toBeNull();
    expect(runNote(icon)).not.toBeNull();
  });

  it("tidies the fields, so a note can never carry a page's worth of text into a prompt", () => {
    const long = runNote({ ...icon, what: `"${"x".repeat(400)}"`, why: `y\n\n   ${"z".repeat(400)}` });
    expect(long!.what.length).toBeLessThanOrEqual(120);
    expect(long!.why.length).toBeLessThanOrEqual(120);
    expect(long!.why).not.toContain("\n");
  });

  it("reads as a sentence a person can act on", () => {
    expect(describeRunNote(icon)).toBe(
      'icons: used a plain dot for "retractable awnings" — TAWD\'s icon set has no icon for that word.',
    );
  });
});

describe("merging a run's notes", () => {
  it("counts the same thing happening twice instead of saying it twice", () => {
    const merged = mergeRunNotes([icon, icon, { ...icon, what: '"sunrooms"' }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.times).toBe(2);
    expect(describeRunNote(merged[0]!)).toContain("(2 times)");
    expect(merged[1]!.times).toBe(1);
  });

  it("keeps the order the work happened in, across every step that reported", () => {
    const contrast: RunNote = { step: "contrast", action: "changed", what: "a heading", why: "it failed contrast" };
    expect(mergeRunNotes([icon], [contrast]).map((n) => n.step)).toEqual(["icons", "contrast"]);
  });

  it("is capped, so a page of a thousand slots can't flood the version or the prompt", () => {
    const many = Array.from({ length: RUN_NOTES_KEPT + 25 }, (_, i) => ({ ...icon, what: `"word ${i}"` }));
    expect(mergeRunNotes(many)).toHaveLength(RUN_NOTES_KEPT);
  });

  it("ignores nothing at all", () => {
    expect(mergeRunNotes(null, undefined, [])).toEqual([]);
  });
});

describe("reading the notes back off a stored version", () => {
  it("reads what was stored, with its count", () => {
    const notes = readRunNotes({ runNotes: [{ ...icon, times: 3 }] });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.times).toBe(3);
  });

  it("trusts nothing in the column: a version stored before run notes existed has none", () => {
    expect(readRunNotes(null)).toEqual([]);
    expect(readRunNotes({})).toEqual([]);
    expect(readRunNotes({ runNotes: "icons: a dot" })).toEqual([]);
    expect(readRunNotes({ runNotes: [{ step: "icons" }] })).toEqual([]);
    // A made-up action is not an action.
    expect(readRunNotes({ runNotes: [{ ...icon, action: "deleted everything" }] })).toEqual([]);
  });

  it("defaults a missing or silly count to once", () => {
    expect(readRunNotes({ runNotes: [{ ...icon, times: 0 }] })[0]!.times).toBe(1);
    expect(readRunNotes({ runNotes: [icon] })[0]!.times).toBe(1);
  });
});

describe("what the Creative Director is told", () => {
  it("says nothing when code changed nothing", () => {
    expect(runNotesForReviewer([])).toBe("");
  });

  it("names every change and forbids asking the builder to undo it", () => {
    const block = runNotesForReviewer(mergeRunNotes([icon]));
    expect(block).toContain("What TAWD's own code did to this page");
    expect(block).toContain('"retractable awnings"');
    expect(block).toContain("the builder cannot undo them");
  });

  it("reaches the real reviewer prompt, beside what TAWD measured", () => {
    const text = buildReviewUserText({
      pass: "first",
      concepts: [
        {
          label: "A",
          direction: "classic_trust",
          checksSummary: "All passed",
          html: "<h1>Hi</h1>",
          measured: { line: "3 photos across 6 bands", mustFix: [] },
          runNotes: mergeRunNotes([icon]),
        },
      ],
      factsKnown: "a",
      factsMissing: "b",
    });
    expect(text).toContain("Measured by TAWD: 3 photos across 6 bands.");
    expect(text).toContain("What TAWD's own code did to this page");
    expect(text).toContain("the builder cannot undo them");
  });

  it("leaves the prompt as it was when there is nothing to report", () => {
    const text = buildReviewUserText({
      pass: "first",
      concepts: [{ label: "A", direction: "classic_trust", checksSummary: "All passed", html: "<h1>Hi</h1>", runNotes: [] }],
      factsKnown: "a",
      factsMissing: "b",
    });
    expect(text).not.toContain("What TAWD's own code did");
  });
});
