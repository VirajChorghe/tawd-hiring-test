import type { Browser, Page } from "playwright-core";
import { ownPageContext } from "./locked-context";
import { openPage } from "./page-load";

/*
  E2, audit batch E (13 November 2026): what "matches the design" means, in
  checks code can run. Spec 15, section 5. Code only, no AI.

  The design is described by what the read of it found: its width and
  height, its bands (top and height, in design pixels), its words in order,
  its pictures (box), and the design picture itself. The built page is
  measured in real Chrome at the design's width, with every section drawn
  (the speed pass's content-visibility is lifted, lazy pictures loaded, web
  fonts ready), so it is measured the way a visitor sees it, all of it. A
  page that answers with an error status is not measured: it throws.

  What is measured on the built page:
  - Words: only text a visitor sees (laid out, at least 2 x 2 px, not placed
    off the page, not clipped to a pixel like a screen-reader-only span, not
    out of view inside something that clips, like a carousel track, not
    transparent), plus form placeholders and button values, in document
    order (the order the design's words were read in). TAWD's own skip link
    and hidden text are not words.
  - Bands: found by going down through wrappers (a lone child is a wrapper;
    a big child that holds several stacked blocks, of any width, is opened
    up); fixed or absolutely placed children, inline boxes and tiny ones
    (under 8 px tall or 48 px wide) are not bands, except a header fixed to
    the top of the page, which is a band at its place. Design
    bands are paired with built bands by alignment (a dynamic programme on
    top and height differences, either side may skip), not by index, so an
    extra or a missing band does not shift every band after it.
  - Pictures: img elements, CSS background images (url(...), not gradients)
    and inline svg of 24 px or more. Each is used once.

  The six checks, each with the numbers behind it:
  1. Page height: within 2% of the design's.
  2. Bands: each band is as tall as the design's band (within 12 px) and
     starts where it should relative to the band before it (the gap to the
     previous paired band matches the design's gap, within 12 px; the first
     band uses its absolute top). So one band that is a little taller fails
     itself, not everything below it.
  3. Words: every design word present once, in order, and nothing added
     (words the read marked as uncertain are left out of the design's list,
     and each forgives one added word of the same spelling on the page).
  4. Pictures: every design picture matched to a built picture whose centre
     is in the paired built band (or on the page, for a picture in no band);
     position relative to its band's top (x absolute) within 12 px, size
     within 5%. Built pictures matched to nothing are listed, not failed.
  5. Colour: each band 90 or more on the colour meter, AND its content
     matched: of the places where the design has something on the band's
     background (the 8 px blocks where the design differs from the built
     band with its words and pictures hidden), at least 80% match the page.
     So an empty band of the right background colour can't pass. The page
     picture is cut to the design's width, so sideways overflow does not
     shift the vertical positions that are scored.
  6. Sideways scrolling: tried for real (scroll to the right and see whether
     the page moved) at the design's width, 390, 820 and 1920 px; a page whose
     overflow-x is hidden or clipped (on <html>, or on <body> when <html>'s is
     visible) is not scrolling sideways for a visitor, though a script can
     still move it.

  The headline is graded, so it moves as a correction round improves a band
  that is still short of its threshold (pass and fail, and the failure
  lines, are the thresholds above and do not change). The bands are 55% of
  the score (each weighted by its height), the words 25%, and the rest of
  the whole page 20%; a page with any failure never scores 100. A band's
  grade is the mean of its parts: position (1 within 12 px, falling to 0 at
  200 px off), colour (colour/90 times content/80, each capped at 1) and, if
  it has pictures, the share placed. The whole page: height (1 within 2%,
  0 at 12%), widths not scrolling sideways, and pictures in no band; the
  words: matched minus added, over the design's. A band that fails is named
  with what failed, so the team and the correction round know where to
  look. These thresholds are a starting point to be tuned on the fixtures
  (spec section 5); nothing blocks on them.

  Known limit: when one of several equal-height bands is missing, geometry
  alone cannot tell which one it was (the pairing may drop the wrong one).
  A later step (E5) can break the tie with each band's words.
*/

