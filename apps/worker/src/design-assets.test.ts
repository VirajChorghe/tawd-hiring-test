import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

import type { Box, Colour, Rgba } from "./design-pixels";
import type { PatchResult } from "./design-patch";

vi.mock("./design-patch", () => ({ wipeAndFill: vi.fn() }));

import { wipeAndFill } from "./design-patch";
import { prepareAsset, prepareAssets, readPixels, toTransparent, writePng } from "./design-assets";
import { readPdf } from "./design-upload";

const mockedWipe = vi.mocked(wipeAndFill);

const WHITE: Colour = [255, 255, 255];
const RED: Colour = [200, 30, 30];
const BLUE: Colour = [30, 80, 200];

function picture(width: number, height: number, colour: (x: number, y: number) => Colour | [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = colour(x, y);
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c.length === 4 ? c[3] : 255;
    }
  }
  return { width, height, data };
}
const px = (p: Rgba, x: number, y: number) => {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
};
// A design with a gradient so every crop is recognisable.
const design = picture(200, 100, (x, y) => [x, y, (x + y) % 256]);
// A red logo (a 20x10 block) on a white 40x30 picture, placed at 50,20 of a white design.
const logoDesign = picture(200, 100, (x, y) => (x >= 60 && x < 80 && y >= 25 && y < 35 ? RED : WHITE));
const logoBox: Box = { x: 50, y: 20, w: 40, h: 30 };

