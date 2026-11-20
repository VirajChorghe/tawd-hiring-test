/*
  The menu of a homepage the team supplied as one HTML file (Jason, 17
  November 2026).

  A supplied homepage is the design the client approved, and its own menu
  says what the site's pages are. Before this, the page plan was made from
  the intake and the keywords alone and never looked at the design, so a
  plan could name pages the design does not have (and miss the ones it
  does), and the shared header's menu — which is written from the plan —
  then disagreed with the page kept underneath it.

  Jason's decision (option A, 17 November 2026): the menu's items become
  real pages, and the links in the kept page that pointed at a section of
  itself point at those pages instead.

  Everything here is code: no AI, no network. The file is a client's, so it
  is read as data, never run, and it is read with the same HTML parser the
  sanitiser uses. The first version of this module read it with regular
  expressions and claimed in this comment that they were linear; a review
  measured 28 seconds on a 240 KB file of `<a ` and hours on a full-sized
  upload, in the web app's own process. Nothing here scans the whole
  document with a pattern, nothing walks it by calling itself, and the one
  place a value is replaced finds it by walking a single tag's attributes.
*/

import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

import { scanOpenTag } from "./safe-html";

export interface NavLink {
  /** The words a visitor reads, e.g. "About Sarah". */
  label: string;
  /** The link's target as the file writes it: "#approach", "/about/", "#". */
  href: string;
}

export interface DeadLink {
  label: string;
  href: string;
}

/* Text inside these is not words a visitor reads as the link's name. */
const NOT_WORDS = new Set(["svg", "script", "style", "template", "noscript"]);

const isTag = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";

const parse = (html: string) => parseDocument(html, { withStartIndices: true, withEndIndices: true });

/*
  Every element of this name, in the order they open, however deeply nested.
  Walked with a stack of its own rather than by calling itself: a client's
  file can nest as deeply as it likes, and recursion would run the web app
  out of stack (CodeRabbit on #107).
*/
function allOf(nodes: ChildNode[], name: string): Element[] {
  const out: Element[] = [];
  const stack: ChildNode[] = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isTag(node)) continue;
    if (node.name === name) out.push(node);
    const children = node.children as ChildNode[];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  return out;
}

/* The words of a link: its text, with icons and scripts left out. The parser has already turned &amp;, &#39; and &#x27; into their characters. */
export function linkLabel(el: Element): string {
  const parts: string[] = [];
  const stack: ChildNode[] = [...(el.children as ChildNode[])].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "text") parts.push(node.data);
    else if (isTag(node) && !NOT_WORDS.has(node.name)) {
      const children = node.children as ChildNode[];
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
}

const hrefOf = (el: Element): string => (el.attribs.href ?? "").trim();

/* A link that is navigation inside this site, not an action, a decoration or somewhere else entirely. */
function isMenuLink(href: string, label: string): boolean {
  if (!label || !href) return false;
  // Another site, a phone, an email: never a page of this site.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return false;
  // The logo and a "skip to content" link are not menu items.
  if (href === "/" || href === "#main" || href === "#content") return false;
  return true;
}

/** The menu's own word for the home page ("Home", "Home page"), which is never a new page. */
export const isHomeLabel = (label: string): boolean => /^home(\s*page)?$/i.test(label.trim());

/*
  Where the href attribute's value sits inside one start tag, quotes and all,
  or null when the tag has none. The tag is walked attribute by attribute, so
  an href written inside another attribute's value — a title reading
  href="#old", say — is never mistaken for the link's own (CodeRabbit on
  #107, which found that one rewritten while the link itself stayed).
*/
function hrefSpan(html: string, tagStart: number, tagEnd: number): { start: number; end: number } | null {
  const space = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  let i = tagStart + 1;
  while (i < tagEnd && !space(html[i]) && html[i] !== "/" && html[i] !== ">") i += 1;
  while (i < tagEnd) {
    while (i < tagEnd && (space(html[i]) || html[i] === "/")) i += 1;
    if (i >= tagEnd || html[i] === ">") return null;
    const nameStart = i;
    while (i < tagEnd && !space(html[i]) && html[i] !== "=" && html[i] !== "/" && html[i] !== ">") i += 1;
    const name = html.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < tagEnd && space(html[j])) j += 1;
    // An attribute with no value at all ("hidden"): carry on from where its name ended.
    if (html[j] !== "=") continue;
    j += 1;
    while (j < tagEnd && space(html[j])) j += 1;
    const quote = html[j];
    let end: number;
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      end = close === -1 || close >= tagEnd ? tagEnd : close + 1;
    } else {
      end = j;
      while (end < tagEnd && !space(html[end]) && html[end] !== ">") end += 1;
    }
    if (name === "href") return { start: j, end };
    i = end;
  }
  return null;
}

