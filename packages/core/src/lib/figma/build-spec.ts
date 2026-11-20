/*
  The plan one build call is given (E5a, Lane 2, 15 November 2026; spec 15
  section 6 stage 4). Plain code, no AI and no storage: given a design read
  as a person has corrected it, the asset sheet the pictures step made, and
  the pages that will exist, it says what the builder is told to draw.

  Why this is code and not part of the call: the builder must never be the
  one deciding which band a word belongs to, which file a picture is, or
  where a menu item points. Those are answerable by measurement, and a
  measurement is cheaper, repeatable and checkable (standing rule 6).

  The rules, and where they come from:

  - A word or picture belongs to the band whose span holds its CENTRE. One
    that falls in no band goes to the nearest band and is flagged, rather
    than being dropped: the paid run showed whole bands coming out blank
    and nothing said so (P-1).
  - Pictures are matched to the asset sheet BY POSITION, not by id. A
    read's ids are only unique within one call, and a tall band is read in
    several, so two pictures of one band can carry the same id (Fable's
    review of E4b-2b). The same overlap test the corrections use decides.
  - A picture the pictures step could not cut is kept in its band, marked
    with no file, and flagged. The page is built at its patched best and
    the item asks for an upload later (Jason, 12 November, answer 2); it is
    never guessed at and never silently left out.
  - Menu items that have no page are kept exactly as drawn and flagged,
    not dropped. The paid run reduced a five-item menu to "HOME" (P-4).
  - Words are carried VERBATIM. No trimming, no re-spacing, no tidying of
    phone numbers: the paid run re-formatted them (P-5). Only characters
    that cannot be drawn at all are removed.
  - Header and footer are whichever bands the read named as such, never a
    band's height or position (13, L-03).

  What comes out feeds two things: the build call, and `designSpecFrom`,
  the shape the checks (E2, design-checks.ts) measure the built page
  against. Both come from this one plan, so the builder and the checks can
  never be working from different ideas of the design.
*/

import { boxMatch, MIN_MATCH, type Box, type PictureKind, type WordRole } from "./read-item-corrections";

/** A band of the design, as the read named it. */
export type BandRole = "header" | "band" | "footer";

export interface SpecBand {
  name: string;
  role: BandRole;
  top: number;
  bottom: number;
}

export interface SpecWord {
  text: string;
  role: WordRole;
  box: Box;
  unsure?: boolean;
}

export interface SpecPicture {
  id: string;
  kind: PictureKind;
  box: Box;
}

export interface SpecColour {
  name: string;
  x: number;
  y: number;
  hex: string;
}

export interface SpecFont {
  role: "heading" | "body" | "button" | "other";
  family: string;
}

/** One picture of the asset sheet, as much of it as the plan needs. */
export interface SheetEntry {
  id: string;
  kind: PictureKind;
  box: Box;
  /** Null for icons, and for a picture that could not be cut. */
  file: string | null;
  icon: { name: string; by: string } | null;
  flags: string[];
}

/** What the read found, after a person's corrections have been applied. */
export interface ReadForBuild {
  width: number;
  height: number;
  bands: {
    band: SpecBand;
    words: SpecWord[];
    pictures: SpecPicture[];
    fonts: SpecFont[];
  }[];
  colours: SpecColour[];
}

export interface PlanWord {
  text: string;
  role: WordRole;
  box: Box;
  /** The read could not make every letter out: drawn as read, left out of the word check. */
  unsure: boolean;
}

export interface PlanPicture {
  kind: PictureKind;
  box: Box;
  /** The prepared file to draw, or null when there is nothing to draw yet. */
  file: string | null;
  /** Set for an icon: the name in TAWD's icon set. */
  icon: string | null;
  /** A name for this picture that the checks and the builder both use. */
  name: string;
}

export interface PlanBand {
  name: string;
  role: BandRole;
  top: number;
  height: number;
  words: PlanWord[];
  pictures: PlanPicture[];
  fonts: SpecFont[];
}

export interface PlanMenuItem {
  /** Exactly as drawn. */
  text: string;
  box: Box;
  /** The page it opens, or null when no page of this build has that name. */
  href: string | null;
}

