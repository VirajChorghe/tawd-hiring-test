/*
  A person's corrections to the new design read's band list (E4b-2, Lane 2,
  14 November 2026). Plain code, no storage: given the bands a read found and
  the corrections made for that upload, it says what the band list is now.

  Jason, 14 November: a re-read keeps people's corrections where the band is
  still there; only admins correct, while the new route is built.

  - Corrections apply oldest first. Each finds the band of THIS read whose
    span overlaps its anchor most (the band's edges on the read it was made
    on), counted as the shared part over the two spans together, and needing
    at least MIN_MATCH of it. On the read a correction was made on, its anchor
    is that band's own span, so it always matches. A band can take several
    corrections; a later one wins for the parts it changes.
  - Matching is against the bands as read, never as already corrected, so a
    band moved by a correction is still found by the next one made on it.
  - A correction no band matches any more, or that two bands match equally
    (a band read as two halves), is returned in `unmatched` with why, never
    dropped silently and never given to one of them by chance.
  - A name and a kind carry over to a re-read. Edges are exact pixels, so
    they carry over only to the read they were made on, or to a band read in
    nearly the same place (EDGE_MATCH); otherwise they are not applied and
    `problems` says so (Fable's review: a merged band must not be shrunk, or
    its neighbour stretched, by edges set on another read).
  - New edges move the neighbour's edge with them, so the bands still run
    from the top of the page to the bottom with no gap or overlap. An edge
    change that would leave a band (or its neighbour) under MIN_HEIGHT px,
    move the page's own top or bottom, or leave the page, is not applied and
    is said in `problems`; the rest of that correction still applies.
*/

export type CorrectableRole = "header" | "band" | "footer";

export interface CorrectableBand {
  name: string;
  role: CorrectableRole;
  top: number;
  bottom: number;
}

export interface BandChange {
  name?: string;
  role?: CorrectableRole;
  top?: number;
  bottom?: number;
}

export interface BandCorrection {
  id: string;
  anchor: { top: number; bottom: number };
  change: BandChange;
  madeOnRun: string;
  by: string | null;
  at: string;
}

export interface CorrectedMark {
  /** Who made the latest correction applied to this band, and when. */
  by: string | null;
  at: string;
  /** Every correction applied to it, oldest first. */
  ids: string[];
}

export type CorrectedBand<B extends CorrectableBand> = B & {
  /** The band as read, before any correction: what a new correction is anchored to. */
  asRead: { top: number; bottom: number };
  corrected: CorrectedMark | null;
};

/** A correction that could not be applied in full: which one, the sentence for a person, and the reason on its own. */
export interface CorrectionProblem {
  id: string;
  text: string;
  reason: string;
}

export const MIN_MATCH = 0.5;
/** How closely a band of a re-read must sit on a correction's anchor for its edges to carry over. */
export const EDGE_MATCH = 0.9;
export const MIN_HEIGHT = 8;
export const ROLES: CorrectableRole[] = ["header", "band", "footer"];
export const MAX_NAME = 80;

/** Overlap over the two spans together (0 to 1). */
export function spanMatch(a: { top: number; bottom: number }, b: { top: number; bottom: number }): number {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const together = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  return overlap > 0 && together > 0 ? overlap / together : 0;
}

/** The band that best matches an anchor: its index (-1 for none) and score; `tied` when two bands match it equally. */
export function matchBand(bands: { top: number; bottom: number }[], anchor: { top: number; bottom: number }): { index: number; score: number; tied: boolean } {
  let index = -1;
  let score = 0;
  let tied = false;
  bands.forEach((band, i) => {
    const s = spanMatch(band, anchor);
    if (s < MIN_MATCH) return;
    if (s > score) {
      index = i;
      score = s;
      tied = false;
    } else if (s === score) {
      tied = true;
    }
  });
  return { index, score, tied };
}

export interface UnmatchedCorrection {
  correction: BandCorrection;
  /** "gone": no band of this read is in its place; "tied": two bands are in its place equally. */
  why: "gone" | "tied";
}

