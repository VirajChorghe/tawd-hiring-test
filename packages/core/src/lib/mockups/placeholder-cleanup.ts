import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

import { isPicturePlaceholder, matchPlaceholders, type IntakeFact } from "./facts";

/*
  Placeholders only for what is required (Jason, 8 October 2026: "if no
  info has been added why does the mockup have it as a placeholder?").

  A [PLACEHOLDER: ...] is wanted only where a required intake field is
  empty. Anything else (an optional field the client left blank, or
  something the intake never asks, like "how often service visits happen")
  is left out, and code takes it out, free: the smallest part of the page
  that holds it and little else (a card, a list item, a line, or a whole
  band when the band says nothing else). A placeholder sitting inside
  real copy can't be cut out cleanly; it is left for the fix round.
*/

const PLACEHOLDER = /\[PLACEHOLDER:[^\]]*\]/gi;

/* Never climbed past: removing one of these would take the page's frame with it. */
const STOP_TAGS = new Set(["html", "body", "main", "header", "footer", "nav", "form"]);

/* What may sit beside a stray placeholder and go with it: a short label or heading. */
const MAX_OTHER_WORDS = 12;

/* A placeholder is wanted when it stands for a required intake field that is empty. */
export function isWantedPlaceholder(placeholder: string, facts: IntakeFact[]): boolean {
  return matchPlaceholders(placeholder, facts).some((m) => m.fact.tier === "required" && m.fact.value === null);
}

/*
  The page's placeholders that nothing required asks for, each once. One
  standing for something the intake does have is not stray: its own check
  puts the real value in, and removing it would take that value's place.
*/
export function strayPlaceholders(html: string, facts: IntakeFact[], confirmable: string[] = []): string[] {
  return [...new Set(visibleText(html).match(PLACEHOLDER) ?? [])].filter((p) => {
    if (isPicturePlaceholder(p)) return false;
    const matched = matchPlaceholders(p, facts);
    if (matched.some((m) => m.fact.value !== null)) return false;
    // A rating, licence or review the client's current site shows, waiting for the client's word (5 November 2026).
    if (/\bconfirm with the client\b/i.test(p) && matched.some((m) => confirmable.includes(m.fact.key))) return false;
    return !matched.some((m) => m.fact.tier === "required");
  });
}

function visibleText(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
}

function textOf(node: ChildNode): string {
  if (node.type === "text") return (node as unknown as { data: string }).data;
  if (node.type !== "tag" && node.type !== "root") return "";
  const el = node as Element;
  if (el.name === "script" || el.name === "style") return "";
  return el.children.map(textOf).join(" ");
}

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function isElement(node: unknown): node is Element {
  return Boolean(node) && (node as Element).type === "tag";
}

export interface PlaceholderCleanup {
  html: string;
  /** The placeholders taken out with the part of the page around them. */
  removed: string[];
  /** Stray placeholders inside real copy, left for the fix round. */
  left: string[];
}

export function removeStrayPlaceholders(html: string, facts: IntakeFact[], confirmable: string[] = []): PlaceholderCleanup {
  const stray = new Set(strayPlaceholders(html, facts, confirmable));
  if (stray.size === 0) return { html, removed: [], left: [] };

  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const ranges: [number, number][] = [];
  const removed = new Set<string>();
  const left = new Set<string>();

  const visit = (node: ChildNode) => {
    if (node.type === "text") {
      const found = ((node as unknown as { data: string }).data.match(PLACEHOLDER) ?? []).filter((p) => stray.has(p));
      if (found.length === 0) return;
      const target = enclosing(node);
      if (target && target.startIndex != null && target.endIndex != null) {
        ranges.push([target.startIndex, target.endIndex + 1]);
        found.forEach((p) => removed.add(p));
      } else {
        found.forEach((p) => left.add(p));
      }
      return;
    }
    if (isElement(node) && (node.name === "script" || node.name === "style")) return;
    if ("children" in node) (node as Element).children.forEach(visit);
  };
  doc.children.forEach(visit);

  /*
    The smallest-to-largest climb from the placeholder's element: keep going
    while what the element says besides placeholders is only a short label,
    it holds no wanted placeholder, and it isn't the page's frame. A band
    (a section) is the furthest it goes.
  */
  function enclosing(text: ChildNode): Element | null {
    let candidate: Element | null = null;
    let current: unknown = text.parent;
    while (isElement(current) && !STOP_TAGS.has(current.name)) {
      const inside = textOf(current);
      const placeholders = inside.match(PLACEHOLDER) ?? [];
      if (placeholders.some((p) => !stray.has(p))) break;
      if (words(inside.replace(PLACEHOLDER, " ")) > MAX_OTHER_WORDS) break;
      candidate = current;
      if (current.name === "section") break;
      current = current.parent;
    }
    return candidate;
  }

  // The outermost of any overlapping parts, cut from the end so earlier positions hold.
  const outer = ranges
    .sort((a, b) => a[0] - b[0] || b[1] - a[1])
    .filter((r, i, all) => !all.some((o, j) => j !== i && o[0] <= r[0] && o[1] >= r[1] && (o[0] !== r[0] || o[1] !== r[1] || j < i)));
  let out = html;
  for (const [start, end] of [...outer].sort((a, b) => b[0] - a[0])) out = out.slice(0, start) + out.slice(end);

  return { html: out, removed: [...removed], left: [...left].filter((p) => !removed.has(p)) };
}
