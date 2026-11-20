import type { Browser, BrowserContext, BrowserContextOptions, Request, Route } from "playwright-core";
import { EMBED_STAND_IN_LABEL } from "@tawd/core/mockups";
import { publicProxy } from "./public-proxy";

/*
  Every Chrome page the worker opens starts here (option B, Jason 22 October
  2026; built 3 November). A page TAWD built, or the AI wrote, may load only:
  inline content (data:, blob:, about:), Google Fonts, and the addresses the
  caller names (the worker's own little server for a built site). Anything
  else is refused, so a page can never reach out to the internet or to a
  private address while it is photographed or checked.

  The lock sits on the context, so it covers every tab in it, popups too.
  Routes a caller adds on a page still run first (Playwright gives page
  routes precedence); whatever they don't handle falls through to here.

  Clients' real websites (the current-site look, sites they like) are
  opened with `publicSiteContext` instead: their pages add the "public
  addresses only" route themselves (`routePublicOnly`).

  A test (locked-context.test.ts) fails if any other file calls
  `newContext` or `browser.newPage`, so a new page can't skip the lock.
*/

const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const INLINE = /^(data|blob|about):/;

/** Whether a request may go out from a locked page. Pure, for the tests. */
export function lockedAllows(url: string, origins: readonly string[]): boolean {
  if (INLINE.test(url) || FONTS.test(url)) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return origins.includes(origin);
}

/** The origin of an address, or null when it isn't one (HTML passed instead). */
export function originOf(address: string): string | null {
  if (!/^https?:\/\//.test(address)) return null;
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
}

/*
  A refused frame inside a page (a map, booking widget or video from another
  site) gets a plain labeled box instead of Chrome's error page, so neither
  the checks nor the Creative Director mistake it for a broken section.
*/
export const EMBED_STAND_IN_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#eceef1;color:#5f6773;font:14px/1.4 system-ui,sans-serif;text-align:center">${EMBED_STAND_IN_LABEL}</body></html>`;

/** Whether a request loads a frame inside a page (not the page itself, not a popup). */
function isEmbeddedFrame(request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() !== null;
  } catch {
    return false;
  }
}

/** A refused request's host, for the log (never the full address: it can carry a query). */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url.split(":")[0]!;
  } catch {
    return "(unreadable address)";
  }
}

/**
 * A browser context for TAWD's own pages. `allow` lists extra origins
 * (for example the worker's local server, `http://127.0.0.1:PORT`).
 */
export async function ownPageContext(
  browser: Browser,
  options: BrowserContextOptions = {},
  allow: readonly (string | null | undefined)[] = [],
): Promise<BrowserContext> {
  const origins = allow.map((a) => (a ? originOf(a) : null)).filter((a): a is string => Boolean(a));
  const context = await browser.newContext(options);
  const refused = new Set<string>();
  await context.route("**/*", (route: Route) => {
    const url = route.request().url();
    if (lockedAllows(url, origins)) return route.continue();
    const host = hostOf(url);
    if (!refused.has(host)) {
      refused.add(host);
      // One line per host per page set: enough to spot a page relying on something from elsewhere.
      console.warn(`[locked page] refused a request to ${host}`);
    }
    if (isEmbeddedFrame(route.request())) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: EMBED_STAND_IN_HTML });
    return route.abort();
  });
  return limitPages(context);
}

/**
 * A browser context for a client's real website. Every request goes through
 * the worker's public-only proxy (C1, public-proxy.ts): redirects, pictures
 * and scripts included, to the address the proxy checked. `<-loopback>`
 * sends 127.0.0.1 and localhost through it too (Chromium skips the proxy for
 * them by default). Each page still adds `routePublicOnly` as a second wall.
 */
export async function publicSiteContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return limitPages(await browser.newContext({ ...options, proxy: { server: await publicProxy(), bypass: "<-loopback>" } }));
}