/** What is wrong with a change on its own (before it meets a read), in plain words; null when nothing. */
export function changeProblem(change: BandChange): string | null {
  const keys = Object.keys(change).filter((k) => (change as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) return "Nothing was changed.";
  if (keys.some((k) => !["name", "role", "top", "bottom"].includes(k))) return "Only a band's name, kind, top and bottom can be corrected.";
  if (change.name !== undefined && (typeof change.name !== "string" || change.name.trim().length === 0 || change.name.trim().length > MAX_NAME)) return `A band's name needs 1 to ${MAX_NAME} characters.`;
  if (change.role !== undefined && !ROLES.includes(change.role)) return "A band is a header, a band or a footer.";
  for (const edge of ["top", "bottom"] as const) {
    const v = change[edge];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) return `The ${edge} edge must be a whole number of pixels, 0 or more.`;
  }
  return null;
}

export function applyBandCorrections<B extends CorrectableBand>(
  read: B[],
  corrections: BandCorrection[],
  height: number,
  /** The read these bands are from (its runId): a correction made on it carries its edges whatever they are. */
  currentRun: string | null,
): { bands: CorrectedBand<B>[]; unmatched: UnmatchedCorrection[]; problems: CorrectionProblem[] } {
  const bands: CorrectedBand<B>[] = read.map((b) => ({ ...b, asRead: { top: b.top, bottom: b.bottom }, corrected: null }));
  const unmatched: UnmatchedCorrection[] = [];
  const problems: CorrectionProblem[] = [];
  // A stable sort: corrections saved in the same millisecond keep the order they were given in (the database's, to the microsecond).
  const ordered = [...corrections].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const c of ordered) {
    const invalid = changeProblem(c.change);
    if (invalid) {
      problems.push({ id: c.id, reason: invalid, text: `A correction made on the band at ${c.anchor.top} to ${c.anchor.bottom} px can't be applied: ${invalid}` });
      continue;
    }
    const match = matchBand(read, c.anchor);
    if (match.index < 0 || match.tied) {
      unmatched.push({ correction: c, why: match.tied ? "tied" : "gone" });
      continue;
    }
    const i = match.index;
    const band = bands[i]!;
    if (c.change.name !== undefined) band.name = c.change.name.trim();
    if (c.change.role !== undefined) band.role = c.change.role;
    const edges = c.change.top !== undefined || c.change.bottom !== undefined;
    if (edges && c.madeOnRun !== currentRun && match.score < EDGE_MATCH) {
      const reason = `it was read in a different place this time (${band.asRead.top} to ${band.asRead.bottom} px, not ${c.anchor.top} to ${c.anchor.bottom}), so edges set on an earlier read were not carried over; correct them again if needed.`;
      problems.push({ id: c.id, reason, text: `The correction of "${band.name}" was applied without its edges: ${reason}` });
    } else if (edges) {
      const problem = moveEdges(bands, i, c.change.top ?? band.top, c.change.bottom ?? band.bottom, height);
      if (problem) problems.push({ id: c.id, reason: problem, text: `The correction of "${band.name}" (${c.anchor.top} to ${c.anchor.bottom} px) was not applied to its edges: ${problem}` });
    }
    band.corrected = { by: c.by, at: c.at, ids: [...(band.corrected?.ids ?? []), c.id] };
  }
  return { bands, unmatched, problems };
}

/* Moves band i to top..bottom, and its neighbours' edges with it; null when done, else why not (nothing moved). */
function moveEdges(bands: CorrectableBand[], i: number, top: number, bottom: number, height: number): string | null {
  const band = bands[i]!;
  const above = bands[i - 1];
  const below = bands[i + 1];
  if (top !== band.top && !above) return "the first band starts at the top of the page.";
  if (bottom !== band.bottom && !below) return "the last band ends at the bottom of the page.";
  if (top < 0 || bottom > height) return `the edges must stay inside the page (0 to ${height} px).`;
  if (bottom - top < MIN_HEIGHT) return `a band needs at least ${MIN_HEIGHT} px.`;
  if (above && top - above.top < MIN_HEIGHT) return `that would leave "${above.name}" above it under ${MIN_HEIGHT} px.`;
  if (below && below.bottom - bottom < MIN_HEIGHT) return `that would leave "${below.name}" below it under ${MIN_HEIGHT} px.`;
  band.top = top;
  band.bottom = bottom;
  if (above) above.bottom = top;
  if (below) below.top = bottom;
  return null;
}
