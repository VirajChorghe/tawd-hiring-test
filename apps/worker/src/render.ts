import { chromium, type Browser, type Page } from "playwright-core";

import { bandKinds, checkRhythm, type PageBand } from "@tawd/core/mockups";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml } from "./page-load";
import { countSections } from "@tawd/core/mockups";

/*
  Turning the HTML into pictures.

  Two deliberate limits, both about memory. The droplet is shared with a
  client-facing app, and Chromium is the largest thing TAWD runs.

  The full-page image renders at 1x rather than 2x. A 1440-wide page six
  thousand pixels tall is already eight megapixels; at 2x it is thirty-four,
  and that bitmap lives in memory while it is encoded. The above-the-fold
  crop - the part a client actually studies - is rendered at 2x, where it is
  only 1440 by 900 to start with.

  And the page height is capped. A runaway layout should produce a truncated
  image and a warning, not an out-of-memory kill that takes a neighbouring
  application with it.
*/

export const VIEWPORT = { width: 1440, height: 900 };
const MAX_FULL_PAGE_HEIGHT = 12_000;

export interface RenderResult {
  fullPage: Buffer;
  fold: Buffer;
  heightPx: number;
  truncated: boolean;
  /** Where each band sits, in pixels down the page, with a short name. */
  bands: PageBand[];
  /** How tall the full-page picture is (the page, up to the height cap). */
  imageHeightPx: number;
}

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args: [
      // The container has a small /dev/shm; without this Chromium crashes
      // on large pages rather than falling back to disk.
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
    ],
  });
}

/*
  Renders one at a time on the 4 GB droplet (CLAUDE.md): a process-wide
  slot. The main queue's jobs that open their own Chromium (withBrowser)
  and the current-site read's look (home-look.ts) each wait for it, so a
  third-party page never loads beside a render (Fable's review L5). Jobs
  sharing one browser (copies, concepts) keep their own limits.
*/
let renderTail: Promise<void> = Promise.resolve();

export async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const before = renderTail;
  let release!: () => void;
  renderTail = new Promise<void>((resolve) => (release = resolve));
  await before;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  return withRenderSlot(async () => {
    const browser = await launchBrowser();
    try {
      return await fn(browser);
    } finally {
      // Closed after every job rather than kept warm: idle Chromium is memory
      // this droplet would rather give to something else.
      await browser.close();
    }
  });
}

/*
  One Chromium shared by jobs running at once (28 September 2026): launched
  by the first, closed when the last finishes. Each job opens its own pages
  in it, so several copies or concepts cost one browser, not several.
*/
let shared: { browser: Promise<Browser>; users: number } | null = null;

export async function withSharedBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  if (!shared) shared = { browser: chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"] }), users: 0 };
  const entry = shared;
  entry.users += 1;
  try {
    return await fn(await entry.browser);
  } finally {
    entry.users -= 1;
    if (entry.users === 0) {
      if (shared === entry) shared = null;
      await (await entry.browser.catch(() => null))?.close().catch(() => undefined);
    }
  }
}

/*
  How the full-page picture is taken (9 November 2026, Sample Rooter).

  A clip taller than the viewport is only captured when fullPage is true:
  Playwright stopped capturing beyond the viewport by default, so a clip
  on its own gives the first screen and nothing else. A page over the
  height cap used to be shot that way, so from the version where Easy
  Rooter's concept passed 12,000px every saved picture was its hero alone
  — while the checks and the Creative Director (whose slices pass
  fullPage: true, see renderForReview) went on seeing the whole page. The
  page was never broken; only its photograph was.
*/
export function fullPageShotOptions(heightPx: number): { type: "png"; fullPage: true; clip?: { x: number; y: number; width: number; height: number } } {
  const whole = { type: "png" as const, fullPage: true as const };
  return heightPx > MAX_FULL_PAGE_HEIGHT
    ? { ...whole, clip: { x: 0, y: 0, width: VIEWPORT.width, height: MAX_FULL_PAGE_HEIGHT } }
    : whole;
}

export interface RenderOptions {
  /**
   * Whether the page may run JavaScript while it is rendered. True (the default)
   * keeps what generated concepts have always had; pass false for a page the
   * team uploaded, which is untrusted and needs no script to be photographed.
   */
  javaScript?: boolean;
}

export async function renderConcept(
  browser: Browser,
  html: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const context = await ownPageContext(browser, {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // The page is a mockup, not a site; it should never talk to anything. An uploaded page is rendered with script off.
    javaScriptEnabled: options.javaScript ?? true,
    offline: false,
  });

  try {
    const page = await context.newPage();

    /*
      Only Google Fonts may load. Everything else is blocked: a mockup must
      not depend on the internet, and a blocked request is also how a page
      that tried to hotlink a stock photo gets caught.
    */
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith("data:") ||
        url.startsWith("about:") ||
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)
      ) {
        void route.continue();
        return;
      }
      void route.abort();
    });

    await loadHtml(page, html);

    // Web fonts settle a moment after load and change every measurement.
    await fontsReady(page);
    await page.waitForTimeout(400);

    const heightPx = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    const truncated = heightPx > MAX_FULL_PAGE_HEIGHT;
    const bands = await readBands(page);

    const fold = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });

    const fullPage = await page.screenshot(fullPageShotOptions(heightPx));

    return {
      fullPage,
      fold,
      heightPx,
      truncated,
      bands,
      imageHeightPx: truncated ? MAX_FULL_PAGE_HEIGHT : heightPx,
    };
  } finally {
    await context.close();
  }
}

/*
  The page's bands as rendered (2 October 2026): the same parts
  splitSections cuts the source into, in pixels, each named by its first
  heading (or its element), so a pin can be tied to its section.
*/
async function readBands(page: Page): Promise<PageBand[]> {
  const found: unknown = await page
    .evaluate(() => {
      const bandLabels = true;
      const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
      const topLevel = (parent: Element) => Array.from(parent.children).filter((e) => !skip.has(e.tagName));
      let bands = topLevel(document.body).flatMap((e) => (e.tagName === "MAIN" ? topLevel(e) : [e]));
      if (bands.length === 1) bands = topLevel(bands[0]!);
      return bands.map((band) => {
        const box = band.getBoundingClientRect();
        const top = box.top + window.scrollY;
        const heading = band.querySelector("h1, h2, h3")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const tag = band.tagName.toLowerCase();
        const name = tag === "header" ? "Header" : tag === "footer" ? "Footer" : heading || tag;
        return { top: Math.round(top), bottom: Math.round(top + box.height), label: bandLabels ? name.slice(0, 60) : "" };
      });
    })
    .catch(() => []);
  return Array.isArray(found) ? (found as PageBand[]) : [];
}

/*
  The checks that need a real browser.

  Contrast is the reason this exists: it depends on computed styles, which
  only a rendering engine knows. Reading the HTML tells you nothing about
  what color a heading ends up.
*/
export interface RenderedCheck {
  id: string;
  severity: "fail" | "warn" | "info";
  message: string;
  /** The bands of the page it is in; see sections.ts for what a band is. */
  sections?: number[];
}

