import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

import { isHeic } from "../images/heic";
import { imageTypeOfBytes } from "./files";

/*
  What an uploaded file really is, from its first bytes (audit F-041, batch
  C6, 12 November 2026). The browser's content type is a declaration, not a
  fact: a ".png" can be an HTML page. Confirming an upload reads only the
  first HEAD_BYTES of the object (a ranged read) and checks them here; only
  an SVG (a logo, 5 MB at most) or a HEIC to convert is read whole.
*/

/** How much of a file is read to tell what it is. */
export const HEAD_BYTES = 4096;

export type Sniffed =
  | { family: "image"; type: string }
  | { family: "other" };

/** The image type the bytes show (HEIC and GIF included), or null. */
export function sniffImage(head: Buffer): string | null {
  if (isHeic(head)) return "image/heic";
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString("ascii", 0, 6))) return "image/gif";
  return imageTypeOfBytes(head);
}

/* Leading whitespace or a UTF-8 byte-order mark may come before %PDF. */
function skipLeading(head: Buffer): Buffer {
  let i = 0;
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && head[i]! <= 0x20) i += 1;
  return head.subarray(i);
}

export function looksLikePdf(head: Buffer): boolean {
  return skipLeading(head).toString("ascii", 0, 5) === "%PDF-";
}

export function looksLikeZip(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

function looksLikeOle(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
}

/** Text: no NUL bytes (UTF-16 with a byte-order mark is allowed, as Excel writes it). */
export function looksLikeText(head: Buffer): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true;
  return !head.includes(0);
}

/*
  Is this an HTML document? After a byte-order mark, white space and any
  comments, the first thing must be a "<!doctype html" or an "<html" tag, and
  there must be no NUL byte (a binary file that merely contains the word).
  Deliberately strict: a mockup saved from Claude or a browser opens this way,
  while a fragment such as "<script>..." or a text file that mentions html
  later on does not count. Used for the homepage_html kind ONLY: the switch
  below is the one place that lets "text/html" through, and no other kind's
  rules list that type, so HTML is still refused as a logo, a photo or a
  design file (those are judged as images, or by their own type).
*/
export function looksLikeHtml(head: Buffer): boolean {
  if (head.includes(0)) return false;
  let text = skipLeading(head).toString("utf8");
  // Comments may come first (a generator's note); take them off one by one.
  for (;;) {
    const m = /^<!--[\s\S]*?-->\s*/.exec(text);
    if (!m) break;
    text = text.slice(m[0].length);
  }
  return /^<!doctype\s+html[\s>]/i.test(text) || /^<html[\s>]/i.test(text);
}

/**
 * Whether the first bytes fit a declared non-image type. Images are judged
 * by sniffImage instead (an image's declared type may differ from its bytes
 * within the types a kind allows).
 */
export function matchesDeclaredDocument(declared: string, head: Buffer): boolean {
  switch (declared) {
    case "application/pdf":
      return looksLikePdf(head);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return looksLikeZip(head);
    case "text/html":
      return looksLikeHtml(head);
    case "text/plain":
    case "text/markdown":
    case "text/csv":
      return looksLikeText(head);
    case "application/vnd.ms-excel":
      return looksLikeOle(head) || looksLikeText(head);
    default:
      // A type with no check here is one the upload rules do not allow.
      return false;
  }
}

/**
 * An SVG runs in the browser when opened on its own, so one with a script,
 * an event handler or a javascript: link is refused, and so is one that
 * could fetch something from another address when it is shown (a style
 * sheet, a font, a picture, a frame: the viewer's browser would call that
 * server). Anything a logo has no use for and the checks can't read with
 * certainty is refused too: entity definitions, processing instructions
 * other than the XML declaration, web-page elements, animated links.
 * Returns a plain-English reason, or null when it is safe to keep.
 */
