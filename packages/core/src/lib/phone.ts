/*
  US phone numbers, one way (Jason, 6 October 2026): every client site shows
  them as (916) 555-0142, however the team typed them. Code only, no AI.

  - formatUsPhone: one number as typed ("916.555.0142", "+1 916 555 0142",
    "1-916-555-0142", "9165550142") → "(916) 555-0142". An extension is kept
    after it ("(916) 555-0142 ext. 12"). Anything that isn't a US number
    (a UK number, half a number, words) comes back exactly as it was.
  - phoneHref: the tap-to-call link ("tel:+19165550142").
  - schemaPhone: the business details for search engines ("+1-916-555-0142").
  - samePhone: two numbers that differ only in how they're written.
  - formatPhonesInText / formatPhonesInHtml: every US number in a page's
    words, rewritten to the format. Only numbers written with separators
    ("916-555-0142", "916.555.0142", "(916)555-0142", "+1 916 555 0142"):
    a bare run of ten digits in a sentence may be an order or licence
    number, so it is left alone. Never inside a tag's attributes, a
    script, a style or a comment (tel: links, JSON-LD and WordPress block
    comments keep their own formats).
*/

const WHOLE =
  /^(?:\+?1[\s.-]*)?\(?\s*([2-9]\d{2})\s*\)?[\s.-]*([2-9]\d{2})[\s.-]*(\d{4})(?:\s*,?\s*(?:x|ext\.?|extension)\s*\.?\s*(\d{1,6}))?$/i;

export interface UsPhone {
  area: string;
  exchange: string;
  line: string;
  extension: string | null;
}

/** A whole value as a US number, or null when it isn't one. */
export function parseUsPhone(value: string): UsPhone | null {
  const m = WHOLE.exec(value.trim());
  return m ? { area: m[1]!, exchange: m[2]!, line: m[3]!, extension: m[4] ?? null } : null;
}

/** "916.555.0142" → "(916) 555-0142"; anything else exactly as it was. */
export function formatUsPhone(value: string): string {
  const phone = parseUsPhone(value);
  if (!phone) return value;
  return `(${phone.area}) ${phone.exchange}-${phone.line}${phone.extension ? ` ext. ${phone.extension}` : ""}`;
}

/** The ten digits of a US number ("9165550142"), or null. */
export function usPhoneDigits(value: string): string | null {
  const phone = parseUsPhone(value);
  return phone ? `${phone.area}${phone.exchange}${phone.line}` : null;
}

/*
  The tap-to-call link: "tel:+19165550142" (",12" dials an extension after
  a pause). Not a US number but ten digits or more: its digits as written
  ("tel:+442071234567"). Too short to call: null.
*/
export function phoneHref(value: string): string | null {
  const phone = parseUsPhone(value);
  if (phone) return `tel:+1${phone.area}${phone.exchange}${phone.line}${phone.extension ? `,${phone.extension}` : ""}`;
  const digits = value.replace(/[^\d+]/g, "");
  return value.trim() && digits.replace(/\D/g, "").length >= 10 ? `tel:${digits}` : null;
}

/** For schema.org's telephone: "+1-916-555-0142"; anything else as written. */
export function schemaPhone(value: string): string {
  const phone = parseUsPhone(value);
  if (!phone) return value.trim();
  return `+1-${phone.area}-${phone.exchange}-${phone.line}${phone.extension ? ` ext. ${phone.extension}` : ""}`;
}

/* The digits that identify a number: a US number's ten, else every digit without a leading 1. */
const phoneKey = (value: string): string => usPhoneDigits(value) ?? value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** Two numbers that differ only in how they're written ("916-555-0142" and "+1 (916) 555 0142"). */
export function samePhone(a: string, b: string): boolean {
  const x = phoneKey(a);
  return x.length > 0 && x === phoneKey(b);
}

/* ---------- numbers inside words ---------- */