/*
  The render check (27 September 2026: an unchecked page shipped with no
  footer). Every build is rendered at 1440px and must have its footer and
  every planned band (a hero with the one heading, the services, a way to
  get in touch), nothing clipped, and no text over the faces in a photo of
  people. Each is a fail, fixed by the usual fix rounds before any review.
*/
export interface RenderExpectations {
  /** The intake's service names: at least two (or the only one) must be on the page. */
  services?: string[];
  /** The colour rhythm for this concept's direction (8 October 2026); hasPhotos when real photos exist to lead a band. */
  rhythm?: { brandColors: string[]; direction: string; hasPhotos?: boolean };
  /** The layout rules from Jason's comments, on TAWD's own concepts only (8 October 2026). */
  pageRules?: boolean;
  /**
   * The client's photos the page hasn't used yet, by token (5 November 2026):
   * with any left, an empty picture area or a labeled "Photo:" frame fails.
   * Left out: the empty-picture check doesn't run (a copy of the designer's design).
   */
  unusedPhotoTokens?: string[];
}

/*
  Deliberately far below anything a real concept could be (CodeRabbit,
  PR #59: this is a `fail`, so a false one costs a paid fix round). A page
  of five bands or more that renders no taller than its own first screen
  is not a short page — it is a page whose bands are not being laid out.
*/
const SHORTEST_REAL_PAGE = VIEWPORT.height + 100;
const ENOUGH_BANDS_TO_JUDGE = 5;

/*
  What the browser made of the page, against what the markup asked for
  (9 November 2026).

  Nothing had ever compared the two. Every check asked whether something
  was present — an H1, a title, a phone link, a form, a photo — and all of
  them pass on a page that is nothing but its hero, because the hero holds
  every one of them. These two ask instead whether the page the browser
  laid out is the page the markup describes: a document whose height has
  collapsed, and bands that are in the markup but take up no room.
*/
async function collapseIssues(page: Page, html: string): Promise<RenderedCheck[]> {
  // Counted on the markup alone: a "<section" inside a script string or a comment is not a band (CodeRabbit, PR #59).
  const inMarkup = countSections(html);
  if (inMarkup < ENOUGH_BANDS_TO_JUDGE) return [];

  /*
    Counted the same way on both sides: every <section> in the markup
    against every <section> the browser gave a height to. (Counting
    top-level bands here instead would call a page with sections nested
    inside sections broken when it is perfectly sound.)
  */
  const laidOut = await page
    .evaluate(() => ({
      height: document.documentElement.scrollHeight,
      standing: Array.from(document.querySelectorAll("section")).filter((s) => s.getBoundingClientRect().height >= 40).length,
    }))
    .catch(() => null);
  if (!laidOut) return [];

  const issues: RenderedCheck[] = [];
  if (laidOut.height < SHORTEST_REAL_PAGE) {
    issues.push({
      id: "structure.collapsed",
      severity: "fail",
      message: `The page renders only ${laidOut.height}px tall — barely one screen — though its markup has ${inMarkup} sections. Something is holding the rest of the page out of the layout (a container that is never closed, a fixed height, or overflow hidden on a wrapper). Build the page so every band stacks down the document.`,
    });
  } else if (laidOut.standing * 2 < inMarkup) {
    issues.push({
      id: "structure.bands_missing",
      severity: "fail",
      message: `Only ${laidOut.standing} of the page's ${inMarkup} sections take up any room on screen. The rest are in the markup but have no height, so nobody sees them.`,
    });
  }
  return issues;
}

