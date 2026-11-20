import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { SPEED_IMAGES_FILE, SPEED_VIEWPORTS, tuneTags, type PageSeen, type Renamed } from "@tawd/core/site";
import { ownPageContext } from "./locked-context";
import { openPage } from "./page-load";

/*
  The speed pass (Jason, 1 October 2026: "get the PageSpeed numbers up and
  fix everything in code"). Every build's finished files, before they're
  stored, by code (no AI, no cost), for Netlify and WordPress alike:

  - Pictures at the size they're shown (twice that, for sharp screens), as
    WebP, under /assets/ with their content in the name, so browsers may
    keep them for a year. The sample client's 818 KB logo shown at 108 x 72 was the
    worst of it. A picture is only swapped when the new one is smaller.
  - Pictures below the first screen load when they're scrolled to; the
    biggest one on the first screen loads first.
  - Google Fonts from the site itself: only the families the site uses,
    the Latin files, loaded early (no waiting on Google, no jump when the
    font arrives).
  - A link with no words (an icon-only phone button) gets a label.

  If something can't be done (Google Fonts unreachable, a picture that
  won't decode), it's left as built, with a note.
*/

export interface SpeedReport {
  images: { from: string; to: string; before: number; after: number }[];
  fonts: { kept: string[]; dropped: string[]; files: number; matched: string[] } | null;
  lazy: number;
  labels: number;
  sections: number;
  /** The header's logo became the site's icon. */
  icon?: boolean;
  /** Phone menus that ran off the screen, kept on it. */
  menus?: number;
  notes: string[];
}

const RASTER = /\.(jpe?g|png|webp)$/i;
const TEXT = /\.(html|css|js|json|xml|txt|webmanifest)$/i;
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const VIEWPORTS = SPEED_VIEWPORTS;

const hash8 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "file";

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
}

const pagePathOf = (file: string) => (file === "index.html" ? "/" : file.endsWith("/index.html") ? `/${file.slice(0, -"index.html".length)}` : `/${file}`);

/* A site path ("/images/a.jpg") everywhere it's used as an address, except in <meta> tags (sharing pictures stay as they are). */
export function replacePath(text: string, from: string, to: string, html: boolean): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<=["'(\\s,=])${escaped}(?=["')\\s,?#]|$)`, "g");
  if (!html) return text.replace(pattern, to);
  return text
    .split(/(<meta\b[^>]*>)/i)
    .map((part) => (/^<meta\b/i.test(part) ? part : part.replace(pattern, to)))
    .join("");
}

/* ---------- Google Fonts, from the site itself ---------- */

const GOOGLE_LINK = /<link\b[^>]*href=["'](https:\/\/fonts\.googleapis\.com\/css2?\?[^"']+)["'][^>]*>\s*/gi;
const GOOGLE_PRECONNECT = /<link\b[^>]*rel=["'](?:preconnect|dns-prefetch)["'][^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com\/?["'][^>]*>\s*/gi;
const GOOGLE_IMPORT = /@import\s+url\(\s*["']?(https:\/\/fonts\.googleapis\.com\/css2?\?[^"')]+)["']?\s*\)[^;]*;\s*/gi;

/* The families a Google Fonts address asks for ("Fraunces", "Source Sans 3"). */
export function fontFamilies(url: string): string[] {
  const query = url.split("?")[1] ?? "";
  return query
    .split("&")
    .filter((p) => p.startsWith("family="))
    .map((p) => decodeURIComponent(p.slice(7).replace(/\+/g, " ")).split(":")[0]!.trim());
}

/* The same address with only these families (null: none left). */
export function keepFamilies(url: string, keep: Set<string>): string | null {
  const [base, query = ""] = url.split("?");
  const parts = query.split("&").filter((p) => !p.startsWith("family=") || keep.has(decodeURIComponent(p.slice(7).replace(/\+/g, " ")).split(":")[0]!.trim()));
  return parts.some((p) => p.startsWith("family=")) ? `${base}?${parts.join("&")}` : null;
}