export interface DesignBand {
  name: string;
  top: number;
  height: number;
}
export interface DesignWord {
  text: string;
  /** The read wasn't sure of this word (blurred text): left out of the word check. */
  uncertain?: boolean;
}
export interface DesignPicture {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DesignSpec {
  width: number;
  height: number;
  bands: DesignBand[];
  /** The design's words in reading order. */
  words: DesignWord[];
  pictures: DesignPicture[];
  /** The design picture (PNG or JPEG) at `width` pixels wide. */
  picture: Buffer;
}

export const TOLERANCE = { heightShare: 0.02, bandPx: 12, picturePx: 12, pictureSize: 0.05, colourMin: 90, contentMin: 80 } as const;
export const OTHER_WIDTHS = [390, 820, 1920] as const;
/** The whole-page checks' share of the headline; the bands have the rest. */
/** The headline's shares: the bands (by height), the words, and the rest of the whole page (height, widths, loose pictures). */
export const SHARES = { bands: 0.55, words: 0.25, page: 0.2 } as const;
/** What it costs to leave a band unpaired on either side when pairing (px of difference). */
const SKIP_COST = 300;

export interface BandResult {
  name: string;
  design: { top: number; height: number };
  built: { top: number; height: number } | null;
  position: boolean;
  colour: number;
  /** 0-100: of the blocks where the design has content, the share the page matches (100 when the band has none). */
  content: number;
  colourOk: boolean;
  pictures: { name: string; ok: boolean; note: string }[];
}
export interface DesignCheckReport {
  /** 0-100: bands 55% (by height), words 25%, the rest of the page 20%; never 100 with a failure. */
  score: number;
  height: { design: number; built: number; ok: boolean };
  bands: BandResult[];
  /** Bands on the page that no design band was paired with. */
  extraBands: { top: number; height: number }[];
  words: { missing: string[]; added: string[]; ok: boolean; designCount: number; builtCount: number };
  /** Design pictures whose centre is in no band, checked against the whole page. */
  loosePictures: { name: string; ok: boolean; note: string }[];
  /** Pictures on the page matched to no design picture (information, not a failure). */
  extraPictures: { x: number; y: number; w: number; h: number }[];
  widths: { width: number; overflow: boolean }[];
  /** One line per failing check, in plain words. */
  failures: string[];
}

/* Words as compared: lower case, letters and digits only; "&" reads as "and". */
export function wordsOf(text: string): string[] {
  return text
    .replace(/&/g, " and ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/*
  The longest common run of words, in order (dynamic programming over the
  two lists): what is in the design and not matched is missing, what is on
  the page and not matched is added. A word moved to another place counts as
  both, which is what "in order" means.
*/
export function compareWords(design: string[], built: string[]): { missing: string[]; added: string[] } {
  const n = design.length;
  const m = built.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = design[i] === built[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const missing: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (design[i] === built[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) missing.push(design[i++]!);
    else added.push(built[j++]!);
  }
  while (i < n) missing.push(design[i++]!);
  while (j < m) added.push(built[j++]!);
  return { missing, added };
}

/*
  The design's words against the page's. Words the read marked uncertain are
  left out of the design list for the comparison (nothing is removed from the
  page first, so the certain words still line up); then each uncertain word
  forgives one added word of the same spelling (a multiset: one uncertain
  "the" forgives one "the", not every "the").
*/
export function compareSpecWords(
  words: DesignWord[],
  built: string[],
): { missing: string[]; added: string[]; designCount: number; builtCount: number } {
  const designWords = words.filter((w) => !w.uncertain).flatMap((w) => wordsOf(w.text));
  const owed = new Map<string, number>();
  for (const w of words.filter((w) => w.uncertain).flatMap((w) => wordsOf(w.text))) owed.set(w, (owed.get(w) ?? 0) + 1);
  const { missing, added } = compareWords(designWords, built);
  const kept = added.filter((w) => {
    const n = owed.get(w) ?? 0;
    if (n <= 0) return true;
    owed.set(w, n - 1);
    return false;
  });
  return { missing, added: kept, designCount: designWords.length, builtCount: built.length };
}

interface Box {
  top: number;
  height: number;
}

/*
  Design bands paired with built bands, in order, by alignment: the cost of a
  pair is mostly the difference of heights, with the difference of tops as a
  small tie-breaker (a quarter of it, capped at 100), and either side may skip
  a band at a fixed cost. Tops count little because a page that has drifted
  (one tall band pushes all below it hundreds of pixels down) should still
  pair band for band and be judged band by band, not have every band below
  the drift called missing. Returns, per design band, the index of its built
  band or null.
*/
export function pairBands(design: Box[], built: Box[]): (number | null)[] {
  const n = design.length;
  const m = built.length;
  // Capped (250 for height, 100 for top) so even a badly wrong band pairs in order rather than counting as one missing and one extra.
  const cost = (i: number, j: number) => Math.min(250, Math.abs(design[i]!.height - built[j]!.height)) + Math.min(100, Math.abs(design[i]!.top - built[j]!.top) / 4);
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) dp[i]![0] = i * SKIP_COST;
  for (let j = 1; j <= m; j += 1) dp[0]![j] = j * SKIP_COST;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i]![j] = Math.min(dp[i - 1]![j - 1]! + cost(i - 1, j - 1), dp[i - 1]![j]! + SKIP_COST, dp[i]![j - 1]! + SKIP_COST);
    }
  }
  const pairs: (number | null)[] = new Array<number | null>(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (dp[i]![j] === dp[i - 1]![j - 1]! + cost(i - 1, j - 1)) {
      pairs[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (dp[i]![j] === dp[i - 1]![j]! + SKIP_COST) i -= 1;
    else j -= 1;
  }
  return pairs;
}

/* Everything drawn, as a visitor sees it once scrolled: speed-pass sections, lazy pictures, web fonts. */
async function drawAll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const img of Array.from(document.querySelectorAll("img"))) img.loading = "eager";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tawd-cv]"))) el.style.contentVisibility = "visible";
    const loads = Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null))));
    await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  });
}

