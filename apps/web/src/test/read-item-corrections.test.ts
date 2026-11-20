import { describe, expect, it } from "vitest";

import {
  BOX_MATCH,
  MIN_SIZE,
  applyPictureCorrections,
  applyWordCorrections,
  boxMatch,
  matchItem,
  pictureChangeProblem,
  wordChangeProblem,
  type Box,
  type CorrectablePicture,
  type CorrectableWord,
  type ItemCorrection,
  type PictureChange,
  type WordChange,
} from "@tawd/core/figma/read-item-corrections";

/*
  E4b-2b: how a person's corrections to the new read's words and pictures
  apply, also after the design is read again. The same rules as the band
  list (read-corrections.test.ts), matched by area instead of height.
*/

const PAGE = { width: 1400, height: 4056 };

const WORDS: CorrectableWord[] = [
  { text: "Pat Rivera", role: "heading", box: { x: 40, y: 20, w: 300, h: 40 } },
  { text: "Plumbing & Heatlng", role: "heading", box: { x: 40, y: 70, w: 420, h: 60 }, unsure: true },
  { text: "Call 555 0199", role: "button", box: { x: 1100, y: 30, w: 220, h: 50 } },
];

const PICTURES: CorrectablePicture[] = [
  { id: "p1", kind: "photo", box: { x: 0, y: 200, w: 1400, h: 600 } },
  { id: "p2", kind: "photo", box: { x: 60, y: 900, w: 120, h: 120 } },
];

let n = 0;
function fix<C extends WordChange | PictureChange>(anchor: Box, change: C, over: Partial<ItemCorrection<C>> = {}): ItemCorrection<C> {
  n += 1;
  return { id: `c${n}`, anchor, change, madeOnRun: "run-a", by: "Jason", at: `2026-11-15T10:${String(n).padStart(2, "0")}:00.000Z`, ...over };
}

