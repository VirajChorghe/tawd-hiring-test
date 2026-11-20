import type { Browser } from "playwright-core";

import type { FigmaNode } from "@tawd/core/figma";
import { ownPageContext } from "./locked-context";

/*
  Filling a page from a template (Jason, 29 September 2026: "detect pages
  that share a layout; build each layout once and fill the others"). Two
  pages that share a layout (the sample client's Rex, Sky and Pip) have their
  words and photos in the same places. So the template page's copy is
  turned into the other page's by code: each word of the template is
  swapped for the other page's word at the same place, and each photo for
  the other page's photo at the same place. $0, no AI. Words of the other
  page with no match are reported (the page then needs that section
  rebuilt, priced).
*/

interface Placed {
  text?: string;
  ref?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size?: number;
}

/* The texts and the photos of a frame, placed within it. */
export function frameContents(frame: FigmaNode): { texts: Placed[]; photos: Placed[] } {
  const origin = frame.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const texts: Placed[] = [];
  const photos: Placed[] = [];
  const walk = (n: FigmaNode) => {
    const b = n.absoluteBoundingBox;
    if (b) {
      const at = { x: b.x - origin.x, y: b.y - origin.y, w: b.width, h: b.height };
      if (n.type === "TEXT" && (n as { characters?: string }).characters?.trim()) {
        texts.push({ ...at, text: (n as { characters?: string }).characters!.trim(), size: (n as { style?: { fontSize?: number } }).style?.fontSize });
      }
      for (const fill of n.fills ?? []) if (fill.type === "IMAGE" && fill.imageRef) photos.push({ ...at, ref: fill.imageRef });
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(frame);
  return { texts, photos };
}

/* Pairs each of `from` with the nearest of `to` at about the same place (one to one, nearest pairs first). */
export function pairByPlace<T extends Placed>(from: T[], to: T[], reach: (a: T) => number): [T, T][] {
  const candidates: { a: T; b: T; d: number }[] = [];
  for (const a of from) {
    for (const b of to) {
      const d = Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
      if (d <= reach(a)) candidates.push({ a, b, d });
    }
  }
  candidates.sort((p, q) => p.d - q.d);
  const usedA = new Set<T>(), usedB = new Set<T>();
  const pairs: [T, T][] = [];
  for (const c of candidates) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    pairs.push([c.a, c.b]);
  }
  return pairs;
}

export interface FillPlan {
  /** Template words to the other page's words, in place. */
  texts: { from: string; to: string }[];
  /** Template photo tokens to the other page's photo tokens. */
  photos: { from: string; to: string }[];
  /** The other page's words with no place in the template. */
  unmatched: string[];
  /** The template's own words and photos with no place on the other page: removed, never kept (29 September 2026). */
  removeTexts: string[];
  removePhotos: string[];
  /** The template page's name and the other page's ("Mia" to "Dakota"), for the words that still name it. */
  names: { from: string; to: string } | null;
  /** Every word of the other page's design (never renamed or removed). */
  targetTexts: string[];
}

export function planFill(
  template: { frame: FigmaNode; byImageRef: Record<string, string>; name?: string },
  target: { frame: FigmaNode; byImageRef: Record<string, string>; name?: string },
): FillPlan {
  const a = frameContents(template.frame);
  const b = frameContents(target.frame);
  const same = (x: string, y: string) => x.replace(/\s+/g, " ").trim().toLowerCase() === y.replace(/\s+/g, " ").trim().toLowerCase();
  // The same words on both pages ("AGE", "WEIGHT") pair with each other first, so labels stay labels and values take values.
  const words = [...new Set(a.texts.map((t) => t.text!.replace(/\s+/g, " ").trim().toLowerCase()))];
  const identical = words.flatMap((w) =>
    pairByPlace(
      a.texts.filter((t) => same(t.text!, w)),
      b.texts.filter((t) => same(t.text!, w)),
      (t) => Math.max(120, t.h * 4),
    ),
  );
  const pairedA = new Set(identical.map(([f]) => f));
  const pairedB = new Set(identical.map(([, t]) => t));
  // The rest by place, a text only with one of about its size.
  const sized = pairByPlace(
    a.texts.filter((t) => !pairedA.has(t)),
    b.texts.filter((t) => !pairedB.has(t)),
    (t) => Math.max(40, t.h * 1.5),
  ).filter(([f, t]) => !f.size || !t.size || Math.abs(f.size - t.size) / Math.max(f.size, t.size) <= 0.3);
  const textPairs = [...identical, ...sized];
  const photoPairs = pairByPlace(a.photos, b.photos, (p) => Math.max(60, Math.min(p.w, p.h) * 0.5));
  const matched = new Set(textPairs.map(([, t]) => t));
  const usedA = new Set(textPairs.map(([f]) => f));
  const usedPhotos = new Set(photoPairs.map(([f]) => f));
  const targetWords = new Set(b.texts.map((t) => t.text!.replace(/\s+/g, " ").trim().toLowerCase()));
  const clean = (n?: string) => (n ? n.trim() : "");
  return {
    texts: textPairs.filter(([f, t]) => f.text !== t.text).map(([f, t]) => ({ from: f.text!, to: t.text! })),
    photos: photoPairs
      .map(([f, t]) => ({ from: template.byImageRef[f.ref!] ?? "", to: target.byImageRef[t.ref!] ?? "" }))
      .filter((p) => p.from && p.to && p.from !== p.to),
    unmatched: b.texts.filter((t) => !matched.has(t)).map((t) => t.text!),
    removeTexts: a.texts.filter((t) => !usedA.has(t) && !targetWords.has(t.text!.replace(/\s+/g, " ").trim().toLowerCase())).map((t) => t.text!),
    removePhotos: a.photos.filter((p) => !usedPhotos.has(p)).map((p) => template.byImageRef[p.ref!] ?? "").filter(Boolean),
    names: clean(template.name) && clean(target.name) && clean(template.name).toLowerCase() !== clean(target.name).toLowerCase() ? { from: clean(template.name), to: clean(target.name) } : null,
    targetTexts: b.texts.map((t) => t.text!),
  };
}

/* The template's source with the other page's words and photo tokens put in. */
export async function fillInBrowser(browser: Browser, source: string, plan: FillPlan): Promise<{ html: string; replaced: number; notFound: string[] }> {
  // Photos: tokens swapped through markers, so a token that is also another's target isn't swapped twice.
  let html = source;
  plan.photos.forEach((p, i) => {
    // nosemgrep: ajinabraham.njsscan.dos.regex_injection.regex_injection_dos -- split on a plain string, not a regular expression
    html = html.split(p.from).join(`\u0000fill-${i}\u0000`);
  });
  plan.photos.forEach((p, i) => {
    html = html.split(`\u0000fill-${i}\u0000`).join(p.to);
  });
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    return await page.evaluate(
      ({ html, texts, removeTexts, removePhotos, names, targetTexts }) => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const norm = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
        const done = new Set<Element>();
        let replaced = 0;
        const notFound: string[] = [];
        // Longer words first, so "Meet Dakota" is found before "Dakota" alone.
        for (const { from, to } of [...texts].sort((p, q) => q.from.length - p.from.length)) {
          const want = norm(from);
          let best: Element | null = null;
          doc.body.querySelectorAll("*").forEach((el) => {
            if (done.has(el) || [...done].some((d) => d.contains(el) || el.contains(d))) return;
            if (norm(el.textContent ?? "") !== want) return;
            if (!best || best.contains(el)) best = el;
          });
          if (!best) {
            // Words the copy joined into a longer paragraph: swap them inside the one text piece that has them.
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
            let swapped = false;
            for (let n = walker.nextNode(); n && !swapped; n = walker.nextNode()) {
              const text = n.textContent ?? "";
              const at = text.replace(/\s+/g, " ").toLowerCase().indexOf(from.replace(/\s+/g, " ").toLowerCase());
              if (at < 0 || text.replace(/\s+/g, " ") !== text) continue;
              n.textContent = text.slice(0, at) + to + text.slice(at + from.replace(/\s+/g, " ").length);
              swapped = true;
            }
            if (swapped) replaced += 1;
            else notFound.push(from);
            continue;
          }
          const el = best as Element;
          const nodes: Text[] = [];
          const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? "").trim()) nodes.push(n as Text);
          if (nodes.length === 0) {
            notFound.push(from);
            continue;
          }
          nodes[0]!.textContent = to;
          for (const n of nodes.slice(1)) n.textContent = "";
          done.add(el);
          replaced += 1;
        }
        // The template's own photos and words with no place here: removed, and whatever held only them closes up.
        const closeUp = (el: Element) => {
          let parent: Element | null = el.parentElement;
          el.remove();
          while (parent && parent !== doc.body && parent.tagName !== "MAIN" && !(parent.textContent ?? "").trim() && !parent.querySelector("img, svg, video, iframe")) {
            const up: Element | null = parent.parentElement;
            parent.remove();
            parent = up;
          }
        };
        for (const token of removePhotos) for (const img of Array.from(doc.querySelectorAll(`img[src="${token}"]`))) closeUp(img);
        const targetSet = new Set(targetTexts.map(norm));
        for (const word of removeTexts) {
          const want = norm(word);
          for (const el of Array.from(doc.body.querySelectorAll("*"))) {
            if (!el.isConnected || done.has(el) || [...done].some((d) => d.contains(el) || el.contains(d))) continue;
            if (norm(el.textContent ?? "") === want && !targetSet.has(want)) {
              closeUp(el);
              break;
            }
          }
        }
        // The template page's name left in words and picture descriptions becomes this page's ("Mia's Photo Gallery" to "Dakota's Photo Gallery"); never in words from this page's own design.
        if (names) {
          const esc = names.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${esc}\\b`, "gi");
          const cased = (found: string) => (found === found.toUpperCase() ? names.to.toUpperCase() : found[0] === found[0]!.toUpperCase() ? names.to[0]!.toUpperCase() + names.to.slice(1).toLowerCase() : names.to.toLowerCase());
          const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const holder = n.parentElement;
            if (!holder || [...done].some((d) => d.contains(holder)) || targetSet.has(norm(n.textContent ?? ""))) continue;
            if (re.test(n.textContent ?? "")) n.textContent = (n.textContent ?? "").replace(re, cased);
            re.lastIndex = 0;
          }
          for (const img of Array.from(doc.querySelectorAll("img[alt]"))) {
            const alt = img.getAttribute("alt") ?? "";
            if (re.test(alt)) img.setAttribute("alt", alt.replace(re, cased));
            re.lastIndex = 0;
          }
        }
        return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, replaced, notFound };
      },
      { html, texts: plan.texts, removeTexts: plan.removeTexts ?? [], removePhotos: plan.removePhotos ?? [], names: plan.names ?? null, targetTexts: plan.targetTexts ?? [] },
    );
  } finally {
    await context.close();
  }
}