/*
  The text a visitor sees, in visual reading order. The same notion of "laid
  out" and "seen" as the band-words check (copied: it is a separate evaluate).
*/
async function readWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    const scrollWidth = document.documentElement.scrollWidth;
    const laidOut = (el: Element) => (el as HTMLElement).checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
    const seen = (el: Element): boolean => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o >= 0.1;
    };
    // Clipped to a pixel (a screen-reader-only span) by itself or by something around it.
    const clipped = (el: Element): boolean => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const box = e.getBoundingClientRect();
        if ((cs.overflowX !== "visible" || cs.overflowY !== "visible") && (box.width <= 1 || box.height <= 1)) return true;
        if (cs.position === "absolute" && /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(cs.clip)) return true;
        if (/^inset\((50|100)%/.test(cs.clipPath)) return true;
      }
      return false;
    };
    /*
      Out of view inside something that clips (a carousel track with
      overflow hidden, one slide in view): the text's box must meet the box of
      every clipping ancestor. An absolutely placed element is clipped only by
      a positioned ancestor, a fixed one by none.
    */
    const clippedAway = (el: Element, rect: DOMRect): boolean => {
      let skipStatic = false;
      for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const clips = [cs.overflowX, cs.overflowY].some((o) => o === "hidden" || o === "clip" || o === "auto" || o === "scroll");
        if (clips && (!skipStatic || cs.position !== "static")) {
          const box = e.getBoundingClientRect();
          if (!(rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom)) return true;
        }
        if (cs.position === "fixed") break;
        if (cs.position === "absolute") skipStatic = true;
      }
      return false;
    };
    const shows = (el: Element, rect: DOMRect): boolean => {
      if (!laidOut(el) || !seen(el) || clipped(el) || clippedAway(el, rect)) return false;
      if (rect.width < 2 || rect.height < 2) return false;
      const left = rect.left + window.scrollX;
      const top = rect.top + window.scrollY;
      return left + rect.width > 0 && top + rect.height > 0 && left < scrollWidth;
    };
    // Document order: the order the design's words were read in (a wrapped span or a row of cards stays in sequence).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let lastText = "";
    let lastBox: DOMRect | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) continue;
        const rect = node.getBoundingClientRect();
        if (!shows(node, rect)) continue;
        const kind = node instanceof HTMLInputElement ? node.type : "";
        parts.push(["button", "submit", "reset"].includes(kind) ? (node.getAttribute("value") ?? "") : node.placeholder);
        continue;
      }
      const el = node.parentElement;
      if (!el || !(node.textContent ?? "").trim() || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!shows(el, range.getBoundingClientRect())) continue;
      const text = node.textContent ?? "";
      /*
        Two pieces of text are one word only when they touch on the page: no
        whitespace between them in the markup, and the first's last box meets
        the second's first box on the same line (they overlap vertically and
        the gap across is under 2 px). A drop cap "W" then "e" and "1" then a
        superscript "st" touch; a line break (<br>) puts the next piece on
        another line, and links set apart by a margin leave a gap, so those
        stay separate words even in minified markup with no spaces at all
        (Fable's fourth read: a whitespace-only rule glued them together).
      */
      const boxes = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const first = boxes[0];
      const touches =
        lastBox !== null &&
        first !== undefined &&
        parts.length > 0 &&
        !/\s$/.test(lastText) &&
        !/^\s/.test(text) &&
        first.top < lastBox.bottom &&
        first.bottom > lastBox.top &&
        first.left - lastBox.right > -1 &&
        first.left - lastBox.right < 2;
      if (touches) parts[parts.length - 1] += text;
      else parts.push(text);
      lastText = text;
      lastBox = boxes[boxes.length - 1] ?? null;
    }
    return parts.filter((p) => p.trim()).join(" ");
  });
}

