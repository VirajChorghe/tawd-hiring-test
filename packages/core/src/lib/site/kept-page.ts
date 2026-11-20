import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/*
  A page the team supplied is kept as it is (Jason, 16 November 2026: "if we
  are providing a supplied home page why is TAWD changing it? That is not the
  way Build A should function").

  The rule: structure and attributes may be adjusted so the page works (the
  picture paths, the stripped scripts, the form's attributes, the head);
  the words a visitor reads may not change. TAWD's own tidy-up rules (call
  to action wording, phone layout, picture frames, form labels) exist for
  pages a model wrote. On a supplied page each one still runs, in a copy,
  so the team can be told exactly what it would have changed. The copy is
  thrown away; the page is never touched.

  This file holds the small pieces that make that possible: the
  words a visitor reads, a diff of two sets of them, and a way to run a
  whole-page pass with the kept <main> held out of its reach.
*/

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";

// Nothing in these is read on the page. (An svg is handled on its own below: only its <text> and foreignObject are words.)
// <title> and <desc> inside an svg are for screen readers and a hover tooltip on the picture, like an alt: they may be adjusted.
const NOT_WORDS = new Set(["script", "style", "template", "head", "title", "desc"]);

// An input shows its own typed or prefilled text; these types show something else (a tick, a colour, a file name) or nothing.
const NO_VALUE_SHOWN = /^(hidden|checkbox|radio|password|file|image|range|color)$/i;

const squash = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() ?? "";

/*
  Every piece of text a visitor reads, in page order: the words between the
  tags, a form field's placeholder and prefilled value, a button's value, a
  dropdown choice's label, the hover tooltip (title="") on any tag, the label
  of a caption track, and the words drawn inside a picture (svg <text>,
  foreignObject). <noscript> counts: it is what a visitor with scripts off
  reads. Each piece is whitespace collapsed. Attributes a visitor does not
  read (alt, aria-label, href) are left out on purpose: those may be adjusted.
*/
export function visibleWords(html: string): string[] {
  const out: string[] = [];
  const add = (value: string | undefined) => {
    const text = squash(value);
    if (text) out.push(text);
  };
  // inSvg: inside an <svg>, where only <text> and <foreignObject> hold words (shapes, paths and defs draw none).
  const visit = (nodes: ChildNode[], inSvg: boolean, inSvgText: boolean, inDatalist: boolean) => {
    for (const node of nodes) {
      if (node.type === "text") {
        if (inSvg && !inSvgText) continue;
        add((node as unknown as { data: string }).data);
        continue;
      }
      if (!isElement(node)) continue;
      const name = node.name.toLowerCase();
      // <title> and <desc> in an svg are skipped by name above; a real <title> only lives in the head.
      if (NOT_WORDS.has(name)) continue;
      // The hidden attribute takes an element out of the page entirely (the form's honeypot label is one), so nothing in it is read. Hidden by a style is not looked for: a page may show it again.
      if (node.attribs.hidden !== undefined) continue;
      const svgNow = inSvg || name === "svg";
      // foreignObject holds ordinary html again: the svg rules stop there.
      const isForeign = svgNow && name === "foreignobject";
      const textNow = isForeign ? true : svgNow ? inSvgText || name === "text" : false;
      if (!svgNow || textNow) {
        add(node.attribs.title);
        add(node.attribs.placeholder);
        if (name === "input" && !NO_VALUE_SHOWN.test(node.attribs.type ?? "")) add(node.attribs.value);
        // A dropdown choice shows its label="" when it has one, else its words (read below as children).
        if ((name === "option" || name === "optgroup") && node.attribs.label) add(node.attribs.label);
        // A datalist suggestion with no words of its own shows its value.
        if (name === "option" && inDatalist && !node.attribs.label && node.children.length === 0) add(node.attribs.value);
        // A caption track's label is the name in the video's caption menu.
        if (name === "track") add(node.attribs.label);
      }
      visit(node.children, isForeign ? false : svgNow, isForeign ? false : textNow, inDatalist || name === "datalist");
    }
  };
  visit(parseDocument(html).children, false, false, false);
  return out;
}

/* The same words as one line, for comparing two pages: node boundaries (how the tags happen to split the text) don't count, the words and their order do. */
export function visibleWordsLine(html: string): string {
  return visibleWords(html).join(" ").replace(/\s+/g, " ").trim();
}

export interface TextChange {
  from: string;
  to: string;
  /** How many places on the page. */
  count: number;
  /**
    A sentence for the team instead of a from/to pair: used when TAWD could not
    tell what would have changed (the page was too large to compare, or a rule
    could not be run safely around the page). Read as it stands.
  */
  notice?: string;
}

/*
  The most cells the word-by-word comparison may fill (one 4-byte cell per
  pair of pieces left after the identical start and end are cut off). 4
  million cells is 16 MB: a few thousand changed pieces on each side, far
  beyond any real home page. The worker has 2 GB and a comparison with no
  limit can take it down (20,000 pieces needed 4.1 GB), so above this the
  page is reported as too large to compare in detail instead of compared.
*/
export const MAX_COMPARE_CELLS = 4_000_000;