// A separator: a space, dot or dash (non-breaking ones too, as characters or as entities).
const SEP = String.raw`(?:[ .\- ‐‑–]|&nbsp;|&#160;|&#xa0;|&#8209;|&#x2011;)`;
const IN_TEXT = new RegExp(
  String.raw`(?<![\w$#@/+.\-])(?:\+?1${SEP}?)?(?:\(([2-9]\d{2})\)(${SEP})?|([2-9]\d{2})(${SEP}))([2-9]\d{2})(${SEP})(\d{4})(?![\w+]|[.,/\-]\d)`,
  "gi",
);
// A number just after these words is a licence, permit or account number, not a phone.
const NOT_A_PHONE_BEFORE = /(?:\b(?:licen[cs]e[ds]?|lic\.?|cslb|reg(?:istration)?\.?|permit|account|acct\.?|invoice|order|policy|claim|id)(?:\s+(?:no\.?|number|#))?|#|\bno\.)[\s:#.-]*$/i;

const NB_SPACES = new Set([" ", "&nbsp;", "&#160;", "&#xa0;"]);
const NB_HYPHENS = new Set(["‑", "&#8209;", "&#x2011;"]);
const isEntity = (sep: string) => sep.startsWith("&");

/* After ")": a space, or a non-breaking one when the number was written not to wrap. */
function spaceFor(sep: string | undefined): string {
  if (!sep || (!NB_SPACES.has(sep.toLowerCase()) && !NB_HYPHENS.has(sep.toLowerCase()))) return " ";
  return isEntity(sep) ? "&nbsp;" : " ";
}

/* Before the last four digits: a dash, or a non-breaking one when the number was written not to wrap. */
function dashFor(sep: string): string {
  if (NB_HYPHENS.has(sep.toLowerCase())) return sep;
  if (NB_SPACES.has(sep.toLowerCase())) return isEntity(sep) ? "&#8209;" : "‑";
  return "-";
}

/** Every US number in a stretch of words, rewritten as "(916) 555-0142". */
export function formatPhonesInText(text: string): string {
  IN_TEXT.lastIndex = 0;
  if (!IN_TEXT.test(text)) return text;
  IN_TEXT.lastIndex = 0;
  return text.replace(IN_TEXT, (found: string, parenArea: string | undefined, parenSep: string | undefined, area: string | undefined, areaSep: string | undefined, exchange: string, lineSep: string, line: string, offset: number) => {
    if (NOT_A_PHONE_BEFORE.test(text.slice(Math.max(0, offset - 40), offset))) return found;
    return `(${parenArea ?? area}) ${exchange}`.replace(" ", spaceFor(parenSep ?? areaSep)) + `${dashFor(lineSep)}${line}`;
  });
}

/*
  The page's text between its tags. Comments (WordPress block comments
  carry JSON), scripts (JSON-LD), styles and text areas are kept whole;
  attributes are inside the tags, so tel: links and alt text keep theirs.
*/
const TOKENS =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(script|style|textarea|xmp)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?(?:<\/\1\s*>|$)|<[!?]?\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*>/gi;

/** Every US number in a page's visible words, rewritten as "(916) 555-0142"; everything else byte for byte. */
export function formatPhonesInHtml(html: string): string {
  IN_TEXT.lastIndex = 0;
  if (!IN_TEXT.test(html)) return html;
  let out = "";
  let last = 0;
  TOKENS.lastIndex = 0;
  for (let m = TOKENS.exec(html); m; m = TOKENS.exec(html)) {
    if (m.index > last) out += formatPhonesInText(html.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
    if (m[0].length === 0) TOKENS.lastIndex += 1;
  }
  if (last < html.length) out += formatPhonesInText(html.slice(last));
  return out;
}

/* ---------- checking a number someone typed ---------- */

/*
  Is this something a person could dial? A US number: ten digits, or eleven
  starting with 1, once the formatting is removed (spaces, dots, dashes,
  brackets, a leading +), with an optional extension. Blank is fine here
  (a missing number is the completeness check's job). Code only, no AI.
*/
export function phoneProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const main = text.replace(/\s*,?\s*(?:x|ext\.?|extension|#)\s*\.?\s*\d{1,6}$/i, "");
  const digits = main.replace(/[\s().+-]/g, "");
  // NANP: the area code and the exchange never start with 0 or 1.
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const ok = /^\d+$/.test(digits) && (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) && /^[2-9]\d{2}[2-9]\d{6}$/.test(national);
  return ok
    ? null
    : `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}" is not a US phone number. Enter 10 digits, for example (916) 555-0142.${/[a-z]/i.test(main) ? " Letters can't be dialled, so write the number in digits." : ""}`;
}

/** The number only when it can be dialled; otherwise blank, so a bad one is never used as a fact. */
export function validPhoneOrBlank(value: string): string {
  return phoneProblem(value) === null ? value : "";
}
