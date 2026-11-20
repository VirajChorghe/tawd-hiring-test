import type { Browser } from "playwright-core";

import type { ElementFindings, RunNote } from "@tawd/core/mockups";

import { VIEWPORT } from "./render";
import { ownPageContext } from "./locked-context";
import { fontsReady, loadHtml } from "./page-load";

/*
  The fixes only a browser can work out, done by code rather than AI.

  - Text contrast: each text element under the floor gets a new color. A
    colour that belongs to the client - one of the brand's, or a neutral -
    keeps its hue and saturation, with the lightness moved away from its
    background until it passes (with a small margin), so the brand colour
    stays recognizable. A colour that belongs to neither is NOT merely
    darkened: F31 (New Dawn, 9 November 2026) was an off-brand purple that
    came out a darker off-brand purple, written with !important, so the
    Creative Director's note about it was one the builder could not act on.
    Such an element is given a brand colour that passes, or failing that
    plain near-black or white, and the substitution is reported as a run
    note so the review knows code chose that colour.
  - The logo: a logo whose marks vanish against what sits behind it gets
    the dark treatment on a light background, or the white one on a dark
    background.

  The page comes in with its elements numbered (numberElements); what
  comes back is the numbers to fix and how. code-fixes.ts turns them into
  classes on those elements in the stored source, never into selectors by
  position.
*/

export interface RenderedFixes extends ElementFindings {
  fixed: string[];
  /* What code changed that the builder did not choose (stage 1 of docs/plans/self-check.md). */
  notes: RunNote[];
}