export const TOO_LARGE_NOTICE = "The page has too many pieces of text to compare word by word, so what the rules would have changed could not be listed";

/*
  What differs between two sets of visible words: a longest-common-run
  diff, then each removed piece paired with the piece that took its place.
  Pieces that only went (or only appeared) pair with nothing (an empty side).
  The identical start and end are cut off first (nearly always almost
  everything), and a comparison too large to do safely says so, never
  "no changes".
*/
export function textChanges(beforeAll: string[], afterAll: string[]): TextChange[] {
  let start = 0;
  while (start < beforeAll.length && start < afterAll.length && beforeAll[start] === afterAll[start]) start += 1;
  let endB = beforeAll.length;
  let endA = afterAll.length;
  while (endB > start && endA > start && beforeAll[endB - 1] === afterAll[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  const before = beforeAll.slice(start, endB);
  const after = afterAll.slice(start, endA);
  const n = before.length;
  const m = after.length;
  if (n === 0 && m === 0) return [];
  if ((n + 1) * (m + 1) > MAX_COMPARE_CELLS) return [{ from: "", to: "", count: 1, notice: TOO_LARGE_NOTICE }];
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = before[i] === after[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const found = new Map<string, TextChange>();
  const note = (from: string, to: string) => {
    const key = `${from}\u0000${to}`;
    const have = found.get(key);
    if (have) have.count += 1;
    else found.set(key, { from, to, count: 1 });
  };
  let i = 0;
  let j = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.max(removed.length, added.length);
    for (let k = 0; k < pairs; k += 1) note(removed[k] ?? "", added[k] ?? "");
    removed = [];
    added = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      removed.push(before[i]!);
      i += 1;
    } else {
      added.push(after[j]!);
      j += 1;
    }
  }
  flush();
  return [...found.values()];
}

/*
  The page's <main>: from its first opening tag to its last closing tag.
  Only the real <main> element: "<main-menu>" and the like (a custom element
  whose name merely starts with "main") are not it. The closing tag is found
  on the page as written, never on a lower-cased copy (that can change the
  string's length: "İ" becomes two characters), and may carry spaces or a
  line break before its ">".
*/
const MAIN_OPEN = /<main(?=[\s>/])/i;
function mainBounds(html: string): { start: number; end: number } | null {
  const open = MAIN_OPEN.exec(html);
  if (!open) return null;
  let close: { index: number; length: number } | null = null;
  for (const m of html.matchAll(/<\/main\s*>/gi)) close = { index: m.index, length: m[0].length };
  if (!close || close.index < open.index) return null;
  return { start: open.index, end: close.index + close.length };
}

export interface KeptPass {
  /** The page after the pass, with <main> exactly as it was given. */
  html: string;
  /** What the pass would have changed in the words of <main>, had it been let. Empty when it would have changed none. */
  wouldChange: TextChange[];
  /**
    False when a kept page could not be passed over safely and was given back
    untouched (no closing </main> to hold out, or the pass lost the held
    place). The caller must then not count the pass's work as done; the team
    is told through wouldChange.
  */
  applied: boolean;
}

export const NOT_APPLIED_NOTICE = "TAWD's usual rules were not run on this page at all, because its main content could not be held out of their reach safely";

/*
  Runs `pass` over a whole page (header, footer and all) without letting it
  reach the kept <main>: the <main> is swapped for a comment while the pass
  runs and put back after. `pass` is also run once over the <main> alone, and
  the words before and after compared, so what the pass would have changed
  can be told to the team. A page with no <main>, or a pass
  that loses the held place, is given back untouched rather than guessed at,
  and says so (applied: false).

  `pass` is told which run it is (forReal), so a pass that keeps count of what
  it has used (the picture pool) only spends it on the real run.
*/
export function keepMainThrough(html: string, pass: (page: string, forReal: boolean) => string): KeptPass {
  const notApplied: KeptPass = { html, wouldChange: [{ from: "", to: "", count: 1, notice: NOT_APPLIED_NOTICE }], applied: false };
  const bounds = mainBounds(html);
  if (!bounds) return notApplied;
  const main = html.slice(bounds.start, bounds.end);
  // A stand-in the page does not already contain: were the plain one already in the page, finding it again afterwards would be ambiguous.
  let hold = "<!--tawd-kept-main-->";
  for (let n = 2; html.includes(hold); n += 1) hold = `<!--tawd-kept-main-${n}-->`;
  const held = pass(html.slice(0, bounds.start) + hold + html.slice(bounds.end), true);
  if (held.split(hold).length !== 2) return notApplied;
  // The look-and-see run is given only the kept <main>, so what it counts and what it changes is about the kept words alone.
  const wouldChange = textChanges(visibleWords(main), visibleWords(pass(main, false)));
  // A function, never a string: the page's own text can hold "$&".
  return { html: held.replace(hold, () => main), wouldChange, applied: true };
}

/* One plain sentence per change, for the team ("Start with a conversation" would have become "Request a quote", in 3 places). */
export function describeEach(changes: TextChange[]): string[] {
  return changes.map((c) => {
    if (c.notice) return c.notice;
    const where = c.count > 1 ? `, in ${c.count} places` : "";
    const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 60)}...` : s}"`;
    if (!c.to) return `${quote(c.from)} would have been taken out${where}`;
    if (!c.from) return `${quote(c.to)} would have been added${where}`;
    return `${quote(c.from)} would have become ${quote(c.to)}${where}`;
  });
}

