import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { and, eq } from "drizzle-orm";
import type { Browser, Page } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { likedSiteShot } from "@tawd/core/schema";
import { isPrivateAddress, publicOnlyLookup } from "@tawd/core/public-address";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import type { LikedSitesJobData } from "@tawd/core/queue";
import { outlineReference, type RawReferenceBand, type ReferenceOutline } from "@tawd/core/mockups";

import { VIEWPORT } from "./render";
import { publicSiteContext } from "./locked-context";

/*
  "Websites they like": each site the PM listed, photographed once (its
  first screen at 1440 by 900, as a JPEG), for the intake's thumbnails and
  for the mockup builder as visual inspiration (never to copy). No AI.

  The worker must never be steered at the droplet itself or a private
  network (the other app on this server, Redis, the cloud's metadata
  address): a site's address, and every request the page makes, must lead
  to a public internet address, or it is not opened.

  Reference study (27 September 2026): the same visit also takes a taller
  desktop screenshot of the page (at most 4,000px) and reads an outline
  from it (its bands top to bottom, the hero's calls to action), still with
  no AI. The brief made from them is a separate, paid step.
*/

/** The tallest page screenshot kept, so a long page stays a sensible file. */
export const PAGE_SHOT_MAX_HEIGHT = 4_000;

/** Each band's text is cut at this many characters (the home page's look asks for more). */
export const BAND_TEXT_CAP = 1_500;

/* The page's bands, read in the browser: each top-level block with its heading, text, pictures and cards. */
export async function readBands(page: import("playwright-core").Page, opts: { textCap?: number } = {}): Promise<{ bands: RawReferenceBand[]; heroCalls: string[] }> {
  return page.evaluate((textCap) => {
    const fullHeight = document.documentElement.scrollHeight || 1;
    let root: Element = document.body;
    // Go into wrappers: one child holding most of the page.
    for (let depth = 0; depth < 6; depth += 1) {
      const kids = Array.from(root.children).filter((el) => (el as HTMLElement).offsetHeight > 0);
      if (kids.length === 1 && (kids[0] as HTMLElement).offsetHeight > fullHeight * 0.6) root = kids[0]!;
      else break;
    }
    // Go into the main area and any block holding most of the page, wrappers with one child included
    // (a page builder's main > div > div > sections, seen on finleypest.com 7 October 2026).
    const expand = (el: Element): Element[] =>
      el.children.length > 0 &&
      (el.tagName === "MAIN" || (["DIV", "SECTION", "ARTICLE"].includes(el.tagName) && (el as HTMLElement).offsetHeight > fullHeight * 0.6))
        ? Array.from(el.children).flatMap(expand)
        : [el];
    const blocks = Array.from(root.children).flatMap(expand).filter((el) => !["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META"].includes(el.tagName) && (el as HTMLElement).offsetHeight > 0);
    const bands = blocks.slice(0, 40).map((el) => {
      const html = el as HTMLElement;
      // innerText keeps a <br> as a break ("Services<br>Sacramento" is two words, not one).
      const h = el.querySelector<HTMLElement>("h1, h2, h3");
      const heading = (h?.innerText || h?.textContent || "").replace(/\s+/g, " ");
      const bgImages = Array.from(el.querySelectorAll<HTMLElement>("*")).slice(0, 400).filter((n) => /url\(/.test(getComputedStyle(n).backgroundImage)).length;
      const cardGroups = Array.from(el.querySelectorAll("ul, ol, div")).slice(0, 300).map((n) => {
        const kids = Array.from(n.children).filter((k) => (k as HTMLElement).offsetHeight > 60);
        return kids.length >= 2 && kids.every((k) => k.tagName === kids[0]!.tagName) ? kids.length : 0;
      });
      return {
        tag: el.tagName.toLowerCase(),
        heading: heading.trim(),
        text: (html.innerText ?? "").slice(0, textCap),
        images: el.querySelectorAll("img, picture, video").length + bgImages,
        cards: Math.min(12, Math.max(0, ...cardGroups)),
        hasForm: Boolean(el.querySelector("form")),
        height: html.offsetHeight,
      };
    });
    const heroCalls = Array.from(document.querySelectorAll<HTMLElement>("a, button"))
      .filter((a) => {
        const box = a.getBoundingClientRect();
        return box.top >= 0 && box.top < 900 && box.width > 60 && box.height > 28 && (a.innerText ?? "").trim().length > 1;
      })
      .map((a) => a.innerText.trim())
      .filter((t) => /call|quote|estimate|book|schedule|contact|get|request|free|\(\d{3}\)|\d{3}[-. ]\d{3}/i.test(t))
      .slice(0, 6);
    return { bands, heroCalls };
  }, opts.textCap ?? BAND_TEXT_CAP);
}


type Lookup = (hostname: string) => Promise<string[]>;
let lookup: Lookup = async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/** Only for tests: how host names become addresses. */
export function setLookupForTesting(fn: Lookup | null): void {
  lookup = fn ?? (async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address));
}

