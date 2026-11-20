import { describe, expect, it } from "vitest";

import { blank, colourAt, crop, type Box, type Colour, type Rgba } from "./design-pixels";
import { wipeAndFill } from "./design-patch";

/*
  E3: wiping what is drawn over a background and filling the gap
  (design-patch.ts). Synthetic pictures, so every rule is checked exactly.
*/

const paint = (width: number, height: number, colour: (x: number, y: number) => Colour): Rgba => {
  const image = blank(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return image;
};

const MAGENTA: Colour = [255, 0, 255];
/** "Letters": magenta strokes inside a box, every third column and a bar along the middle. */
const withText = (base: (x: number, y: number) => Colour, box: Box) => (x: number, y: number): Colour => {
  const inBox = x >= box.x + 3 && x < box.x + box.w - 3 && y >= box.y + 3 && y < box.y + box.h - 3;
  return inBox && (x % 3 === 0 || y === box.y + Math.floor(box.h / 2)) ? MAGENTA : base(x, y);
};
/** A repeatable JPEG-like noise of up to `n` per channel, scattered in both directions (no Math.random). */
const noise = (x: number, y: number, n: number) => ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) % (2 * n + 1) - n;
/** A photo-like texture: diagonal stripes that change a few levels a pixel, with hard edges where they wrap. */
const photo = (x: number, y: number): Colour => {
  const v = ((x * 3 + y * 5) % 97) * 2;
  return [v, 255 - v, 60 + ((x + y) % 50) * 3];
};

const maxError = (image: Rgba, box: Box, expected: (x: number, y: number) => Colour): number => {
  let worst = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const got = colourAt(image, x, y);
      const want = expected(x, y);
      worst = Math.max(worst, ...got.map((v, c) => Math.abs(v - want[c]!)));
    }
  }
  return worst;
};
const pixelsOutsideUnchanged = (before: Rgba, after: Rgba, box: Box): boolean => {
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
      const i = (y * before.width + x) * 4;
      for (let c = 0; c < 4; c += 1) if (before.data[i + c] !== after.data[i + c]) return false;
    }
  }
  return true;
};
const hasMagenta = (image: Rgba, box: Box): boolean => {
  for (let y = box.y; y < box.y + box.h; y += 1) for (let x = box.x; x < box.x + box.w; x += 1) if (colourAt(image, x, y).every((v, c) => Math.abs(v - MAGENTA[c]!) < 40)) return true;
  return false;
};

describe("wipeAndFill: smooth backgrounds are blended", () => {
  const box: Box = { x: 40, y: 30, w: 60, h: 24 };

  it("a flat colour comes back exactly, the text is gone, and nothing outside the box changes", () => {
    const navy: Colour = [20, 40, 90];
    const before = paint(160, 90, withText(() => navy, box));
    const result = wipeAndFill(before, box);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.method).toBe("blend");
    expect(result.record.feather).toBe(0);
    expect(maxError(result.image, box, () => navy)).toBe(0);
    expect(pixelsOutsideUnchanged(before, result.image, box)).toBe(true);
  });

  it("a straight gradient comes back within 2 per channel", () => {
    const gradient = (x: number, y: number): Colour => [Math.round(x * 1.5), Math.round(100 + y), 200];
    const result = wipeAndFill(paint(160, 90, withText(gradient, box)), box);
    expect(result.ok && result.record.method).toBe("blend");
    if (result.ok) expect(maxError(result.image, box, gradient)).toBeLessThanOrEqual(2);
  });

  it("JPEG-like noise still counts as smooth, and the fill stays within the noise", () => {
    const grey = (x: number, y: number): Colour => [128 + noise(x, y, 4), 128 + noise(x, y, 4), 128 + noise(x, y, 4)];
    const result = wipeAndFill(paint(160, 90, withText(grey, box)), box);
    expect(result.ok && result.record.method).toBe("blend");
    if (!result.ok) return;
    expect(maxError(result.image, box, () => [128, 128, 128])).toBeLessThanOrEqual(4);
    // The noise outside is kept pixel for pixel: a blend touches only the box.
    expect(pixelsOutsideUnchanged(paint(160, 90, withText(grey, box)), result.image, box)).toBe(true);
  });

  it("one stray pixel just outside the box does not streak across the patch", () => {
    const white: Colour = [255, 255, 255];
    const before = paint(160, 90, (x, y) => (x === box.x - 2 && y === box.y + 10 ? [0, 0, 0] : withText(() => white, box)(x, y)));
    const result = wipeAndFill(before, box);
    expect(result.ok).toBe(true);
    if (result.ok) expect(maxError(result.image, box, () => white)).toBe(0);
  });

  it("a box against the picture's edge fills from the sides it has", () => {
    const edgeBox: Box = { x: 0, y: 0, w: 50, h: 20 };
    const green: Colour = [10, 160, 60];
    const result = wipeAndFill(paint(120, 60, withText(() => green, edgeBox)), edgeBox);
    expect(result.ok).toBe(true);
    if (result.ok) expect(maxError(result.image, edgeBox, () => green)).toBe(0);
  });
});

