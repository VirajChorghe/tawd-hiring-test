/*
  No code from the AI on a client's site (13 October 2026, the whole-code
  review): the header, footer and every page's <main> are written by the AI,
  and text it read (a makeover's current site, the client's copy) could steer
  it into a script. Before the files are written, by code: every <script>
  goes (the model's structured data too: TAWD writes its own into each head
  afterwards, and a head is never given to this cleaner), every on...=
  attribute goes, srcdoc goes, and a javascript:, vbscript: or data: address
  (pictures excepted) becomes "#". Since audit F-011 (12 November 2026) it is
  an allow-list: only known tags and attributes stay; no base, meta refresh,
  object or embed; a form posts only to an address on the site; a frame,
  picture, sheet or font loads only from the site itself, Google Fonts or
  the booking pages TAWD frames; no remote url() or @import in CSS. TAWD's
  own parts (the consent banner, videos) are added after this and aren't
  touched.
*/

import { parseDocument } from "htmlparser2";
import type { CDATA, ChildNode, Comment, Element, ProcessingInstruction, Text } from "domhandler";

const SCRIPT_OPEN = /<script\b/gi;
const SCRIPT_CLOSE = /<\/script\s*>/gi;
const SCRIPT_TAG = /<\/?script\b/gi;

/*
  Whole <script>...</script> blocks, then any stray script tag, taken out by
  walking the page. These were two patterns ("<script\b[^>]*>" and the like)
  that re-scanned to the end of the page from every "<script " that had no
  ">" after it, so a file made of repeated "<script " took quadratic time
  (130 KB: 6 seconds). Looking for the ">" with indexOf, and giving up as
  soon as there is none, keeps it one pass.
*/
function dropScripts(html: string): string {
  let out = "";
  let from = 0;
  SCRIPT_OPEN.lastIndex = 0;
  for (let m = SCRIPT_OPEN.exec(html); m; ) {
    const gt = html.indexOf(">", m.index);
    if (gt < 0) break;
    SCRIPT_CLOSE.lastIndex = gt + 1;
    const close = SCRIPT_CLOSE.exec(html);
    if (!close) break;
    out += html.slice(from, m.index);
    from = close.index + close[0].length;
    SCRIPT_OPEN.lastIndex = from;
    m = SCRIPT_OPEN.exec(html);
  }
  return out + html.slice(from);
}

function dropStrayScriptTags(html: string): string {
  let out = "";
  let from = 0;
  SCRIPT_TAG.lastIndex = 0;
  for (let m = SCRIPT_TAG.exec(html); m; ) {
    const gt = html.indexOf(">", m.index);
    if (gt < 0) break;
    out += html.slice(from, m.index);
    from = gt + 1;
    SCRIPT_TAG.lastIndex = from;
    m = SCRIPT_TAG.exec(html);
  }
  return out + html.slice(from);
}
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "data", "background", "srcset"]);

/* A character code past the end of Unicode (or a lone surrogate) is no character: a browser reads it as U+FFFD, and fromCodePoint would throw on it. */
const fromCode = (code: number): string => (Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd");

const decode = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => fromCode(Number(dec)))
    .replace(/&(tab|newline|colon);/gi, (_m, name: string) => ({ tab: "\t", newline: "\n", colon: ":" })[name.toLowerCase()]!);

/* Does this address run code? Tabs, line breaks and entities inside it don't hide it. */
export function isActiveUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const plain = decode(value).replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  if (/^(javascript|vbscript):/.test(plain)) return true;
  return plain.startsWith("data:") && !/^data:image\/(png|jpe?g|gif|webp|avif)[;,]/.test(plain);
}

