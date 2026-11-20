/*
  A person's corrections to the words and pictures of the new design read
  (E4b-2b, Lane 2, 15 November 2026). Plain code, no storage: given the
  items a read found and the corrections made for that upload, it says what
  the words and pictures are now.

  The band list has its own module (read-corrections.ts). Bands are a
  top-and-bottom span of the page; words and pictures are boxes, so they
  are matched by area, not by height. Everything else follows the same
  rules Jason set on 14 November, for the same reasons:

  - Corrections apply oldest first. Each finds the item of THIS read whose
    box overlaps its anchor most (the box on the read it was made on),
    counted as the shared area over the two boxes together, and needing at
    least MIN_MATCH of it. On the read a correction was made on, its anchor
    is that item's own box, so it always matches. An item can take several
    corrections; a later one wins for the parts it changes.
  - Matching is against the items as read, never as already corrected, so
    an item moved by a correction is still found by the next one made on it.
  - A correction no item matches any more, or that two items match equally,
    is returned in `unmatched` with why: never dropped silently, and never
    given to one of them by chance.
  - What a person read off the design carries over to a re-read: a word's
    text and role, a picture's kind. An exact box does not, unless the item
    was read in nearly the same place (BOX_MATCH), because a box set on one
    read would otherwise cut or stretch a differently-read item; when it is
    not carried over, `problems` says so and the rest of the correction
    still applies.
  - A corrected word is no longer "unsure": a person has read it.
*/

import type { SheetKind } from "./read-assets";

/** The kinds a picture can be, as the asset sheet names them (read-assets.ts). */
export type PictureKind = SheetKind;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WordRole = "heading" | "paragraph" | "button" | "link" | "label" | "other";

export const WORD_ROLES: WordRole[] = ["heading", "paragraph", "button", "link", "label", "other"];
export const PICTURE_KINDS: PictureKind[] = ["photo", "background", "cutout", "logo", "silhouette", "icon"];

/** How much of an anchor an item must share to be the one a correction was made on. */
export const MIN_MATCH = 0.5;
/** How closely an item of a re-read must sit on a correction's anchor for an exact box to carry over. */
export const BOX_MATCH = 0.9;
/** The smallest box a correction may set, in design pixels: smaller is a mis-drag, not an intent. */
export const MIN_SIZE = 4;
export const MAX_TEXT = 2000;

export interface CorrectableWord {
  text: string;
  role: WordRole;
  box: Box;
  unsure?: boolean;
}

export interface CorrectablePicture {
  id: string;
  kind: PictureKind;
  box: Box;
}

export interface WordChange {
  text?: string;
  role?: WordRole;
}

export interface PictureChange {
  kind?: PictureKind;
  box?: Box;
}

export type ItemChange = WordChange | PictureChange;

export interface ItemCorrection<C extends ItemChange = ItemChange> {
  id: string;
  /** The item's box on the read this correction was made on. */
  anchor: Box;
  change: C;
  madeOnRun: string;
  by: string | null;
  at: string;
}

export interface CorrectedMark {
  by: string | null;
  at: string;
  /** Every correction applied to this item, oldest first. */
  ids: string[];
}

export type Corrected<T> = T & {
  /** The box as read, before any correction: what a new correction is anchored to. */
  asRead: Box;
  corrected: CorrectedMark | null;
};

export interface UnmatchedItemCorrection<C extends ItemChange = ItemChange> {
  correction: ItemCorrection<C>;
  /** "gone": no item of this read is in its place; "tied": two items are in its place equally. */
  why: "gone" | "tied";
}

export interface ItemProblem {
  id: string;
  text: string;
  reason: string;
}

function isBox(v: unknown): v is Box {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((k) => Number.isInteger(b[k]));
}

/** Shared area over the two boxes' area together (0 to 1). */
export function boxMatch(a: Box, b: Box): number {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlapW <= 0 || overlapH <= 0) return 0;
  const overlap = overlapW * overlapH;
  const together = a.w * a.h + b.w * b.h - overlap;
  return together > 0 ? overlap / together : 0;
}

