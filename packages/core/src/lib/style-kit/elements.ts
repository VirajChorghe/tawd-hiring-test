import { colorMask, cornerRadius, edgeRoughness, largestShape, loopsPath, outlinePoints, pathData, simplify, traceField, type Mask } from "./contour";
import { findOutlines, findSegments, chainSegments } from "./lines";
import {
  boxArea,
  colorDistance,
  contains,
  dominantColor,
  fromHex,
  intersects,
  lightness,
  overlapArea,
  rgbAt,
  toHex,
  type Box,
  type Pixels,
  type Rgb,
} from "./pixels";
import { busyAreas, CELL, flatGrid, flatRegions, type Grid, type Region } from "./regions";

/*
  The design's elements, section by section, found by code (Jason, 28
  September 2026: "from the design read, inventory every element per
  section"). The design read gives the texts and the pictures; the picture
  itself gives everything the read leaves out: the coloured panels, the
  bordered boxes, the buttons, the brush-stroke ribbons, the icons and the
  dividers. No AI.
*/

export interface ReadText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  weight: number;
  color: string | null;
  /** The read's guess at the kind of font: "cursive", "serif", or null for a plain sans. */
  font: string | null;
}

export interface DesignReadPage {
  background?: string | null;
  sections: { name: string; top: number; height: number; background?: string | null }[];
  texts: ReadText[];
  images?: { x: number; y: number; w: number; h: number; kind: string }[];
}

export type FontRole = "script" | "display" | "serif" | "sans";

export type KitElement =
  | { kind: "panel"; box: Box; fill: string; radius: number }
  | { kind: "card"; box: Box; fill: string; radius: number; border: string | null }
  | { kind: "box"; box: Box; border: string; borderWidth: number; radius: number; titleGap: { from: number; to: number } | null }
  | { kind: "button"; box: Box; fill: string | null; border: string | null; radius: number; text: string; textColor: string; icon: boolean }
  | { kind: "ribbon"; box: Box; fill: string; path: string; text: string; textColor: string }
  | { kind: "icon"; box: Box; color: string; background: string; mask: string; group: string | null; path: string }
  | { kind: "picture"; box: Box; role: string }
  | { kind: "divider"; box: Box; color: string; upright: boolean }
  | { kind: "text"; box: Box; text: string; role: FontRole; size: number; weight: number; color: string };

export interface SectionInventory {
  number: number;
  name: string;
  top: number;
  height: number;
  background: string;
  elements: (KitElement & { id: string })[];
}

export interface PageInventory {
  width: number;
  height: number;
  background: string;
  sections: SectionInventory[];
}

export function fontRole(t: Pick<ReadText, "font" | "size" | "weight">): FontRole {
  const hint = (t.font ?? "").toLowerCase();
  if (/cursive|script|hand|brush/.test(hint)) return "script";
  if (/serif/.test(hint) && !/sans/.test(hint)) return t.size >= 40 ? "display" : "serif";
  return "sans";
}

function textBox(t: ReadText): Box {
  return { x: t.x, y: t.y, w: t.w, h: t.h };
}

