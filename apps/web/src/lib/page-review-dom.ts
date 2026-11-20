/*
  The page review's work inside the framed page (step 3a, 3 October 2026),
  kept apart from the screen so it can be tried in a real browser: which
  section a point belongs to (the header, the footer, or a part of <main>,
  numbered as the build keeps them), where a section sits, and where a pin
  goes on it (percent of the section, so it stays put at any width).
*/

export type Area = "header" | "footer" | "main";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
export const BLUE = "#205AF2";

/* The parts of the page's own content, as the build keeps them: <main>'s children. */
export function mainParts(doc: Document): Element[] {
  const main = doc.querySelector("main");
  return main ? Array.from(main.children).filter((e) => !SKIP.has(e.tagName)) : [];
}

export function headerOf(doc: Document): Element | null {
  return doc.querySelector("body > header") ?? doc.querySelector("header:not(main header)");
}

export function footerOf(doc: Document): Element | null {
  const all = Array.from(doc.querySelectorAll("body > footer"));
  return all.at(-1) ?? Array.from(doc.querySelectorAll("footer")).filter((f) => !f.closest("main")).at(-1) ?? null;
}

export function nameOf(el: Element, fallback: string): string {
  const heading = el.querySelector("h1, h2, h3")?.textContent?.replace(/\s+/g, " ").trim();
  return (heading || fallback).slice(0, 60);
}

/* The section a point on the page belongs to. */
export function sectionAt(doc: Document, target: Element): { area: Area; section: number | null; el: Element; label: string } | null {
  const main = doc.querySelector("main");
  if (main?.contains(target)) {
    const parts = mainParts(doc);
    const index = parts.findIndex((p) => p.contains(target));
    return index === -1 ? null : { area: "main", section: index, el: parts[index]!, label: nameOf(parts[index]!, `Section ${index + 1}`) };
  }
  const header = headerOf(doc);
  if (header?.contains(target)) return { area: "header", section: null, el: header, label: "Header" };
  const footer = footerOf(doc);
  if (footer?.contains(target)) return { area: "footer", section: null, el: footer, label: "Footer" };
  return null;
}

export function elementFor(doc: Document, area: Area, section: number | null): Element | null {
  if (area === "header") return headerOf(doc);
  if (area === "footer") return footerOf(doc);
  return section === null ? null : (mainParts(doc)[section] ?? null);
}

export function box(el: Element) {
  const r = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView!;
  return { left: r.left + view.scrollX, top: r.top + view.scrollY, width: r.width, height: r.height };
}

/* A point on the page as a pin on its section, in percent of the section's width and height. */
export function pinSpot(b: { left: number; top: number; width: number; height: number }, pageX: number, pageY: number): { x: number; y: number } {
  const pct = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
  return { x: pct(((pageX - b.left) / Math.max(1, b.width)) * 100), y: pct(((pageY - b.top) / Math.max(1, b.height)) * 100) };
}

/* Where a pin kept on a section is drawn on the page. */
export function pinPoint(b: { left: number; top: number; width: number; height: number }, x: number, y: number): { left: number; top: number } {
  return { left: b.left + (x / 100) * b.width, top: b.top + (y / 100) * b.height };
}