export function svgProblem(text: string): string | null {
  /*
    Fable's re-review of #81: the file is read as UTF-8, so one declaring
    another encoding (ISO-2022-JP, say, where an escape sequence vanishes
    when decoded) could spell "<script>" to a browser and something else to
    these checks. Kept: UTF-8, ASCII, and the single-byte Latin and Windows
    encodings older Illustrator writes (ISO-8859-x, windows-125x): each
    spells every ASCII character (so "<", "s", "c"...) with the same byte as
    UTF-8, so the markup reads the same either way. Anything else is
    refused, and so is any control character other than tab and line breaks.
  */
  const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']*)["']/i.exec(text);
  if (declared && !/^(?:utf-?8|us-ascii|ascii|iso[-_]?8859-\d{1,2}|latin-?1|windows-125\d|cp125\d)$/i.test(declared[1]!.trim())) {
    return `it is saved in the ${declared[1]} encoding, not UTF-8`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return "it contains hidden control characters";
  if (/<script\b/i.test(text)) return "it contains a script";
  if (/<[^>]*[\s/"']on[a-z]+\s*=/i.test(text)) return "it contains an event handler";
  if (/javascript\s*:/i.test(text)) return "it contains a javascript: link";
  if (/<foreignObject\b/i.test(text)) return "it embeds web content (foreignObject)";
  // Fable's review of #81: an internal entity can hold a script the browser expands when the file is opened.
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) return "it defines its own entities (a DOCTYPE with definitions)";
  // <?xml-stylesheet href="https://..."?> loads a sheet; only the plain XML declaration is kept.
  if (/<\?(?!xml[\s?])/i.test(text)) return "it contains a processing instruction (such as a linked style sheet)";
  const css = cssProblem(text);
  if (css) return css;
  return parsedSvgProblem(text);
}

/*
  Does this address leave the file? Spaces and control characters are taken
  out first (a browser ignores them), then: two slashes in any mix of "/"
  and "\" (a browser reads "/\host" and "\\host" as another server), or any
  scheme other than data: (http:, https:, ftp:, file: and the rest). data:
  is judged where it appears; "#id" and plain paths stay inside the file.
*/
function leavesFile(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  return /^[\\/]{2}/.test(v) || (/^[a-z][a-z0-9+.-]*:/.test(v) && !v.startsWith("data:"));
}

/*
  CodeRabbit #81 (second review) and Fable's review: a <style> block, a style
  attribute or a paint attribute (fill="url(...)") can pull in another
  server's file with @import, url(...) or an image-set() string. CSS escapes
  ("@\69mport", "\75rl(") and comments are undone first so they can't hide
  any of these. Any @import is refused (a logo has no use for one); url() is
  refused when it leaves the file, closed or not (CSS closes an unclosed
  url( at the end of the sheet), so url(#gradient) still passes. The whole
  text is checked, and every attribute and <style> block again as parsed
  (entities such as &#64; decoded by the parser).
*/
function unescapeCss(css: string): string {
  return css
    // One pass, left to right, as CSS reads it: "\\e" is an escaped backslash then "e", not a backslash then the escape "\e".
    .replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_, hex: string | undefined, char: string | undefined) => {
      if (hex === undefined) return char ?? "";
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}
/*
  Judged twice: with comments taken out (so url(/**\/https://...) can't hide)
  and with them left in, because a "/*" inside a quoted string is not a
  comment and taking it out would hide the real CSS up to a later "*\/"
  (Fable's re-review of #81). Either reading that breaks a rule refuses it;
  when only the second does, the reason says so, since it may be a rule
  someone commented out (the checks can't tell that from a hidden one).
*/
function cssProblem(css: string): string | null {
  const unescaped = unescapeCss(css);
  const withoutComments = cssReadingProblem(unescaped.replace(/\/\*[\s\S]*?\*\//g, ""));
  if (withoutComments) return withoutComments;
  return cssReadingProblem(unescaped) ? "its style rules point at another website (perhaps inside a comment, which can't be read safely)" : null;
}
function cssReadingProblem(plain: string): string | null {
  if (/@import\b/i.test(plain)) return "it loads an external style sheet";
  for (const m of plain.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    if (leavesFile(m[2]!)) return "it loads a file from another website";
  }
  if (/image-set\s*\(/i.test(plain)) {
    for (const m of plain.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      if (leavesFile(m[1] ?? m[2] ?? "")) return "it loads a file from another website";
    }
  }
  return null;
}

// Web-page elements (in the XHTML namespace, say): a logo has no use for any of them, and several load or run things.
const PAGE_ELEMENTS = new Set(
  "iframe frame frameset embed object applet portal meta link base img picture source audio video track form input button textarea select html body".split(" "),
);
// Attributes that load an address on a page element: never needed in an SVG.
// xml:base (local name "base") would point every plain href, such as href="p.png", at another server.
const LOADING_ATTRIBUTES = new Set("src srcset lowsrc dynsrc poster background action formaction codebase archive ping base".split(" "));

/*
  Every element and attribute as an XML parser reads them (CodeRabbit #81):
  the patterns above are fooled by a ">" inside a quoted value, so the
  parsed tree is checked as well.
*/
function parsedSvgProblem(text: string): string | null {
  const doc = parseDocument(text, { xmlMode: true, lowerCaseAttributeNames: false, lowerCaseTags: false });
  /*
    Which prefixes name the XHTML namespace anywhere in the file. A web-page
    element counts when it has no prefix or one of these: <h:img> is a page
    element, Inkscape's metadata <dc:source> is not (Fable's re-review of #81).
  */
  const xhtmlPrefixes = new Set<string>();
  const collect = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      for (const [name, value] of Object.entries((node as Element).attribs)) {
        const m = /^xmlns:(.+)$/i.exec(name);
        if (m && /^\s*http:\/\/www\.w3\.org\/1999\/xhtml\s*$/i.test(value)) xhtmlPrefixes.add(m[1]!.toLowerCase());
      }
      collect((node as Element).children);
    }
  };
  collect(doc.children);
  const walk = (nodes: ChildNode[]): string | null => {
    for (const node of nodes) {
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      const tag = el.name.toLowerCase().replace(/^.*:/, "");
      const prefix = el.name.includes(":") ? el.name.toLowerCase().replace(/:.*$/, "") : "";
      if (tag === "script") return "it contains a script";
      if (tag === "foreignobject") return "it embeds web content (foreignObject)";
      if (PAGE_ELEMENTS.has(tag) && (prefix === "" || xhtmlPrefixes.has(prefix))) return `it contains a web-page element (${tag})`;
      if (tag === "style") {
        const css = cssProblem(el.children.map((c) => ("data" in c ? String(c.data) : "")).join(""));
        if (css) return css;
      }
      // <set attributeName="href" to="https://..."> swaps an address in while the picture is shown.
      if (/^(?:set|animate|animatemotion|animatetransform|animatecolor)$/.test(tag)) {
        const target = Object.entries(el.attribs).find(([k]) => k.toLowerCase() === "attributename")?.[1] ?? "";
        if (/^(?:[a-z0-9_.-]+:)?(?:href|src)$/i.test(target.trim())) return "it changes a link while it is shown (an animated href)";
      }
      for (const [name, value] of Object.entries(el.attribs)) {
        const lower = name.toLowerCase();
        const local = lower.replace(/^.*:/, "");
        if (/^(?:[a-z0-9_.-]+:)?on/.test(lower)) return "it contains an event handler";
        // eslint-disable-next-line no-control-regex
        const squashed = value.replace(/[\u0000- ]+/g, "").toLowerCase();
        if (/^(?:javascript|vbscript):/.test(squashed)) return "it contains a javascript: link";
        if (LOADING_ATTRIBUTES.has(local)) return `it has an attribute that loads an address (${local})`;
        if (local === "href" && /^data:(?!image\/(?:png|jpe?g|gif|webp|avif)[;,])/.test(squashed)) return "it links to embedded data that is not a picture";
        // A picture or symbol fetched from another server when shown (a link the viewer clicks, <a href>, is not a fetch).
        if (local === "href" && tag !== "a" && leavesFile(value)) return "it loads a file from another website";
        if (/^(?:to|from|by|values)$/.test(local) && value.split(";").some(leavesFile)) return "it loads a file from another website";
        // style, and paint attributes such as fill="url(...)", read as CSS.
        if (local === "style" || /url\(|image-set|@import/i.test(value)) {
          const css = cssProblem(value);
          if (css) return css;
        }
      }
      const inner = walk(el.children);
      if (inner) return inner;
    }
    return null;
  };
  return walk(doc.children);
}