export async function runRenderedChecks(
  browser: Browser,
  html: string,
  expected: RenderExpectations = {},
): Promise<RenderedCheck[]> {
  const context = await ownPageContext(browser, {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });

  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith("data:") ||
        url.startsWith("about:") ||
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)
      ) {
        void route.continue();
        return;
      }
      void route.abort();
    });

    await loadHtml(page, html);
    await fontsReady(page);

    const found = await page.evaluate((expectations) => {
      const issues: { id: string; severity: "fail" | "warn" | "info"; message: string; sections?: number[] }[] =
        [];

      /*
        The page's bands, by the same rule as sections.ts: the top-level
        elements of <body>, a <main> opened into its children, and a single
        wrapper opened too.
      */
      const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
      const topLevel = (parent: Element) => Array.from(parent.children).filter((e) => !skip.has(e.tagName));
      let bands = topLevel(document.body).flatMap((e) => (e.tagName === "MAIN" ? topLevel(e) : [e]));
      if (bands.length === 1) bands = topLevel(bands[0]!);
      const sectionOf = (element: Element) => bands.findIndex((band) => band === element || band.contains(element));
      const sectionsOf = (elements: Element[]) =>
        [...new Set(elements.map(sectionOf).filter((i) => i >= 0))].sort((a, b) => a - b);
      const lowContrastElements: Element[] = [];

      const parse = (value: string): [number, number, number] | null => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return null;
        const parts = m[1]!.split(",").map((p) => parseFloat(p.trim()));
        if (parts.length < 3) return null;
        return [parts[0]!, parts[1]!, parts[2]!];
      };

      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };

      const luminance = ([r, g, b]: [number, number, number]) =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

      const ratio = (
        a: [number, number, number],
        b: [number, number, number],
      ) => {
        const la = luminance(a);
        const lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };

      /* A colour's alpha: 1 for rgb(), the fourth value of rgba() (Chromium writes "rgba(r, g, b, a)"). */
      const alphaOf = (value: string): number => {
        const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(value);
        return m ? Math.max(0, Math.min(1, parseFloat(m[1]!))) : /rgba?\(/.test(value) ? 1 : 0;
      };
      const mix = (top: [number, number, number], under: [number, number, number], alpha: number): [number, number, number] => [
        top[0] * alpha + under[0] * (1 - alpha),
        top[1] * alpha + under[1] * (1 - alpha),
        top[2] * alpha + under[2] * (1 - alpha),
      ];

      /*
        The colour actually behind an element (5 November 2026, New Dawn
        Awning's Concept A): every see-through background up the tree laid
        over the next, down to the first solid one (or the white page). A
        half-transparent card used to count as solid, or not at all.
      */
      const backgroundOf = (element: Element): [number, number, number] => {
        const layers: { color: [number, number, number]; alpha: number }[] = [];
        let node: Element | null = element;
        while (node) {
          const style = getComputedStyle(node);
          const color = parse(style.backgroundColor);
          const alpha = color ? alphaOf(style.backgroundColor) : 0;
          if (color && alpha > 0) {
            layers.push({ color, alpha });
            if (alpha >= 0.999) break;
          }
          node = node.parentElement;
        }
        let result: [number, number, number] = [255, 255, 255];
        for (const layer of layers.reverse()) result = mix(layer.color, result, layer.alpha);
        return result;
      };

      /* How faded an element is: its own opacity times every ancestor's. */
      const opacityOf = (element: Element): number => {
        let value = 1;
        for (let node: Element | null = element; node; node = node.parentElement) value *= parseFloat(getComputedStyle(node).opacity || "1");
        return value;
      };

      let lowContrast = 0;
      let worst = 21;
      let worstText = "";

      /*
        Text over a photo or a gradient has no single background colour to
        read from the styles: an image or gradient in its own backgrounds
        (before any solid colour), or a picture painted underneath it. Those
        are set aside and measured from the pixels afterwards.
      */
      const pictures = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
        if (el.tagName === "IMG" || el.tagName === "VIDEO" || el.tagName === "PICTURE") return true;
        const bg = getComputedStyle(el).backgroundImage;
        return Boolean(bg) && bg !== "none";
      });
      const overPicture = (element: Element): boolean => {
        // The element whose solid colour is the backdrop; a picture inside it is painted over that colour.
        let owner: Element = document.documentElement;
        let node: Element | null = element;
        while (node) {
          const style = getComputedStyle(node);
          if (style.backgroundImage && style.backgroundImage !== "none") return true;
          const color = parse(style.backgroundColor);
          const alpha = /rgba\([^)]+,\s*([\d.]+)\)/.exec(style.backgroundColor);
          if (color && (!alpha || parseFloat(alpha[1]!) > 0.5)) {
            owner = node;
            break;
          }
          node = node.parentElement;
        }
        const box = element.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        return pictures.some((picture) => {
          if (picture === element || element.contains(picture) || picture.contains(element)) return false;
          if (picture !== owner && !owner.contains(picture)) return false;
          const p = picture.getBoundingClientRect();
          return p.width > 0 && cx >= p.left && cx <= p.right && cy >= p.top && cy <= p.bottom;
        });
      };
      const probes: { n: number; fg: [number, number, number]; alpha: number; required: number; text: string; section: number }[] = [];

      /*
        Every element that holds text itself (5 November 2026): a contact
        card's lines sit straight in a div, an address, a strong or a
        small, which the old list of tags never looked at.
      */
      const notText = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "TITLE"]);
      const textNodes = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
        (el) => !notText.has(el.tagName) && !(el instanceof SVGElement),
      );

      for (const element of textNodes) {
        const text = element.textContent?.trim() ?? "";
        if (text.length < 3) continue;
        // Only elements that hold text directly, so a wrapper is not counted.
        const ownText = Array.from(element.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent?.trim().length ?? 0) > 2,
        );
        if (!ownText) continue;

        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        /*
          Faded text is read as it shows (5 November 2026): the text colour's
          own alpha times the opacity of the element and its ancestors. Only
          text faded almost to nothing (an animation's starting state, a
          closed menu) is skipped.
        */
        const fade = opacityOf(element);
        if (fade < 0.1) continue;
        // Gradient text (the colour clipped to a background) has no single colour to measure.
        if (style.getPropertyValue("-webkit-text-fill-color").includes("rgba(0, 0, 0, 0)") && /text/.test(style.getPropertyValue("background-clip") || style.getPropertyValue("-webkit-background-clip"))) continue;

        const fg = parse(style.color);
        if (!fg) continue;
        const textAlpha = alphaOf(style.color) * fade;
        if (textAlpha <= 0) continue;

        const size = parseFloat(style.fontSize || "16");
        const weight = parseInt(style.fontWeight || "400", 10);
        // WCAG large text: 24px, or 18.66px when bold.
        const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
        const required = isLarge ? 3 : 4.5;

        if (overPicture(element)) {
          if (probes.length < 25) {
            element.setAttribute("data-tawd-probe", String(probes.length));
            probes.push({ n: probes.length, fg, alpha: textAlpha, required, text: text.slice(0, 40), section: sectionOf(element) });
          }
          continue;
        }

        const behind = backgroundOf(element);
        const value = ratio(mix(fg, behind, textAlpha), behind);
        if (value < required) {
          lowContrast += 1;
          lowContrastElements.push(element);
          if (value < worst) {
            worst = value;
            worstText = text.slice(0, 40);
          }
        }
      }

      // Reported after the texts over pictures are measured from the pixels.
      const contrast = { count: lowContrast, worst, worstText, sections: sectionsOf(lowContrastElements) };

      /* The phone must be reachable without scrolling. */
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) {
        const box = tel.getBoundingClientRect();
        if (box.top > 900) {
          issues.push({
            id: "conversion.tel.belowFold",
            severity: "fail",
            // The phone belongs in the header or the hero.
            sections: [0, 1].filter((i) => i < bands.length),
            message:
              "The phone number is below the fold at 1440 by 900. A stressed visitor should not have to scroll for it.",
          });
        }
      }

      /*
        The logo must show. Each uploaded logo on the page is marked with
        data-tawd-logo when its image goes in, so it can be found here. Its
        visible marks (the pixels that are not transparent, after any CSS
        filter such as brightness(0) invert(1)) are averaged and compared
        with the background behind it. A logo with a solid background of its
        own (a JPEG, say) carries its own contrast and is left alone.
      */
      let hiddenLogos = 0;
      let worstLogo = 21;
      const hiddenLogoElements: Element[] = [];
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img[data-tawd-logo]"))) {
        const box = img.getBoundingClientRect();
        if (box.width < 4 || box.height < 4 || !img.complete || img.naturalWidth === 0) continue;
        const style = getComputedStyle(img);
        if (style.visibility === "hidden" || style.display === "none") continue;

        const canvas = document.createElement("canvas");
        const w = Math.min(160, img.naturalWidth);
        const h = Math.max(1, Math.round((w / img.naturalWidth) * img.naturalHeight));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.filter = style.filter && style.filter !== "none" ? style.filter : "none";
        ctx.drawImage(img, 0, 0, w, h);
        let data: Uint8ClampedArray;
        try {
          data = ctx.getImageData(0, 0, w, h).data;
        } catch {
          continue;
        }

        let r = 0, g = 0, b = 0, weight = 0, opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3]! / 255;
          if (a > 0.95) opaque += 1;
          if (a < 0.2) continue;
          r += data[i]! * a;
          g += data[i + 1]! * a;
          b += data[i + 2]! * a;
          weight += a;
        }
        if (weight === 0) continue;
        if (opaque / (w * h) > 0.97) continue;

        const marks: [number, number, number] = [r / weight, g / weight, b / weight];
        const value = ratio(marks, backgroundOf(img));
        if (value < 1.8) {
          hiddenLogos += 1;
          hiddenLogoElements.push(img);
          worstLogo = Math.min(worstLogo, value);
        }
      }
      if (hiddenLogos > 0) {
        issues.push({
          id: "images.logo.invisible",
          severity: "fail",
          sections: sectionsOf(hiddenLogoElements),
          message: `The logo is almost invisible against its background (${worstLogo.toFixed(1)} to 1) in ${hiddenLogos === 1 ? "one place" : `${hiddenLogos} places`}. Put it on a background it contrasts with, or change its treatment: on a dark header show it white with CSS filter: brightness(0) invert(1); on a light header show it dark with filter: brightness(0). Keep the brand colors wherever the logo already shows clearly.`,
        });
      }

      /*
        Tap targets. 44px is a mobile rule; a desktop mockup is measured at
        1440 wide, so this is information only. The WordPress build checks
        it properly on mobile.
      */
      const small = Array.from(
        document.querySelectorAll("a, button, input[type=submit]"),
      ).filter((el) => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        return box.height < 44 && (el.textContent?.trim().length ?? 0) > 0;
      });
      if (small.length > 0) {
        issues.push({
          id: "a11y.tapTargets",
          severity: "info",
          message: `${small.length} tappable ${small.length === 1 ? "element is" : "elements are"} under 44px tall. Fine on desktop; checked on mobile in the WordPress build.`,
        });
      }

      /* Anything that spills sideways is a layout bug at this width. */
      if (document.documentElement.scrollWidth > 1460) {
        const wide = Array.from(document.body.querySelectorAll("*")).filter(
          (el) => el.getBoundingClientRect().right > window.innerWidth + 20,
        );
        issues.push({
          id: "layout.overflow",
          severity: "fail",
          sections: sectionsOf(wide),
          message: `The page is ${document.documentElement.scrollWidth}px wide at a 1440px viewport, so it scrolls sideways; it must be no wider than 1440px.`,
        });
      }

      /* The footer: a real one, at the bottom of the page. */
      const docHeight = document.documentElement.scrollHeight;
      const footer = Array.from(document.querySelectorAll<HTMLElement>("footer, [role=contentinfo]")).find((el) => {
        const box = el.getBoundingClientRect();
        return box.height >= 60 && box.bottom + window.scrollY >= docHeight - 240;
      });
      if (!footer) {
        issues.push({
          id: "render.footer",
          severity: "fail",
          sections: bands.length ? [bands.length - 1] : [],
          message:
            "The page has no footer at the bottom. Add a <footer> band after the last section with the business name, phone, service areas (when the intake has them), the logo and the small VML credit.",
        });
      }

      /* The planned bands: a hero with the heading, the services, a way to get in touch. */
      const missing: string[] = [];
      const h1 = document.querySelector("h1");
      if (!h1 || h1.getBoundingClientRect().top > 900) missing.push("a hero with the page's one heading in the first screen");
      const bodyText = (document.body.innerText || "").toLowerCase();
      const services = (expectations.services ?? []).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);
      if (services.length > 0) {
        const shown = services.filter((s) => bodyText.includes(s)).length;
        if (shown < Math.min(2, services.length)) missing.push("the services (at least two of the intake's services by name)");
      }
      if (!document.querySelector("form") && !document.querySelector('a[href^="tel:"]')) missing.push("a way to get in touch (the form or a tap-to-call link)");
      if (missing.length > 0) {
        issues.push({
          id: "render.sections",
          severity: "fail",
          message: `A planned section is missing from the rendered page: ${missing.join("; ")}.`,
        });
      }

      /* Clipped text: a box too small for its words, with the overflow hidden. */
      const hides = (el: Element) => {
        const st = getComputedStyle(el);
        return /hidden|clip/.test(st.overflow + st.overflowX + st.overflowY);
      };
      const ownsText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent?.trim().length ?? 0) > 2);
      const clipped: Element[] = [];
      for (const element of textNodes) {
        if (!ownsText(element)) continue;
        const box = element.getBoundingClientRect();
        // Screen-reader-only text is clipped on purpose.
        if (box.width <= 2 || box.height <= 2) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const tooTall = element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 4;
        const tooWide = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 4;
        if ((tooTall || tooWide) && hides(element)) {
          clipped.push(element);
          continue;
        }
        const parent = element.parentElement;
        if (parent && hides(parent)) {
          const p = parent.getBoundingClientRect();
          if (p.width > 2 && p.height > 2 && (box.right > p.right + 4 || box.bottom > p.bottom + 4 || box.left < p.left - 4)) clipped.push(element);
        }
      }
      if (clipped.length > 0) {
        issues.push({
          id: "render.clipped",
          severity: "fail",
          sections: sectionsOf(clipped),
          message: `${clipped.length} text ${clipped.length === 1 ? "element is" : "elements are"} cut off by a box too small for it (first: "${(clipped[0]!.textContent ?? "").trim().slice(0, 40)}"). Let the box grow with its text; never hide overflowing words.`,
        });
      }

      /*
        Text over faces: a photo of people (the client's team photos, marked
        when their images go in, or a stock frame asking for people) keeps
        its upper middle, where faces usually are, clear of text.
      */
      const PEOPLE = /\b(people|person|team|crew|staff|family|homeowners?|customers?|technicians?|workers?|plumbers?|electricians?|man|woman|men|women|couple|portrait|smiling)\b/i;
      const peoplePictures = Array.from(document.querySelectorAll<HTMLElement>("img[data-tawd-people], [data-tawd-photo][data-tawd-stock]")).filter(
        (el) => el.tagName === "IMG" || PEOPLE.test(el.getAttribute("data-tawd-photo") ?? ""),
      );
      const overFaces: Element[] = [];
      for (const picture of peoplePictures) {
        const p = picture.getBoundingClientRect();
        if (p.width < 120 || p.height < 120) continue;
        const zone = { left: p.left + p.width * 0.15, right: p.right - p.width * 0.15, top: p.top + p.height * 0.1, bottom: p.top + p.height * 0.6 };
        for (const element of textNodes) {
          if (element.closest(".tawd-stock-label")) continue;
          if (!ownsText(element)) continue;
          const b = element.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          const overlapX = Math.min(b.right, zone.right) - Math.max(b.left, zone.left);
          const overlapY = Math.min(b.bottom, zone.bottom) - Math.max(b.top, zone.top);
          if (overlapX > 20 && overlapY > 10) overFaces.push(element);
        }
      }
      if (overFaces.length > 0) {
        issues.push({
          id: "render.faceText",
          severity: "fail",
          sections: sectionsOf(overFaces),
          message: `Text sits over the upper middle of a photo of people, where their faces are ("${(overFaces[0]!.textContent ?? "").trim().slice(0, 40)}"). Move the text beside the photo or to its lower part, or place the photo so the faces are clear.`,
        });
      }

      /*
        A heading over one column only (8 October 2026, Jason on the
        official run's FAQ: "the FAQs should be in line with the container
        on the left, not with the eyebrow text"): in a band laid out in two
        columns side by side, one column starts with the band's label or
        heading and the other with content, so the content doesn't line up.
      */
      const headingish = (el: Element) =>
        /^H[1-3]$/.test(el.tagName) || /\b(eyebrow|kicker|overline|label|sec-head|section-head)\b/i.test(el.getAttribute("class") ?? "");
      const oneSided: number[] = [];
      bands.forEach((band, index) => {
        const bandBox = band.getBoundingClientRect();
        if (bandBox.width === 0) return;
        const queue: Element[] = [band];
        for (let seen = 0; queue.length && seen < 60; seen += 1) {
          const el = queue.shift()!;
          const kids = Array.from(el.children).filter((c) => !skip.has(c.tagName) && (c as HTMLElement).offsetHeight > 0);
          if (kids.length === 2) {
            const [a, b] = kids.map((k) => k.getBoundingClientRect());
            const sideBySide = b!.left >= a!.right - 8 && a!.width > bandBox.width * 0.25 && b!.width > bandBox.width * 0.25;
            if (sideBySide) {
              const firsts = kids.map((k) => k.firstElementChild ?? k);
              if (headingish(firsts[0]!) !== headingish(firsts[1]!)) oneSided.push(index);
              return;
            }
          }
          queue.push(...kids);
        }
      });
      if (expectations.pageRules && oneSided.length) {
        issues.push({
          id: "layout.headingOneColumn",
          severity: "fail",
          sections: oneSided,
          message: `Band${oneSided.length === 1 ? "" : "s"} ${oneSided.join(", ")} put${oneSided.length === 1 ? "s" : ""} the label and heading over one column only, so the two columns don't line up. Put the label and heading above both columns, full width.`,
        });
      }

      /*
        Gap 13, the rendered layout safety net (6 November 2026, New Dawn
        Concept B): the builder writes free-form inline CSS with nothing to
        catch a layout it breaks. Two checks, both deliberately conservative
        so a real build is never blocked by a false alarm.

        (a) A heading squeezed onto three or more lines while its column has
        room: New Dawn's `.why h2.title{max-width:20ch}` forced a short
        heading onto three lines even though its column was far wider. Only a
        heading pinched well under the width it could use counts; a genuinely
        long heading that fills its column is content, not a bug.
      */
      const wrapped: Element[] = [];
      const headings = new Set(
        Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, .title, .headline")),
      );
      for (const h of headings) {
        // A wrapper around another heading (a `.title` holding an <h2> and a
        // tagline) has a tall box that isn't one block of wrapping text; judge
        // the real heading, not its wrapper.
        if (/^(?:DIV|SECTION|HEADER|ARTICLE|ASIDE|SPAN)$/.test(h.tagName) && h.querySelector("h1, h2, h3, h4")) continue;
        const style = getComputedStyle(h);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const box = h.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        if ((h.textContent ?? "").trim().length < 8) continue;
        const fontSize = parseFloat(style.fontSize) || 16;
        let lineHeight = parseFloat(style.lineHeight);
        if (!Number.isFinite(lineHeight) || lineHeight < 1) lineHeight = fontSize * 1.2;
        // The text's own height: the border box less the heading's padding and
        // border, so a padded two-line heading isn't miscounted as three lines.
        const contentHeight =
          box.height -
          (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) -
          (parseFloat(style.borderTopWidth) || 0) - (parseFloat(style.borderBottomWidth) || 0);
        const lines = Math.round(contentHeight / lineHeight);
        if (lines < 3) continue;
        const parent = h.parentElement;
        if (!parent) continue;
        const ps = getComputedStyle(parent);
        // In a flex or grid parent the heading's width is set by the layout, not
        // by filling the block, so "narrower than the parent" isn't a reliable
        // sign of a width throttle — don't judge wrap there.
        if (/\b(?:flex|grid)\b/.test(ps.display)) continue;
        const available =
          parent.getBoundingClientRect().width - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0);
        if (available <= 0) continue;
        // Pinched well under the room it had: the mark of a width/max-width
        // throttle rather than a heading long enough to fill its column.
        if (box.width <= available * 0.7) wrapped.push(h);
      }
      if (expectations.pageRules && wrapped.length > 0) {
        issues.push({
          id: "layout.headingWrap",
          severity: "fail",
          sections: sectionsOf(wrapped),
          message: `A heading is squeezed onto three or more lines while its column has room ("${(wrapped[0]!.textContent ?? "").trim().slice(0, 40)}"). Widen it or drop the max-width so it uses the space; never force a short heading to wrap.`,
        });
      }

      /*
        (b) A grid item that spans more than one row or column and leaves a
        hole (New Dawn Concept B: `.svc-main{grid-row:1/3}` spanned two rows,
        so a cell was left empty and the other cards lost their place). Read
        the grid's resolved tracks, map every cell, and flag only an interior
        empty cell — one with a filled cell after it in reading order — when
        some child spans. A trailing gap (a normal partial last row) is left
        alone, so a legitimate grid is never blocked.
      */
      const toPx = (list: string) => list.split(" ").map((p) => parseFloat(p)).filter((n) => Number.isFinite(n));
      const gridHoles: Element[] = [];
      const grids = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) =>
        getComputedStyle(el).display.includes("grid"),
      );
      for (const grid of grids) {
        const gs = getComputedStyle(grid);
        const cols = toPx(gs.gridTemplateColumns);
        const rows = toPx(gs.gridTemplateRows);
        // Only a real two-dimensional grid with explicit tracks; implicit
        // auto-rows aren't reported here, and that's fine (fewer, surer hits).
        if (cols.length < 2 || rows.length < 2 || cols.length * rows.length > 60) continue;
        // The cell map below assumes the tracks start at the content box's edge.
        // When extra space is distributed (justify/align-content centre, space-*,
        // end) the tracks shift, so the map would be wrong: leave those grids be.
        const flush = (v: string) => /^(?:normal|start|flex-start|stretch)$/.test(v);
        if (!flush(gs.justifyContent) || !flush(gs.alignContent)) continue;
        // A display:contents wrapper is not itself a grid item; its children are,
        // so step through it when gathering the real items.
        const kids = Array.from(grid.children)
          .flatMap((c) => (getComputedStyle(c).display === "contents" ? Array.from(c.children) : [c]))
          .filter((c) => !skip.has(c.tagName))
          .filter((c) => {
            const st = getComputedStyle(c);
            if (st.display === "none" || st.visibility === "hidden" || st.position === "absolute" || st.position === "fixed") return false;
            const b = c.getBoundingClientRect();
            return b.width > 2 && b.height > 2;
          });
        if (kids.length < 3) continue;
        const spanOf = (a: string, b: string) => {
          if (a.startsWith("span ")) return parseInt(a.slice(5), 10) || 1;
          if (b.startsWith("span ")) return parseInt(b.slice(5), 10) || 1;
          const an = parseInt(a, 10);
          const bn = parseInt(b, 10);
          return Number.isFinite(an) && Number.isFinite(bn) ? Math.abs(bn - an) : 1;
        };
        const spans = kids.some((k) => {
          const st = getComputedStyle(k);
          return spanOf(st.gridRowStart, st.gridRowEnd) >= 2 || spanOf(st.gridColumnStart, st.gridColumnEnd) >= 2;
        });
        if (!spans) continue;
        const box = grid.getBoundingClientRect();
        const colGap = parseFloat(gs.columnGap) || 0;
        const rowGap = parseFloat(gs.rowGap) || 0;
        const xs: number[] = [];
        let x = box.left + (parseFloat(gs.borderLeftWidth) || 0) + (parseFloat(gs.paddingLeft) || 0);
        for (const w of cols) { xs.push(x); x += w + colGap; }
        const ys: number[] = [];
        let y = box.top + (parseFloat(gs.borderTopWidth) || 0) + (parseFloat(gs.paddingTop) || 0);
        for (const hgt of rows) { ys.push(y); y += hgt + rowGap; }
        const kidBoxes = kids.map((k) => k.getBoundingClientRect());
        // A cell counts as filled when a child overlaps its rectangle, not only
        // when a child sits under its centre: a top-aligned or narrower card
        // (align-items/justify-items other than stretch) still occupies its cell.
        const filled = (cl: number, ct: number, cr: number, cb: number) =>
          kidBoxes.some(
            (b) => Math.min(cr, b.right) - Math.max(cl, b.left) > 4 && Math.min(cb, b.bottom) - Math.max(ct, b.top) > 4,
          );
        const cells: boolean[] = []; // true = real cell filled, false = real cell empty; collapsed tracks skipped
        for (let r = 0; r < rows.length; r += 1) {
          for (let c = 0; c < cols.length; c += 1) {
            if (cols[c]! < 2 || rows[r]! < 2) continue; // a collapsed track is not a cell
            cells.push(filled(xs[c]!, ys[r]!, xs[c]! + cols[c]!, ys[r]! + rows[r]!));
          }
        }
        const lastFilled = cells.lastIndexOf(true);
        if (lastFilled > 0 && cells.slice(0, lastFilled).some((v) => !v)) gridHoles.push(grid);
      }
      if (expectations.pageRules && gridHoles.length > 0) {
        const band = sectionOf(gridHoles[0]!);
        issues.push({
          id: "layout.gridOrphan",
          severity: "fail",
          sections: sectionsOf(gridHoles),
          message: `A grid leaves an empty cell because an item spans more than one row or column${band >= 0 ? ` (band ${band})` : ""}. Fill every cell or change the span so the cards tile the grid with no gap.`,
        });
      }

      /*
        Each band's background as it looks (8 October 2026, the colour
        rhythm): the band's own colour or gradient, else a single child that
        fills it, else what shows through from behind. "image" for a photo.
      */
      const colourOf = (el: Element): string | null => {
        const s = getComputedStyle(el);
        if (s.backgroundImage && s.backgroundImage !== "none") {
          // A url() means a photo, even under a gradient scrim (the usual photo-hero pattern —
          // the gradient stop must not hide it; CodeRabbit PR #55). The builder can only
          // reference tawd-asset images, so a url is never a mere texture here.
          if (/url\(/i.test(s.backgroundImage)) return "image";
          const stop = /rgba?\([^)]+\)|#[0-9a-f]{3,6}\b/i.exec(s.backgroundImage);
          if (stop) return stop[0];
        }
        const c = s.backgroundColor;
        return c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c) ? c : null;
      };
      const backgrounds = bands.map((band) => {
        const own = colourOf(band);
        if (own) return own;
        const kids = Array.from(band.children).filter((c) => !skip.has(c.tagName));
        const bandHeight = band.getBoundingClientRect().height;
        const filler = kids.find((k) => bandHeight > 0 && k.getBoundingClientRect().height >= bandHeight * 0.9);
        const inner = filler ? colourOf(filler) : null;
        if (inner) return inner;
        if (band.querySelector(":scope > img, :scope > picture, :scope > video") && bandHeight > 0) return "image";
        for (let up = band.parentElement; up; up = up.parentElement) {
          const behind = colourOf(up);
          if (behind) return behind;
        }
        return "rgb(255, 255, 255)";
      });

      /*
        Empty picture areas (Jason, 4 November 2026, New Dawn Awning: "no
        empty cards"). A picture that didn't load, or a box shaped and named
        for a picture (an image, photo, media, thumb or cover class, or a
        figure) with nothing in it: no picture, drawing or text. With the
        client's photos still unused, a labeled "Photo: ..." frame counts
        too, since a real photo could be there.
      */
      if (expectations.unusedPhotoTokens) {
        const unused = expectations.unusedPhotoTokens;
        const MEDIA = /(^|[\s_-])(img|image|images|photo|photos|media|thumb|thumbnail|picture|pic|figure|gallery|cover|visual)([\s_-]|$)/i;
        const empty: Element[] = [];
        const holdsPicture = (el: Element) =>
          Boolean(el.querySelector("img, svg, video, picture, iframe, canvas, object")) ||
          [el, ...Array.from(el.querySelectorAll("*"))].some((n) => {
            const bg = getComputedStyle(n).backgroundImage;
            return Boolean(bg) && bg !== "none";
          });
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          if (empty.some((e) => e.contains(el))) continue;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const box = el.getBoundingClientRect();
          if (el.tagName === "IMG") {
            const img = el as HTMLImageElement;
            if (box.width >= 80 && box.height >= 60 && (!img.getAttribute("src") || (img.complete && img.naturalWidth === 0))) empty.push(el);
            continue;
          }
          if (box.width < 140 || box.height < 100) continue;
          // An overlay or a decoration laid over the picture (absolutely placed), or one drawn with ::before or ::after, isn't a picture area.
          if (style.position === "absolute" || style.position === "fixed") continue;
          if (["::before", "::after"].some((p) => {
            const bg = getComputedStyle(el, p).backgroundImage;
            return Boolean(bg) && bg !== "none";
          })) continue;
          const text = (el.innerText || "").trim();
          const named = el.tagName === "FIGURE" || MEDIA.test(`${typeof el.className === "string" ? el.className : ""} ${el.id}`);
          if (named && !text && !holdsPicture(el)) {
            empty.push(el);
            continue;
          }
          if (unused.length > 0 && /^photo\s*:/i.test(text) && text.length < 160 && !holdsPicture(el)) empty.push(el);
        }
        if (empty.length > 0) {
          const where = sectionsOf(empty);
          issues.push({
            id: "images.empty",
            severity: "fail",
            sections: where,
            message: unused.length > 0
              ? `${empty.length} picture ${empty.length === 1 ? "area is" : "areas are"} empty or a labeled placeholder while the client's own photos are unused. Put one of these in each, by its token: ${unused.slice(0, 8).join(", ")}. No empty card or image box.`
              : `${empty.length} picture ${empty.length === 1 ? "area is" : "areas are"} empty. Give each a labeled placeholder frame ("Photo: ...") or remove the empty box; never leave a blank image area on a card.`,
          });
        }
      }

      /*
        A line nobody can see (New Dawn Awning, 10 November 2026).

        Concept B's articles band drew a 1px rule above each post in white,
        on a white background, so the three posts ran together as bare text
        and the Creative Director marked the band down. Every colour check
        TAWD had only ever looked at TEXT, so a line drawn in the
        background's own colour was invisible to the checks as well as to
        the visitor.

        Deliberately narrow, because a border the colour of its background
        is also a real technique (the tab that cuts the line below it):

        - one bordered side only, so a box or a card is never touched;
        - 1 to 4px, the range a rule is drawn in;
        - no buttons, links or form controls, where the trick lives;
        - nothing absolutely placed, and nothing over a picture or gradient,
          where "the colour behind it" is not one colour;
        - and the colours must be all but identical (1.1 to 1), not merely
          subtle: #eeeeee on white is a quiet divider somebody chose, and
          sits well above that line.

        It is a warning, never a fail: the page is honest, and code fixes it
        in the same pass (rendered-fixes.ts), so no paid fix round is ever
        spent on it.

        The fix side measures this again rather than being handed the
        elements, because the checks run on a page that has not been
        numbered yet, so there is nothing here to name an element by. The
        two scans must stay in step; the canary measures both sides of the
        pair (rendered and fixRules) on one fixed page, so a drift between
        them shows up as a difference rather than as silence.
      */
      const SIDES = ["top", "right", "bottom", "left"] as const;
      const invisibleEdges: { element: Element; side: string }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || opacityOf(el) < 0.1) continue;
        if (style.position === "absolute" || style.position === "fixed") continue;
        /*
          Table parts are left alone as well (11 November 2026, a second
          read of this scan): a cell with a border the colour of its
          background is the oldest way of faking space between rows, and
          colouring it would draw a line where somebody deliberately drew
          none - the same reason links and buttons are skipped.
        */
        if (["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "TD", "TH", "TR", "TABLE", "THEAD", "TBODY", "TFOOT"].includes(el.tagName)) continue;
        if (el.closest("a, button") !== null) continue;
        if (style.backgroundImage !== "" && style.backgroundImage !== "none") continue;
        const box = el.getBoundingClientRect();
        if (box.width < 24 || box.height < 1) continue;
        const drawn = SIDES.filter((side) => {
          const width = parseFloat(style.getPropertyValue(`border-${side}-width`) || "0");
          const kind = style.getPropertyValue(`border-${side}-style`);
          return width >= 1 && kind !== "none" && kind !== "hidden";
        });
        if (drawn.length !== 1) continue;
        const side = drawn[0]!;
        const width = parseFloat(style.getPropertyValue(`border-${side}-width`) || "0");
        if (width > 4) continue;
        const value = style.getPropertyValue(`border-${side}-color`);
        const colour = parse(value);
        if (!colour || alphaOf(value) < 0.5) continue;
        if (ratio(colour, backgroundOf(el)) >= 1.1) continue;
        invisibleEdges.push({ element: el, side });
      }
      if (invisibleEdges.length > 0) {
        const count = invisibleEdges.length;
        issues.push({
          id: "design.invisibleRule",
          severity: "warn",
          sections: sectionsOf(invisibleEdges.map((e) => e.element)),
          message: `${count} ${count === 1 ? "line is" : "lines are"} drawn in the same colour as the background behind ${count === 1 ? "it" : "them"}, so ${count === 1 ? "it is" : "they are"} invisible. TAWD gives ${count === 1 ? "it" : "them"} a colour that can be seen: one of the brand's where one works on that background, otherwise plain near-black or near-white.`,
        });
      }

      return { issues, probes, contrast, backgrounds };
    }, expected);

    if (expected.rhythm && Array.isArray(found.backgrounds) && found.backgrounds.length > 0) {
      const rhythm = checkRhythm({
        backgrounds: found.backgrounds,
        kinds: bandKinds(html).map((b) => b.kind),
        brandColors: expected.rhythm.brandColors,
        direction: expected.rhythm.direction,
        hasPhotos: expected.rhythm.hasPhotos,
      });
      // An issue that names its own bands (the flat-run check) keeps them; the pale-rhythm issue points at its plan.
      for (const issue of rhythm.issues) found.issues.push({ ...issue, severity: "fail", sections: issue.sections ?? rhythm.plan });
    }

    /*
      Text over a picture: hide the text, photograph what is behind it, and
      compare the text's colour with the average colour of that area.
    */
    let { count, worst, worstText } = found.contrast;
    const sections = new Set(found.contrast.sections);
    for (const probe of found.probes) {
      const behind = await pixelsBehind(page, probe.n);
      if (!behind) continue;
      const value = contrastRatio(blendOver(probe.fg, behind, probe.alpha), behind);
      if (value >= probe.required) continue;
      count += 1;
      if (probe.section >= 0) sections.add(probe.section);
      if (value < worst) {
        worst = value;
        worstText = probe.text;
      }
    }
    if (count > 0) {
      found.issues.unshift({
        id: "a11y.contrast",
        severity: "fail",
        sections: [...sections].sort((a, b) => a - b),
        message: `${count} text ${count === 1 ? "element does" : "elements do"} not meet the contrast floor. Worst is ${worst.toFixed(1)} to 1 on "${worstText}"; body text must be at least 4.5 to 1 and large text at least 3 to 1.`,
      });
    }
    // Is it still a page? The markup's bands against the ones the browser laid out (9 November 2026).
    found.issues.push(...(await collapseIssues(page, html)));

    return found.issues;
  } finally {
    await context.close();
  }
}

