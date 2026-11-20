import type { CheckIssue } from "./checks";
import type { DirectionId } from "./directions";
import type { BandKind } from "./pictures";
import { replaceSections, splitSections } from "./sections";

/*
  Pages that pop (Jason, 8 October 2026, Finley's concept B: "the site was
  dull, it did not pop... the BG colours were all very subtle, had to change
  a few sections BG to the neon green to make it look presentable").

  Code sets the background rhythm per direction (Jason's yes, 8 October):
  how many bands between the header and the footer carry the full brand
  colour, and the longest run of pale bands (white or a light tint) allowed.
  The builder is told the rule; the rendered page is measured; and when it
  falls short, code turns the right pale bands to the brand colour (as Jason
  did by hand), free, with the contrast fix run straight after.
*/

export interface Rhythm {
  /** Bands in the full brand colour, at least. */
  fullBands: number;
  /** Pale bands in a row, at most. */
  maxPaleRun: number;
}

export const RHYTHM: Record<DirectionId, Rhythm> = {
  bold_emergency: { fullBands: 3, maxPaleRun: 2 },
  bright_friendly: { fullBands: 3, maxPaleRun: 2 },
  classic_trust: { fullBands: 2, maxPaleRun: 2 },
  warm_local: { fullBands: 2, maxPaleRun: 2 },
  rugged_craftsman: { fullBands: 2, maxPaleRun: 2 },
  brand_led: { fullBands: 2, maxPaleRun: 2 },
  heritage_established: { fullBands: 2, maxPaleRun: 3 },
  technical_precision: { fullBands: 2, maxPaleRun: 3 },
  editorial_authority: { fullBands: 1, maxPaleRun: 3 },
  modern_clean: { fullBands: 1, maxPaleRun: 3 },
  premium_upscale: { fullBands: 1, maxPaleRun: 3 },
  clinical_calm: { fullBands: 1, maxPaleRun: 3 },
  // The work is the colour: no rule.
  gallery_portfolio: { fullBands: 0, maxPaleRun: 99 },
};

export function rhythmFor(direction: string): Rhythm | null {
  return (RHYTHM as Record<string, Rhythm>)[direction] ?? null;
}

/* The rule for the builder. */
export function rhythmRule(direction: string): string {
  const r = rhythmFor(direction);
  if (!r || r.fullBands === 0) return "";
  return `- Section backgrounds (TAWD measures this on the rendered page): at least ${r.fullBands} band${r.fullBands === 1 ? "" : "s"} between the header and the footer use${r.fullBands === 1 ? "s" : ""} the full brand colour as ${r.fullBands === 1 ? "its" : "their"} background, with readable text on ${r.fullBands === 1 ? "it" : "them"}${r.fullBands >= 2 ? ": a band early on, and the call-to-action band before the footer" : ""}. A band led by a full-bleed photograph counts as one of them. Never two full brand-colour bands in a row: between full-colour bands, alternate white, a light tint of the brand colour, or a photo-led band, and never put more than ${r.maxPaleRun} pale band${r.maxPaleRun === 1 ? "" : "s"} (white or a light tint) in a row. Subtle, washed-out backgrounds everywhere read as dull.`;
}

/* ---------- colours ---------- */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(r: number, g: number, b: number): Hsl {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: h * 60, s, l };
}

