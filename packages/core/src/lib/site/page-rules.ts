import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { phoneHref } from "../phone";

/*
  Code rules for every built page (Jason's comments on Sacramento Plumbing
  Experts, 8 October 2026), applied free after the build and before the
  speed pass, for Netlify and WordPress alike:

  - never an empty picture frame: a stock frame (data-tawd-photo) gets one
    of the client's own photos not used elsewhere, else any of theirs, and
    without any photo the frame is taken out (a site can't show the
    watermarked previews mockups use, and licensing isn't built yet);
  - two calls to action only: a button that goes to the form says "Request
    a quote" (it said "Send a message", "Describe the problem", "Call about
    your address");
  - the small label above the hero's heading goes when it only repeats the
    business's name.
*/

function isElement(node: unknown): node is Element {
  return Boolean(node) && (node as Element).type === "tag";
}

function walk(nodes: ChildNode[], visit: (el: Element) => void) {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    visit(n);
    walk(n.children, visit);
  }
}

function textOf(node: ChildNode): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  if (!isElement(node)) return "";
  if (node.name === "script" || node.name === "style" || node.name === "svg") return "";
  return node.children.map(textOf).join(" ");
}

const plain = (text: string) => text.replace(/\s+/g, " ").trim();
const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

interface Cut {
  start: number;
  end: number;
  insert: string;
}

function applyCuts(html: string, cuts: Cut[]): string {
  let out = html;
  for (const cut of [...cuts].sort((a, b) => b.start - a.start)) out = out.slice(0, cut.start) + cut.insert + out.slice(cut.end);
  return out;
}

/* ---------- picture frames ---------- */

export interface FrameFill {
  html: string;
  filled: number;
  removed: number;
}

/*
  Every stock frame on the page: filled with the photo `pick` gives for its
  label, or taken out when there's none. `pick` keeps track of what it has
  given, so the unused photos go first.
*/
export function fillPictureFrames(html: string, pick: (label: string) => string | null): FrameFill {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const cuts: Cut[] = [];
  let filled = 0;
  let removed = 0;
  walk(doc.children, (el) => {
    if (!("data-tawd-photo" in el.attribs) || el.startIndex == null || el.endIndex == null) return;
    if (cuts.some((c) => c.start <= el.startIndex! && c.end >= el.endIndex! + 1)) return;
    const label = plain(textOf(el)).replace(/^(photo|picture|image)\s*:\s*/i, "") || el.attribs["data-tawd-photo"] || "";
    const src = pick(label);
    if (!src) {
      cuts.push({ start: el.startIndex, end: el.endIndex + 1, insert: "" });
      removed += 1;
      return;
    }
    const classes = escapeAttr(el.attribs.class ?? "");
    cuts.push({
      start: el.startIndex,
      end: el.endIndex + 1,
      insert: `<${el.name}${classes ? ` class="${classes}"` : ""} data-tawd-filled><img src="${escapeAttr(src)}" alt="${escapeAttr(label)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;display:block"></${el.name}>`,
    });
    filled += 1;
  });
  return { html: cuts.length ? applyCuts(html, cuts) : html, filled, removed };
}

/* ---------- calls to action ---------- */

export const FORM_CTA = "Request a quote";

