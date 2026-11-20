import { boxInside, crop, copyOf, type Box, type Colour, type Rgba } from "./design-pixels";

/*
  Wiping what is drawn over a background, and filling the gap (E3, Lane 2
  assets, 13 November 2026; spec 15, section 2 step 9; paid run finding P-2,
  where the hero was cut out with its headline and form baked in).

  A design's background often has a heading, a card or a form drawn over
  it. The page sets real text and real cards on top, so the background is
  delivered clean: each drawn-over box is wiped and filled from what is
  around it, and every patch is recorded.

  Rules:
  - The box must be whole pixels and fully inside the picture, or the patch
    is refused with a reason. A box that covers the whole picture has
    nothing around it to fill from and is refused too.
  - What is around the box decides the fill. Along each side TAWD reads
    the colour just outside the box (each value the median of up to 3
    pixels 2 to 4 px out, so one stray pixel at the edge of a letter does
    not count) and asks whether those colours run in a straight line: a
    flat colour or an even gradient, within LINE_LIMIT per colour channel
    (JPEG noise included):
    - every side straight: **blend**. Each pixel is mixed from those side
      colours, weighted by closeness. A flat colour comes back exactly,
      and so does a straight gradient when the box has picture on both
      sides of it (against the picture's edge, a gradient is carried in
      only from the sides it has).
    - any side not straight: **soft**. A photo, a shape running along a
      side (a mountain's ridge coming in under the box), or two bands
      meeting beside it: a blend between sides can only draw straight
      changes, and drew such shapes across the patch as streaks.
    The soft fill: the colours around the box are carried
      into it smoothly (each pixel takes the average of the picture around
      it at ever wider scales, the nearest counting most), so the sky stays
      sky-coloured and the ground ground-coloured, with no shapes in it.
      Nothing is copied in: a reflected or copied patch of a photo puts
      a second truck or an upside-down mountain on the page, and that is
      a guess (Jason's decision 2, 12 November 2026: stop, flag it, ask
      for the file). On the page the real heading or form sits over that
      spot at the design's width; the soft patch shows only at other
      widths, as background. What was under the box cannot be known, so
      every soft patch is for the asset step to flag with an Upload.
  - The record keeps where, how big, how it was filled, the pixels that
    were under the box (`underneath`), and how far outside it a soft
    patch was feathered (`feather`: those pixels are the photo, softened,
    not hidden). The input picture is never changed.
  - Known limit: a box drawn too tight, with part of the letter or card
    outside it, leaves that part in place and can tint the fill near that
    edge. The read (E4) draws the boxes with a margin.
*/

export type FillMethod = "blend" | "soft";

/** One patch: where (on the picture it was made on), how big, how it was filled, and the pixels that were there before. */
export interface PatchRecord {
  box: Box;
  method: FillMethod;
  /** How many px outside the box were eased into a soft fill (0 for a blend: only the box itself changed). */
  feather: number;
  /** The original pixels under the box, at its exact size: what the patch hid. */
  underneath: Rgba;
}

export type PatchResult = { ok: true; image: Rgba; record: PatchRecord } | { ok: false; reason: string };

/** How far (per colour channel) a side's colours may stray from a straight line and still count as a flat colour or an even gradient. */
export const LINE_LIMIT = 12;
/** Where each side's blend value is sampled: this many pixels out from the box (closest first). */
const SAMPLE_FROM = 2;
const SAMPLE_TO = 4;

interface Room {
  left: number;
  right: number;
  up: number;
  down: number;
}

function roomAround(image: Rgba, box: Box): Room {
  return { left: box.x, right: image.width - box.x - box.w, up: box.y, down: image.height - box.y - box.h };
}

const median3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
  The blend value on one side for one line: the median of the pixels SAMPLE_FROM to SAMPLE_TO out
  (fewer when the side has less room), and how far that sample sits from the box's edge.
