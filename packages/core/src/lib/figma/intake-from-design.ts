import type { FigmaFile, FigmaNode } from "./api";
import { findNode } from "./design-review";
import { visibleTree } from "./visible";
import type { PrefillKey } from "../intake/prefill-fields";

/*
  "Pre-fill the intake from the design" (Lane 2): the business facts the
  designer already typed into the Figma frames, read by plain text
  matching from the file saved at import. No Figma read and no AI.

  Every value comes with the text it was read from, so the PM can see why.
  Nothing is guessed: a value is proposed only when a pattern clearly
  matches, and placeholders like "[license]" are never taken as facts.
*/

export { PREFILL_KEYS, PREFILL_LABELS, SITE_ONLY_PREFILL_KEYS, type PrefillKey } from "../intake/prefill-fields";

export type PrefillValue =
  | string
  | number
  | string[]
  | { name: string; description: string }[]
  | { name: string; phone: string; streetAddress: string; city: string; state: string }[];

export interface PrefillProposal {
  key: PrefillKey;
  value: PrefillValue;
  /** The design's text the value was read from. */
  from: string;
}

interface DesignText {
  text: string;
  frame: string;
  isHome: boolean;
  x: number;
  y: number;
  /** The text's box (0 when the file gives no size). */
  w: number;
  h: number;
  size: number;
  weight: number;
  /** The text's containers, nearest first. */
  parents: FigmaNode[];
}

/* Every visible text layer of the final frames, homepage first, in reading order. */
function designTexts(file: FigmaFile, frames: { id: string; name: string; isHome: boolean }[]): DesignText[] {
  const out: DesignText[] = [];
  const ordered = [...frames].sort((a, b) => Number(b.isHome) - Number(a.isHome));
  for (const frame of ordered) {
    const found = findNode(file.document, frame.id);
    const node = found ? visibleTree(found) : null;
    if (!node) continue;
    const origin = node.absoluteBoundingBox ?? { x: 0, y: 0 };
    const visit = (n: FigmaNode, parents: FigmaNode[]) => {
      if (n.visible === false) return;
      if (n.type === "TEXT") {
        const text = (n.characters ?? "").replace(/\s+/g, " ").trim();
        const box = n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
        if (text) {
          out.push({
            text,
            frame: frame.name,
            isHome: frame.isHome,
            x: box.x - origin.x,
            y: box.y - origin.y,
            w: box.width ?? 0,
            h: box.height ?? 0,
            size: n.style?.fontSize ?? 16,
            weight: n.style?.fontWeight ?? 400,
            parents,
          });
        }
        return;
      }
      for (const child of n.children ?? []) visit(child, [n, ...parents]);
    };
    for (const child of node.children ?? []) visit(child, [node]);
  }
  return out;
}