/* Whether the site's styles name a family (in font-family, or a variable that feeds one). */
export function familyUsed(styles: string, family: string): boolean {
  const name = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:["']${name}["']|[:,]\\s*${name}\\s*[,;}!])`, "i").test(styles);
}

/* Google's stylesheet for these fonts: the Latin @font-face rules, their files to fetch. */
export function latinFaces(css: string): { rules: string[]; files: string[] } {
  const rules: string[] = [];
  const files: string[] = [];
  const blocks = css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g);
  for (const [, subset, rule] of blocks) {
    if (subset !== "latin" && subset !== "latin-ext") continue;
    rules.push(rule!);
    for (const [, url] of rule!.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) if (!files.includes(url!)) files.push(url!);
  }
  return { rules, files };
}

type FontFetch = (url: string, init?: RequestInit) => Promise<Response>;
let fontFetch: FontFetch | null = null;
/** Tests pass a stand-in for Google Fonts. */
export function setFontFetchForTesting(stand: FontFetch | null): void {
  fontFetch = stand;
}

/*
  A stand-in of the same size for each font while it loads (Arial or
  Georgia, scaled), so nothing moves when the real one arrives: the sample client's
  menu wrapped onto two lines in Arial and the page jumped 15 px. The
  real font is measured in the build's browser; Arial and Georgia were
  measured once (Windows, 1 October 2026), as the worker has neither.
*/
export const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog. Call us today for a free quote, we answer every message within the hour.";
export const STAND_INS = {
  sans: { local: "Arial", width: 5258.25, ascent: 91, descent: 21 },
  serif: { local: "Georgia", width: 5185.06, ascent: 92, descent: 22 },
} as const;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Whether the site's stack for a family falls back to a serif ("Fraunces", Georgia, serif). */
export function isSerifStack(styles: string, family: string): boolean {
  const m = new RegExp(`["']${escapeRe(family)}["']\\s*,([^;}]*)`, "i").exec(styles);
  return Boolean(m && /(^|[,\s])serif\b/i.test(m[1]!) && !/sans-serif/i.test(m[1]!));
}

export function fallbackRule(family: string, web: { width: number; ascent: number; descent: number }, standIn: { local: string; width: number }): string {
  const size = web.width / standIn.width;
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return `@font-face{font-family:"${family} Fallback";src:local("${standIn.local}");size-adjust:${pct(size)};ascent-override:${pct(web.ascent / 100 / size)};descent-override:${pct(web.descent / 100 / size)};line-gap-override:0%}`;
}

/* "Fraunces" in the site's styles becomes "Fraunces","Fraunces Fallback" (in the same quotes). */
export function addFallbacks(text: string, families: string[]): string {
  let out = text;
  for (const f of families) {
    const name = escapeRe(f);
    out = out.replace(new RegExp(`(["'])${name}\\1(?!\\s*,\\s*["']${name} Fallback)`, "g"), (m, q: string) => `${m},${q}${f} Fallback${q}`);
  }
  return out;
}

/* One font file measured in the page: the sample's width and the font's height above and below the line, at 100 px. */
const FONT_PROBE_SCRIPT = `async function (url, sample) {
  var name = "tawd-probe-" + Math.random().toString(36).slice(2);
  var face = new FontFace(name, "url(" + url + ")");
  await face.load();
  document.fonts.add(face);
  var c = document.createElement("canvas").getContext("2d");
  c.font = '100px "' + name + '"';
  var m = c.measureText(sample);
  return { width: m.width, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
}`;

