import { describe, expect, it } from "vitest";

import { checkAssets, describeRepeatedPhotos, isFixable, photoTokenUses, spreadRepeatedPhotos, type PageAsset } from "@tawd/core/mockups";

/*
  F8 (9 November 2026): the same photograph in several bands.

  Nothing stopped the builder putting one photo token in three places, and
  nothing noticed - the page looked to the checks like a page with pictures,
  and the Creative Director marked the repetition down as a design fault the
  builder had not been told about.

  Code counts the uses and swaps each repeat for a photo nobody used. With
  nothing spare it says so and leaves the page alone: a repeat is better
  than an empty frame.
*/

const photo = (n: number): PageAsset => ({ token: `tawd-asset:photo-${n}`, kind: "photo", caption: `Photo ${n}` }) as PageAsset;
const band = (token: string) => `<section><img src="${token}" alt="x"></section>`;
const page = (...tokens: string[]) => `<html><body>${tokens.map(band).join("")}</body></html>`;

describe("counting a page's photographs", () => {
  it("counts every photograph of the client's, uploaded or read from their site, but not the logo", () => {
    const html = `${page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:photo-2")}<img src="tawd-asset:logo"><img src="tawd-asset:photo-site-3">`;
    expect([...photoTokenUses(html)]).toEqual([
      ["tawd-asset:photo-1", 2],
      ["tawd-asset:photo-2", 1],
      // A photo read from the client's current site is one of their photographs too.
      ["tawd-asset:photo-site-3", 1],
    ]);
    expect(photoTokenUses(html).has("tawd-asset:logo")).toBe(false);
  });

  it("is blind to case, as the token pattern is", () => {
    expect(photoTokenUses('<img src="TAWD-ASSET:PHOTO-1"><img src="tawd-asset:photo-1">').get("tawd-asset:photo-1")).toBe(2);
  });
});

describe("spreading the repeats", () => {
  const all = [1, 2, 3, 4].map((n) => `tawd-asset:photo-${n}`);

  it("keeps the first use where the builder put it and gives the rest unused photos, in upload order", () => {
    const { html, swapped } = spreadRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:photo-1"), all);
    expect(swapped).toEqual([
      { from: "tawd-asset:photo-1", to: "tawd-asset:photo-2" },
      { from: "tawd-asset:photo-1", to: "tawd-asset:photo-3" },
    ]);
    expect([...photoTokenUses(html).values()]).toEqual([1, 1, 1]);
  });

  it("leaves a page alone when every photo is used once", () => {
    const html = page("tawd-asset:photo-1", "tawd-asset:photo-2");
    expect(spreadRepeatedPhotos(html, all)).toEqual({ html, swapped: [] });
  });

  it("leaves a page alone when there is nothing spare: a repeat beats an empty frame", () => {
    const html = page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:photo-2");
    expect(spreadRepeatedPhotos(html, ["tawd-asset:photo-1", "tawd-asset:photo-2"])).toEqual({ html, swapped: [] });
  });

  it("swaps as many as it can and leaves the rest repeated", () => {
    const { html, swapped } = spreadRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:photo-1"), [
      "tawd-asset:photo-1",
      "tawd-asset:photo-2",
    ]);
    expect(swapped).toEqual([{ from: "tawd-asset:photo-1", to: "tawd-asset:photo-2" }]);
    expect(photoTokenUses(html).get("tawd-asset:photo-1")).toBe(2);
  });

  /*
    CodeRabbit on PR #65. The designer flows upload their pictures as photos
    named design-image-N, which photoTokenUses does not count, so a spare
    chosen from the counts alone could be a picture already on the page -
    making a new repeat that nothing would notice. A spare is judged against
    every token the page refers to.
  */
  it("never hands back a picture already on the page, whatever it is named", () => {
    const html = page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:design-image-7");
    const { html: out, swapped } = spreadRepeatedPhotos(html, ["tawd-asset:photo-1", "tawd-asset:design-image-7"]);
    // design-image-7 is already in a band, so there is nothing spare and the page is left alone.
    expect(swapped).toEqual([]);
    expect(out).toBe(html);
  });

  it("changes nothing a second time: the page is settled once it is spread", () => {
    const once = spreadRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1"), all).html;
    expect(spreadRepeatedPhotos(once, all)).toEqual({ html: once, swapped: [] });
  });
});

describe("what the reviewer is told about a forced repeat", () => {
  const two = ["tawd-asset:photo-1", "tawd-asset:photo-2"];

  it("is silent when nothing repeats", () => {
    expect(describeRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-2"), two)).toBeNull();
  });

  it("is silent when a photo was spare (the repeat should have been swapped)", () => {
    expect(describeRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1"), two)).toBeNull();
  });

  it("states only what the code knows: which photo, how many times, and that none was spare", () => {
    const line = describeRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1", "tawd-asset:photo-2"), two)!;
    expect(line).toContain("photo-1 2 times");
    expect(line).toContain("2 uploaded photographs");
    expect(line).not.toContain("photo-2 ");
    // No claims about why the builder did it or what it could have done.
    expect(line).not.toMatch(/for this page|avoid/);
  });

  it("is singular for one photograph", () => {
    const line = describeRepeatedPhotos(page("tawd-asset:photo-1", "tawd-asset:photo-1"), ["tawd-asset:photo-1"])!;
    expect(line).toContain("1 uploaded photograph is");
  });
});

describe("what the team is told", () => {
  it("fails while there is an unused photo to put in its place, so code fixes it", () => {
    const issues = checkAssets(page("tawd-asset:photo-1", "tawd-asset:photo-1"), [photo(1), photo(2)]);
    const repeat = issues.find((i) => i.id === "images.repeatedPhoto")!;
    expect(repeat.severity).toBe("fail");
    expect(isFixable(repeat)).toBe(true);
    expect(repeat.message).toContain("1 uploaded photo is unused");
  });

  it("only warns when there is nothing spare, so no fix round is spent on it", () => {
    const issues = checkAssets(page("tawd-asset:photo-1", "tawd-asset:photo-1"), [photo(1)]);
    const repeat = issues.find((i) => i.id === "images.repeatedPhoto")!;
    expect(repeat.severity).toBe("warn");
    expect(isFixable(repeat)).toBe(false);
    expect(repeat.message).toContain("no unused photo");
  });

  it("says nothing when every photo is used once", () => {
    const issues = checkAssets(page("tawd-asset:photo-1", "tawd-asset:photo-2"), [photo(1), photo(2)]);
    expect(issues.some((i) => i.id === "images.repeatedPhoto")).toBe(false);
  });
});