export function parseColour(value: string): Hsl | null {
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    let v = hex[1]!;
    if (v.length === 3) v = v.split("").map((c) => c + c).join("");
    return toHsl(parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16));
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i.exec(value);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) < 0.5) return null;
    return toHsl(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return null;
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

export type Background = "brand" | "pale" | "strong";

/*
  A band's background: the full brand colour (saturated, mid lightness, a
  brand hue), pale (white, a light tint, a light grey), or strong (a dark
  or photo band: not dull, but not the brand colour). "image" is a photo.
*/
export function classifyBackground(value: string, brandColors: string[]): Background {
  if (value === "image") return "strong";
  const c = parseColour(value);
  if (!c) return "pale";
  if (c.l >= 0.8 || (c.s < 0.15 && c.l >= 0.6)) return "pale";
  const brands = brandColors.map(parseColour).filter((b): b is Hsl => b !== null && b.s >= 0.2);
  if (c.s >= 0.3 && c.l >= 0.18 && c.l <= 0.75 && brands.some((b) => hueGap(b.h, c.h) <= 25)) return "brand";
  return "strong";
}

/* ---------- the check and the plan ---------- */

/* The order bands are turned to the brand colour in: calls to action and proof first, never the hero, a form's band last. */
const PREFERENCE: BandKind[] = ["contact", "why", "proof", "process", "area", "services", "other", "about", "reviews", "faq"];

export interface RhythmResult {
  issues: CheckIssue[];
  /** The bands (by index among all bands) code would turn to the brand colour. */
  plan: number[];
}

export function checkRhythm(input: {
  /** Every band's background, in page order (header and footer included). */
  backgrounds: string[];
  kinds: BandKind[];
  brandColors: string[];
  direction: string;
  /** Whether the page has real photos to lead a band with (the client's, or the current site's). */
  hasPhotos?: boolean;
}): RhythmResult {
  const rhythm = rhythmFor(input.direction);
  if (!rhythm || rhythm.fullBands === 0 || input.brandColors.length === 0) return { issues: [], plan: [] };
  const main = input.kinds
    .map((kind, index) => ({
      index,
      kind,
      bg: classifyBackground(input.backgrounds[index] ?? "", input.brandColors),
      image: (input.backgrounds[index] ?? "") === "image",
    }))
    .filter((b) => b.kind !== "header" && b.kind !== "footer");
  if (main.length < 3) return { issues: [], plan: [] };

  const longestRun = (list: { bg: Background }[], of: Background = "pale") => {
    let run = 0;
    let most = 0;
    for (const b of list) {
      run = b.bg === of ? run + 1 : 0;
      most = Math.max(most, run);
    }
    return most;
  };

  const issues: CheckIssue[] = [];

  /*
    Flat brand runs (the design-skills diagnosis, 8 November 2026): two full
    brand-colour bands in a row read as one navy slab. Not code-fixable — the
    fix round varies them (a photo band, a pale band or a light tint between).
  */
  // The LONGEST brand run and where it starts, in one pass (the first adjacent pair can belong to a shorter run).
  let brandRun = 0;
  let runStart = 0;
  for (let i = 0, r = 0; i < main.length; i += 1) {
    r = main[i]!.bg === "brand" ? r + 1 : 0;
    if (r > brandRun) {
      brandRun = r;
      runStart = i - r + 1;
    }
  }
  if (brandRun > 1) {
    issues.push({
      id: "design.colourRhythm.flatRun",
      severity: "fail",
      sections: main.slice(runStart, runStart + brandRun).map((b) => b.index),
      message: `${brandRun} bands in a row carry the full brand colour, which reads as one flat slab. Break them up: a photo-led band, a white band or a light tint of the brand colour between full-colour bands — never two full-colour bands in a row.`,
    });
  }

  /*
    Photo bands count toward the rhythm (the diagnosis: the reference sites
    lead with photography) — and when the page HAS real photos, at least one
    band must be led by one.
  */
  const imageBands = main.filter((b) => b.image).length;
  if (input.hasPhotos && imageBands === 0) {
    issues.push({
      id: "design.photoBand",
      severity: "fail",
      // The bands the message names, so the fix round works on them, not on the pale-rhythm plan's bands.
      sections: main.filter((b) => b.kind === "hero" || b.kind === "proof").map((b) => b.index),
      message:
        "No band is led by a photograph, though the page has real photos. Give one band a full-bleed photo background (the hero, or a proof band), by its tawd-asset token, with readable text over it.",
    });
  }

  // A photo-led band carries as much visual weight as a brand band, so it counts toward the full bands.
  const full = main.filter((b) => b.bg === "brand").length + imageBands;
  const run = longestRun(main);
  if (full >= rhythm.fullBands && run <= rhythm.maxPaleRun) return { issues, plan: [] };

  /* The plan: break every long pale run in its middle with the best band, then add bands until there are enough. */
  const working = main.map((b) => ({ ...b }));
  const plan: number[] = [];
  const rank = (kind: BandKind) => {
    const at = PREFERENCE.indexOf(kind);
    return at === -1 ? PREFERENCE.length : at;
  };
  // Never create the slab the flat-run check exists to prevent: a band next to a brand band is no candidate.
  const clearOfBrand = (b: { index: number }) => {
    const at = working.findIndex((w) => w.index === b.index);
    return working[at - 1]?.bg !== "brand" && working[at + 1]?.bg !== "brand";
  };
  const turn = (candidates: typeof working) => {
    const best = candidates.filter((b) => b.bg === "pale" && b.kind !== "hero" && clearOfBrand(b)).sort((a, b) => rank(a.kind) - rank(b.kind))[0];
    if (!best) return false;
    best.bg = "brand";
    plan.push(best.index);
    return true;
  };

  // The call-to-action band before the footer first, then the long pale runs broken, then the best of the rest.
  const lastMain = working[working.length - 1];
  if (working.filter((b) => b.bg === "brand").length < rhythm.fullBands && lastMain && lastMain.bg === "pale" && lastMain.kind !== "hero" && clearOfBrand(lastMain)) {
    lastMain.bg = "brand";
    plan.push(lastMain.index);
  }
  for (let guard = 0; guard < working.length && longestRun(working) > rhythm.maxPaleRun; guard += 1) {
    // The first run that is too long, and its middle part.
    let start = 0;
    let length = 0;
    for (let i = 0, r = 0; i < working.length; i += 1) {
      r = working[i]!.bg === "pale" ? r + 1 : 0;
      if (r > rhythm.maxPaleRun) {
        length = r;
        start = i - r + 1;
        while (start + length < working.length && working[start + length]!.bg === "pale") length += 1;
        break;
      }
    }
    if (length === 0) break;
    const middle = working.slice(start + 1, start + length - 1);
    if (!turn(middle.length ? middle : working.slice(start, start + length))) break;
  }
  while (working.filter((b) => b.bg === "brand").length + imageBands < rhythm.fullBands && turn(working)) {
    /* keep turning */
  }

  issues.push({
    id: "design.colourRhythm",
    severity: "fail",
    message: `Too pale for this direction: ${full} band${full === 1 ? "" : "s"} in the full brand colour or led by a photo (needs ${rhythm.fullBands}) and up to ${run} pale bands in a row (at most ${rhythm.maxPaleRun}).${plan.length ? ` TAWD turns band${plan.length === 1 ? "" : "s"} ${plan.join(", ")} to the brand colour.` : ""}`,
    where: plan.join(","),
  });
  return { issues, plan: [...new Set(plan)].sort((a, b) => a - b) };
}

/* A colour that reads on the brand colour: white on a dark one, near-black on a light one. */
export function readableOn(hex: string): string {
  const c = parseColour(hex);
  return c && c.l > 0.6 ? "#111111" : "#ffffff";
}

export const BRAND_BAND_CLASS = "tawd-band-brand";

/*
  The style rule for the bands code turned to the brand colour (the contrast
  fix follows). The design-skills diagnosis (8 November 2026) showed the old
  rule — background + background-image:none — literally manufactured the
  flat-navy-slab fault, painting over whatever the band had. Now only the
  background COLOUR is set and any background imagery is kept, multiplied
  with the brand colour: a gradient or texture becomes a deep brand tint of
  itself instead of a flat wall.
*/
export function brandBandRule(brandHex: string): string {
  return `.${BRAND_BAND_CLASS}{background-color:${brandHex} !important;background-blend-mode:multiply !important;color:${readableOn(brandHex)} !important}`;
}

/* Marks the planned bands with the brand-band class, on their opening tags. Running it twice changes nothing more. */
export function markBrandBands(html: string, indexes: number[]): string {
  const sections = splitSections(html);
  const replacements = new Map<number, string>();
  for (const index of indexes) {
    const band = sections.find((s) => s.index === index);
    if (!band) continue;
    const tagEnd = band.html.indexOf(">");
    if (tagEnd < 0) continue;
    const open = band.html.slice(0, tagEnd);
    if (open.includes(BRAND_BAND_CLASS)) continue;
    const classAttr = /\sclass\s*=\s*(["'])([^"']*)\1/i.exec(open);
    const nextOpen = classAttr
      ? open.replace(classAttr[0], ` class=${classAttr[1]}${classAttr[2]} ${BRAND_BAND_CLASS}${classAttr[1]}`)
      : `${open} class="${BRAND_BAND_CLASS}"`;
    replacements.set(index, nextOpen + band.html.slice(tagEnd));
  }
  return replacements.size ? replaceSections(html, sections, replacements) : html;
}