/* A link styled as a button that goes to the form (the contact page or the page's #contact form). */
function isFormButton(el: Element): boolean {
  if (el.name !== "a") return false;
  const href = el.attribs.href ?? "";
  const classes = el.attribs.class ?? "";
  if (!/\b(btn|button|cta)\b/i.test(classes)) return false;
  return /(^|\/)contact\/?(#.*)?$|#(contact|quote|form|request)\b/i.test(href);
}

/* Button labels that go to the form, all "Request a quote"; icons kept. Returns how many changed. */
export function unifyFormButtons(html: string): { html: string; changed: number } {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const cuts: Cut[] = [];
  walk(doc.children, (el) => {
    if (!isFormButton(el) || el.startIndex == null || el.endIndex == null) return;
    if (plain(textOf(el)).toLowerCase() === FORM_CTA.toLowerCase()) return;
    const openEnd = html.indexOf(">", el.startIndex) + 1;
    const closeStart = el.endIndex + 1 - "</a>".length;
    if (openEnd <= 0 || html.slice(closeStart, el.endIndex + 1).toLowerCase() !== "</a>") return;
    // Icons stay; the words become the one form label.
    const icons = el.children
      .filter((c): c is Element => isElement(c) && (c.name === "svg" || /\bicon\b/.test(c.attribs.class ?? "") || "data-tawd-icon" in c.attribs))
      .map((c) => html.slice(c.startIndex!, c.endIndex! + 1))
      .join("");
    cuts.push({ start: openEnd, end: closeStart, insert: `${icons}${FORM_CTA}` });
  });
  return { html: cuts.length ? applyCuts(html, cuts) : html, changed: cuts.length };
}

/*
  The phone's call to action (8 October 2026, Jason's comment 6: "Call about
  your address"): a link styled as a button that calls says "Call" and the
  number, as the intake writes it. Icons kept. Returns how many changed.
*/
const digitsOf = (text: string) => text.replace(/\D+/g, "");

export function unifyCallButtons(html: string, phones: string[]): { html: string; changed: number } {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const cuts: Cut[] = [];
  let buttons = 0;
  walk(doc.children, (el) => {
    if (el.name !== "a" || el.startIndex == null || el.endIndex == null) return;
    const href = el.attribs.href ?? "";
    if (!/^tel:/i.test(href) || !/\b(btn|button|cta)\b/i.test(el.attribs.class ?? "")) return;
    const words = plain(textOf(el));
    const number = digitsOf(href).slice(-10);
    // Already shows the number ("Call (916) 235-7878", or the number alone): left as it is.
    if (number.length >= 7 && digitsOf(words).endsWith(number)) return;
    // A link with no number in it (an empty "tel:") dials nothing: it gets the business number in its link too (13 October 2026, the whole-code review).
    const empty = number.length < 7;
    const written = words.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? null;
    const shown = empty ? (phones[0] ?? written) : (phones.find((p) => digitsOf(p).endsWith(number)) ?? written);
    if (!shown) return;
    const openEnd = html.indexOf(">", el.startIndex) + 1;
    const closeStart = el.endIndex + 1 - "</a>".length;
    if (openEnd <= 0 || html.slice(closeStart, el.endIndex + 1).toLowerCase() !== "</a>") return;
    const icons = el.children
      .filter((c): c is Element => isElement(c) && (c.name === "svg" || /\bicon\b/.test(c.attribs.class ?? "") || "data-tawd-icon" in c.attribs))
      .map((c) => html.slice(c.startIndex!, c.endIndex! + 1))
      .join("");
    if (empty) {
      // The attribute itself, after a space: never the end of "data-href" (CodeRabbit, PR #11).
      const at = /(\s)href\s*=\s*(["'])tel:[^"']*\2/i.exec(html.slice(el.startIndex, openEnd));
      // The intake's own tap-to-call form: a US number as +1, any other as written (CodeRabbit, PR #11).
      const dial = phoneHref(shown);
      if (!at || !dial) return;
      const start = el.startIndex + at.index + at[1]!.length;
      cuts.push({ start, end: el.startIndex + at.index + at[0].length, insert: `href="${escapeAttr(dial)}"` });
    }
    cuts.push({ start: openEnd, end: closeStart, insert: `${icons}Call ${escapeAttr(shown)}` });
    buttons += 1;
  });
  return { html: cuts.length ? applyCuts(html, cuts) : html, changed: buttons };
}

/* ---------- a reviews band with nothing real in it ---------- */

const REVIEWS_HEADING = /\b(reviews?|testimonials?|customers? say|what (?:our )?(?:clients|customers|neighbou?rs) say)\b/i;

/*
  A reviews band that only asks for reviews (8 October 2026: the wireframe's
  Reviews section held a [PLACEHOLDER], and Jason removed it by hand): no
  fake reviews is a house rule, and a hollow band says nothing, so it goes.
  Only when, apart from its heading, it holds nothing but placeholders for
  reviews and a few words (13 October 2026, the whole-code review): a band
  with any other placeholder ("[PLACEHOLDER: Google Business Profile link]")
  keeps it visible for the go-live check, and a band with a customer's
  words (quoted, or more than a short line) stays.
*/
// A placeholder for reviews themselves; one for a link or a profile (where the reviews are) is information still owed, and keeps the band.
const REVIEW_PLACEHOLDER = /\[PLACEHOLDER:?(?![^\]]*\b(?:links?|url|profiles?|page|address)\b)[^\]]*\b(?:reviews?|testimonials?|ratings?)\b[^\]]*\]/gi;
// A customer's words in quotes: double quotes anywhere, single quotes only as a pair (never an apostrophe).
const QUOTED = /["“”]|(?:^|[\s(])['‘][^'‘’]{2,}['’](?=$|[\s.,!?)])/;
const HOLLOW_WORDS = 12;

export function dropHollowReviews(html: string, options: { keepToConfirm?: boolean } = {}): { html: string; dropped: number } {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const cuts: Cut[] = [];
  walk(doc.children, (el) => {
    if (el.name !== "section" || el.startIndex == null || el.endIndex == null) return;
    if (cuts.some((c) => c.start <= el.startIndex! && c.end >= el.endIndex! + 1)) return;
    let heading = "";
    walk(el.children, (h) => {
      if (!heading && /^h[1-3]$/.test(h.name)) heading = plain(textOf(h));
    });
    if (!REVIEWS_HEADING.test(heading)) return;
    const text = plain(textOf(el));
    if (!/\[PLACEHOLDER/i.test(text)) return;
    // The current site shows ratings (5 November 2026): its band stays, with the rating to confirm with the client.
    if (options.keepToConfirm && /\[PLACEHOLDER:[^\]]*\bconfirm with the client\b/i.test(text)) return;
    const rest = plain(text.replace(heading, " ").replace(REVIEW_PLACEHOLDER, " "));
    if (/\[PLACEHOLDER/i.test(rest) || QUOTED.test(rest) || (rest.match(/\S+/g)?.length ?? 0) > HOLLOW_WORDS) return;
    cuts.push({ start: el.startIndex, end: el.endIndex + 1, insert: "" });
  });
  return { html: cuts.length ? applyCuts(html, cuts) : html, dropped: cuts.length };
}

/* ---------- small labels above headings ---------- */

const LABEL_CLASS = /\b(kicker|eyebrow|overline|pre-?title|section-label|section-tag|tagline-small|label-small)\b/i;

/* The small labels in each <section>, by its position among the page's sections: for the check "at most one per band". */
export function bandLabels(html: string): { band: number; labels: string[] }[] {
  const doc = parseDocument(html, { lowerCaseAttributeNames: true });
  const out: { band: number; labels: string[] }[] = [];
  let band = 0;
  walk(doc.children, (el) => {
    if (el.name !== "section") return;
    band += 1;
    const labels: string[] = [];
    walk(el.children, (child) => {
      if (LABEL_CLASS.test(child.attribs.class ?? "")) labels.push(plain(textOf(child)));
    });
    out.push({ band, labels });
  });
  return out;
}

/* ---------- repeated labels ---------- */

/* The small label above the first heading on the page, when it only says the business's name. */
export function dropNameLabel(html: string, businessName: string): { html: string; dropped: boolean } {
  const name = plain(businessName).toLowerCase();
  if (name.length < 3) return { html, dropped: false };
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  let cut: Cut | null = null;
  walk(doc.children, (el) => {
    if (cut || el.startIndex == null || el.endIndex == null) return;
    if (!/\b(kicker|eyebrow|overline|tagline-small|pre-?title)\b/i.test(el.attribs.class ?? "")) return;
    if (plain(textOf(el)).toLowerCase() !== name) return;
    cut = { start: el.startIndex, end: el.endIndex + 1, insert: "" };
  });
  return cut ? { html: applyCuts(html, [cut]), dropped: true } : { html, dropped: false };
}
