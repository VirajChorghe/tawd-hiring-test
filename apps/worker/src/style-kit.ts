import type { Browser, Page } from "playwright-core";

import { inventoryPage, fontRole, type DesignReadPage, type PageInventory } from "@tawd/core/style-kit/elements";
import { FONT_CANDIDATES } from "@tawd/core/style-kit/fonts";
import { KIT_ICONS, iconSvg, type KitIcon as SetIcon } from "@tawd/core/style-kit/icon-set";
import { buildStyleKit, type FontChoice, type StyleKit } from "@tawd/core/style-kit/kit";
import { flatGrid } from "@tawd/core/style-kit/regions";
import { layoutSignature, type LayoutSignature } from "@tawd/core/style-kit/templates";
import { chooseIcons, closeGaps, textSimilarity } from "@tawd/core/style-kit/matching";
import { unpackMask } from "@tawd/core/style-kit/elements";
import { colorDistance, dominantColor, fromHex, rgbAt, type Pixels } from "@tawd/core/style-kit/pixels";
import type { Mask } from "@tawd/core/style-kit/contour";
import type { FontRole } from "@tawd/core/style-kit/elements";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  The style kit, in the worker (Jason, 28 September 2026): the browser
  decodes the design's pictures and draws the icon and font candidates;
  everything else is core code. No AI, so a kit costs nothing but a few
  seconds of Chromium, and the font files come from Google Fonts once.
*/

/* A picture drawn at the given width, as RGBA pixels. */
export async function decodePicture(browser: Browser, png: Buffer, width = 1440): Promise<Pixels> {
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    const out = await page.evaluate(
      async ({ src, width }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const h = Math.round((img.naturalHeight * width) / img.naturalWidth);
        const c = document.createElement("canvas");
        c.width = width;
        c.height = h;
        const x = c.getContext("2d")!;
        x.drawImage(img, 0, 0, width, h);
        const d = x.getImageData(0, 0, width, h).data;
        let s = "";
        const chunk = 0x8000;
        for (let i = 0; i < d.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(d.subarray(i, i + chunk)));
        return { h, b64: btoa(s) };
      },
      { src: `data:image/png;base64,${png.toString("base64")}`, width },
    );
    return { width, height: out.h, data: new Uint8Array(Buffer.from(out.b64, "base64")) };
  } finally {
    await context.close();
  }
}

let iconMasks: { item: SetIcon; mask: Mask }[] | null = null;

/* Every icon in the set drawn 64px, as masks (drawn once per worker). */
export async function setIconMasks(browser: Browser): Promise<{ item: SetIcon; mask: Mask }[]> {
  if (iconMasks) return iconMasks;
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    const svgs = KIT_ICONS.map((i) => iconSvg(i, 'width="64" height="64"'));
    const bits: string[] = await page.evaluate(async (list: string[]) => {
      const out: string[] = [];
      for (const svg of list) {
        const img = new Image();
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await img.decode();
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const x = c.getContext("2d")!;
        x.drawImage(img, 0, 0, 64, 64);
        const d = x.getImageData(0, 0, 64, 64).data;
        let s = "";
        for (let i = 3; i < d.length; i += 4) s += d[i]! > 100 ? "1" : "0";
        out.push(s);
      }
      return out;
    }, svgs);
    iconMasks = bits.map((s, i) => ({ item: KIT_ICONS[i]!, mask: { w: 64, h: 64, on: Uint8Array.from(s, (c) => (c === "1" ? 1 : 0)) } }));
    return iconMasks;
  } finally {
    await context.close();
  }
}

interface Sample {
  role: FontRole;
  text: string;
  weight: number;
  mask: Mask;
}