const channelOf = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanceOf = ([r, g, b]: [number, number, number]) => 0.2126 * channelOf(r) + 0.7152 * channelOf(g) + 0.0722 * channelOf(b);

/* A see-through colour as it shows over another. */
export function blendOver(top: [number, number, number], under: [number, number, number], alpha: number): [number, number, number] {
  const a = Math.max(0, Math.min(1, alpha));
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a)];
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* The average colour behind a marked text element, with the text itself hidden. */
async function pixelsBehind(page: import("playwright-core").Page, n: number): Promise<[number, number, number] | null> {
  const selector = `[data-tawd-probe="${n}"]`;
  const box = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))]) {
      node.style.setProperty("color", "transparent", "important");
      node.style.setProperty("text-shadow", "none", "important");
    }
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, selector);
  if (!box || box.width < 2 || box.height < 2) return null;
  /*
    Only the part of the text that is on screen (1 October 2026: Dave
    Riccio's Concept A failed with "Clipped area is either empty or outside
    the resulting image"). Text off the screen (a closed menu drawer, a
    carousel's later slides) has nothing behind it to measure, so it's
    skipped; a picture that still can't be taken skips that text only,
    never the whole concept.
  */
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(VIEWPORT.width, box.x + box.width);
  const bottom = Math.min(VIEWPORT.height, box.y + box.height);
  if (right - left < 2 || bottom - top < 2) return null;
  let shot: Buffer;
  try {
    shot = await page.screenshot({ type: "png", clip: { x: left, y: top, width: right - left, height: bottom - top } });
  } catch (error) {
    console.warn(`Contrast check: the area behind one text element couldn't be photographed (${error instanceof Error ? error.message.split("\n")[0] : "unknown"}); skipped.`);
    return null;
  }
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.min(200, image.naturalWidth));
    canvas.height = Math.max(1, Math.round((canvas.width / image.naturalWidth) * image.naturalHeight));
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let r = 0, g = 0, b = 0;
    const count = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
    }
    return [r / count, g / count, b / count] as [number, number, number];
  }, `data:image/png;base64,${shot.toString("base64")}`);
}

