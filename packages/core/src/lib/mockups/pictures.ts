import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

import type { CheckIssue } from "./checks";
import { replaceSections, splitSections, type PageSection } from "./sections";
import { STOCK_FRAME_ATTR } from "./stock";

/*
  Pictures where they belong (Jason, 8 October 2026, Finley's concept B: no
  Shutterstock pictures in the first build, then one picture forced into
  "What sets us apart?" that the section didn't need).

  Code decides, free:
  - which bands may carry a stock picture, by what the band is (its heading):
    the hero, services, service areas, and a band about a problem or a job
    may; "why us", the process, FAQs, reviews, proof (licences,
    guarantees), contact and calls to action don't (a client's own photo
    still may; this is only about stock);
  - that every general-scene frame in a band that may carry one gets its
    stock phrase, so Shutterstock fills it (the model often left it off);
  - that the hero has a picture at all.
*/

export type BandKind =
  | "header"
  | "hero"
  | "services"
  | "area"
  | "about"
  | "why"
  | "process"
  | "faq"
  | "reviews"
  | "proof"
  | "contact"
  | "footer"
  | "other";

/* Bands where a stock scene helps. Everything else gets the client's own photos or none. */
export const STOCK_BAND_KINDS: ReadonlySet<BandKind> = new Set<BandKind>(["hero", "services", "area", "other"]);

const KIND_WORDS: [BandKind, RegExp][] = [
  ["faq", /\b(faqs?|questions|asked)\b/i],
  ["reviews", /\b(reviews?|testimonials?|customers? say|what (?:our )?(?:clients|customers|neighbou?rs) say|ratings?)\b/i],
  ["process", /\b(how (?:it|we|this) works?|our process|the process|steps?|what (?:to expect|happens)|in \d+ (?:easy |simple )?steps)\b/i],
  ["why", /\b(why|sets? us apart|the difference|choose us|our promise|our values|what makes)\b/i],
  ["about", /\b(about|our (?:team|story|family|crew|people)|meet|who we are)\b/i],
  ["proof", /\b(guarantee[sd]?|warrant(?:y|ies)|licen[cs]ed|insured|certified|accredit\w*|by the numbers)\b/i],
  ["area", /\b(areas?|service area|serving|we serve|locations?|near you|cities|neighbou?rhoods?|communities)\b/i],
  ["contact", /\b(contact|call (?:us|now|today)|get (?:a|your) (?:free )?(?:quote|estimate|inspection)|book|schedule|request|ready to|talk to)\b/i],
  ["services", /\b(services?|what we (?:do|treat|offer|fix)|solutions|treatments?|we (?:treat|handle|fix|install|repair))\b/i],
];