/*
  The page's bands as built. From the body, a container with exactly one
  in-flow visible child is a wrapper: go down into it. A container with
  several in-flow, stacked, near-full-width children has them as its bands; a
  child that is 30% or more of the page and itself holds such blocks (and
  only block containers) is opened up into them. Fixed or absolutely placed
  children and ones with no height are not bands.
*/
async function builtBands(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const pageHeight = document.documentElement.scrollHeight;
    const containers = new Set(["HEADER", "SECTION", "DIV", "ARTICLE", "ASIDE", "FOOTER", "MAIN", "NAV"]);
    // In-flow, block-level children of a real size: tiny ones (a 1 px picture, a spacer) and inline boxes are not bands.
    const flow = (el: Element) =>
      Array.from(el.children).filter((k) => {
        const cs = getComputedStyle(k);
        if (cs.position === "fixed" || cs.position === "absolute" || cs.display.startsWith("inline")) return false;
        const r = k.getBoundingClientRect();
        return r.height >= 8 && r.width >= 48;
      });
    /*
      Stacked: each starts below the start of the one before it and overlaps
      it by at most half of the smaller of the two (cards pulled up over a
      hero with a negative margin are still stacked; columns side by side are
      not). No width rule: boxed sections are bands too. (Fable's third read:
      a 2 px slack made one overlap anywhere collapse every band.)
    */
    const stacked = (kids: Element[]) => {
      const rects = kids.map((k) => k.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      return rects.every((r, i) => {
        if (i === 0) return true;
        const prev = rects[i - 1]!;
        const overlap = prev.bottom - r.top;
        return r.top > prev.top + 2 && overlap <= Math.min(prev.height, r.height) / 2;
      });
    };
    const split = (el: Element, open: boolean, depth: number): Element[] | null => {
      if (depth > 12) return null;
      const kids = flow(el);
      // A lone section or article is a band of its own, not a wrapper to open (Fable's third read: a one-section <main> was split into its divs).
      // But a lone section or article holding two or more stacked sections, articles, headers or footers is a wrapper, and is opened (Fable's fourth read).
      if (kids.length === 1 && !open && ["SECTION", "ARTICLE"].includes(kids[0]!.tagName)) {
        const inner = flow(kids[0]!).filter((k) => ["SECTION", "ARTICLE", "HEADER", "FOOTER"].includes(k.tagName));
        if (!(inner.length >= 2 && stacked(inner))) return [kids[0]!];
      }
      if (kids.length === 1) return split(kids[0]!, open, depth + 1);
      if (kids.length < 2 || !stacked(kids)) return null;
      if (!open) return kids;
      return kids.flatMap((k) => {
        if (k.getBoundingClientRect().height < pageHeight * 0.3) return [k];
        const inside = split(k, false, depth + 1);
        return inside && inside.every((p) => containers.has(p.tagName)) ? inside : [k];
      });
    };
    const found = split(document.body, true, 0) ?? [document.body];
    // A header fixed to the top of the page takes no room in the flow but is a band, at its place on the page.
    const heads = Array.from(document.querySelectorAll("header, [role=banner]")).filter((e) => {
      if (getComputedStyle(e).position !== "fixed" || found.some((f) => f.contains(e))) return false;
      const r = e.getBoundingClientRect();
      return r.top + window.scrollY <= 2 && r.width >= window.innerWidth * 0.9 && r.height > 0;
    });
    return [...heads, ...found]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
      })
      .filter((b) => b.height > 0)
      .sort((a, b) => a.top - b.top);
  });
}

