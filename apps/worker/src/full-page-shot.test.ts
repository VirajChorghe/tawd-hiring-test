import { describe, expect, it } from "vitest";

import { fullPageShotOptions } from "./render";

/*
  The picture of a tall page (9 November 2026, a client's site): every saved
  version was 12,000px tall with 16 bands, yet the concept screen showed
  the hero alone. A clip taller than the viewport is only captured with
  fullPage: true — the review's slices already pass it, the full-page shot
  did not, so every concept over the height cap was photographed as its
  first screen.
*/
describe("the full-page picture", () => {
  it("takes the whole page when it fits under the cap", () => {
    const options = fullPageShotOptions(8_000);
    expect(options.fullPage).toBe(true);
    expect(options.clip).toBeUndefined();
  });

  it("keeps fullPage when it has to clip a page over the cap", () => {
    const options = fullPageShotOptions(13_493);
    expect(options.fullPage).toBe(true);
    expect(options.clip).toEqual({ x: 0, y: 0, width: 1440, height: 12_000 });
  });

  it("never clips without fullPage, at any height", () => {
    for (const height of [900, 11_400, 12_000, 12_001, 13_493, 40_000]) {
      const options = fullPageShotOptions(height);
      expect(options.fullPage, `height ${height}`).toBe(true);
    }
  });
});
