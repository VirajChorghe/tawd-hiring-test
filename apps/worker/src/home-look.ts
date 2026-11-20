import type { Browser, Page, Response } from "playwright-core";

import { summarizeCurrentSite, type SiteHome } from "@tawd/core/mockups";
import { SiteImportError, blockedSiteMessage, botCheck } from "@tawd/core/site";

import { readBands, routePublicOnly } from "./liked-sites";
import { publicSiteContext } from "./locked-context";

/*
  The home page as a browser sees it (one read of the current site,
  0.96.0): its sections, menu, phones and quotes (summarizeCurrentSite, the
  same as concepts' references), its colours and fonts from computed
  styles, and a first-screen screenshot. One tab in the shared Chromium.
  lookAtUrl opens the live site (only after a plain request proved it
  readable); lookAtHtml reads HTML a blocked route returned, with
  JavaScript off and every request refused (the page's words are data).
*/

/** Reads the home page as a browser sees it; saveShot stores the screenshot and gives its key. */
export type HomeLooker = (url: string, saveShot: (jpeg: Buffer) => Promise<string | null>) => Promise<SiteHome>;
/** Reads a route's HTML of the home page (no screenshot: the route gives its own). */
export type HtmlLooker = (html: string, url: string) => Promise<SiteHome>;

/** A home page section's words are kept up to this long (the summary's own limit; a band elsewhere stops at 1,500). */
export const HOME_TEXT_CAP = 4_000;

/** The browser's look at the home page stops after this long. */
export const LOOK_TIMEOUT_MS = 30_000;

/* The site's menu: of every header and nav on the page, the one with the most links to the site's own pages
   under short labels (the first nav is often a "Skip to content" link or a hidden phone menu, seen on
   finleypest.com 7 October 2026). The same places the plain-HTML reader looks (core menuOf). */