/*
  C10 (audit F-037, Jason 12 November 2026: "keep the speed and add the
  cap"). The worker runs concepts, copies and drafts side by side in one
  shared Chrome, so "one render at a time" was never true; what a 2 GB
  container can't afford is many open pages at once. Every page opened in
  any context made here waits for one of PAGE_SLOTS (TAWD_PAGES_AT_ONCE,
  default 3) and gives it back when it closes, or when its context closes.

  A job that already holds a page and asks for a second while every slot is
  taken by others would wait forever, so a wait longer than SLOT_WAIT_MS
  goes ahead anyway and says so: memory is a pressure, a stuck job is a
  failure. That escape is bounded (CodeRabbit #81): at most PAGE_SLOTS pages
  may be open beyond the cap, so the hard ceiling is twice the cap; a waiter
  that finds the ceiling reached keeps waiting (and logs it) instead of
  opening one more. A deadlock needs only one way out, not an unlimited one.
  That second wait is bounded too (CodeRabbit #81, second review): after
  SLOT_GIVE_UP_MS in all, the waiter leaves the queue and its newPage()
  fails with a plain error, so the job fails (and is retried or reported)
  instead of hanging, and the ceiling is never passed to recover.

  A slot given back goes straight to the first waiter (the count is not
  lowered and raised again), so a caller arriving in between can't take it
  and push the count over the cap. While the count is over the cap (after
  an escape) a slot given back is not handed on, it just lowers the count.
*/
export const PAGE_SLOTS = Math.max(1, Number(process.env.TAWD_PAGES_AT_ONCE) || 3);
export const SLOT_WAIT_MS = 2 * 60_000;
export const SLOT_GIVE_UP_MS = 10 * 60_000;
let pagesOpen = 0;
const waiting: (() => void)[] = [];

/** How many pages are open now, and how many are waiting for a slot (for tests and the log). */
export function pageSlots(): { open: number; waiting: number } {
  return { open: pagesOpen, waiting: waiting.length };
}

/* Resolves holding a slot: the count already includes it. */
async function takeSlot(): Promise<void> {
  if (pagesOpen < PAGE_SLOTS) {
    pagesOpen += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let waited = 0;
    const go = () => {
      clearTimeout(timer);
      resolve();
    };
    const leave = () => {
      const at = waiting.indexOf(go);
      if (at >= 0) waiting.splice(at, 1);
    };
    const arm = () => {
      timer = setTimeout(() => {
        waited += SLOT_WAIT_MS;
        if (pagesOpen >= PAGE_SLOTS * 2) {
          if (waited >= SLOT_GIVE_UP_MS) {
            leave();
            reject(new Error(`No browser page came free in ${SLOT_GIVE_UP_MS / 60_000} minutes (${pagesOpen} open, cap ${PAGE_SLOTS}, ceiling ${PAGE_SLOTS * 2}); stopped waiting.`));
            return;
          }
          console.warn(`[browser] still waiting for a page slot after ${waited / 1000}s (${pagesOpen} open, cap ${PAGE_SLOTS}, ceiling ${PAGE_SLOTS * 2})`);
          arm();
          return;
        }
        leave();
        pagesOpen += 1;
        console.warn(`[browser] waited ${waited / 1000}s for a page slot (${pagesOpen} open, cap ${PAGE_SLOTS}); opening anyway`);
        resolve();
      }, SLOT_WAIT_MS);
    };
    arm();
    waiting.push(go);
  });
}

function giveSlot(): void {
  const next = pagesOpen <= PAGE_SLOTS ? waiting.shift() : undefined;
  if (next) next();
  else pagesOpen = Math.max(0, pagesOpen - 1);
}

export function limitPages(context: BrowserContext): BrowserContext {
  const open = context.newPage.bind(context);
  context.newPage = async () => {
    await takeSlot();
    let given = false;
    const give = () => {
      if (given) return;
      given = true;
      giveSlot();
    };
    try {
      const page = await open();
      page.once("close", give);
      context.once("close", give);
      return page;
    } catch (error) {
      give();
      throw error;
    }
  };
  return context;
}
