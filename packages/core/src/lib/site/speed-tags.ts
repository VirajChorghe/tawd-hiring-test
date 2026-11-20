import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { usPhoneDigits } from "../phone";

/*
  The speed pass's changes to a page's own tags (1 October 2026), from
  what the build's browser measured on it (apps/worker/src/site-speed.ts):
  pictures below the first screen load when scrolled to, the first
  screen's biggest one loads first, a swapped picture lists all its sizes
  with how wide it's shown, sections well below the first screen are laid
  out only when scrolled near (content-visibility), and links with no
  visible words get a label.
*/

export interface PageSeen {
  /** Each <img> in order, at each width (computer, phone): its address, its top on the page and its shown size. */
  imgs: { src: string | null; top: number; w: number; h: number }[][];
  /** <main>'s own children in order, at each width: their top on the page and height. */
  /** pinned: a fixed or sticky part inside, so the section is never deferred (Fable's B11, 3 October 2026). */
  sections: { top: number; h: number; pinned?: boolean }[][];
  /** Links with no visible words at some width, by their place among the page's links: the address and the link's words. */
  unnamed: Map<number, { href: string; text: string }>;
  anchors: number;
}

/** Each picture swapped: its new address (the largest size) and every size made, for srcset. */
export type Renamed = Map<string, { main: string; set: { w: number; url: string }[]; dw?: number; pw?: number }>;

/** The build file listing each swapped picture's sizes (the WordPress package reads it; "_" keeps it out of the pictures). */
export const SPEED_IMAGES_FILE = "_tawd/images.json";

