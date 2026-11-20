import { colorDistance, rgbAt, type Box, type Pixels, type Rgb } from "./pixels";

/*
  Thin lines, found by code (style kit, 28 September 2026): the borders of
  boxes like the sample client's "Meet the Pack", dividers, and the outline of outlined
  buttons. A line pixel differs from the pixels a few rows above and below
  it (or left and right, for an upright line), which match each other.
*/

export interface Segment {
  /** Horizontal: y is the row, x0..x1 the extent. Vertical: x is the column, y0..y1. */
  at: number;
  from: number;
  to: number;
  thickness: number;
  color: Rgb;
}

export interface Outline {
  box: Box;
  color: Rgb;
  thickness: number;
  /** About how round the corners are, in pixels. */
  radius: number;
  /** A gap in the top edge (a title set into the border), if there is one. */
  titleGap: { from: number; to: number } | null;
}

const EDGE = 8;
const SIDES_MATCH = 8;

function linePixel(p: Pixels, x: number, y: number, horizontal: boolean, reach: number): Rgb | null {
  const c = rgbAt(p, x, y);
  const a = horizontal ? rgbAt(p, x, y - reach) : rgbAt(p, x - reach, y);
  const b = horizontal ? rgbAt(p, x, y + reach) : rgbAt(p, x + reach, y);
  if (colorDistance(a, b) > SIDES_MATCH) return null;
  if (colorDistance(c, a) < EDGE || colorDistance(c, b) < EDGE) return null;
  return c;
}

/* Runs of line pixels at least minLength long, merged across neighbouring rows (or columns). */
export function findSegments(p: Pixels, horizontal: boolean, minLength = 60): Segment[] {
  const outer = horizontal ? p.height : p.width;
  const inner = horizontal ? p.width : p.height;
  const raw: Segment[] = [];
  for (let a = 3; a < outer - 3; a += 1) {
    let start = -1;
    let color: Rgb | null = null;
    let misses = 0;
    for (let b = 0; b <= inner; b += 1) {
      const px = b < inner ? (horizontal ? linePixel(p, b, a, true, 3) : linePixel(p, a, b, false, 3)) : null;
      const same = px && color && colorDistance(px, color) <= 40;
      if (px && start < 0) {
        start = b;
        color = px;
        misses = 0;
      } else if (start >= 0 && (same || (px && !color))) {
        misses = 0;
      } else if (start >= 0) {
        // A pixel or two of anti-aliasing doesn't end a line.
        misses += 1;
        if (misses > 2 || b === inner) {
          const end = b - misses;
          if (end - start + 1 >= minLength) raw.push({ at: a, from: start, to: end, thickness: 1, color: color! });
          start = -1;
          color = null;
        }
      }
    }
  }
  // One line drawn 2 or 3 pixels thick shows up in neighbouring rows: keep one.
  raw.sort((s, t) => s.at - t.at || s.from - t.from);
  const merged: Segment[] = [];
  for (const s of raw) {
    const prev = merged.find((m) => s.at - (m.at + m.thickness - 1) <= 1 && s.at >= m.at && Math.abs(m.from - s.from) <= 4 && Math.abs(m.to - s.to) <= 4);
    if (prev) prev.thickness = s.at - prev.at + 1;
    else merged.push({ ...s });
  }
  return merged;
}

/* A line made of pieces: the pieces on one row (or column) joined across short breaks. */
export interface Chain {
  at: number;
  from: number;
  to: number;
  thickness: number;
  color: Rgb;
  /** Breaks longer than a few letters: where something sits across the line. */
  gaps: { from: number; to: number }[];
  /** How much of from..to is drawn. */
  drawn: number;
}

/* Joins pieces on the same row (within 2px) and of the same colour; breaks up to maxGap long are kept as gaps. */
export function chainSegments(segments: Segment[], maxGap: number): Chain[] {
  const groups: Segment[][] = [];
  for (const s of [...segments].sort((a, b) => a.at - b.at)) {
    const g = groups.find((list) => Math.abs(list[0]!.at - s.at) <= 2 && colorDistance(list[0]!.color, s.color) <= 24);
    if (g) g.push(s);
    else groups.push([s]);
  }
  const chains: Chain[] = [];
  for (const list of groups) {
    // Overlapping pieces from neighbouring rows are one piece.
    const pieces = [...list].sort((a, b) => a.from - b.from);
    let current: Chain | null = null;
    for (const s of pieces) {
      if (current && s.from <= current.to + maxGap) {
        if (s.from > current.to + 12) current.gaps.push({ from: current.to, to: s.from });
        current.drawn += Math.max(0, s.to - Math.max(s.from, current.to));
        current.to = Math.max(current.to, s.to);
        current.thickness = Math.max(current.thickness, s.thickness, Math.abs(s.at - current.at) + 1);
      } else {
        if (current) chains.push(current);
        current = { at: s.at, from: s.from, to: s.to, thickness: s.thickness, color: s.color, gaps: [], drawn: s.to - s.from };
      }
    }
    if (current) chains.push(current);
  }
  return chains;
}

/*
  Boxes drawn with an outline: a top and a bottom line of about the same
  extent (the top may be broken by a title, the bottom by a button set
  across it), joined by upright lines at both ends.
*/
export function findOutlines(p: Pixels): Outline[] {
  const across = chainSegments(findSegments(p, true, 16), 700).filter((c) => c.to - c.from >= 60 && c.drawn >= (c.to - c.from) * 0.4);
  const upright = chainSegments(findSegments(p, false, 12), 60).filter((c) => c.to - c.from >= 20);
  const out: Outline[] = [];
  for (const top of across) {
    for (const bottom of across) {
      if (bottom.at - top.at < 24) continue;
      if (Math.abs(bottom.from - top.from) > 14 || Math.abs(bottom.to - top.to) > 14) continue;
      if (colorDistance(bottom.color, top.color) > 60) continue;
      const height = bottom.at - top.at;
      const side = (x: number) =>
        upright.find((v) => Math.abs(v.at - x) <= 14 && v.from >= top.at - 6 && v.to <= bottom.at + 6 && v.to - v.from >= height * 0.4 && colorDistance(v.color, top.color) <= 60);
      const left = side(Math.min(top.from, bottom.from));
      const right = side(Math.max(top.to, bottom.to));
      if (!left || !right) continue;
      const x = Math.min(left.at, top.from);
      const w = Math.max(right.at + right.thickness, top.to) - x + 1;
      const radius = Math.max(0, Math.round(Math.max(left.from - top.at, top.from - left.at)));
      const titleGap = top.gaps.length ? top.gaps.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a)) : null;
      out.push({ box: { x, y: top.at, w, h: height + bottom.thickness }, color: top.color, thickness: Math.max(top.thickness, 1), radius: Math.min(radius, 40), titleGap: titleGap && titleGap.to - titleGap.from > 40 ? titleGap : null });
      break;
    }
  }
  // The same box found from two tops a row apart: keep the first.
  return out.filter((o, i) => !out.some((q, j) => j < i && Math.abs(q.box.y - o.box.y) <= 3 && Math.abs(q.box.x - o.box.x) <= 6 && Math.abs(q.box.w - o.box.w) <= 12));
}