/* What the band is, from its tag, its classes and its first heading. */
export function bandKind(section: PageSection, heroIndex: number): BandKind {
  if (section.tag === "header" || section.tag === "nav") return "header";
  if (section.tag === "footer") return "footer";
  if (section.index === heroIndex) return "hero";
  const open = section.html.slice(0, section.html.indexOf(">") + 1);
  if (/\bclass\s*=\s*["'][^"']*\bhero\b/i.test(open)) return "hero";
  const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(section.html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
  for (const [kind, words] of KIND_WORDS) if (words.test(heading)) return kind;
  if (/<form\b/i.test(section.html)) return "contact";
  return "other";
}

/* The bands with their kinds; the hero is the first band after the header. */
export function bandKinds(html: string): { section: PageSection; kind: BandKind }[] {
  const sections = splitSections(html);
  const heroIndex = sections.find((s) => s.tag !== "header" && s.tag !== "nav")?.index ?? -1;
  return sections.map((section) => ({ section, kind: bandKind(section, heroIndex) }));
}

/* A frame for something only the client can supply: their people, premises, vehicles, work. */
const CLIENT_OWNED = /\b(our|team|owners?|founders?|crew|staff|employees|truck|van|vehicles?|fleet|shop|office|storefront|premises|building|logo|headshot|portrait)\b/i;

const FRAME_CLASS = /\b(photo-frame|photo-placeholder|image-placeholder|img-placeholder|placeholder-photo|placeholder-image)\b/i;
const LABEL = /^\s*(?:photo|picture|image)\s*:\s*/i;

function isElement(node: unknown): node is Element {
  return Boolean(node) && (node as Element).type === "tag";
}

function textOf(node: ChildNode): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  if (!isElement(node)) return "";
  if (node.name === "script" || node.name === "style") return "";
  return node.children.map(textOf).join(" ");
}

function hasPicture(el: Element, svgCounts = false): boolean {
  const walk = (n: ChildNode): boolean => {
    if (!isElement(n)) return false;
    if (n.name === "img" || n.name === "picture" || n.name === "video") return true;
    // An inline drawing is a picture to the go-live check; the stock-photo filler still treats a frame with only an svg as fillable.
    if (svgCounts && n.name === "svg") return true;
    return n.children.some(walk);
  };
  return el.children.some(walk) || /tawd-asset:|url\(/i.test(el.attribs.style ?? "");
}

function walkElements(nodes: ChildNode[], visit: (el: Element) => void) {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    visit(n);
    walkElements(n.children, visit);
  }
}

/*
  Every labeled placeholder frame left in a page (F-036), stock-search ones
  included: the text of each ("Photo: technician inspecting under a kitchen
  sink"). The go-live check uses it, because a built site must not go live
  with a grey box saying "Photo: ..." where a picture belongs.
*/
export function labelledPhotoFrames(html: string): string[] {
  const doc = parseDocument(html, { lowerCaseAttributeNames: true });
  const found: string[] = [];
  const visit = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.name === "script" || n.name === "style") continue;
      if ((n.name === "div" || n.name === "figure") && !hasPicture(n, true)) {
        const text = textOf(n).replace(/\s+/g, " ").trim();
        const classed = FRAME_CLASS.test(n.attribs.class ?? "");
        // A frame with real copy in it is a card, not a picture frame (same rule as frameLabel).
        if ((classed || LABEL.test(text)) && text.length <= 120) {
          found.push(text || "(empty photo frame)");
          continue;
        }
      }
      visit(n.children);
    }
  };
  visit(doc.children);
  return found;
}

/* A labeled placeholder frame: a div or figure saying "Photo: ...", or with a frame class, and no picture in it. */
function frameLabel(el: Element): string | null {
  if (el.name !== "div" && el.name !== "figure") return null;
  if (STOCK_FRAME_ATTR in el.attribs || hasPicture(el)) return null;
  const text = textOf(el).replace(/\s+/g, " ").trim();
  const classed = FRAME_CLASS.test(el.attribs.class ?? "");
  if (!classed && !LABEL.test(text)) return null;
  // A frame with real copy in it is a card, not a picture frame.
  if (text.length > 120) return null;
  return text.replace(LABEL, "").trim() || null;
}

/* A short stock search phrase from a frame's label: plain words, at most six. */
export function phraseFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "of", "with", "and", "in", "on", "at", "for"].includes(w))
    .slice(0, 6)
    .join(" ");
}

interface BandEdit {
  html: string;
  removed: number;
  added: number;
}

