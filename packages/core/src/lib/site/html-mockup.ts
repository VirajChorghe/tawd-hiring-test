import { parseDocument } from "htmlparser2";
import type { ChildNode, Element, Text } from "domhandler";

import { ASSET_SCHEME, photoToken } from "../mockups/assets";
import { isActiveUrl, stripActiveContent } from "./safe-html";

/*
  Reading a homepage mockup that the team uploaded as HTML (16 November
  2026). VML builds client homepage mockups as one self-contained HTML file,
  and the source already holds everything a picture of the page would lose:
  the real CSS, fonts, text, icons and photos. So TAWD takes the HTML
  directly and sends it down the same road as an approved Lane 1 mockup.

  A Lane 1 concept is stored with tokens (tawd-asset:photo-1), never with
  inlined images, and the site build writes each token as /images/photo-1.webp.
  This module makes an uploaded file look the same: its embedded photos
  become tokens plus separate image files, and the page is cleaned for
  Build A (plain HTML and CSS). Nothing is done silently: everything removed
  or refused comes back as a sentence the team can read.

  The file is untrusted data, never instructions: it is only read as text,
  never run, and nothing in it is passed on as an instruction.
*/

export interface ExtractedImage {
  /** "tawd-asset:photo-1" and so on, as written into the page. */
  token: string;
  /** Always a real image type: image/png, image/jpeg, image/webp, image/gif or image/avif. */
  contentType: string;
  bytes: Uint8Array;
}

export interface ExtractedFont {
  /** "tawd-asset:font-1" and so on, as written into the page's CSS url(...). */
  token: string;
  /** Always one of font/woff2, font/woff, font/ttf, font/otf. */
  contentType: string;
  bytes: Uint8Array;
}

export interface HtmlMockupRead {
  /** The cleaned page: no scripts, no event handlers, photos as tokens, fonts as tokens. */
  html: string;
  /** Photos only. Fonts are kept apart in `fonts` so nothing that writes images ever writes a font as a picture. */
  images: ExtractedImage[];
  fonts: ExtractedFont[];
  /** What was taken out, in plain English, for the team to see. */
  removed: string[];
  /** Things that need a person's eye (an image refused, a cap hit). */
  warnings: string[];
}

/* Abuse guards: a page has a handful of photos, not hundreds, and none is 50 MB. */
export const MAX_EXTRACTED_IMAGES = 40;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/* Only formats the site build knows how to serve. SVG is left out on purpose: it can carry script. */
const IMAGE_TYPES: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "image/avif": "image/avif",
};

/* The first bytes of a real file of each type. A label that lies about its content is refused. */
function looksLike(type: string, b: Uint8Array): boolean {
  const at = (i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));
  switch (type) {
    case "image/png":
      return b[0] === 0x89 && at(1, "PNG");
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8;
    case "image/webp":
      return at(0, "RIFF") && at(8, "WEBP");
    case "image/gif":
      return at(0, "GIF8");
    case "image/avif":
      return at(4, "ftyp");
    default:
      return false;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- A3: scripts, event handlers, javascript: links ---------- */

/*
  The cleaning itself is done by safe-html.ts, TAWD's parser-based allow-list
  (audit F-011). The regexes that used to do it here were not sound: a split
  tag reassembled into a live script, an attribute with no space before it
  survived, an empty comment hid an <img onerror>, and a <style> inside an
  SVG is markup to a browser. A parser reads the page the way a browser does,
  so none of those tricks work on it. What stays in this file is only the
  REPORT: the team is told what was taken out, worked out by reading the page
  before and after the cleaner, never by a second pattern of our own. The
  report is a courtesy; the safety is entirely the cleaner's.
*/

/*
  Say what a script was for, so "3 scripts removed" can add "(one was the FAQ
  open/close)". Only a guess from its words, and worded as one.
*/
function describeScript(open: string, body: string): string {
  const text = `${open} ${body}`.toLowerCase();
  if (/application\/ld\+json/.test(text)) return "structured data for search engines";
  if (/gtag\(|googletagmanager|datalayer|analytics|fbq\(|_paq/.test(text)) return "tracking or analytics";
  if (/faq|accordion|aria-expanded|details|toggle/.test(text)) return "the FAQ open/close";
  if (/nav|menu|hamburger|drawer/.test(text)) return "the mobile menu";
  if (/scroll|intersectionobserver|reveal|animate/.test(text)) return "a scroll effect";
  if (/slider|carousel|swiper|slide/.test(text)) return "a slider";
  if (/submit|formdata|fetch\(|xmlhttprequest|\.value/.test(text)) return "form handling";
  if (/\ssrc\s*=/.test(open)) return "an outside script file";
  return "page behaviour";
}

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "data", "poster", "background", "srcset"]);
const EMBED_TAGS = new Set(["iframe", "object", "embed", "applet", "base", "frame", "frameset", "portal"]);

/* What a page holds that the cleaner is meant to take out, counted by reading it. */
interface Census {
  scripts: string[];
  handlers: number;
  activeLinks: number;
  embeds: number;
  refreshes: number;
  sheetLinks: number;
  styleText: string;
}

function census(html: string): Census {
  const c: Census = { scripts: [], handlers: 0, activeLinks: 0, embeds: 0, refreshes: 0, sheetLinks: 0, styleText: "" };
  const walk = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      const name = el.name.toLowerCase();
      if (node.type === "script" || name === "script") {
        const open = Object.entries(el.attribs).map(([k, v]) => ` ${k}="${v}"`).join("");
        const body = el.children.map((child) => (child.type === "text" ? (child as Text).data : "")).join("");
        c.scripts.push(describeScript(open, body));
        continue;
      }
      if (EMBED_TAGS.has(name)) c.embeds += 1;
      if (name === "meta" && Object.keys(el.attribs).some((k) => k.toLowerCase() === "http-equiv")) c.refreshes += 1;
      if (name === "link") c.sheetLinks += 1;
      if (name === "style") c.styleText += el.children.map((child) => (child.type === "text" ? (child as Text).data : "")).join("");
      for (const [key, value] of Object.entries(el.attribs)) {
        const k = key.toLowerCase();
        if (/^on[a-z]/.test(k)) c.handlers += 1;
        else if (name !== "link" && URL_ATTRS.has(k) && k !== "srcset" && isActiveUrl(value)) c.activeLinks += 1;
      }
      walk(el.children);
    }
  };
  walk(parseDocument(html).children);
  return c;
}

