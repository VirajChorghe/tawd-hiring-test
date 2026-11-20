import type { CheckIssue } from "./checks";
import { PLACEHOLDER_PATTERN } from "./checks";

/*
  A page as its bands: header, each section, footer. A fix round sends the
  AI only the bands a problem is in and swaps back only what it returns,
  so a fix costs a few thousand tokens instead of a whole page.

  The bands are the top-level elements inside <body>, with a <main> opened
  up into its children, and a single wrapper opened up too. The worker's
  rendered checks find bands by the same rule in the browser
  (render.ts), so an index here and there mean the same band.
*/

export interface PageSection {
  index: number;
  tag: string;
  start: number;
  end: number;
  html: string;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/* Not content: never a band, but left where they are. */
export const NON_SECTION_TAGS = new Set(["script", "style", "noscript", "link", "template", "meta"]);

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;

interface Element {
  tag: string;
  start: number;
  /** Just after the opening tag. */
  innerStart: number;
  /** Where the closing tag begins. */
  innerEnd: number;
  end: number;
}

/** The elements directly inside [from, to), in order. */
function childElements(html: string, from: number, to: number): Element[] {
  const out: Element[] = [];
  const stack: { tag: string; start: number; innerStart: number }[] = [];
  TAG.lastIndex = from;
  let match: RegExpExecArray | null;

  while ((match = TAG.exec(html)) !== null && match.index < to) {
    if (match[0].startsWith("<!--")) continue;
    const closing = match[1] === "/";
    const tag = match[2]!.toLowerCase();
    const selfClosing = match[3] === "/" || VOID.has(tag);

    if (!closing) {
      if (selfClosing) {
        if (stack.length === 0) {
          out.push({ tag, start: match.index, innerStart: TAG.lastIndex, innerEnd: TAG.lastIndex, end: TAG.lastIndex });
        }
        continue;
      }
      if (RAW_TEXT.has(tag)) {
        // Skip to the matching close: nothing inside is markup.
        const close = html.toLowerCase().indexOf(`</${tag}`, TAG.lastIndex);
        const closeEnd = close === -1 ? to : html.indexOf(">", close) + 1;
        if (stack.length === 0) {
          out.push({ tag, start: match.index, innerStart: TAG.lastIndex, innerEnd: close === -1 ? to : close, end: closeEnd });
        }
        TAG.lastIndex = closeEnd;
        continue;
      }
      stack.push({ tag, start: match.index, innerStart: TAG.lastIndex });
      continue;
    }

    // A closing tag: close back to the nearest open element of that name.
    let at = stack.length - 1;
    while (at >= 0 && stack[at]!.tag !== tag) at -= 1;
    if (at < 0) continue;
    const opened = stack[at]!;
    stack.length = at;
    if (stack.length === 0) {
      out.push({ tag, start: opened.start, innerStart: opened.innerStart, innerEnd: match.index, end: TAG.lastIndex });
    }
  }
  return out;
}

export function splitSections(html: string): PageSection[] {
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (!bodyOpen) return [];
  const bodyStart = bodyOpen.index + bodyOpen[0].length;
  const bodyClose = html.toLowerCase().lastIndexOf("</body");
  const bodyEnd = bodyClose === -1 ? html.length : bodyClose;

  const content = (list: Element[]) => list.filter((e) => !NON_SECTION_TAGS.has(e.tag));
  let bands = content(childElements(html, bodyStart, bodyEnd)).flatMap((e) =>
    e.tag === "main" ? content(childElements(html, e.innerStart, e.innerEnd)) : [e],
  );
  if (bands.length === 1) bands = content(childElements(html, bands[0]!.innerStart, bands[0]!.innerEnd));

  return bands.map((e, index) => ({ index, tag: e.tag, start: e.start, end: e.end, html: html.slice(e.start, e.end) }));
}

/** Swaps sections by index, last first so earlier positions stay valid. */
export function replaceSections(html: string, sections: PageSection[], replacements: Map<number, string>): string {
  let out = html;
  for (const section of [...sections].sort((a, b) => b.start - a.start)) {
    const next = replacements.get(section.index);
    if (next === undefined) continue;
    out = out.slice(0, section.start) + next + out.slice(section.end);
  }
  return out;
}

const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const digitsOf = (text: string) => text.replace(/\D+/g, "");

/*
  Which bands a problem is in. A rendered check says so itself; a check on
  the HTML leaves evidence (the phone number it found, the placeholder it
  counted) that is looked for band by band; the rest follow from what the
  check is about. When nothing narrows it down: the header and the hero.
*/
export function sectionsForIssue(issue: CheckIssue, sections: PageSection[]): number[] {
  if (sections.length === 0) return [];
  const all = sections.map((s) => s.index);
  const where = (test: (s: PageSection) => boolean) => sections.filter(test).map((s) => s.index);
  const top = all.slice(0, 2);

  if (issue.sections && issue.sections.length > 0) return issue.sections.filter((i) => i < sections.length);

  if (issue.evidence) {
    const evidence = issue.evidence;
    const found = where((s) => s.html.includes(evidence) || plain(s.html).includes(evidence));
    if (found.length > 0) return found;
    const digits = digitsOf(evidence);
    if (digits.length >= 7) {
      const byDigits = where((s) => digitsOf(plain(s.html)).includes(digits));
      if (byDigits.length > 0) return byDigits;
    }
  }

  const id = issue.id;
  if (id.startsWith("structure.h1")) {
    const withH1 = where((s) => /<h1\b/i.test(s.html));
    return withH1.length > 0 ? withH1 : top;
  }
  if (id === "a11y.alt") return where((s) => /<img\b(?![^>]*\balt=)/i.test(s.html));
  if (id === "a11y.labels" || id === "conversion.form.missing") {
    const forms = where((s) => /<(form|input|select|textarea)\b/i.test(s.html));
    if (forms.length > 0) return forms;
    // No form anywhere: the last band before the footer is where one goes.
    const last = sections.at(-1)!;
    return [last.tag === "footer" && sections.length > 1 ? last.index - 1 : last.index];
  }
  // A feature of the current site that is missing (5 November 2026): added as new sections before the footer.
  if (id === "content.siteFeatures") {
    const last = sections.at(-1)!;
    return [last.tag === "footer" && sections.length > 1 ? last.index - 1 : last.index];
  }
  if (id === "images.logo.unused") {
    return [...new Set([all[0]!, all.at(-1)!])];
  }
  if (id === "images.photos.unused") {
    const frames = where((s) => /\bPhoto:/i.test(plain(s.html)));
    return [...new Set([all[1] ?? all[0]!, ...frames])].slice(0, 4);
  }
  if (id.startsWith("placeholders.")) {
    const withPlaceholders = where((s) => new RegExp(PLACEHOLDER_PATTERN.source, "i").test(s.html));
    if (withPlaceholders.length > 0) return withPlaceholders;
  }
  return top;
}

/* ---------- parts for an edit: the bands, and the style sheet ---------- */

/*
  The page's own style sheet, as one more part an edit can change, for a
  request about the whole page's look (colors, fonts, spacing everywhere).
  It is the largest <style> element that is not TAWD's fix block. Its
  index is -1, and it goes to the AI as <tawd-section id="styles">.
*/
export const STYLES_PART = -1;

export function styleSection(html: string): PageSection | null {
  let best: PageSection | null = null;
  for (const match of html.matchAll(/<style\b(?![^>]*data-tawd-fixes)[^>]*>[\s\S]*?<\/style>/gi)) {
    if (!best || match[0].length > best.html.length) {
      best = { index: STYLES_PART, tag: "style", start: match.index, end: match.index + match[0].length, html: match[0] };
    }
  }
  return best;
}

/*
  The page as the reviewer reads it: each band opened by a marker
  (<!-- band N -->), so each note can say which band it is about and the
  improvement round sends only those.
*/
export function markBands(html: string): string {
  let out = html;
  for (const section of [...splitSections(html)].reverse()) {
    out = `${out.slice(0, section.start)}<!-- band ${section.index} -->\n${out.slice(section.start)}`;
  }
  return out;
}

/* A short outline of the bands, for the call that finds which a written request is about. */
export function outlineBands(sections: PageSection[]): string {
  return sections
    .map((s) => {
      const open = /^<[^>]*>/.exec(s.html)?.[0] ?? "";
      const id = /\sid=["']([^"']+)/i.exec(open)?.[1];
      const cls = /\sclass=["']([^"']+)/i.exec(open)?.[1]?.split(/\s+/).slice(0, 3).join(".");
      const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(s.html)?.[1];
      const text = plain(heading ?? s.html).trim().slice(0, 100);
      return `${s.index}. <${s.tag}${id ? `#${id}` : ""}${cls ? `.${cls}` : ""}> ${text}`;
    })
    .join("\n");
}

/*
  Which parts a Creative Director note is about: its band number, the
  style sheet for a page-wide note (band -1), or, for a note without a
  usable number, its section name when that clearly names one band. Null
  when it cannot be told; that note then goes to the call that finds it.
*/
export function bandsForNote(note: { band?: number | null; section: string }, sections: PageSection[]): number[] | null {
  if (sections.length === 0) return null;
  if (note.band === STYLES_PART) return [STYLES_PART];
  if (typeof note.band === "number" && note.band >= 0 && note.band < sections.length) return [note.band];

  const name = note.section.toLowerCase();
  const last = sections.at(-1)!;
  if (/\bfooter\b/.test(name) && last.tag === "footer") return [last.index];
  if (/\b(header|nav|navigation|top bar)\b/.test(name) && sections[0]!.tag === "header") return [0];
  if (/\b(hero|first screen|above the fold)\b/.test(name)) {
    return [sections[0]!.tag === "header" && sections.length > 1 ? 1 : 0];
  }
  // A band whose id or first heading carries the note's section name.
  const words = name.replace(/[^a-z0-9 ]+/g, " ").trim();
  if (words.length >= 3) {
    const found = sections.filter((s) => {
      const open = /^<[^>]*>/.exec(s.html)?.[0].toLowerCase() ?? "";
      const heading = plain(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(s.html)?.[1] ?? "").toLowerCase();
      return open.includes(words.replace(/ /g, "-")) || (heading.length > 0 && heading.includes(words));
    });
    if (found.length === 1) return [found[0]!.index];
  }
  return null;
}

/*
  Which band a pinned comment sits on: its position down the full-page
  screenshot (0-100) against where each band starts and ends on the page,
  as measured in the browser. Null when the bands could not be measured.
*/
export function bandAtPin(y: number, extents: { top: number; bottom: number }[]): number | null {
  const at = extents.findIndex((e) => y >= e.top && y < e.bottom);
  if (at !== -1) return at;
  return extents.length > 0 && y >= extents.at(-1)!.bottom ? extents.length - 1 : null;
}

/*
  The bands of a version, measured with its render (2 October 2026): in
  pixels down the page, with a short name (the first heading, or the
  element). Kept on the version's checks so a pin is tied to its section
  when it is placed, and the screen can outline the section under the mouse.
*/
export interface PageBand {
  top: number;
  bottom: number;
  label: string;
}

/*
  Where each band sits on the render, in percent of the picture (which
  stops at its height cap). Bands with no height (a closed phone menu, a
  skip link) or below the cap are left out, so each keeps `index`, its
  number in splitSections: a pin is stored and edited by that number,
  never by its place in this shorter list (Fable's check, 3 October 2026).
*/
export interface BandOnImage {
  index: number;
  top: number;
  bottom: number;
  label: string;
}

export function bandsOnImage(bands: PageBand[], imageHeight: number): BandOnImage[] {
  if (imageHeight <= 0) return [];
  return bands
    .map((b, index) => ({ b, index }))
    .filter(({ b }) => b.top < imageHeight && b.bottom > b.top)
    .map(({ b, index }) => ({
      index,
      top: (b.top / imageHeight) * 100,
      bottom: (Math.min(b.bottom, imageHeight) / imageHeight) * 100,
      label: b.label,
    }));
}

/* The band (its splitSections number) at a point down the picture, in percent; null when none. */
export function bandIndexAt(y: number, bands: BandOnImage[]): number | null {
  const at = bandAtPin(y, bands);
  return at === null ? null : bands[at]!.index;
}

/* The full-page render stops at this height (render.ts): a taller page's picture is its top 12,000 pixels. */
export const RENDER_HEIGHT_CAP = 12_000;

/*
  A point down a version's picture (percent of the picture) as a point down
  the whole page (percent of the page), for the pages taller than the cap
  (Fable's A7, 3 October 2026). Unknown heights leave it as it is.
*/
export function pictureToPagePercent(y: number, checks: unknown): number {
  const c = (checks ?? {}) as { heightPx?: unknown; truncated?: unknown };
  const height = typeof c.heightPx === "number" ? c.heightPx : 0;
  if (height <= RENDER_HEIGHT_CAP || c.truncated === false) return y;
  return (y * RENDER_HEIGHT_CAP) / height;
}

/* Reads the bands kept on a version's checks; anything else gives none. */
export function readPageBands(checks: unknown): { bands: PageBand[]; imageHeight: number } {
  const c = (checks ?? {}) as { bands?: unknown; heightPx?: unknown; imageHeightPx?: unknown; truncated?: unknown };
  const bands = Array.isArray(c.bands)
    ? c.bands.filter(
        (b): b is PageBand =>
          typeof b === "object" && b !== null && typeof b.top === "number" && typeof b.bottom === "number" && typeof b.label === "string",
      )
    : [];
  const imageHeight =
    typeof c.imageHeightPx === "number"
      ? c.imageHeightPx
      : typeof c.heightPx === "number"
        ? Math.min(c.heightPx, c.truncated === true ? RENDER_HEIGHT_CAP : c.heightPx)
        : 0;
  return { bands, imageHeight };
}

/** The element whose opening tag starts at `start`: where its content begins and ends. */
export function elementAt(html: string, start: number): { tag: string; innerStart: number; innerEnd: number; end: number } | null {
  const first = childElements(html, start, html.length)[0];
  return first && first.start === start ? { tag: first.tag, innerStart: first.innerStart, innerEnd: first.innerEnd, end: first.end } : null;
}
