import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/*
  A makeover's blog articles, built by code (Jason, 7 October 2026, 0.98.0):
  the first kept article is built by the AI with its words inside one
  element marked data-tawd-article; every other kept article is that page
  with the marked element's words swapped for its own, written from its
  kept Markdown here. No AI, so 100 articles cost what one does. The words
  check after the build (keptWordsCheck) still checks each one.

  The kept Markdown is keptMarkdown's (site-import.ts): # headings, plain
  paragraphs (a leading backslash escapes a mark), "> " quotes, "- " and
  "1. " lists, "| " table rows, and links as [text](path).
*/

export const ARTICLE_SLOT_ATTR = "data-tawd-article";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The marked element in a page's <main>: where its inner HTML starts and ends, or null. */
function slotOf(main: string): { tag: string; innerStart: number; innerEnd: number } | null {
  const doc = parseDocument(main, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: true });
  const find = (nodes: ChildNode[]): Element | null => {
    for (const node of nodes) {
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      if (ARTICLE_SLOT_ATTR in el.attribs) return el;
      const inner = find(el.children);
      if (inner) return inner;
    }
    return null;
  };
  const el = find(doc.children);
  if (!el || el.startIndex == null || el.endIndex == null) return null;
  const openEnd = main.indexOf(">", el.startIndex);
  const close = `</${el.name}>`;
  const closeStart = el.endIndex + 1 - close.length;
  if (openEnd < 0 || main.slice(closeStart, el.endIndex + 1).toLowerCase() !== close) return null;
  return { tag: el.name, innerStart: openEnd + 1, innerEnd: closeStart };
}

/* A built article page TAWD can fill other articles into: exactly one marked element holding the article's one H1. */
export function hasArticleSlot(main: string): boolean {
  if ((main.match(new RegExp(`\\b${ARTICLE_SLOT_ATTR}\\b`, "g")) ?? []).length !== 1) return false;
  const slot = slotOf(main);
  if (!slot) return false;
  const inner = main.slice(slot.innerStart, slot.innerEnd);
  const outer = main.slice(0, slot.innerStart) + main.slice(slot.innerEnd);
  if (!/<h1\b/i.test(inner) || /<h1\b/i.test(outer)) return false;
  // Nothing of this article's own around the slot (a breadcrumb with its title would repeat on every article).
  const title = (/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(inner)?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const around = outer.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  return title.length > 0 && !around.includes(title);
}

/* The class the template gives each kind of element inside the article, so a filled article looks like the first. */
function classesOf(inner: string): Map<string, string> {
  const classes = new Map<string, string>();
  for (const m of inner.matchAll(/<(h1|h2|h3|h4|h5|h6|p|ul|ol|li|blockquote|table|tr|td|th|a)\b[^>]*?\bclass="([^"]*)"/gi)) {
    const tag = m[1]!.toLowerCase();
    if (!classes.has(tag)) classes.set(tag, m[2]!);
  }
  return classes;
}

/*
  A kept link's address is written only when it's a path on the site or an
  http(s), mailto or tel address; anything else (javascript: in any spelling,
  from a read saved before the reading side checked it) keeps its words and
  loses the link.
*/
function safeHref(href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try {
    return ["http:", "https:", "mailto:", "tel:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

/* Kept Markdown as HTML: the same blocks the AI was given, every word as written. */
export function keptMarkdownToHtml(markdown: string, classes: Map<string, string> = new Map()): string {
  const open = (tag: string, extra = "") => `<${tag}${classes.get(tag) ? ` class="${escapeHtml(classes.get(tag)!)}"` : ""}${extra}>`;
  const inline = (text: string) =>
    escapeHtml(text.trim())
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
        safeHref(href) ? `${open("a", ` href="${href.replace(/"/g, "%22")}"`)}${label.trim()}</a>` : label.trim(),
      )
      .replace(/\s{2,}/g, " ");
  const out: string[] = [];
  for (const block of markdown.replace(/\r/g, "").split(/\n{2,}/)) {
    const text = block.trim();
    if (!text) continue;
    const lines = text.split("\n");
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading && lines.length === 1) {
      const tag = `h${heading[1]!.length}`;
      out.push(`${open(tag)}${inline(heading[2]!)}</${tag}>`);
    } else if (lines.every((l) => /^[-*]\s+/.test(l))) {
      out.push(`${open("ul")}${lines.map((l) => `${open("li")}${inline(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`);
    } else if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      out.push(`${open("ol")}${lines.map((l) => `${open("li")}${inline(l.replace(/^\d+\.\s+/, ""))}</li>`).join("")}</ol>`);
    } else if (lines.every((l) => /^\|.*\|$/.test(l.trim()))) {
      const rows = lines.map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
      out.push(`${open("table")}<tbody>${rows.map((r) => `${open("tr")}${r.map((c) => `${open("td")}${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (lines.every((l) => /^>\s?/.test(l))) {
      out.push(`${open("blockquote")}${open("p")}${inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "))}</p></blockquote>`);
    } else {
      out.push(`${open("p")}${inline(lines.join(" ").replace(/^\\/, ""))}</p>`);
    }
  }
  return out.join("\n");
}

/* Another kept article in the first one's layout: the marked element's words replaced by this article's. */
export function fillArticle(templateMain: string, markdown: string): string {
  const slot = slotOf(templateMain);
  if (!slot) throw new Error("The article layout has no marked place for the words.");
  const classes = classesOf(templateMain.slice(slot.innerStart, slot.innerEnd));
  return `${templateMain.slice(0, slot.innerStart)}\n${keptMarkdownToHtml(markdown, classes)}\n${templateMain.slice(slot.innerEnd)}`;
}
