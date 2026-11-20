import type { Mask } from "./contour";

/*
  Matching shapes by code (style kit, 28 September 2026): an icon cut from
  the design against the kit's vector icons, and a line of text against
  candidate fonts. Both sides are drawn as black-and-white masks, fitted
  into the same small grid and compared with a pixel or two of slack, so a
  slightly thicker stroke still counts as the same shape.
*/

export function inkCount(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.on.length; i += 1) n += mask.on[i]!;
  return n;
}

/* The mask cut down to its ink. */
export function trimInk(mask: Mask): Mask {
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.h; y += 1) {
    for (let x = 0; x < mask.w; x += 1) {
      if (mask.on[y * mask.w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { w: 0, h: 0, on: new Uint8Array(0) };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) on[y * w + x] = mask.on[(y + y0) * mask.w + x + x0]!;
  return { w, h, on };
}

/* The ink fitted into a size x size grid, keeping its proportions, centred (each cell on if a third of it is ink). */
export function fitSquare(mask: Mask, size = 32): Mask {
  const t = trimInk(mask);
  const on = new Uint8Array(size * size);
  if (t.w === 0) return { w: size, h: size, on };
  const scale = size / Math.max(t.w, t.h);
  const ox = (size - t.w * scale) / 2, oy = (size - t.h * scale) / 2;
  return resample(t, size, size, scale, scale, ox, oy);
}

/* The ink stretched to exactly w x h (for text, where the proportions are compared separately). */
export function fitStretch(mask: Mask, w: number, h: number): Mask {
  const t = trimInk(mask);
  if (t.w === 0) return { w, h, on: new Uint8Array(w * h) };
  return resample(t, w, h, w / t.w, h / t.h, 0, 0);
}

function resample(t: Mask, w: number, h: number, sx: number, sy: number, ox: number, oy: number): Mask {
  const on = new Uint8Array(w * h);
  const cover = new Float32Array(w * h);
  const area = new Float32Array(w * h);
  for (let y = 0; y < t.h; y += 1) {
    for (let x = 0; x < t.w; x += 1) {
      const gx = Math.min(w - 1, Math.max(0, Math.floor(ox + (x + 0.5) * sx)));
      const gy = Math.min(h - 1, Math.max(0, Math.floor(oy + (y + 0.5) * sy)));
      area[gy * w + gx] += 1;
      cover[gy * w + gx] += t.on[y * t.w + x]!;
    }
  }
  for (let i = 0; i < w * h; i += 1) {
    if (area[i]! > 0) on[i] = cover[i]! / area[i]! >= 0.34 ? 1 : 0;
  }
  // Scaling up leaves empty cells between source pixels: fill each from its nearest source cell.
  if (sx > 1 || sy > 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (area[y * w + x]! > 0) continue;
        const srcX = Math.floor((x + 0.5 - ox) / sx), srcY = Math.floor((y + 0.5 - oy) / sy);
        if (srcX >= 0 && srcY >= 0 && srcX < t.w && srcY < t.h) on[y * w + x] = t.on[srcY * t.w + srcX]!;
      }
    }
  }
  return { w, h, on };
}

export function dilate(mask: Mask, r = 1): Mask {
  const { w, h } = mask;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask.on[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) on[yy * w + xx] = 1;
        }
      }
    }
  }
  return { w, h, on };
}

/*
  How alike two masks of the same size are, 0 to 1: the share of each
  one's ink that lands on (or right next to) the other's.
*/
export function shapeSimilarity(a: Mask, b: Mask, slack = 1): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error("Masks must be the same size to compare.");
  const da = dilate(a, slack), db = dilate(b, slack);
  let aHit = 0, aInk = 0, bHit = 0, bInk = 0;
  for (let i = 0; i < a.on.length; i += 1) {
    if (a.on[i]) {
      aInk += 1;
      if (db.on[i]) aHit += 1;
    }
    if (b.on[i]) {
      bInk += 1;
      if (da.on[i]) bHit += 1;
    }
  }
  if (aInk === 0 || bInk === 0) return 0;
  return Math.min(aHit / aInk, bHit / bInk);
}

