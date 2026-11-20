import { GOOGLE_FONT_FAMILIES } from "../figma/google-fonts";
import { normalizeHex } from "./palette";

/*
  "From the brand guide" (Jason, 26 September 2026): the brand guide PDF is
  read once, when it is uploaded, into suggestions the PM confirms: its
  colours, its fonts and its logo rules. No AI: this reads the PDF's text.
  A guide that is only pictures (a scan) has no text to read; that is said,
  and nothing is guessed.
*/

export interface BrandGuideColor {
  hex: string;
  /** The words just before it on its line: "Navy Blue", "Primary". */
  name: string | null;
}

export interface BrandGuideReading {
  colors: BrandGuideColor[];
  fonts: string[];
  logoRules: string[];
}

/* Commercial families that often appear in brand guides, besides every Google font. */
const OTHER_FONTS = [
  "Helvetica Neue", "Helvetica", "Arial", "Futura", "Gotham", "Proxima Nova", "Brandon Grotesque", "Avenir Next", "Avenir",
  "Garamond", "Adobe Garamond", "Minion Pro", "Myriad Pro", "Frutiga", "Frutiger", "Univers", "Gill Sans", "Trade Gothic",
  "Museo Sans", "Museo Slab", "Akzidenz-Grotesk", "DIN", "Neue Haas Grotesk", "Sofia Pro", "Circular", "Graphik", "Freight Text",
  "Freight Sans", "Georgia", "Times New Roman", "Verdana", "Calibri", "Segoe UI", "Baskerville", "Didot", "Bodoni", "Rockwell",
];
const FONT_NAMES = [...new Set([...GOOGLE_FONT_FAMILIES, ...OTHER_FONTS])].sort((a, b) => b.length - a.length);
const TYPE_LINE = /\b(font|fonts|typeface|typefaces|typography|type family|heading|headings|headline|body copy|body text|display)\b/i;
const LOGO_RULE = /\b(clear ?space|exclusion zone|minimum (size|width|height)|do not|don't|never|always|background|stretch|distort|rotate|recolou?r|outline|drop shadow|placement|reversed?|knock ?out|on (dark|light))\b/i;

export function readBrandGuideText(text: string): BrandGuideReading {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

  /* ---------- colours: #hex, "HEX 1F4E79", "RGB 31 78 121" ---------- */
  const colors: BrandGuideColor[] = [];
  const add = (hex: string | null, line: string, at: number) => {
    if (!hex || colors.some((c) => c.hex === hex)) return;
    const before = line
      .slice(0, at)
      .replace(/\b(hex|rgb|cmyk|pms|pantone|colou?r)\b[:\s]*/gi, " ")
      .replace(/[#:|,()\-–]+/g, " ")
      .trim();
    const name = /([A-Za-z][A-Za-z ]{1,30})$/.exec(before)?.[1]?.trim() ?? null;
    colors.push({ hex, name: name && name.length >= 3 ? name : null });
  };
  for (const line of lines) {
    for (const m of line.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(normalizeHex(m[1]!), line, m.index!);
    for (const m of line.matchAll(/\bhex(?:adecimal)?\s*[:#]?\s*([0-9a-f]{6})\b/gi)) add(normalizeHex(m[1]!), line, m.index!);
    for (const m of line.matchAll(/\bRGB\s*[:(]?\s*(\d{1,3})[\s,/]+(\d{1,3})[\s,/]+(\d{1,3})/gi)) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      if ([r, g, b].some((v) => v! > 255)) continue;
      add(`#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`.toUpperCase(), line, m.index!);
    }
    for (const m of line.matchAll(/\bR\s*[:=]?\s*(\d{1,3})\s+G\s*[:=]?\s*(\d{1,3})\s+B\s*[:=]?\s*(\d{1,3})\b/g)) {
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      if ([r, g, b].some((v) => v! > 255)) continue;
      add(`#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`.toUpperCase(), line, m.index!);
    }
  }

  /* ---------- fonts: known family names on lines about type ---------- */
  const fonts: string[] = [];
  // A line about type, or the line right under a short heading such as "Typography".
  const typeLines = lines.filter((line, i) => {
    const above = lines[i - 1] ?? "";
    return TYPE_LINE.test(line) || (above.length <= 30 && TYPE_LINE.test(above));
  });
  for (const line of typeLines) {
    let rest = line;
    for (const name of FONT_NAMES) {
      if (name.length < 3) continue;
      const pattern = new RegExp(`(^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`);
      if (pattern.test(rest)) {
        if (!fonts.includes(name)) fonts.push(name);
        // A longer name found first ("Helvetica Neue") keeps its shorter part ("Helvetica") from counting again.
        rest = rest.replace(pattern, "$1 ");
      }
    }
  }

  /* ---------- logo rules: sentences about using the logo ---------- */
  // A line end ends a sentence too: guides are full of short lines without full stops.
  const sentences = lines
    .flatMap((line) => line.split(/(?<=[.!?])\s+|\s*[•·▪]\s*/))
    .map((s) => s.trim())
    .filter(Boolean);
  const logoRules: string[] = [];
  for (const sentence of sentences) {
    if (!/\blogo(s|type|mark)?\b/i.test(sentence) || !LOGO_RULE.test(sentence)) continue;
    const rule = sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence;
    if (!logoRules.includes(rule)) logoRules.push(rule);
  }

  return { colors: colors.slice(0, 12), fonts: fonts.slice(0, 6), logoRules: logoRules.slice(0, 8) };
}