interface BuiltPicture {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* Pictures as built: img, CSS background images (url, not gradients), inline svg of 24 px or more. */
async function builtPictures(page: Page): Promise<BuiltPicture[]> {
  return page.evaluate(() => {
    const out: BuiltPicture[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      const box = { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
      if (el.tagName === "IMG") {
        if (box.w >= 2 && box.h >= 2) out.push(box);
      } else if (el.tagName.toLowerCase() === "svg") {
        if (box.w >= 24 && box.h >= 24 && !el.parentElement?.closest("svg")) out.push(box);
      } else if (box.w >= 2 && box.h >= 2 && getComputedStyle(el).backgroundImage.includes("url(")) out.push(box);
    }
    return out;
  });
}

export async function checkAgainstDesign(browser: Browser, url: string, spec: DesignSpec): Promise<DesignCheckReport> {
  // TAWD's own locked context (the page cap, only this page's own address and Google Fonts load).
  const context = await ownPageContext(browser, { viewport: { width: spec.width, height: 900 }, deviceScaleFactor: 1 }, [url]);
  try {
    const page = await context.newPage();
    // An error page with no body makes Chrome's own navigation fail, so the status is taken from the response itself.
    let answered = 0;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) answered = r.status();
    });
    // The repo's own way of opening a served page (structure first, then a bounded wait; never "load" with no limit).
    try {
      await openPage(page, url, { what: "The built page" });
    } catch (error) {
      if (answered >= 400) throw new Error(`the page answered ${answered}`, { cause: error });
      throw error;
    }
    // The final status after any redirects (a redirect to an error page with a body is still an error page).
    const finalStatus = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseStatus ?? 0);
    if (finalStatus >= 400) throw new Error(`the page answered ${finalStatus}`);
    await drawAll(page);
    const builtHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const bands = await builtBands(page);
    const text = await readWords(page);
    const pictures = await builtPictures(page);
    // Cut to the design's width, so sideways overflow can't widen the picture and shift what is scored.
    const clip = { x: 0, y: 0, width: spec.width, height: builtHeight };
    const full = await page.screenshot({ type: "png", fullPage: true, clip });
    // The same page with its words and pictures hidden: what the bands' backgrounds alone score.
    await page.addStyleTag({
      content:
        "body *,*::before,*::after{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important}img,svg,video,picture,canvas{visibility:hidden !important}",
    });
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        const cs = getComputedStyle(el);
        if (cs.backgroundClip === "text" || (cs as unknown as { webkitBackgroundClip: string }).webkitBackgroundClip === "text") {
          el.style.setProperty("background-image", "none", "important");
        }
      }
    });
    const empty = await page.screenshot({ type: "png", fullPage: true, clip });

    const pairs = pairBands(spec.bands, bands);
    const scores = await colourScores(page, spec, pairs.map((p) => (p === null ? null : bands[p]!)), full, empty);

    // Which design band holds each design picture (by its centre), and each picture matched once.
    const bandOfPicture = spec.pictures.map((p) => spec.bands.findIndex((b) => p.y + p.h / 2 >= b.top && p.y + p.h / 2 < b.top + b.height));
    const pictureResults = matchPictures(spec, bandOfPicture, pairs.map((p) => (p === null ? null : bands[p]!)), pictures);

    // Position: the height matches, and the top is where the previous paired band's bottom plus the design's gap puts it.
    let previous: number | null = null;
    const deviations: number[] = [];
    const bandResults: BandResult[] = spec.bands.map((band, i) => {
      const built = pairs[i] === null ? null : bands[pairs[i]!]!;
      let position = false;
      let deviation = Infinity;
      if (built !== null) {
        const prev: number | null = previous;
        const expectedTop = prev === null ? band.top : bands[pairs[prev]!]!.top + bands[pairs[prev]!]!.height + (band.top - (spec.bands[prev]!.top + spec.bands[prev]!.height));
        deviation = Math.max(Math.abs(built.height - band.height), Math.abs(built.top - expectedTop));
        position = deviation <= TOLERANCE.bandPx;
        previous = i;
      }
      const colourScore = scores.full[i] ?? 0;
      const content = scores.content[i] ?? 0;
      deviations.push(deviation);
      return {
        name: band.name,
        design: { top: band.top, height: band.height },
        built,
        position,
        colour: colourScore,
        content,
        colourOk: colourScore >= TOLERANCE.colourMin && content >= TOLERANCE.contentMin,
        pictures: pictureResults.results.filter((_, k) => bandOfPicture[k] === i),
      };
    });
    const paired = new Set(pairs.filter((p): p is number => p !== null));
    const extraBands = bands.filter((_, j) => !paired.has(j));
    const loosePictures = pictureResults.results.filter((_, k) => bandOfPicture[k] === -1);

    const words = compareSpecWords(spec.words, wordsOf(text));

    // Sideways scrolling, tried for real: scroll right and see whether the page moved (a page that hides its overflow does not).
    const widths: { width: number; overflow: boolean }[] = [];
    for (const width of Array.from(new Set<number>([spec.width, ...OTHER_WIDTHS]))) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      widths.push({
        width,
        overflow: await page.evaluate(() => {
          const y = window.scrollY;
          window.scrollTo({ left: 10_000, top: y, behavior: "instant" });
          const moved = window.scrollX > 0;
          window.scrollTo({ left: 0, top: y, behavior: "instant" });
          // A script can move a page whose overflow is hidden; a visitor can't. The viewport takes <html>'s overflow, or <body>'s when <html>'s is visible.
          let viewport = getComputedStyle(document.documentElement).overflowX;
          if (viewport === "visible") viewport = getComputedStyle(document.body).overflowX;
          return moved && viewport !== "hidden" && viewport !== "clip";
        }),
      });
    }

    const height = { design: spec.height, built: builtHeight, ok: Math.abs(builtHeight - spec.height) <= spec.height * TOLERANCE.heightShare };
    const failures: string[] = [];
    if (!height.ok) failures.push(`The page is ${builtHeight} px tall; the design is ${spec.height} px (more than 2% apart).`);
    for (const b of extraBands) failures.push(`The page has an extra band at ${b.top} px (${b.height} px tall) that the design doesn't have.`);
    for (const b of bandResults) {
      if (!b.position) failures.push(b.built ? `"${b.name}" is ${b.built.height} px tall and starts at ${b.built.top} px; the design has ${b.design.height} px, starting ${b.design.top} px down.` : `"${b.name}" has no band on the page.`);
      if (!b.colourOk) failures.push(`"${b.name}" scores ${b.colour} on colour, and matches ${b.content}% of the places where the design has words or pictures.`);
      for (const p of b.pictures.filter((p) => !p.ok)) failures.push(`"${b.name}": the picture ${p.name} is ${p.note}.`);
    }
    for (const p of loosePictures.filter((p) => !p.ok)) failures.push(`The picture ${p.name} (in no band) is ${p.note}.`);
    if (words.missing.length) failures.push(`${words.missing.length} of the design's words are missing or out of order (${words.missing.slice(0, 8).join(", ")}).`);
    if (words.added.length) failures.push(`${words.added.length} words on the page aren't in the design (${words.added.slice(0, 8).join(", ")}).`);
    for (const w of widths.filter((w) => w.overflow)) failures.push(`At ${w.width} px wide the page scrolls sideways.`);
    const wordsOk = words.missing.length === 0 && words.added.length === 0;

    // The headline, graded so it moves as a band improves short of its threshold (pass and fail above are unchanged).
    // Band: position (1 within tolerance, 0 at 200 px of deviation), colour (colour/90 x content/80, each capped at 1), pictures placed (if any); the mean of its parts, weighted by height.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    let bandPassed = 0;
    let bandTotal = 0;
    bandResults.forEach((b, i) => {
      const parts = [
        deviations[i]! <= TOLERANCE.bandPx ? 1 : Math.max(0, 1 - (deviations[i]! - TOLERANCE.bandPx) / (200 - TOLERANCE.bandPx)),
        Math.min(1, b.colour / TOLERANCE.colourMin) * Math.min(1, b.content / TOLERANCE.contentMin),
        ...(b.pictures.length ? [b.pictures.filter((p) => p.ok).length / b.pictures.length] : []),
      ];
      bandPassed += mean(parts) * b.design.height;
      bandTotal += b.design.height;
    });
    /*
      Words are a quarter of the score on their own (Fable's third read: as a
      third of a quarter, a page with every word wrong but the same layout
      scored 92). The rest of the whole page: height (1 within 2%, 0 at 12%),
      widths not scrolling, loose pictures placed.
    */
    const heightOff = Math.abs(builtHeight - spec.height) / Math.max(1, spec.height);
    const wordsGrade = words.designCount === 0 ? (words.added.length === 0 ? 1 : 0) : Math.max(0, (words.designCount - words.missing.length - words.added.length) / words.designCount);
    const pageGrade = mean([
      heightOff <= TOLERANCE.heightShare ? 1 : Math.max(0, 1 - (heightOff - TOLERANCE.heightShare) / (0.12 - TOLERANCE.heightShare)),
      widths.filter((w) => !w.overflow).length / widths.length,
      ...(loosePictures.length ? [loosePictures.filter((p) => p.ok).length / loosePictures.length] : []),
    ]);
    const bandsGrade = bandTotal === 0 ? pageGrade : bandPassed / bandTotal;
    const graded = SHARES.bands * bandsGrade + SHARES.words * wordsGrade + SHARES.page * pageGrade;
    // Never 100 while anything failed (one dropped word used to round up to 100).
    const score = failures.length > 0 ? Math.min(99, Math.round(graded * 100)) : Math.round(graded * 100);

    return {
      score,
      height,
      bands: bandResults,
      extraBands,
      words: { ...words, ok: wordsOk },
      loosePictures,
      extraPictures: pictureResults.extra,
      widths,
      failures,
    };
  } finally {
    await context.close();
  }
}