/*
  All of them, unless a limit is given. A caller that cuts the list short
  must show the rest somewhere else and say where (moreNote, e.g. ", listed
  in full below"): "and 8 more" with no way to see them hides what TAWD did
  not do from the team.
*/
export function describeChanges(changes: TextChange[], limit = Infinity, moreNote = ""): string {
  const shown = describeEach(changes.slice(0, limit));
  const more = changes.length > limit ? `; and ${changes.length - limit} more${moreNote}` : "";
  return `${shown.join("; ")}${more}`;
}

/*
  Notes joined into one run of sentences with exactly one full stop between
  and after them. A note may already end in a full stop of its own (the
  shared-parts note does), so each one's own trailing stops are taken off
  first: the joining is the only place a stop is added, so no mix of notes
  can double one.
*/
export function joinSentences(notes: string[]): string {
  const clean = notes.map((n) => n.trim().replace(/[.\s]+$/, "")).filter(Boolean);
  return clean.length ? `${clean.join(". ")}.` : "";
}

/*
  The mark a kept page carries on its <main>. It travels with the page into
  the saved sources and the built files, so every later pass (a rebuild, a
  speed-up of an old version, a fix) knows the page is kept without being
  told, and a person reading the page's source can see it too.
*/
export const KEPT_MAIN_ATTR = "data-tawd-kept";

export function isKeptMain(html: string): boolean {
  // The real <main> element only (never <main-menu>).
  const open = /<main(?=[\s>/])[^>]*>/i.exec(html);
  // The attribute by name, after a space and followed by a space, "=", ">" or "/": never the tail of a longer name.
  return Boolean(open && /\sdata-tawd-kept(?=[\s=>/])/i.test(open[0]));
}

/*
  The words a visitor reads in a kept page's own <main>, as one line (the
  header and footer round it are TAWD's, not the supplied page's, so they are
  not here). Null for a page that is not kept. The supplied page's words are
  the client's own words: the go-live fact and claim checks count a finding
  that is one of these words as backed (publish.ts, backedByOwnWords).
*/
export function keptMainWords(html: string): string | null {
  if (!isKeptMain(html)) return null;
  const bounds = mainBounds(html);
  return bounds ? visibleWordsLine(html.slice(bounds.start, bounds.end)) : null;
}

/*
  A page that was kept before an edit and has lost its mark after (the model
  was asked for the whole <main> back and wrote its own wrapper): the mark is
  put back by code, never left to the model, or the next build would treat the
  page as ordinary and rewrite every word of it.
*/
export function restampKept(before: string, after: string): string {
  if (!isKeptMain(before) || isKeptMain(after)) return after;
  return after.replace(/<main(?=[\s>/])/i, `<main ${KEPT_MAIN_ATTR}`);
}

/*
  The one door every whole-page pass goes through: an ordinary page gets the
  pass; a kept page gets it with its <main> held out of reach and the would-be
  changes reported.
*/
export function passOverPage(html: string, pass: (page: string, forReal: boolean) => string): KeptPass {
  return isKeptMain(html) ? keepMainThrough(html, pass) : { html: pass(html, true), wouldChange: [], applied: true };
}

/*
  The header and footer round a kept page are TAWD's own, not the supplied
  page's: the menu has to point at the site's real pages, so they are written
  to match the site. They may therefore word or lay out things differently
  from the kept <main>. This is the sentence that tells the team so, naming a
  phone number written two ways when the page and its header or footer do.
  Null for a page that is not kept (nothing is held back there).
*/
const PHONE_IN_TEXT = /\(?\d{3}\)?[\s.\-–]*\d{3}[\s.\-–]*\d{4}/g;

export function sharedPartsNote(html: string): string | null {
  if (!isKeptMain(html)) return null;
  const bounds = mainBounds(html);
  if (!bounds) return null;
  const phones = (text: string) => [...text.matchAll(PHONE_IN_TEXT)].map((m) => m[0].trim());
  const inMain = phones(visibleWordsLine(html.slice(bounds.start, bounds.end)));
  const around = phones(visibleWordsLine(html.slice(0, bounds.start) + html.slice(bounds.end)));
  const digits = (s: string) => s.replace(/\D/g, "");
  let differs: string | null = null;
  for (const a of around) {
    const other = inMain.find((p) => digits(p) === digits(a) && p !== a);
    if (other) {
      differs = ` The phone number is written "${a}" in them and "${other}" on the supplied page.`;
      break;
    }
  }
  return `They are TAWD's own (the menu has to point at the site's real pages), so their wording and layout may differ from the supplied page's.${differs ?? ""}`;
}