/* Plain overlap: shared ink over all ink. */
export function overlapScore(a: Mask, b: Mask): number {
  let both = 0, either = 0;
  for (let i = 0; i < a.on.length; i += 1) {
    if (a.on[i] && b.on[i]) both += 1;
    if (a.on[i] || b.on[i]) either += 1;
  }
  return either ? both / either : 0;
}

/* Takes away a ring drawn around an icon (the sample client's circled social icons), leaving what's inside. */
export function withoutRing(mask: Mask): { mask: Mask; ring: boolean } {
  const t = trimInk(mask);
  const { w, h, on } = t;
  if (w < 12 || h < 12) return { mask: t, ring: false };
  // The parts touching the edge of the ink's box.
  const label = new Int32Array(w * h).fill(-1);
  const touches: number[] = [];
  let id = 0;
  for (let s = 0; s < w * h; s += 1) {
    if (!on[s] || label[s] !== -1) continue;
    const queue = [s];
    label[s] = id;
    let edge = false;
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (on[j] && label[j] === -1) {
            label[j] = id;
            queue.push(j);
          }
        }
      }
    }
    if (edge) touches.push(id);
    id += 1;
  }
  if (id < 2 || touches.length === 0) return ringByShape(t);
  // A ring touches all four sides and leaves the middle clear.
  const ringId = touches[0]!;
  const sides = [false, false, false, false];
  for (let i = 0; i < w * h; i += 1) {
    if (label[i] !== ringId) continue;
    const x = i % w, y = (i - x) / w;
    if (x === 0) sides[0] = true;
    if (x === w - 1) sides[1] = true;
    if (y === 0) sides[2] = true;
    if (y === h - 1) sides[3] = true;
  }
  if (!sides.every(Boolean) || label[Math.floor(h / 2) * w + Math.floor(w / 2)] === ringId) return ringByShape(t);
  // Only a round ring, drawn nearly all the way round (a speech bubble is not a ring).
  if (h / w < 0.85 || h / w > 1.18 || !roundRim(t, (i) => label[i] === ringId)) return { mask: t, ring: false };
  const inner = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) inner[i] = on[i] && label[i] !== ringId ? 1 : 0;
  return { mask: trimInk({ w, h, on: inner }), ring: true };
}

/* Whether ink (as `is` says) is found nearly all the way round, just inside the box's circle. */
function roundRim(t: Mask, is: (i: number) => boolean): boolean {
  const { w, h } = t;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  let rim = 0;
  for (let a = 0; a < 64; a += 1) {
    let hit = false;
    for (const k of [0.88, 0.93, 0.98]) {
      const x = Math.min(w - 1, Math.floor(cx + Math.cos((a / 64) * Math.PI * 2) * r * k));
      const y = Math.min(h - 1, Math.floor(cy + Math.sin((a / 64) * Math.PI * 2) * r * k));
      if (is(y * w + x)) hit = true;
    }
    if (hit) rim += 1;
  }
  return rim >= 58;
}

/* A round ring the glyph touches: drawn nearly all the way round near the edge; clear that band, keep the inside. */
function ringByShape(t: Mask): { mask: Mask; ring: boolean } {
  const { w, h, on } = t;
  if (h / w < 0.85 || h / w > 1.18) return { mask: t, ring: false };
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2;
  let rim = 0;
  for (let a = 0; a < 64; a += 1) {
    let hit = false;
    for (const k of [0.92, 0.96, 0.99]) {
      const x = Math.floor(cx + Math.cos((a / 64) * Math.PI * 2) * r * k), y = Math.floor(cy + Math.sin((a / 64) * Math.PI * 2) * r * k);
      if (on[Math.min(h - 1, y) * w + Math.min(w - 1, x)]) hit = true;
    }
    if (hit) rim += 1;
  }
  if (rim < 58) return { mask: t, ring: false };
  // The ring's thickness: how far in the ink runs from the edge on the left, middle row.
  let thick = 0;
  while (thick < w / 4 && on[Math.floor(cy) * w + thick]) thick += 1;
  const inner = new Uint8Array(w * h);
  let n = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (on[y * w + x] && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r - thick - 1) {
        inner[y * w + x] = 1;
        n += 1;
      }
    }
  }
  return n >= 6 ? { mask: trimInk({ w, h, on: inner }), ring: true } : { mask: t, ring: false };
}

