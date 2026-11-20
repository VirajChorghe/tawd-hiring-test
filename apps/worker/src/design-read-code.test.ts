import { describe, expect, it } from "vitest";
import { blank, type Rgba } from "./design-pixels";
import { checkCoverage, measureColours, parseBandList, snapEdges, tidyWords, toDesignSpec, toPictureRequests } from "./design-read-code";
import type { BandRead, DesignRead, ReadBand } from "./design-read-types";

function fill(img: Rgba, y0: number, y1: number, c: [number, number, number]) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
}
const band = (name: string, top: number, bottom: number, role: ReadBand["role"] = "band"): ReadBand => ({ name, role, top, bottom });

describe("parseBandList", () => {
  it("accepts a good list, rounds to whole pixels and trims names", () => {
    const r = parseBandList({ bands: [{ name: "  Top ", role: "header", top: 0.4, bottom: 99.6 }, { name: "Body", role: "band", top: 100, bottom: 300 }] }, 300);
    expect(r.problems).toEqual([]);
    expect(r.bands).toEqual([band("Top", 0, 100, "header"), band("Body", 100, 300)]);
  });
  it("names an empty band 'Band N' and turns an unknown role into band with a problem", () => {
    const r = parseBandList({ bands: [{ name: " ", role: "hero", top: 0, bottom: 50 }] }, 100);
    expect(r.bands).toEqual([band("Band 1", 0, 50)]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/hero/);
  });
  it("leaves out bands with bad numbers, top at or below bottom, or outside the page", () => {
    const r = parseBandList(
      { bands: [{ name: "a", role: "band", top: NaN, bottom: 5 }, { name: "b", role: "band", top: 50, bottom: 50 }, { name: "c", role: "band", top: -3, bottom: 40 }, { name: "d", role: "band", top: 10, bottom: 101 }, { name: "e", role: "band", top: "1", bottom: 9 }, { name: "ok", role: "band", top: 10, bottom: 20 }] },
      100,
    );
    expect(r.bands.map((b) => b.name)).toEqual(["ok"]);
    expect(r.problems).toHaveLength(5);
  });
  it("never throws on garbage: empty list and a problem", () => {
    for (const junk of [null, undefined, 7, "x", [], {}, { bands: "no" }, { bands: [null, 3, "s"] }]) {
      const r = parseBandList(junk, 100);
      expect(r.bands).toEqual([]);
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });
});

describe("checkCoverage", () => {
  it("closes small gaps and overlaps at the midpoint and snaps the page's top and bottom", () => {
    const r = checkCoverage([band("b", 104, 196), band("a", 6, 100, "header"), band("c", 190, 395, "footer")], 400);
    expect(r.problems).toEqual([]);
    expect(r.bands.map((b) => [b.name, b.top, b.bottom])).toEqual([["a", 0, 102], ["b", 102, 193], ["c", 193, 400]]);
  });
  it("reports gaps and overlaps bigger than 8 px, and never changes or removes a band", () => {
    const input = [band("a", 0, 100), band("b", 120, 200), band("c", 180, 400)];
    const r = checkCoverage(input, 400);
    expect(r.bands).toEqual(input);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/gap of 20/);
    expect(r.problems[1]).toMatch(/overlap by 20/);
  });
  it("reports a page not covered at the top or bottom", () => {
    const r = checkCoverage([band("a", 30, 100), band("b", 100, 300)], 400);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join(" ")).toMatch(/top of the page/);
    expect(r.problems.join(" ")).toMatch(/bottom of the page/);
  });
  it("reports a header not first, a footer not last, and two headers or footers", () => {
    const r = checkCoverage([band("a", 0, 100), band("h", 100, 200, "header"), band("f", 200, 300, "footer"), band("z", 300, 400)], 400);
    expect(r.problems.join(" ")).toMatch(/header, "h", is not the first/);
    expect(r.problems.join(" ")).toMatch(/footer, "f", is not the last/);
    const two = checkCoverage([band("h1", 0, 100, "header"), band("h2", 100, 200, "header"), band("f1", 200, 300, "footer"), band("f2", 300, 400, "footer")], 400);
    expect(two.problems.join(" ")).toMatch(/2 headers/);
    expect(two.problems.join(" ")).toMatch(/2 footers/);
  });
  it("reports no bands", () => {
    expect(checkCoverage([], 400).problems).toHaveLength(1);
  });
});