export async function readMenu(page: Page): Promise<{ label: string; href: string }[]> {
  return page.evaluate(() => {
    // The page's own address (a route's HTML is laid out under a <base>, so location is about:blank).
    const host = new URL(document.baseURI).hostname.replace(/^www\./, "");
    const linksOf = (el: Element) =>
      Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .slice(0, 60)
        .map((a) => ({ label: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim(), href: a.href }))
        .filter((a) => a.label && !/^(#|javascript:|mailto:|tel:)/i.test(a.href));
    const ownShort = (links: { label: string; href: string }[]) =>
      links.filter((a) => {
        if (a.label.length > 40 || /^skip to\b/i.test(a.label)) return false;
        try {
          return new URL(a.href).hostname.replace(/^www\./, "") === host;
        } catch {
          return false;
        }
      }).length;
    // A nav with three or more of the site's own links wins; a whole header (its top bar's buttons too) only without one.
    const pick = (selector: string) => {
      let best: { label: string; href: string }[] = [];
      let bestScore = 0;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const links = linksOf(el);
        const score = ownShort(links);
        if (score > bestScore) [best, bestScore] = [links, score];
      }
      return { best, bestScore };
    };
    const nav = pick("nav, [role=navigation]");
    if (nav.bestScore >= 3) return nav.best;
    const header = pick("header, [role=banner], .elementor-location-header");
    if (header.bestScore > nav.bestScore) return header.best;
    if (nav.bestScore > 0) return nav.best;
    const first = document.querySelector("header nav, nav, header");
    return linksOf(first ?? document.body);
  });
}

/* The page's most used colours (text, backgrounds, buttons) and its font families, from computed styles. */
async function readStyle(page: Page): Promise<{ colours: string[]; fonts: string[] }> {
  return page.evaluate(() => {
    const colours = new Map<string, number>();
    const fonts = new Map<string, number>();
    const hex = (value: string) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
      return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    };
    const elements = Array.from(document.querySelectorAll<HTMLElement>("body, header, nav, main, section, footer, h1, h2, h3, p, a, button, .button, .btn")).slice(0, 600);
    for (const el of elements) {
      const style = getComputedStyle(el);
      const weight = el.matches("button, .button, .btn, h1, h2") ? 3 : 1;
      for (const value of [style.color, style.backgroundColor]) {
        const colour = hex(value);
        if (colour) colours.set(colour, (colours.get(colour) ?? 0) + weight);
      }
      const family = style.fontFamily.split(",")[0]?.replace(/["']/g, "").trim();
      if (family) fonts.set(family, (fonts.get(family) ?? 0) + weight);
    }
    const top = (map: Map<string, number>, n: number) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    return { colours: top(colours, 6), fonts: top(fonts, 3) };
  });
}

/* The live home page: one tab in the shared Chromium (render.ts), every request the page makes checked public. */
export const lookAtUrl: HomeLooker = async (url, saveShot) => {
  const { VIEWPORT, withRenderSlot, withSharedBrowser } = await import("./render");
  return withRenderSlot(() => withSharedBrowser(async (browser) => {
    const context = await publicSiteContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await routePublicOnly(page);
      // Video, audio and live connections aren't needed for the look, and cost memory.
      await page.route("**/*", (route) => (["media", "websocket", "eventsource"].includes(route.request().resourceType()) ? route.abort() : route.fallback()));
      await page.goto(url, { waitUntil: "load", timeout: LOOK_TIMEOUT_MS });
      await page.waitForTimeout(1_500);
      const check = botCheck({ status: 200, text: await page.content() });
      if (check) throw new SiteImportError(blockedSiteMessage(url, check), true);
      const { bands } = await readBands(page, { textCap: HOME_TEXT_CAP });
      const result = summarizeCurrentSite({ title: await page.title(), bands, menu: await readMenu(page) });
      const style = await readStyle(page).catch(() => ({ colours: [], fonts: [] }));
      const shot = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
      return { ...result, look: { colours: style.colours, fonts: style.fonts, screenshotKey: shot ? await saveShot(shot) : null } };
    } finally {
      await context.close().catch(() => undefined);
    }
  }));
};

/* A route's HTML of the home page: laid out in a tab with JavaScript off and no requests at all, then read the same way. */
export const lookAtHtml: HtmlLooker = async (html, url) => {
  const { VIEWPORT, withRenderSlot, withSharedBrowser } = await import("./render");
  return withRenderSlot(() => withSharedBrowser(async (browser) => {
    const context = await publicSiteContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) => route.abort());
      await page.setContent(html.replace(/<head([^>]*)>/i, `<head$1><base href="${url.replace(/"/g, "")}">`), { waitUntil: "domcontentloaded", timeout: LOOK_TIMEOUT_MS });
      const { bands } = await readBands(page, { textCap: HOME_TEXT_CAP });
      const result = summarizeCurrentSite({ title: await page.title(), bands, menu: await readMenu(page) });
      const style = await readStyle(page).catch(() => ({ colours: [], fonts: [] }));
      return { ...result, look: { colours: style.colours, fonts: style.fonts, screenshotKey: null } };
    } finally {
      await context.close().catch(() => undefined);
    }
  }));
};

/*
  The client's own photos on their current website (Jason, 4 November 2026:
  New Dawn Awning's concepts had empty cards while the client's site was
  full of their work). The live home page in one tab, every request checked
  public as above; scrolled once so lazy pictures load; the larger photos
  outside the header, menu and footer kept, never a logo, an icon, a badge
  or a map. Only bytes the page itself loaded are kept, so nothing is
  fetched outside the checked route. Never throws: no photos is a normal
  answer (a blocked site, a site of drawings).
*/
export interface SitePhoto {
  bytes: Buffer;
  contentType: string;
  alt: string;
  width: number;
  height: number;
  src: string;
}

/** The most photos kept from the current site. */
export const MAX_SITE_PHOTOS = 8;
// HEIC/HEIF are admitted so an iPhone photo on the site is captured; it's converted to JPEG at ingress (gap 11).
const PHOTO_TYPES = /^image\/(jpeg|jpg|png|webp|heic|heif)\b/i;
const MIN_BYTES = 15 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

