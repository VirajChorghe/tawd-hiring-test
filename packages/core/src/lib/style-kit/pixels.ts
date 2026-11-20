/*
  Pixels and colours for the style kit (Jason, 28 September 2026).

  The style kit is read from the design's picture by code, not AI: the
  picture is decoded once (in Chromium, by the worker) into RGBA pixels and
  everything here works on those. All positions are in the picture's own
  pixels, drawn 1440px wide like the design read.
*/

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array | Uint8ClampedArray;
}

export type Rgb = [number, number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rgbAt(p: Pixels, x: number, y: number): Rgb {
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!];
}

/** The largest difference in any one channel: 0 same, 255 opposite. */
export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function toHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** Perceived lightness, 0 (black) to 255 (white). */
export function lightness(c: Rgb): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

export function boxArea(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function intersects(a: Box, b: Box, pad = 0): boolean {
  return a.x - pad < b.x + b.w && b.x - pad < a.x + a.w && a.y - pad < b.y + b.h && b.y - pad < a.y + a.h;
}

export function contains(outer: Box, inner: Box, slack = 0): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}

export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/* The most common colour in a box (colours grouped in steps of 8), averaged within its group. */
export function dominantColor(p: Pixels, box: Box, step = 2): { color: Rgb; share: number } {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const x1 = Math.min(p.width, box.x + box.w);
  const y1 = Math.min(p.height, box.y + box.h);
  for (let y = Math.max(0, box.y); y < y1; y += step) {
    for (let x = Math.max(0, box.x); x < x1; x += step) {
      const [r, g, b] = rgbAt(p, x, y);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      counts.set(key, bin);
      total += 1;
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const bin of counts.values()) if (!best || bin.n > best.n) best = bin;
  if (!best || total === 0) return { color: [255, 255, 255], share: 0 };
  return { color: [best.r / best.n, best.g / best.n, best.b / best.n], share: best.n / total };
}

/* A small picture made from the pixels, for tests. */
export function blankPixels(width: number, height: number, fill: Rgb): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

export function fillBox(p: Pixels, box: Box, color: Rgb): void {
  for (let y = Math.max(0, box.y); y < Math.min(p.height, box.y + box.h); y += 1) {
    for (let x = Math.max(0, box.x); x < Math.min(p.width, box.x + box.w); x += 1) {
      const i = (y * p.width + x) * 4;
      p.data[i] = color[0];
      p.data[i + 1] = color[1];
      p.data[i + 2] = color[2];
    }
  }
}