describe("prepareAsset: photo and boxes", () => {
  it("cuts a photo at its exact size and pixels", () => {
    const a = prepareAsset(design, { id: "p1", kind: "photo", box: { x: 10, y: 20, w: 30, h: 15 } });
    expect(a.picture).toMatchObject({ width: 30, height: 15 });
    expect(px(a.picture!, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(a.picture!, 29, 14)).toEqual([39, 34, 73, 255]);
    expect(a.flags).toEqual([]);
  });

  it("flags a box outside the design instead of throwing", () => {
    const a = prepareAsset(design, { id: "far", kind: "photo", box: { x: 190, y: 0, w: 30, h: 10 } });
    expect(a.picture).toBeNull();
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain("far");
    expect(a.flags[0]).toContain("not fully inside");
  });

  it("never changes the design it cuts from", () => {
    const before = new Uint8ClampedArray(logoDesign.data);
    prepareAsset(logoDesign, { id: "l", kind: "logo", box: logoBox });
    prepareAsset(logoDesign, { id: "s", kind: "silhouette", box: logoBox, band: { x: 0, y: 0, w: 200, h: 100 } });
    expect(Array.from(logoDesign.data)).toEqual(Array.from(before));
  });

  it("prepareAssets does one per request, in order", () => {
    const list = prepareAssets(design, [
      { id: "a", kind: "photo", box: { x: 0, y: 0, w: 5, h: 5 } },
      { id: "b", kind: "photo", box: { x: 500, y: 0, w: 5, h: 5 } },
    ]);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
    expect(list[1]!.picture).toBeNull();
  });
});

describe("prepareAsset: background patches", () => {
  const record = (box: Box, mark: number) => ({ box, method: "blend" as "blend" | "soft", feather: 0, underneath: picture(box.w, box.h, () => [mark, 0, 0]) });
  const fake = (mark: number) => (image: Rgba, box: Box): PatchResult => {
    const next = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    next.data[0] = mark; // a visible trace of each patch, on top of the previous one's
    next.data[1] = (image.data[1]! + 1) % 256; // counts how many patches came before
    return { ok: true, image: next, record: record(box, mark) };
  };

  it("applies patches in order on the previous result, with boxes in picture coordinates and cut to the picture", () => {
    mockedWipe.mockReset();
    mockedWipe.mockImplementation(fake(7));
    const a = prepareAsset(design, {
      id: "bg",
      kind: "background",
      box: { x: 20, y: 10, w: 100, h: 50 },
      drawnOver: [
        { x: 30, y: 15, w: 10, h: 10 },
        { x: 110, y: 50, w: 40, h: 40 }, // sticks out right and bottom: cut to 10x10
      ],
    });
    expect(mockedWipe).toHaveBeenCalledTimes(2);
    expect(mockedWipe.mock.calls[0]![1]).toEqual({ x: 10, y: 5, w: 10, h: 10 });
    expect(mockedWipe.mock.calls[1]![1]).toEqual({ x: 90, y: 40, w: 10, h: 10 });
    // The second call got the first call's image, not a fresh crop.
    expect(mockedWipe.mock.calls[1]![0].data[0]).toBe(7);
    expect(a.patches).toHaveLength(2);
    expect(a.patches[0]!.box).toEqual({ x: 10, y: 5, w: 10, h: 10 });
    expect(a.picture!.data[1]).toBe(12); // 10 (green at 20,10) + two patches
    expect(a.flags).toEqual([]);
  });

  it("flags a soft patch (not a plain colour or straight-line gradient behind the box), numbering the box from 1 in request order", () => {
    mockedWipe.mockReset();
    mockedWipe.mockImplementationOnce(fake(7));
    mockedWipe.mockImplementationOnce((image, box) => {
      const r = fake(8)(image, box);
      if (r.ok) r.record.method = "soft";
      return r;
    });
    const a = prepareAsset(design, {
      id: "hero",
      kind: "background",
      box: { x: 20, y: 10, w: 100, h: 50 },
      drawnOver: [
        { x: 30, y: 15, w: 10, h: 10 },
        { x: 60, y: 30, w: 10, h: 10 },
      ],
    });
    expect(a.patches).toHaveLength(2);
    expect(a.flags).toEqual(["hero: the picture behind drawn-over box 2 is not a plain colour or an even, straight-line gradient, so TAWD smoothed it over; what was under it can't be known, so upload the picture without the text for a clean copy."]);
  });

  it("keeps the picture as it is and flags the reason when a patch fails", () => {
    mockedWipe.mockReset();
    mockedWipe.mockReturnValueOnce({ ok: false, reason: "the box is nearly the whole picture" });
    mockedWipe.mockImplementationOnce(fake(9));
    const a = prepareAsset(design, {
      id: "bg",
      kind: "background",
      box: { x: 20, y: 10, w: 100, h: 50 },
      drawnOver: [
        { x: 30, y: 15, w: 10, h: 10 },
        { x: 60, y: 30, w: 10, h: 10 },
      ],
    });
    expect(a.patches).toHaveLength(1);
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain("the box is nearly the whole picture");
    expect(a.picture!.data[0]).toBe(9); // the second still ran, on the unpatched picture
    expect(a.picture!.data[1]).toBe(11);
  });

  it("flags a drawn-over box that does not touch the picture and skips it", () => {
    mockedWipe.mockReset();
    const a = prepareAsset(design, { id: "bg", kind: "background", box: { x: 20, y: 10, w: 50, h: 30 }, drawnOver: [{ x: 150, y: 80, w: 10, h: 10 }] });
    expect(mockedWipe).not.toHaveBeenCalled();
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain("does not touch");
    expect(a.flags[0]).toContain("bg");
    expect(a.picture).toMatchObject({ width: 50, height: 30 });
  });
});

describe("toTransparent", () => {
  it("clears the plain background and keeps the body solid", () => {
    const t = toTransparent(picture(40, 30, (x, y) => (x >= 10 && x < 30 && y >= 5 && y < 15 ? RED : WHITE)));
    if ("refused" in t) throw new Error(t.refused);
    expect(t.colour).toBe("#ffffff");
    expect(px(t.picture, 0, 0)[3]).toBe(0);
    expect(px(t.picture, 39, 29)[3]).toBe(0);
    expect(px(t.picture, 15, 8)).toEqual([200, 30, 30, 255]);
  });

  // An edge pixel is drawn in its strong neighbour's colour at the share its own colour shows: no fringe of the old background.
  it.each([
    { name: "a grey edge of black text on white", ink: [0, 0, 0] as Colour, edge: [128, 128, 128] as Colour, share: 127 / 255 },
    { name: "a half-red edge of a red logo (far enough from white to have counted as solid before)", ink: RED, edge: [228, 143, 143] as Colour, share: 0.5 },
  ])("un-mixes $name", ({ ink, edge, share }) => {
    const t = toTransparent(picture(20, 10, (x, y) => (x === 10 && y > 0 && y < 9 ? edge : x > 10 && x < 19 && y > 0 && y < 9 ? ink : WHITE)));
    if ("refused" in t) throw new Error(t.refused);
    const [r, g, b, a] = px(t.picture, 10, 4);
    expect([r, g, b]).toEqual(ink);
    expect(Math.abs(a! - 255 * share)).toBeLessThanOrEqual(3);
    // The body next to it stays exactly as drawn, and solid.
    expect(px(t.picture, 14, 4)).toEqual([...ink, 255]);
  });

  it("makes pixels within 24 of the background fully clear, 96 or more fully solid, and a faint one on its own see-through and un-mixed", () => {
    // (11,11) is 60 from white and more than 4px from anything stronger: half see-through, its colour pushed away from the white.
    const t = toTransparent(picture(16, 16, (x, y) => (x === 4 && y === 4 ? [255 - 24, 255, 255] : x === 5 && y === 5 ? [255 - 96, 255, 255] : x === 11 && y === 11 ? [195, 255, 255] : WHITE)));
    if ("refused" in t) throw new Error(t.refused);
    expect(px(t.picture, 4, 4)).toEqual([0, 0, 0, 0]);
    expect(px(t.picture, 5, 5)).toEqual([159, 255, 255, 255]);
    expect(px(t.picture, 11, 11)).toEqual([135, 255, 255, 128]);
  });

  it("refuses a striped border", () => {
    const t = toTransparent(picture(40, 30, (x, y) => (x === 0 || y === 0 || x === 39 || y === 29 ? ((x + y) % 2 ? RED : BLUE) : WHITE)));
    expect("refused" in t).toBe(true);
  });

  it("accepts a border that is 90% plain and refuses one that is under", () => {
    // 40x30 border = 136 pixels; the top row has 40 pixels. Spoil 13 (9.6%) and then 15 (11%).
    const spoil = (n: number) => picture(40, 30, (x, y) => (y === 0 && x < n ? RED : WHITE));
    expect("refused" in toTransparent(spoil(13))).toBe(false);
    expect("refused" in toTransparent(spoil(15))).toBe(true);
  });

  it("refuses a picture under 3x3", () => {
    expect("refused" in toTransparent(picture(2, 5, () => WHITE))).toBe(true);
  });

  it("never changes its input", () => {
    const p = picture(40, 30, (x, y) => (x > 10 && x < 30 && y > 5 && y < 20 ? RED : WHITE));
    const before = Array.from(p.data);
    const t = toTransparent(p);
    expect("refused" in t).toBe(false); // the transform really ran
    expect(Array.from(p.data)).toEqual(before);
  });
});

describe("prepareAsset: logo, cutout, silhouette", () => {
  it("makes a logo see-through on its plain colour and records the colour", () => {
    const a = prepareAsset(logoDesign, { id: "logo", kind: "logo", box: logoBox });
    expect(a.transparentOn).toBe("#ffffff");
    expect(px(a.picture!, 0, 0)[3]).toBe(0);
    expect(px(a.picture!, 39, 29)[3]).toBe(0);
    expect(px(a.picture!, 15, 8)[3]).toBe(255);
    expect(a.flags).toEqual([]);
  });

  it("treats a cutout the same way", () => {
    const a = prepareAsset(logoDesign, { id: "cut", kind: "cutout", box: logoBox });
    expect(a.transparentOn).toBe("#ffffff");
    expect(px(a.picture!, 0, 0)[3]).toBe(0);
  });

  it("keeps the opaque crop and flags when the logo's border is striped", () => {
    const striped = picture(100, 60, (x, y) => (x < 40 || y < 30 ? (x + y) % 2 ? RED : BLUE : WHITE));
    const a = prepareAsset(striped, { id: "logo", kind: "logo", box: { x: 0, y: 0, w: 40, h: 30 } });
    expect(a.transparentOn).toBeNull();
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain("logo can't be made see-through (its edge is not one plain colour)");
    expect(a.flags[0]).toContain("upload the file");
    expect(px(a.picture!, 0, 0)[3]).toBe(255);
    expect(a.picture).toMatchObject({ width: 40, height: 30 });
  });

  // A red figure (200x100) on a plain white ground, inside a 240x140 box at 80,20.
  const figureDesign = picture(400, 200, (x, y) => (x >= 100 && x < 300 && y >= 40 && y < 140 ? RED : WHITE));
  const figureBox: Box = { x: 80, y: 20, w: 240, h: 140 };

  it("fades a silhouette only on the edges that are not the band's own edge, with a linear ramp", () => {
    // The band shares the box's left and bottom edge; its right and top lie beyond the box.
    const a = prepareAsset(figureDesign, { id: "sil", kind: "silhouette", box: figureBox, band: { x: 80, y: 0, w: 320, h: 160 } });
    expect(a.fadedEdges.sort()).toEqual(["right", "top"]);
    const p = a.picture!;
    // Fade: min(48, 25% of 240) = 48 across; min(48, 25% of 140) = 35 down.
    expect(px(p, 239, 60)[3]).toBe(0);
    expect(px(p, 215, 60)[3]).toBe(Math.round(255 * (24 / 48)));
    expect(px(p, 20, 20)[3]).toBe(Math.round(255 * (20 / 35)));
    expect(px(p, 20, 60)[3]).toBe(255); // left edge of the figure: not faded
    expect(px(p, 100, 119)[3]).toBe(255); // bottom of the figure: not faded
    expect(px(p, 100, 70)[3]).toBe(255);
    expect(a.transparentOn).toBe("#ffffff");
  });

  it("fades nothing when the band's edges are the box's own", () => {
    const a = prepareAsset(figureDesign, { id: "sil", kind: "silhouette", box: figureBox, band: figureBox });
    expect(a.fadedEdges).toEqual([]);
    expect(px(a.picture!, 239, 60)[3]).toBe(0); // the white ground, cleared, not faded
    expect(px(a.picture!, 100, 70)[3]).toBe(255);
    const edge = prepareAsset(figureDesign, { id: "sil", kind: "silhouette", box: { x: 80, y: 20, w: 240, h: 140 }, band: { x: 0, y: 20, w: 320, h: 140 } });
    expect(edge.fadedEdges).toEqual(["left"]);
  });

  it("flags a silhouette with no band and cuts it as a plain crop", () => {
    const a = prepareAsset(figureDesign, { id: "sil", kind: "silhouette", box: figureBox });
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain("sil");
    expect(a.transparentOn).toBeNull();
    expect(a.fadedEdges).toEqual([]);
    expect(px(a.picture!, 20, 20)).toEqual([200, 30, 30, 255]);
    expect(px(a.picture!, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("keeps a silhouette opaque and flags when it is not on a plain colour", () => {
    const busy = picture(400, 200, (x, y) => ((x + y) % 2 ? RED : BLUE));
    const a = prepareAsset(busy, { id: "sil", kind: "silhouette", box: { x: 100, y: 40, w: 200, h: 100 }, band: { x: 0, y: 0, w: 400, h: 200 } });
    expect(a.flags).toHaveLength(1);
    expect(a.fadedEdges).toEqual([]);
    expect(px(a.picture!, 0, 0)[3]).toBe(255);
  });
});

describe("review of E3: edges, pale colours, silhouettes on the band's edge", () => {
  const NAVY: Colour = [0, 0, 80];
  const LIGHT_BLUE: Colour = [150, 200, 255];

  it("keeps a pale colour of the logo's own beside a strong one exactly as drawn", () => {
    // White picture; a navy block at x 6-11 touching a light-blue block at x 12-17.
    const t = toTransparent(picture(24, 12, (x, y) => (y >= 3 && y < 9 && x >= 6 && x < 12 ? NAVY : y >= 3 && y < 9 && x >= 12 && x < 18 ? LIGHT_BLUE : WHITE)));
    if ("refused" in t) throw new Error(t.refused);
    for (const x of [12, 13, 14]) expect(px(t.picture, x, 5)).toEqual([...LIGHT_BLUE, 255]);
  });

  it("draws a soft edge up to 4 px wide in the logo's colour, with no grey fringe", () => {
    // A black block with a 4-step ramp to white on its left: 51, 102, 153, 204 from white.
    const ramp = [204, 153, 102, 51];
    const t = toTransparent(picture(20, 9, (x, y) => (y >= 2 && y < 7 && x >= 8 && x < 16 ? [0, 0, 0] : y >= 2 && y < 7 && x >= 4 && x < 8 ? [ramp[x - 4]!, ramp[x - 4]!, ramp[x - 4]!] : WHITE)));
    if ("refused" in t) throw new Error(t.refused);
    for (let x = 4; x < 8; x += 1) {
      const [r, g, b, a] = px(t.picture, x, 4);
      expect([r, g, b]).toEqual([0, 0, 0]);
      expect(Math.abs(a! - (255 - ramp[x - 4]!))).toBeLessThanOrEqual(2);
    }
  });

  it("makes a silhouette standing on its band's edge see-through, reading the background from its other sides", () => {
    // Band 0,0 300x160; the figure's box touches the band's bottom, and the dark figure touches the box's bottom for 120 px.
    const band: Box = { x: 0, y: 0, w: 300, h: 160 };
    const box: Box = { x: 20, y: 40, w: 260, h: 120 };
    const scene = picture(300, 160, (x, y) => (y >= 100 && x >= 90 && x < 210 ? [20, 30, 40] : WHITE));
    const a = prepareAsset(scene, { id: "sil", kind: "silhouette", box, band });
    expect(a.flags).toEqual([]);
    expect(a.transparentOn).toBe("#ffffff");
    expect(a.fadedEdges).toEqual(["left", "right", "top"]);
    // The figure's foot, on the band's edge, stays solid.
    expect(px(a.picture!, 130, 119)[3]).toBe(255);
  });

  it("flags a silhouette whose band does not hold its box", () => {
    const scene = picture(300, 160, () => WHITE);
    const a = prepareAsset(scene, { id: "sil", kind: "silhouette", box: { x: 20, y: 40, w: 260, h: 120 }, band: { x: 0, y: 0, w: 200, h: 100 } });
    expect(a.flags[0]).toContain("has no band around it inside the design");
    expect(a.transparentOn).toBeNull();
  });
});

describe("prepareAsset: icons", () => {
  it("matches an icon from the label and records how it was found", () => {
    const a = prepareAsset(design, { id: "i1", kind: "icon", box: { x: 0, y: 0, w: 10, h: 10 }, label: "phone" });
    expect(a.picture).toBeNull();
    expect(a.icon).not.toBeNull();
    expect(a.icon!.by).not.toBe("unknown");
    expect(a.flags).toEqual([]);
  });

  it("flags a label no icon matches", () => {
    const a = prepareAsset(design, { id: "i2", kind: "icon", box: { x: 0, y: 0, w: 10, h: 10 }, label: "zxqvw flarbnok" });
    expect(a.icon!.by).toBe("unknown");
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toContain('No icon in TAWD\'s set matches "zxqvw flarbnok"');
  });

  it("flags an icon with no label, including a blank one", () => {
    for (const label of [undefined, "", "   "]) {
      const a = prepareAsset(design, { id: "i3", kind: "icon", box: { x: 0, y: 0, w: 10, h: 10 }, label });
      expect(a.icon).toBeNull();
      expect(a.flags).toHaveLength(1);
      expect(a.flags[0]).toContain("i3");
    }
  });
});

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
let browser: Browser;
let page: Page;
beforeAll(async () => {
  if (!hasChrome) return;
  browser = await chromium.launch({ executablePath: CHROME });
  page = await (await browser.newContext()).newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!hasChrome)("readPixels and writePng in a real browser", () => {
  const pat = path.resolve(__dirname, "../../../fixtures/lane2/pat-rivera-design.pdf");
  it.skipIf(!fs.existsSync(pat))("reads Pat Rivera's design, makes its footer logo see-through, and round-trips it through PNG", async () => {
    const [one] = await readPdf(page, fs.readFileSync(pat), 1);
    const whole = await readPixels(page, one!.png.replace(/^data:image\/png;base64,/, ""), "image/png");
    expect(whole.width).toBe(1400);
    expect(whole.height).toBe(4056);
    expect(whole.data.length).toBe(1400 * 4056 * 4);

    const a = prepareAsset(whole, { id: "footer-logo", kind: "logo", box: { x: 98, y: 3728, w: 175, h: 106 } });
    expect(a.flags).toEqual([]);
    const p = a.picture!;
    expect(p).toMatchObject({ width: 175, height: 106 });
    for (const [x, y] of [[0, 0], [174, 0], [0, 105], [174, 105]] as const) expect(px(p, x, y)[3]).toBe(0);
    let solid = 0;
    for (let i = 3; i < p.data.length; i += 4) if (p.data[i] === 255) solid += 1;
    expect(solid).toBeGreaterThan(50);

    const b64 = await writePng(page, p);
    const back = await readPixels(page, b64, "image/png");
    expect(back).toMatchObject({ width: 175, height: 106 });
    expect(px(back, 0, 0)[3]).toBe(0);
    expect(px(back, 174, 105)[3]).toBe(0);
  }, 120_000);

  it("round-trips a small picture's alpha", async () => {
    const p = picture(4, 3, (x) => (x < 2 ? [10, 20, 30, 255] : [0, 0, 0, 0]));
    const back = await readPixels(page, await writePng(page, p), "image/png");
    expect(px(back, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(back, 3, 2)[3]).toBe(0);
  });
});