/** The average step between neighbouring pixels inside a box: low for a smooth fill, high for a copied photo. */
const insideRoughness = (image: Rgba, box: Box): number => {
  let total = 0;
  let steps = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w - 1; x += 1) {
      const a = colourAt(image, x, y);
      const c = colourAt(image, x + 1, y);
      total += Math.max(...a.map((v, k) => Math.abs(v - c[k]!)));
      steps += 1;
    }
  }
  return total / steps;
};
const grow = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by });

describe("wipeAndFill: what counts as a straight side (review of E3)", () => {
  // Two flat bands meeting beside the box are not one colour or an even gradient: always the soft fill, wherever the line
  // falls (before, it was blend or soft depending on where the line fell in a 32 px stretch).
  it.each([
    { h: 40, line: 55 },
    { h: 40, line: 56 },
    { h: 70, line: 85 },
    { h: 60, line: 34 },
    { h: 20, line: 30 },
  ])("box $h tall, two flat bands meeting at y=$line beside it: soft", ({ h, line }) => {
    const box: Box = { x: 60, y: 20, w: 80, h };
    const bands = (x: number, y: number): Colour => (y < line ? [20, 40, 90] : [200, 200, 210]);
    const result = wipeAndFill(paint(200, 120, withText(bands, box)), box);
    expect(result.ok && result.record.method).toBe("soft");
  });

  it("a gentle shape along one side (a ridge coming in under the box) is not a gradient: soft, so it is not streaked across", () => {
    // Red everywhere, except a pale ridge below the box that rises and falls along it: every pixel step is small (about 2 levels).
    const box: Box = { x: 20, y: 20, w: 160, h: 40 };
    const ridge = (x: number, y: number): Colour => {
      const top = 70 + Math.abs(x - 100) / 2;
      return y >= top ? [230, 150, 160] : [200, 20, 40];
    };
    const smooth = (x: number, y: number): Colour => {
      // A soft edge to the ridge, about 60 px tall, so neighbouring pixels differ by little.
      const k = Math.min(1, Math.max(0, (y - (30 + Math.abs(x - 100) / 2)) / 60));
      const a = ridge(x, 0);
      const c = ridge(x, 999);
      return [0, 1, 2].map((i) => Math.round(a[i]! + (c[i]! - a[i]!) * k)) as Colour;
    };
    const result = wipeAndFill(paint(200, 140, withText(smooth, box)), box);
    expect(result.ok && result.record.method).toBe("soft");
  });
});