const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const STREET =
  /\b\d{1,6}\s+(?:[A-Z0-9][\w.'-]*\s+){0,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Hwy|Highway|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle)\b\.?(?:,?\s*(?:Suite|Ste\.?|Unit|#)\s*[\w-]+)?/;
const STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const CITY_STATE = new RegExp(`\\b([A-Z][a-z]+(?:[ '-][A-Z][a-z]+){0,3}),\\s*(${STATES})\\b`);
const LICENSE = [
  /\b(?:lic(?:ense)?\.?|cslb|license\s*(?:no\.?|number))\s*(?:[A-Z]-?\d{1,3}\s*)?(?:#|no\.?)?\s*:?\s*([A-Z]{0,3}-?\d[\dA-Z-]{3,})/i,
  /\bC-\d{2}\s*#\s*(\d{5,8})\b/,
];
const YEAR = /\b(?:since|est\.?|established(?:\s+in)?|founded(?:\s+in)?)\s+((?:18|19|20)\d{2})\b/i;
const NAV_WORDS = /^(home|services?|about( us)?|areas?|service areas|contact( us)?|reviews?|faq|blog|gallery|projects|menu|book now|call now|get a quote)$/i;
const SERVICES_HEADING = /^(our\s+)?services$|^what we do$|^how we (can )?help$|^our work$/i;
const AREAS_LINE = /\b(?:serving|proudly serving|service areas?:?|areas we serve:?|we serve)\s+(.+)/i;
const AREAS_HEADING = /^(service areas|areas we serve|where we work|areas served)$/i;

const phoneText = (m: RegExpExecArray) => `(${m[1]}) ${m[2]}-${m[3]}`;
const digitsOf = (m: RegExpExecArray) => `${m[1]}${m[2]}${m[3]}`;

const TOWN = /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2}$/;
const CALL_WORDS = /^(?:(?:call|phone|tel|text|office|location|us|now|at)\b[\s:]*)+/i;

/* The town just before a phone in the same text: "Bishop: 760-555-0142", "| Winnemucca 775-...". */
function townBefore(text: string): string | null {
  const tail = /([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2})[\s:–—-]*\(?$/.exec(text.replace(/[|·•,]+/g, " ").trimEnd());
  const name = tail?.[1]?.replace(CALL_WORDS, "").trim();
  return name && TOWN.test(name) && !NAV_WORDS.test(name) && !/^(?:call|phone|tel|text|office|fax|cell|mobile|main|emergency|toll free)$/i.test(name) ? name : null;
}

/*
  A button's or a link's whole label, never a town, a service or its words
  ("Schedule Online", "Message", "Request an Estimate", "Learn more"). The
  whole line must be the label: a word such as "view" or "sign" inside a
  real name ("Mountain View", "Sign Installation") or a sentence ("Get your
  drains flowing again today.") is not a button (Fable's review of #85).
*/
const BUTTON_LABEL =
  /^(?:learn more|read more|view more|see more|see all|view all|find out more|more info|more|details|view details|click here|(?:view|see)(?: all)?(?: our)? services?|our story|about us|schedule(?: online| now| service| today| (?:an? )?appointment)?|book(?: now| online| today| (?:an? )?appointment)?|request (?:a |an )?(?:free )?(?:quote|estimate|service|appointment)|get (?:a |an |your )?(?:free )?(?:quote|estimate)|(?:free|instant) (?:quote|estimate)|get started|get directions|directions|message(?: us)?|email us|send(?: (?:a )?message)?|submit|call (?:us|now|today)(?: today| now)?|contact(?: us)?(?: today| now)?|pay(?: online| now| your bill)?|apply(?: now)?|sign up|subscribe|online|order now|shop now)[\s.!>→›»]*$/i;
const isButtonLabel = (text: string) => BUTTON_LABEL.test(text.trim());

/*
  A short town-like line beside the phone in its own block: in the phone's
  column and at most a few lines above it ("Bishop" over "760-205-6540"),
  or on the same line just to its left or right. Found on the Pat Rivera
  read (E0(c), 13 November 2026): the nearest line by height alone was a
  button on the same row ("Schedule Online"), so position across the page
  counts too, and a button's label is never a town.
*/
/*
  `taken`: towns already paired with another number. A town belongs to one
  number only, so in an evenly spaced row ("530-555-0100 Reno 760-555-0111
  Bishop", the gap to the town on either side the same) a number can't take
  the previous number's town (Fable's second re-read).
*/
function townInBlock(block: DesignText[], phoneText: DesignText, taken: Set<DesignText> = new Set()): DesignText | null {
  const lineHeight = Math.max(phoneText.h, phoneText.size, 8);
  const inColumn = (t: DesignText) => phoneText.w > 0 && t.w > 0 && t.x < phoneText.x + phoneText.w && t.x + t.w > phoneText.x;
  const above = (t: DesignText) => t.y <= phoneText.y + lineHeight / 2 && phoneText.y - t.y <= lineHeight * 3;
  const sameLine = (t: DesignText) => Math.abs(t.y - phoneText.y) <= lineHeight / 2 && t.w > 0;
  const justLeft = (t: DesignText) => sameLine(t) && t.x + t.w <= phoneText.x && phoneText.x - (t.x + t.w) <= lineHeight * 3;
  const justRight = (t: DesignText) => sameLine(t) && t.x >= phoneText.x + phoneText.w && t.x - (phoneText.x + phoneText.w) <= lineHeight * 3;
  const candidates = block
    .filter((t) => t !== phoneText && !taken.has(t) && t.text.length <= 30 && !/\d/.test(t.text) && TOWN.test(t.text) && !NAV_WORDS.test(t.text) && !isButtonLabel(t.text))
    // A file that gives no box sizes can't be judged by column: the nearest line then, as before.
    .filter((t) => phoneText.w === 0 || (inColumn(t) && above(t)) || justLeft(t) || justRight(t))
    /*
      The closest by the gap between them: on the same line, the space between
      the two boxes' edges, so in "530-555-0100 Reno · 760-555-0111 Bishop"
      each number takes the town touching it, not the one before it (Fable's
      re-read); above, the height between them. Without box sizes, as before.
    */
    .sort((a, b) => gap(a) - gap(b));
  function gap(t: DesignText): number {
    if (phoneText.w === 0) return Math.abs(phoneText.y - t.y) + Math.abs(phoneText.x - t.x) / 4;
    if (sameLine(t)) return t.x >= phoneText.x + phoneText.w ? t.x - (phoneText.x + phoneText.w) : phoneText.x - (t.x + t.w);
    return phoneText.y - t.y;
  }
  return candidates[0] ?? null;
}

/* A bit of text that can only be a placeholder or an instruction, never a fact. */
const isPlaceholder = (text: string) => /\[[^\]]*\]|lorem ipsum|placeholder|xxx/i.test(text);

function splitList(text: string): string[] {
  return text
    .replace(/\b(?:since|for over|for)\b.*$/i, "")
    .split(/,|•|·|\||;|\band\b|&/)
    .map((part) => part.replace(/[.!]+$/, "").trim())
    .filter((part) => /^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}$/.test(part) && !NAV_WORDS.test(part));
}

export function prefillFromDesign(
  file: FigmaFile,
  frames: { id: string; name: string; isHome: boolean }[],
): PrefillProposal[] {
  const texts = designTexts(file, frames).filter((t) => !isPlaceholder(t.text) || /\d/.test(t.text));
  const proposals: PrefillProposal[] = [];
  const propose = (key: PrefillKey, value: PrefillValue, from: string) => {
    if (!proposals.some((p) => p.key === key)) proposals.push({ key, value, from });
  };
  const first = (pattern: RegExp) => {
    for (const t of texts) {
      const m = pattern.exec(t.text);
      if (m) return { m, t };
    }
    return null;
  };

  /* Phone, email. */
  const phone = first(PHONE);
  if (phone) propose("business.phone", phoneText(phone.m), phone.t.text);
  const email = first(EMAIL);
  if (email) propose("business.email", email.m[0], email.t.text);

  /*
    Other locations: every further phone number with a town next to it
    ("Bishop 760-555-0142", or a town and street in the same block). The
    first phone is the main one; a phone with no town beside it is left out.
  */
  if (phone) {
    const seen = new Set([digitsOf(phone.m)]);
    const blockOf = (t: DesignText) => texts.filter((other) => other.parents[0] === t.parents[0]);
    // The main number's own town is taken first, so the next number in its row can't claim it.
    const mainTown = townInBlock(blockOf(phone.t), phone.t);
    const taken = new Set<DesignText>(mainTown ? [mainTown] : []);
    const locations: { name: string; phone: string; streetAddress: string; city: string; state: string }[] = [];
    const sources: string[] = [];
    for (const t of texts) {
      let previousEnd = 0;
      for (const m of t.text.matchAll(new RegExp(PHONE.source, "g"))) {
        const exec = m as unknown as RegExpExecArray;
        const digits = digitsOf(exec);
        const before = t.text.slice(previousEnd, m.index);
        previousEnd = m.index! + m[0].length;
        if (seen.has(digits)) continue;
        const block = blockOf(t);
        const cityState = block.map((b) => CITY_STATE.exec(b.text)).find(Boolean);
        const inText = townBefore(before);
        const town = inText ? null : townInBlock(block, t, taken);
        const name = inText ?? town?.text ?? null;
        if (!name && !cityState) continue;
        seen.add(digits);
        if (town) taken.add(town);
        const street = block.map((b) => STREET.exec(b.text)).find(Boolean);
        locations.push({
          name: name ?? cityState![1]!,
          phone: phoneText(exec),
          streetAddress: street ? street[0].replace(/\s+/g, " ").trim() : "",
          city: cityState?.[1] ?? name ?? "",
          state: cityState?.[2] ?? "",
        });
        sources.push(t.text);
      }
    }
    if (locations.length > 0) propose("business.locations", locations.slice(0, 20), [...new Set(sources)].join(" / "));
  }

  /* Street address, then the city and state after it, or a "City, ST" line anywhere. */
  const street = first(STREET);
  if (street) {
    propose("business.streetAddress", street.m[0].replace(/\s+/g, " ").trim(), street.t.text);
    const rest = CITY_STATE.exec(street.t.text.slice(street.m.index + street.m[0].length));
    if (rest) {
      propose("business.city", rest[1]!, street.t.text);
      propose("business.state", rest[2]!, street.t.text);
    }
  }
  const cityState = first(CITY_STATE);
  if (cityState) {
    propose("business.city", cityState.m[1]!, cityState.t.text);
    propose("business.state", cityState.m[2]!, cityState.t.text);
  }

  /* License: needs a digit, so "[license]" never counts. */
  for (const pattern of LICENSE) {
    const license = first(pattern);
    if (license && /\d/.test(license.m[1]!)) {
      propose("business.licenseNumbers", [license.m[1]!.replace(/^#/, "")], license.t.text);
      break;
    }
  }

  /* Year founded, only with words that say so ("since 1987"), never any year on the page. */
  const year = first(YEAR);
  if (year) {
    const value = Number(year.m[1]);
    if (value >= 1800 && value <= new Date().getFullYear()) propose("business.yearFounded", value, year.t.text);
  }

  /*
    The business name: the copyright line; else a footer line that also
    carries the phone ("Name · Town · phone"), its first part; else the
    leftmost text in the homepage header that is not the menu or the phone.
  */
  const copyright = first(/©\s*(?:\d{4}\s*)?([^|·•\n]+?)(?:\s*\d{4})?(?:\.|\s*[|·•]|\s*all rights reserved|$)/i);
  const footerLine = texts.find((t) => /[·•|]/.test(t.text) && PHONE.test(t.text));
  const header = texts
    .filter((t) => t.isHome && t.y < 160 && t.text.length >= 3 && t.text.length <= 60)
    .filter((t) => !NAV_WORDS.test(t.text) && !PHONE.test(t.text) && !EMAIL.test(t.text) && !isPlaceholder(t.text))
    .sort((a, b) => a.x - b.x)[0];
  if (copyright && copyright.m[1]!.trim().length >= 3 && /[A-Za-z]/.test(copyright.m[1]!)) {
    propose("business.name", copyright.m[1]!.trim().replace(/[.,]$/, ""), copyright.t.text);
  } else if (footerLine) {
    const name = footerLine.text.split(/[·•|]/)[0]!.trim();
    if (name.length >= 3 && !PHONE.test(name)) propose("business.name", name, footerLine.text);
  }
  if (header) propose("business.name", header.text, header.text);

  /*
    Services: the titles under a "Services" heading, each with the words
    beneath it.

    E0(c), 13 November 2026, from the Pat Rivera read: "Our Services" was a
    button at the foot of another band (beside "Our Story"), picked for being
    the largest match, and every bold line of that band became a "service".
    So: a heading counts only when titles sit below it (or on its own row, to
    its right: a heading beside a grid of cards); the titles are the largest
    group of lines sharing one size and weight, bold groups first, so the
    band's single big headline is not one and plain description lines never
    outrank bold titles; a button's label ("Learn more") is never a title;
    and a title's description is the lines straight beneath it in its own
    column (left-aligned or centred). A heading with fewer than two titles
    proposes nothing.
  */
  const servicesUnder = (heading: DesignText): { name: string; description: string }[] => {
    const area = heading.parents[0]!;
    const inArea = texts.filter((t) => t !== heading && t.parents.includes(area));
    if (inArea.length === 0) return [];
    const body = Math.min(...inArea.map((t) => t.size));
    const headingLine = Math.max(heading.h, heading.size, 8);
    const afterHeading = (t: DesignText) => t.y > heading.y + headingLine / 2 || (Math.abs(t.y - heading.y) <= headingLine / 2 && heading.w > 0 && t.x >= heading.x + heading.w);
    const candidates = inArea.filter(
      (t) =>
        afterHeading(t) &&
        (t.weight >= 600 || t.size > body) &&
        t.text.length <= 50 &&
        !NAV_WORDS.test(t.text) &&
        !isButtonLabel(t.text) &&
        !PHONE.test(t.text) &&
        // A street address or a "City, ST" line is a location, not a service (a footer's Locations column beside its Services).
        !STREET.test(t.text) &&
        !CITY_STATE.test(t.text) &&
        !isPlaceholder(t.text),
    );
    const groups = new Map<string, DesignText[]>();
    for (const t of candidates) {
      const key = `${t.weight >= 600 ? "bold" : "plain"}|${t.size}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    const chosen =
      [...groups.entries()]
        .filter(([, group]) => group.length >= 2)
        .sort((a, b) => Number(b[0].startsWith("bold")) - Number(a[0].startsWith("bold")) || b[1].length - a[1].length)[0]?.[1] ?? [];
    // A title on the heading's own row counts only as the top of a grid: another title sits below it in the same column (Fable's re-read: a lone bold "Call Bob Today" beside the heading is not a service).
    const onHeadingRow = (t: DesignText) => Math.abs(t.y - heading.y) <= headingLine / 2;
    const titles = chosen.filter((t) => !onHeadingRow(t) || chosen.some((o) => o !== t && !onHeadingRow(o) && Math.abs(o.x - t.x) <= headingLine));
    const sized = titles.every((t) => t.w > 0);
    return titles.slice(0, 12).map((title) => {
      if (!sized) {
        // A file without box sizes: the first other text in the title's own block, as before.
        const description = inArea.find((t) => t !== title && !titles.includes(t) && t.parents[0] === title.parents[0] && !isButtonLabel(t.text));
        return { name: title.text, description: description?.text ?? "" };
      }
      const lineHeight = Math.max(title.h, title.size, 8);
      // Its own column, never the next card's: a line starting at the title's left edge or within its left half, or one centred on the title.
      const leftAligned = (t: DesignText) => t.x >= title.x - lineHeight * 2 && t.x <= title.x + title.w / 2;
      const centred = (t: DesignText) => Math.abs(t.x + t.w / 2 - (title.x + title.w / 2)) <= lineHeight;
      const column = (t: DesignText) => t.w > 0 && (leftAligned(t) || centred(t));
      const under = inArea
        .filter((t) => t !== title && !titles.includes(t) && t.y > title.y && column(t) && !isButtonLabel(t.text))
        .sort((a, b) => a.y - b.y);
      // The first line within a few lines of the title, then the lines that follow it in the same style.
      const lines: DesignText[] = [];
      for (const t of under) {
        const previous = lines[lines.length - 1];
        if (!previous) {
          if (t.y - title.y > lineHeight * 3) break;
          lines.push(t);
          continue;
        }
        if (t.size !== previous.size || t.weight !== previous.weight || t.y - previous.y > Math.max(previous.h, previous.size) * 1.8) break;
        lines.push(t);
      }
      return { name: title.text, description: lines.map((l) => l.text).join(" ") };
    });
  };
  // Every "Services" heading, biggest first; the first with titles below it. Never the menu link of the same name.
  for (const heading of texts.filter((t) => SERVICES_HEADING.test(t.text)).sort((a, b) => b.size - a.size || b.weight - a.weight)) {
    const items = servicesUnder(heading);
    if (items.length >= 2) {
      propose("services.items", items, `${heading.text}: ${items.map((i) => i.name).join(", ")}`);
      break;
    }
  }

  /* Service areas: a "Serving ..." line, or the short names under an areas heading. */
  const areasLine = first(AREAS_LINE);
  const fromLine = areasLine ? splitList(areasLine.m[1]!) : [];
  if (areasLine && fromLine.length > 0) {
    propose("serviceAreas.cities", fromLine, areasLine.t.text);
  } else {
    const areasHeading = texts.find((t) => AREAS_HEADING.test(t.text));
    if (areasHeading) {
      const area = areasHeading.parents[0]!;
      const names = texts
        .filter((t) => t !== areasHeading && t.parents.includes(area))
        .flatMap((t) => splitList(t.text));
      if (names.length > 0) propose("serviceAreas.cities", [...new Set(names)].slice(0, 30), `${areasHeading.text}: ${names.join(", ")}`);
    }
  }

  return proposals;
}