export { isPrivateAddress };

/* Why this address can't be opened, or null when it may. */
export async function refusePrivate(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That isn't a web address.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Only http and https addresses are opened.";
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "That address points at a private network, so it isn't opened.";
  }
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  if (addresses.length === 0) return "No website answers at that address.";
  if (addresses.some(isPrivateAddress)) return "That address points at a private network, so it isn't opened.";
  return null;
}

/* Every request a page makes goes only to public addresses (each host checked once). */
export async function routePublicOnly(page: Page): Promise<void> {
  const checked = new Map<string, boolean>();
  await page.route("**/*", async (route) => {
    const target = route.request().url();
    if (target.startsWith("data:") || target.startsWith("blob:")) return route.continue();
    let host: string;
    try {
      host = new URL(target).host;
    } catch {
      return route.abort();
    }
    if (!checked.has(host)) checked.set(host, (await refusePrivate(target)) === null);
    return checked.get(host) ? route.continue() : route.abort();
  });
}

export async function runLikedSitesJob(job: LikedSitesJobData, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const rows = await db
    .select()
    .from(likedSiteShot)
    .where(and(eq(likedSiteShot.projectId, job.projectId), eq(likedSiteShot.status, "queued")));

  for (const row of rows) {
    const refused = await refusePrivate(row.url);
    if (refused) {
      await db.update(likedSiteShot).set({ status: "failed", failureReason: refused }).where(eq(likedSiteShot.id, row.id));
      continue;
    }
    const context = await publicSiteContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1 });
    const checked = new Map<string, boolean>();
    try {
      const page = await context.newPage();
      // Every request the page makes, not only the first: a public page may still ask for a private address.
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
        let host: string;
        try {
          host = new URL(url).host;
        } catch {
          return route.abort();
        }
        if (!checked.has(host)) checked.set(host, (await refusePrivate(url)) === null);
        return checked.get(host) ? route.continue() : route.abort();
      });
      await page.goto(row.url, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const shot = await page.screenshot({ type: "jpeg", quality: 70 });
      const key = `${projectStoragePrefix(job.projectId)}intake/liked-sites/${row.id}.jpg`;
      await storage.put(key, shot, "image/jpeg");

      // The taller shot and the outline are extras: a page that fights them still keeps its first screen.
      let pageKey: string | null = null;
      let outline: ReferenceOutline | null = null;
      try {
        const height = Math.min(PAGE_SHOT_MAX_HEIGHT, await page.evaluate(() => document.documentElement.scrollHeight));
        const tall = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.max(VIEWPORT.height, height) } });
        pageKey = `${projectStoragePrefix(job.projectId)}intake/liked-sites/${row.id}-page.jpg`;
        await storage.put(pageKey, tall, "image/jpeg");
        const read = await readBands(page);
        outline = outlineReference(read.bands, read.heroCalls);
      } catch (error) {
        console.warn(`Reference ${row.url}: the page shot or outline couldn't be read:`, error instanceof Error ? error.message : error);
      }
      await db
        .update(likedSiteShot)
        .set({ status: "done", imageKey: key, pageImageKey: pageKey, outline, failureReason: null, takenAt: new Date() })
        .where(eq(likedSiteShot.id, row.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = /timeout/i.test(message)
        ? "The site didn't finish loading within 30 seconds."
        : /ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)
          ? "No website answers at that address."
          : "The site couldn't be opened.";
      await db.update(likedSiteShot).set({ status: "failed", failureReason: reason }).where(eq(likedSiteShot.id, row.id));
    } finally {
      await context.close();
    }
  }
}

/*
  A status-only request connected to the address that was checked (14
  October 2026; CodeRabbit, PR #13): the booking/review link check needs
  only the status and the Location, so the body is never read and the
  connection is closed at once. Shaped like fetch for checkIntegrationLinks.
*/
export const pinnedStatusFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const get = url.protocol === "https:" ? https.request : http.request;
  return new Promise<Response>((resolve, reject) => {
    const request = get(url, { method: init?.method ?? "GET", lookup: publicOnlyLookup, signal: init?.signal ?? undefined, headers: (init?.headers ?? {}) as Record<string, string> }, (response) => {
      const location = response.headers.location;
      response.destroy();
      resolve(new Response(null, { status: response.statusCode ?? 502, headers: location ? { location } : {} }));
    });
    request.on("error", reject);
    request.end();
  });
}) as typeof fetch;