/* A light shape on a filled disc (a play button drawn as a solid circle): the shape is the disc's hole. */
export function holeOfDisc(mask: Mask): Mask | null {
  const t = trimInk(mask);
  const ink = inkCount(t) / Math.max(1, t.w * t.h);
  if (ink < 0.5 || t.w < 10 || t.h / t.w < 0.85 || t.h / t.w > 1.18) return null;
  const out = new Uint8Array(t.w * t.h);
  const cx = t.w / 2, cy = t.h / 2, r = Math.min(t.w, t.h) / 2 - 1;
  // A disc is solid all the way round just inside its edge.
  let rim = 0;
  for (let a = 0; a < 48; a += 1) {
    const x = Math.floor(cx + Math.cos((a / 48) * Math.PI * 2) * r * 0.88), y = Math.floor(cy + Math.sin((a / 48) * Math.PI * 2) * r * 0.88);
    if (t.on[y * t.w + x]) rim += 1;
  }
  if (rim < 40) return null;
  let n = 0;
  for (let y = 0; y < t.h; y += 1) {
    for (let x = 0; x < t.w; x += 1) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r * 0.85 && !t.on[y * t.w + x]) {
        out[y * t.w + x] = 1;
        n += 1;
      }
    }
  }
  return n >= 6 ? trimInk({ w: t.w, h: t.h, on: out }) : null;
}

export interface Match<T> {
  item: T;
  score: number;
}

/* The ink pixels on the shape's edge (next to a blank pixel, or the grid's side). */
export function edges(mask: Mask): Mask {
  const { w, h, on } = mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!on[y * w + x]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !on[y * w + x - 1] || !on[y * w + x + 1] || !on[(y - 1) * w + x] || !on[(y + 1) * w + x]) out[y * w + x] = 1;
    }
  }
  return { w, h, on: out };
}

/* How far every cell is from the nearest ink (two passes, 3-4 chamfer, in cells). */
export function distanceTo(mask: Mask): Float32Array {
  const { w, h, on } = mask;
  const d = new Float32Array(w * h).fill(1e6);
  for (let i = 0; i < w * h; i += 1) if (on[i]) d[i] = 0;
  const step = (i: number, j: number, c: number) => {
    if (d[j]! + c < d[i]!) d[i] = d[j]! + c;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x > 0) step(i, i - 1, 3);
      if (y > 0) {
        step(i, i - w, 3);
        if (x > 0) step(i, i - w - 1, 4);
        if (x < w - 1) step(i, i - w + 1, 4);
      }
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (x < w - 1) step(i, i + 1, 3);
      if (y < h - 1) {
        step(i, i + w, 3);
        if (x < w - 1) step(i, i + w + 1, 4);
        if (x > 0) step(i, i + w - 1, 4);
      }
    }
  }
  for (let i = 0; i < w * h; i += 1) d[i] = d[i]! / 3;
  return d;
}

/*
  How alike two shapes' outlines are, 0 to 1: the average distance from
  each one's edge to the other's, both ways (the worse of the two), where 0
  cells apart scores 1 and `falloff` cells or more scores 0.
*/
export function edgeSimilarity(a: Mask, b: Mask, falloff = 4): number {
  const ea = edges(a), eb = edges(b);
  const da = distanceTo(ea), db = distanceTo(eb);
  const mean = (e: Mask, d: Float32Array) => {
    let sum = 0, n = 0;
    for (let i = 0; i < e.on.length; i += 1) {
      if (e.on[i]) {
        sum += Math.min(d[i]!, falloff * 2);
        n += 1;
      }
    }
    return n ? sum / n : falloff * 2;
  };
  const worst = Math.max(mean(ea, db), mean(eb, da));
  return Math.max(0, 1 - worst / falloff);
}