describe("matching a correction to an item", () => {
  it("scores shared area over the two boxes together", () => {
    expect(boxMatch({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(1);
    // Half of each box overlaps: 5000 shared over 15000 together.
    expect(boxMatch({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 })).toBeCloseTo(5000 / 15000);
    expect(boxMatch({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(0);
    // Touching only at a corner is not an overlap.
    expect(boxMatch({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 100, w: 100, h: 100 })).toBe(0);
    // Well apart on both axes: the gaps must never multiply into a false overlap.
    expect(boxMatch({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 100, h: 100 })).toBe(0);
    expect(boxMatch({ x: 200, y: 200, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(0);
  });

  it("takes the item that overlaps most, and none under half", () => {
    const boxes = WORDS.map((w) => w.box);
    expect(matchItem(boxes, { x: 42, y: 72, w: 418, h: 58 })).toMatchObject({ index: 1, tied: false });
    // A box over the gap between two words matches neither well enough.
    expect(matchItem(boxes, { x: 500, y: 300, w: 200, h: 40 })).toMatchObject({ index: -1 });
  });

  it("calls two equal matches a tie rather than picking one", () => {
    const halves = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 100, y: 0, w: 100, h: 100 },
    ];
    expect(matchItem(halves, { x: 0, y: 0, w: 200, h: 100 })).toMatchObject({ score: 0.5, tied: true });
  });
});

describe("what a change may say", () => {
  it("refuses an empty change, an unknown field and an unknown kind", () => {
    expect(wordChangeProblem({})).toBe("Nothing was changed.");
    expect(wordChangeProblem({ box: { x: 0, y: 0, w: 1, h: 1 } } as unknown as WordChange)).toMatch(/text and kind/);
    expect(wordChangeProblem({ text: "   " })).toMatch(/1 to 2000/);
    expect(wordChangeProblem({ role: "title" as never })).toMatch(/heading, a paragraph/);
    expect(pictureChangeProblem({ kind: "drawing" as never })).toMatch(/photo, a background/);
  });

  it("refuses a box that is off the page or too small to be meant", () => {
    expect(pictureChangeProblem({ box: { x: -1, y: 0, w: 50, h: 50 } })).toMatch(/starts inside the page/);
    expect(pictureChangeProblem({ box: { x: 0, y: 0, w: MIN_SIZE - 1, h: 50 } })).toMatch(new RegExp(`${MIN_SIZE} px`));
    expect(pictureChangeProblem({ box: { x: 0, y: 0, w: 10.5, h: 50 } as Box })).toMatch(/four whole numbers/);
  });
});

describe("correcting words", () => {
  it("fixes the text, clears 'unsure', and marks the word corrected", () => {
    const c = fix({ x: 40, y: 70, w: 420, h: 60 }, { text: "Plumbing & Heating" });
    const { items, problems, unmatched } = applyWordCorrections(WORDS, [c], "run-a");
    expect(problems).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(items[1]!.text).toBe("Plumbing & Heating");
    expect(items[1]!.unsure).toBe(false);
    expect(items[1]!.corrected).toMatchObject({ by: "Jason", ids: ["c1"] });
    // Every other word is untouched and unmarked.
    expect(items[0]!.corrected).toBeNull();
    expect(items[0]!.text).toBe("Pat Rivera");
  });

  it("clears 'unsure' whichever part of the word was corrected: a person has looked at it", () => {
    const kindOnly = fix({ x: 40, y: 70, w: 420, h: 60 }, { role: "paragraph" as const });
    const out = applyWordCorrections(WORDS, [kindOnly], "run-a");
    expect(out.items[1]!.role).toBe("paragraph");
    expect(out.items[1]!.unsure).toBe(false);
    // A word nobody corrected keeps whatever the read said.
    expect(applyWordCorrections(WORDS, [], "run-a").items[1]!.unsure).toBe(true);
  });

  it("keeps the word's box as read, so the next correction still finds it", () => {
    const first = fix({ x: 40, y: 70, w: 420, h: 60 }, { text: "Plumbing & Heating" });
    const second = fix({ x: 40, y: 70, w: 420, h: 60 }, { role: "paragraph" as const });
    const { items } = applyWordCorrections(WORDS, [first, second], "run-a");
    expect(items[1]!.text).toBe("Plumbing & Heating");
    expect(items[1]!.role).toBe("paragraph");
    expect(items[1]!.corrected?.ids).toEqual([first.id, second.id]);
    expect(items[1]!.asRead).toEqual({ x: 40, y: 70, w: 420, h: 60 });
  });

  it("applies corrections oldest first, so a later one wins", () => {
    const early = fix({ x: 40, y: 20, w: 300, h: 40 }, { text: "First" }, { at: "2026-11-15T09:00:00.000Z" });
    const late = fix({ x: 40, y: 20, w: 300, h: 40 }, { text: "Second" }, { at: "2026-11-15T11:00:00.000Z" });
    // Given newest first, the order is still oldest first.
    const { items } = applyWordCorrections(WORDS, [late, early], "run-a");
    expect(items[0]!.text).toBe("Second");
  });

  it("carries the text to a re-read that moved the word, and never guesses between two", () => {
    const c = fix({ x: 40, y: 70, w: 420, h: 60 }, { text: "Plumbing & Heating" });
    const moved: CorrectableWord[] = [{ text: "Plumbing & Heatlng", role: "heading", box: { x: 44, y: 76, w: 420, h: 60 } }];
    expect(applyWordCorrections(moved, [c], "run-b").items[0]!.text).toBe("Plumbing & Heating");

    // Read as two lines this time: neither half is the one it was made on.
    const split: CorrectableWord[] = [
      { text: "Plumbing", role: "heading", box: { x: 40, y: 70, w: 210, h: 60 } },
      { text: "& Heatlng", role: "heading", box: { x: 250, y: 70, w: 210, h: 60 } },
    ];
    const out = applyWordCorrections(split, [c], "run-b");
    expect(out.items.every((w) => w.corrected === null)).toBe(true);
    expect(out.unmatched).toHaveLength(1);
    expect(out.unmatched[0]).toMatchObject({ why: "tied" });
  });

  it("reports a correction whose word is gone, rather than dropping it", () => {
    const c = fix({ x: 40, y: 70, w: 420, h: 60 }, { text: "Plumbing & Heating" });
    const out = applyWordCorrections([WORDS[0]!], [c], "run-b");
    expect(out.unmatched).toHaveLength(1);
    expect(out.unmatched[0]).toMatchObject({ why: "gone" });
    expect(out.items[0]!.corrected).toBeNull();
  });
});

describe("correcting pictures", () => {
  it("changes the kind and keeps it across a re-read", () => {
    const c = fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" as const });
    expect(applyPictureCorrections(PICTURES, [c], "run-a", PAGE).items[1]!.kind).toBe("logo");
    const moved: CorrectablePicture[] = [{ id: "q", kind: "photo", box: { x: 66, y: 906, w: 120, h: 120 } }];
    expect(applyPictureCorrections(moved, [c], "run-b", PAGE).items[0]!.kind).toBe("logo");
  });

  it("sets the box on the read it was made on", () => {
    const c = fix({ x: 0, y: 200, w: 1400, h: 600 }, { box: { x: 0, y: 220, w: 1400, h: 560 } });
    const out = applyPictureCorrections(PICTURES, [c], "run-a", PAGE);
    expect(out.problems).toEqual([]);
    expect(out.items[0]!.box).toEqual({ x: 0, y: 220, w: 1400, h: 560 });
    expect(out.items[0]!.asRead).toEqual({ x: 0, y: 200, w: 1400, h: 600 });
  });

  it("refuses a box that leaves the design, and says so without losing the kind", () => {
    const c = fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" as const, box: { x: 1350, y: 900, w: 120, h: 120 } });
    const out = applyPictureCorrections(PICTURES, [c], "run-a", PAGE);
    expect(out.items[1]!.kind).toBe("logo");
    expect(out.items[1]!.box).toEqual({ x: 60, y: 900, w: 120, h: 120 });
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]!.text).toMatch(/stay inside the design \(1400 by 4056 px\)/);
  });

  it("does not carry an exact box to a picture read somewhere else, and says why", () => {
    const c = fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" as const, box: { x: 60, y: 910, w: 120, h: 100 } });
    // Overlapping, but under BOX_MATCH: the same picture read a good deal lower.
    const moved: CorrectablePicture[] = [{ id: "q", kind: "photo", box: { x: 60, y: 940, w: 120, h: 120 } }];
    const out = applyPictureCorrections(moved, [c], "run-b", PAGE);
    expect(boxMatch(moved[0]!.box, c.anchor)).toBeLessThan(BOX_MATCH);
    // The kind carries over; the box does not, and the panel is told.
    expect(out.items[0]!.kind).toBe("logo");
    expect(out.items[0]!.box).toEqual({ x: 60, y: 940, w: 120, h: 120 });
    expect(out.problems[0]!.text).toMatch(/read in a different place this time/);
    // It still counts as corrected: a person did change this picture.
    expect(out.items[0]!.corrected).not.toBeNull();
  });

  it("anchors a later correction to the box as read, not the box a correction moved", () => {
    // The first correction carries the small picture clear of where it was read.
    const moveIt = fix({ x: 60, y: 900, w: 120, h: 120 }, { box: { x: 60, y: 1300, w: 120, h: 120 } });
    const thenKind = fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" as const });
    // Nothing of the moved box is left where it was read, so matching on it would lose the second correction.
    expect(boxMatch({ x: 60, y: 1300, w: 120, h: 120 }, { x: 60, y: 900, w: 120, h: 120 })).toBe(0);
    const out = applyPictureCorrections(PICTURES, [moveIt, thenKind], "run-a", PAGE);
    expect(out.unmatched).toEqual([]);
    expect(out.items[1]!.box).toEqual({ x: 60, y: 1300, w: 120, h: 120 });
    expect(out.items[1]!.kind).toBe("logo");
    expect(out.items[1]!.corrected?.ids).toHaveLength(2);
  });

  it("leaves the read's own list untouched", () => {
    const c = fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" as const, box: { x: 60, y: 910, w: 120, h: 100 } });
    applyPictureCorrections(PICTURES, [c], "run-a", PAGE);
    expect(PICTURES[1]).toEqual({ id: "p2", kind: "photo", box: { x: 60, y: 900, w: 120, h: 120 } });
  });
});