/*
  Each design picture to a built picture, each built picture used once. A
  picture in a band is matched among the built pictures whose centre is in
  that band's paired built band, by distance from the band's top (x absolute);
  a picture in no band against the whole page. Closest pairs first.
*/
function matchPictures(
  spec: DesignSpec,
  bandOf: number[],
  builtBandOf: (Box | null)[],
  built: BuiltPicture[],
): { results: { name: string; ok: boolean; note: string }[]; extra: BuiltPicture[] } {
  const candidates: { p: number; b: number; dx: number; dy: number }[] = [];
  spec.pictures.forEach((p, pi) => {
    const di = bandOf[pi]!;
    const band = di >= 0 ? builtBandOf[di] : null;
    if (di >= 0 && !band) return;
    built.forEach((b, bi) => {
      if (band) {
        const cy = b.y + b.h / 2;
        if (cy < band.top || cy >= band.top + band.height) return;
        candidates.push({ p: pi, b: bi, dx: b.x - p.x, dy: b.y - band.top - (p.y - spec.bands[di]!.top) });
      } else candidates.push({ p: pi, b: bi, dx: b.x - p.x, dy: b.y - p.y });
    });
  });
  candidates.sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  const matchOf = new Map<number, (typeof candidates)[number]>();
  const used = new Set<number>();
  for (const c of candidates) {
    if (matchOf.has(c.p) || used.has(c.b)) continue;
    matchOf.set(c.p, c);
    used.add(c.b);
  }
  const results = spec.pictures.map((p, pi) => {
    const c = matchOf.get(pi);
    if (!c) return { name: p.name, ok: false, note: "not on the page" };
    const b = built[c.b]!;
    const placed = Math.abs(c.dx) <= TOLERANCE.picturePx && Math.abs(c.dy) <= TOLERANCE.picturePx;
    const sized = Math.abs(b.w - p.w) <= p.w * TOLERANCE.pictureSize && Math.abs(b.h - p.h) <= p.h * TOLERANCE.pictureSize;
    return { name: p.name, ok: placed && sized, note: placed && sized ? "" : !placed ? `${Math.round(Math.abs(c.dx) + Math.abs(c.dy))} px from where the design has it` : "a different size" };
  });
  return { results, extra: built.filter((_, bi) => !used.has(bi)) };
}

