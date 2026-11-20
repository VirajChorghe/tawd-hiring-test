import type { Page } from "playwright-core";

/*
  E0(b), audit batch E (13 November 2026): does every band of a page built
  from a design show its words?

  The paid Lane 2 run of 12 November ended "done" on pages whose screenshots
  had whole bands blank. The cause there turned out to be the screenshot
  (the speed pass's content-visibility, below), but nothing in TAWD would
  have noticed a band that really was blank: words the same colour as what
  is behind them, words hidden or drawn under a picture. This reads the page
  in the real browser the way a visitor sees it:

  - Sections the speed pass draws only when scrolled near ([data-tawd-cv],
    content-visibility: auto) are drawn first, and lazy pictures loaded, or
    every band below the first screen would look blank to the check too.
  - The bands are the page's <header>, each direct child of <main> that
    holds words (or <main> itself when none does), and the <footer>.
  - Words not laid out at this width are left out (display: none, the
    hidden attribute, placed off the page): a phone menu's copy of the
    links, a form's trap field, a skip link. Found on the paid run's real
    pages, where counting them failed every header.
  - A laid-out word counts as shown when it isn't hidden (visibility,
    opacity), isn't the same colour as the solid colour behind it
    (contrast at least 1.5:1; over a picture or gradient the colour can't
    be judged, so it counts), and is the topmost thing at the middle of
    its box once scrolled into view (so words under a picture or another
    layer don't count).
  - A band whose laid-out words are less than half shown (by characters)
    fails, and so does a band that takes up room on the screen while none
    of its words are laid out.

  Code only, no AI. Pure in the browser: one evaluate, no outside requests.
*/

export type BandWords = {
  /** The band's first heading, or its tag and class, for the team to find it. */
  name: string;
  /** Characters of words in the band's markup. */
  total: number;
  /** Characters of words a visitor can see. */
  shown: number;
  /** A few of the words that can't be seen, for the note. */
  hidden: string[];
  ok: boolean;
};

export const SHOWN_SHARE = 0.5;

/** How long pictures may take to load before the check gives up (CodeRabbit #83: a picture that never decodes must not hold the build). */
export const PREPARE_MS = 15_000;

