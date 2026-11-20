import type { Grid } from "./regions";

/*
  Pages that share a layout (Jason, 28 September 2026: "detect pages that
  share a layout (the sample client's 5 dog pages); build each layout once and fill the
  others"). Found by code from the page pictures: each page is cut into
  large blocks, each block either busy (photos, text) or a flat shade;
  two pages whose blocks agree enough share a layout. On the sample client's design the
  Rex, Sky and Pip pages agree 64-75% and every other pair 55% or
  less, so 60% is the line.
*/

export interface LayoutSignature {
  cols: number;
  rows: number;
  /** Per block: -1 busy, else its lightness in steps of 32. */
  blocks: number[];
  width: number;
}

/* Blocks of `size` cells (80px at 4px cells). */
export function layoutSignature(grid: Grid, size = 20): LayoutSignature {
  const cols = Math.floor(grid.cols / size);
  const rows = Math.floor(grid.rows / size);
  const blocks: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let flat = 0, light = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const f = grid.flat[(r * size + y) * grid.cols + c * size + x];
          if (f) {
            flat += 1;
            light += 0.299 * f[0] + 0.587 * f[1] + 0.114 * f[2];
          }
        }
      }
      blocks.push(flat < size * size * 0.6 ? -1 : Math.round(light / flat / 32));
    }
  }
  return { cols, rows, blocks, width: grid.cols };
}

/* The share of blocks two pages agree on, over the height they share (0 when drawn at different widths). */
export function layoutSimilarity(a: LayoutSignature, b: LayoutSignature): number {
  if (a.cols !== b.cols || a.width !== b.width) return 0;
  const rows = Math.min(a.rows, b.rows);
  if (rows === 0) return 0;
  // A page much shorter than the other doesn't share its layout.
  if (Math.min(a.rows, b.rows) / Math.max(a.rows, b.rows) < 0.75) return 0;
  let same = 0;
  for (let i = 0; i < rows * a.cols; i += 1) if (a.blocks[i] === b.blocks[i]) same += 1;
  return same / (rows * a.cols);
}

export interface SharedLayout {
  /** The pages (by the key given), the first being the one to build. */
  pages: string[];
  /** The lowest agreement between the first page and the others, 0-100. */
  agreement: number;
}

/* Groups of two or more pages that share a layout (each page agreeing with the group's first at `threshold` or more). */
export function sharedLayouts(pages: { key: string; signature: LayoutSignature }[], threshold = 0.6): SharedLayout[] {
  const used = new Set<string>();
  const groups: SharedLayout[] = [];
  for (const first of pages) {
    if (used.has(first.key)) continue;
    const members = pages.filter((p) => p.key !== first.key && !used.has(p.key)).map((p) => ({ key: p.key, score: layoutSimilarity(first.signature, p.signature) }));
    const same = members.filter((m) => m.score >= threshold);
    if (same.length === 0) continue;
    used.add(first.key);
    for (const m of same) used.add(m.key);
    groups.push({ pages: [first.key, ...same.map((m) => m.key)], agreement: Math.round(Math.min(...same.map((m) => m.score)) * 100) });
  }
  return groups;
}