/*
  The colour meter, per band: the design's band against the paired built
  band, in 8 px blocks of average colour, the share of blocks within 10% of
  each other (the existing fidelity meter's measure). Run twice: against the
  page as built, and against the page with its words and pictures hidden. The
  design is scaled to the page's width first.
*/
async function colourScores(page: Page, spec: DesignSpec, bands: (Box | null)[], full: Buffer, empty: Buffer): Promise<{ full: number[]; content: number[] }> {
  const toUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  const kind = spec.picture[0] === 0xff ? "jpeg" : "png";
  const designUrl = `data:image/${kind};base64,${spec.picture.toString("base64")}`;
  return page.evaluate(
    async ({ designUrl, fullUrl, emptyUrl, designBands, builtBands, width }) => {
      const load = async (src: string) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image;
      };
      const [design, built, bare] = await Promise.all([load(designUrl), load(fullUrl), load(emptyUrl)]);
      const BLOCK = 8;
      const SCALE = 360 / width;
      const blocks = (image: HTMLImageElement, top: number, height: number, toImage: number) => {
        const w = 360;
        const h = Math.max(BLOCK, Math.round(height * SCALE));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(image, 0, top * toImage, image.naturalWidth, Math.max(1, height * toImage), 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const out: number[][] = [];
        for (let by = 0; by + BLOCK <= h; by += BLOCK) {
          for (let bx = 0; bx + BLOCK <= w; bx += BLOCK) {
            let r = 0;
            let g = 0;
            let b = 0;
            for (let y = by; y < by + BLOCK; y += 1) {
              for (let x = bx; x < bx + BLOCK; x += 1) {
                const i = (y * w + x) * 4;
                r += data[i]!;
                g += data[i + 1]!;
                b += data[i + 2]!;
              }
            }
            out.push([r / 64, g / 64, b / 64]);
          }
        }
        return out;
      };
      const near = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!) / (255 * Math.sqrt(3)) < 0.1;
      const score = (x: number[][], y: number[][]) => {
        const n = Math.min(x.length, y.length);
        if (n === 0) return 0;
        let close = 0;
        for (let i = 0; i < n; i += 1) if (near(x[i]!, y[i]!)) close += 1;
        return Math.round((close / n) * 100);
      };
      // Where the design has content (it differs from the bare band), the share the page matches.
      const contentMatch = (d: number[][], f: number[][], e: number[][]) => {
        const n = Math.min(d.length, f.length, e.length);
        let content = 0;
        let matched = 0;
        for (let i = 0; i < n; i += 1) {
          if (near(d[i]!, e[i]!)) continue;
          content += 1;
          if (near(d[i]!, f[i]!)) matched += 1;
        }
        return content === 0 ? 100 : Math.round((matched / content) * 100);
      };
      const toDesign = design.naturalWidth / width;
      const toBuilt = built.naturalWidth / width;
      const fullScores: number[] = [];
      const contentScores: number[] = [];
      designBands.forEach((band, i) => {
        const b = builtBands[i];
        if (!b) {
          fullScores.push(0);
          contentScores.push(0);
          return;
        }
        const d = blocks(design, band.top, band.height, toDesign);
        const f = blocks(built, b.top, band.height, toBuilt);
        fullScores.push(score(d, f));
        contentScores.push(contentMatch(d, f, blocks(bare, b.top, band.height, toBuilt)));
      });
      return { full: fullScores, content: contentScores };
    },
    { designUrl, fullUrl: toUrl(full), emptyUrl: toUrl(empty), designBands: spec.bands, builtBands: bands, width: spec.width },
  );
}