export async function bandsShowWords(page: Page, options: { prepareMs?: number } = {}): Promise<BandWords[]> {
  const ready = await page.evaluate(async (limit: number) => {
    for (const img of Array.from(document.querySelectorAll("img"))) img.loading = "eager";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tawd-cv]"))) el.style.contentVisibility = "visible";
    const loads = Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))).then(() => true);
    const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limit));
    return Promise.race([loads, late]);
  }, options.prepareMs ?? PREPARE_MS);
  // The caller records the check as not run; the tab moves to the next page, which ends whatever was still loading.
  if (!ready) throw new Error(`the page's pictures didn't load within ${Math.round((options.prepareMs ?? PREPARE_MS) / 1000)} seconds`);
  return page.evaluate((share: number) => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(c);
      if (!m) return null;
      const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    };
    const luminance = ([r, g, b]: [number, number, number, number]) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const contrast = (a: [number, number, number, number], b: [number, number, number, number]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    // The solid colour behind an element, or null when a picture or gradient is behind it (can't be judged).
    const behind = (el: Element): [number, number, number, number] | null => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
        const c = parse(cs.backgroundColor);
        if (c && c[3] >= 0.95) return c;
      }
      return [255, 255, 255, 1];
    };
    const ownText = (el: Element) =>
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    /*
      Words not laid out at this width are left out, not counted against the
      band: a phone menu's copy of the links (display: none on a computer),
      a form's trap field (the hidden attribute), a skip link placed off the
      page until it gets focus. They are not meant to be seen here.
    */
    const laidOut = (el: HTMLElement): boolean => {
      if (!el.checkVisibility({ contentVisibilityAuto: true })) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return false;
      const left = box.left + window.scrollX;
      const top = box.top + window.scrollY;
      return left + box.width > 0 && top + box.height > 0 && left < document.documentElement.scrollWidth;
    };
    // Why a laid-out word can't be seen, or null when it can.
    // The element's opacity times every ancestor's: what the eye gets of it.
    const opacityOf = (el: Element): number => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity) || 0;
      return o;
    };
    // Does this layer paint something solid where it sits: a picture, video, canvas or drawing, or a background, at real opacity?
    // Does this layer paint something solid at the point (x, y): a picture, video, canvas or drawing, a background, or an inset shadow reaching that far in, at real opacity?
    const paints = (layer: Element, x: number, y: number): boolean => {
      const cs = getComputedStyle(layer);
      if (cs.visibility === "hidden" || opacityOf(layer) < 0.5) return false;
      if (["IMG", "VIDEO", "CANVAS", "IFRAME", "EMBED", "OBJECT", "PICTURE"].includes(layer.tagName) || layer instanceof SVGElement) return true;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      const bg = parse(cs.backgroundColor);
      if (bg !== null && bg[3] >= 0.5) return true;
      /*
        An inset box shadow paints a band along the layer's inside edges, as
        wide as its spread (CodeRabbit #83, third and fourth reviews: "inset 0
        0 0 100vmax white" hides everything; a 20px spread on a big card
        leaves its middle clear). So the point is covered only when it lies
        within the spread of an edge, widened by the offsets and the blur to
        stay on the safe side. A border is not counted: it paints only at the
        very edges, so a transparent card-sized link with a border would
        otherwise count as covering the words in its middle.
      */
      const box = layer.getBoundingClientRect();
      const fromEdge = Math.min(x - box.left, box.right - x, y - box.top, box.bottom - y);
      return cs.boxShadow
        .split(/,(?![^(]*\))/)
        .some((shadow) => {
          if (!/\binset\b/.test(shadow)) return false;
          const colour = parse(shadow);
          if (colour !== null && colour[3] < 0.5) return false;
          // Computed form: offset-x, offset-y, blur, spread (all in px).
          const [dx = 0, dy = 0, blur = 0, spread = 0] = (shadow.replace(/rgba?\([^)]*\)/g, "").match(/-?[\d.]+px/g) ?? []).map((l) => parseFloat(l));
          return spread > 0 && fromEdge <= spread + Math.max(Math.abs(dx), Math.abs(dy)) + blur;
        });
    };
    const unseen = (el: HTMLElement): string | null => {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return "hidden";
      const cs = getComputedStyle(el);
      const colour = parse(cs.color);
      // The text colour as painted: its own alpha and every ancestor's opacity laid over what is behind it (CodeRabbit #83).
      const alpha = (colour ? colour[3] : 1) * opacityOf(el);
      if (alpha < 0.1) return "transparent";
      const back = behind(el);
      if (colour && back) {
        const painted: [number, number, number, number] = [0, 1, 2].map((i) => colour[i]! * alpha + back[i]! * (1 - alpha)) as unknown as [number, number, number, number];
        painted[3] = 1;
        if (contrast(painted, back) < 1.5) return "same colour as its background";
      }
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const now = el.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 1, Math.max(0, now.left + Math.min(now.width, 40) / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, now.top + now.height / 2));
      /*
        The layers at that point, top first: the words are covered only by a
        layer that paints something there before the words are reached. A
        layer that paints nothing (opacity 0, a transparent link stretched
        over a card, an empty wrapper) is looked through (CodeRabbit #83,
        second review: a readable band must not fail on an invisible layer).
      */
      for (const layer of document.elementsFromPoint(x, y)) {
        if (layer === el || el.contains(layer) || layer.contains(el)) return null;
        if (paints(layer, x, y)) return "covered by another element";
      }
      return "covered by another element";
    };
    const bandsOf = (): Element[] => {
      const out: Element[] = [];
      for (const root of Array.from(document.querySelectorAll("body > header, body header:not(main header), main, body > footer, body footer:not(main footer)"))) {
        const kids = Array.from(root.children).filter((k) => (k.textContent ?? "").trim());
        if (root.tagName === "MAIN" && kids.length) out.push(...kids);
        else out.push(root);
      }
      return Array.from(new Set(out));
    };
    const nameOf = (band: Element) => {
      const h = band.querySelector("h1,h2,h3");
      const heading = h?.textContent?.replace(/\s+/g, " ").trim();
      if (heading) return heading.slice(0, 60);
      const cls = (band.getAttribute("class") ?? "").trim().split(/\s+/)[0];
      return `${band.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
    };
    /*
      A picture laid over the words with pointer-events: none is skipped by
      elementFromPoint (hit testing ignores it) though it paints on top
      (CodeRabbit #83). While measuring, everything is made hit-testable;
      the style is taken out again afterwards.
    */
    const hitAll = document.createElement("style");
    hitAll.textContent = "*,*::before,*::after{pointer-events:auto !important}";
    document.head.appendChild(hitAll);
    const results = [];
    for (const band of bandsOf()) {
      let total = 0;
      let shown = 0;
      let notLaidOut = 0;
      const hidden: string[] = [];
      for (const el of Array.from(band.querySelectorAll<HTMLElement>("*"))) {
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "TITLE"].includes(el.tagName)) continue;
        if (el.closest("svg, script, style, noscript, template, [aria-hidden='true'], .sr-only, .visually-hidden")) continue;
        const text = ownText(el);
        if (!text) continue;
        if (!laidOut(el)) {
          notLaidOut += text.length;
          continue;
        }
        total += text.length;
        const why = unseen(el);
        if (!why) shown += text.length;
        else if (hidden.length < 4) hidden.push(`${text.slice(0, 40)} (${why})`);
      }
      // The band itself may hold loose words (text straight inside a section).
      const loose = ownText(band);
      if (loose && laidOut(band as HTMLElement)) {
        total += loose.length;
        const why = unseen(band as HTMLElement);
        if (!why) shown += loose.length;
        else if (hidden.length < 4) hidden.push(`${loose.slice(0, 40)} (${why})`);
      }
      if (total === 0) {
        // Words in the markup, none laid out, yet the band takes up room on the screen: a blank band.
        const room = band.getBoundingClientRect();
        if (notLaidOut > 0 && room.height >= 100 && room.width >= 100) {
          results.push({ name: nameOf(band), total: notLaidOut, shown: 0, hidden: ["its words aren't laid out at this width"], ok: false });
        }
        continue;
      }
      results.push({ name: nameOf(band), total, shown, hidden, ok: shown / total >= share });
    }
    hitAll.remove();
    window.scrollTo(0, 0);
    return results;
  }, SHOWN_SHARE);
}

/* The notes for one page: one line per band that fails. */
export function bandWordsNotes(bands: BandWords[]): string[] {
  return bands
    .filter((b) => !b.ok)
    .map((b) => `The band "${b.name}" shows ${Math.round((b.shown / b.total) * 100)}% of its words${b.hidden.length ? ` (not shown: "${b.hidden.join('", "')}")` : ""}.`);
}
