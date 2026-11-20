import { describe, expect, it } from "vitest";

import { EDGE_MATCH, MIN_HEIGHT, applyBandCorrections, changeProblem, matchBand, spanMatch, type BandCorrection, type CorrectableBand } from "@tawd/core/figma/read-corrections";

/*
  E4b-2: how a person's corrections to the new read's band list apply, also
  after the design is read again (Jason, 14 November: a re-read keeps the
  corrections where the band is still there).
*/

const READ: CorrectableBand[] = [
  { name: "Header", role: "header", top: 0, bottom: 120 },
  { name: "Hero", role: "band", top: 120, bottom: 620 },
  { name: "Services", role: "band", top: 620, bottom: 1000 },
  { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
];

let n = 0;
const fix = (anchor: [number, number], change: BandCorrection["change"], at = `2026-11-14T10:${String(n).padStart(2, "0")}:00.000Z`): BandCorrection => ({
  id: `c${++n}`,
  anchor: { top: anchor[0], bottom: anchor[1] },
  change,
  madeOnRun: "run-a",
  by: "Jason",
  at,
});

describe("matching a correction to a band", () => {
  it("scores overlap over the two spans together", () => {
    expect(spanMatch({ top: 0, bottom: 100 }, { top: 0, bottom: 100 })).toBe(1);
    expect(spanMatch({ top: 0, bottom: 100 }, { top: 50, bottom: 150 })).toBeCloseTo(50 / 150);
    expect(spanMatch({ top: 0, bottom: 100 }, { top: 100, bottom: 200 })).toBe(0);
  });

  it("takes the band that overlaps most, and none under half", () => {
    expect(matchBand(READ, { top: 118, bottom: 622 })).toMatchObject({ index: 1, tied: false });
    expect(matchBand(READ, { top: 400, bottom: 900 })).toMatchObject({ index: -1 });
    // A band read as two equal halves: both match equally.
    expect(matchBand([{ top: 120, bottom: 370 }, { top: 370, bottom: 620 }], { top: 120, bottom: 620 })).toMatchObject({ score: 0.5, tied: true });
  });
});

describe("applying corrections to the read they were made on", () => {
  it("renames and re-kinds a band, marks it corrected, and keeps where it was read", () => {
    const c = fix([120, 620], { name: "Hero with form", role: "header" });
    const { bands, unmatched, problems } = applyBandCorrections(READ, [c], 1200, "run-a");
    expect(bands[1]).toMatchObject({ name: "Hero with form", role: "header", top: 120, bottom: 620, asRead: { top: 120, bottom: 620 }, corrected: { by: "Jason", at: c.at, ids: [c.id] } });
    expect(bands[0]!.corrected).toBeNull();
    expect(unmatched).toEqual([]);
    expect(problems).toEqual([]);
    // The read itself is never changed.
    expect(READ[1]!.name).toBe("Hero");
  });

  it("moves the neighbours' edges with a band's, so the bands still cover the page", () => {
    const { bands } = applyBandCorrections(READ, [fix([120, 620], { top: 100, bottom: 650 })], 1200, "run-a");
    expect(bands.map((b) => [b.top, b.bottom])).toEqual([
      [0, 100],
      [100, 650],
      [650, 1000],
      [1000, 1200],
    ]);
  });

  it("refuses an edge change that moves the page's own top or bottom, leaves the page, or squeezes a band, and still applies the rest", () => {
    const cases: [BandCorrection, RegExp][] = [
      [fix([0, 120], { top: 10, name: "Top bar" }), /first band starts at the top/],
      [fix([1000, 1200], { bottom: 1100 }), /last band ends at the bottom/],
      [fix([120, 620], { top: 120, bottom: 120 + MIN_HEIGHT - 1 }), new RegExp(`at least ${MIN_HEIGHT} px`)],
      [fix([120, 620], { top: 5 }), /leave "Header" above it under/],
      [fix([620, 1000], { bottom: 1195 }), /leave "Footer" below it under/],
    ];
    for (const [c, why] of cases) {
      const { bands, problems } = applyBandCorrections(READ, [c], 1200, "run-a");
      expect(problems).toHaveLength(1);
      expect(problems[0]!.id).toBe(c.id);
      expect(problems[0]!.reason).toMatch(why);
      expect(bands.map((b) => [b.top, b.bottom])).toEqual(READ.map((b) => [b.top, b.bottom]));
    }
    // The name in the same correction still applies.
    expect(applyBandCorrections(READ, [cases[0]![0]], 1200, "run-a").bands[0]!.name).toBe("Top bar");
  });

  it("applies corrections oldest first, a later one winning for what it changes", () => {
    const first = fix([120, 620], { name: "Hero", role: "header" }, "2026-11-14T10:00:00.000Z");
    const second = fix([120, 620], { name: "Big hero" }, "2026-11-14T11:00:00.000Z");
    const { bands } = applyBandCorrections(READ, [second, first], 1200, "run-a");
    expect(bands[1]).toMatchObject({ name: "Big hero", role: "header", corrected: { at: second.at, ids: [first.id, second.id] } });
  });

  it("still finds a band its neighbour's correction squeezed, by where it was read", () => {
    // The hero grows to 992, leaving Services 8 px (992 to 1000): as corrected it barely overlaps its anchor, as read it is the same band.
    const grow = fix([120, 620], { bottom: 992 }, "2026-11-14T10:00:00.000Z");
    const rename = fix([620, 1000], { name: "What we do" }, "2026-11-14T11:00:00.000Z");
    const { bands, unmatched } = applyBandCorrections(READ, [grow, rename], 1200, "run-a");
    expect(bands[2]).toMatchObject({ name: "What we do", top: 992, bottom: 1000 });
    expect(unmatched).toEqual([]);
  });

  it("finds a band moved by one correction for the next one, by where it was read", () => {
    const moved = fix([120, 620], { bottom: 900 }, "2026-11-14T10:00:00.000Z");
    const renamed = fix([120, 620], { name: "Tall hero" }, "2026-11-14T11:00:00.000Z");
    const { bands, unmatched } = applyBandCorrections(READ, [moved, renamed], 1200, "run-a");
    expect(bands[1]).toMatchObject({ name: "Tall hero", top: 120, bottom: 900 });
    expect(unmatched).toEqual([]);
  });
});

describe("after the design is read again (Jason, 14 November: corrections are kept)", () => {
  it("applies a correction to the band in the same place, even when the new read's edges differ a little", () => {
    const reRead: CorrectableBand[] = [
      { name: "Top", role: "header", top: 0, bottom: 116 },
      { name: "Main", role: "band", top: 116, bottom: 628 },
      { name: "What we do", role: "band", top: 628, bottom: 1004 },
      { name: "Bottom", role: "footer", top: 1004, bottom: 1200 },
    ];
    const { bands, unmatched } = applyBandCorrections(reRead, [fix([120, 620], { name: "Hero with form" })], 1200, "run-b");
    expect(bands.map((b) => b.name)).toEqual(["Top", "Hero with form", "What we do", "Bottom"]);
    expect(unmatched).toEqual([]);
  });

  it("lists a correction no band matches any more, and applies it nowhere", () => {
    // The hero was read as three parts this time: none overlaps the old hero by half (the largest, 180 of 500 px).
    const reRead: CorrectableBand[] = [
      { name: "Header", role: "header", top: 0, bottom: 120 },
      { name: "Hero top", role: "band", top: 120, bottom: 300 },
      { name: "Hero middle", role: "band", top: 300, bottom: 450 },
      { name: "Hero bottom", role: "band", top: 450, bottom: 620 },
      { name: "Services", role: "band", top: 620, bottom: 1000 },
      { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
    ];
    const c = fix([120, 620], { name: "Hero with form" });
    const { bands, unmatched } = applyBandCorrections(reRead, [c], 1200, "run-b");
    expect(unmatched).toEqual([{ correction: c, why: "gone" }]);
    expect(bands.every((b) => b.corrected === null)).toBe(true);
    expect(bands.map((b) => b.name)).toEqual(reRead.map((b) => b.name));
  });

  it("gives a correction to neither band when two of the new read are in its place equally", () => {
    const halves: CorrectableBand[] = [
      { name: "Header", role: "header", top: 0, bottom: 120 },
      { name: "Hero top", role: "band", top: 120, bottom: 370 },
      { name: "Hero bottom", role: "band", top: 370, bottom: 620 },
      { name: "Services", role: "band", top: 620, bottom: 1000 },
      { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
    ];
    const c = fix([120, 620], { name: "Hero with form" });
    const { bands, unmatched } = applyBandCorrections(halves, [c], 1200, "run-b");
    expect(unmatched).toEqual([{ correction: c, why: "tied" }]);
    expect(bands.every((b) => b.corrected === null)).toBe(true);
  });

  // Fable's review: two bands merged in a re-read must not be shrunk (nor their neighbour stretched) by edges set on the old read.
  it("carries a name to a band read in another place, but not edges set on an earlier read, and says so", () => {
    const merged: CorrectableBand[] = [
      { name: "Header", role: "header", top: 0, bottom: 120 },
      { name: "Hero", role: "band", top: 120, bottom: 620 },
      { name: "Services", role: "band", top: 620, bottom: 1000 },
      { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
    ];
    // Made on read A, where the hero was 120-400 (a smaller band); the re-read's hero overlaps it at 280/500.
    const c = { ...fix([120, 400], { name: "Hero with form", bottom: 380 }), madeOnRun: "run-a" };
    const { bands, problems } = applyBandCorrections(merged, [c], 1200, "run-b");
    expect(bands[1]).toMatchObject({ name: "Hero with form", top: 120, bottom: 620 });
    expect(bands[2]).toMatchObject({ top: 620, corrected: null });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.text).toBe('The correction of "Hero with form" was applied without its edges: it was read in a different place this time (120 to 620 px, not 120 to 400), so edges set on an earlier read were not carried over; correct them again if needed.');
    // On the read it was made on, the same edges apply.
    expect(applyBandCorrections(merged, [{ ...c, madeOnRun: "run-b" }], 1200, "run-b").bands[1]).toMatchObject({ bottom: 380 });
  });

  it("carries edges to a re-read that found the band in nearly the same place", () => {
    const close: CorrectableBand[] = [
      { name: "Header", role: "header", top: 0, bottom: 118 },
      { name: "Hero", role: "band", top: 118, bottom: 622 },
      { name: "Services", role: "band", top: 622, bottom: 1000 },
      { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
    ];
    expect(spanMatch({ top: 118, bottom: 622 }, { top: 120, bottom: 620 })).toBeGreaterThanOrEqual(EDGE_MATCH);
    const { bands, problems } = applyBandCorrections(close, [fix([120, 620], { bottom: 650 })], 1200, "run-b");
    expect(bands[1]).toMatchObject({ bottom: 650 });
    expect(problems).toEqual([]);
  });

  it("says a stored correction that can't be applied is a problem, not a band that went missing", () => {
    const broken = { ...fix([120, 620], {}), change: { colour: "red" } as unknown as BandCorrection["change"] };
    const { unmatched, problems } = applyBandCorrections(READ, [broken], 1200, "run-a");
    expect(unmatched).toEqual([]);
    expect(problems[0]!.text).toContain("can't be applied: Only a band's name, kind, top and bottom can be corrected.");
  });
});

describe("what a change may say", () => {
  it("refuses an empty change, unknown fields, a bad name or kind, and edges that aren't whole numbers", () => {
    expect(changeProblem({})).toBe("Nothing was changed.");
    expect(changeProblem({ name: "  " })).toMatch(/1 to 80 characters/);
    expect(changeProblem({ name: "x".repeat(81) })).toMatch(/1 to 80 characters/);
    expect(changeProblem({ role: "sidebar" as never })).toMatch(/header, a band or a footer/);
    expect(changeProblem({ top: 1.5 })).toMatch(/whole number/);
    expect(changeProblem({ top: -1 })).toMatch(/whole number/);
    expect(changeProblem({ top: null as never })).toMatch(/whole number/);
    expect(changeProblem({ bottom: "600" as never })).toMatch(/whole number/);
    expect(changeProblem({ name: "Hero", top: 0, bottom: 10, role: "band" })).toBeNull();
  });
});