function cleanTag(tag: string): string {
  const name = /^<([^\s/>]+)/.exec(tag)![1]!;
  const body = tag.slice(name.length + 1, tag.endsWith("/>") ? -2 : -1);
  let changed = false;
  const kept: string[] = [];
  for (const m of body.matchAll(ATTR)) {
    const attr = m[1]!.toLowerCase();
    const raw = m[2];
    if (/^on/.test(attr) || attr === "srcdoc") {
      changed = true;
      continue;
    }
    if (raw !== undefined && URL_ATTRS.has(attr)) {
      const value = raw.replace(/^["']|["']$/g, "");
      const bad = attr === "srcset" ? value.split(",").some((part) => isActiveUrl(part.trim().split(/\s+/)[0] ?? "")) : isActiveUrl(value);
      if (bad) {
        changed = true;
        kept.push(`${m[1]}="#"`);
        continue;
      }
    }
    kept.push(m[0]);
  }
  if (!changed) return tag;
  return `<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${tag.endsWith("/>") ? " />" : ">"}`;
}

/*
  Where a tag the old block-list pattern would read ends: "<", a letter, a
  name, then anything up to a ">" that is not inside a quoted value. Returns
  the index after the ">", or -1 when it never closes. This is the same
  reading the pattern /<[a-zA-Z][^\s/>]*(?:[^"'>]|"[^"]*"|'[^']*')*>/ gave,
  written as a walk because that pattern backtracked catastrophically on
  unterminated tags (a 20 KB run of "<a" never finished: a hang an uploaded
  file could cause). `dead` remembers every position a failed walk passed
  through while outside quotes: another walk reaching one of them fails at
  once, so a whole page is read in one pass however hostile it is.
*/
function tagEnd(html: string, start: number, dead?: Uint8Array): number {
  let i = start + 2;
  const visited: number[] = [];
  const fail = () => {
    if (dead) for (const at of visited) dead[at] = 1;
    return -1;
  };
  // The name: a second map (the upper half of `dead`), because a quote inside a name is just a letter while outside it opens a value.
  const named = html.length + 1;
  while (i < html.length && !/[\s/>]/.test(html[i]!)) {
    if (dead && dead[named + i]) return fail();
    visited.push(named + i);
    i++;
  }
  while (i < html.length) {
    if (dead && dead[i]) return fail();
    const c = html[i]!;
    if (c === ">") return i + 1;
    visited.push(i);
    if (c === '"' || c === "'") {
      const close = html.indexOf(c, i + 1);
      if (close < 0) return fail();
      i = close + 1;
    } else i++;
  }
  return fail();
}

/* Every tag the walk above can read, handed to `fix`; text between tags is copied as it is. */
function replaceTags(html: string, fix: (tag: string) => string): string {
  const dead = new Uint8Array(2 * html.length + 2);
  let out = "";
  let from = 0;
  let at = html.indexOf("<");
  while (at >= 0) {
    const next = /[a-zA-Z]/.test(html[at + 1] ?? "") ? tagEnd(html, at, dead) : -1;
    if (next < 0) {
      at = html.indexOf("<", at + 1);
      continue;
    }
    out += html.slice(from, at) + fix(html.slice(at, next));
    from = next;
    at = html.indexOf("<", next);
  }
  return out + html.slice(from);
}

/* The old block-list pass, kept as the backstop after the allow-list: no script at all, no handlers, no active addresses. */
function backstop(html: string): string {
  return (
    replaceTags(dropStrayScriptTags(dropScripts(html)), cleanTag)
      // A tag the walk above can't read as a whole (an unquoted value holding a quote): any handler in it goes (CodeRabbit #81).
      .replace(/<[a-zA-Z][^>]*>?/g, (tag) => (tagEnd(tag, 0) === tag.length ? tag : tag.replace(/(^|[\s"'`/])on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "$1")))
  );
}

/* ---------- the allow-list (audit F-011, 12 November 2026) ---------- */

const HTML_TAGS = new Set(
  ("a abbr address area article aside audio b bdi bdo blockquote body br button caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form " +
    "h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meter nav ol optgroup option output p picture pre progress q rp rt ruby s samp " +
    "search section select small source span strong style sub summary sup svg table tbody td textarea tfoot th thead time title tr track u ul var video wbr meta").split(" "),
);
// Inline icons only: no animation, no foreignObject.
const SVG_TAGS = new Set(
  ("svg g path circle rect line polyline polygon ellipse defs use title desc lineargradient radialgradient stop clippath mask symbol pattern marker text tspan textpath image a style switch " +
    "filter fegaussianblur feoffset feblend fecolormatrix femerge femergenode feflood fecomposite fedropshadow").split(" "),
);
const VOID_TAGS = new Set("area base br col embed frame hr img input link meta param source track wbr".split(" "));
// Removed with everything inside them.
const REMOVE_WITH_CONTENT = new Set(
  "script base object embed applet noscript noembed noframes xmp plaintext template foreignobject animate animatemotion animatetransform set frame frameset portal param".split(" "),
);
const HTML_ATTRS = new Set(
  ("accept action align alt autocomplete autoplay border cellpadding cellspacing charset checked cite class cols colspan content controls crossorigin datetime decoding dir disabled download enctype " +
    "fetchpriority for formaction headers height hidden href hreflang id inputmode itemid itemprop itemscope itemtype kind label lang list loading loop max maxlength media method min minlength multiple " +
    "muted name novalidate open pattern placeholder playsinline poster preload property readonly referrerpolicy rel required reversed role rows rowspan scope selected sizes span src srcset srclang " +
    "netlify netlify-honeypot start step style tabindex target title translate type valign value width allowfullscreen frameborder bgcolor color").split(" "),
);

type Rule = { host: RegExp; path?: RegExp };
const FONT_RULES: Rule[] = [{ host: /^(?:fonts\.googleapis\.com|fonts\.gstatic\.com)$/ }];
// The only pages TAWD frames itself (integrations.ts: Calendly and Acuity), plus a Google map.
const FRAME_RULES: Rule[] = [{ host: /(?:^|\.)calendly\.com$/ }, { host: /(?:^|\.)acuityscheduling\.com$/ }, { host: /^www\.google\.com$/, path: /^\/maps\/embed(?:\/|$)/ }];

type Where = { kind: "local" } | { kind: "remote"; host: string; path: string } | { kind: "bad" };

/* Where does this address point? Already decoded by the parser; controls and spaces never hide a scheme. */
function whereIs(value: string): Where {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000- \u007f]+/g, "");
  if (v === "" || v.startsWith("#") || /^tawd-asset:/i.test(v) || /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i.test(v)) return { kind: "local" };
  let abs: string | null = null;
  if (/^[\\/]{2}/.test(v)) abs = `https:${v}`;
  else if (/^https?:/i.test(v)) abs = v;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return { kind: "bad" };
  if (abs === null) return { kind: "local" };
  try {
    const url = new URL(abs.replace(/\\/g, "/"));
    return url.protocol === "https:" || url.protocol === "http:" ? { kind: "remote", host: url.hostname.toLowerCase(), path: url.pathname } : { kind: "bad" };
  } catch {
    return { kind: "bad" };
  }
}

/* A picture, frame, sheet or font: TAWD's own paths, or an allowed host over https. */
function resourceOk(value: string, rules: Rule[] = []): boolean {
  const where = whereIs(value);
  if (where.kind === "local") return true;
  if (where.kind === "bad") return false;
  // eslint-disable-next-line no-control-regex
  if (!/^[\\/]{2}|^https:/i.test(value.replace(/[\u0000- \u007f]+/g, ""))) return false;
  return rules.some((r) => r.host.test(where.host) && (!r.path || r.path.test(where.path)));
}

const cssRemoteOk = (value: string) => resourceOk(value.trim(), FONT_RULES);

/*
  image-set() takes plain strings as addresses too, beside url(). It is read
  to its own closing bracket, past any nested url(...) and any quoted ")"
  (CodeRabbit #81, second review: a pattern stopping at the first ")" left
  every candidate after a url() unchecked), and every string inside is
  judged. One that never closes can't be read whole, so it is cut off there.
*/
function cleanImageSets(text: string): string {
  const opener = /(?:-webkit-)?image-set\s*\(/gi;
  let out = "";
  let from = 0;
  for (let m = opener.exec(text); m; m = opener.exec(text)) {
    let depth = 1;
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out += text.slice(from, m.index);
    if (depth > 0) return `${out}none`;
    out += text
      .slice(m.index, i)
      .replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, (str, a?: string, b?: string) => (resourceOk((a ?? b ?? "").trim()) ? str : '""'));
    from = i;
    opener.lastIndex = i;
  }
  return out + text.slice(from);
}

/* A style sheet or a style attribute: no @import, no remote url() (Google Fonts excepted), no expression(). */
export function cleanCss(css: string): string {
  const once = (text: string) =>
    cleanImageSets(
      text
        .replace(/@import\s*(?:url\(\s*)?(["']?)([^"')\s;]*)\1[^;{}]*;?/gi, (whole, _q: string, url: string) => (cssRemoteOk(url) ? whole : ""))
        // A url( never closed is still fetched (CSS closes it at the end of the sheet; Fable's review of #81), and an unclosed quote is still the address.
        .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*(?:\)|$)/gi, (whole, a?: string, b?: string, c?: string) =>
          cssRemoteOk((a ?? b ?? c ?? "").replace(/^\s*['"]/, "")) ? whole : 'url("")',
        ),
    )
      .replace(/expression\s*\(/gi, "blocked(")
      .replace(/-moz-binding\s*:[^;}]*/gi, "");
  const cleaned = once(css);
  // Escapes and comments can spell what the pattern looks for: if the plain reading still breaks a rule, the whole sheet goes.
  const plain = cleaned
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd))
    .replace(/\\(.)/g, "$1");
  return once(plain) === plain ? cleaned : "";
}

const escapeValue = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const squash = (value: string) => value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();

/* What an attribute becomes: its value (maybe changed), or null when it goes. */
function attributeValue(tag: string, name: string, value: string, svg: boolean): string | null {
  if (!/^[a-z_:][-a-z0-9_:.]*$/i.test(name)) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || lower === "srcdoc") return null;
  if (svg && /(?:javascript|vbscript):/.test(squash(value))) return null;
  const known = HTML_ATTRS.has(lower) || lower.startsWith("data-") || lower.startsWith("aria-") || lower === "xlink:href" || svg;
  if (!known) return null;
  switch (lower) {
    case "style":
      return cleanCss(value);
    case "href":
    case "xlink:href":
      if (tag === "a" || tag === "area") return isActiveUrl(value) ? "#" : value;
      // A link element was judged whole (linkOk): its rel and its address together.
      if (tag === "link") return value;
      return resourceOk(value) ? value : null;
    case "src":
    case "poster":
      return resourceOk(value, tag === "iframe" ? FRAME_RULES : []) ? value : null;
    case "srcset":
      return value.split(",").every((part) => resourceOk(part.trim().split(/\s+/)[0] ?? "")) ? value : null;
    case "action":
    case "formaction":
      // A form posts only to TAWD's own address on the site (the thank-you page, where Netlify takes it).
      return whereIs(value).kind === "local" && !/^data:/i.test(value.trim()) ? value : null;
    default:
      // Paint and filter attributes (fill, filter, mask, clip-path, marker-*) take url() like CSS does: same rules (CodeRabbit #81).
      return svg ? cleanCss(value) : value;
  }
}

type Edit = { start: number; end: number; text: string };

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/*
  Where a start tag ends, read the way the parser reads it (CodeRabbit #81):
  an unquoted value runs to the next space or ">" and a quote inside it is
  just a character, so a pattern that treats every quote as opening a quoted
  value can disagree about where the tag stops. Returns the index after ">"
  or -1 when the tag never closes.
*/
/* Where a start tag ends, quotes respected. Exported for supplied-nav.ts, which replaces one href inside a tag it has already parsed. */
export function scanOpenTag(html: string, start: number): number {
  let i = start + 1;
  while (i < html.length && !isSpace(html[i]) && html[i] !== "/" && html[i] !== ">") i++;
  while (i < html.length) {
    const c = html[i]!;
    if (c === ">") return i + 1;
    if (isSpace(c) || c === "/") {
      i++;
      continue;
    }
    // An attribute name runs to a space, "=", "/" or ">".
    while (i < html.length && !isSpace(html[i]) && html[i] !== "=" && html[i] !== "/" && html[i] !== ">") i++;
    let j = i;
    while (isSpace(html[j])) j++;
    if (html[j] !== "=") continue;
    j++;
    while (isSpace(html[j])) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return -1;
      i = close + 1;
    } else {
      while (j < html.length && !isSpace(html[j]) && html[j] !== ">") j++;
      i = j;
    }
  }
  return -1;
}

/*
  Every end tag written plainly ("</p >", "</p\n>", "</div class=x>" become
  "</p>", "</div>") before the parser sees the page (Fable's re-review of
  #81). A browser ignores whatever follows an end tag's name, so nothing a
  browser shows changes; but the parser counts positions wrongly after such
  a tag (the next element's start lands inside it), which sent the cleaner's
  cuts to the wrong place and cut the rest of the page off.

  Only real end tags are touched, found the way a browser's tokenizer walks
  the page (Fable's third read: a pattern over the text also rewrote "</b"
  inside comments, attribute values and <textarea> text, and one it couldn't
  read stopped the tidying for the whole page): comments and <!...>/<?...>
  are stepped over, a start tag is stepped over whole (its quoted values may
  hold "</" or ">"), raw-text elements (script, style, textarea, title and
  the like) are stepped over to their own end tag, and an end tag is read
  with quoted values that may hold ">". Wherever this walk and the parser
  could still disagree, the allow-list fails closed (the edits below).
*/
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);
function tidyEndTags(html: string): string {
  let out = "";
  let from = 0;
  let i = 0;
  const isLetter = (c: string | undefined) => c !== undefined && /[a-zA-Z]/.test(c);
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1];
    if (html.startsWith("<!--", lt)) {
      // "<!-->" and "<!--->" end at once; otherwise at "-->" or "--!>".
      if (html.startsWith("<!-->", lt) || html.startsWith("<!--->", lt)) {
        i = html.indexOf(">", lt) + 1;
        continue;
      }
      const ends = [html.indexOf("-->", lt + 4), html.indexOf("--!>", lt + 4)].filter((n) => n >= 0);
      if (ends.length === 0) break;
      const at = Math.min(...ends);
      i = at + (html.startsWith("-->", at) ? 3 : 4);
      continue;
    }
    if (next === "!" || next === "?" || (next === "/" && !isLetter(html[lt + 2]))) {
      // A declaration, processing instruction, "</>" or "</ x": ends at the next ">".
      const close = html.indexOf(">", lt + 1);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    if (next === "/") {
      const end = scanOpenTag(html, lt);
      // An end tag that never closes runs to the end of the page in a browser too; it is left as written.
      if (end < 0) break;
      const name = /^<\/([^\s/>]+)/.exec(html.slice(lt, end))![1]!;
      const plain = `</${name}>`;
      if (html.slice(lt, end) !== plain) {
        out += `${html.slice(from, lt)}${plain}`;
        from = end;
      }
      i = end;
      continue;
    }
    if (isLetter(next)) {
      const end = scanOpenTag(html, lt);
      if (end < 0) break;
      const name = /^<([^\s/>]+)/.exec(html.slice(lt, end))![1]!.toLowerCase();
      i = end;
      if (name === "plaintext") break;
      if (RAW_TEXT.has(name)) {
        const close = html.slice(end).search(new RegExp(`</${name}[\\s/>]`, "i"));
        if (close < 0) break;
        i = end + close;
      }
      continue;
    }
    i = lt + 1;
  }
  return out + html.slice(from);
}

function allowList(input: string): string {
  const html = tidyEndTags(input);
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, lowerCaseAttributeNames: false });
  const edits: Edit[] = [];

  /* The start tag as the parser read it. `agrees` is false when re-reading its text gives other attributes than the parser found: then it is rebuilt, never spliced. */
  const openTag = (el: Element): { end: number; text: string; agrees: boolean } | null => {
    const start = el.startIndex ?? 0;
    const end = scanOpenTag(html, start);
    if (end < 0) return null;
    const text = html.slice(start, end);
    const again = parseDocument(text, { lowerCaseAttributeNames: false }).children[0];
    const found = again && (again.type === "tag" || again.type === "script" || again.type === "style") ? (again as Element).attribs : null;
    const mine = el.attribs;
    const agrees = found !== null && Object.keys(mine).length === Object.keys(found).length && Object.entries(mine).every(([k, v]) => found[k] === v);
    return { end, text, agrees };
  };
  // Where the element's closing tag is, when it has one of its own.
  const closing = (el: Element, openEnd: number): { start: number; end: number } | null => {
    const end = (el.endIndex ?? -1) + 1;
    if (end <= openEnd) return null;
    const m = new RegExp(`</${el.name}\\s*>$`, "i").exec(html.slice(openEnd, end));
    return m ? { start: end - m[0].length, end } : null;
  };

  /* A start tag that never closes can't be read safely: it and everything after it go (fail closed). */
  const dropTail = (el: Element): true => {
    edits.push({ start: el.startIndex!, end: html.length, text: "" });
    return true;
  };

  const attrsOk = (el: Element, svg: boolean): boolean => {
    const open = openTag(el);
    if (!open) return dropTail(el);
    /*
      An element the parser made from a stray end tag ("</p>" with no <p>
      open becomes an empty <p>, "</br>" a <br>, as in a browser): the text
      at its start is that end tag, and a browser ignores an end tag's
      attributes, so there is nothing to clean and it stays as written
      (Fable's re-review of #81: treating it as unreadable cut the page off).
    */
    if (open.text.startsWith("</")) return true;
    const seen = new Set<string>();
    const kept: string[] = [];
    let changed = false;
    for (const [name, value] of Object.entries(el.attribs)) {
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        changed = true;
        continue;
      }
      seen.add(lower);
      const next = attributeValue(el.name, name, value, svg);
      if (next === null) {
        changed = true;
        continue;
      }
      if (next !== value) changed = true;
      kept.push(`${name}="${escapeValue(next)}"`);
    }
    if (changed || !open.agrees) {
      const named = /^<([^\s/>]+)/.exec(open.text);
      // No tag name where one must be: it can't be read safely, so it goes with what follows.
      if (!named) return dropTail(el);
      const nameText = named[1]!;
      edits.push({ start: el.startIndex!, end: open.end, text: `<${nameText}${kept.length ? ` ${kept.join(" ")}` : ""}${open.text.endsWith("/>") ? " />" : ">"}` });
    }
    return true;
  };

  /* Takes the element out with what is inside it (only when it closes itself, else just its opening tag). */
  const remove = (el: Element, descend: (el: Element) => void) => {
    const open = openTag(el);
    if (!open) return void dropTail(el);
    const close = VOID_TAGS.has(el.name) || open.text.endsWith("/>") ? null : closing(el, open.end);
    if (VOID_TAGS.has(el.name) || open.text.endsWith("/>")) {
      edits.push({ start: el.startIndex!, end: open.end, text: "" });
    } else if (close) {
      edits.push({ start: el.startIndex!, end: close.end, text: "" });
    } else {
      edits.push({ start: el.startIndex!, end: open.end, text: "" });
      descend(el);
    }
  };

  /* An unknown tag: its words stay, the tag goes. */
  const unwrap = (el: Element) => {
    const open = openTag(el);
    if (!open) return void dropTail(el);
    edits.push({ start: el.startIndex!, end: open.end, text: "" });
    const close = VOID_TAGS.has(el.name) || open.text.endsWith("/>") ? null : closing(el, open.end);
    if (close) edits.push({ start: close.start, end: close.end, text: "" });
  };

  const linkOk = (el: Element): boolean => {
    const href = el.attribs.href ?? "";
    const rels = (el.attribs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (rels.length === 0) return false;
    const loads = ["stylesheet", "preload", "prefetch", "preconnect", "dns-prefetch", "modulepreload", "icon", "apple-touch-icon", "shortcut", "manifest", "mask-icon"];
    if (rels.some((r) => loads.includes(r))) return resourceOk(href, FONT_RULES);
    return rels.every((r) => ["canonical", "alternate", "next", "prev", "author", "license", "help"].includes(r)) && !isActiveUrl(href);
  };

  const visit = (nodes: ChildNode[], inSvg: boolean) => {
    for (const node of nodes) {
      /*
        Fable's review of #81: a CDATA section is read to "]]>" by the parser
        but ended at the first ">" by a browser's HTML parser, which then reads
        the rest as markup the cleaner never saw. A page has no use for one, so
        it goes whole, whatever it holds (a <style>'s text is not visited here).
      */
      const start = node.startIndex;
      if (node.type === "cdata" || (start != null && html.startsWith("<![", start))) {
        edits.push({ start: start ?? 0, end: node.endIndex != null ? node.endIndex + 1 : html.length, text: "" });
        continue;
      }
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      const name = el.name.toLowerCase();
      const children = (e: Element) => visit(e.children, inSvg || name === "svg");
      if (node.type === "script" || REMOVE_WITH_CONTENT.has(name)) {
        remove(el, children);
        continue;
      }
      const svg = inSvg || name === "svg";
      if (name === "iframe" && !resourceOk(el.attribs.src ?? "x:", FRAME_RULES)) {
        remove(el, children);
        continue;
      }
      if (name === "link" && !linkOk(el)) {
        remove(el, children);
        continue;
      }
      if (name === "meta" && Object.keys(el.attribs).some((k) => k.toLowerCase() === "http-equiv")) {
        remove(el, children);
        continue;
      }
      if (!(HTML_TAGS.has(name) || (svg && SVG_TAGS.has(name)))) {
        unwrap(el);
        visit(el.children, svg);
        continue;
      }
      // An SVG sheet the parser split into elements (a meta or embed inside it) is not a sheet: it goes whole (CodeRabbit #81).
      if (name === "style" && el.children.some((c) => c.type === "tag" || c.type === "script" || c.type === "style")) {
        remove(el, children);
        continue;
      }
      attrsOk(el, svg);
      if (name === "style") {
        const open = openTag(el);
        const close = open ? closing(el, open.end) : null;
        if (open && close) {
          const css = html.slice(open.end, close.start);
          const cleaned = cleanCss(css);
          if (cleaned !== css) edits.push({ start: open.end, end: close.start, text: cleaned });
        } else if (open) {
          // A sheet that never closes would run to the end of the page: it goes with everything it would swallow.
          edits.push({ start: el.startIndex!, end: html.length, text: "" });
        }
        continue;
      }
      visit(el.children, svg);
    }
  };
  visit(doc.children, false);

  /*
    Overlapping edits: the outer one wins (Fable's third read of #81). An
    edit that overlaps another is a removal or a "drop the rest" (an element
    can't be read safely); an attribute fix inside it must never cancel it.
    Before, the later edit was applied first and the outer one skipped, so a
    page that should have been cut off kept the element exactly as written.
    So: take edits by start, widest first, keep each one that starts after
    the last kept one ends, then apply the kept ones from the end backwards.
  */
  // "Drop the rest" first: the page is cut at the earliest such point, and an edit that straddles the cut moves it back to its own start.
  let cut = html.length;
  for (const edit of edits) if (edit.end >= html.length && edit.text === "") cut = Math.min(cut, edit.start);
  for (let moved = true; moved; ) {
    moved = false;
    for (const edit of edits) {
      if (edit.start < cut && edit.end > cut) {
        cut = edit.start;
        moved = true;
      }
    }
  }
  const inside = edits.filter((edit) => edit.end <= cut);
  const kept: Edit[] = [];
  let reach = -1;
  for (const edit of inside.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (edit.start < reach) continue;
    kept.push(edit);
    reach = Math.max(reach, edit.end);
  }
  let out = html.slice(0, cut);
  for (const edit of kept.reverse()) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  return out;
}

export function stripActiveContent(html: string): string {
  return backstop(allowList(html));
}

/*
  An element as what it is, not how it is spelt (audit F-005, 12 November
  2026): tag names, every attribute and its value, and the text, after the
  parser has decoded entities. The browser writes a bare `hidden` back as
  `hidden=""` and may change quotes and entity spelling; none of that
  changes this. A change to any attribute, word or child still does, so an
  element merely named like TAWD's banner is still cleaned. Comments,
  directives and CDATA count too: a copy with a comment slipped inside is a
  different element, so it is cleaned rather than taken for TAWD's own.
*/
function canonical(nodes: ChildNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return (node as Text).data;
      if (node.type === "comment") return `<!--${(node as Comment).data}-->`;
      if (node.type === "directive") return `<${(node as ProcessingInstruction).data}>`;
      if (node.type === "cdata") return `<![CDATA[${canonical((node as CDATA).children)}]]>`;
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return "";
      const el = node as Element;
      const attrs = Object.entries(el.attribs).map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join("");
      return `<${el.name}${attrs}>${canonical(el.children)}</${el.name}>`;
    })
    .join("");
}

