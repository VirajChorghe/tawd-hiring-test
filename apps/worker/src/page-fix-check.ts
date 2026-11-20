import type { Browser, Page } from "playwright-core";

import { getStorage } from "@tawd/core/intake/storage";
import { FIX_CHECK_WIDTHS, describeFixCheck, type FixCheckRaw, type FixCheckWidth, type FixPartId } from "@tawd/core/site";
import { ownPageContext } from "./locked-context";
import { openPage } from "./page-load";

/*
  TAWD's check after a Fix these (3c, 5 October 2026): free, by code. The
  fixed page is opened from the build's own files (nothing from the
  internet but fonts) at 1,280 and 390 wide, and only the parts that
  changed are measured. The rules for what counts are in core
  `site/page-fix-check.ts`; anything unsure is left out, since a false
  alarm costs a paid retry.
*/

export const SITE_ORIGIN = "https://site.tawd.local";
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  woff2: "font/woff2",
  ico: "image/x-icon",
};

/* A tab that answers the build's own address from storage, and fonts from the internet; nothing else loads. */
export async function serveBuild(tab: Page, base: string): Promise<void> {
  const storage = getStorage();
  await tab.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (/^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.continue();
    if (url.origin !== SITE_ORIGIN) return route.abort();
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = rel === "" ? "index.html" : /\.[a-z0-9]+$/i.test(rel) ? rel : `${rel.replace(/\/$/, "")}/index.html`;
    if (file.split("/").some((s) => s === "..")) return route.abort();
    const body = await storage.get(`${base}${file}`);
    if (!body) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, body, contentType: TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" });
  });
}

/*
  The check of one fixed page: plain-English findings, empty when all is
  well. A check that can't run finds nothing (it never stops the fix).
*/
export async function checkFixedPage(browser: Browser, base: string, path: string, parts: FixPartId[]): Promise<string[]> {
  if (parts.length === 0) return [];
  const results: { width: FixCheckWidth; found: FixCheckRaw[] }[] = [];
  for (const width of ["computer", "phone"] as const) {
    const context = await ownPageContext(browser, { viewport: FIX_CHECK_WIDTHS[width], deviceScaleFactor: 1 });
    try {
      const tab = await context.newPage();
      await serveBuild(tab, base);
      await openPage(tab, `${SITE_ORIGIN}${path}`);
      await tab.waitForTimeout(300);
      const found = await tab.evaluate(measureFixParts, { parts: parts.map(String), width });
      results.push({ width, found: Array.isArray(found) ? found : [] });
    } catch {
      // Unmeasured: nothing found at this width.
    } finally {
      await context.close();
    }
  }
  return describeFixCheck(results);
}