/* Lines of text from the design (one line each, the largest few per kind of font), as ink masks. */
function textSamples(pages: { pixels: Pixels; read: DesignReadPage }[], perRole = 4): Sample[] {
  const all: (Sample & { area: number })[] = [];
  for (const { pixels, read } of pages) {
    for (const t of read.texts) {
      if (t.h < 14 || !t.color || t.h > t.size * 1.7 || t.w < t.h) continue;
      const pad = 3;
      const box = { x: Math.max(0, t.x - pad), y: Math.max(0, t.y - pad), w: Math.min(pixels.width - t.x, t.w + pad * 2), h: Math.min(pixels.height - t.y, t.h + pad * 2) };
      const bg = dominantColor(pixels, box, 1).color;
      const ink = fromHex(t.color);
      const full = colorDistance(ink, bg);
      if (full < 60) continue;
      const on = new Uint8Array(box.w * box.h);
      for (let y = 0; y < box.h; y += 1) {
        for (let x = 0; x < box.w; x += 1) {
          const px = rgbAt(pixels, box.x + x, box.y + y);
          on[y * box.w + x] = colorDistance(px, bg) > full * 0.5 && colorDistance(px, ink) < full * 0.6 ? 1 : 0;
        }
      }
      all.push({ role: fontRole(t), text: t.text, weight: t.weight, mask: closeGaps({ w: box.w, h: box.h, on }, Math.max(1, Math.round(t.h / 40))), area: t.w * t.h });
    }
  }
  const out: Sample[] = [];
  for (const role of ["script", "display", "serif", "sans"] as FontRole[]) {
    const mine = all.filter((s) => s.role === role).sort((a, b) => b.area - a.area);
    const seen = new Set<string>();
    for (const s of mine) {
      if (seen.has(s.text) || seen.size >= perRole) continue;
      seen.add(s.text);
      out.push(s);
    }
  }
  return out;
}

/* The candidate families from Google Fonts; resolves with the ones that really loaded (a family that didn't would be drawn in the fallback and scored wrongly). */
async function loadFamilies(page: Page, families: string[]): Promise<string[]> {
  const links = families.flatMap((f) => {
    const name = f.replace(/ /g, "+");
    return [`https://fonts.googleapis.com/css2?family=${name}&display=block`, `https://fonts.googleapis.com/css2?family=${name}:wght@700&display=block`];
  });
  // The stylesheets get up to a minute, as before (5 November 2026); each font file 10 s at most, so none can hang the kit.
  await loadHtml(page, `<html><head>${links.map((l) => `<link rel="stylesheet" href="${l}">`).join("")}</head><body></body></html>`, { settleMs: 60_000, what: "The font samples", free: true });
  return page.evaluate(async (fams: string[]) => {
    const bounded = (p: Promise<unknown>) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
    for (const f of fams) for (const w of [400, 700]) await bounded(document.fonts.load(`${w} 40px "${f}"`, "Aa"));
    return fams.filter((f) => document.fonts.check(`400 40px "${f}"`, "Aa"));
  }, families);
}

/* The words drawn in a family at 60px, as masks. */
async function drawTexts(page: Page, family: string, texts: { text: string; weight: number }[]): Promise<Mask[]> {
  const bits: string[] = await page.evaluate(
    ({ family, texts }) =>
      texts.map((t) => {
        const size = 60;
        const c = document.createElement("canvas");
        const x = c.getContext("2d")!;
        x.font = `${t.weight} ${size}px "${family}", monospace`;
        const w = Math.ceil(x.measureText(t.text).width) + 20;
        c.width = w;
        c.height = size * 2;
        x.font = `${t.weight} ${size}px "${family}", monospace`;
        x.fillStyle = "#fff";
        x.fillRect(0, 0, w, c.height);
        x.fillStyle = "#000";
        x.textBaseline = "middle";
        x.fillText(t.text, 10, size);
        const d = x.getImageData(0, 0, w, c.height).data;
        let s = `${w},${c.height},`;
        for (let i = 0; i < d.length; i += 4) s += d[i]! < 128 ? "1" : "0";
        return s;
      }),
    { family, texts },
  );
  return bits.map((s) => {
    const [w, h, b] = s.split(",");
    return { w: Number(w), h: Number(h), on: Uint8Array.from(b!, (c) => (c === "1" ? 1 : 0)) };
  });
}