/*
  A whole page already written (the speed pass copies an earlier version,
  which may predate the cleanup): everything in its body is cleaned except
  what TAWD itself puts there, passed in as fragments (the consent banner,
  the video script) and matched by canonical() above, so the browser's
  re-spelling doesn't lose them: an element merely named like one of them is
  cleaned like the rest (CodeRabbit, PR #5). The head is TAWD's (SEO, structured data, the tracking
  script) and stays. A design's sections sitting straight in <body> (an
  exact copy) are cleaned too (CodeRabbit, PR #5).
*/
export function stripActiveContentInPage(html: string, own: string[] = []): string {
  // TAWD's own parts, by what they are rather than how they are spelt (audit F-005).
  const ownForms = new Set(own.map((fragment) => canonical(parseDocument(fragment).children)));
  // The real elements, found by a parser: tag-like text inside an attribute never ends a part (CodeRabbit, PR #5).
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const parts: { start: number; end: number }[] = [];
  const visit = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const el = node as Element;
      if (el.name === "html" || el.name === "body") {
        visit(el.children);
        continue;
      }
      if (el.name === "head" || el.startIndex == null || el.endIndex == null) continue;
      if (ownForms.has(canonical([el]))) continue;
      parts.push({ start: el.startIndex, end: el.endIndex + 1 });
    }
  };
  visit(doc.children);
  let out = html;
  for (const { start, end } of parts.reverse()) out = `${out.slice(0, start)}${stripActiveContent(out.slice(start, end))}${out.slice(end)}`;
  return out;
}

/*
  Whether a page's consent banner can still be answered (audit F-005): it
  is there, and both of its buttons call tawdConsent. A banner whose
  buttons were cleaned shows on every page and can never be closed, so the
  go-live check and "Speed up this build" both refuse it.
*/
export function consentBannerWorks(html: string): boolean {
  const doc = parseDocument(html);
  const find = (nodes: ChildNode[]): Element | null => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.attribs.id === "tawd-consent") return el;
      const inside = find(el.children);
      if (inside) return inside;
    }
    return null;
  };
  const banner = find(doc.children);
  if (!banner) return false;
  const buttons: Element[] = [];
  const collect = (nodes: ChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== "tag") continue;
      const el = node as Element;
      if (el.name === "button") buttons.push(el);
      collect(el.children);
    }
  };
  collect(banner.children);
  const calls = buttons.map((b) => b.attribs.onclick ?? "");
  return calls.length === 2 && calls.some((c) => c.includes("tawdConsent('granted')")) && calls.some((c) => c.includes("tawdConsent('denied')"));
}