describe("wipeAndFill: photos get a soft fill, never a copy", () => {
  const box: Box = { x: 120, y: 30, w: 60, h: 40 };

  it("wipes the text, fills smoothly with nothing copied in, and eases only a recorded few pixels around it", () => {
    const before = paint(300, 100, withText(photo, box));
    const result = wipeAndFill(before, box);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.method).toBe("soft");
    expect(hasMagenta(result.image, box)).toBe(false);
    // A copy or reflection of the photo would step as much as the photo does; the soft fill steps under half that.
    const photoSteps = insideRoughness(before, { x: 10, y: 10, w: 60, h: 40 });
    expect(photoSteps).toBeGreaterThan(5);
    expect(insideRoughness(result.image, box)).toBeLessThan(photoSteps / 2);
    // A quarter of the smaller side (40 / 4).
    expect(result.record.feather).toBe(10);
    expect(pixelsOutsideUnchanged(before, result.image, grow(box, 10))).toBe(true);
    expect(pixelsOutsideUnchanged(before, result.image, grow(box, 9))).toBe(false);
  });

  it("carries the colours from each side, not one average", () => {
    // Blue photo on the left half, orange photo on the right; the box straddles the middle.
    const split = (x: number, y: number): Colour => {
      const n = noise(x, y, 12);
      return x < 150 ? [30 + n, 60 + n, 200 + n] : [230 + n, 130 + n, 30 + n];
    };
    const result = wipeAndFill(paint(300, 100, withText(split, box)), box);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.method).toBe("soft");
    const nearLeft = colourAt(result.image, box.x + 2, box.y + 20);
    const nearRight = colourAt(result.image, box.x + box.w - 3, box.y + 20);
    expect(nearLeft[2]).toBeGreaterThan(nearLeft[0]);
    expect(nearRight[0]).toBeGreaterThan(nearRight[2]);
  });

  it("counts a box as rough when only one stretch of one side is a photo", () => {
    // Flat sky all round a long box, except a photo above the first 32px of its top: a sixth of one side.
    const long: Box = { x: 50, y: 40, w: 200, h: 30 };
    const sky: Colour = [180, 210, 240];
    const grain = (x: number, y: number): Colour => [120 + noise(x, y, 30), 140 + noise(x + 7, y, 30), 90 + noise(x, y + 5, 30)];
    const mixed = (x: number, y: number): Colour => (x >= long.x && x < long.x + 32 && y < long.y ? grain(x, y) : sky);
    const result = wipeAndFill(paint(300, 100, withText(mixed, long)), long);
    expect(result.ok && result.record.method).toBe("soft");
  });

  it("still fills a photo with only a sliver around it (the asset step flags it)", () => {
    const big: Box = { x: 10, y: 10, w: 180, h: 80 };
    const result = wipeAndFill(paint(200, 100, withText(photo, big)), big);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.method).toBe("soft");
    expect(hasMagenta(result.image, big)).toBe(false);
  });
});

describe("wipeAndFill: what it refuses, and what it records", () => {
  it("refuses a box outside the picture", () => {
    const result = wipeAndFill(paint(50, 50, () => [0, 0, 0]), { x: 40, y: 40, w: 20, h: 5 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/not inside/);
  });

  it("refuses a box that covers the whole picture", () => {
    const result = wipeAndFill(paint(50, 50, () => [0, 0, 0]), { x: 0, y: 0, w: 50, h: 50 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/nothing around it/);
  });

  it("records where, how big, how, and the exact pixels it hid; the input is never changed", () => {
    const box: Box = { x: 40, y: 30, w: 60, h: 24 };
    const before = paint(160, 90, withText(() => [200, 200, 200], box));
    const copy = new Uint8ClampedArray(before.data);
    const result = wipeAndFill(before, box);
    if (!result.ok) throw new Error(result.reason);
    expect(result.record.box).toEqual(box);
    expect(result.record.underneath.width).toBe(60);
    expect(result.record.underneath.height).toBe(24);
    expect(Array.from(result.record.underneath.data)).toEqual(Array.from(crop(before, box).data));
    expect(Array.from(before.data)).toEqual(Array.from(copy));
  });
});