/*
  Runs inside the page (Playwright's evaluate), so it uses nothing from
  outside its own body. Waits a few seconds at most for the parts' pictures
  and the fonts, then measures each part.
*/
export async function measureFixParts(arg: { parts: string[]; width: "computer" | "phone" }): Promise<FixCheckRaw[]> {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
  const media = new Set(["IMG", "PICTURE", "VIDEO", "IFRAME", "SVG", "CANVAS"]);
  const main = document.querySelector("main");
  const partEl = (part: string): Element | null =>
    part === "header"
      ? (document.querySelector("body > header") ?? document.querySelector("header"))
      : part === "footer"
        ? (Array.from(document.querySelectorAll("body > footer")).at(-1) ?? Array.from(document.querySelectorAll("footer")).at(-1) ?? null)
        : main
          ? (Array.from(main.children).filter((e) => !skip.has(e.tagName))[Number(part)] ?? null)
          : null;
  const shown = (el: Element): boolean => {
    const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
    if (check && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const words = (el: Element): string =>
    ((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  // How many lines some text takes: its boxes, grouped by where each line starts.
  const lineCount = (rects: DOMRect[]): number => {
    const tops: number[] = [];
    for (const r of rects.filter((x) => x.width > 0.5 && x.height > 0.5).sort((a, b) => a.top - b.top)) {
      if (!tops.some((t) => Math.abs(t - r.top) < r.height * 0.5)) tops.push(r.top);
    }
    return tops.length;
  };
  const textRects = (el: Element): DOMRect[] => {
    const out: DOMRect[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement || !shown(node.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      out.push(...Array.from(range.getClientRects()));
    }
    return out;
  };

  const roots = arg.parts.map((p) => ({ part: p, el: partEl(p) })).filter((r): r is { part: string; el: Element } => Boolean(r.el));
  // Lazy pictures in the parts load now; wait for them and the fonts, six seconds at most.
  const pictures = roots.flatMap((r) => Array.from(r.el.querySelectorAll("img")));
  for (const img of pictures) if (img.loading === "lazy") img.loading = "eager";
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  await Promise.race([
    Promise.all([
      ...pictures
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
      document.fonts ? document.fonts.ready.then(() => undefined) : Promise.resolve(),
    ]),
    wait(6000),
  ]);
  await wait(100);

  const found: FixCheckRaw[] = [];
  const edge = window.innerWidth;
  const phoneRe = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}/g;
  const buttonClass = /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i;

  for (const { part, el: root } of roots) {
    if (!shown(root)) continue;

    // 1. A phone number, a button or (at computer width, in the header) a menu link on more than one line.
    const seen: Element[] = [];
    const near = (el: Element) => seen.some((s) => s === el || s.contains(el) || el.contains(s));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !shown(parent)) continue;
      // On a phone, the menu's own links belong to the phone menu.
      if (arg.width === "phone" && parent.closest("nav")) continue;
      for (const match of (node.textContent ?? "").matchAll(phoneRe)) {
        const range = document.createRange();
        range.setStart(node, match.index!);
        range.setEnd(node, match.index! + match[0].length);
        const lines = lineCount(Array.from(range.getClientRects()));
        if (lines > 1 && !near(parent)) {
          seen.push(parent);
          found.push({ part, kind: "wrap", what: "phone number", text: match[0].trim(), lines });
        }
      }
    }
    const tappable = Array.from(root.querySelectorAll("button, [role='button'], a[href^='tel:'], a[class]")).filter(
      (b) => b.tagName === "BUTTON" || b.getAttribute("role") === "button" || Boolean(b.getAttribute("href")?.startsWith("tel:")) || buttonClass.test(b.getAttribute("class") ?? ""),
    );
    const menuLinks = arg.width === "computer" && part === "header" ? Array.from(root.querySelectorAll("nav a")).filter((a) => !tappable.includes(a)) : [];
    for (const [el, what, longest] of [
      ...tappable.map((b) => [b, "button", arg.width === "phone" ? 20 : 40] as const),
      ...menuLinks.map((a) => [a, "menu link", 25] as const),
    ]) {
      if (!shown(el) || near(el)) continue;
      if (arg.width === "phone" && el.closest("nav")) continue;
      const label = words(el);
      // A short label never needs two lines; a long one may (a full sentence on a phone).
      if (!label || label.length > longest) continue;
      const lines = lineCount(textRects(el));
      if (lines > 1) {
        seen.push(el);
        found.push({ part, kind: "wrap", what, text: label, lines });
      }
    }

    // 2. Something a person reads or taps sticking out past the edge of the page.
    const clipped = (el: Element): boolean => {
      // A box that cuts off or scrolls its content hides the overflow; the page itself only hides pictures and shapes.
      const upToPage = media.has(el.tagName.toUpperCase());
      for (let a = el.parentElement; a; a = a.parentElement) {
        if ((a === document.body || a === document.documentElement) && !upToPage) break;
        const style = getComputedStyle(a);
        if (style.overflowX !== "visible") return true;
      }
      return false;
    };
    const out: Element[] = [];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (skip.has(el.tagName) || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      // Partly on the page: a drawer waiting off to the side is wholly off it.
      if (r.right - edge <= 2 || r.left >= edge - 1) continue;
      const style = getComputedStyle(el);
      if ((style.position === "absolute" || style.position === "fixed") && (el.getAttribute("aria-hidden") === "true" || !words(el))) continue;
      if (!words(el) && !media.has(el.tagName.toUpperCase()) && !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName)) continue;
      if (clipped(el)) continue;
      out.push(el);
    }
    for (const el of out.filter((e) => !out.some((o) => o !== e && o.contains(e))).slice(0, 3)) {
      found.push({ part, kind: "overflow", what: el === root ? "part" : "element", text: el === root ? "" : words(el), by: Math.round(el.getBoundingClientRect().right - edge) });
    }

    // 3. The build's own pictures that didn't load (pictures from elsewhere aren't served here, so aren't judged).
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const src = img.currentSrc || img.src;
      if (!src || !img.complete || img.naturalWidth > 0) continue;
      const check = (img as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
      if (check && !check.call(img, { checkVisibilityCSS: true, visibilityProperty: true })) continue;
      let url: URL;
      try {
        url = new URL(src, location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;
      found.push({ part, kind: "image", what: "picture", text: decodeURIComponent(url.pathname.split("/").pop() ?? "").slice(0, 60) });
    }
  }
  return found;
}