function describeRemoval(before: Census, after: Census): string[] {
  const removed: string[] = [];
  const gone = (a: number, b: number) => Math.max(0, a - b);
  if (before.scripts.length) {
    const counts = new Map<string, number>();
    for (const p of before.scripts) counts.set(p, (counts.get(p) ?? 0) + 1);
    const detail = [...counts].map(([p, n]) => (n === 1 ? `one was ${p}` : `${n} were ${p}`)).join("; ");
    removed.push(
      /*
        Said precisely, because the supplied home page is KEPT as it is and
        never rebuilt: a menu or an FAQ that ran on a script simply stops
        working on it. Only the other pages are written fresh, without script.
      */
      `${plural(before.scripts.length, "script")} removed (${detail}). The supplied home page is kept exactly as it is, so anything that ran on a script - a menu button, an open-and-close FAQ - will not work on it. The other pages are built without scripts.`,
    );
  }
  const handlers = gone(before.handlers, after.handlers);
  if (handlers) removed.push(`${plural(handlers, "inline event handler")} removed (attributes like onclick that run script when clicked or loaded).`);
  const links = gone(before.activeLinks, after.activeLinks);
  if (links) removed.push(`${plural(links, "javascript: link")} replaced with a plain "#" link.`);
  const embeds = gone(before.embeds, after.embeds) + gone(before.refreshes, after.refreshes);
  if (embeds) removed.push(`${plural(embeds, "embedded frame, object or automatic page redirect")} removed (they can load or run content from elsewhere).`);
  const sheets = gone(before.sheetLinks, after.sheetLinks);
  if (sheets) removed.push(`${plural(sheets, "<link> tag")} removed (an outside style sheet, or an icon, that is not on Google Fonts or in the page itself; a tab icon written as an svg data address is one).`);
  if (before.styleText !== after.styleText) {
    removed.push("Some CSS was changed: any @import or url() that loaded something from another website was taken out (Google Fonts and the page's own pictures and fonts stay).");
  }
  return removed;
}

/* ---------- A2: embedded photos become asset tokens ---------- */

/*
  The base64 may be wrapped over several lines (a tool that writes a file
  with a line width does that), so a line break plus its indent is allowed
  between runs of characters, but only when more base64 follows it. (Runs, not
  one character at a time: a repeated group per character overflows the regex
  stack on a multi-megabyte picture.) A plain space
  is NOT allowed: in a srcset a space ends the address ("data:...  2x"). Each
  piece starts with a different character, so there is nothing to backtrack
  over and the match stays linear however large the input is.
*/
const B64 = String.raw`[A-Za-z0-9+/]+(?:(?:\r\n|\n|\r)[ \t]*[A-Za-z0-9+/]+)*={0,2}`;
const DATA_IMAGE = new RegExp(String.raw`data:(image/[A-Za-z0-9.+-]+);base64,(${B64})`, "gi");
const unwrap = (b64: string) => b64.replace(/\s+/g, "");