/* One band's picture fixes, as text surgery by source position (last first). */
function fixBand(bandHtml: string, mayHaveStock: boolean, stockAvailable: boolean): BandEdit {
  const doc = parseDocument(bandHtml, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const cuts: { start: number; end: number; insert: string }[] = [];
  let removed = 0;
  let added = 0;
  let stockInBand = 0;

  walkElements(doc.children, (el) => {
    if (STOCK_FRAME_ATTR in el.attribs) stockInBand += 1;
  });

  walkElements(doc.children, (el) => {
    if (el.startIndex == null || el.endIndex == null) return;
    if (STOCK_FRAME_ATTR in el.attribs && !mayHaveStock) {
      // A stock scene where the band doesn't need one: the frame goes.
      if (cuts.some((c) => c.start <= el.startIndex! && c.end >= el.endIndex! + 1)) return;
      cuts.push({ start: el.startIndex, end: el.endIndex + 1, insert: "" });
      removed += 1;
      return;
    }
    if (!mayHaveStock || !stockAvailable || stockInBand > 0) return;
    const label = frameLabel(el);
    if (!label || CLIENT_OWNED.test(label)) return;
    const phrase = phraseFromLabel(label);
    if (phrase.split(" ").length < 2) return;
    // The opening tag gains the phrase; one stock frame per band.
    const tagEnd = bandHtml.indexOf(">", el.startIndex);
    if (tagEnd < 0) return;
    const selfClosing = bandHtml[tagEnd - 1] === "/";
    const at = selfClosing ? tagEnd - 1 : tagEnd;
    cuts.push({ start: at, end: at, insert: ` ${STOCK_FRAME_ATTR}="${phrase}"` });
    added += 1;
    stockInBand += 1;
  });

  let out = bandHtml;
  for (const cut of cuts.sort((a, b) => b.start - a.start)) out = out.slice(0, cut.start) + cut.insert + out.slice(cut.end);
  return { html: out, removed, added };
}

export interface PictureFixes {
  html: string;
  fixed: string[];
}

/* Every band's picture fixes. Free and repeatable: running it twice changes nothing more. */
export function fixPictures(html: string, options: { stockAvailable: boolean }): PictureFixes {
  const bands = bandKinds(html);
  const replacements = new Map<number, string>();
  let removed = 0;
  let added = 0;
  for (const { section, kind } of bands) {
    if (kind === "header" || kind === "footer") continue;
    const edit = fixBand(section.html, STOCK_BAND_KINDS.has(kind), options.stockAvailable);
    if (edit.html !== section.html) replacements.set(section.index, edit.html);
    removed += edit.removed;
    added += edit.added;
  }
  if (replacements.size === 0) return { html, fixed: [] };
  const fixed = [
    ...(removed ? [`took out ${removed} stock picture${removed === 1 ? "" : "s"} from sections that don't need one`] : []),
    ...(added ? [`asked Shutterstock for ${added} empty picture frame${added === 1 ? "" : "s"}`] : []),
  ];
  return { html: replaceSections(html, splitSections(html), replacements), fixed };
}

/* The checks: what fixPictures would change (fixed by code), and a hero without a picture (an AI round). */
export function checkPictures(html: string, options: { stockAvailable: boolean }): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const bands = bandKinds(html);
  for (const { section, kind } of bands) {
    if (kind === "header" || kind === "footer") continue;
    const edit = fixBand(section.html, STOCK_BAND_KINDS.has(kind), options.stockAvailable);
    if (edit.removed > 0) {
      issues.push({ id: "images.stockOutOfPlace", severity: "fail", message: `Band ${section.index} (${kind}) has a stock picture it doesn't need; stock goes only in the hero, services, service areas and job bands.`, where: String(section.index) });
    }
    if (edit.added > 0) {
      issues.push({ id: "images.frameWithoutStock", severity: "fail", message: `Band ${section.index} has an empty picture frame with no stock phrase, so it would stay an empty box.`, where: String(section.index) });
    }
  }
  // Only a real band (a section or a wrapper) is a hero; a bare heading at the top of the body isn't.
  const hero = bands.find((b) => b.kind === "hero" && ["section", "div", "article", "main"].includes(b.section.tag));
  if (hero && !/<img\b|<picture\b|<video\b|tawd-asset:photo|background-image|data-tawd-photo/i.test(hero.section.html)) {
    issues.push({ id: "images.heroNoPicture", severity: "fail", message: "The hero has no picture. Give it the client's best photo or, without one, a stock scene frame of the trade at work." });
  }
  return issues;
}