/* The page's larger photos, biggest first (run in the page). Exported for the test. */
export async function photoCandidates(page: Page): Promise<{ src: string; alt: string; width: number; height: number }[]> {
  return page.evaluate(() => {
    const NOT_A_PHOTO = /logo|icon|badge|seal|award|sprite|avatar|flag|payment|bbb|angi|yelp|google|facebook|map\b|maps|placeholder|spacer|pixel|svg/i;
    const inChrome = (el: Element) => Boolean(el.closest("header, nav, footer, [role=banner], [role=navigation], [role=contentinfo]"));
    const out: { src: string; alt: string; width: number; height: number; area: number }[] = [];
    for (const img of Array.from(document.images)) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:") || !img.complete) continue;
      const box = img.getBoundingClientRect();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < 400 || h < 250 || box.width < 200 || box.height < 140) continue;
      const ratio = w / h;
      if (ratio < 0.4 || ratio > 3.2) continue;
      if (inChrome(img) || NOT_A_PHOTO.test(`${src} ${img.alt} ${img.className}`)) continue;
      out.push({ src, alt: (img.alt || "").replace(/\s+/g, " ").trim().slice(0, 120), width: w, height: h, area: box.width * box.height });
    }
    // Large sections painted with a photo (a hero, a project tile).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 3000)) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
      if (!m || m[1]!.startsWith("data:")) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 400 || box.height < 250 || inChrome(el) || NOT_A_PHOTO.test(m[1]!)) continue;
      out.push({ src: new URL(m[1]!, document.baseURI).href, alt: "", width: Math.round(box.width), height: Math.round(box.height), area: box.width * box.height });
    }
    const seen = new Set<string>();
    return out
      .sort((a, b) => b.area - a.area)
      .filter((p) => (seen.has(p.src) ? false : (seen.add(p.src), true)))
      .slice(0, 20)
      .map(({ src, alt, width, height }) => ({ src, alt, width, height }));
  });
}

/* In the browser the concept job already has open (one Chromium on a 4 GB server). */
export async function collectSitePhotos(browser: Browser, url: string): Promise<SitePhoto[]> {
  const { VIEWPORT } = await import("./render");
  try {
    return await (async () => {
      const context = await publicSiteContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        await routePublicOnly(page);
        await page.route("**/*", (route) => (["media", "websocket", "eventsource"].includes(route.request().resourceType()) ? route.abort() : route.fallback()));
        // The pictures the page loads, by address: only these are ever kept, and only the chosen ones are read into memory.
        const loaded = new Map<string, Response>();
        page.on("response", (response) => {
          if (loaded.size >= 200 || response.request().resourceType() !== "image" || response.status() !== 200) return;
          const headers = response.headers();
          if (!PHOTO_TYPES.test(headers["content-type"] ?? "")) return;
          const length = Number(headers["content-length"] ?? NaN);
          if (Number.isFinite(length) && (length < MIN_BYTES || length > MAX_BYTES)) return;
          loaded.set(response.url(), response);
        });
        await page.goto(url, { waitUntil: "load", timeout: LOOK_TIMEOUT_MS });
        if (botCheck({ status: 200, text: await page.content() })) return [];
        // Down the page and back, so pictures that load on scroll are there.
        await page.evaluate(async () => {
          const until = Date.now() + 8_000;
          for (let y = 0; y < document.documentElement.scrollHeight && y < 20_000 && Date.now() < until; y += 700) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1_200);
        const photos: SitePhoto[] = [];
        for (const candidate of await photoCandidates(page)) {
          const response = loaded.get(candidate.src);
          if (!response) continue;
          const bytes = await response.body().catch(() => null);
          if (!bytes || bytes.length < MIN_BYTES || bytes.length > MAX_BYTES) continue;
          const contentType = (response.headers()["content-type"] ?? "image/jpeg").split(";")[0]!.trim();
          photos.push({ bytes, contentType, alt: candidate.alt, width: candidate.width, height: candidate.height, src: candidate.src });
          if (photos.length >= MAX_SITE_PHOTOS) break;
        }
        return photos;
      } finally {
        await context.close().catch(() => undefined);
      }
    })();
  } catch (error) {
    console.warn(`[site photos] the current site's photos couldn't be read (${error instanceof Error ? error.message.split("\n")[0] : "unknown"}); the concepts go without them.`);
    return [];
  }
}