/*
  A picture or font that is refused is not left as an empty address: src=""
  makes a browser ask for the page itself, and a hole with no mark would slip
  past the house rule that missing content shows a visible [PLACEHOLDER] and
  blocks go-live. It becomes a token with no file behind it. The site build
  already turns such a token into "[PLACEHOLDER: image missing-photo-1]" (in
  an <img>) or drops it (in CSS), and the go-live check then refuses the site.
*/
const missingPhoto = (n: number) => `${ASSET_SCHEME}missing-photo-${n}`;
const missingFont = (n: number) => `${ASSET_SCHEME}missing-font-${n}`;

function extractImages(html: string, warnings: string[]): { html: string; images: ExtractedImage[] } {
  const images: ExtractedImage[] = [];
  /* The same picture used twice gets one token, used in both places. A refused one is remembered too, so it is reported once. */
  const seen = new Map<string, string>();
  let missing = 0;

  const out = html.replace(DATA_IMAGE, (whole, declared: string, wrapped: string) => {
    const known = seen.get(whole);
    if (known !== undefined) return known;
    const b64 = unwrap(wrapped);
    const reject = (why: string) => {
      warnings.push(`An embedded picture was left out: ${why}. It shows as a [PLACEHOLDER] until a real picture is supplied.`);
      const token = missingPhoto((missing += 1));
      seen.set(whole, token);
      return token;
    };

    const type = IMAGE_TYPES[declared.toLowerCase()];
    if (!type) return reject(`its type (${declared.toLowerCase()}) is not a photo format TAWD accepts (png, jpeg, webp, gif, avif)`);
    if (images.length >= MAX_EXTRACTED_IMAGES) return reject(`the page already has ${MAX_EXTRACTED_IMAGES} pictures, the most TAWD takes from one file`);
    if ((b64.length * 3) / 4 > MAX_IMAGE_BYTES + 3) return reject(`it is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB once decoded`);

    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (bytes.length === 0) return reject("it is empty");
    if (bytes.length > MAX_IMAGE_BYTES) return reject(`it is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB once decoded`);
    if (!looksLike(type, bytes)) return reject(`its contents are not really ${type}`);

    const token = photoToken(images.length);
    images.push({ token, contentType: type, bytes });
    seen.set(whole, token);
    return token;
  });
  return { html: out, images };
}

/* ---------- embedded fonts become asset tokens too ---------- */

/*
  A page made in Claude carries its fonts inside the CSS as base64 (about
  140 KB on the first real file, against about 19 KB of actual CSS). That CSS
  is sent to the model on every page-build call as the site's stylesheet, and
  the model never needs font bytes, so they are lifted out exactly like
  photos and left as tokens in url(...). Whatever writes the built site's
  files has to write each font and point the token at it.
*/
export const MAX_EXTRACTED_FONTS = 16;
export const MAX_FONT_BYTES = 2 * 1024 * 1024;

/* Every spelling of a font type seen in the wild, mapped to the four TAWD accepts. */
const FONT_TYPES: Record<string, string> = {
  "font/woff2": "font/woff2",
  "application/font-woff2": "font/woff2",
  "application/x-font-woff2": "font/woff2",
  "font/woff": "font/woff",
  "application/font-woff": "font/woff",
  "application/x-font-woff": "font/woff",
  "font/ttf": "font/ttf",
  "application/x-font-ttf": "font/ttf",
  "application/x-font-truetype": "font/ttf",
  "font/otf": "font/otf",
  "application/x-font-opentype": "font/otf",
  "application/x-font-otf": "font/otf",
  "font/sfnt": "font/sfnt",
  "application/font-sfnt": "font/sfnt",
};

