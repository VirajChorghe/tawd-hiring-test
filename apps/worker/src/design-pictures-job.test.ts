import { describe, expect, it } from "vitest";

import type { ItemCorrection, PictureChange } from "@tawd/core/figma/read-item-corrections";

import { filesToClear, readWithCorrectedPictures } from "./design-pictures-job";
import { mayWriteStatus, type AssetSheet } from "@tawd/core/figma/read-assets";

import type { BandRead, DesignRead } from "./design-read-types";

/*
  E4b-2b: a person's corrections to the pictures reach the free prepare, so
  a kind read wrong can be put right without paying for the read again.
*/

const band = (name: string, top: number, bottom: number, pictures: BandRead["pictures"]): BandRead => ({
  band: { name, role: "band", top, bottom },
  words: [],
  points: [],
  fonts: [],
  pictures,
  notes: [],
});

const READ: DesignRead = {
  runId: "design-read-p-1",
  width: 1400,
  height: 4056,
  colours: [],
  notes: [],
  bands: [
    band("Hero", 0, 800, [{ id: "a1", kind: "photo", box: { x: 0, y: 0, w: 1400, h: 800 } }]),
    band("Services", 800, 1600, [
      { id: "a2", kind: "photo", box: { x: 60, y: 900, w: 120, h: 120 } },
      { id: "a3", kind: "photo", box: { x: 400, y: 900, w: 120, h: 120 } },
    ]),
  ],
} as unknown as DesignRead;

let n = 0;
const fix = (anchor: { x: number; y: number; w: number; h: number }, change: PictureChange): ItemCorrection<PictureChange> => {
  n += 1;
  return { id: `c${n}`, anchor, change, madeOnRun: "design-read-p-1", by: "Jason", at: `2026-11-15T10:0${n}:00.000Z` };
};

describe("the corrections a free prepare uses", () => {
  it("gives the read back untouched when nobody corrected anything", () => {
    expect(readWithCorrectedPictures(READ, [])).toBe(READ);
  });

  it("changes the kind of the one picture it was made on, and leaves the rest", () => {
    const out = readWithCorrectedPictures(READ, [fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" })]);
    expect(out.bands[1]!.pictures[0]!.kind).toBe("logo");
    expect(out.bands[1]!.pictures[1]!.kind).toBe("photo");
    expect(out.bands[0]!.pictures[0]!.kind).toBe("photo");
  });

  it("moves a picture's box", () => {
    const out = readWithCorrectedPictures(READ, [fix({ x: 0, y: 0, w: 1400, h: 800 }, { box: { x: 0, y: 40, w: 1400, h: 700 } })]);
    expect(out.bands[0]!.pictures[0]!.box).toEqual({ x: 0, y: 40, w: 1400, h: 700 });
  });

  it("matches across the whole page, so a picture in the second band is not confused with the first", () => {
    const out = readWithCorrectedPictures(READ, [fix({ x: 400, y: 900, w: 120, h: 120 }, { kind: "icon" })]);
    expect(out.bands[1]!.pictures[1]!.kind).toBe("icon");
    expect(out.bands[1]!.pictures[0]!.kind).toBe("photo");
  });

  it("never changes the saved read it was given", () => {
    readWithCorrectedPictures(READ, [fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo", box: { x: 60, y: 905, w: 120, h: 120 } })]);
    expect(READ.bands[1]!.pictures[0]).toEqual({ id: "a2", kind: "photo", box: { x: 60, y: 900, w: 120, h: 120 } });
  });

  it("leaves a picture alone when the correction's box is off the page", () => {
    const out = readWithCorrectedPictures(READ, [fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo", box: { x: 1390, y: 900, w: 120, h: 120 } })]);
    // The kind still applies; the impossible box does not.
    expect(out.bands[1]!.pictures[0]!.kind).toBe("logo");
    expect(out.bands[1]!.pictures[0]!.box).toEqual({ x: 60, y: 900, w: 120, h: 120 });
  });
});

/*
  A picture's id is only unique within one call to the read, and a tall band is
  read in parts, one call per part, all under the same band number. So two
  pictures of one band can carry the same id. Putting the corrected pictures
  back by id would give both the last one's kind and box (Fable's review).
*/
describe("pictures of one band that share an id", () => {
  const TWINS: DesignRead = {
    runId: "design-read-p-1",
    width: 1400,
    height: 4056,
    colours: [],
    notes: [],
    bands: [
      band("Services", 0, 1600, [
        { id: "b1-icon", kind: "photo", box: { x: 60, y: 100, w: 120, h: 120 } },
        { id: "b1-icon", kind: "photo", box: { x: 60, y: 900, w: 120, h: 120 } },
      ]),
    ],
  } as unknown as DesignRead;

  it("corrects only the one the correction was made on", () => {
    const out = readWithCorrectedPictures(TWINS, [fix({ x: 60, y: 900, w: 120, h: 120 }, { kind: "logo" })]);
    expect(out.bands[0]!.pictures[0]!.kind).toBe("photo");
    expect(out.bands[0]!.pictures[1]!.kind).toBe("logo");
  });

  it("leaves both where they were read when the correction matches neither", () => {
    const out = readWithCorrectedPictures(TWINS, [fix({ x: 900, y: 3000, w: 120, h: 120 }, { kind: "logo" })]);
    expect(out.bands[0]!.pictures.map((p) => [p.kind, p.box.y])).toEqual([
      ["photo", 100],
      ["photo", 900],
    ]);
  });
});

describe("which files a finished prepare clears", () => {
  const sheet = (over: Partial<AssetSheet>): AssetSheet =>
    ({ runId: "r", version: "v", page: 1, preparedAt: "2026-11-15T10:00:00.000Z", assets: [], error: null, ...over }) as AssetSheet;

  it("clears what the last sheet named and this one does not", () => {
    const now = sheet({ assets: [{ id: "a", kind: "photo", box: { x: 0, y: 0, w: 1, h: 1 }, file: "p1.png", width: 1, height: 1, icon: null, patches: [], transparentOn: null, fadedEdges: [], flags: [] }] });
    expect(filesToClear(new Set(["p1.png", "p2.png"]), now)).toEqual(["p2.png"]);
  });

  it("clears nothing at all when the prepare failed, so the last good pictures survive", () => {
    expect(filesToClear(new Set(["p1.png", "p2.png"]), sheet({ error: "could not be prepared" }))).toEqual([]);
  });
});

describe("whether an attempt may still write the status", () => {
  const bytes = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

  it("lets an attempt write its own status, and a missing or unreadable one", () => {
    expect(mayWriteStatus(bytes({ attempt: "a1" }), "a1")).toBe(true);
    expect(mayWriteStatus(null, "a1")).toBe(true);
    expect(mayWriteStatus(Buffer.from("not json", "utf8"), "a1")).toBe(true);
  });

  it("stops an older attempt writing over a newer one", () => {
    expect(mayWriteStatus(bytes({ attempt: "a2" }), "a1")).toBe(false);
  });
});