export async function computeRenderedFixes(browser: Browser, html: string, brandColors: string[] = []): Promise<RenderedFixes> {
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

    const found = await page.evaluate((brandHexes: string[]) => {
      type RGB = [number, number, number];
      const contrast: {
        n: number;
        color: string;
        from?: string;
        offBrand?: boolean;
        colourless?: boolean;
        overridden?: boolean;
        fighting?: string;
      }[] = [];
      const logos: { n: number; on: "light" | "dark" }[] = [];
      const edges: { n: number; side: string; color: string; from: string }[] = [];
      const fixed = new Set<string>();

      const parse = (value: string): RGB | null => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return null;
        const parts = m[1]!.split(",").map((p) => parseFloat(p.trim()));
        return parts.length < 3 ? null : [parts[0]!, parts[1]!, parts[2]!];
      };
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const ratio = (a: RGB, b: RGB) => {
        const la = luminance(a);
        const lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      };
      /* Measured as the check measures it (render.ts, 5 November 2026): see-through colours and fading count. */
      const alphaOf = (value: string): number => {
        const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(value);
        return m ? Math.max(0, Math.min(1, parseFloat(m[1]!))) : /rgba?\(/.test(value) ? 1 : 0;
      };
      const mix = (top: RGB, under: RGB, alpha: number): RGB => [
        top[0] * alpha + under[0] * (1 - alpha),
        top[1] * alpha + under[1] * (1 - alpha),
        top[2] * alpha + under[2] * (1 - alpha),
      ];
      const backgroundOf = (element: Element): RGB => {
        const layers: { color: RGB; alpha: number }[] = [];
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
        let result: RGB = [255, 255, 255];
        for (const layer of layers.reverse()) result = mix(layer.color, result, layer.alpha);
        return result;
      };
      const opacityOf = (element: Element): number => {
        let value = 1;
        for (let node: Element | null = element; node; node = node.parentElement) value *= parseFloat(getComputedStyle(node).opacity || "1");
        return value;
      };

      /*
        Text over a photo or a gradient: the colour behind it isn't one
        colour, so no shade worked out here would be right. Left for a
        person (or the design fixes) instead.
      */
      const pictures = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
        const style = getComputedStyle(el);
        return el.tagName === "IMG" || el.tagName === "PICTURE" || el.tagName === "VIDEO" || (style.backgroundImage !== "" && style.backgroundImage !== "none");
      });
      const overPicture = (element: Element): boolean => {
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
          const r = picture.getBoundingClientRect();
          return r.width > 0 && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
        });
      };

      /* The element's number in the stored source; null for one the browser made up. */
      const numberOf = (element: Element): number | null => {
        const value = element.getAttribute("data-tawd-n");
        return value === null ? null : Number(value);
      };

      const toHsl = ([r, g, b]: RGB): [number, number, number] => {
        const rn = r / 255, gn = g / 255, bn = b / 255;
        const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
        const l = (max + min) / 2;
        if (max === min) return [0, 0, l];
        const d = max - min;
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
        return [h / 6, s, l];
      };
      const fromHsl = ([h, s, l]: [number, number, number]): RGB => {
        if (s === 0) return [l * 255, l * 255, l * 255];
        const hue = (p: number, q: number, t: number) => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
      };
      const hex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

      /*
        Same hue, lightness moved away from the background until it passes,
        as it shows: a solid colour still faded by the opacity of the text
        and its ancestors (fade). null when even black or white wouldn't pass
        (the fading itself must go: left for the fix round).
      */
      const passingColor = (fg: RGB, bg: RGB, required: number, fade = 1): RGB | null => {
        const [h, s, l] = toHsl(fg);
        const darker = luminance(bg) > 0.3;
        const shows = (c: RGB) => ratio(mix(c, bg, fade), bg);
        for (let step = 1; step <= 100; step += 1) {
          const next = Math.max(0, Math.min(1, darker ? l - step / 100 : l + step / 100));
          const candidate = fromHsl([h, s, next]);
          if (shows(candidate) >= required + 0.2) return candidate;
          if (next === 0 || next === 1) break;
        }
        const end: RGB = darker ? [17, 17, 17] : [255, 255, 255];
        return shows(end) >= required ? end : null;
      };

      /*
        F31. The brand's own colours, and what counts as belonging to the
        client. A near-grey is always fine (text is usually grey or black,
        and grey has no hue to be wrong about); a colour with real
        saturation has to sit near one of the brand's hues. 20 degrees is
        about as far as a hue can move before a person calls it a different
        colour.
      */
      /*
        The intake holds brand colours as hex ("#8dc63f"); getComputedStyle
        answers in rgb(). `parse` only reads the second, so reading the brand
        list with it returned nothing and every colour looked like the
        client's own - caught by the test for this change before it shipped.
      */
      const parseHexOrRgb = (value: string): RGB | null => {
        const hexen = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
        if (!hexen) return parse(value);
        const digits = hexen[1]!;
        const full = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
      };
      const brandRgb = brandHexes.map(parseHexOrRgb).filter((c): c is RGB => c !== null);
      const NEUTRAL_SATURATION = 0.15;
      const HUE_REACH = 20 / 360;
      const hueGap = (a: number, b: number) => {
        const gap = Math.abs(a - b) % 1;
        return Math.min(gap, 1 - gap);
      };
      const belongsToTheClient = (c: RGB) => {
        const [h, sat] = toHsl(c);
        if (sat < NEUTRAL_SATURATION) return true;
        if (brandRgb.length === 0) return true; // No brand colours given: nothing to judge it against.
        return brandRgb.some((brand) => {
          const [bh, bs] = toHsl(brand);
          return bs < NEUTRAL_SATURATION ? false : hueGap(h, bh) <= HUE_REACH;
        });
      };
      /*
        A brand colour that can be read here, or plain near-black/white;
        never a darker version of a colour that was already wrong.

        The brand's coloured entries are tried before its neutral ones,
        because a brand list usually opens with #ffffff or #000000, and
        taking those first would turn an off-brand colour grey when the
        brand's actual colour was available.
      */
      const colourThatBelongs = (bg: RGB, required: number, fade: number): RGB | null => {
        const coloured = brandRgb.filter((c) => toHsl(c)[1] >= NEUTRAL_SATURATION);
        const neutrals = brandRgb.filter((c) => toHsl(c)[1] < NEUTRAL_SATURATION);
        for (const brand of [...coloured, ...neutrals]) {
          const candidate = passingColor(brand, bg, required, fade);
          if (candidate) return candidate;
        }
        const plain: RGB = luminance(bg) > 0.3 ? [17, 17, 17] : [255, 255, 255];
        return ratio(mix(plain, bg, fade), bg) >= required ? plain : null;
      };

      /*
        The page's own rule that is setting this element's colour with
        !important - the one TAWD's fix is fighting, and the one a person
        can remove.

        TAWD's OWN rules are skipped by the stylesheet they live in, not by
        their selector. The colour-rhythm step writes
        ".tawd-band-brand{...color:#fff !important}", so any text inside a
        brand band matches a rule of TAWD's own, and naming that to the
        builder would be the very unactionable instruction this note exists
        to stop. Every rule code writes is in the <style data-tawd-fixes>
        block; a rule the BUILDER wrote is not, even when it uses one of
        TAWD's class names.

        A sheet the browser will not open is skipped: a font sheet from
        another origin throws on cssRules, and that must not stop the
        measurement.
      */
      const pageColourRule = (element: Element): string | null => {
        for (const sheet of Array.from(document.styleSheets)) {
          const owner = sheet.ownerNode;
          if (owner instanceof Element && owner.hasAttribute("data-tawd-fixes")) continue;
          let rules: CSSRuleList;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            if (!(rule instanceof CSSStyleRule)) continue;
            const selector = rule.selectorText;
            if (!selector || /tawd-fix-\d+/.test(selector)) continue;
            if (rule.style.getPropertyPriority("color") !== "important") continue;
            try {
              if (element.matches(selector)) return selector;
            } catch {
              // A selector the browser kept but cannot match against: not ours to judge.
            }
          }
        }
        return null;
      };

      /* ---------- contrast ---------- */
      // Every element holding text itself, as the check reads them (5 November 2026).
      const notText = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "TITLE"]);
      const textNodes = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
        (el) => !notText.has(el.tagName) && !(el instanceof SVGElement),
      );
      for (const element of textNodes) {
        const text = element.textContent?.trim() ?? "";
        if (text.length < 3) continue;
        const ownText = Array.from(element.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent?.trim().length ?? 0) > 2,
        );
        if (!ownText) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const fade = opacityOf(element);
        if (fade < 0.1) continue;
        const fg = parse(style.color);
        if (!fg) continue;
        const size = parseFloat(style.fontSize || "16");
        const weight = parseInt(style.fontWeight || "400", 10);
        const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        if (overPicture(element)) continue;
        const bg = backgroundOf(element);
        if (ratio(mix(fg, bg, alphaOf(style.color) * fade), bg) >= required) continue;
        const n = numberOf(element);
        if (n === null) continue;
        /*
          White text on a mid-tone button can't get any lighter: the shade
          worked out is the colour it already has. That is no fix (the
          background would have to change), so it is left for a person.
        */
        /*
          F31: an off-brand colour is replaced, not darkened. Keeping its hue
          is only right when the hue was right to begin with.
        */
        const offBrand = !belongsToTheClient(fg);
        /*
          Plain white or plain black has no hue to keep (New Dawn,
          10 November 2026). White labels inside a white card went through
          the "it belongs to the client" path, because white is a neutral
          and a neutral was taken to be deliberate - so the hue was kept and
          the shade walked down until it passed, which turned every one of
          them #737373. Nobody designed a grey label: the Creative Director
          asked for the navy the headings use, and the grey cost the concept
          points on two questions.

          White that cannot be read means its background is light, so the
          white was simply wrong, and the same for black on a dark band.
          Both go through the brand chooser instead, which prefers a colour
          the client actually owns and falls back to near-black or
          near-white. A chosen grey - #999 on white - still keeps its hue
          and only moves darker, because that one was a decision.
        */
        const [, fgSat, fgLight] = toHsl(fg);
        const colourless = fgSat < NEUTRAL_SATURATION && (fgLight >= 0.95 || fgLight <= 0.05);
        const passing = offBrand || colourless ? colourThatBelongs(bg, required, fade) : passingColor(fg, bg, required, fade);
        if (!passing) continue;
        const color = hex(passing);
        // A see-through colour made solid is a fix even when the shade is the same.
        if (color === hex(fg) && alphaOf(style.color) >= 0.999) continue;
        /*
          Did TAWD already fix this element, and is it STILL failing? Then
          the page's own CSS is beating the fix rule (New Dawn: five form
          labels, two paid fix rounds, no change on the page). The rule is
          written stronger for it below, and the page's own rule is named,
          so the Creative Director can tell the builder which of ITS rules
          to remove instead of asking for a code fix to be undone.
        */
        const overridden = Array.from(element.classList).some((c) => /^tawd-fix-\d+$/.test(c));
        const fighting = overridden ? pageColourRule(element) : null;
        contrast.push({
          n,
          color,
          from: hex(fg),
          ...(offBrand ? { offBrand: true } : {}),
          ...(colourless ? { colourless: true } : {}),
          ...(overridden ? { overridden: true } : {}),
          ...(fighting ? { fighting } : {}),
        });
        fixed.add("contrast");
      }

      /*
        ---------- lines nobody can see ----------

        The same measurement render.ts's checks make, and it must stay in
        step with it: one bordered side only, 1 to 4px, no links, buttons or
        form controls, nothing absolutely placed or over a picture, and the
        line's colour all but identical to what is behind it (1.1 to 1).
        render.ts says why each of those limits is there.

        The colour it gets is chosen the way an off-brand text colour is: a
        colour the client actually owns that can be seen here, else plain
        near-black or near-white. 3 to 1 is the floor for something that is
        not text.
      */
      const SIDES = ["top", "right", "bottom", "left"] as const;
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
        if (parseFloat(style.getPropertyValue(`border-${side}-width`) || "0") > 4) continue;
        const value = style.getPropertyValue(`border-${side}-color`);
        const colour = parse(value);
        if (!colour || alphaOf(value) < 0.5) continue;
        const bg = backgroundOf(el);
        if (ratio(colour, bg) >= 1.1) continue;
        const n = numberOf(el);
        if (n === null) continue;
        const passing = colourThatBelongs(bg, 3, 1);
        if (!passing) continue;
        const color = hex(passing);
        if (color === hex(colour)) continue;
        edges.push({ n, side, color, from: hex(colour) });
        fixed.add("invisible lines");
      }

      /* ---------- the logo ---------- */
      for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img[data-tawd-logo]"))) {
        const box = img.getBoundingClientRect();
        if (box.width < 4 || box.height < 4 || !img.complete || img.naturalWidth === 0) continue;
        const style = getComputedStyle(img);
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
        if (weight === 0 || opaque / (w * h) > 0.97) continue;
        const bg = backgroundOf(img);
        if (ratio([r / weight, g / weight, b / weight], bg) >= 1.8) continue;
        const n = numberOf(img);
        if (n === null) continue;
        logos.push({ n, on: luminance(bg) > 0.3 ? "light" : "dark" });
        fixed.add("logo visibility");
      }

      return { contrast, logos, edges, fixed: [...fixed] };
    }, brandColors);

    /*
      The notes are built out here, not in the page: the browser side stays a
      pure measurement, and the wording lives with the rest of TAWD's words.
    */
    /*
      EVERY colour code changed is reported, not only the off-brand ones (New
      Dawn, 10 November 2026). A fix that kept the hue produced no note, so
      the Creative Director saw grey step titles and a washed-out strip title
      with no explanation and wrote "remove tawd-fix-24 to -29" - an
      instruction the builder cannot carry out, because these are code rules
      with !important. That is the unactionable-fix loop run notes exist to
      break, and it cost points on both concepts.
    */
    const whyRecoloured = (c: { offBrand?: boolean; colourless?: boolean }) => {
      if (c.colourless) {
        return "plain white or black could not be read on its background, and says nothing about the design, so it was given a colour the client owns where one works here, or plain near-black or near-white - not a grey nobody chose";
      }
      if (c.offBrand) {
        return "it could not be read on its background, and the colour it had is not one of the brand's, so making it darker would have left it off-brand";
      }
      return "it could not be read on its background, so the same colour was moved lighter or darker until it could";
    };
    const notes: RunNote[] = found.contrast.map((c) => ({
      step: "contrast",
      action: "substituted" as const,
      what: c.from ? `the text that was ${c.from}` : "a text colour",
      with: c.color,
      why: whyRecoloured(c),
    }));
    for (const e of found.edges) {
      notes.push({
        step: "lines",
        action: "substituted",
        what: `a ${e.side} line that was ${e.from}`,
        with: e.color,
        why: "it was drawn in the same colour as the background behind it, so nobody could see it",
      });
    }
    /*
      A fix that did not take says so, and names the page's own rule (New
      Dawn, 10 November 2026). This is the note that breaks the loop: the
      Creative Director was telling the builder to remove "tawd-fix-38 to
      -45", which the builder cannot do, when the rule that actually needed
      removing was the builder's own.
    */
    for (const c of found.contrast) {
      if (!c.overridden) continue;
      notes.push({
        step: "contrast",
        action: "changed",
        what: c.fighting ? `the page's own rule "${c.fighting}"` : "a colour the page's own CSS keeps overriding",
        with: "a stronger rule from TAWD",
        why: c.fighting
          ? "TAWD had already recoloured this text so it could be read, and that rule was still winning, so the text never changed. Remove it from the page's CSS rather than asking for TAWD's fix to be undone"
          : "TAWD had already recoloured this text and it still could not be read, so the page's own CSS is overriding the fix",
      });
    }
    return { ...found, notes };
  } finally {
    await context.close();
  }
}