/*
  What the Creative Director looks at.

  JPEG rather than PNG, and the full page cut into slices, because the API
  scales every image down to about 1,568px on its long side: a 1440 by 9000
  page sent whole would arrive as an unreadable strip. Slices of 1440 by
  2400 keep text legible at about 2,000 tokens each. Capped at five slices;
  a page taller than 12,000px is already flagged by the checks.
*/
export interface ReviewShots {
  fold: Buffer;
  slices: Buffer[];
  heightPx: number;
}

const SLICE_HEIGHT = 2400;
const MAX_SLICES = 5;

export async function renderForReview(
  browser: Browser,
  html: string,
): Promise<ReviewShots> {
  const context = await ownPageContext(browser, {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });

  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith("data:") ||
        url.startsWith("about:") ||
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)
      ) {
        void route.continue();
        return;
      }
      void route.abort();
    });

    await loadHtml(page, html);
    await fontsReady(page);
    await page.waitForTimeout(400);

    const heightPx = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );

    const fold = await page.screenshot({
      type: "jpeg",
      quality: 75,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });

    const slices: Buffer[] = [];
    const total = Math.min(heightPx, SLICE_HEIGHT * MAX_SLICES);
    for (let y = 0; y < total; y += SLICE_HEIGHT) {
      slices.push(
        await page.screenshot({
          type: "jpeg",
          quality: 70,
          fullPage: true,
          clip: {
            x: 0,
            y,
            width: VIEWPORT.width,
            height: Math.min(SLICE_HEIGHT, total - y),
          },
        }),
      );
    }

    return { fold, slices, heightPx };
  } finally {
    await context.close();
  }
}