/* What the WordPress package takes off a picture block's <img> (WordPress's theme puts it back) and off sections. */
export function stripSpeedForBlocks(html: string): string {
  return html
    .replace(/(<figure\b[^>]*>\s*<img\b)([^>]*)(>\s*<\/figure>)/gi, (_m, a: string, attrs: string, z: string) => a + attrs.replace(/\s(?:srcset|sizes|loading|decoding|fetchpriority)=(["'])[^"']*\1/gi, "") + z)
    .replace(/\sdata-tawd-cv(?=[\s>])/g, "")
    .replace(/\sstyle=(["'])([^"']*)\1/g, (m, q: string, v: string) => {
      if (!/--tawd-hp?:/.test(v)) return m;
      const kept = v.replace(/;?\s*--tawd-hp?:\s*\d+px/g, "").replace(/^;\s*/, "").trim();
      return kept ? ` style=${q}${kept}${q}` : "";
    });
}

export interface TagCounts {
  lazy: number;
  labels: number;
  sections: number;
  notes: string[];
}

/** The widths the build's browser measures at: a computer, then a phone. */
export const SPEED_VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
] as const;

/* The rule that sizes the sections laid out only when scrolled near (one per page, in the head). */
export const SECTION_RULE = "[data-tawd-cv]{content-visibility:auto;contain-intrinsic-size:auto var(--tawd-h,800px)}@media (max-width:600px){[data-tawd-cv]{contain-intrinsic-size:auto var(--tawd-hp,var(--tawd-h,800px))}}";

/* "tel:+15555555555" → "(555) 555-5555"; anything else as written. */
export function phoneWords(href: string): string {
  const us = usPhoneDigits(href.replace(/^tel:/i, "").replace(/[^\d+]/g, ""));
  return us ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : decodeURIComponent(href.replace(/^tel:/i, ""));
}

const pathOf = (file: string) => (file === "index.html" ? "/" : file.endsWith("/index.html") ? `/${file.slice(0, -"index.html".length)}` : `/${file}`);
const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";

/* A label that says what the link does: its own words when it has some (hidden on a phone), else the number or the address. */
export function linkLabel(href: string, text: string): string | null {
  const words = text.replace(/\s+/g, " ").trim();
  if (words) return words;
  if (/^tel:/i.test(href)) return `Call ${phoneWords(href)}`;
  if (/^mailto:/i.test(href)) return `Email ${href.slice(7).split("?")[0]}`;
  return null;
}

export function tuneTags(html: string, page: PageSeen, renamed: Renamed, counts: TagCounts, file: string): string {
  // Each change is an insertion at a place in the original page; applied last to first so the places stay right.
  const edits: { at: number; text: string; replace?: number }[] = [];

  /*
    The pictures the browser sees: not those inside <noscript> (a tracking
    pixel) or a comment, which it never shows (Fable's B12, 3 October 2026).
  */
  const hidden = [...html.matchAll(/<noscript\b[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const tags = [...html.matchAll(/<img\b[^>]*>/gi)].filter((m) => !hidden.some(([from, to]) => m.index! >= from && m.index! < to));
  const views = [page.imgs[0], page.imgs[1]];
  if (tags.length && views.every((v) => v?.length === tags.length)) {
    const [desk, phone] = views as [PageSeen["imgs"][number], PageSeen["imgs"][number]];
    const fold = (i: number) => views.some((v, k) => v![i]!.top < SPEED_VIEWPORTS[k]!.height && v![i]!.w > 0);
    let lcp = -1;
    for (let i = 0; i < tags.length; i += 1) if (fold(i) && (lcp < 0 || phone[i]!.w * phone[i]!.h > phone[lcp]!.w * phone[lcp]!.h)) lcp = i;
    const mains = new Map([...renamed.values()].map((r) => [r.main, r.set]));
    for (let i = 0; i < tags.length; i += 1) {
      const tag = tags[i]![0];
      const add: string[] = [];
      if (i === lcp && !/\bfetchpriority=/i.test(tag)) add.push('fetchpriority="high"');
      if (!fold(i) && !/\bloading=/i.test(tag)) {
        add.push('loading="lazy" decoding="async"');
        counts.lazy += 1;
      }
      const set = mains.get(/\ssrc=["']([^"']+)["']/i.exec(tag)?.[1] ?? "");
      if (set && set.length > 1 && !/\ssrcset=/i.test(tag)) {
        const dw = Math.round(desk[i]!.w || phone[i]!.w);
        const pw = Math.round(phone[i]!.w || desk[i]!.w);
        if (dw > 0) add.push(`srcset="${set.map((s) => `${s.url} ${s.w}w`).join(", ")}" sizes="(max-width: 600px) ${pw}px, ${dw}px"`);
      }
      if (add.length) edits.push({ at: tags[i]!.index! + 4, text: ` ${add.join(" ")}` });
    }
  }

  // Sections well below the first screen at both widths: laid out only when scrolled near, at their measured height until then.
  const [deskSections, phoneSections] = page.sections;
  if (deskSections?.length && phoneSections?.length === deskSections.length) {
    const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
    const find = (nodes: ChildNode[]): Element | null => {
      for (const n of nodes) {
        if (!isElement(n)) continue;
        if (n.name === "main") return n;
        const inside = find(n.children);
        if (inside) return inside;
      }
      return null;
    };
    const kids = (find(doc.children)?.children ?? []).filter(isElement);
    if (kids.length === deskSections.length) {
      let marked = 0;
      for (const [i, el] of kids.entries()) {
        const d = deskSections[i]!;
        const p = phoneSections[i]!;
        if (d.top < SPEED_VIEWPORTS[0].height * 1.5 || p.top < SPEED_VIEWPORTS[1].height * 1.5 || d.pinned || p.pinned || el.name === "script" || el.name === "style" || el.attribs["data-tawd-cv"] !== undefined) continue;
        const open = html.slice(el.startIndex!, html.indexOf(">", el.startIndex!) + 1);
        const style = /\sstyle=(["'])([\s\S]*?)\1/i.exec(open);
        const props = `--tawd-h:${Math.ceil(d.h)}px;--tawd-hp:${Math.ceil(p.h)}px`;
        if (style) {
          const at = el.startIndex! + style.index + style[0].length - 1;
          edits.push({ at, text: `${style[2]!.trim().endsWith(";") || !style[2]!.trim() ? "" : ";"}${props}` });
          edits.push({ at: el.startIndex! + 1 + el.name.length, text: " data-tawd-cv" });
        } else {
          edits.push({ at: el.startIndex! + 1 + el.name.length, text: ` data-tawd-cv style="${props}"` });
        }
        marked += 1;
      }
      if (marked) {
        counts.sections += marked;
        const head = /<\/head>/i.exec(html);
        if (head) edits.push({ at: head.index, text: `<style id="tawd-sections">${SECTION_RULE}</style>` });
      }
    }
  }

  const anchors = [...html.matchAll(/<a\b[^>]*>/gi)];
  if (page.unnamed.size && anchors.length === page.anchors) {
    for (const [i, { href, text }] of page.unnamed) {
      const tag = anchors[i]![0];
      if (/\saria-label=/i.test(tag)) continue;
      const label = linkLabel(href, text);
      if (!label) {
        counts.notes.push(`A link on ${pathOf(file)} has no words for screen readers (${href || "no address"}).`);
        continue;
      }
      edits.push({ at: anchors[i]!.index! + 2, text: ` aria-label="${label.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` });
      counts.labels += 1;
    }
  }

  let out = html;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}
