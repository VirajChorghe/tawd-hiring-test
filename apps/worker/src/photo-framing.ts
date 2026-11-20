import type { Browser } from "playwright-core";

import { ownPageContext } from "./locked-context";

/*
  Framing baked into a photo on the client's current site (gap 10, Jason,
  5 November 2026: New Dawn's photos carried the old site's navy and orange
  corner blocks, so they looked unlike every other photo). By code, $0:
  - a band of one solid colour along an edge (a border, a bar);
  - a solid block in a corner with straight, sharp inner edges (a corner
    tab), cut off on whichever side loses less of the photo.
  Light or see-through colours are left alone: a white border or a pale sky
  is too easy to confuse with the photo, and the design build's own trimmer
  handles light strips with words in them. Both kinds must end in a hard
  line (a sky or an awning's fabric fades or breaks up instead). Never more
  than 20% from a side, and the photo keeps at least 60% of each side, or
  nothing is cut. The original is always kept beside the cut copy.
*/

export interface FramingCut {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TOLERANCE = 24;
const MAX_BAND = 0.15;
const MAX_SIDE = 0.2;
const MIN_KEEP = 0.6;
const MIN_BLOCK = 0.03;

type Px = ArrayLike<number>;

/** The solid framing on a photo's edges, in its own pixels (RGBA, row by row); null when there is none or it can't be cut safely. */
export function findFraming(data: Px, width: number, height: number): FramingCut | null {
  if (width < 24 || height < 24) return null;
  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!] as const;
  };
  const same = (a: readonly number[], b: readonly number[]) => Math.abs(a[0]! - b[0]!) <= TOLERANCE && Math.abs(a[1]! - b[1]!) <= TOLERANCE && Math.abs(a[2]! - b[2]!) <= TOLERANCE;
  const diff = (a: readonly number[], b: readonly number[]) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
  // Pale, or see-through (a transparent PNG's edge reads as black otherwise): never treated as framing.
  const light = (c: readonly number[]) => c[3]! < 250 || 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]! > 200;

  const cut: FramingCut = { left: 0, top: 0, right: 0, bottom: 0 };

  // The rails every cut must clear, whichever pass found it.
  const finish = (c: FramingCut): FramingCut | null => {
    if (c.left + c.top + c.right + c.bottom === 0) return null;
    for (const side of ["left", "right"] as const) if (c[side] > width * MAX_SIDE) return null;
    for (const side of ["top", "bottom"] as const) if (c[side] > height * MAX_SIDE) return null;
    if (width - c.left - c.right < width * MIN_KEEP || height - c.top - c.bottom < height * MIN_KEEP) return null;
    return c;
  };

  /*
    0. A composed canvas (#3, 8 November 2026, confirmed on New Dawn's real
    photos): the photograph sits INSET in a canvas whose border is a
    transparent or near-white margin, with decorative solid shapes (the navy
    and orange corner blocks) peeking out from BEHIND it. The visible shapes
    are L-shaped, never the rectangles pass 2 models, and the margin is
    light, so passes 1 and 2 can never cut them. Here the photograph's own
    content rectangle is found and the cut goes to its box — one cut removes
    the margin and every decorative shape together.

    Deliberately conservative, no-false-positive priority:
    - the whole border ring must be margin-like (light/transparent, or one of
      at most four solid colours), so an ordinary photograph never qualifies;
    - a composition is only believed when the ring has real transparency or a
      solid block of meaningful size on the ring — a JPEG that merely fades
      to white at its edges (a sky, a vignette) has neither and is left
      alone, keeping the old "light borders are never framing" promise;
    - everything outside the found box must be margin-like, so the cut can
      never slice through content;
    - the usual rails hold: at most 20% off a side, at least 60% kept.
  */
  const composedBox = (): FramingCut | null => {
    const solids: (readonly number[])[] = [];
    const solidCounts: number[] = [];
    let transparent = 0;
    let lit = 0;
    let ring = 0;
    const ringPixel = (c: readonly number[]): boolean => {
      ring += 1;
      if (c[3]! < 250) transparent += 1;
      if (light(c)) {
        lit += 1;
        return true;
      }
      for (let s = 0; s < solids.length; s += 1) {
        if (same(c, solids[s]!)) {
          solidCounts[s]! += 1;
          return true;
        }
      }
      if (solids.length >= 4) return false; // a busy ring is a photograph, not a canvas
      solids.push(c);
      solidCounts.push(1);
      return true;
    };
    for (let x = 0; x < width; x += 1) if (!ringPixel(at(x, 0)) || !ringPixel(at(x, height - 1))) return null;
    for (let y = 1; y < height - 1; y += 1) if (!ringPixel(at(0, y)) || !ringPixel(at(width - 1, y))) return null;
    // A composition's canvas is LIGHT: a mostly dark ring is a photograph's own edge (a night
    // shot, a letterbox, a vignette), never a margin — this pass must not touch it (CodeRabbit PR #54).
    if (lit < ring * 0.5) return null;
    // And it needs real transparency, or at least one solid block with presence on the ring.
    if (transparent < ring * 0.25 && !solidCounts.some((n) => n >= ring * 0.03)) return null;

    /*
      Margin-like: light/transparent, or near one of the ring's solid colours.
      A decorative block may be a gradient (New Dawn's orange is), so the
      match against a ring colour is twice as wide as `same` — still a colour
      MATCH, never a pixel-to-pixel crawl: following smooth gradients was
      tried and rejected, because a block's soft drop-shadow ramps into the
      photograph and the crawl eats it. A composition whose blocks drift
      further than this from their ring colour is refused by the outside
      check below and left uncut — the conservative miss.
    */
    const wide = (a: readonly number[], b: readonly number[]) =>
      Math.abs(a[0]! - b[0]!) <= TOLERANCE * 2 && Math.abs(a[1]! - b[1]!) <= TOLERANCE * 2 && Math.abs(a[2]! - b[2]!) <= TOLERANCE * 2;
    const marginLike = (c: readonly number[]) => light(c) || solids.some((s) => wide(c, s));
    const colPhoto: number[] = new Array<number>(width).fill(0);
    const rowPhoto: number[] = new Array<number>(height).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!marginLike(at(x, y))) {
          colPhoto[x]! += 1;
          rowPhoto[y]! += 1;
        }
      }
    }
    let left = 0;
    let right = width - 1;
    let top = 0;
    let bottom = height - 1;
    while (left < width && colPhoto[left]! < height * 0.3) left += 1;
    while (right >= 0 && colPhoto[right]! < height * 0.3) right -= 1;
    while (top < height && rowPhoto[top]! < width * 0.3) top += 1;
    while (bottom >= 0 && rowPhoto[bottom]! < width * 0.3) bottom -= 1;
    if (left >= right || top >= bottom) return null;
    if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1) return null;
    // The cut must never slice through content: outside the box, (almost) everything is margin-like.
    let outside = 0;
    let outsideMargin = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x >= left && x <= right && y >= top && y <= bottom) continue;
        outside += 1;
        if (marginLike(at(x, y))) outsideMargin += 1;
      }
    }
    if (outside === 0 || outsideMargin / outside < 0.97) return null;
    return finish({ left, top, right: width - 1 - right, bottom: height - 1 - bottom });
  };
  const composed = composedBox();
  if (composed) return composed;

  // 1. Bands: whole lines of one solid colour, from each edge inward.
  const line = (side: keyof FramingCut, k: number, i: number) =>
    side === "top" ? at(i, k) : side === "bottom" ? at(i, height - 1 - k) : side === "left" ? at(k, i) : at(width - 1 - k, i);
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const length = side === "top" || side === "bottom" ? width : height;
    const depth = side === "top" || side === "bottom" ? height : width;
    const colour = line(side, 0, Math.floor(length / 2));
    if (light(colour)) continue;
    let k = 0;
    while (k < depth * MAX_BAND + 1) {
      let n = 0;
      for (let i = 0; i < length; i += 1) if (same(line(side, k, i), colour)) n += 1;
      if (n / length < 0.97) break;
      k += 1;
    }
    // A band as deep as the limit is a flat part of the photo (a wall, a dark sky), not framing.
    if (k === 0 || k > depth * MAX_BAND || k >= depth) continue;
    // Framing ends in a hard line: (almost) every pixel just past the band is clearly another colour.
    // A sky or an awning's fabric fades or breaks up instead (review M1), and is left alone.
    let sharp = 0;
    for (let i = 0; i < length; i += 1) if (diff(line(side, k, i), colour) >= 40) sharp += 1;
    if (sharp / length >= 0.8) cut[side] = k;
  }

  // 2. Corner blocks inside what is left: a solid rectangle with straight, sharp inner edges.
  const bands = { ...cut };
  const x0 = cut.left, x1 = width - 1 - cut.right, y0 = cut.top, y1 = height - 1 - cut.bottom;
  const innerW = x1 - x0 + 1, innerH = y1 - y0 + 1;
  for (const [cx, cy, dx, dy] of [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ] as const) {
    const colour = at(cx, cy);
    if (light(colour)) continue;
    const runX = (y: number) => {
      let n = 0;
      while (n < innerW && same(at(cx + dx * n, y), colour)) n += 1;
      return n;
    };
    const runY = (x: number) => {
      let n = 0;
      while (n < innerH && same(at(x, cy + dy * n), colour)) n += 1;
      return n;
    };
    const w = runX(cy), h = runY(cx);
    if (w < innerW * MIN_BLOCK || h < innerH * MIN_BLOCK || w >= innerW * 0.97 || h >= innerH * 0.97) continue;
    // Straight edges: (almost) every row of the block is as wide as the block, and every column as tall.
    const slack = Math.max(2, Math.round(innerW * 0.03));
    const slackY = Math.max(2, Math.round(innerH * 0.03));
    let rows = 0, cols = 0, sharp = 0, edges = 0;
    for (let k = 0; k < h; k += 1) {
      const y = cy + dy * k;
      const r = runX(y);
      if (Math.abs(r - w) <= slack) rows += 1;
      if (r < innerW) {
        edges += 1;
        if (diff(at(cx + dx * r, y), colour) >= 40) sharp += 1;
      }
    }
    for (let k = 0; k < w; k += 1) if (Math.abs(runY(cx + dx * k) - h) <= slackY) cols += 1;
    if (rows < h * 0.85 || cols < w * 0.85 || (edges > 0 && sharp < edges * 0.8)) continue;
    // Cut on the side that loses less of the photo, with a pixel more for the blended edge.
    const sideX = dx === 1 ? "left" : "right";
    const sideY = dy === 1 ? "top" : "bottom";
    if (h / innerH <= w / innerW) cut[sideY] = Math.max(cut[sideY], bands[sideY] + h + 1);
    else cut[sideX] = Math.max(cut[sideX], bands[sideX] + w + 1);
  }

  return finish(cut);
}

