/*
  "Suggest colors from the logo" (the founders' request, 25 September
  2026): the logo's main colours, read from its pixels with no AI. The
  browser draws the logo small and hands the pixels here; the colours come
  back most-used first, near-duplicates merged, the see-through and plain
  white background left out.
*/

export interface PaletteColor {
  hex: string;
  /** The share of the logo's visible pixels this colour covers, 0 to 1. */
  share: number;
}

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/*
  pixels: RGBA bytes, four per pixel (a canvas's ImageData.data).
  Colours covering less than 2% of the logo are noise from its edges.
*/
export function logoPalette(pixels: ArrayLike<number>, maxColors = 6, minShare = 0.02): PaletteColor[] {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let visible = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    if (a < 128) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    // The white a logo sits on is its background, not a brand colour.
    if (r > 245 && g > 245 && b > 245) continue;
    visible += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }
  if (visible === 0) return [];

  // Most-used first; a colour close to one already kept joins it.
  const merged: { r: number; g: number; b: number; n: number }[] = [];
  for (const bucket of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    const colour = { r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n };
    const near = merged.find((m) => Math.hypot(m.r / m.n - colour.r, m.g / m.n - colour.g, m.b / m.n - colour.b) < 48);
    if (near) {
      near.r += bucket.r;
      near.g += bucket.g;
      near.b += bucket.b;
      near.n += bucket.n;
    } else {
      merged.push({ ...bucket });
    }
  }
  /*
    The soft edge where navy meets the white background is pale blue: a mix
    of two colours already found, not a colour of its own. A colour lying
    between two kept ones (or a kept one and white or black) is left out.
  */
  const kept: RGB[] = [];
  const out: PaletteColor[] = [];
  for (const m of merged.sort((a, b) => b.n - a.n)) {
    if (m.n / visible < minShare || out.length >= maxColors) continue;
    const colour: RGB = [m.r / m.n, m.g / m.n, m.b / m.n];
    const ends: RGB[] = [...kept, [255, 255, 255], [0, 0, 0]];
    const blend = kept.some((a) => ends.some((b) => b !== a && isBetween(colour, a, b)));
    if (blend) continue;
    kept.push(colour);
    out.push({ hex: hex(...colour), share: Math.round((m.n / visible) * 100) / 100 });
  }
  return out;
}

type RGB = [number, number, number];

/* Whether c sits on the straight line from a to b, part-way along: a mix of the two. */
function isBetween(c: RGB, a: RGB, b: RGB): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
  if (length === 0) return false;
  const t = ((c[0] - a[0]) * ab[0]! + (c[1] - a[1]) * ab[1]! + (c[2] - a[2]) * ab[2]!) / length;
  if (t < 0.12 || t > 0.88) return false;
  const off = Math.hypot(a[0] + ab[0]! * t - c[0], a[1] + ab[1]! * t - c[1], a[2] + ab[2]! * t - c[2]);
  return off < 24;
}

/* ---------- colour arithmetic for the picker ---------- */

export interface Hsv {
  /** 0 to 360. */
  h: number;
  /** 0 to 1. */
  s: number;
  /** 0 to 1. */
  v: number;
}

/* "#1f4e79" or "#1F4" to its six-digit upper-case form; null when it isn't a hex colour. */
export function normalizeHex(value: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const digits = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join("") : m[1]!;
  return `#${digits.toUpperCase()}`;
}

export function hexToHsv(value: string): Hsv | null {
  const normal = normalizeHex(value);
  if (!normal) return null;
  const r = parseInt(normal.slice(1, 3), 16) / 255;
  const g = parseInt(normal.slice(3, 5), 16) / 255;
  const b = parseInt(normal.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
