import { describe, expect, it } from "vitest";

import { compareToBaseline, type CanaryBaseline, type CanaryMeasurement } from "./canary";

/*
  The canary's own comparison. The measuring is proved by canary-run.test.ts
  against real Chrome; this covers the part that decides whether to shout.
*/

const measurement = (over: Partial<CanaryMeasurement> = {}): CanaryMeasurement => ({
  checks: ["icons.noIcon:warn"],
  placeholders: 0,
  rendered: [],
  heightPx: 3690,
  imageHeightPx: 3690,
  pictureHeightPx: 3690,
  pictureWidthPx: 1440,
  truncated: false,
  bands: 8,
  noIconWords: ["sunroom"],
  photoUses: { "tawd-asset:photo-1": 1 },
  richness: { clientPhotos: 1, stockFrames: 0, emptyFrames: 0, bands: 6, branded: true },
  fixRules: [],
  fixNotes: [],
  renderedAfterFixes: [],
  ...over,
});

describe("what the canary shouts about", () => {
  const baseline: CanaryBaseline = { "whole-page": measurement() };

  it("says nothing when every measurement is as recorded", () => {
    expect(compareToBaseline(baseline, { "whole-page": measurement() })).toEqual([]);
  });

  it("names the page, the measurement, and both values", () => {
    const [line, ...rest] = compareToBaseline(baseline, { "whole-page": measurement({ pictureHeightPx: 900 }) });
    expect(rest).toEqual([]);
    expect(line).toBe("whole-page.pictureHeightPx: was 3690, now 900");
  });

  it("notices a check appearing or disappearing, not only a number moving", () => {
    const quiet = compareToBaseline(baseline, { "whole-page": measurement({ checks: [] }) });
    expect(quiet).toEqual(['whole-page.checks: was ["icons.noIcon:warn"], now []']);
    const extra = compareToBaseline(baseline, { "whole-page": measurement({ checks: ["icons.noIcon:warn", "structure.truncated"] }) });
    expect(extra[0]).toContain("structure.truncated");
  });

  it("notices a photo used twice where it was used once", () => {
    const [line] = compareToBaseline(baseline, { "whole-page": measurement({ photoUses: { "tawd-asset:photo-1": 2 } }) });
    expect(line).toContain("photoUses");
    expect(line).toContain('"tawd-asset:photo-1":2');
  });

  it("reports every changed measurement, not just the first", () => {
    const many = compareToBaseline(baseline, { "whole-page": measurement({ heightPx: 10, bands: 2, truncated: true }) });
    expect(many).toHaveLength(3);
  });

  /*
    The measurement that cannot be fooled by a fix that did not take (New
    Dawn, 10 November 2026): TAWD wrote three contrast rules for the quote
    form, reported the contrast as fixed, and the page still failed.
  */
  it("notices that a check survived TAWD's own fixes", () => {
    const [line] = compareToBaseline(baseline, { "whole-page": measurement({ renderedAfterFixes: ["a11y.contrast"] }) });
    expect(line).toBe('whole-page.renderedAfterFixes: was [], now ["a11y.contrast"]');
  });

  it("notices a run note appearing or going quiet", () => {
    const [line] = compareToBaseline(baseline, { "whole-page": measurement({ fixNotes: ["contrast: substituted the text that was #ffffff with #12305a"] }) });
    expect(line).toContain("fixNotes");
    expect(line).toContain("#12305a");
  });

  it("says when a page has gone, so a fixture cannot be quietly deleted", () => {
    expect(compareToBaseline(baseline, {})).toEqual([
      "whole-page: in the baseline but not in this run (a fixture was removed or renamed).",
    ]);
  });

  it("says when a page is new, rather than passing it silently", () => {
    const [line] = compareToBaseline(baseline, { "whole-page": measurement(), "a-new-page": measurement() });
    expect(line).toBe("a-new-page: new, with no baseline. Run with --update to record it.");
  });
});