/*
  The photo with its framing cut off, by the browser: it is read small (at
  most 400px a side) to find the framing, then cut at full size in its own
  format, at most 1600px a side. Null when there is nothing to cut; throws
  when the photo can't be checked (the caller keeps it as it was and tries
  again on its next use).
*/
export interface TrimmedPhoto {
  bytes: Buffer;
  /** What was cut, in the photo's own pixels. */
  cut: FramingCut;
  /** The share of the width and height kept (0-1). */
  kept: { width: number; height: number };
}

export async function trimPhotoFraming(browser: Browser, bytes: Buffer, contentType: string): Promise<TrimmedPhoto | null> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    const probe = await page.evaluate(
      async ({ src }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const k = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { w: canvas.width, h: canvas.height, fullW: img.naturalWidth, fullH: img.naturalHeight, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
      },
      { src: `data:${contentType};base64,${bytes.toString("base64")}` },
    );
    const found = findFraming(probe.data, probe.w, probe.h);
    if (!found) return null;
    const sx = probe.fullW / probe.w, sy = probe.fullH / probe.h;
    const cut: FramingCut = { left: Math.ceil(found.left * sx), right: Math.ceil(found.right * sx), top: Math.ceil(found.top * sy), bottom: Math.ceil(found.bottom * sy) };
    const type = /png/i.test(contentType) ? "image/png" : /webp/i.test(contentType) ? "image/webp" : "image/jpeg";
    const out = await page.evaluate(
      async ({ src, cut, type }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const w = img.naturalWidth - cut.left - cut.right, h = img.naturalHeight - cut.top - cut.bottom;
        // At most 1600px a side (what the page uses anyway): a smaller canvas on a 4 GB server (review L4).
        const k = Math.min(1, 1600 / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * k));
        canvas.height = Math.max(1, Math.round(h * k));
        canvas.getContext("2d")!.drawImage(img, cut.left, cut.top, w, h, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL(type, 0.9);
      },
      { src: `data:${contentType};base64,${bytes.toString("base64")}`, cut, type },
    );
    const base64 = /^data:[^;]+;base64,(.*)$/.exec(out)?.[1];
    const kept = { width: (probe.fullW - cut.left - cut.right) / probe.fullW, height: (probe.fullH - cut.top - cut.bottom) / probe.fullH };
    if (!base64) throw new Error("The browser didn't hand back the cut photo.");
    return { bytes: Buffer.from(base64, "base64"), cut, kept };
  } finally {
    await context.close();
  }
}