export interface BuildPlan {
  width: number;
  height: number;
  bands: PlanBand[];
  /** The header's links, in the order they are drawn. */
  menu: PlanMenuItem[];
  colours: SpecColour[];
  /** Plain sentences for the "Could not copy" list. Never shown as a failure on their own. */
  flags: string[];
}

/*
  Characters that cannot be drawn: control codes, and the half of a broken
  emoji left on its own.

  A WHOLE emoji is two of those halves in a pair, and it must survive: a
  design that draws a spanner keeps its spanner. Matching the surrogate
  range on its own would delete both halves of every emoji on the page,
  which is the opposite of carrying the words as drawn.
*/
// eslint-disable-next-line no-control-regex
const UNDRAWABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The text exactly as the design draws it, minus only what cannot be drawn.
 *
 * Nothing else is touched: a phone number keeps its brackets, dots or
 * spacing, and two spaces stay two spaces. The paid run's re-formatting
 * (P-5) came from tidying here.
 */
export function drawableText(text: string): string {
  return text.replace(UNDRAWABLE, "");
}

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** How far a centre sits outside a band's span; 0 when it is inside. */
function awayFrom(band: SpecBand, y: number): number {
  if (y < band.top) return band.top - y;
  if (y > band.bottom) return y - band.bottom;
  return 0;
}

/**
 * The band an item belongs to: the one whose span holds its centre, or
 * failing that the nearest one. Returns the index and whether it had to
 * fall back, so the caller can flag it.
 */
export function bandFor(bands: SpecBand[], box: Box): { index: number; outside: boolean } | null {
  if (bands.length === 0) return null;
  const y = centre(box).y;
  let best = 0;
  let bestAway = Infinity;
  for (let i = 0; i < bands.length; i += 1) {
    const away = awayFrom(bands[i]!, y);
    if (away < bestAway) {
      best = i;
      bestAway = away;
    }
  }
  return { index: best, outside: bestAway > 0 };
}

/**
 * The asset sheet entry for a picture the read found, matched by position.
 *
 * Not by id: see the note at the top. The entry must overlap the read's
 * box by at least MIN_MATCH, and the best overlap wins. A tie between two
 * entries leaves the picture unmatched rather than picking one by chance.
 */
