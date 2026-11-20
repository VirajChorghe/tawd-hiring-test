import { parseDocument } from "htmlparser2";
import type { ChildNode, Element, Text } from "domhandler";

/*
  Build B (1 October 2026, from VML's dev team): the header's menu as a
  real WordPress menu. Build A's header is written per site, usually with
  the menu twice (the desktop one and the phone one). Each <nav> that is a
  plain list of the site's own pages becomes [tawd_menu nav="..."]: the
  theme draws WordPress's "Main menu" there, each item in that nav's own
  markup, so the look stays and the team edits one menu (Appearance,
  Menus). A nav it can't read for certain (a dropdown, links to other
  places in between) stays exactly as built, with a note.
*/

export interface WpMenu {
  /** The menu's items, in the desktop menu's order: what install.php puts in "Main menu" the first time. */
  items: { label: string; path: string }[];
  /** Each converted nav: one item's markup ({tawd:href}, {tawd:label}, {tawd:current}) and what goes between items. */
  navs: { key: string; template: string; gap: string }[];
}

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";
const elements = (nodes: ChildNode[]): Element[] => nodes.filter(isElement);
const textOf = (node: ChildNode): string => (node.type === "text" ? node.data : isElement(node) ? node.children.map(textOf).join("") : "");

function all(nodes: ChildNode[], name: string, out: Element[] = []): Element[] {
  for (const n of elements(nodes)) {
    if (n.name === name) out.push(n);
    else all(n.children, name, out);
  }
  return out;
}

/* "/about", "/about/" and "/about/index.html" are the same page. */
export function pagePathOf(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//") || /[?#]/.test(href)) return null;
  const path = href.replace(/index\.html$/, "");
  return path.endsWith("/") ? path : `${path}/`;
}

const ancestors = (node: ChildNode): ChildNode[] => {
  const out: ChildNode[] = [];
  for (let n: ChildNode | null = node; n; n = n.parent as ChildNode | null) out.unshift(n);
  return out;
};

interface ReadNav {
  start: number;
  end: number;
  template: string;
  gap: string;
  items: { label: string; path: string }[];
}

/* One nav, if it's a plain list of the site's pages: the range its items take, one item's markup, and the items. */
function readNav(html: string, nav: Element, pages: Set<string>): ReadNav | string {
  const links = all(nav.children, "a");
  const pageLinks = links.filter((a) => {
    const path = pagePathOf(a.attribs.href ?? "");
    return path !== null && pages.has(path);
  });
  if (pageLinks.length < 2) return "it isn't a list of the site's pages";
  if (pageLinks.length !== links.length) return "it has links to other places among the pages";
  // The items: each link's ancestor that sits directly in the element holding them all.
  const chains = pageLinks.map(ancestors);
  let depth = 0;
  while (chains.every((c) => c[depth] === chains[0]![depth])) depth += 1;
  const holder = chains[0]![depth - 1] as Element;
  const items = chains.map((c) => c[depth] as Element);
  if (new Set(items).size !== items.length) return "it has a dropdown";
  const kids = elements(holder.children);
  const first = kids.indexOf(items[0]!);
  if (kids.slice(first, first + items.length).some((k, i) => k !== items[i])) return "something else sits between its links";

  const templates: string[] = [];
  const gaps: string[] = [];
  const read: { label: string; path: string }[] = [];
  for (const [i, item] of items.entries()) {
    const a = pageLinks[i]!;
    const texts: Text[] = [];
    const walk = (n: ChildNode) => (n.type === "text" ? (n.data.trim() ? texts.push(n) : 0) : isElement(n) ? n.children.forEach(walk) : 0);
    walk(a);
    if (texts.length !== 1) return "a link has more than its words in it";
    const label = textOf(a).trim();
    const src = html.slice(item.startIndex!, item.endIndex! + 1);
    // The link's opening tag: its address becomes {tawd:href}, aria-current goes (the theme adds it for the page being viewed).
    const openStart = a.startIndex! - item.startIndex!;
    const openEnd = src.indexOf(">", openStart) + 1;
    const open = src
      .slice(openStart, openEnd)
      .replace(/\s+aria-current\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "")
      .replace(/(\shref\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1"{tawd:href}"')
      .replace(/^<a\b/i, "<a{tawd:current}");
    const t = texts[0]!;
    const raw = html.slice(t.startIndex!, t.endIndex! + 1);
    const tStart = t.startIndex! - item.startIndex!;
    const tEnd = t.endIndex! - item.startIndex! + 1;
    const labelled = `${raw.match(/^\s*/)![0]}{tawd:label}${raw.match(/\s*$/)![0]}`;
    if (tStart < openEnd) return "a link's words come before it";
    templates.push(src.slice(0, openStart) + open + src.slice(openEnd, tStart) + labelled + src.slice(tEnd));
    if (i > 0) gaps.push(html.slice(items[i - 1]!.endIndex! + 1, item.startIndex!));
    read.push({ label, path: pagePathOf(a.attribs.href!)! });
  }
  if (templates.some((t) => t !== templates[0])) return "its links aren't all written the same way";
  if (gaps.some((g) => g !== gaps[0] || g.trim() !== "")) return "something else sits between its links";
  return { start: items[0]!.startIndex!, end: items.at(-1)!.endIndex! + 1, template: templates[0]!, gap: gaps[0] ?? "", items: read };
}

/*
  The header with its menus as [tawd_menu] placeholders. Every converted
  nav shows the same pages in the same order (the desktop one's), so one
  WordPress menu can stand for all of them.
*/
export function headerMenu(header: string, pages: Set<string>): { header: string; menu: WpMenu | null; notes: string[] } {
  const doc = parseDocument(header, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
  const navs = all(doc.children, "nav");
  const notes: string[] = [];
  const done: (ReadNav & { key: string })[] = [];
  for (const [i, nav] of navs.entries()) {
    const read = readNav(header, nav, pages);
    const name = nav.attribs["aria-label"] || nav.attribs.class || `menu ${i + 1}`;
    if (typeof read === "string") {
      if (read !== "it isn't a list of the site's pages") notes.push(`The header's "${name}" menu is kept as HTML (${read}): edit it in the Site Editor.`);
      continue;
    }
    if (done.length && JSON.stringify(read.items) !== JSON.stringify(done[0]!.items)) {
      notes.push(`The header's "${name}" menu is kept as HTML (it lists different pages from the first one): edit it in the Site Editor.`);
      continue;
    }
    done.push({ ...read, key: `nav-${done.length + 1}` });
  }
  if (!done.length) return { header, menu: null, notes };
  let out = header;
  for (const n of [...done].reverse()) out = `${out.slice(0, n.start)}[tawd_menu nav="${n.key}"]${out.slice(n.end)}`;
  return { header: out, menu: { items: done[0]!.items, navs: done.map((n) => ({ key: n.key, template: n.template, gap: n.gap })) }, notes };
}
