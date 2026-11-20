import type { Page } from "playwright-core";

/*
  Loading a page TAWD made itself (Jason, 5 November 2026, gap 8: New Dawn
  Awning's free Build & preview check failed with "page.setContent: Timeout
  30000ms exceeded - waiting until load"). Every page the worker generates
  and opens in Chromium goes through here: it waits for the page's
  structure (the HTML read, DOMContentLoaded) with an explicit limit, then
  gives its pictures, styles and fonts a short while more and carries on
  whether or not they finished. A slow or never-answering resource can no
  longer stop a step. Only a page whose structure can't be read in time
  fails, with a plain message (PageLoadError).

  Real client websites (home-look.ts, liked-sites.ts) keep their own reads:
  they are not TAWD's pages and have their own limits and messages.
*/

/** The most a page's structure may take: the HTML handed over and read. */
export const STRUCTURE_TIMEOUT_MS = 60_000;
/** After the structure, the most the worker waits for pictures, styles and fonts before carrying on. */
export const SETTLE_MS = 15_000;
/** The most the worker waits for the page's fonts to be ready before carrying on. */
export const FONTS_MS = 5_000;

export class PageLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PageLoadError";
  }
}

export interface LoadOptions {
  /** What the page is, for the message ("The style kit's preview"). */
  what?: string;
  /** A free step: the message may say nothing was spent. Left out after a paid step (the AI call is already charged). */
  free?: boolean;
  structureMs?: number;
  settleMs?: number;
}

function plain(what: string | undefined, free: boolean | undefined, error: unknown): PageLoadError {
  const name = what ?? "A page TAWD made";
  const timedOut = error instanceof Error && /timeout/i.test(error.message);
  const spent = free ? " Nothing was spent." : "";
  return new PageLoadError(
    timedOut
      ? `${name} couldn't be opened in the browser in time (its HTML took over a minute to read; usually the page is far too large).${spent} Try again; if it happens again, tell an admin.`
      : `${name} couldn't be opened in the browser (${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}).${spent} Try again; if it happens again, tell an admin.`,
    { cause: error },
  );
}

/* After the structure: pictures, styles and fonts get a short while, then the step carries on. True when everything loaded. */
async function settle(page: Page, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  // Never throws: a stand-in page with no load state (the tests') counts as loaded, the same as carrying on.
  if (typeof page.waitForLoadState !== "function") return true;
  return Promise.resolve()
    .then(() => page.waitForLoadState("load", { timeout: ms }))
    .then(
      () => true,
      () => false,
    );
}

/**
 * Puts TAWD's own HTML in the page: structure first (with a limit), then a
 * bounded wait for the rest. Resolves true when everything loaded, false
 * when the step carries on without some of it.
 */
export async function loadHtml(page: Page, html: string, options: LoadOptions = {}): Promise<boolean> {
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: options.structureMs ?? STRUCTURE_TIMEOUT_MS });
  } catch (error) {
    throw plain(options.what, options.free, error);
  }
  return settle(page, options.settleMs ?? SETTLE_MS);
}

/** Opens one of TAWD's own pages by address (the worker's local server for a built site), the same way. */
export async function openPage(page: Page, url: string, options: LoadOptions = {}): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.structureMs ?? STRUCTURE_TIMEOUT_MS });
  } catch (error) {
    throw plain(options.what, options.free, error);
  }
  return settle(page, options.settleMs ?? SETTLE_MS);
}

/** Waits for the page's fonts, at most a few seconds: a font that never arrives is drawn in its fallback. */
export async function fontsReady(page: Page, ms = FONTS_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