function center(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function within(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

/* Regions of one colour close together (a panel broken up by what's on it) are one. */
function mergeRegions(regions: Region[], grid: Grid, gap = 16): Region[] {
  const list = regions.map((r) => ({ ...r, box: { ...r.box } }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!, b = list[j]!;
        if (colorDistance(a.color, b.color) > 10 || !intersects(a.box, b.box, gap)) continue;
        // Pieces of one panel lie side by side; a region inside another's box (a white card on a white page) is its own.
        if (contains(a.box, b.box) || contains(b.box, a.box)) continue;
        // Two cards with a strip of another flat colour between them stay two.
        if (otherColorBetween(grid, a, b)) continue;
        const x0 = Math.min(a.box.x, b.box.x), y0 = Math.min(a.box.y, b.box.y);
        const x1 = Math.max(a.box.x + a.box.w, b.box.x + b.box.w), y1 = Math.max(a.box.y + a.box.h, b.box.y + b.box.h);
        const cells = a.cells + b.cells;
        const color: Rgb = [0, 1, 2].map((k) => (a.color[k]! * a.cells + b.color[k]! * b.cells) / cells) as Rgb;
        list[i] = { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, color, cells, edgeFill: 0, fill: 0 };
        list.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return list;
}

/* Whether the gap between two regions is mostly flat cells of another colour. */
function otherColorBetween(grid: Grid, a: Region, b: Region): boolean {
  const x0 = Math.max(a.box.x, b.box.x), x1 = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  const y0 = Math.max(a.box.y, b.box.y), y1 = Math.min(a.box.y + a.box.h, b.box.y + b.box.h);
  // Side by side: the gap is between the right edge of one and the left of the other, over the rows they share.
  const gapBox =
    x1 <= x0 && y1 > y0
      ? { x: x1, y: y0, w: x0 - x1, h: y1 - y0 }
      : y1 <= y0 && x1 > x0
        ? { x: x0, y: y1, w: x1 - x0, h: y0 - y1 }
        : null;
  if (!gapBox || gapBox.w < CELL || gapBox.h < CELL) return false;
  let n = 0, other = 0;
  for (let r = Math.floor(gapBox.y / CELL); r < Math.ceil((gapBox.y + gapBox.h) / CELL); r += 1) {
    for (let c = Math.floor(gapBox.x / CELL); c < Math.ceil((gapBox.x + gapBox.w) / CELL); c += 1) {
      const f = grid.flat[r * grid.cols + c];
      n += 1;
      if (f && colorDistance(f, a.color) > 8) other += 1;
    }
  }
  return n > 0 && other / n >= 0.5;
}

/* The share of the box's edge ring (one cell in, clear of the corners) that is flat and of the colour. */
function edgeCoverage(grid: Grid, box: Box, color: Rgb): number {
  const c0 = Math.floor(box.x / CELL) + 1, c1 = Math.floor((box.x + box.w) / CELL) - 2;
  const r0 = Math.floor(box.y / CELL) + 1, r1 = Math.floor((box.y + box.h) / CELL) - 2;
  if (c1 - c0 < 4 || r1 - r0 < 4) return 0;
  let n = 0, own = 0;
  const check = (c: number, r: number) => {
    n += 1;
    const f = grid.flat[r * grid.cols + c];
    if (f && colorDistance(f, color) <= 14) own += 1;
  };
  for (let c = c0 + 3; c <= c1 - 3; c += 1) {
    check(c, r0);
    check(c, r1);
  }
  for (let r = r0 + 3; r <= r1 - 3; r += 1) {
    check(c0, r);
    check(c1, r);
  }
  return n ? own / n : 0;
}

/* A mask as a compact string ("w,h,hex bits") so it can be stored with the kit and matched to an icon later. */
export function packMask(mask: Mask): string {
  let bits = "";
  for (let i = 0; i < mask.on.length; i += 4) {
    const v = (mask.on[i]! << 3) | ((mask.on[i + 1] ?? 0) << 2) | ((mask.on[i + 2] ?? 0) << 1) | (mask.on[i + 3] ?? 0);
    bits += v.toString(16);
  }
  return `${mask.w},${mask.h},${bits}`;
}

export function unpackMask(packed: string): Mask {
  const [w, h, bits] = packed.split(",");
  const on = new Uint8Array(Number(w) * Number(h));
  for (let i = 0; i < (bits ?? "").length; i += 1) {
    const v = parseInt(bits![i]!, 16);
    for (let k = 0; k < 4; k += 1) if (i * 4 + k < on.length) on[i * 4 + k] = (v >> (3 - k)) & 1;
  }
  return { w: Number(w), h: Number(h), on };
}

/* The ink of a small area: the pixels that stand out from its background. */
function inkMask(p: Pixels, box: Box, background: Rgb, threshold = 60): { mask: Mask; color: Rgb } {
  const on = new Uint8Array(box.w * box.h);
  const inks: { px: Rgb; d: number }[] = [];
  for (let y = 0; y < box.h; y += 1) {
    for (let x = 0; x < box.w; x += 1) {
      const px = rgbAt(p, Math.min(p.width - 1, box.x + x), Math.min(p.height - 1, box.y + y));
      const d = colorDistance(px, background);
      if (d > threshold) {
        on[y * box.w + x] = 1;
        inks.push({ px, d });
      }
    }
  }
  // The icon's colour is its strongest ink: thin strokes are mostly edge pixels blended with the background.
  inks.sort((a, b) => b.d - a.d);
  const top = inks.slice(0, Math.max(1, Math.ceil(inks.length * 0.3)));
  const color: Rgb = top.length ? [0, 1, 2].map((k) => top.reduce((sum, i) => sum + i.px[k]!, 0) / top.length) as Rgb : background;
  return { mask: { w: box.w, h: box.h, on }, color };
}

/* The ink's own box inside the mask, as a mask of just that. */
function trimMask(mask: Mask): { mask: Mask; dx: number; dy: number } {
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
  if (x1 < 0) return { mask: { w: 0, h: 0, on: new Uint8Array(0) }, dx: 0, dy: 0 };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) on[y * w + x] = mask.on[(y + y0) * mask.w + x + x0]!;
  return { mask: { w, h, on }, dx: x0, dy: y0 };
}

/* `prefix` keeps ids unique across a design's pages (p2-s4-icon-1). */
export function inventoryPage(p: Pixels, read: DesignReadPage, prefix = ""): PageInventory {
  const grid = flatGrid(p);
  const pageBg = dominantColor(p, { x: 0, y: 0, w: p.width, h: p.height }, 4).color;
  const regions = mergeRegions(flatRegions(grid, 6).filter((r) => r.cells >= 6), grid);
  const texts = read.texts.filter((t) => t.w > 0 && t.h > 0);
  const pictures = (read.images ?? []).filter((i) => i.w > 0 && i.h > 0);
  const found: KitElement[] = [];

  // Bands: flat colour across the page's width, the sections' backgrounds.
  const bands = regions.filter((r) => r.box.w >= p.width * 0.9 && r.box.h >= 24);
  const backgroundAt = (b: Box): Rgb => {
    const c = center(b);
    const band = bands.filter((r) => within(r.box, c.x, c.y)).sort((a, z) => boxArea(a.box) - boxArea(z.box))[0];
    return band?.color ?? pageBg;
  };

  // Panels and cards: large flat areas whose colour differs from what's behind them.
  const panels: { box: Box; color: Rgb }[] = [];
  for (const r of regions) {
    if (r.box.w >= p.width * 0.9 || r.box.w < 110 || r.box.h < 90) continue;
    const edge = edgeCoverage(grid, r.box, r.color);
    if (edge < 0.5) continue;
    panels.push({ box: growBox(p, r.box, r.color), color: r.color });
  }
  panels.sort((a, b) => boxArea(b.box) - boxArea(a.box));
  const panelAt = (b: Box, skip?: Box): { box: Box; color: Rgb } | null =>
    panels.filter((q) => q.box !== skip && contains(q.box, b, 2) && boxArea(q.box) > boxArea(b)).sort((a, z) => boxArea(a.box) - boxArea(z.box))[0] ?? null;
  const behind = (b: Box, skip?: Box): Rgb => panelAt(b, skip)?.color ?? backgroundAt(b);
  const outlines = findOutlines(p);
  for (const q of panels) {
    const back = behind(q.box, q.box);
    if (colorDistance(q.color, back) <= 5) continue;
    const mask = colorMask(p, { x: q.box.x, y: q.box.y, w: Math.min(q.box.w, 80), h: Math.min(q.box.h, 80) }, q.color, 14);
    const radius = Math.min(40, cornerRadius(mask));
    const inside = panelAt(q.box, q.box);
    if (inside) {
      const outline = outlines.find((o) => Math.abs(o.box.x - q.box.x) <= 8 && Math.abs(o.box.y - q.box.y) <= 8);
      found.push({ kind: "card", box: q.box, fill: toHex(q.color), radius, border: outline ? toHex(outline.color) : null });
    } else {
      found.push({ kind: "panel", box: q.box, fill: toHex(q.color), radius });
    }
  }

  // Ribbons: a light script word (a name) on a dark shape with ragged, brush-stroke edges.
  const claimedTexts = new Set<ReadText>();
  for (const t of texts) {
    if (fontRole(t) !== "script" || !t.color || lightness(fromHex(t.color)) < 170) continue;
    // Words painted in an illustration (the sample client's signpost) stay part of the picture.
    if (pictures.some((pic) => !/icon/i.test(pic.kind) && contains({ x: pic.x, y: pic.y, w: pic.w, h: pic.h }, textBox(t), 4))) continue;
    const back = behind(textBox(t));
    const ring = dominantColor(p, { x: t.x - 6, y: t.y - 4, w: t.w + 12, h: t.h + 8 }, 1);
    const ringColor = ring.color;
    if (colorDistance(ringColor, back) < 60 || colorDistance(ringColor, fromHex(t.color)) < 80) continue;
    const area = clampBox(p, { x: Math.round(t.x - t.h * 2.5), y: Math.round(t.y - t.h * 0.6), w: Math.round(t.w + t.h * 5), h: Math.round(t.h * 2.2) });
    const shape = trimMask(largestShape(colorMask(p, area, ringColor, 60)));
    if (shape.mask.w < t.w) continue;
    const box = { x: area.x + shape.dx, y: area.y + shape.dy, w: shape.mask.w, h: shape.mask.h };
    const rough = edgeRoughness(shape.mask);
    if (rough <= 1.2) continue;
    const points = simplify(outlinePoints(shape.mask), 1.0);
    found.push({ kind: "ribbon", box, fill: toHex(ringColor), path: pathData(points), text: t.text, textColor: t.color });
    claimedTexts.add(t);
  }
  const ribbonBoxes = () => found.filter((e) => e.kind === "ribbon").map((e) => e.box);

  // Buttons: small flat areas with a text on them in a contrasting colour.
  for (const r of regions) {
    if (r.box.w < 40 || r.box.w > 600 || r.box.h < 16 || r.box.h > 120) continue;
    const on = texts.filter((t) => {
      const c = center(textBox(t));
      return within(r.box, c.x, c.y) && t.color && colorDistance(fromHex(t.color), r.color) > 80;
    });
    if (on.length === 0 || on.some((t) => claimedTexts.has(t))) continue;
    // Words painted in an illustration (the sample client's signpost) are part of the picture, not buttons.
    if (pictures.some((pic) => /illustration|logo/i.test(pic.kind) && contains({ x: pic.x, y: pic.y, w: pic.w, h: pic.h }, r.box, 6))) continue;
    if (ribbonBoxes().some((b) => overlapArea(b, r.box) > boxArea(r.box) * 0.3)) continue;
    const back = behind(r.box);
    if (colorDistance(back, r.color) <= 20) continue;
    const pad = 3;
    const area = { x: Math.max(0, r.box.x - pad), y: Math.max(0, r.box.y - pad), w: Math.min(p.width - r.box.x, r.box.w + pad * 2), h: Math.min(p.height - r.box.y, r.box.h + pad * 2) };
    const mask = largestShape(colorMask(p, area, r.color, 60));
    const text = on.map((t) => t.text).join(" ");
    const script = on.some((t) => fontRole(t) === "script");
    const rough = edgeRoughness(mask);
    if (script && rough > 1.2) {
      const points = simplify(outlinePoints(mask), 1.0);
      found.push({ kind: "ribbon", box: area, fill: toHex(r.color), path: pathData(points), text, textColor: on[0]!.color ?? "#ffffff" });
    } else {
      // An icon beside the words: ink on the button that isn't a text.
      const icon = busyAreas(flatGrid({ width: area.w, height: area.h, data: cropData(p, area) })).some(
        (b) => b.box.w >= 8 && b.box.h >= 8 && !on.some((t) => intersects(textBox(t), { x: b.box.x + area.x, y: b.box.y + area.y, w: b.box.w, h: b.box.h })),
      );
      found.push({ kind: "button", box: r.box, fill: toHex(r.color), border: null, radius: Math.min(r.box.h / 2, cornerRadius(mask)), text, textColor: on[0]!.color ?? "#ffffff", icon });
    }
    on.forEach((t) => claimedTexts.add(t));
  }

  // Bordered boxes and outlined buttons.
  for (const o of outlines) {
    const on = texts.filter((t) => {
      const c = center(textBox(t));
      return within(o.box, c.x, c.y);
    });
    if (o.box.h <= 80 && on.length > 0 && on.length <= 2) {
      found.push({ kind: "button", box: o.box, fill: null, border: toHex(o.color), radius: o.radius, text: on.map((t) => t.text).join(" "), textColor: on[0]!.color ?? toHex(o.color), icon: false });
      on.forEach((t) => claimedTexts.add(t));
    } else if (!found.some((e) => (e.kind === "card" || e.kind === "panel") && Math.abs(e.box.x - o.box.x) <= 8 && Math.abs(e.box.y - o.box.y) <= 8)) {
      found.push({ kind: "box", box: o.box, border: toHex(o.color), borderWidth: Math.max(1, Math.min(3, o.thickness)), radius: o.radius, titleGap: o.titleGap });
    }
  }

  // Dividers: long single lines that aren't part of a box.
  const edges = found.filter((e) => e.kind === "box" || e.kind === "card" || e.kind === "panel" || e.kind === "button").map((e) => e.box);
  for (const upright of [false, true]) {
    for (const c of chainSegments(findSegments(p, !upright, upright ? 60 : 120), 24)) {
      const box = upright ? { x: c.at, y: c.from, w: c.thickness, h: c.to - c.from } : { x: c.from, y: c.at, w: c.to - c.from, h: c.thickness };
      if (edges.some((e) => Math.abs((upright ? e.x : e.y) - c.at) <= 6 || Math.abs((upright ? e.x + e.w : e.y + e.h) - c.at) <= 6)) continue;
      if (pictures.some((pic) => overlapArea(pic, box) > 0)) continue;
      if (texts.some((t) => overlapArea(textBox(t), box) > 0)) continue;
      found.push({ kind: "divider", box, color: toHex(c.color), upright });
    }
  }

  // Pictures, as the read saw them: photos, logos, illustrations. The read's "icon" pictures are split below.
  for (const pic of pictures) {
    if (/icon/i.test(pic.kind)) continue;
    found.push({ kind: "picture", box: { x: pic.x, y: pic.y, w: pic.w, h: pic.h }, role: pic.kind });
  }

  // A play button over a photo (a video thumbnail): a small solid triangle at its centre, ringed by light.
  for (const pic of pictures) {
    if (!/photo|video|thumb/i.test(pic.kind) || pic.w < 60 || pic.h < 60) continue;
    const cx = Math.round(pic.x + pic.w / 2), cy = Math.round(pic.y + pic.h / 2);
    const span = Math.round(Math.min(pic.w, pic.h) * 0.3);
    const area = clampBox(p, { x: cx - span, y: cy - span, w: span * 2, h: span * 2 });
    const seed = rgbAt(p, cx, cy);
    if (lightness(seed) > 200) continue;
    const mask = largestShape(colorMask(p, area, seed, 30));
    const shape = trimMask(mask);
    const { w, h } = shape.mask;
    if (w < 6 || h < 6 || w > span || h > span || h / w < 0.7 || h / w > 1.8) continue;
    const box = { x: area.x + shape.dx, y: area.y + shape.dy, w, h };
    // The light ring around it.
    const r = Math.max(w, h) * 1.1;
    let light = 0, n = 0;
    for (let a = 0; a < 24; a += 1) {
      const x = Math.round(box.x + w / 2 + Math.cos((a / 24) * Math.PI * 2) * r);
      const y = Math.round(box.y + h / 2 + Math.sin((a / 24) * Math.PI * 2) * r);
      if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
      n += 1;
      if (lightness(rgbAt(p, x, y)) > 215) light += 1;
    }
    if (!n || light / n < 0.7) continue;
    const ring = Math.round(r * 1.3);
    found.push({ kind: "icon", box: { x: Math.round(box.x + w / 2 - ring), y: Math.round(box.y + h / 2 - ring), w: ring * 2, h: ring * 2 }, color: toHex(seed), background: "#ffffff", mask: packMask(shape.mask), group: "play over a photo", path: "" });
  }

  // Icons on buttons and ribbons, found pixel by pixel (at cell size they run into the words beside them).
  const onHolders: Box[] = [];
  for (const holder of found.filter((e): e is Extract<KitElement, { kind: "button" | "ribbon" }> => e.kind === "ribbon" || (e.kind === "button" && e.fill !== null))) {
    const fill = fromHex(holder.kind === "ribbon" ? holder.fill : holder.fill!);
    const area = clampBox(p, holder.box);
    const { mask } = inkMask(p, area, fill, 90);
    const words = texts.filter((t) => intersects(textBox(t), area)).map((t) => ({ x: t.x - area.x - 3, y: t.y - area.y - 3, w: t.w + 6, h: t.h + 6 }));
    for (const part of pixelParts(mask, 2)) {
      const b = part;
      if (b.w < 14 || b.h < 14 || b.w > area.h || b.h > area.h) continue;
      if (words.some((wb) => overlapArea(wb, b) > boxArea(b) * 0.2)) continue;
      // Ink touching the holder's edge is its ragged outline, not an icon.
      if (b.x <= 1 || b.y <= 1 || b.x + b.w >= area.w - 1 || b.y + b.h >= area.h - 1) continue;
      const box = { x: area.x + b.x, y: area.y + b.y, w: b.w, h: b.h };
      const ink = inkMask(p, box, fill, 90);
      found.push({ kind: "icon", box, color: toHex(ink.color), background: toHex(fill), mask: packMask(trimMask(ink.mask).mask), group: null, path: tracedIcon(p, box, fill, ink.color) });
      onHolders.push(box);
    }
  }

  // Icons: small busy spots that aren't text or part of a picture.
  const photoBoxes = pictures.filter((pic) => !/icon/i.test(pic.kind));
  const iconGroups = pictures.filter((pic) => /icon/i.test(pic.kind));
  for (const spot of busyAreas(grid, 1)) {
    const b = spot.box;
    if (b.w < 8 || b.h < 8 || b.w > 96 || b.h > 96) continue;
    if (b.w / b.h > 2.6 || b.h / b.w > 2.6) continue;
    if (photoBoxes.some((pic) => overlapArea(pic, b) > boxArea(b) * 0.3)) continue;
    if (texts.some((t) => overlapArea({ x: t.x - 2, y: t.y - 2, w: t.w + 4, h: t.h + 4 }, b) > boxArea(b) * 0.25)) continue;
    if (onHolders.some((h) => overlapArea(h, b) > 0)) continue;
    // An icon on a button or a ribbon (the paw beside a dog's name) stands out from that, not the page.
    const c = center(b);
    const holder = found.find((e): e is Extract<KitElement, { kind: "button" | "ribbon" }> => (e.kind === "ribbon" || (e.kind === "button" && e.fill !== null)) && within(e.box, c.x, c.y));
    if (holder && holder.kind === "ribbon" && (b.w > holder.box.h || b.h > holder.box.h)) continue;
    const back = holder ? fromHex(holder.kind === "ribbon" ? holder.fill : holder.fill!) : behind(b);
    const { mask, color } = inkMask(p, b, back);
    const trimmed = trimMask(mask);
    if (trimmed.mask.w < 6 || trimmed.mask.h < 6) continue;
    const ink = trimmed.mask.on.reduce((a, v) => a + v, 0) / (trimmed.mask.w * trimmed.mask.h);
    if (ink < 0.12) continue;
    const box = { x: b.x + trimmed.dx, y: b.y + trimmed.dy, w: trimmed.mask.w, h: trimmed.mask.h };
    const group = iconGroups.find((g) => contains({ x: g.x, y: g.y, w: g.w, h: g.h }, box, 6));
    found.push({ kind: "icon", box, color: toHex(color), background: toHex(back), mask: packMask(trimmed.mask), group: group ? group.kind : null, path: tracedIcon(p, box, back, color) });
  }

  // Texts, with the role of their font (words painted in an illustration are part of the picture).
  for (const t of texts) {
    if (pictures.some((pic) => /illustration|logo/i.test(pic.kind) && contains({ x: pic.x, y: pic.y, w: pic.w, h: pic.h }, textBox(t), 4))) continue;
    found.push({ kind: "text", box: textBox(t), text: t.text, role: fontRole(t), size: t.size, weight: t.weight, color: t.color ?? "#000000" });
  }

  // Section by section.
  const sections: SectionInventory[] = read.sections.map((s, i) => ({
    number: i + 1,
    name: s.name,
    top: s.top,
    height: s.height,
    background: toHex(backgroundAt({ x: 0, y: s.top, w: p.width, h: s.height })),
    elements: [],
  }));
  const counters = new Map<string, number>();
  for (const e of found) {
    const cy = e.box.y + e.box.h / 2;
    const section = sections.find((s) => cy >= s.top && cy < s.top + s.height) ?? sections[sections.length - 1];
    if (!section) continue;
    const key = `${section.number}:${e.kind}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    section.elements.push({ ...e, id: `${prefix}s${section.number}-${e.kind}-${n}` });
  }
  return { width: p.width, height: p.height, background: toHex(pageBg), sections };
}

/* The icon's own shape as a smooth SVG path in its box (for an icon the kit's set has no match for). */
export function tracedIcon(p: Pixels, box: Box, background: Rgb, ink: Rgb): string {
  const pad = 1;
  const w = box.w + pad * 2, h = box.h + pad * 2;
  const field = new Float32Array(w * h);
  const full = Math.max(1, colorDistance(ink, background) - 20);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = box.x - pad + x, py = box.y - pad + y;
      if (px < 0 || py < 0 || px >= p.width || py >= p.height) continue;
      field[y * w + x] = Math.max(0, Math.min(1, (colorDistance(rgbAt(p, px, py), background) - 20) / full));
    }
  }
  const loops = traceField(field, w, h, 0.5).map((l) => l.map(([x, y]) => [x - pad, y - pad] as [number, number]));
  return loopsPath(loops);
}

/* Groups of ink pixels within `gap` pixels of each other, as boxes in the mask. */
function pixelParts(mask: Mask, gap: number): Box[] {
  const { w, h, on } = mask;
  const seen = new Uint8Array(w * h);
  const out: Box[] = [];
  for (let s = 0; s < w * h; s += 1) {
    if (!on[s] || seen[s]) continue;
    seen[s] = 1;
    const queue = [s];
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -gap; dy <= gap; dy += 1) {
        for (let dx = -gap; dx <= gap; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (on[j] && !seen[j]) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

function clampBox(p: Pixels, b: Box): Box {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.max(1, Math.min(p.width, b.x + b.w) - x), h: Math.max(1, Math.min(p.height, b.y + b.h) - y) };
}

/* Pushes each edge of a panel outward while the row or column just outside is still mostly the panel's colour. */
function growBox(p: Pixels, box: Box, color: Rgb): Box {
  let { x, y, w, h } = box;
  const share = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0, own = 0;
    for (let yy = y0; yy <= y1; yy += 1) for (let xx = x0; xx <= x1; xx += 1) {
      if (xx < 0 || yy < 0 || xx >= p.width || yy >= p.height) return 0;
      n += 1;
      if (colorDistance(rgbAt(p, xx, yy), color) <= 8) own += 1;
    }
    return n ? own / n : 0;
  };
  for (let i = 0; i < 400 && share(x - 1, y, x - 1, y + h - 1) >= 0.45; i += 1) { x -= 1; w += 1; }
  for (let i = 0; i < 400 && share(x + w, y, x + w, y + h - 1) >= 0.45; i += 1) w += 1;
  for (let i = 0; i < 400 && share(x, y - 1, x + w - 1, y - 1) >= 0.45; i += 1) { y -= 1; h += 1; }
  for (let i = 0; i < 400 && share(x, y + h, x + w - 1, y + h) >= 0.45; i += 1) h += 1;
  return { x, y, w, h };
}

function cropData(p: Pixels, box: Box): Uint8ClampedArray {
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  for (let y = 0; y < box.h; y += 1) {
    const from = ((box.y + y) * p.width + box.x) * 4;
    out.set(p.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return out;
}