/* For each kind of lettering in the design, the candidate font whose shapes come closest. */
export async function chooseFonts(browser: Browser, pages: { pixels: Pixels; read: DesignReadPage }[], overrides: Partial<Record<FontRole, string>> = {}): Promise<FontChoice[]> {
  const samples = textSamples(pages);
  const context = await ownPageContext(browser);
  try {
    const page = await context.newPage();
    const choices: FontChoice[] = [];
    for (const role of ["script", "display", "serif", "sans"] as FontRole[]) {
      const mine = samples.filter((s) => s.role === role);
      if (mine.length === 0) continue;
      const families = FONT_CANDIDATES[role];
      const loaded = await loadFamilies(page, families);
      const scored: { family: string; score: number }[] = [];
      // Only fonts that loaded are compared; if none did (Google Fonts down), all are, as before.
      for (const family of loaded.length ? loaded : families) {
        const drawn = await drawTexts(page, family, mine);
        const scores = mine.map((s, i) => textSimilarity(s.mask, drawn[i]!));
        scored.push({ family, score: scores.reduce((a, b) => a + b, 0) / scores.length });
      }
      scored.sort((a, b) => b.score - a.score);
      // The designer's choice wins; the matches stay as the alternatives.
      const chosen = overrides[role];
      if (chosen) {
        const own = scored.find((x) => x.family === chosen);
        scored.splice(0, scored.length, { family: chosen, score: own?.score ?? 1 }, ...scored.filter((x) => x.family !== chosen));
      }
      const weights = [...new Set(pages.flatMap((p) => p.read.texts.filter((t) => fontRole(t) === role).map((t) => (t.weight >= 600 ? 700 : 400))))];
      choices.push({ role, family: scored[0]!.family, score: scored[0]!.score, alternatives: scored.slice(1, 4), weights, files: [] });
    }
    return choices;
  } finally {
    await context.close();
  }
}

/* The kit for a design's pages: inventories, icons matched or traced, fonts chosen. */
export async function buildKitForPages(
  browser: Browser,
  pages: { png: Buffer; read: DesignReadPage }[],
  overrides: Partial<Record<FontRole, string>> = {},
  pickFonts: typeof chooseFonts = chooseFonts,
): Promise<{ kit: StyleKit; inventories: PageInventory[]; signatures: LayoutSignature[] }> {
  const decoded = [];
  for (const p of pages) decoded.push({ pixels: await decodePicture(browser, p.png), read: p.read });
  const inventories = decoded.map((d, i) => inventoryPage(d.pixels, d.read, pages.length > 1 ? `p${i + 1}-` : ""));
  const masks = await setIconMasks(browser);
  const icons = inventories.flatMap((inv) => inv.sections.flatMap((s) => s.elements.filter((e) => e.kind === "icon").map((e) => ({ id: e.id, mask: unpackMask((e as { mask: string }).mask), group: (e as { group: string | null }).group }))));
  const choices = chooseIcons(icons, masks);
  const fonts = await pickFonts(browser, decoded, overrides);
  const kit = buildStyleKit({ pages: inventories, icons: choices, fonts });
  const signatures = decoded.map((d) => layoutSignature(flatGrid(d.pixels)));
  return { kit, inventories, signatures };
}

/*
  The chosen fonts' files, fetched once from Google Fonts (the Latin
  subset, woff2) so the site can host them itself. A weight a family
  doesn't have falls back to the family's regular.
*/
const MODERN_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export async function fetchFontFile(family: string, weight: number): Promise<Buffer | null> {
  for (const query of [`${family.replace(/ /g, "+")}:wght@${weight}`, family.replace(/ /g, "+")]) {
    try {
      const css = await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=swap`, { headers: { "User-Agent": MODERN_BROWSER } });
      if (!css.ok) continue;
      const text = await css.text();
      // The block after the "latin" comment (not latin-ext); else the last block.
      const blocks = text.split("/*").map((b) => b.trim());
      const latin = blocks.find((b) => b.startsWith("latin */")) ?? blocks[blocks.length - 1] ?? "";
      const url = /url\((https:[^)]+\.woff2)\)/.exec(latin)?.[1];
      if (!url) continue;
      const file = await fetch(url);
      if (file.ok) return Buffer.from(await file.arrayBuffer());
    } catch {
      // Try the next form, else report the font as not fetched.
    }
  }
  return null;
}