*/
function sideSample(image: Rgba, at: (k: number) => [number, number], room: number): { colour: Colour; offset: number } | null {
  if (room <= 0) return null;
  const from = Math.min(SAMPLE_FROM, room);
  const to = Math.min(SAMPLE_TO, room);
  const picks: Colour[] = [];
  for (let k = from; k <= to; k += 1) {
    const [x, y] = at(k);
    const i = (y * image.width + x) * 4;
    picks.push([image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]);
  }
  while (picks.length < 3) picks.push(picks[picks.length - 1]!);
  const colour: Colour = [0, 1, 2].map((c) => median3(picks[0]![c]!, picks[1]![c]!, picks[2]![c]!)) as Colour;
  return { colour, offset: (from + to) / 2 };
}

type Sample = { colour: Colour; offset: number } | null;
interface Sides {
  lefts: Sample[];
  rights: Sample[];
  ups: Sample[];
  downs: Sample[];
}

/** The colour just outside the box along each side, one per line (null on a side with no picture). */
function sidesOf(image: Rgba, box: Box, room: Room): Sides {
  return {
    lefts: Array.from({ length: box.h }, (_, j) => sideSample(image, (k) => [box.x - k, box.y + j], room.left)),
    rights: Array.from({ length: box.h }, (_, j) => sideSample(image, (k) => [box.x + box.w - 1 + k, box.y + j], room.right)),
    ups: Array.from({ length: box.w }, (_, i) => sideSample(image, (k) => [box.x + i, box.y - k], room.up)),
    downs: Array.from({ length: box.w }, (_, i) => sideSample(image, (k) => [box.x + i, box.y + box.h - 1 + k], room.down)),
  };
}

/** The furthest any side's colours stray from their own best straight line (least squares, per channel). */
function bend(sides: Sides): number {
  let worst = 0;
  for (const line of [sides.lefts, sides.rights, sides.ups, sides.downs]) {
    const n = line.length;
    if (n < 3 || !line[0]) continue;
    const meanX = (n - 1) / 2;
    let sxx = 0;
    for (let t = 0; t < n; t += 1) sxx += (t - meanX) ** 2;
    for (let c = 0; c < 3; c += 1) {
      let meanY = 0;
      for (let t = 0; t < n; t += 1) meanY += line[t]!.colour[c]!;
      meanY /= n;
      let sxy = 0;
      for (let t = 0; t < n; t += 1) sxy += (t - meanX) * (line[t]!.colour[c]! - meanY);
      const slope = sxy / sxx;
      for (let t = 0; t < n; t += 1) worst = Math.max(worst, Math.abs(line[t]!.colour[c]! - (meanY + slope * (t - meanX))));
    }
  }
  return worst;
}

/** The blend fill for every pixel of the box, as RGB triples row by row. */
function blendFill(box: Box, sides: Sides): Float32Array {
  const out = new Float32Array(box.w * box.h * 3);
  const { lefts, rights, ups, downs } = sides;
  for (let j = 0; j < box.h; j += 1) {
    for (let i = 0; i < box.w; i += 1) {
      // Each side weighted by 1 / its distance: between two sides that is straight-line interpolation.
      const sides: [{ colour: Colour; offset: number } | null, number][] = [
        [lefts[j]!, i],
        [rights[j]!, box.w - 1 - i],
        [ups[i]!, j],
        [downs[i]!, box.h - 1 - j],
      ];
      let weight = 0;
      const sum = [0, 0, 0];
      for (const [side, inside] of sides) {
        if (!side) continue;
        const w = 1 / (inside + side.offset);
        weight += w;
        for (let c = 0; c < 3; c += 1) sum[c]! += side.colour[c]! * w;
      }
      const o = (j * box.w + i) * 3;
      for (let c = 0; c < 3; c += 1) out[o + c] = sum[c]! / weight;
    }
  }
  return out;
}

/** One level of the soft fill: RGB already divided out, and how much known picture stands behind each pixel (0 to 1). */
interface Level {
  w: number;
  h: number;
  rgb: Float32Array;
  known: Float32Array;
}