/*
  A small first-screen image of a concept, for reviewing another concept
  one at a time: enough to see how it looks at a glance, a fraction of the
  tokens of the full-size shot. The fold JPEG is drawn at 480 wide and
  photographed again.
*/
export const THUMBNAIL_WIDTH = 480;

export async function renderThumbnail(browser: Browser, foldJpeg: Buffer): Promise<Buffer> {
  const height = Math.round((THUMBNAIL_WIDTH / VIEWPORT.width) * VIEWPORT.height);
  const context = await ownPageContext(browser, { viewport: { width: THUMBNAIL_WIDTH, height }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await loadHtml(
      page,
      `<html><body style="margin:0"><img src="data:image/jpeg;base64,${foldJpeg.toString("base64")}" style="display:block;width:${THUMBNAIL_WIDTH}px;height:${height}px"></body></html>`,
    );
    return await page.screenshot({ type: "jpeg", quality: 70, clip: { x: 0, y: 0, width: THUMBNAIL_WIDTH, height } });
  } finally {
    await context.close();
  }
}

/*
  Where each band of the page starts and ends, as a percentage down the
  full page (the same page the team pins comments on), so a pinned comment
  can be matched to its band. Bands by the same rule as sections.ts. An
  empty list when the page cannot be measured; the pin is then described
  in words instead.
*/
export async function measureBands(browser: Browser, html: string): Promise<{ top: number; bottom: number }[]> {
  const context = await ownPageContext(browser, { viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:") || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) {
        void route.continue();
        return;
      }
      void route.abort();
    });
    await loadHtml(page, html);
    await fontsReady(page);

    const extents: unknown = await page.evaluate(() => {
      const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "TEMPLATE", "META"]);
      const topLevel = (parent: Element) => Array.from(parent.children).filter((e) => !skip.has(e.tagName));
      let bands = topLevel(document.body).flatMap((e) => (e.tagName === "MAIN" ? topLevel(e) : [e]));
      if (bands.length === 1) bands = topLevel(bands[0]!);
      const pageHeight = Math.max(document.documentElement.scrollHeight, 1);
      return bands.map((band) => {
        const box = band.getBoundingClientRect();
        const top = box.top + window.scrollY;
        return { top: (top / pageHeight) * 100, bottom: ((top + box.height) / pageHeight) * 100 };
      });
    });
    return Array.isArray(extents) ? (extents as { top: number; bottom: number }[]) : [];
  } catch {
    return [];
  } finally {
    await context.close();
  }
}

