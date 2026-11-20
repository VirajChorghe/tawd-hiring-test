import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

import { findFlatMargins } from "./flat-margins";
import { raster, makePdf, type Rgb } from "./make-test-pdf";
import { PAGE_WIDTH, keptReadWasDrawnTheOldWay, pictureTakenInNote, readPdf } from "./design-upload";

/*
  E1, take in (13 November 2026, audit finding L-01): a picture-only PDF
  (the client's design is one embedded JPEG, no text layer) was redrawn at
  1440px wide, shrinking a 1400px-wide design to ~55% inside a picture
  that was ~45% black. Now such a page uses its own picture at its own
  size and the flat margins are trimmed, and the team is told.
*/

const BLACK: Rgb = [0, 0, 0];
const BLUE: Rgb = [30, 80, 200];
const GOLD: Rgb = [230, 190, 40];

/* 1200 x 800 picture: 100px black either side, and a 1000px-wide design (blue with a gold band) between. */
const designPicture = (colour: (x: number, y: number) => Rgb, width = 1200, height = 800) => ({ width, height, rgb: raster(width, height, colour) });
const centred = (x: number, y: number): Rgb => (x < 100 || x >= 1100 ? BLACK : y >= 100 && y < 160 ? GOLD : BLUE);

describe("findFlatMargins", () => {
  const find = (width: number, height: number, colour: (x: number, y: number) => Rgb, noise = 0) => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = colour(x, y);
        const i = (y * width + x) * 4;
        const n = noise ? ((x * 7 + y * 13) % (2 * noise + 1)) - noise : 0;
        pixels[i] = r + n;
        pixels[i + 1] = g + n;
        pixels[i + 2] = b + n;
        pixels[i + 3] = 255;
      }
    }
    return findFlatMargins(pixels, width, height);
  };

  it("trims black either side of a centred design, and says how much", () => {
    const m = find(1200, 800, centred);
    expect(m).toMatchObject({ left: 100, right: 100, top: 0, bottom: 0, colourX: "#000000" });
  });

  it("allows JPEG-like noise in the margin", () => {
    const m = find(1200, 800, centred, 6);
    expect(m.left).toBe(100);
    expect(m.right).toBe(100);
  });

  // Review of E1: a frame's colour can't be told from the design's own band of that colour, so rows are never cut; only the sides.
  it("trims only the sides of a picture framed all round, never its top or bottom", () => {
    const m = find(300, 500, (x, y) => (x < 40 || x >= 260 || y < 30 || y >= 470 ? [255, 255, 255] : x % 50 < 25 ? BLUE : GOLD));
    expect(m).toMatchObject({ top: 0, bottom: 0, left: 40, right: 40 });
  });

  it("never eats a design's own flat top and bottom (no frame at the sides)", () => {
    const m = find(300, 500, (x, y) => (y < 30 || y >= 470 ? [255, 255, 255] : x % 50 < 25 ? BLUE : GOLD));
    expect(m).toMatchObject({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("does not trim a margin that is not one colour", () => {
    // Left edge black, right edge a different colour: not a margin, a design.
    const m = find(400, 600, (x, y) => (x < 100 ? BLACK : x >= 300 ? [250, 250, 250] : y >= 100 && y < 160 ? GOLD : BLUE));
    expect(m).toMatchObject({ left: 0, right: 0 });
  });

  it("does not trim an edge whose line is mixed", () => {
    // The outermost left column is half black, half blue: not flat.
    const m = find(400, 600, (x, y) => (x < 100 && y < 300 ? BLACK : x < 100 ? BLUE : x >= 300 ? BLACK : GOLD));
    expect(m).toMatchObject({ left: 0, right: 0 });
  });

  /* The reviewer's three cases: thin features at the edge of a flat margin. None may be cut into. */
  it("keeps a black header with a 20px logo and a black footer with a text line (2560 x 4056, 580px of black each side)", () => {
    const m = find(2560, 4056, (x, y) => {
      if (x < 580 || x >= 1980) return BLACK;
      if (y < 120) return x >= 1200 && x < 1220 && y >= 40 && y < 80 ? [255, 255, 255] : BLACK;
      if (y >= 3900) return x >= 1000 && x < 1400 && y >= 3950 && y < 3970 ? [255, 255, 255] : BLACK;
      return y % 200 < 100 ? BLUE : GOLD;
    });
    expect(m.left).toBe(580);
    expect(m.right).toBe(580);
    // The logo starts at row 40 and the footer text ends 86 rows from the bottom: both stay.
    expect(m.top).toBeLessThanOrEqual(40);
    expect(m.bottom).toBeLessThanOrEqual(4056 - 3950);
  });

  it("keeps a white page whose dark nav and footer run full width (1440 x 4000, 1200px container)", () => {
    const m = find(1440, 4000, (x, y) => (y < 40 || y >= 3970 ? [20, 20, 40] : x < 120 || x >= 1320 ? [255, 255, 255] : y % 200 < 100 ? BLUE : GOLD));
    expect(m).toMatchObject({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("keeps a strip that is wider than the content (60px tall on a 4000px page)", () => {
    const m = find(1400, 4000, (x, y) => (y >= 1000 && y < 1060 && x >= 100 && x < 1300 ? [20, 20, 40] : x >= 200 && x < 1200 ? (y % 200 < 100 ? BLUE : GOLD) : [255, 255, 255]));
    // The white outside the strip may go; the strip (columns 100 to 1299) may not be touched.
    expect(m.left).toBeLessThanOrEqual(100);
    expect(m.right).toBeLessThanOrEqual(100);
  });

  it("trims through a small mark that sits in the margin (like the one in the Pat picture)", () => {
    const m = find(1600, 2000, (x, y) => (x < 500 ? BLACK : x >= 1100 ? (x >= 1550 && y >= 1900 && y < 1930 ? [255, 255, 255] : BLACK) : y % 200 < 100 ? BLUE : GOLD));
    expect(m).toMatchObject({ left: 500, right: 500 });
  });

  it("does not trim through a wide band of marks in the margin (an edge that is design)", () => {
    // 400px-wide white blob (1.5% of each column) at the right edge: more than 5% of the width, so not a stray mark.
    const m = find(1200, 2000, (x, y) => (x < 100 ? BLACK : x >= 700 ? (y >= 1900 && y < 1930 ? [255, 255, 255] : BLACK) : y % 200 < 100 ? BLUE : GOLD));
    expect(m).toMatchObject({ left: 0, right: 0 });
  });

  it("trims nothing when a mark sits mid-way in one margin (sides would differ: 580 and 310)", () => {
    const m = find(2560, 4056, (x, y) => (x < 580 || x >= 1980 ? (x >= 2250 && x < 2300 && y >= 3941 && y < 3985 ? [255, 255, 255] : BLACK) : y % 200 < 100 ? BLUE : GOLD));
    expect(m).toMatchObject({ left: 0, right: 0 });
  });

  it("trims nothing for a white design with a widget on its right edge (gutters 120 and 200)", () => {
    const m = find(1440, 4056, (x, y) => (x >= 1390 && y >= 2000 && y < 2044 ? [20, 20, 40] : x >= 120 && x < 1240 ? (y % 200 < 100 ? BLUE : GOLD) : [255, 255, 255]));
    expect(m).toMatchObject({ left: 0, right: 0 });
  });

  it("never trims a picture that is all one colour", () => {
    expect(find(300, 300, () => BLACK)).toMatchObject({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("stops at the design: a dark design edge inside the margin is kept", () => {
    // 100px black margin, then a design whose first column is dark grey (distance 40 from black).
    const m = find(400, 600, (x, y) => (x < 100 || x >= 300 ? BLACK : x === 100 ? [40, 40, 40] : y % 2 ? BLUE : GOLD));
    expect(m.left).toBe(100);
  });
});

describe("a kept read and how its page was drawn", () => {
  it("an old read (1440 wide, no native marker) was drawn the old way", () => {
    expect(keptReadWasDrawnTheOldWay(JSON.stringify({ page: { width: 1440 }, notes: [] }))).toBe(true);
  });
  it("a native read that trimmed to exactly 1440 wide was not", () => {
    expect(keptReadWasDrawnTheOldWay(JSON.stringify({ page: { width: 1440 }, notes: [], native: true }))).toBe(false);
  });
  it("a read of another width was not", () => {
    expect(keptReadWasDrawnTheOldWay(JSON.stringify({ page: { width: 1400 }, notes: [] }))).toBe(false);
  });
});

describe("pictureTakenInNote", () => {
  it("says the picture was used at its own size and what was trimmed", () => {
    const note = pictureTakenInNote(1, { pictureWidth: 2560, pictureHeight: 4056, trimmed: { left: 580, right: 581, top: 0, bottom: 0, colourX: "#000000", colourY: null } }, 1399, 4056);
    expect(note).toContain("Page 1");
    expect(note).toContain("1399 \u00d7 4056");
    expect(note).toContain("2560 \u00d7 4056");
    expect(note).toContain("580 px off the left");
    expect(note).toContain("581 px off the right");
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

const pngSize = (dataUri: string) => {
  const bytes = Buffer.from(dataUri.replace(/^data:image\/png;base64,/, ""), "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe.skipIf(!hasChrome)("readPdf in a real browser", () => {
  it("uses a picture-only page's own picture at its own size, with the black margins trimmed", async () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: designPicture(centred) });
    const [one] = await readPdf(page, pdf, 1);
    expect(one!.taken).toMatchObject({ pictureWidth: 1200, pictureHeight: 800, trimmed: { left: 100, right: 100, top: 0, bottom: 0 } });
    // The design (1000 wide), not 1440 and not the 1200 wide picture.
    expect(one!.raw.width).toBe(1000);
    expect(one!.raw.height).toBe(800);
    expect(pngSize(one!.png)).toEqual({ width: 1000, height: 800 });
    // Everything in pixels agrees with the trimmed picture.
    expect(one!.raw.rows).toHaveLength(800);
    expect(one!.raw.rows[0]).toBe("#2050c8");
    expect(one!.raw.rows[130]).toBe("#e8c028");
    expect(one!.raw.texts).toEqual([]);
    // The picture box exists, is inside the trimmed picture and fills it.
    expect(one!.raw.images).toHaveLength(1);
    const box = one!.raw.images[0]!;
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(1000 + 0.5);
    expect(box.y + box.h).toBeLessThanOrEqual(800 + 0.5);
    expect(box.w).toBeGreaterThan(990);
    expect(box.h).toBeGreaterThan(790);
  }, 60_000);

  it("takes the picture at its own size even when nothing needs trimming", async () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: designPicture((x, y) => (y >= 100 && y < 160 ? GOLD : x % 40 < 20 ? BLUE : [200, 60, 60])) });
    const [one] = await readPdf(page, pdf, 1);
    expect(one!.raw.width).toBe(1200);
    expect(one!.raw.height).toBe(800);
    expect(one!.taken?.trimmed).toMatchObject({ left: 0, right: 0, top: 0, bottom: 0 });
  }, 60_000);

  it("does not trim an edge that is not one flat colour", async () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: designPicture((x, y) => (x < 100 ? BLACK : x >= 1100 ? [250, 250, 250] : y >= 100 && y < 160 ? GOLD : BLUE)) });
    const [one] = await readPdf(page, pdf, 1);
    expect(one!.taken?.trimmed).toMatchObject({ left: 0, right: 0 });
    expect(one!.raw.width).toBe(1200);
  }, 60_000);

  it("keeps the usual 1440px path for a page with a text layer", async () => {
    const pdf = makePdf({ pageW: 612, pageH: 792, text: "Hello from the design" });
    const [one] = await readPdf(page, pdf, 1);
    expect(one!.taken).toBeNull();
    expect(one!.raw.width).toBe(PAGE_WIDTH);
    expect(one!.raw.texts.map((t) => t.str).join(" ")).toContain("Hello");
  }, 60_000);

  it("keeps the usual path for a page with text over a full-page picture", async () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: designPicture(centred), text: "Words on top" });
    const [one] = await readPdf(page, pdf, 1);
    expect(one!.taken).toBeNull();
    expect(one!.raw.width).toBe(PAGE_WIDTH);
  }, 60_000);

  /* The picture is used at its own size only when what is left is 800 to 1920 wide. */
  const plain = (x: number, y: number): Rgb => (y % 100 < 50 ? (x % 100 < 50 ? BLUE : GOLD) : [200, 60, 60]);
  const widthsTaken = async (picWidth: number) => {
    const [one] = await readPdf(page, makePdf({ pageW: picWidth / 2, pageH: 150, image: designPicture(plain, picWidth, 300) }), 1);
    return one!;
  };
  it("takes a picture 800 and 1920 wide at its own size (the lower and upper bounds)", async () => {
    expect((await widthsTaken(800)).raw.width).toBe(800);
    expect((await widthsTaken(1920)).raw.width).toBe(1920);
  }, 60_000);
  it("draws a picture 799 or 1921 wide the usual way, 1440 wide", async () => {
    for (const w of [799, 1921]) {
      const one = await widthsTaken(w);
      expect(one.taken, `${w} wide`).toBeNull();
      expect(one.raw.width, `${w} wide`).toBe(PAGE_WIDTH);
    }
  }, 60_000);
  it("draws a picture the usual way when the trim leaves it under 800 wide", async () => {
    // 1000 wide with 100px of black each side: 800 left is fine, but 850 wide with 100 each side leaves 650.
    const [one] = await readPdf(page, makePdf({ pageW: 425, pageH: 150, image: designPicture((x, y) => (x < 100 || x >= 750 ? BLACK : plain(x, y)), 850, 300) }), 1);
    expect(one!.taken).toBeNull();
    expect(one!.raw.width).toBe(PAGE_WIDTH);
  }, 60_000);

  it("keeps drawing a page 1440 wide when its kept read was made that way", async () => {
    const pdf = makePdf({ pageW: 600, pageH: 400, image: designPicture(centred) });
    const [kept] = await readPdf(page, pdf, 1, { drawnBefore: [1] });
    expect(kept!.taken).toBeNull();
    expect(kept!.raw.width).toBe(PAGE_WIDTH);
    // A different page number in the list changes nothing for this page.
    const [fresh] = await readPdf(page, pdf, 1, { drawnBefore: [2] });
    expect(fresh!.raw.width).toBe(1000);
  }, 60_000);

  it("the second run of a page trimmed to exactly 1440 stays native and matches its kept read", async () => {
    // A 1440 design centred on a 1920 canvas: 240px of black each side.
    const pdf = makePdf({ pageW: 960, pageH: 200, image: designPicture((x, y) => (x < 240 || x >= 1680 ? BLACK : plain(x, y)), 1920, 400) });
    const [first] = await readPdf(page, pdf, 1);
    expect(first!.taken).not.toBeNull();
    expect(first!.raw.width).toBe(1440);
    expect(first!.raw.height).toBe(400);
    // What the job saves as the kept read, and what the next run decides from it.
    const saved = JSON.stringify({ page: { width: first!.raw.width, height: first!.raw.height }, notes: [], native: first!.taken !== null });
    const drawnBefore = keptReadWasDrawnTheOldWay(saved) ? [1] : [];
    const [second] = await readPdf(page, pdf, 1, { drawnBefore });
    expect(second!.taken).not.toBeNull();
    expect(second!.raw.width).toBe(first!.raw.width);
    expect(second!.raw.height).toBe(first!.raw.height);
  }, 60_000);

  it("an old unmarked 1440 read of the same page is matched by drawing it the old way", async () => {
    const pdf = makePdf({ pageW: 960, pageH: 200, image: designPicture((x, y) => (x < 240 || x >= 1680 ? BLACK : plain(x, y)), 1920, 400) });
    const drawnBefore = keptReadWasDrawnTheOldWay(JSON.stringify({ page: { width: 1440, height: 300 }, notes: [] })) ? [1] : [];
    const [one] = await readPdf(page, pdf, 1, { drawnBefore });
    expect(one!.taken).toBeNull();
    expect(one!.raw.width).toBe(1440);
    expect(one!.raw.height).toBe(300);
  }, 60_000);

  const pat = path.resolve(__dirname, "../../../fixtures/lane2/pat-rivera-design.pdf");
  it.skipIf(!fs.existsSync(pat))("Pat Rivera's design: 2560 x 4056 picture, 580px of black each side trimmed to 1400 x 4056", async () => {
    const [one] = await readPdf(page, fs.readFileSync(pat), 1);
    expect(one!.taken).toMatchObject({ pictureWidth: 2560, pictureHeight: 4056 });
    expect(one!.raw.width).toBe(1400);
    expect(one!.raw.height).toBe(4056);
    expect(one!.taken!.trimmed.left).toBeGreaterThanOrEqual(578);
    expect(one!.taken!.trimmed.left).toBeLessThanOrEqual(582);
    expect(one!.taken!.trimmed.left + one!.taken!.trimmed.right).toBe(1160);
    expect(pngSize(one!.png)).toEqual({ width: 1400, height: 4056 });
  }, 120_000);
});