/**
  The soft fill for every pixel of the box, as RGB triples row by row ("push-pull"). A window
  around the box is halved again and again, each pixel the average of the known pixels under it,
  until one pixel is left; then, coming back up, every pixel with no known picture of its own takes
  the smoothly enlarged value from the level below. The window reaches half the box's size beyond
  it (at least 8 px), so a big box draws on a wide area and a small one on its near surroundings.
*/
function softFill(image: Rgba, box: Box): { inside: Float32Array; feather: number; smoothAt: (x: number, y: number) => Colour } {
  const margin = Math.max(8, Math.ceil(Math.max(box.w, box.h) / 2));
  const x0 = Math.max(0, box.x - margin);
  const y0 = Math.max(0, box.y - margin);
  const x1 = Math.min(image.width, box.x + box.w + margin);
  const y1 = Math.min(image.height, box.y + box.h + margin);
  const first: Level = { w: x1 - x0, h: y1 - y0, rgb: new Float32Array((x1 - x0) * (y1 - y0) * 3), known: new Float32Array((x1 - x0) * (y1 - y0)) };
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      if (inBox) continue;
      const k = (y - y0) * first.w + (x - x0);
      const i = (y * image.width + x) * 4;
      first.known[k] = 1;
      first.rgb[k * 3] = image.data[i]!;
      first.rgb[k * 3 + 1] = image.data[i + 1]!;
      first.rgb[k * 3 + 2] = image.data[i + 2]!;
    }
  }

  // Push: halve until one pixel.
  const levels: Level[] = [first];
  while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
    const fine = levels[levels.length - 1]!;
    const w = Math.ceil(fine.w / 2);
    const h = Math.ceil(fine.h / 2);
    const coarse: Level = { w, h, rgb: new Float32Array(w * h * 3), known: new Float32Array(w * h) };
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let weight = 0;
        const sum = [0, 0, 0];
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const fx = 2 * x + dx;
            const fy = 2 * y + dy;
            if (fx >= fine.w || fy >= fine.h) continue;
            const f = fy * fine.w + fx;
            const kw = fine.known[f]!;
            weight += kw;
            for (let c = 0; c < 3; c += 1) sum[c]! += fine.rgb[f * 3 + c]! * kw;
          }
        }
        const k = y * w + x;
        coarse.known[k] = Math.min(1, weight);
        if (weight > 0) for (let c = 0; c < 3; c += 1) coarse.rgb[k * 3 + c] = sum[c]! / weight;
      }
    }
    levels.push(coarse);
  }

  // Pull: from the coarsest back up, each pixel mixing its own known part with the enlarged level below it.
  for (let n = levels.length - 2; n >= 0; n -= 1) {
    const fine = levels[n]!;
    const coarse = levels[n + 1]!;
    for (let y = 0; y < fine.h; y += 1) {
      for (let x = 0; x < fine.w; x += 1) {
        const k = y * fine.w + x;
        const own = fine.known[k]!;
        if (own >= 1) continue;
        // Bilinear from the coarse level, at this pixel's centre.
        const cx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const cy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const ax = Math.floor(cx);
        const ay = Math.floor(cy);
        const bx = Math.min(coarse.w - 1, ax + 1);
        const by = Math.min(coarse.h - 1, ay + 1);
        const tx = cx - ax;
        const ty = cy - ay;
        for (let c = 0; c < 3; c += 1) {
          const v =
            coarse.rgb[(ay * coarse.w + ax) * 3 + c]! * (1 - tx) * (1 - ty) +
            coarse.rgb[(ay * coarse.w + bx) * 3 + c]! * tx * (1 - ty) +
            coarse.rgb[(by * coarse.w + ax) * 3 + c]! * (1 - tx) * ty +
            coarse.rgb[(by * coarse.w + bx) * 3 + c]! * tx * ty;
          fine.rgb[k * 3 + c] = fine.rgb[k * 3 + c]! * own + v * (1 - own);
        }
        fine.known[k] = 1;
      }
    }
  }

  const inside = new Float32Array(box.w * box.h * 3);
  for (let j = 0; j < box.h; j += 1) {
    for (let i = 0; i < box.w; i += 1) {
      const k = (box.y + j - y0) * first.w + (box.x + i - x0);
      for (let c = 0; c < 3; c += 1) inside[(j * box.w + i) * 3 + c] = first.rgb[k * 3 + c]!;
    }
  }

  /*
    The feather: how far outside the box the photo is eased into the soft fill, so the patch has no
    hard rectangle edge. A quarter of the box's smaller side, between 2 and 24 px, and never further
    than the window reaches. Each pixel there is mixed toward the window seen at a blur of about the
    feather's size (the level halved that many times), the closer to the box the more.
  */
  const feather = Math.max(0, Math.min(24, margin, Math.max(2, Math.floor(Math.min(box.w, box.h) / 4))));
  const n = Math.min(levels.length - 1, Math.max(1, Math.round(Math.log2(Math.max(2, feather)))));
  const blurred = levels[n]!;
  const scale = 2 ** n;
  const smoothAt = (x: number, y: number): Colour => {
    const cx = Math.min(blurred.w - 1, Math.max(0, (x - x0 + 0.5) / scale - 0.5));
    const cy = Math.min(blurred.h - 1, Math.max(0, (y - y0 + 0.5) / scale - 0.5));
    const ax = Math.floor(cx);
    const ay = Math.floor(cy);
    const bx = Math.min(blurred.w - 1, ax + 1);
    const by = Math.min(blurred.h - 1, ay + 1);
    const tx = cx - ax;
    const ty = cy - ay;
    return [0, 1, 2].map(
      (c) =>
        blurred.rgb[(ay * blurred.w + ax) * 3 + c]! * (1 - tx) * (1 - ty) +
        blurred.rgb[(ay * blurred.w + bx) * 3 + c]! * tx * (1 - ty) +
        blurred.rgb[(by * blurred.w + ax) * 3 + c]! * (1 - tx) * ty +
        blurred.rgb[(by * blurred.w + bx) * 3 + c]! * tx * ty,
    ) as Colour;
  };
  return { inside, feather, smoothAt };
}