/* First bytes of a real font file: wOF2, wOFF, OTTO, 00 01 00 00 or "true". A label that lies is refused. */
function fontLooksLike(type: string, b: Uint8Array): boolean {
  const at = (text: string) => [...text].every((c, k) => b[k] === c.charCodeAt(0));
  const isOtto = at("OTTO");
  const isTrueType = (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || at("true");
  switch (type) {
    case "font/woff2":
      return at("wOF2");
    case "font/woff":
      return at("wOFF");
    case "font/otf":
      return isOtto;
    case "font/ttf":
      return isTrueType;
    case "font/sfnt":
      return isOtto || isTrueType;
    default:
      return false;
  }
}

const DATA_FONT = new RegExp(
  String.raw`data:((?:font/|application/(?:x-)?font-|application/vnd\.ms-fontobject)[A-Za-z0-9.+-]*);base64,(${B64})`,
  "gi",
);

function extractFonts(html: string, warnings: string[]): { html: string; fonts: ExtractedFont[] } {
  const fonts: ExtractedFont[] = [];
  const seen = new Map<string, string>();
  let missing = 0;

  const out = html.replace(DATA_FONT, (whole, declared: string, wrapped: string) => {
    const known = seen.get(whole);
    if (known !== undefined) return known;
    const b64 = unwrap(wrapped);
    const reject = (why: string) => {
      warnings.push(`An embedded font was left out: ${why}.`);
      const token = missingFont((missing += 1));
      seen.set(whole, token);
      return token;
    };

    const type = FONT_TYPES[declared.toLowerCase()];
    if (!type) return reject(`its type (${declared.toLowerCase()}) is not a font format TAWD accepts (woff2, woff, ttf, otf)`);
    if (fonts.length >= MAX_EXTRACTED_FONTS) return reject(`the page already has ${MAX_EXTRACTED_FONTS} fonts, the most TAWD takes from one file`);
    if ((b64.length * 3) / 4 > MAX_FONT_BYTES + 3) return reject(`it is larger than ${MAX_FONT_BYTES / (1024 * 1024)} MB once decoded`);

    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    if (bytes.length === 0) return reject("it is empty");
    if (bytes.length > MAX_FONT_BYTES) return reject(`it is larger than ${MAX_FONT_BYTES / (1024 * 1024)} MB once decoded`);
    if (!fontLooksLike(type, bytes)) return reject(`its contents are not really ${type}`);

    const token = `${ASSET_SCHEME}font-${fonts.length + 1}`;
    /* font/sfnt says nothing about the flavour, so the real one is read from the bytes. */
    const contentType = type === "font/sfnt" ? (bytes[0] === 0x4f ? "font/otf" : "font/ttf") : type;
    fonts.push({ token, contentType, bytes });
    seen.set(whole, token);
    return token;
  });
  return { html: out, fonts };
}

/*
  After the cleaner, a photo or font that nothing in the page points at any
  more (it was only mentioned inside a script, say) is dropped, and the rest
  are numbered 1, 2, 3 again so the files and tokens stay in step.
*/
function keepUsed<T extends { token: string }>(html: string, items: T[], kind: "photo" | "font"): { html: string; items: T[] } {
  const present = new Set(html.match(/tawd-asset:(?:photo|font)-\d+/g));
  const kept = items.filter((item) => present.has(item.token));
  if (kept.length === items.length) return { html, items };
  const rename = new Map(kept.map((item, i) => [item.token, `${ASSET_SCHEME}${kind}-${i + 1}`]));
  // One pass: every token is looked up once, so "photo-3 becomes photo-2" is never read again as the old photo-2.
  const out = html.replace(/tawd-asset:(?:photo|font)-\d+/g, (token) => rename.get(token) ?? token);
  return { html: out, items: kept.map((item, i) => ({ ...item, token: `${ASSET_SCHEME}${kind}-${i + 1}` })) };
}

/*
  The one entry point: lift the photos and fonts out, clean the page for
  Build A with the parser-based cleaner, and say what was taken out.

  Photos and fonts go FIRST because the cleaner (rightly) refuses a data:
  address that is not a picture, and a font is exactly that; as tokens they
  pass. They are lifted only from what is still in the page afterwards.

  Deliberately NOT extracted: a small non-base64 data address such as the
  page's favicon (data:image/svg+xml,%3Csvg...). It is a few hundred bytes of
  URL-encoded text, not a photo, nothing sends it anywhere that costs, and
  leaving it keeps the tab icon working. Only base64 pictures and fonts are
  big enough to be worth lifting out.
*/
export function readHtmlMockup(input: string): HtmlMockupRead {
  const warnings: string[] = [];

  const extracted = extractImages(input, warnings);
  const withFonts = extractFonts(extracted.html, warnings);
  const before = census(withFonts.html);
  const cleaned = stripActiveContent(withFonts.html);
  const removed = describeRemoval(before, census(cleaned));

  const photos = keepUsed(cleaned, extracted.images, "photo");
  const fonts = keepUsed(photos.html, withFonts.fonts, "font");
  const html = fonts.html;

  if (!/<body\b/i.test(html)) warnings.push("The file has no <body>, so there are no sections to build from.");
  return { html, images: photos.items, fonts: fonts.items, removed, warnings };
}
