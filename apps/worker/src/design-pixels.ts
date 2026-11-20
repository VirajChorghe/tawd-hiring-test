/*
  Pixels of a client's design, as plain numbers (E3, Lane 2 assets, 13 November 2026).

  The picture step (design-assets.ts) and the patch step (design-patch.ts)
  work on raw RGBA pixels in Node, so every rule can be tested without a
  browser. A browser is used only to turn a PNG or JPEG into pixels and
  back (see readPixels / writePng in design-assets.ts).
*/

/** A picture as RGBA bytes, row by row from the top left: 4 bytes a pixel. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A box on a picture, in whole pixels: left, top, width, height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Colour = [number, number, number];

export function blank(width: number, height: number): Rgba {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function copyOf(image: Rgba): Rgba {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

/** Whole pixels, a positive size, and fully inside the picture. */
export function boxInside(box: Box, image: { width: number; height: number }): boolean {
  const whole = [box.x, box.y, box.w, box.h].every((n) => Number.isInteger(n));
  return whole && box.w > 0 && box.h > 0 && box.x >= 0 && box.y >= 0 && box.x + box.w <= image.width && box.y + box.h <= image.height;
}

/** The box cut out at its exact size. A box not fully inside the picture is refused, never clamped: a clamped crop would be the wrong picture at the wrong size. */
export function crop(image: Rgba, box: Box): Rgba {
  if (!boxInside(box, image)) throw new Error(`The box ${box.w}x${box.h} at ${box.x},${box.y} is not inside the ${image.width}x${image.height} picture.`);
  const out = blank(box.w, box.h);
  for (let y = 0; y < box.h; y += 1) {
    const from = ((box.y + y) * image.width + box.x) * 4;
    out.data.set(image.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return out;
}

export function colourAt(image: Rgba, x: number, y: number): Colour {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
}

export function hex(c: Colour): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** The largest per-channel difference between two colours. */
export function colourDistance(a: Colour, b: Colour): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}