/* The best-scoring candidates, best first. */
export function rankMatches<T>(target: Mask, candidates: { item: T; mask: Mask }[], size = 48, top = 3): Match<T>[] {
  const fitted = fitSquare(target, size);
  const targetTrim = trimInk(target);
  const targetRatio = targetTrim.w / Math.max(1, targetTrim.h);
  return candidates
    .map((c) => {
      const t = trimInk(c.mask);
      const ratio = t.w / Math.max(1, t.h);
      // Very different proportions can't be the same icon.
      const shape = Math.exp(-Math.abs(Math.log(Math.max(0.01, ratio / Math.max(0.01, targetRatio)))) * 1.5);
      return { item: c.item, score: edgeSimilarity(fitted, fitSquare(c.mask, size)) * shape };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/*
  How alike a line of text in the design and the same words in a candidate
  font are: the shapes stretched to one size and compared, times how
  close their proportions are.
*/
export function textSimilarity(design: Mask, candidate: Mask): number {
  const a = trimInk(design), b = trimInk(candidate);
  if (a.w === 0 || b.w === 0) return 0;
  const h = 40;
  const w = Math.max(40, Math.min(400, Math.round((a.w / a.h) * h)));
  const shape = shapeSimilarity(fitStretch(a, w, h), fitStretch(b, w, h), 1);
  const ra = a.w / a.h, rb = b.w / b.h;
  return shape * Math.exp(-Math.abs(Math.log(ra / rb)) * 2);
}

export function erode(mask: Mask, r = 1): Mask {
  const inverted = { w: mask.w, h: mask.h, on: mask.on.map((v) => (v ? 0 : 1)) };
  const grown = dilate(inverted, r);
  return { w: mask.w, h: mask.h, on: grown.on.map((v) => (v ? 0 : 1)) };
}

/* Fills specks and scratches in printed-looking (distressed) lettering, so its shape is compared, not its texture. */
export function closeGaps(mask: Mask, r = 2): Mask {
  return erode(dilate(mask, r), r);
}

/*
  Which vector icon each icon in the inventory becomes (style kit). Social
  icons (in a row the read called icons, or drawn in a ring or on a disc)
  are matched to the brand marks; the rest keep the design's own traced
  shape unless a set icon matches very closely.
*/
export function chooseIcons<I extends { name: string; style: "outline" | "filled" | "brand" }>(
  icons: { id: string; mask: Mask; group: string | null }[],
  set: { item: I; mask: Mask }[],
): { id: string; name: string | null; style: I["style"] | null; score: number; frame: "ring" | "disc" | null }[] {
  const brands = set.filter((c) => c.item.name.startsWith("brand-")).flatMap((c) => {
    const hole = holeOfDisc(c.mask);
    return hole ? [c, { item: c.item, mask: hole }] : [c];
  });
  const plain = set.filter((c) => !c.item.name.startsWith("brand-"));
  return icons.map((icon) => {
    if (icon.group === "play over a photo") return { id: icon.id, name: "player-play", style: "filled" as const, score: 1, frame: "disc" as const };
    const disc = holeOfDisc(icon.mask);
    const ring = disc ? null : withoutRing(icon.mask);
    const glyph = disc ?? (ring?.ring ? ring.mask : icon.mask);
    const frame = disc ? ("disc" as const) : ring?.ring ? ("ring" as const) : null;
    const social = Boolean(icon.group) || frame !== null;
    if (social) {
      const [best, next] = rankMatches(glyph, brands, 32, 6).filter((m, i, all) => all.findIndex((x) => x.item.name === m.item.name) === i);
      if (best && (best.score >= 0.7 || (best.score >= 0.35 && best.score - (next?.score ?? 0) >= 0.15))) return { id: icon.id, name: best.item.name, style: best.item.style, score: best.score, frame };
    }
    const [best] = rankMatches(glyph, plain, 48, 1);
    if (best && best.score >= 0.85) return { id: icon.id, name: best.item.name, style: best.item.style, score: best.score, frame };
    return { id: icon.id, name: null, style: null, score: best?.score ?? 0, frame: null };
  });
}
