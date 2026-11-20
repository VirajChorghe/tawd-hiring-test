import { describe, expect, it } from "vitest";

import type { AssetSheet } from "@tawd/core/figma/read-assets";
import type { ItemCorrection, PictureChange, WordChange } from "@tawd/core/figma/read-item-corrections";
import type { BandChange, BandCorrection } from "@tawd/core/figma/read-corrections";

import { correctedRead, sheetEntries } from "./design-page-job";
import type { DesignRead } from "./design-read-types";

/*
  E5a: what the build is given is the read as a person has corrected it,
  and the pictures as the sheet actually prepared them. Both are worked out
  here, before the one paid call, so the call never sees a word or a kind
  somebody has already put right.
*/

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const TITLE = box(40, 30, 300, 40);
const BLUR = box(40, 90, 400, 50);
const LOGO = box(40, 200, 120, 60);

const READ: DesignRead = {
  runId: "design-read-p-1",
  width: 1000,
  height: 800,
  colours: [],
  notes: [],
  bands: [
    {
      band: { name: "Header", role: "header", top: 0, bottom: 300 },
      words: [
        { text: "Pat Rivera", role: "heading", box: TITLE },
        { text: "Plumbing & Heatlng", role: "paragraph", box: BLUR, unsure: true },
      ],
      points: [],
      fonts: [],
      pictures: [{ id: "a1", kind: "photo", box: LOGO }],
      notes: [],
    },
    {
      band: { name: "Hero", role: "band", top: 300, bottom: 800 },
      words: [],
      points: [],
      fonts: [],
      pictures: [],
      notes: [],
    },
  ],
} as unknown as DesignRead;

const wordFix = (anchor: typeof TITLE, change: WordChange): ItemCorrection<WordChange> => ({
  id: "w1",
  anchor,
  change,
  madeOnRun: "design-read-p-1",
  by: "Jason",
  at: "2026-11-15T10:00:00.000Z",
});

const pictureFix = (anchor: typeof LOGO, change: PictureChange): ItemCorrection<PictureChange> => ({
  id: "p1",
  anchor,
  change,
  madeOnRun: "design-read-p-1",
  by: "Jason",
  at: "2026-11-15T10:00:00.000Z",
});

describe("the read the build is given", () => {
  it("is the read itself when nobody corrected anything", () => {
    const out = correctedRead(READ, [], [], []);
    expect(out.bands[0]!.words.map((w) => w.text)).toEqual(["Pat Rivera", "Plumbing & Heatlng"]);
    expect(out.bands[0]!.pictures[0]!.kind).toBe("photo");
  });

  it("carries a corrected word, and the word is no longer unsure", () => {
    const out = correctedRead(READ, [], [wordFix(BLUR, { text: "Plumbing & Heating" })], []);
    expect(out.bands[0]!.words[1]!.text).toBe("Plumbing & Heating");
    expect(out.bands[0]!.words[1]!.unsure).toBe(false);
    // The word nobody touched is left exactly as read.
    expect(out.bands[0]!.words[0]!.text).toBe("Pat Rivera");
  });

  it("carries a corrected picture kind", () => {
    const out = correctedRead(READ, [], [], [pictureFix(LOGO, { kind: "logo" })]);
    expect(out.bands[0]!.pictures[0]!.kind).toBe("logo");
  });

  it("carries both at once", () => {
    const out = correctedRead(READ, [], [wordFix(TITLE, { role: "paragraph" })], [pictureFix(LOGO, { kind: "logo" })]);
    expect(out.bands[0]!.words[0]!.role).toBe("paragraph");
    expect(out.bands[0]!.pictures[0]!.kind).toBe("logo");
  });

  it("never changes the saved read it was given", () => {
    correctedRead(READ, [], [wordFix(BLUR, { text: "Plumbing & Heating" })], [pictureFix(LOGO, { kind: "logo" })]);
    expect(READ.bands[0]!.words[1]!.text).toBe("Plumbing & Heatlng");
    expect(READ.bands[0]!.pictures[0]!.kind).toBe("photo");
  });
});

describe("the pictures the build is given", () => {
  const sheet = (over: Partial<AssetSheet>): AssetSheet =>
    ({ runId: "r", version: "v", page: 1, preparedAt: "2026-11-15T10:00:00.000Z", assets: [], error: null, ...over }) as AssetSheet;

  const asset = {
    id: "a1",
    kind: "photo" as const,
    box: LOGO,
    file: "p1.png",
    width: 120,
    height: 60,
    icon: null,
    patches: [],
    transparentOn: null,
    fadedEdges: [],
    flags: ["one edge faded"],
  };

  it("are what the sheet prepared, with its flags", () => {
    expect(sheetEntries(sheet({ assets: [asset] }))).toEqual([{ id: "a1", kind: "photo", box: LOGO, file: "p1.png", icon: null, flags: ["one edge faded"] }]);
  });

  it("are none at all when the pictures were never prepared", () => {
    expect(sheetEntries(null)).toEqual([]);
  });

  /*
    A sheet that failed comes back with an empty list and an error. Treating
    it as "no pictures" is right: the plan then keeps each picture the read
    found, with no file, and flags it for an upload. Treating its empty list
    as the truth would quietly build a page with no pictures and nothing
    said.
  */
  it("are none at all when preparing them failed", () => {
    expect(sheetEntries(sheet({ assets: [asset], error: "could not be prepared" }))).toEqual([]);
  });
});

/*
  Band corrections change a band's name, what it is, and where it starts and
  ends. The build has to see them: which band is the header decides the whole
  menu, and the tops and heights decide where every band is drawn. They were
  loaded but never applied until Fable's review of E5a found it.
*/
describe("band corrections reach the build", () => {
  const bandFix = (anchor: { top: number; bottom: number }, change: BandChange): BandCorrection => ({
    id: "b1",
    anchor,
    change,
    madeOnRun: "design-read-p-1",
    by: "Jason",
    at: "2026-11-15T10:00:00.000Z",
  });

  it("carries a corrected band name", () => {
    const out = correctedRead(READ, [bandFix({ top: 0, bottom: 300 }, { name: "Top bar" })], [], []);
    expect(out.bands[0]!.band.name).toBe("Top bar");
  });

  it("carries a corrected role, which is what decides the menu", () => {
    const out = correctedRead(READ, [bandFix({ top: 0, bottom: 300 }, { role: "band" })], [], []);
    expect(out.bands[0]!.band.role).toBe("band");
  });

  /*
    Moving one band's edge moves its neighbour's with it, so the bands still
    cover the page: that is the rule the band corrections were built with
    (E4b-2a), and the build gets the result of it, not a raw number.
  */
  it("carries a corrected edge, and moves the neighbouring band's with it", () => {
    const out = correctedRead(READ, [bandFix({ top: 0, bottom: 300 }, { bottom: 250 })], [], []);
    expect(out.bands[0]!.band.bottom).toBe(250);
    expect(out.bands[1]!.band.top).toBe(250);
  });

  it("leaves the read alone when nobody corrected a band", () => {
    const out = correctedRead(READ, [], [], []);
    expect(out.bands[0]!.band).toEqual({ name: "Header", role: "header", top: 0, bottom: 300 });
  });

  it("never changes the saved read it was given", () => {
    correctedRead(READ, [bandFix({ top: 0, bottom: 300 }, { name: "Top bar" })], [], []);
    expect(READ.bands[0]!.band.name).toBe("Header");
  });
});