/** Wipe `box` on `image` and fill it from what is around it. Never changes the input; returns a new picture. */
export function wipeAndFill(image: Rgba, box: Box): PatchResult {
  if (!boxInside(box, image)) return { ok: false, reason: `the box ${box.w}x${box.h} at ${box.x},${box.y} is not inside the ${image.width}x${image.height} picture` };
  const room = roomAround(image, box);
  if (room.left + room.right + room.up + room.down === 0) return { ok: false, reason: "it covers the whole picture, so there is nothing around it to fill from" };

  const underneath = crop(image, box);
  const sides = sidesOf(image, box, room);
  const method: FillMethod = bend(sides) <= LINE_LIMIT ? "blend" : "soft";
  const soft = method === "soft" ? softFill(image, box) : null;
  const fill = soft ? soft.inside : blendFill(box, sides);
  const out = copyOf(image);
  const feather = soft?.feather ?? 0;
  if (soft && feather > 0) {
    // Outside the box, up to `feather` px away (by the larger of the two distances): eased toward the blurred picture.
    for (let y = Math.max(0, box.y - feather); y < Math.min(image.height, box.y + box.h + feather); y += 1) {
      for (let x = Math.max(0, box.x - feather); x < Math.min(image.width, box.x + box.w + feather); x += 1) {
        const dx = x < box.x ? box.x - x : x >= box.x + box.w ? x - (box.x + box.w - 1) : 0;
        const dy = y < box.y ? box.y - y : y >= box.y + box.h ? y - (box.y + box.h - 1) : 0;
        const d = Math.max(dx, dy);
        if (d === 0) continue;
        const a = 1 - d / (feather + 1);
        const s = soft.smoothAt(x, y);
        const p = (y * image.width + x) * 4;
        for (let c = 0; c < 3; c += 1) out.data[p + c] = Math.round(image.data[p + c]! * (1 - a) + s[c]! * a);
      }
    }
  }
  for (let j = 0; j < box.h; j += 1) {
    for (let i = 0; i < box.w; i += 1) {
      const p = ((box.y + j) * image.width + box.x + i) * 4;
      const f = (j * box.w + i) * 3;
      out.data[p] = Math.round(fill[f]!);
      out.data[p + 1] = Math.round(fill[f + 1]!);
      out.data[p + 2] = Math.round(fill[f + 2]!);
      out.data[p + 3] = 255;
    }
  }
  return { ok: true, image: out, record: { box, method, feather, underneath } };
}