/*
  A strip of a picture, drawn at a given width and cut into JPEG slices no
  taller than maxHeight (so the AI can read each). Used for a section of
  the Figma frame, and for the same section of the copy.
*/
export async function cropPicture(
  browser: Browser,
  png: Buffer,
  strip: { top: number; height: number; sourceWidth: number },
  width = VIEWPORT.width,
  maxHeight = 2000,
): Promise<Buffer[]> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    await loadHtml(page, "<html><body></body></html>");
    const slices: string[] = await page.evaluate(
      async ({ src, top, height, sourceWidth, width, maxHeight }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const scale = image.naturalWidth / sourceWidth;
        const sy = top * scale;
        const sh = Math.max(1, Math.min(height * scale, image.naturalHeight - sy));
        const outHeight = Math.max(1, Math.round((sh * width) / image.naturalWidth));
        const out: string[] = [];
        for (let y = 0; y < outHeight; y += maxHeight) {
          const h = Math.min(maxHeight, outHeight - y);
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = h;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, h);
          const srcY = sy + (y * image.naturalWidth) / width;
          const srcH = (h * image.naturalWidth) / width;
          ctx.drawImage(image, 0, srcY, image.naturalWidth, srcH, 0, 0, width, h);
          out.push(canvas.toDataURL("image/jpeg", 0.75));
        }
        return out;
      },
      { src: `data:image/png;base64,${png.toString("base64")}`, ...strip, width, maxHeight },
    );
    return (Array.isArray(slices) ? slices : []).map((uri) => Buffer.from(uri.split(",")[1] ?? "", "base64"));
  } finally {
    await context.close();
  }
}

