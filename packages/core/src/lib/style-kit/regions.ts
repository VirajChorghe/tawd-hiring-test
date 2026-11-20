import { colorDistance, rgbAt, type Box, type Pixels, type Rgb } from "./pixels";

/*
  Flat areas of colour, found by code (style kit, 28 September 2026).

  The picture is cut into small cells. A cell whose pixels are all nearly
  one colour is "flat"; touching flat cells of the same colour make a
  region. Large regions are the section bands and the panels (the sample client's beige
  and blue boxes), small ones are buttons, badges and ribbons. Cells that
  aren't flat make up the photos, the text and the icons.
*/

export const CELL = 4;

export interface Grid {
  cols: number;
  rows: number;
  /** The cell's colour when it is flat, else null. */
  flat: (Rgb | null)[];
}

export interface Region {
  box: Box;
  color: Rgb;
  /** How many cells the region has. */
  cells: number;
  /** The share of the cells just inside its box's edge that are the region's: 1 for a clean rectangle. */
  edgeFill: number;
  /** The share of its box's cells that are the region's. */
  fill: number;
}

const FLAT_TOLERANCE = 14;
const SAME_REGION = 12;

export function flatGrid(p: Pixels): Grid {
  const cols = Math.floor(p.width / CELL);
  const rows = Math.floor(p.height / CELL);
  const flat: (Rgb | null)[] = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let sr = 0, sg = 0, sb = 0;
      let lo: Rgb = [255, 255, 255];
      let hi: Rgb = [0, 0, 0];
      for (let y = r * CELL; y < r * CELL + CELL; y += 1) {
        for (let x = c * CELL; x < c * CELL + CELL; x += 1) {
          const px = rgbAt(p, x, y);
          sr += px[0];
          sg += px[1];
          sb += px[2];
          for (let k = 0; k < 3; k += 1) {
            if (px[k]! < lo[k]!) lo[k] = px[k]!;
            if (px[k]! > hi[k]!) hi[k] = px[k]!;
          }
        }
      }
      const spread = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const n = CELL * CELL;
      if (spread <= FLAT_TOLERANCE) flat[r * cols + c] = [sr / n, sg / n, sb / n];
    }
  }
  return { cols, rows, flat };
}

/* Touching flat cells of one colour, as regions of at least minCells cells. */
export function flatRegions(grid: Grid, minCells = 6): Region[] {
  const { cols, rows, flat } = grid;
  const owner = new Int32Array(cols * rows).fill(-1);
  const regions: Region[] = [];
  const members: number[][] = [];
  for (let start = 0; start < cols * rows; start += 1) {
    const seed = flat[start];
    if (!seed || owner[start] !== -1) continue;
    const id = members.length;
    const list: number[] = [];
    const queue = [start];
    owner[start] = id;
    let sr = 0, sg = 0, sb = 0;
    while (queue.length) {
      const i = queue.pop()!;
      list.push(i);
      const col = flat[i]!;
      sr += col[0];
      sg += col[1];
      sb += col[2];
      const c = i % cols;
      const r = (i - c) / cols;
      const next = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1];
      for (const j of next) {
        if (j < 0 || owner[j] !== -1) continue;
        const other = flat[j];
        if (other && colorDistance(other, seed) <= SAME_REGION) {
          owner[j] = id;
          queue.push(j);
        }
      }
    }
    members.push(list);
    if (list.length < minCells) {
      regions.push(null as unknown as Region);
      continue;
    }
    let c0 = cols, c1 = 0, r0 = rows, r1 = 0;
    for (const i of list) {
      const c = i % cols;
      const r = (i - c) / cols;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
    // The ring of cells one in from the box's edge (clear of rounded corners' outermost cells).
    let ring = 0, ringOwn = 0;
    const inset = c1 - c0 >= 4 && r1 - r0 >= 4 ? 1 : 0;
    const ra = r0 + inset, rb = r1 - inset, ca = c0 + inset, cb = c1 - inset;
    const cornerSkip = 3;
    for (let c = ca + cornerSkip; c <= cb - cornerSkip; c += 1) {
      for (const r of [ra, rb]) {
        ring += 1;
        if (owner[r * cols + c] === id) ringOwn += 1;
      }
    }
    for (let r = ra + cornerSkip; r <= rb - cornerSkip; r += 1) {
      for (const c of [ca, cb]) {
        ring += 1;
        if (owner[r * cols + c] === id) ringOwn += 1;
      }
    }
    const n = list.length;
    regions.push({
      box: { x: c0 * CELL, y: r0 * CELL, w: (c1 - c0 + 1) * CELL, h: (r1 - r0 + 1) * CELL },
      color: [sr / n, sg / n, sb / n],
      cells: n,
      edgeFill: ring ? ringOwn / ring : 1,
      fill: n / ((c1 - c0 + 1) * (r1 - r0 + 1)),
    });
  }
  return regions.filter(Boolean);
}

/*
  Busy areas: touching cells that aren't flat (photos, illustrations, text,
  icons), each as its box and how densely busy it is.
*/
export function busyAreas(grid: Grid, gap = 1): { box: Box; cells: number; density: number }[] {
  const { cols, rows, flat } = grid;
  const seen = new Uint8Array(cols * rows);
  const out: { box: Box; cells: number; density: number }[] = [];
  for (let start = 0; start < cols * rows; start += 1) {
    if (flat[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let c0 = cols, c1 = 0, r0 = rows, r1 = 0, n = 0;
    while (queue.length) {
      const i = queue.pop()!;
      n += 1;
      const c = i % cols;
      const r = (i - c) / cols;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      for (let dr = -gap; dr <= gap; dr += 1) {
        for (let dc = -gap; dc <= gap; dc += 1) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!flat[j] && !seen[j]) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
    }
    const box = { x: c0 * CELL, y: r0 * CELL, w: (c1 - c0 + 1) * CELL, h: (r1 - r0 + 1) * CELL };
    out.push({ box, cells: n, density: n / ((c1 - c0 + 1) * (r1 - r0 + 1)) });
  }
  return out;
}