/** The item that best matches an anchor: its index (-1 for none) and score; `tied` when two match it equally. */
export function matchItem(boxes: Box[], anchor: Box): { index: number; score: number; tied: boolean } {
  let index = -1;
  let score = 0;
  let tied = false;
  boxes.forEach((box, i) => {
    const s = boxMatch(box, anchor);
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

/** What is wrong with a word change on its own (before it meets a read), in plain words; null when nothing. */
export function wordChangeProblem(change: WordChange): string | null {
  const keys = Object.keys(change).filter((k) => (change as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) return "Nothing was changed.";
  if (keys.some((k) => !["text", "role"].includes(k))) return "Only a word's text and kind can be corrected.";
  if (change.text !== undefined && (typeof change.text !== "string" || change.text.trim().length === 0 || change.text.length > MAX_TEXT)) {
    return `The words need 1 to ${MAX_TEXT} characters.`;
  }
  if (change.role !== undefined && !WORD_ROLES.includes(change.role)) return "A word is a heading, a paragraph, a button, a link, a label or other.";
  return null;
}

/** What is wrong with a picture change on its own; null when nothing. The design's size checks the box later. */
export function pictureChangeProblem(change: PictureChange): string | null {
  const keys = Object.keys(change).filter((k) => (change as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0) return "Nothing was changed.";
  if (keys.some((k) => !["kind", "box"].includes(k))) return "Only a picture's kind and box can be corrected.";
  if (change.kind !== undefined && !PICTURE_KINDS.includes(change.kind)) return "A picture is a photo, a background, a cut-out, a logo, a silhouette or an icon.";
  if (change.box !== undefined) {
    if (!isBox(change.box)) return "A box is four whole numbers of pixels: x, y, width and height.";
    if (change.box.x < 0 || change.box.y < 0) return "A box starts inside the page (0 or more).";
    if (change.box.w < MIN_SIZE || change.box.h < MIN_SIZE) return `A box needs at least ${MIN_SIZE} px each way.`;
  }
  return null;
}

/** A box must stay inside the design; null when it does, else why not. */
export function boxFitsPage(box: Box, page: { width: number; height: number }): string | null {
  if (box.x + box.w > page.width || box.y + box.h > page.height) {
    return `the box must stay inside the design (${page.width} by ${page.height} px).`;
  }
  return null;
}

interface ApplyResult<T, C extends ItemChange> {
  items: Corrected<T>[];
  unmatched: UnmatchedItemCorrection<C>[];
  problems: ItemProblem[];
}

/*
  The shared walk: for each correction oldest first, find its item, say what
  can't be done, and hand the rest to `set`, which applies the one kind's
  fields. `describe` names the item in a sentence a person reads.
*/
function applyCorrections<T, C extends ItemChange>(
  read: T[],
  boxOf: (item: T) => Box,
  corrections: ItemCorrection<C>[],
  currentRun: string | null,
  invalidOf: (change: C) => string | null,
  describe: (item: Corrected<T>) => string,
  set: (item: Corrected<T>, change: C, carryBox: boolean) => string | null,
): ApplyResult<T, C> {
  const items: Corrected<T>[] = read.map((item) => ({ ...item, asRead: { ...boxOf(item) }, corrected: null }));
  const readBoxes = read.map(boxOf);
  const unmatched: UnmatchedItemCorrection<C>[] = [];
  const problems: ItemProblem[] = [];
  // A stable sort: corrections saved in the same millisecond keep the order they were given in.
  const ordered = [...corrections].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const c of ordered) {
    const invalid = invalidOf(c.change);
    if (invalid) {
      problems.push({
        id: c.id,
        reason: invalid,
        text: `A correction made at ${c.anchor.x}, ${c.anchor.y} px can't be applied: ${invalid}`,
      });
      continue;
    }
    const match = matchItem(readBoxes, c.anchor);
    if (match.index < 0 || match.tied) {
      unmatched.push({ correction: c, why: match.tied ? "tied" : "gone" });
      continue;
    }
    const item = items[match.index]!;
    const carryBox = c.madeOnRun === currentRun || match.score >= BOX_MATCH;
    const problem = set(item, c.change, carryBox);
    if (problem) problems.push({ id: c.id, reason: problem, text: `The correction of ${describe(item)} was applied without its box: ${problem}` });
    item.corrected = { by: c.by, at: c.at, ids: [...(item.corrected?.ids ?? []), c.id] };
  }
  return { items, unmatched, problems };
}

export function applyWordCorrections(
  read: CorrectableWord[],
  corrections: ItemCorrection<WordChange>[],
  currentRun: string | null,
): ApplyResult<CorrectableWord, WordChange> {
  return applyCorrections<CorrectableWord, WordChange>(
    read,
    (w) => w.box,
    corrections,
    currentRun,
    wordChangeProblem,
    (w) => `"${w.text}"`,
    (word, change) => {
      if (change.text !== undefined) word.text = change.text.trim();
      if (change.role !== undefined) word.role = change.role;
      // A person has looked at this word to correct it, whichever part they changed,
      // so the read's own "could not make every letter out" no longer stands.
      word.unsure = false;
      return null;
    },
  );
}

export function applyPictureCorrections(
  read: CorrectablePicture[],
  corrections: ItemCorrection<PictureChange>[],
  currentRun: string | null,
  page: { width: number; height: number },
): ApplyResult<CorrectablePicture, PictureChange> {
  return applyCorrections<CorrectablePicture, PictureChange>(
    read,
    (p) => p.box,
    corrections,
    currentRun,
    pictureChangeProblem,
    (p) => `the ${p.kind} at ${p.asRead.x}, ${p.asRead.y} px`,
    (picture, change, carryBox) => {
      if (change.kind !== undefined) picture.kind = change.kind;
      if (change.box === undefined) return null;
      if (!carryBox) {
        return `it was read in a different place this time (${picture.asRead.x}, ${picture.asRead.y} px, not ${change.box.x}, ${change.box.y}), so a box set on an earlier read was not carried over; set it again if needed.`;
      }
      const outside = boxFitsPage(change.box, page);
      if (outside) return outside;
      picture.box = { ...change.box };
      return null;
    },
  );
}