/*
  One section of a version's render with the team's pins drawn on it
  (2 October 2026): what the editor is shown next to the section's code,
  so "make this bigger" points at the right thing. At most 1,600 pixels of
  the page (around the pins when the section is taller), drawn 1,000 wide.
*/
export async function pinnedBandPicture(
  browser: Browser,
  png: Buffer,
  band: { top: number; bottom: number },
  pins: { number: number; x: number; yPx: number }[],
): Promise<{ jpeg: Buffer; outside: number[] } | null> {
  const MAX_TALL = 1600;
  let top = band.top;
  let bottom = band.bottom;
  if (bottom - top > MAX_TALL) {
    const ys = pins.map((p) => p.yPx);
    const middle = ys.length > 0 ? (Math.min(...ys) + Math.max(...ys)) / 2 : top + MAX_TALL / 2;
    top = Math.max(band.top, Math.min(band.bottom - MAX_TALL, Math.round(middle - MAX_TALL / 2)));
    bottom = top + MAX_TALL;
  }
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    await loadHtml(page, "<html><body></body></html>");
    const uri: unknown = await page.evaluate(
      async ({ src, top, bottom, pinMarks, width }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const scale = image.naturalWidth / 1440;
        const sy = top * scale;
        const sh = Math.max(1, Math.min((bottom - top) * scale, image.naturalHeight - sy));
        const height = Math.max(1, Math.round((sh * width) / image.naturalWidth));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, sy, image.naturalWidth, sh, 0, 0, width, height);
        const k = width / 1440;
        for (const pin of pinMarks) {
          const x = (pin.x / 100) * width;
          // A pin beyond the cut is drawn at its edge (the caption says it's further along), never off the picture.
          const y = Math.min(height - 18, Math.max(18, (pin.yPx - top) * k));
          ctx.beginPath();
          ctx.arc(x, y, 16, 0, Math.PI * 2);
          ctx.fillStyle = "#D93025";
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#fff";
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.font = "bold 16px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(pin.number), x, y + 1);
        }
        return canvas.toDataURL("image/jpeg", 0.8);
      },
      { src: `data:image/png;base64,${png.toString("base64")}`, top, bottom, pinMarks: pins, width: 1000 },
    );
    if (typeof uri !== "string" || !uri.includes(",")) return null;
    // Fable's A8 (3 October 2026): which pins lie outside the cut, for the caption.
    const outside = pins.filter((p) => p.yPx < top || p.yPx > bottom).map((p) => p.number);
    return { jpeg: Buffer.from(uri.split(",")[1] ?? "", "base64"), outside };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

/* The text on the page, section by section (data-figma-section), in the order it appears. */
export async function pageTextsBySection(browser: Browser, html: string): Promise<{ number: number; texts: string[] }[]> {
  const context = await ownPageContext(browser, { viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:")) void route.continue();
      else void route.abort();
    });
    await loadHtml(page, html);
    const found: unknown = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("body > [data-figma-section]")).map((section) => {
        const texts: string[] = [];
        const walk = (el: Element) => {
          const own = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (own) texts.push(own);
          Array.from(el.children).forEach((child) => {
            if (child.tagName !== "STYLE" && child.tagName !== "SCRIPT") walk(child);
          });
        };
        walk(section);
        return { number: Number(section.getAttribute("data-figma-section")), texts };
      }),
    );
    return Array.isArray(found) ? (found as { number: number; texts: string[] }[]) : [];
  } finally {
    await context.close();
  }
}

/* A picture's height in pixels, read in the browser. */
export async function imageHeight(browser: Browser, png: Buffer): Promise<number> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    await loadHtml(page, "<html><body></body></html>");
    const height: unknown = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image.naturalHeight;
    }, `data:image/png;base64,${png.toString("base64")}`);
    return typeof height === "number" && height > 0 ? height : 1;
  } finally {
    await context.close();
  }
}