describe("snapEdges", () => {
  it("moves an AI edge that is 10 px off onto the exact colour change, only the inner boundary", () => {
    const img = blank(40, 300);
    fill(img, 0, 100, [255, 255, 255]);
    fill(img, 100, 200, [20, 40, 90]);
    fill(img, 200, 300, [240, 240, 240]);
    const guess = [band("a", 0, 110, "header"), band("b", 110, 193), band("c", 193, 300, "footer")];
    const r = snapEdges(img, guess);
    expect(r.map((b) => [b.top, b.bottom])).toEqual([[0, 100], [100, 200], [200, 300]]);
  });
  it("leaves a boundary alone when no row nearby changes more than the threshold (a photo-like edge)", () => {
    const img = blank(60, 200);
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 5;
    };
    for (let y = 0; y < 200; y += 1) for (let x = 0; x < 60; x += 1) {
      const v = 120 + next();
      const i = (y * 60 + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    const guess = [band("a", 0, 100), band("b", 100, 200)];
    expect(snapEdges(img, guess)).toEqual(guess);
  });
  it("never moves the page's own top or bottom and keeps each band at least 8 px tall", () => {
    const img = blank(20, 100);
    fill(img, 0, 6, [0, 0, 0]);
    fill(img, 6, 100, [255, 255, 255]);
    // a strong change at row 6 would pull the boundary at 14 to 6, but band "a" (top 0) must stay 8 tall.
    const r = snapEdges(img, [band("a", 0, 14), band("b", 14, 100)]);
    expect(r[0]!.top).toBe(0);
    expect(r[1]!.bottom).toBe(100);
    expect(r[0]!.bottom - r[0]!.top).toBeGreaterThanOrEqual(8);
    expect(r[0]!.bottom).toBe(r[1]!.top);
  });
  it("does not look beyond its reach", () => {
    const img = blank(20, 200);
    fill(img, 0, 100, [255, 255, 255]);
    fill(img, 100, 200, [0, 0, 0]);
    const guess = [band("a", 0, 130), band("b", 130, 200)];
    expect(snapEdges(img, guess)).toEqual(guess);
    expect(snapEdges(img, guess, 40)[0]!.bottom).toBe(100);
  });
});

describe("measureColours", () => {
  it("takes the median of the 5x5 around the point, ignoring one stray pixel", () => {
    const img = blank(20, 20);
    fill(img, 0, 20, [10, 120, 200]);
    const i = (10 * 20 + 10) * 4;
    img.data[i] = 255;
    img.data[i + 1] = 0;
    img.data[i + 2] = 0;
    const r = measureColours(img, [{ name: "brand", x: 10, y: 10 }]);
    expect(r.problems).toEqual([]);
    expect(r.colours).toEqual([{ name: "brand", x: 10, y: 10, hex: "#0a78c8" }]);
  });
  it("uses fewer pixels at the picture's edge and skips points outside with a problem", () => {
    const img = blank(10, 10);
    fill(img, 0, 10, [1, 2, 3]);
    const r = measureColours(img, [{ name: "corner", x: 0, y: 0 }, { name: "out", x: 10, y: 3 }, { name: "neg", x: 3, y: -1 }]);
    expect(r.colours.map((c) => c.hex)).toEqual(["#010203"]);
    expect(r.problems).toHaveLength(2);
  });
});

describe("tidyWords", () => {
  const box = { x: 10, y: 10, w: 300, h: 40 };
  const w = (text: string, b = box) => ({ text, role: "heading" as const, box: b });
  it("rejoins L-05's three spaced strings", () => {
    const out = tidyWords([w("A L E GAC Y O F S E RV I C E"), w("W H AT W E D O"), w("C O M P L E T E WAT E R S O L U T I O N S")].map((x, i) => ({ ...x, box: { ...box, y: i * 100 } })));
    expect(out.map((o) => o.text)).toEqual(["A LEGACY OF SERVICE", "WHAT WE DO", "COMPLETE WATER SOLUTIONS"]);
  });
  it("uses double spaces as word breaks when the input shows them", () => {
    expect(tidyWords([w("Q X  Z K  J V W")])[0]!.text).toBe("QX ZK JVW");
  });
  it("falls back to joining single letters around kept chunks when the letters are not words", () => {
    expect(tidyWords([w("Q X Z K VB J V")])[0]!.text).toBe("QXZK VB JV");
  });
  it("leaves ordinary text, short runs and mixed-case text alone", () => {
    for (const t of ["Call us today", "A B C", "WHAT WE DO", "Q X Z K", "S E R V I C E S and more"]) {
      const out = tidyWords([w(t)])[0]!.text;
      if (t === "Q X Z K") expect(out).toBe("QXZK");
      else expect(out).toBe(t);
    }
  });
  it("drops a doubled heading (same text, boxes overlapping by half) but keeps the first, and keeps repeats far apart", () => {
    const a = w("PUMP AND WELL", { x: 100, y: 100, w: 400, h: 60 });
    const shadow = w("pump and  well", { x: 103, y: 104, w: 400, h: 60 });
    const far = w("PUMP AND WELL", { x: 100, y: 900, w: 400, h: 60 });
    const sliver = w("PUMP AND WELL", { x: 480, y: 100, w: 400, h: 60 });
    const other = w("PUMP AND WELLS", { x: 100, y: 100, w: 400, h: 60 });
    const out = tidyWords([a, shadow, far, sliver, other]);
    expect(out).toEqual([a, far, sliver, other]);
    expect(out[0]).toBe(a);
  });
  it("changes no other field of a word", () => {
    const x = { text: "W H AT W E D O", role: "heading" as const, box, unsure: true };
    expect(tidyWords([x])[0]).toEqual({ text: "WHAT WE DO", role: "heading", box, unsure: true });
  });
});

describe("toDesignSpec and toPictureRequests", () => {
  const bandRead = (b: ReadBand, over: Partial<BandRead> = {}): BandRead => ({ band: b, words: [], points: [], fonts: [], pictures: [], notes: [], ...over });
  const read: DesignRead = {
    width: 1000,
    height: 600,
    colours: [],
    notes: [],
    bands: [
      bandRead(band("Second", 200, 600, "footer"), {
        words: [
          { text: "Right", role: "other", box: { x: 500, y: 300, w: 50, h: 20 } },
          { text: "Left words", role: "other", box: { x: 10, y: 300, w: 80, h: 20 }, unsure: true },
          { text: "Upper", role: "heading", box: { x: 400, y: 250, w: 50, h: 20 } },
        ],
        pictures: [
          { id: "pic", kind: "silhouette", box: { x: 600, y: 220, w: 300, h: 300 } },
          { id: "ic", kind: "icon", box: { x: 20, y: 400, w: 24, h: 24 }, label: "Phone", context: "Call" },
        ],
      }),
      bandRead(band("First", 0, 200, "header"), {
        words: [{ text: "Home", role: "link", box: { x: 5, y: 5, w: 50, h: 20 } }],
        pictures: [
          { id: "pic", kind: "background", box: { x: 0, y: 0, w: 1000, h: 200 }, drawnOver: [{ x: 10, y: 10, w: 100, h: 50 }] },
          { id: "logo", kind: "logo", box: { x: 5, y: 5, w: 80, h: 30 } },
        ],
      }),
    ],
  };
  it("toDesignSpec: bands, words in reading order split into words with unsure as uncertain, no icons", () => {
    const buf = Buffer.from("png");
    const spec = toDesignSpec(read, buf);
    expect(spec.width).toBe(1000);
    expect(spec.height).toBe(600);
    expect(spec.picture).toBe(buf);
    expect(spec.bands).toEqual([{ name: "First", top: 0, height: 200 }, { name: "Second", top: 200, height: 400 }]);
    expect(spec.words).toEqual([
      { text: "Home" },
      { text: "Upper" },
      { text: "Left", uncertain: true },
      { text: "words", uncertain: true },
      { text: "Right" },
    ]);
    expect(spec.pictures.map((p) => p.name)).toEqual(["pic", "logo", "pic"]);
    expect(spec.pictures[2]).toEqual({ name: "pic", x: 600, y: 220, w: 300, h: 300 });
  });
  it("toPictureRequests: straight mapping, silhouette band box, unique ids across the page", () => {
    const reqs = toPictureRequests(read);
    const ids = reqs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("logo");
    expect(ids).toContain("ic");
    const second = reqs.find((r) => r.kind === "silhouette")!;
    expect(second.id).toBe("b1-pic");
    expect(second.band).toEqual({ x: 0, y: 200, w: 1000, h: 400 });
    const bg = reqs.find((r) => r.kind === "background")!;
    expect(bg.id).toBe("b2-pic");
    expect(bg.drawnOver).toEqual([{ x: 10, y: 10, w: 100, h: 50 }]);
    expect(bg.band).toBeUndefined();
    expect(reqs.find((r) => r.kind === "icon")).toEqual({ id: "ic", kind: "icon", box: { x: 20, y: 400, w: 24, h: 24 }, label: "Phone", context: "Call" });
  });
});