async function fallbackFaces(browser: Browser, origin: string, rules: string[], families: string[], styles: string): Promise<{ family: string; rule: string }[]> {
  const out: { family: string; rule: string }[] = [];
  const context = await ownPageContext(browser, {}, [origin]);
  try {
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    for (const family of families) {
      const own = rules.filter((r) => r.includes(`'${family}'`) && !/unicode-range:[^;]*U\+0100/.test(r) && !/font-style:\s*italic/.test(r));
      const pick = own.find((r) => /font-weight:\s*400\b/.test(r)) ?? own[0];
      const url = pick && /url\((\/assets\/fonts\/[^)]+)\)/.exec(pick)?.[1];
      if (!url) continue;
      const web = (await tab.evaluate(`(${FONT_PROBE_SCRIPT})(${JSON.stringify(url)}, ${JSON.stringify(FONT_SAMPLE)})`).catch(() => null)) as { width: number; ascent: number; descent: number } | null;
      if (!web || !web.width) continue;
      out.push({ family, rule: fallbackRule(family, web, isSerifStack(styles, family) ? STAND_INS.serif : STAND_INS.sans) });
    }
  } finally {
    await context.close();
  }
  return out;
}

async function selfHostFonts(dist: string, htmlFiles: string[], cssFiles: string[], report: SpeedReport, browser: Browser, origin: string): Promise<void> {
  const read = async (f: string) => fs.readFile(path.join(dist, f), "utf8");
  const html = new Map(await Promise.all(htmlFiles.map(async (f) => [f, await read(f)] as const)));
  const css = new Map(await Promise.all(cssFiles.map(async (f) => [f, await read(f)] as const)));
  const urls = new Set<string>();
  for (const text of html.values()) for (const m of text.matchAll(GOOGLE_LINK)) urls.add(m[1]!.replace(/&amp;/g, "&"));
  for (const text of css.values()) for (const m of text.matchAll(GOOGLE_IMPORT)) urls.add(m[1]!);
  if (!urls.size) return;

  // The site's own styles, without the font addresses themselves.
  const styles = [...css.values(), ...[...html.values()].flatMap((t) => [...t.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|style=["']([^"']*)["']/gi)].map((m) => m[1] ?? m[2] ?? ""))].join("\n");
  const asked = [...new Set([...urls].flatMap(fontFamilies))];
  const used = new Set(asked.filter((f) => familyUsed(styles, f)));
  const dropped = asked.filter((f) => !used.has(f));
  const wanted = [...urls].map((u) => keepFamilies(u, used)).filter((u): u is string => u !== null);

  const rules: string[] = [];
  const preload: string[] = [];
  let files = 0;
  try {
    for (const url of wanted) {
      const response = await (fontFetch ?? fetch)(url, { headers: { "User-Agent": CHROME_UA }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Google Fonts answered ${response.status}`);
      const faces = latinFaces(await response.text());
      const local = new Map<string, string>();
      for (const file of faces.files) {
        const got = await (fontFetch ?? fetch)(file, { signal: AbortSignal.timeout(20_000) });
        if (!got.ok) throw new Error(`a font file answered ${got.status}`);
        const bytes = new Uint8Array(await got.arrayBuffer());
        const family = /font-family:\s*'([^']+)'/.exec(faces.rules.find((r) => r.includes(file)) ?? "")?.[1] ?? "font";
        const name = `/assets/fonts/${slug(family)}-${hash8(bytes)}.woff2`;
        await fs.mkdir(path.join(dist, "assets", "fonts"), { recursive: true });
        await fs.writeFile(path.join(dist, name.slice(1)), bytes);
        local.set(file, name);
        files += 1;
      }
      for (const rule of faces.rules) rules.push(rule.replace(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g, (_m, u: string) => `url(${local.get(u)})`));
      // The Latin files load early (variable fonts: one file serves every weight).
      for (const [file, name] of local) if (faces.rules.some((r) => r.includes(file) && r.startsWith("@font-face") && !/unicode-range:[^;]*U\+0100/.test(r))) preload.push(name);
    }
  } catch (error) {
    report.notes.push(`Google Fonts weren't copied to the site (${error instanceof Error ? error.message : "no answer"}): they still load from Google.`);
    return;
  }

  const fallbacks = await fallbackFaces(browser, origin, rules, [...used], styles).catch(() => [] as { family: string; rule: string }[]);
  const withFallback = fallbacks.map((f) => f.family);
  const faces = [...rules, ...fallbacks.map((f) => f.rule)];
  const head = [...new Set(preload)].slice(0, 4).map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`).join("") + (faces.length ? `<style id="tawd-fonts">${faces.join("")}</style>` : "");
  for (const [file, text] of html) {
    let out = addFallbacks(text.replace(GOOGLE_LINK, "").replace(GOOGLE_PRECONNECT, ""), withFallback);
    const charset = /<meta\b[^>]*charset[^>]*>/i.exec(out);
    const at = charset ? charset.index + charset[0].length : (/<head\b[^>]*>/i.exec(out)?.index ?? -1) + (/<head\b[^>]*>/i.exec(out)?.[0].length ?? 0);
    if (at > 0) out = out.slice(0, at) + head + out.slice(at);
    await fs.writeFile(path.join(dist, file), out, "utf8");
  }
  for (const [file, text] of css) await fs.writeFile(path.join(dist, file), addFallbacks(text.replace(GOOGLE_IMPORT, ""), withFallback), "utf8");
  report.fonts = { kept: [...used], dropped, files, matched: withFallback };
}

/* ---------- what the pages show, measured in the browser ---------- */

interface Seen {
  pages: Map<string, PageSeen>;
  /** Per picture path: the widest it's shown on a computer and on a phone, in CSS pixels. */
  shown: Map<string, { desktop: number; phone: number }>;
}

/*
  The code that runs in the page, as text: what a bundler adds to named
  functions doesn't exist there.
*/
const MEASURE_SCRIPT = `(() => {
  function local(u) {
    try {
      var url = new URL(u, location.href);
      return url.origin === location.origin ? decodeURIComponent(url.pathname) : null;
    } catch (e) {
      return null;
    }
  }
  var imgs = Array.from(document.images).map(function (img) {
    var r = img.getBoundingClientRect();
    return { src: local(img.currentSrc || img.src), top: r.top + window.scrollY, w: r.width, h: r.height };
  });
  var backgrounds = [];
  Array.from(document.querySelectorAll("body *")).forEach(function (el) {
    var bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") return;
    var re = /url\\("?([^")]+)"?\\)/g, m;
    while ((m = re.exec(bg))) {
      var src = local(m[1]);
      if (src) backgrounds.push({ src: src, w: el.getBoundingClientRect().width });
    }
  });
  var anchors = Array.from(document.querySelectorAll("a"));
  var unnamed = [];
  anchors.forEach(function (a, i) {
    var label = a.getAttribute("aria-label"), title = a.getAttribute("title");
    // Only a link a visitor can see right now (a closed menu's links have their words when it opens).
    var shown = typeof a.checkVisibility === "function" ? a.checkVisibility() : a.getClientRects().length > 0;
    var named = !shown || Boolean((a.innerText || "").trim() || (label && label.trim()) || a.getAttribute("aria-labelledby") || (title && title.trim()) || Array.from(a.querySelectorAll("img")).some(function (x) { return x.alt.trim(); }) || a.querySelector("svg title"));
    if (!named) unnamed.push({ i: i, href: a.getAttribute("href") || "", text: a.textContent || "" });
  });
  var main = document.querySelector("main");
  var sections = main ? Array.from(main.children).map(function (el) {
    var r = el.getBoundingClientRect();
    // A fixed or sticky part inside (a floating call button) must stay painted: such a section is never deferred.
    var pinned = [el].concat(Array.from(el.querySelectorAll("*"))).some(function (x) {
      var p = getComputedStyle(x).position;
      return p === "fixed" || p === "sticky";
    });
    return { top: r.top + window.scrollY, h: r.height, pinned: pinned };
  }) : [];
  return { imgs: imgs, backgrounds: backgrounds, unnamed: unnamed, anchors: anchors.length, sections: sections };
})()`;

/* One picture at a few widths, as WebP (data: addresses); widths past the picture's own are left out. */
const SHRINK_SCRIPT = `async function (url, widths) {
  var img = new Image();
  img.src = url;
  await img.decode();
  var done = [], out = [];
  for (var k = 0; k < widths.length; k++) {
    var w = Math.min(widths[k], img.naturalWidth);
    if (done.some(function (d) { return Math.abs(d - w) / w < 0.15; })) continue;
    done.push(w);
    var h = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var g = canvas.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, w, h);
    var blob = await new Promise(function (ok) { canvas.toBlob(ok, "image/webp", 0.8); });
    if (!blob || blob.type !== "image/webp") return null;
    var data = await new Promise(function (ok) {
      var reader = new FileReader();
      reader.onload = function () { ok(String(reader.result)); };
      reader.readAsDataURL(blob);
    });
    out.push({ w: w, data: data });
  }
  return out;
}`;

async function measure(browser: Browser, origin: string, htmlFiles: string[]): Promise<Seen> {
  const seen: Seen = { pages: new Map(), shown: new Map() };
  for (const [k, viewport] of VIEWPORTS.entries()) {
    const context = await ownPageContext(browser, { viewport, deviceScaleFactor: 1 }, [origin]);
    try {
      const tab = await context.newPage();
      for (const file of htmlFiles) {
        try {
          // Measured only once everything loaded: half-loaded pictures would give wrong heights (skipped, as before 0.123.1).
          if (!(await openPage(tab, `${origin}${pagePathOf(file)}`))) continue;
        } catch {
          continue;
        }
        const got = (await tab.evaluate(MEASURE_SCRIPT)) as { imgs: { src: string | null; top: number; w: number; h: number }[]; backgrounds: { src: string; w: number }[]; unnamed: { i: number; href: string; text: string }[]; anchors: number; sections: { top: number; h: number; pinned?: boolean }[] };
        // An answer that isn't the measurement (a stand-in browser) leaves the page as built.
        if (!got || !Array.isArray(got.imgs) || !Array.isArray(got.unnamed) || !Array.isArray(got.sections)) continue;
        const page: PageSeen = seen.pages.get(file) ?? { imgs: [], sections: [], unnamed: new Map(), anchors: got.anchors };
        page.imgs[k] = got.imgs;
        page.sections[k] = got.sections;
        for (const u of got.unnamed) page.unnamed.set(u.i, { href: u.href, text: u.text });
        seen.pages.set(file, page);
        for (const shown of [...got.imgs, ...got.backgrounds]) {
          if (!shown.src || shown.w <= 0) continue;
          const was = seen.shown.get(shown.src) ?? { desktop: 0, phone: 0 };
          if (k === 0) was.desktop = Math.max(was.desktop, shown.w);
          else was.phone = Math.max(was.phone, shown.w);
          seen.shown.set(shown.src, was);
        }
      }
    } finally {
      await context.close();
    }
  }
  return seen;
}

/* ---------- pictures ---------- */

async function shrinkPictures(browser: Browser, origin: string, dist: string, seen: Seen, report: SpeedReport): Promise<Renamed> {
  const renamed: Renamed = new Map();
  const context = await ownPageContext(browser, {}, [origin]);
  try {
    const tab = await context.newPage();
    await tab.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    for (const [src, shown] of seen.shown) {
      if (!RASTER.test(src) || src.startsWith("/assets/")) continue;
      const file = path.join(dist, src.slice(1));
      const before = await fs.stat(file).then((s) => s.size).catch(() => 0);
      if (!before) continue;
      // As shown on a computer and a phone, and twice that for sharp screens; largest first.
      const widths = [shown.desktop * 2, shown.desktop, shown.phone * 2, shown.phone].filter((w) => w > 0).map(Math.ceil).sort((a, b) => b - a);
      const made = (await tab.evaluate(`(${SHRINK_SCRIPT})(${JSON.stringify(src)}, ${JSON.stringify(widths)})`).catch(() => null)) as { w: number; data: string }[] | null;
      if (!made?.length) {
        report.notes.push(`${src} couldn't be made smaller: it's kept as it was.`);
        continue;
      }
      const sizes = made.map((m) => ({ w: m.w, bytes: new Uint8Array(Buffer.from(m.data.split(",")[1]!, "base64")) }));
      if (sizes[0]!.bytes.length > before * 0.95) continue;
      const base = slug(path.basename(src).replace(/\.[^.]+$/, ""));
      await fs.mkdir(path.join(dist, "assets", "images"), { recursive: true });
      const set: { w: number; url: string }[] = [];
      for (const size of sizes) {
        const url = `/assets/images/${base}-${size.w}-${hash8(size.bytes)}.webp`;
        await fs.writeFile(path.join(dist, url.slice(1)), size.bytes);
        set.push({ w: size.w, url });
      }
      renamed.set(src, { main: set[0]!.url, set, dw: Math.round(shown.desktop || shown.phone), pw: Math.round(shown.phone || shown.desktop) });
      report.images.push({ from: src, to: set[0]!.url, before, after: sizes[0]!.bytes.length });
    }
  } finally {
    await context.close();
  }
  return renamed;
}

/* ---------- the site's icon ---------- */

/* The header's logo as a 64 px PNG (a data: address), or null. */
const ICON_SCRIPT = `async function (url) {
  var img = new Image();
  img.src = url;
  await img.decode();
  var side = 64, scale = Math.min(side / img.naturalWidth, side / img.naturalHeight);
  var w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  var canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  var g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
  return canvas.toDataURL("image/png");
}`;

/*
  Browsers ask every site for an icon; without one each page logs a
  "404" (PageSpeed's Best Practices). The header's logo becomes the icon;
  with no logo, an empty icon stops the request.
*/
async function addIcon(browser: Browser, origin: string, dist: string, htmlFiles: string[], report: SpeedReport): Promise<void> {
  const pages = await Promise.all(htmlFiles.map(async (f) => [f, await fs.readFile(path.join(dist, f), "utf8")] as const));
  if (pages.some(([, h]) => /<link\b[^>]*rel=["'][^"']*\bicon\b/i.test(h))) return;
  const home = pages.find(([f]) => f === "index.html")?.[1] ?? pages[0]?.[1] ?? "";
  const header = /<header\b[\s\S]*?<\/header>/i.exec(home)?.[0] ?? "";
  const logo = [...header.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).find((t) => /logo/i.test(t)) ?? null;
  const src = logo && /\ssrc=["'](\/[^"']+)["']/i.exec(logo)?.[1];
  let href = "data:,";
  if (src && !/\.svg$/i.test(src)) {
    const context = await ownPageContext(browser, {}, [origin]);
    try {
      const tab = await context.newPage();
      await tab.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      const data = (await tab.evaluate(`(${ICON_SCRIPT})(${JSON.stringify(src)})`).catch(() => null)) as string | null;
      if (data) {
        const bytes = new Uint8Array(Buffer.from(data.split(",")[1]!, "base64"));
        href = `/assets/images/icon-${hash8(bytes)}.png`;
        await fs.mkdir(path.join(dist, "assets", "images"), { recursive: true });
        await fs.writeFile(path.join(dist, href.slice(1)), bytes);
      }
    } finally {
      await context.close();
    }
  } else if (src) {
    href = src;
  }
  for (const [file, html] of pages) {
    const head = /<\/head>/i.exec(html);
    if (head) await fs.writeFile(path.join(dist, file), `${html.slice(0, head.index)}<link rel="icon" href="${href}">${html.slice(head.index)}`, "utf8");
  }
  report.icon = href !== "data:,";
}

/* ---------- the phone menu, on the screen ---------- */

/*
  Each <details> menu in the header, opened at a phone's width: the parts
  that run off the screen, with a selector for each (its own classes inside
  the menu's). The sample client's menu was pinned to its button, not the screen, and lost
  its first letters on a real phone (Jason, 1 October 2026).
*/
const MENU_SCRIPT = `(() => {
  function sel(el) {
    var cls = Array.from(el.classList).filter(function (c) { return /^[A-Za-z_][\\w-]*$/.test(c); });
    return el.tagName.toLowerCase() + cls.map(function (c) { return "." + c; }).join("");
  }
  var out = [];
  Array.from(document.querySelectorAll("header details")).forEach(function (d) {
    d.open = true;
    var vw = document.documentElement.clientWidth;
    Array.from(d.querySelectorAll("*")).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.position !== "absolute" && cs.position !== "fixed") return;
      var r = el.getBoundingClientRect();
      if (!r.width || (r.left >= 0 && r.right <= vw)) return;
      var s = "details" + sel(d).slice(7) + "[open] " + sel(el);
      if (document.querySelectorAll(s).length !== 1) return;
      out.push({ selector: s, top: Math.round(r.top) });
    });
    d.open = false;
  });
  return out;
})()`;

/* The rule that keeps a menu panel on a phone's screen: 12 px from each side, below its button, scrolling when tall. */
export function phoneMenuRule(selector: string, top: number): string {
  return `@media (max-width:600px){${selector}{position:fixed;left:12px;right:12px;width:auto;max-width:none;top:${top}px;max-height:calc(100vh - ${top + 12}px);overflow:auto}}`;
}

async function keepMenusOnScreen(browser: Browser, origin: string, dist: string, htmlFiles: string[], report: SpeedReport): Promise<void> {
  const found = new Map<string, number>();
  for (const width of [360, 412]) {
    const context = await ownPageContext(browser, { viewport: { width, height: 800 }, deviceScaleFactor: 1 }, [origin]);
    try {
      const tab = await context.newPage();
      await openPage(tab, `${origin}/`);
      const off = (await tab.evaluate(MENU_SCRIPT).catch(() => [])) as { selector: string; top: number }[];
      if (!Array.isArray(off)) continue;
      for (const o of off) found.set(o.selector, Math.max(found.get(o.selector) ?? 0, o.top));
    } finally {
      await context.close();
    }
  }
  if (!found.size) return;
  const rules = [...found].map(([s, top]) => phoneMenuRule(s, top)).join("");
  for (const file of htmlFiles) {
    const html = await fs.readFile(path.join(dist, file), "utf8");
    const head = /<\/head>/i.exec(html);
    if (head) await fs.writeFile(path.join(dist, file), `${html.slice(0, head.index)}<style id="tawd-phone-menu">${rules}</style>${html.slice(head.index)}`, "utf8");
  }
  report.menus = found.size;
}

/* ---------- the whole pass ---------- */

export async function speedUpSite(browser: Browser, dist: string, origin: string): Promise<SpeedReport> {
  const report: SpeedReport = { images: [], fonts: null, lazy: 0, labels: 0, sections: 0, notes: [] };
  const all = await listFiles(dist);
  const htmlFiles = all.filter((f) => f.endsWith(".html"));
  const cssFiles = all.filter((f) => f.endsWith(".css"));

  await selfHostFonts(dist, htmlFiles, cssFiles, report, browser, origin);
  await addIcon(browser, origin, dist, htmlFiles, report).catch(() => undefined);
  await keepMenusOnScreen(browser, origin, dist, htmlFiles, report).catch(() => undefined);
  const seen = await measure(browser, origin, htmlFiles);
  const renamed = await shrinkPictures(browser, origin, dist, seen, report);

  const textFiles = (await listFiles(dist)).filter((f) => TEXT.test(f));
  /*
    A picture is renamed only where the files really name it, in any of the
    ways a page can write its address (Fable's B3, 3 October 2026): the
    browser measures "/images/my photo.jpg", the page may say
    "/images/my%20photo.jpg". One no file names is left as it was, and its
    smaller copies are removed, so nothing points at a missing file.
  */
  const originals = await Promise.all(textFiles.map((f) => fs.readFile(path.join(dist, f), "utf8")));
  for (const [from, to] of [...renamed]) {
    if (originals.some((t) => pathForms(from).some((form) => t.includes(form)))) continue;
    renamed.delete(from);
    report.images = report.images.filter((i) => i.from !== from);
    report.notes.push(`${from} isn't named the same way in the pages, so it's kept as it was.`);
    for (const size of to.set) await fs.rm(path.join(dist, size.url.slice(1)), { force: true });
  }
  for (const file of textFiles) {
    let text = await fs.readFile(path.join(dist, file), "utf8");
    const before = text;
    for (const [from, to] of renamed) for (const form of pathForms(from)) text = replacePath(text, form, to.main, file.endsWith(".html"));
    const page = seen.pages.get(file);
    if (page && file.endsWith(".html")) text = tuneTags(text, page, renamed, report, file);
    if (text !== before) await fs.writeFile(path.join(dist, file), text, "utf8");
  }
  // The sizes of each picture, for the WordPress package (its picture blocks get them back from the theme).
  if (renamed.size) {
    await fs.mkdir(path.join(dist, path.dirname(SPEED_IMAGES_FILE)), { recursive: true });
    await fs.writeFile(path.join(dist, SPEED_IMAGES_FILE), JSON.stringify(Object.fromEntries([...renamed.values()].map((r) => [r.main, { set: r.set, dw: r.dw ?? 0, pw: r.pw ?? 0 }]))), "utf8");
  }
  // The originals nothing points at any more go (a sharing picture in <meta> keeps its own).
  const texts = await Promise.all(textFiles.map((f) => fs.readFile(path.join(dist, f), "utf8")));
  for (const from of renamed.keys()) {
    if (!texts.some((t) => pathForms(from).some((form) => t.includes(form)))) await fs.rm(path.join(dist, from.slice(1)), { force: true });
  }
  return report;
}

/* The ways a page can write a site path: as is, URL-encoded ("my%20photo.jpg"), and with "&" written "&amp;" in HTML. */
export function pathForms(sitePath: string): string[] {
  let encoded = sitePath;
  try {
    encoded = encodeURI(sitePath);
  } catch {
    // A path that can't be encoded is only ever written as is.
  }
  return [...new Set([sitePath, encoded, sitePath.replace(/&/g, "&amp;"), encoded.replace(/&/g, "&amp;")])];
}

/*
  The speed pass on a normal build, all or nothing (Fable's B4, 3 October
  2026): a copy of the site is kept first, and put back if the pass stops
  part-way, so a build is never stored half changed. The reason is passed
  on for the build's notes.
*/
export async function speedUpSiteSafely(browser: Browser, dist: string, origin: string): Promise<SpeedReport> {
  const backup = path.join(path.dirname(dist), `${path.basename(dist)}.before-speed`);
  await fs.rm(backup, { recursive: true, force: true });
  await fs.cp(dist, backup, { recursive: true });
  try {
    return await speedUpSite(browser, dist, origin);
  } catch (error) {
    await fs.rm(dist, { recursive: true, force: true });
    await fs.cp(backup, dist, { recursive: true });
    throw error;
  } finally {
    await fs.rm(backup, { recursive: true, force: true });
  }
}

/* One line for the build's notes. */
export function speedLine(r: SpeedReport): string {
  const before = r.images.reduce((n, i) => n + i.before, 0);
  const after = r.images.reduce((n, i) => n + i.after, 0);
  const parts = [
    r.images.length ? `${r.images.length} picture${r.images.length === 1 ? "" : "s"} made smaller (${Math.round(before / 1024)} KB to ${Math.round(after / 1024)} KB)` : null,
    r.fonts ? `fonts served from the site (${r.fonts.kept.join(", ") || "none"}${r.fonts.dropped.length ? `; unused ${r.fonts.dropped.join(", ")} left out` : ""})` : null,
    r.lazy ? `${r.lazy} picture${r.lazy === 1 ? "" : "s"} below the first screen load when scrolled to` : null,
    r.sections ? `${r.sections} section${r.sections === 1 ? "" : "s"} far down the pages laid out only when scrolled near` : null,
    r.labels ? `${r.labels} link${r.labels === 1 ? "" : "s"} given a label` : null,
    r.icon ? "the logo as the site's icon" : null,
    r.menus ? `the phone menu kept on the screen` : null,
  ].filter(Boolean);
  return parts.length ? `Speed: ${parts.join("; ")}.` : "Speed: nothing to change.";
}