export function entryFor(entries: SheetEntry[], picture: SpecPicture): SheetEntry | null {
  let best: SheetEntry | null = null;
  let bestScore = MIN_MATCH;
  let tied = false;
  for (const entry of entries) {
    const score = boxMatch(entry.box, picture.box);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      tied = false;
    } else if (best && score === bestScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** A word that acts as a menu item: a link or a button drawn in the header. */
function isMenuWord(word: SpecWord): boolean {
  return word.role === "link" || word.role === "button";
}

/* Menu text and page names are compared with case, spacing and punctuation set aside. */
function sameName(a: string, b: string): boolean {
  const plain = (s: string) =>
    s
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return plain(a) === plain(b) && plain(a) !== "";
}

/** A page this build will produce: what it is called, and the address it sits at. */
export interface BuiltPage {
  name: string;
  /** "" for the home page. */
  slug: string;
}

/**
 * Build the plan.
 *
 * `pages` is what this build will actually produce. On the first run that
 * is the home page alone (standing rule 8, one page first), so most menu
 * items will have no page: they are kept as drawn and flagged, which is
 * the point of P-4.
 */
export function buildPlan(read: ReadForBuild, sheet: SheetEntry[], pages: BuiltPage[]): BuildPlan {
  const flags: string[] = [];
  const bands = [...read.bands].sort((a, b) => a.band.top - b.band.top);
  const spans = bands.map((b) => b.band);

  const planBands: PlanBand[] = spans.map((band, i) => ({
    name: band.name,
    role: band.role,
    top: band.top,
    height: Math.max(0, band.bottom - band.top),
    words: [],
    pictures: [],
    fonts: bands[i]!.fonts,
  }));

  /*
    Words keep the ORDER THE READ GAVE THEM, band by band.

    Sorting the whole page by y and then x looks tidier and is wrong. A row
    of three cards is read "Repairs / We fix pumps / Wells / We drill wells
    / Filtration / We clean water"; sorting by y turns that into the three
    headings followed by the three paragraphs, because the headings share a
    y and the paragraphs share a lower one. The checks compare the design's
    words against the page's IN ORDER, so a perfectly built page would come
    back with half its words reported missing, and E5b's correction rounds
    would then be spent chasing failures that are not there. A single pixel
    of difference between two words on one line would reorder them too.

    The read gives its words in reading order within each band, which is
    the order a person would read the design, so that is what is kept.
  */
  const allWords = bands
    .flatMap((b) => b.words)
    .map((w) => ({ ...w, text: drawableText(w.text) }))
    .filter((w) => w.text !== "");

  for (const word of allWords) {
    const found = bandFor(spans, word.box);
    if (!found) continue;
    if (found.outside) {
      flags.push(`The words "${short(word.text)}" sit outside every band the read found; they are drawn in "${spans[found.index]!.name}".`);
    }
    planBands[found.index]!.words.push({ text: word.text, role: word.role, box: word.box, unsure: word.unsure === true });
  }

  // Pictures, each matched to what the pictures step prepared.
  let n = 0;
  for (const band of bands) {
    for (const picture of band.pictures) {
      n += 1;
      const found = bandFor(spans, picture.box);
      if (!found) continue;
      const entry = entryFor(sheet, picture);
      const name = `picture ${n}`;
      if (!entry) {
        flags.push(`A ${picture.kind} in "${spans[found.index]!.name}" was read but not prepared, so it is left out of the page.`);
        planBands[found.index]!.pictures.push({ kind: picture.kind, box: picture.box, file: null, icon: null, name });
        continue;
      }
      if (entry.kind === "icon") {
        if (!entry.icon) flags.push(`An icon in "${spans[found.index]!.name}" was not matched to one in TAWD's set, so a space is left for it.`);
        planBands[found.index]!.pictures.push({ kind: entry.kind, box: picture.box, file: null, icon: entry.icon?.name ?? null, name });
      } else {
        if (!entry.file) flags.push(`A ${entry.kind} in "${spans[found.index]!.name}" could not be cut out of the design, so its space is left empty.`);
        planBands[found.index]!.pictures.push({ kind: entry.kind, box: picture.box, file: entry.file, icon: null, name });
      }
      for (const flag of entry.flags) flags.push(`${name} in "${spans[found.index]!.name}": ${flag}`);
    }
  }

  // The menu: the header's links and buttons, as drawn, each pointed at a page if one exists.
  const header = planBands.find((b) => b.role === "header");
  const menu: PlanMenuItem[] = [];
  if (header) {
    const items = header.words.filter(isMenuWord).sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
    for (const item of items) {
      const page = pages.find((p) => sameName(p.name, item.text));
      menu.push({ text: item.text, box: item.box, href: page ? `/${page.slug}` : null });
    }
    const without = menu.filter((m) => m.href === null);
    if (without.length) {
      flags.push(
        `The menu is drawn in full, but ${without.length === 1 ? "one item has" : `${without.length} items have`} no page yet: ${without.map((m) => `"${short(m.text)}"`).join(", ")}.`,
      );
    }
  }

  return { width: read.width, height: read.height, bands: planBands, menu, colours: read.colours, flags };
}

function short(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

/* ---- What the checks measure the built page against ---- */

export interface SpecForChecks {
  width: number;
  height: number;
  bands: { name: string; top: number; height: number }[];
  words: { text: string; uncertain?: boolean }[];
  pictures: { name: string; x: number; y: number; w: number; h: number }[];
}

/**
 * The same plan, in the shape the checks take (E2).
 *
 * A word the read was unsure of is marked `uncertain`, so the word check
 * neither demands it nor counts it as added: it is flagged for a person
 * instead. A picture with nothing to draw is left out, because the checks
 * would otherwise fail a band for a picture that was never going to be
 * there; the flag already says so.
 */
export function designSpecFrom(plan: BuildPlan): SpecForChecks {
  return {
    width: plan.width,
    height: plan.height,
    bands: plan.bands.map((b) => ({ name: b.name, top: b.top, height: b.height })),
    words: plan.bands.flatMap((b) => b.words.map((w) => (w.unsure ? { text: w.text, uncertain: true } : { text: w.text }))),
    pictures: plan.bands.flatMap((b) =>
      b.pictures.filter((p) => p.file !== null || p.icon !== null).map((p) => ({ name: p.name, x: p.box.x, y: p.box.y, w: p.box.w, h: p.box.h })),
    ),
  };
}