/*
  The header's menu, in the order it is written. The <nav> element is the
  menu when there is one (a header also holds the logo and a call-to-action
  button, which are not pages); without one, the header's own links are
  read, minus the logo, the phone and the skip link.

  Two links to the same place are one menu item: a design often repeats its
  "Contact" item as a button, and each would otherwise become a page of its
  own. "#" is not a place, so items that point nowhere are all kept.
*/
export function headerNavLinks(header: string): NavLink[] {
  if (!header.trim()) return [];
  const doc = parse(header);
  const navs = allOf(doc.children as ChildNode[], "nav");
  const main = navs.find((n) => /^(main|primary)/i.test(n.attribs["aria-label"] ?? "")) ?? navs[0];
  const anchors = allOf(main ? (main.children as ChildNode[]) : (doc.children as ChildNode[]), "a");
  const links: NavLink[] = [];
  const seenLabel = new Set<string>();
  const seenHref = new Set<string>();
  for (const el of anchors) {
    const href = hrefOf(el);
    const label = linkLabel(el);
    if (!isMenuLink(href, label)) continue;
    const key = label.toLowerCase();
    if (seenLabel.has(key)) continue;
    if (href !== "#" && seenHref.has(href)) continue;
    seenLabel.add(key);
    seenHref.add(href);
    links.push({ label, href });
  }
  return links;
}

/*
  Which page now holds each menu item that pointed at a section of the home
  page: "#services" -> "/services/". Matched by the words of the link, which
  are the name the page plan gave the page, so a renamed page simply drops
  out rather than sending a visitor somewhere else. An item named "Home"
  points at the home page itself. "#" on its own points at nothing and is
  left for the dead-link check to report.
*/
export function anchorPaths(nav: NavLink[], pages: { name: string; slug: string }[]): Map<string, string> {
  const byName = new Map(pages.map((p) => [p.name.trim().toLowerCase(), p.slug]));
  const paths = new Map<string, string>();
  for (const link of nav) {
    if (!link.href.startsWith("#") || link.href === "#") continue;
    // The first item wins: two items pointing at one place must not send the same link to two pages.
    if (paths.has(link.href)) continue;
    if (isHomeLabel(link.label)) {
      paths.set(link.href, "/");
      continue;
    }
    const slug = byName.get(link.label.trim().toLowerCase());
    if (slug === undefined) continue;
    paths.set(link.href, slug ? `/${slug}/` : "/");
  }
  return paths;
}

/*
  The links in a kept page that pointed at one of its own sections now point
  at the page that holds it. Only an exact href is replaced ("#services",
  never "#services-intro"), only the href attribute of a real <a>, and
  nothing else in the page is touched. What was actually replaced is
  reported back, so the build's checklist says what happened to this page
  rather than what the menu would allow.
*/
export function rewriteAnchors(html: string, paths: Map<string, string>): { html: string; moved: string[] } {
  if (!html || paths.size === 0) return { html, moved: [] };
  const doc = parse(html);
  const edits: { start: number; end: number; text: string }[] = [];
  const moved = new Set<string>();
  for (const el of allOf(doc.children as ChildNode[], "a")) {
    const href = hrefOf(el);
    const to = paths.get(href);
    if (to === undefined || el.startIndex == null) continue;
    const end = scanOpenTag(html, el.startIndex);
    if (end < 0) continue;
    const span = hrefSpan(html, el.startIndex, end);
    if (!span) continue;
    edits.push({ start: span.start, end: span.end, text: `"${to}"` });
    moved.add(`${href} -> ${to}`);
  }
  if (edits.length === 0) return { html, moved: [] };
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let from = 0;
  for (const edit of edits) {
    out += html.slice(from, edit.start) + edit.text;
    from = edit.end;
  }
  return { html: out + html.slice(from), moved: [...moved] };
}

/*
  Links that go nowhere: href="#" or an empty one. A supplied design often
  marks a page it has not designed yet this way (Sample Marketing Co.'s "Insights",
  "All services" and four service links on 17 November 2026). Nothing in
  TAWD checked for them, and they would have gone live as they are, so the
  build's checklist lists them for the team. Reported, never changed: what
  they should point at is the client's decision, not TAWD's.
*/
export function deadLinks(html: string): DeadLink[] {
  const out: DeadLink[] = [];
  for (const el of allOf(parse(html).children as ChildNode[], "a")) {
    // No href at all is an anchor target, which a browser does not make a link: not a dead link.
    if (el.attribs.href === undefined) continue;
    const href = hrefOf(el);
    if (href !== "#" && href !== "") continue;
    out.push({ label: linkLabel(el) || "(a link with no words)", href: href || '""' });
  }
  return out;
}

/*
  The plan's pages in the order the design's menu writes them, with the home
  page first (option A, 17 November 2026). The plan was made from this menu,
  so each item names one of its pages; an item that names none is left out
  rather than guessed at, and a menu that names no page at all gives nothing
  back, which leaves the header's menu planned the ordinary way.

  A page the menu does not name is still added, at the end: the team can add
  or rename a page by hand after the plan is made, and a page that is built
  and paid for must never be left with no link to it from anywhere.
*/
export function menuPages<T extends { name: string; kind: string; slug: string }>(header: string, plan: T[]): T[] {
  const byName = new Map(plan.map((p) => [p.name.trim().toLowerCase(), p]));
  const home = plan.find((p) => p.kind === "home");
  const ordered: T[] = [];
  for (const link of headerNavLinks(header)) {
    const page = isHomeLabel(link.label) ? home : byName.get(link.label.trim().toLowerCase());
    if (page && !ordered.includes(page)) ordered.push(page);
  }
  if (ordered.length === 0) return [];
  if (home && !ordered.includes(home)) ordered.unshift(home);
  for (const page of plan) if (!ordered.includes(page)) ordered.push(page);
  return ordered;
}
