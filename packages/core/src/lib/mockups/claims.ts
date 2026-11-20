import type { CheckIssue } from "./checks";
import { FACT_CHECKS_BLOCK } from "./confirmed-facts";
import { splitSections } from "./sections";

/*
  The claims guard (gap 12, Jason 6 November 2026).

  House rule: nothing is invented. The mechanical invented-facts check
  (checks.ts) proves only that numbers match the intake — phones, licence
  numbers, founding year, review counts. It cannot see a prose claim like
  "lifetime warranty" or "free consultation", so until now those passed every
  check and the go-live gate; only the Creative Director's eye caught them.

  This is the code guard for that category. It is deliberately conservative,
  matching claim phrases a machine can settle, in three groups:

  - Superlatives / puffery ("the best", "#1", "award-winning"): banned outright
    by the house rules; never backed by anything. Flagged for the fix round to
    rephrase, and blocked at go-live if any remain.
  - Confirmable offers (a warranty or guarantee, a free consultation/estimate,
    financing): real only if the intake says so. Flagged when the matching
    intake field is empty, to become a visible placeholder to confirm.
  - Over-claims: a guarantee the intake backs, but stated stronger than the
    intake supports ("lifetime"/"money-back" when the intake says "1-year").
    Flagged for human review — shipping a wrong warranty is as harmful as an
    invented one.

  It cannot catch every over-statement, only the obvious ones, which is the
  same honest limit as the invented-facts check.
*/

export interface ClaimFacts {
  /** intake.data.process.guarantees (free text; empty means the client named none). */
  guarantees: string;
  /** intake.data.extras.currentOffers (free text; empty means none). */
  currentOffers: string;
  /** intake.data.extras.financingAvailable. */
  financingAvailable: boolean;
  /*
    The client's own free text from the intake, joined (statedTextFrom): the
    only thing that can back a claim the intake has no field for, such as
    "family owned". Absent means nothing the client wrote is known here, so
    such a claim is treated as unsupported - which is the safe way round.
  */
  statedText?: string;
  /*
    B2 (audit F-010): what the credential, hours and count claims are backed
    by. All optional; absent means the intake gave nothing, so a claim of that
    kind is unsupported - the safe way round.
  */
  /** The intake has at least one licence number: "licensed" is backed. */
  licensed?: boolean;
  /** intake.business.certifications, joined: backs "bonded", "insured", "EPA certified", "A+ BBB". */
  certifications?: string;
  /** intake.business.emergency247: backs "24/7". */
  emergency247?: boolean;
  /*
    B3: values read from the client's current website that nobody has
    confirmed yet, so they were taken out of the facts above. Only used to
    word a finding: "the current website says X, but nobody has confirmed
    it" instead of "the intake names none". Keys: "process.guarantees",
    "extras.currentOffers", "extras.financingAvailable".
  */
  unconfirmed?: { key: string; value: string }[];
}

/*
  The severity of a kind of check that is new in B2: it follows
  FACT_CHECKS_BLOCK ("fail" while on, as it is now; "warn" when off). Read inside functions only, never at load time,
  because confirmed-facts.ts imports this file too.
*/
function newKindSeverity(): "fail" | "warn" {
  return FACT_CHECKS_BLOCK ? "fail" : "warn";
}

/* The client's own words from several intake fields as one text, for a claim no single field answers. */
export function statedTextFrom(parts: (string | null | undefined)[]): string {
  return parts
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" . ");
}

const PLACEHOLDER_PATTERN = /\[PLACEHOLDER:[^\]]*\]/gi;

/* The HTML character references worth decoding before matching: the common named ones plus any numeric/hex ref. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…",
};
function decodeRef(match: string, body: string): string {
  try {
    if (body[0] === "#") {
      const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  } catch {
    return match;
  }
}

/*
  The meta description's own words (Jason's run, 10 November 2026).

  Concept B's description said "Family owned since 1970"; Concept A's
  offered a "free design consultation". The intake says neither, and the
  guard never saw a word of it: a description lives in an ATTRIBUTE, and
  the text below is built by stripping whole tags, attributes and all. The
  one sentence Google shows under the result was the one sentence no check
  read, and only the Creative Director caught it, by eye, at review price.

  The <title> was always read, because its words are text rather than an
  attribute - now proved by a test, since that was an assumption.
*/
function metaDescriptionText(html: string): string {
  const tag = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i.exec(html)?.[0];
  if (!tag) return "";
  const content = /(?<![\w-])content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return content ? (content[1] ?? content[2] ?? "") : "";
}

/*
  The repair for a claim that is in the meta description (12 November 2026,
  CodeRabbit on PR #75). The guard reads the description, but the AI fix
  round is handed only the page's bands, never the head - so a claim that
  lived only in the description was flagged, sent to the header and hero,
  and still there after every paid round.

  Code takes it out instead, for free: every sentence of the description
  that holds an unsupported claim's or a superlative's words is dropped,
  and the rest is kept as it was written. An over-claim is left alone,
  because a person decides that one. The match is on the claim's words, so
  a sentence like "the best time to call" goes too when "the best" was
  flagged elsewhere in the description - a description sentence lost,
  never a claim left in. When nothing is left the tag goes, and the
  missing-description fix writes one from the page (code-fixes.ts).
*/
const DESCRIPTION_TAG = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i;

export function descriptionWithoutClaims(html: string, issues: CheckIssue[]): { html: string; removed: number } {
  const claims = issues
    // A report-only ("warn") finding changes nothing: only a claim that fails is taken out.
    .filter((issue) => issue.severity !== "warn" && (issue.id === "house.claim.unsupported" || issue.id === "house.claim.superlative"))
    .map((issue) => samePunctuation(issue.evidence ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean)
    // Whole words, so "best" does not take out a sentence that holds "bestselling".
    .map((claim) => new RegExp(`(?<![\\w-])${claim.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}(?![\\w-])`, "i"));
  const tag = DESCRIPTION_TAG.exec(html)?.[0];
  if (claims.length === 0 || !tag) return { html, removed: 0 };
  // As written in the attribute (character references and all), so what is kept is kept exactly.
  const sentences = metaDescriptionText(html).match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [];
  const read = (sentence: string) =>
    samePunctuation(sentence.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, decodeRef)).replace(/\s+/g, " ").toLowerCase();
  const kept = sentences.filter((sentence) => !claims.some((claim) => claim.test(read(sentence))));
  if (kept.length === sentences.length) return { html, removed: 0 };
  const content = kept.join("").trim().replace(/"/g, "&quot;");
  const next = content ? tag.replace(/(?<![\w-])content\s*=\s*(?:"[^"]*"|'[^']*')/i, () => `content="${content}"`) : "";
  return { html: html.replace(tag, () => next), removed: sentences.length - kept.length };
}

/*
  A call to action is never a claim (B2): a button or link whose whole text
  is a short invitation ("Get a free estimate", "Special offers") asks the
  visitor to do something; it does not state what the business offers. It is
  found by the element - <a>, <button> - and its length, not by its words
  alone, so the same words in a sentence are still read. An
  <input type="submit"> keeps its words in an attribute, which is never read.
*/
const CTA_ELEMENT = /<(a|button)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
/* A button drawn as a span or div ("site-header-cta kit-button-1": New Dawn's header, the count of 12 Nov): its class says it is one. */
const CTA_STYLED = /<(span|div)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\b(?:cta|btn|button)[\w-]*)[^>]*>([^<]*(?:<(?!\/?\1\b)[^<]*)*)<\/\1\s*>/gi;
const CTA_MAX_WORDS = 6;
function withoutCtas(html: string): string {
  const shortOnly = (whole: string, _tag: string, inner: string) => {
    const words = inner.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= CTA_MAX_WORDS ? " . " : whole;
  };
  return html.replace(CTA_ELEMENT, shortOnly).replace(CTA_STYLED, shortOnly);
}

function toText(html: string, options: { dropCtas?: boolean } = {}): string {
  const description = metaDescriptionText(html);
  const body = options.dropCtas ? withoutCtas(html) : html;
  // Its own clause, so a negation in the page's copy cannot reach into the description or out of it.
  const stripped = `${description ? `${description} . ` : ""}${body}`
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(PLACEHOLDER_PATTERN, " ")
    // Block-level elements end a clause, so a negation in one block ("<p>No financing</p>") doesn't
    // carry into the next ("<p>Free estimate</p>"); inline tags are dropped without a break.
    .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|section|article|header|footer|nav|main|aside|table|thead|tbody|tr|td|th|blockquote|figure|figcaption|address|form|fieldset|dl|dd|dt|pre)\b[^>]*>|<br\s*\/?>/gi, " . ")
    .replace(/<[^>]+>/g, " ")
    // Decode HTML character references once the markup is gone and before dashes/apostrophes are
    // normalized, so an encoded hyphen ("worry&#8209;free"), dash or apostrophe reads like its character.
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, decodeRef);
  return samePunctuation(stripped).replace(/\s+/g, " ").trim();
}

/*
  The punctuation every text is read with: the page's, and the client's own
  words that back an ownership claim (12 November 2026, CodeRabbit on PR
  #75: a client who typed "family‑owned" with a non-breaking hyphen did not
  back their own page's "family-owned").
*/
function samePunctuation(text: string): string {
  return (
    text
      // Curly apostrophes to straight, so negation words ("can't", "don't") match however they were typed.
      .replace(/[‘’]/g, "'")
      // Unicode hyphens (hyphen, non-breaking hyphen, figure/en dash, minus) to a plain "-", so a
      // "worry‑free" compound typed with one is still excluded like "worry-free", and "money‑back" still reads.
      .replace(/[‐‑‒–−]/g, "-")
  );
}

/*
  The words a visitor does not read as page text but a search engine or a
  screen reader does (B2): image alt text, and the wording in the page's
  JSON-LD (description, slogan, text). The meta description and title were
  already read. Claims found only here follow FACT_CHECKS_BLOCK: they block while it is on (it is on now) and are only reported when it is off.
  An "award" in JSON-LD is returned apart: it is a claim by its key alone.
*/
function hiddenWords(html: string): { text: string; awards: string[] } {
  const parts: string[] = [];
  const awards: string[] = [];
  const clean = (value: string) => samePunctuation(value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, decodeRef)).replace(/\s+/g, " ").trim();
  for (const m of html.replace(PLACEHOLDER_PATTERN, " ").matchAll(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    const alt = clean(m[1] ?? m[2] ?? "");
    if (alt) parts.push(alt);
  }
  const WORDING_KEYS = new Set(["description", "slogan", "text", "disambiguatingdescription"]);
  const AWARD_KEYS = new Set(["award", "awards"]);
  const walk = (node: unknown, key = ""): void => {
    if (typeof node === "string") {
      const value = clean(node);
      if (!value) return;
      if (AWARD_KEYS.has(key)) awards.push(value);
      else if (WORDING_KEYS.has(key)) parts.push(value);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, k.toLowerCase());
    }
  };
  for (const block of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(block[1]!));
    } catch {
      // Not valid JSON: nothing to read, and the SEO checks report broken structured data.
    }
  }
  return { text: parts.join(" . "), awards };
}

/* Puffery the house rules rule out outright: nothing but the client's own words backs it. */
/* What is never a ranking: "our number one priority", "the best fit for your home". */
const PRIORITY_WORD = "(?:priority|priorities|concern|goal|focus|rule|commitment|mission|aim|objective|value|reason)";
/* Unit and street context: "Suite #1", "123 Main St #1 Sacramento". */
const UNIT_BEFORE = "(?<!\\b(?:suite|ste|unit|apt|apartment|bldg|building|room|lot|st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|step|no|item|part|phase|tip|rule|option|day|chapter)\\.?,?\\s*)";
/*
  The kind of business a ranking or "leading" claim is about. Never the
  products it installs: "leading HVAC brands like Carrier" and "top-rated
  Rheem water heaters" are about the maker, so a product word after it ends
  the match (review of B2).
*/
const TRADE_NOUN =
  "(?:providers?|compan(?:y|ies)|contractors?|plumbers?|plumbing|electricians?|electrical|roofers?|roofing|hvac|firms?|experts?|specialists?|installers?|technicians?|teams?|business(?:es)?|services?|choices?|authority|sources?|shops?|pros?|professionals?|exterminators?|pest\\s+control|lawyers?|attorneys?|firm|glass|repair)" +
  "(?![\\w-]*\\s+(?:brands?|manufacturers?|makers?|names?|products?|equipment|units?|systems?|parts|models?|lines?)\\b)";
const SUPERLATIVES: { re: RegExp; label: string }[] = [
  // "the best plumber / choice / value / in Sacramento", but not "the best time/way/day to call",
  // "the best fit for your home", "the best job we can", "the best of both worlds".
  { re: /\bthe\s+best\b(?!\s+(?:time|times|way|ways|day|days|moment|moments|chance|chances|part|parts|thing|things|option|options|place|places|season|seasons|months?|week|weeks|fit|of\b|job\s+(?:we|that\s+we|possible|you|they|i)\b))/i, label: "the best" },
  // "Springfield's best plumber", "the area's best": a possessive in front of "best".
  // Not "It's best to ...", "what's best for your home", "that's best left to ..." (a contraction, not a possessive).
  { re: /(?<![\w'])(?!(?:it|that|what|here|there|who|he|she|where|how|this|let)'s\b)[a-z]+'s\s+best\b(?!\s+(?:time|times|way|ways|day|days|fit|of\b|interest|friend|work\b))/i, label: "'s best" },
  { re: /\bbest[- ]in[- ](?:class|town|the\s+\w+)\b/i, label: "best-in-class" },
  // "#1" in a ranking claim ("rated #1"), or followed by any noun ("#1 pest control") - never "Suite #1" or "our #1 priority".
  { re: new RegExp(`\\b(?:rated|voted|ranked|we(?:'| a)?re|you(?:'| a)?re|your)\\s+#\\s?1\\b(?!\\s*${PRIORITY_WORD})`, "i"), label: "#1" },
  { re: new RegExp(`${UNIT_BEFORE}#\\s?1\\s+(?!${PRIORITY_WORD}\\b)(?:[a-z]+)`, "i"), label: "#1" },
  // "No. 1" and "Number 1", spelled either way.
  { re: new RegExp(`${UNIT_BEFORE}\\b(?:no\\.\\s?|number\\s+)(?:1|one)\\b(?!\\s*${PRIORITY_WORD})`, "i"), label: "No. 1" },
  // "5-star rated" / "five-star" is no longer here: it is a rating, and factIssues (B1, confirmed-facts.ts)
  // reads it once as facts.rating. Reading it here too raised two findings for one phrase.
  // "most trusted plumber": about the business, so a trade noun must follow ("the most reliable option" is not a claim).
  { re: new RegExp(`\\bmost\\s+(?:trusted|reliable|respected|recommended|experienced|awarded)\\s+(?:[\\w-]+\\s+){0,2}?${TRADE_NOUN}\\b`, "i"), label: "most trusted" },
  { re: new RegExp(`\\b(?:leading|premier)\\s+(?!to\\b|up\\b|into\\b|edge\\b|cause\\b)(?:[\\w-]+\\s+){0,2}?${TRADE_NOUN}\\b`, "i"), label: "leading" },
  { re: /\bhighest[- ]rated\b/i, label: "highest rated" },
  // "top-rated" about the business ("top-rated plumber", "we are top-rated"), not a product's rating ("top-rated Rheem water heaters").
  { re: new RegExp(`\\btop[- ]rated\\s+(?:[\\w-]+\\s+){0,2}?${TRADE_NOUN}\\b`, "i"), label: "top-rated" },
  { re: /\bwe(?:'re| are)\s+(?:the\s+)?(?:\w+'s\s+)?top[- ]rated\b/i, label: "top-rated" },
  { re: /\bvoted\s+(?:the\s+)?best\b/i, label: "voted best" },
  { re: /\baward[- ]winning\b/i, label: "award-winning" },
  { re: /\bunbeatable\b/i, label: "unbeatable" },
  { re: /\bunmatched\b/i, label: "unmatched" },
  { re: /\bsecond\s+to\s+none\b/i, label: "second to none" },
  { re: /\btrusted\s+by\s+thousands\b/i, label: "trusted by thousands" },
  { re: /\b(?:results\s+guaranteed|guaranteed\s+results)\b/i, label: "guaranteed results" },
];

/* A warranty or guarantee offered on the page (not the superlative "guaranteed results"). */
const GUARANTEE_RE = /\b(?:warrant(?:y|ies)|guarantees?|guaranteed|money[- ]back)\b/i;
/*
  A concrete free sales offer, or a discount offer. The free offer may be worded
  with the "free" word before the offer noun ("free consultation", "free design
  consultation", "complimentary estimate", "no-cost inspection" — up to two
  adjectives allowed in between), or after it ("the consultation costs nothing").
  An offer noun is always required, so a benign "free" that names no offer does
  not match: "free to choose", "feel free to call", "free of charge" on its own.
  Bare "discount"/"coupon" are left out (they turn up in "no hidden discounts").
*/
// The gap between the "free" word and the offer noun: at most one adjective, and
// never the word "to". So a verb reading never matches — "free to choose", "feel
// free to consult/quote", "Free yourself from a quote" — and a two-word gap
// ("Free yourself from quote") can't reach the noun either. The leading
// look-behind keeps a "…-free" adjective out ("worry-free/hassle-free estimate").
// "assessment"/"evaluation"/bare "consult" are left out: too easily a verb or a
// praising opinion ("a complimentary assessment of our crew"). A real "free
// assessment" offer is the accepted miss — far better than blocking a go-live.
const OFFER_GAP = "(?:\\s+(?!to\\b)[\\w][\\w-]*){0,1}?";
/*
  Who owns the business (Jason's run, 10 November 2026).

  Both concepts said New Dawn Awning was "family owned", in the copy and in
  the meta description. The intake does not say it, and there is no intake
  field that could: so nothing in TAWD could either back it or refuse it,
  and it shipped. It is exactly the claim a local-services page invents,
  and a client who is not family owned would have had a lie published on
  their own website.

  Each claim is judged only against ITSELF in the client's own words: a
  client who says "family owned" has not thereby said "veteran owned".
  Bare "family" is not here on purpose - a page may talk all it likes about
  the families it serves - and nor is "locally owned" being inferred from a
  local address; the client either said it or they did not.
*/
/*
  One claim, all the ways it can be worded. The page matching any wording
  is the claim; the client's own words matching ANY wording of the SAME
  claim back it.

  Grouping matters, and the test for this change found why: a client who
  wrote "a family owned shop, second generation" and a page that says
  "Second generation owners" are stating one fact in two word orders. Kept
  as separate claims, the client's own sentence did not back their own
  page. What must stay separate is one claim backing ANOTHER: saying
  "family owned" is not saying "veteran owned".
*/
const OWNERSHIP_CLAIMS: { name: string; wordings: RegExp[] }[] = [
  {
    name: "family owned",
    wordings: [
      /\bfamily[-\s]?(?:owned|run|operated)\b/i,
      /\bfamily\s+business\b/i,
      /\bfather[-\s]and[-\s]son\b/i,
      /\bmother[-\s]and[-\s]daughter\b/i,
    ],
  },
  { name: "veteran owned", wordings: [/\bveteran[-\s]?owned\b/i] },
  { name: "woman owned", wordings: [/\b(?:wom[ae]n|female)[-\s]?owned\b/i] },
  { name: "minority owned", wordings: [/\bminority[-\s]?owned\b/i] },
  /*
    A generation claim has to be about PEOPLE. "Second-generation" is
    also how a trade describes a product - a second-generation heat pump
    - and this check fails a page and blocks a go-live, so it carries
    the no-false-positive priority the rest of the guard has.

    One claim per generation (12 November 2026, CodeRabbit on PR #75): the
    number is the fact, so a client who said "second generation" has not
    said "fourth". Either word order, and "2nd" for "second", stay one
    claim. In the owner-first order the generation must END the clause
    ("a family business, now in its third generation"): "our business
    installs second-generation heat pumps" puts a business noun near a
    product's generation, and that is not a claim about the owners.
  */
  ...([["second", "2nd"], ["third", "3rd"], ["fourth", "4th"]] as const).map(([word, short]) => {
    const generation = `(?:${word}|${short})[-\\s]?generation`;
    return {
      name: `a ${word} generation business`,
      wordings: [
        new RegExp(`\\b${generation}\\b,?(?:\\s+[\\w'-]+){0,2}?\\s+(?:owners?|owned|family|business|contractors?|craftsmen|plumbers?|builders?|team)\\b`, "i"),
        new RegExp(`\\b(?:owners?|family|business|shop)\\b[^.!?]{0,30}\\b${generation}\\b(?=\\s*(?:[.,;:!?)]|$))`, "i"),
      ],
    };
  }),
];
/*
  "Locally owned and operated" is deliberately NOT here. It is on almost
  every local trade's website, it is true of nearly every business TAWD
  builds for - a shop in the area it serves - and this check blocks a
  go-live. Flagging a near-tautology would have made the guard noise, and
  noise is how a guard stops being read. The Creative Director still sees
  the words and can ask about them.
*/

/* Words that turn a claim into its opposite ("we cannot guarantee ...", "no free estimate"): never a claim. */
const NEGATION_BEFORE = /\b(?:no|not|never|cannot|can't|cant|don't|dont|doesn't|doesnt|does\s+not|do\s+not|without|isn't|aren't|won't|wont|offer\s+no|make[s]?\s+no)\b[\s\w]{0,14}$/i;
/* A genuine negation, as opposed to the promotional "don't miss / don't wait", which negates nothing. */
const GENUINE_NEGATION = /\b(?:no|not|never|cannot|can't|cant|without|won't|wont|isn't|aren't|offer\s+no|make[s]?\s+no)\b/i;
const PROMO_DONT = /\b(?:do(?:es)?n'?t|do(?:es)?\s+not)\s+(?:miss|wait|hesitate|delay|forget|let|lose|pass)\b/i;
/*
  Phrases that contain a negation word and negate nothing (B2): "no
  obligation free estimate" offers the estimate; "you can't beat our
  warranty" praises it; "not only a 10-year warranty" adds to it. Taken out
  of the words before a claim, so they cannot read as a negation of it.
*/
const NON_NEGATING =
  /\b(?:no[- ](?:obligation|commitment|pressure|strings(?:\s+attached)?|risk|hassle|contracts?|catch|fuss|surprises?|hidden\s+\w+|matter)|(?:can't|cannot|cant|won't|wont)\s+(?:beat|match|top|find\s+(?:a\s+)?better)|not\s+(?:only|just|merely|simply)|without\s+(?:a\s+)?doubt)\b/gi;
function negatedBefore(text: string, index: number): boolean {
  // Only the clause right before the claim governs it: a negation in an earlier sentence
  // ("No pressure. Don't miss our free estimate!") doesn't make the claim a negation.
  const window = text.slice(Math.max(0, index - 40), index);
  const cut = window.search(/[.;:!?][^.;:!?]*$/);
  const before = (cut >= 0 ? window.slice(cut + 1) : window).replace(NON_NEGATING, " ");
  if (!NEGATION_BEFORE.test(before)) return false;
  // "Don't miss our free estimate!" is promotion, not a negation of the offer.
  if (PROMO_DONT.test(before) && !GENUINE_NEGATION.test(before)) return false;
  return true;
}

/* Strong guarantee qualifiers: the page claiming one the intake doesn't is an over-claim. */
const STRONG_QUALIFIERS = ["lifetime", "forever", "permanent", "for life", "money-back", "unconditional", "100%"];

/*
  A duration the way people write it (B2): "1-year", "one-year" and "12
  months" are the same promise, so each is read as a number of years.
*/
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, fifty: 50,
};
const NUM = "(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[- ]five)?|thirty|fifty)";
const DURATION = `${NUM}\\s*[- ]?\\s*(?:years?|yrs?|months?|mos?)`;

function qualifierYears(q: string): number {
  if (/lifetime|forever|permanent|for\s+life/i.test(q)) return Infinity;
  const m = new RegExp(`(${NUM})\\s*[- ]?\\s*(year|yr|month|mo)`, "i").exec(q);
  if (!m) return 0;
  const raw = m[1]!.toLowerCase().replace(/\s+/g, "-");
  const n = /^\d/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? 0);
  return /^mo/i.test(m[2]!) ? n / 12 : n;
}

/*
  The strength of a guarantee as stated, measured from the qualifier bound to
  the guarantee word itself (within a word or two), never from unrelated numbers
  nearby. "Over 25 years of experience. 1-year warranty" reads as 1 year, not
  25; "family-owned 10 years; 1-year warranty" reads as 1 year too.
*/
// The qualifier must sit in the same clause as the guarantee word (no . ; : ! ? between), so a
// duration in an earlier sentence ("25 years of experience. 1-year warranty") is never read as its strength.
// The intake's own text may punctuate it ("Warranty: 12 months on labor"), so its colon does not end the clause (B2).
const guaranteeBound = (stop: string): RegExp[] => [
  new RegExp(`\\b(lifetime|forever|permanent|for\\s+life|money[- ]back|unconditional|100%|${DURATION})\\b[^${stop}]{0,30}?\\b(?:warrant(?:y|ies)|guarantee)`, "gi"),
  new RegExp(`\\b(?:warrant(?:y|ies)|guarantee[ds]?)\\b[^${stop}]{0,24}?\\b(lifetime|forever|for\\s+life|money[- ]back|unconditional|100%|${DURATION})\\b`, "gi"),
];
const GUARANTEE_BOUND_PAGE = guaranteeBound(".;:!?");
const GUARANTEE_BOUND_INTAKE = guaranteeBound(".;!?");
function boundGuaranteeStrength(text: string, intakeText = false): { years: number; strong: string[] } {
  let years = 0;
  const strong = new Set<string>();
  for (const re of intakeText ? GUARANTEE_BOUND_INTAKE : GUARANTEE_BOUND_PAGE) {
    for (const m of text.matchAll(re)) {
      // A negated warranty ("we do not offer a lifetime warranty") doesn't set the page's strength.
      if (negatedBefore(text, m.index!)) continue;
      const q = m[1]!.toLowerCase();
      years = Math.max(years, qualifierYears(q));
      for (const sq of STRONG_QUALIFIERS) if (q.replace(/\s+/g, " ").includes(sq)) strong.add(sq);
    }
  }
  return { years, strong: [...strong] };
}

/* A short window of the page text around a match, to show a claim in context in the message. */
function windowAround(text: string, index: number, span = 70): string {
  return text.slice(Math.max(0, index - span), Math.min(text.length, index + span));
}

/*
  #1a (the New Dawn bug list, 8 November 2026): a whole SECTION built around an
  optional fact the intake doesn't provide. The word-level guards below catch
  the claim phrases they know; a band can still be built on the fact in words
  they don't ("Lifetime Materials", "Complimentary Design Session"). A band's
  own heading declares its topic, so this reads HEADINGS only (h1-h3), and
  deliberately narrowly — no-false-positive priority, because the issue blocks
  go-live:
  - a guarantee topic is the explicit words (warranty/guarantee/money-back), or
    "lifetime" only when bound to a build-quality word in the same heading
    ("Lifetime Materials" flags; a poetic "A Lifetime of Shade" hero is left to
    the Creative Director);
  - an offer topic needs the free-word AND an offer noun in the heading;
  - financing is its own words.
  A named multi-step process stays out of scope: every concept has a process
  band by design, and code cannot settle whether its steps are invented (the
  same honest limit as the invented-facts check).
*/
const SECTION_HEADING_RE = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i;
const LIFETIME_BOUND_RE = /(?<![\w-])lifetime\b[^.!?]{0,20}\b(?:materials?|workmanship|craftsmanship|parts|labou?r|coverage|protection|warrant(?:y|ies)|guarantee[ds]?)\b/i;
const GUARANTEE_TOPIC_RE = /(?<![\w-])(?:warrant(?:y|ies)|guarantee[ds]?|money[- ]back)\b/i;
const OFFER_TOPIC_RE = /(?<![\w-])(?:free|complimentary|no[-\s]cost)\b[^.!?]{0,30}\b(?:consultations?|estimates?|quotes?|inspections?|sessions?|visits?|assessments?|evaluations?)\b/i;
const FINANCING_TOPIC_RE = /\b(?:financing|payment\s+plans?|0%\s*(?:apr|interest))\b/i;

/*
  A band of articles nobody wrote (Jason's run, 10 November 2026).

  Both concepts built one. Concept A's "Our Blogs" showed post titles and
  dates the intake never supplied, with "Read more" links that go nowhere,
  and the Creative Director scored Placeholders only where required 2 of 5
  for it: "a section for unasked content ... Remove the blog band
  entirely". Concept B had the same band, fabricated dates and every link a
  "#".

  Neither the claim-phrase guard nor the section-heading guard could see
  it, because the invention is not a phrase or a heading: it is a list of
  ITEMS that do not exist. What a machine can settle is the links - an
  article nobody can open is an article nobody wrote - so the links are
  what this tests, and not the words.

  Deliberately narrow, because it fails a page and blocks a go-live:

  - at least two items that look like articles rather than cards: each
    carries a date a reader would see, or a "read more" kind of link;
  - and EVERY one of their links goes nowhere. One real link and the band
    is somebody's real writing with a gap in it - the reviewer's call, not
    a house-rule fault.

  A makeover that keeps the client's real posts links to real paths, so it
  is never touched. That is the point of testing the links.
*/
const ARTICLE_ITEM = /<(article|li|div)\b[^>]*>[\s\S]{0,1200}?<\/\1>/gi;
/* The real read-more phrasings, as the whole link text (or "Read more ..." at its start). A bare "more" is not one: "Learn more about our 20 years" is not a post link. */
const READ_MORE =
  /^\W*(?:read\s+more\b.*|read\s+(?:the|full)\s+(?:article|post|story)|continue\s+reading|full\s+(?:post|article)|view\s+(?:the\s+)?(?:article|post))\W*$/i;
/* A date a reader would see on a post: "March 4, 2024", "4 March 2024", "2024-03-04", "04/03/2024". */
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const POST_DATE = new RegExp(
  `\\b(?:${MONTH})\\b[^<]{0,12}\\b\\d{4}\\b|\\b\\d{1,2}\\s+(?:${MONTH})\\b[^<]{0,8}\\b\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}\\b`,
  "i",
);
/* A link that opens nothing: empty, a bare "#", or a script. An anchor to an id the page has ("#contact") is a real link; one to an id it lacks is checked in linkGoesNowhere. */
const GOES_NOWHERE = /^(?:|#|javascript:.*|void\(0\))$/i;

function linkGoesNowhere(href: string, pageHtml: string): boolean {
  if (GOES_NOWHERE.test(href)) return true;
  if (!href.startsWith("#")) return false;
  const id = href.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !new RegExp(`\\s(?:id|name)\\s*=\\s*(?:"${id}"|'${id}')`, "i").test(pageHtml);
}

/* Every candidate item, overlapping ones included, so a wrapper div cannot swallow the articles inside it. */
function articleCandidates(sectionHtml: string): { start: number; end: number; html: string }[] {
  const out: { start: number; end: number; html: string }[] = [];
  const starts = /<(?:article|li|div)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = starts.exec(sectionHtml))) {
    ARTICLE_ITEM.lastIndex = m.index;
    const item = ARTICLE_ITEM.exec(sectionHtml);
    if (item && item.index === m.index) out.push({ start: m.index, end: m.index + item[0].length, html: item[0] });
  }
  ARTICLE_ITEM.lastIndex = 0;
  return out;
}

function articleBandIssues(html: string): CheckIssue[] {
  const out: CheckIssue[] = [];
  for (const section of splitSections(html)) {
    const qualifying = articleCandidates(section.html).filter((item) => {
      const links = [...item.html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
      if (links.length === 0) return false;
      return POST_DATE.test(toText(item.html)) || links.some((link) => READ_MORE.test(toText(link[1] ?? "")));
    });
    // Keep the innermost: a wrapper that holds a qualifying article is the band, not an article.
    const articles = qualifying
      .filter((a) => !qualifying.some((b) => b !== a && b.start >= a.start && b.end <= a.end))
      .map((a) => a.html);
    if (articles.length < 2) continue;
    // Every link of every article, not just the first.
    const hrefs = articles.flatMap((item) =>
      [...item.matchAll(/<a\b[^>]*>/gi)].map((tag) => {
        const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
        return (href ? (href[1] ?? href[2] ?? "") : "").trim();
      }),
    );
    if (!hrefs.every((href) => linkGoesNowhere(href, html))) continue;
    const heading = SECTION_HEADING_RE.exec(section.html);
    const title = heading ? toText(heading[2]!) : "";
    out.push({
      id: "house.section.unsupported",
      severity: "fail",
      evidence: title || `${articles.length} article cards`,
      sections: [section.index],
      message: `The ${title ? `"${title}"` : "articles"} section lists ${articles.length} articles whose links go nowhere, so they are posts that do not exist. House rule 2: no invented facts. Link each one to a page the site really has, or take the section out.`,
    });
  }
  return out;
}

function sectionTopicIssues(html: string, facts: ClaimFacts): CheckIssue[] {
  const out: CheckIssue[] = [];
  for (const section of splitSections(html)) {
    const headingTag = SECTION_HEADING_RE.exec(section.html);
    // toText also strips [PLACEHOLDER: ...], so a heading already shown as one to confirm is not flagged again.
    const heading = headingTag ? toText(headingTag[2]!) : "";
    if (!heading) continue;
    const flag = (topic: string, fix: string) =>
      out.push({
        id: "house.section.unsupported",
        severity: "fail",
        evidence: heading,
        sections: [section.index],
        message: `The "${heading}" section is built around ${topic} the intake doesn't provide. House rule 2: ${fix}`,
      });
    if (!facts.guarantees.trim() && (GUARANTEE_TOPIC_RE.test(heading) || LIFETIME_BOUND_RE.test(heading))) {
      flag("a guarantee or warranty", "show it as a visible [PLACEHOLDER: warranty — confirm with the client], or remove the section.");
    } else if (!facts.currentOffers.trim() && OFFER_TOPIC_RE.test(heading)) {
      flag("an offer", "show it as a visible [PLACEHOLDER: offer — confirm with the client], or remove the section.");
    } else if (!facts.financingAvailable && FINANCING_TOPIC_RE.test(heading)) {
      flag("financing", "remove the section, or the client confirms financing in the intake.");
    }
  }
  return out;
}

/*
  Every claim issue on a page: superlatives, offers the intake doesn't back,
  guarantees stated stronger than the intake supports, and whole sections
  built on an unsupported optional fact (#1a). Placeholders are removed
  first, so a claim already shown as "[PLACEHOLDER: ...]" is not flagged
  again; a negated claim ("we cannot guarantee ...") is not a claim.
*/
interface Severities {
  /** For the kinds the guard had before B2: "fail" on the page's own words. */
  old: "fail" | "warn";
  /** For every kind that is new in B2 (follows FACT_CHECKS_BLOCK: "fail" while it is on, as now). */
  fresh: "fail" | "warn";
}

/* ---------- B2 (audit F-010): what the page says, against what the client said ---------- */

/* Warranty words that are not the business's own promise: the maker's, a home-warranty company's, a repair done under one. */
const NOT_OWN_WARRANTY: RegExp[] = [
  /\b(?:manufacturers?|factory|vendor|supplier|brand|builder)(?:'s|s)?\s+(?:[\w-]+\s+){0,2}?(?:warrant(?:y|ies)|guarantees?)\b/gi,
  /\bhome\s+warrant(?:y|ies)\b/gi,
  /\bwarrant(?:y|ies)\s+(?:repairs?|work|claims?|service|compan(?:y|ies)|providers?|administrators?)\b/gi,
];
function withoutNonOwnWarranty(text: string): string {
  return NOT_OWN_WARRANTY.reduce((acc, re) => acc.replace(re, " "), text);
}

/* What a guarantee covers, said in a word: the page may not cover more than the intake's own words do. */
const SCOPE_WORDS = /\b(full|comprehensive|complete|total|everything|no\s+questions\s+asked|parts|labou?r|workmanship|materials?)\b/gi;
function canonicalScope(word: string): string {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (/^(?:full|comprehensive|complete|total)$/.test(w)) return "full";
  if (/^(?:labou?r|workmanship)$/.test(w)) return "labor";
  if (/^materials?$/.test(w)) return "materials";
  return w;
}
function scopeOf(clause: string): Set<string> {
  return new Set([...clause.matchAll(SCOPE_WORDS)].map((m) => canonicalScope(m[1]!)));
}
/* "1-year warranty on all work" covers everything the page may say it covers: all / every / any work, job or installation. */
const WHOLE_SCOPE = /\b(?:all|every|any|each)\s+(?:of\s+(?:our|the)\s+)?(?:work|jobs?|installations?|installs?|repairs?|projects?)\b/i;
function intakeScopeOf(text: string): Set<string> {
  const scope = scopeOf(text);
  if (WHOLE_SCOPE.test(text)) for (const word of ["full", "everything", "parts", "labor", "materials"]) scope.add(word);
  return scope;
}

/* A guarantee promised without using the word: "if you are not happy we come back", "we stand behind our work for life". */
const GUARANTEE_PARAPHRASES: { re: RegExp; kind: "satisfaction" | "life" }[] = [
  { re: /\bif\s+you(?:'re|\s+are)\s+not\s+(?:completely\s+|fully\s+|100%\s+|totally\s+)?(?:happy|satisfied|delighted|thrilled)\b[^.!?]{0,80}/i, kind: "satisfaction" },
  { re: /\b(?:come\s+back|return|re-?do|redo|fix\s+it|make\s+it\s+right|put\s+it\s+right)\b[^.!?]{0,40}\bat\s+no\s+(?:extra\s+)?(?:charge|cost)\b/i, kind: "satisfaction" },
  { re: /\bwe(?:'ll|\s+will)\s+make\s+it\s+right\b/i, kind: "satisfaction" },
  { re: /\b100%\s+satisfaction\b/i, kind: "satisfaction" },
  { re: /\bstands?\s+behind\s+(?:our|every|all|each)\b[^.!?]{0,40}\bfor\s+life\b/i, kind: "life" },
  { re: /\b(?:work|workmanship|repairs?|installations?|installs?)\b[^.!?]{0,30}\bfor\s+life\b/i, kind: "life" },
];
const SATISFACTION_BACKING = /satisf|happy|make it right|put it right|come back|re-?do|refund|money[- ]back|at no (?:extra )?(?:charge|cost)/i;
const LIFE_BACKING = /lifetime|for life|forever|permanent|as long as you own/i;

/* A free or special offer worded with "free". Nouns the guard had first, then the ones B2 added. */
const FREE_WORD = "(?:free|complimentary|no[-\\s]cost)";
const FREE_NOUNS_OLD = "consultations?|estimates?|quotes?|inspections?";
const FREE_NOUNS_NEW = "second\\s+opinions?|diagnostics?|diagnosis";
const FREE_OFFER_RE = new RegExp(
  `(?<![\\w-])${FREE_WORD}\\b${OFFER_GAP}\\s+(${FREE_NOUNS_OLD}|${FREE_NOUNS_NEW})\\b` +
    `|\\b(${FREE_NOUNS_OLD}|${FREE_NOUNS_NEW})\\b${OFFER_GAP}\\s+costs?\\s+nothing\\b`,
  "gi",
);
function nounGroup(noun: string): string {
  const n = noun.toLowerCase();
  if (/estimate|quote/.test(n)) return "(?:estimates?|quotes?|bids?)";
  if (/consult/.test(n)) return "(?:consultations?|design\\s+sessions?)";
  if (/inspect/.test(n)) return "inspections?";
  if (/opinion/.test(n)) return "opinions?";
  return "(?:diagnostics?|diagnosis)";
}

/* An offer with a number or a named group in it: it must be the client's own number, not just any offer. */
interface SpecificOffer {
  re: RegExp;
  /** The guard had this kind before B2. */
  old: boolean;
  backed: (m: RegExpMatchArray, has: (re: RegExp) => boolean) => boolean;
}
const percentBacked = (m: RegExpMatchArray, has: (re: RegExp) => boolean) => has(new RegExp(`\\b${m[1]}\\s*(?:%|percent)`));
const dollarBacked = (m: RegExpMatchArray, has: (re: RegExp) => boolean) => has(new RegExp(`\\$\\s?${m[1]!.replace(/,/g, "")}\\b`));
const OFFER_GROUPS = "senior|military|veteran|first[- ]responder|student|new[- ]customer|referral|loyalty|repeat[- ]customer";
const SPECIFIC_OFFERS: SpecificOffer[] = [
  { re: /\b(\d{1,3})\s*%\s*off\b/gi, old: true, backed: percentBacked },
  { re: /\$\s?(\d[\d,]*)\s*off\b/gi, old: true, backed: dollarBacked },
  { re: /\b(\d{1,3})\s*%\s*(?:discount|savings?)\b/gi, old: false, backed: percentBacked },
  { re: /\bsave\s+(?:up\s+to\s+)?\$\s?(\d[\d,]*)/gi, old: false, backed: dollarBacked },
  { re: /\bhalf[- ](?:off|price)\b/gi, old: false, backed: (_m, has) => has(/half[- ](?:off|price)|\b50\s*%/i) },
  {
    re: new RegExp(`\\b(?:(?:${OFFER_GROUPS})s?(?:\\s*(?:,|and|&)\\s*)?)+\\s+discounts?\\b`, "gi"),
    old: false,
    backed: (m, has) =>
      [...m[0].matchAll(new RegExp(OFFER_GROUPS, "gi"))].every((g) => has(new RegExp(g[0].replace(/[- ]/g, "[- ]"), "i"))) && has(/discount|\boff\b|saving/i),
  },
  { re: /\bno\s+(?:trip|service[- ]call|travel|dispatch)\s+(?:charge|fee)s?\b/gi, old: false, backed: (_m, has) => has(/no\s+(?:trip|service[- ]call|travel|dispatch)\s+(?:charge|fee)|free\s+(?:service\s+call|trip)/i) },
  { re: /\$\s?0\s+down\b|\bno\s+money\s+down\b|\bzero\s+down\b/gi, old: false, backed: (_m, has) => has(/\$\s?0\s+down|no\s+money\s+down|zero\s+down/i) },
  {
    re: /\b(?:price[- ]match(?:ing)?|match\s+any\s+(?:written\s+|competitor'?s?\s+)?(?:price|quote|estimate)s?|beat\s+any\s+(?:written\s+|competitor'?s?\s+)?(?:price|quote)s?|lowest[- ]prices?)\b/gi,
    old: false,
    backed: (_m, has) => has(/price[- ]match|match\s+(?:any|your|a)\s+(?:[\w-]+\s+)?(?:price|quote)|lowest[- ]price|beat\s+any/i),
  },
];

/* Financing worded other than "financing": the same claim, said with other words. */
const FINANCING_OLD = /\bfinancing\b|\bpayment\s+plans?\b|\b0%\s*(?:apr|interest|financing)\b/gi;
const FINANCING_NEW = /\bpay\s+over\s+time\b|\blow\s+monthly\s+payments?\b|\bmonthly\s+payments?\s+(?:as\s+low\s+as|from|starting)\b|\beasy\s+payments?\b|\bbuy\s+now,?\s+pay\s+later\b|\binterest[- ]free\b|\bno[- ]interest(?=[-\s]+(?:financing|loans?|payments?|plans?|for|until|offers?|options?|credit|installments?|on\s+(?:approved|qualifying))\b)/gi;
const FINANCING_BACKING = /financ|payment\s+plans?|pay\s+over\s+time/i;
const FIN_PERCENT = /\b(\d{1,2}(?:\.\d+)?)\s*%\s*(?:apr|interest|financing)\b/gi;
const FIN_MONTHS = /\b(\d{1,3})\s*[- ]?\s*months?\b/gi;

/* Credentials: said on the page, they need the intake's licence number, certifications, or the client's own words. */
interface Credential {
  re: RegExp;
  what: string;
  backed: (m: RegExpMatchArray, facts: ClaimFacts, has: (re: RegExp) => boolean) => boolean;
}
const ACRONYMS = "EPA|NATE|OSHA|BPI|NABCEP";
const CREDENTIALS: Credential[] = [
  { re: /\blicensed\b/gi, what: "licensed", backed: (_m, f, has) => Boolean(f.licensed) || has(/\blicensed\b/i) },
  { re: /\bbonded\b/gi, what: "bonded", backed: (_m, _f, has) => has(/\bbond(?:ed|ing)?\b/i) },
  { re: /\binsured\b/gi, what: "insured", backed: (_m, _f, has) => has(/\binsur(?:ed|ance)\b/i) },
  { re: /\bbackground[- ]check(?:ed|s)?\b/gi, what: "background-checked", backed: (_m, _f, has) => has(/background/i) },
  {
    re: /\bA\+\s*(?:rating|rated)?[^.!?]{0,30}\b(?:BBB|Better\s+Business\s+Bureau)\b|\b(?:BBB|Better\s+Business\s+Bureau)\b[^.!?]{0,30}\bA\+|\bBBB[- ]accredited\b/gi,
    what: "a Better Business Bureau rating",
    backed: (_m, _f, has) => has(/\bBBB\b|Better\s+Business/i),
  },
  {
    re: new RegExp(`\\b(?:(?:${ACRONYMS})(?:\\s*(?:,|and|&)\\s*)?)+[-\\s]+(?:certified|licensed|approved)\\b`, "gi"),
    what: "a named certification",
    backed: (m, _f, has) => [...m[0].matchAll(new RegExp(ACRONYMS, "gi"))].every((a) => has(new RegExp(`\\b${a[0]}\\b`, "i"))),
  },
  {
    re: /\b24\s*(?:\/|-|x)\s*7\b|\b24[- ]hours?\s+(?:a\s+day|emergency|service|support)\b|\baround[- ]the[- ]clock\b/gi,
    what: "round-the-clock service",
    backed: (_m, f, has) => Boolean(f.emergency247) || has(/24\s*(?:\/|-|x)?\s*7|24[- ]hour|around[- ]the[- ]clock/i),
  },
  {
    re: /\bsame[- ]day\s+(?:service|appointments?|repairs?|installs?|installation|estimates?)\b/gi,
    what: "same-day service",
    backed: (_m, f, has) => Boolean(f.emergency247) || has(/same[- ]day/i),
  },
  {
    re: /\b(?:over|more\s+than|nearly|almost)?\s*(\d{1,3}(?:,\d{3})+|\d{3,})\+?\s+(?:jobs|projects|homes|customers|clients|families|installations?|installs|repairs|systems)\s+(?:completed|installed|served|serviced|done)\b/gi,
    what: "a job count",
    backed: (m, _f, has) => has(new RegExp(`\\b${m[1]!.replace(/,/g, "")}\\b`)),
  },
  {
    // Not the 7 of "24/7 technicians".
    re: /(?<![\d/])\b(\d{1,3})\s+(?:(?:full[- ]time|certified|licensed|expert|skilled)\s+)*(?:technicians|plumbers|electricians|employees|team\s+members|installers|roofers|staff|experts)\b/gi,
    what: "a head count",
    backed: (m, _f, has) => has(new RegExp(`\\b${m[1]}\\b`)),
  },
];

const clauseAround = (text: string, index: number) => {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("!", index), text.lastIndexOf("?", index), text.lastIndexOf(";", index)) + 1;
  const ends = [".", "!", "?", ";"].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length).trim();
};

/*
  The whole check on one text: the page's words, or the words only a search
  engine or screen reader reads. `noCta` is the page's words with the short
  text of its buttons and links taken out, because a call to action is not a
  claim; the generic free offers are read there and nowhere else.
*/
function claimIssuesInText(
  text: string,
  noCta: string,
  facts: ClaimFacts,
  sev: Severities,
  awards: string[],
  add: (issue: CheckIssue) => void,
): void {
  const stated = samePunctuation(facts.statedText ?? "");
  // Everything the client said, for the claims no single field answers. Thousands separators go, so "$1,500" and "$1500" agree.
  const words = samePunctuation([facts.currentOffers, facts.guarantees, facts.statedText ?? "", facts.certifications ?? ""].join(" . "))
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ");
  const clientHas = (re: RegExp) => [...words.matchAll(new RegExp(re.source, "gi"))].some((m) => !negatedBefore(words, m.index!));
  const unnegated = (source: string, re: RegExp): RegExpMatchArray[] =>
    [...source.matchAll(new RegExp(re.source, "gi"))].filter((m) => !negatedBefore(source, m.index!));
  const firstUnnegated = (re: RegExp): RegExpMatchArray | null => unnegated(text, re)[0] ?? null;
  // The text with its thousands separators gone, for the numbers (prices, counts) checked against `words`.
  const plain = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const hasOffers = facts.currentOffers.trim().length > 0;
  const unsupported = (severity: "fail" | "warn", evidence: string, message: string) =>
    add({ id: "house.claim.unsupported", severity, evidence, message });
  // B3: the value is on the client's old site but nobody confirmed it. Say so, in place of "the intake names none".
  const pendingNote = (key: string, field: string): string | null => {
    const entry = facts.unconfirmed?.find((u) => u.key === key && u.value.trim());
    return entry
      ? `the client's current website says "${entry.value.trim().slice(0, 120)}", but nobody has confirmed it yet: confirm it on the intake (${field}), or remove it from the page.`
      : null;
  };
  const GUARANTEE_PENDING = "process.guarantees";
  const OFFERS_PENDING = "extras.currentOffers";
  const FINANCING_PENDING = "extras.financingAvailable";

  // A superlative is backed only when the client's own words contain it.
  for (const { re } of SUPERLATIVES) {
    const found = re.exec(text);
    if (!found || clientHas(re)) continue;
    add({
      id: "house.claim.superlative",
      severity: sev.old,
      evidence: found[0],
      message: `The copy claims "${found[0].trim()}". House rule 5: no "best", "#1" or other superlatives. Rephrase into a plain, specific statement the client can stand behind, or remove it.`,
    });
  }

  // Guarantees. The page is read without warranty words that are not the business's own promise.
  const own = withoutNonOwnWarranty(text);
  const ownStated = withoutNonOwnWarranty(stated);
  // The Guarantees answer; or, when it is empty, the client's other words if they gave a warranty there.
  const guaranteeText = facts.guarantees.trim() ? facts.guarantees : GUARANTEE_RE.test(ownStated) ? ownStated : "";
  if (!guaranteeText) {
    const g = unnegated(own, GUARANTEE_RE)[0];
    if (g) {
      const near = windowAround(own, g.index!);
      const pending = pendingNote(GUARANTEE_PENDING, "Guarantees and warranties");
      unsupported(
        sev.old,
        g[0],
        pending
          ? `The page offers a guarantee or warranty ("${near.trim()}"); ${pending}`
          : `The page offers a guarantee or warranty ("${near.trim()}") but the intake names none (Guarantees and warranties is empty). House rule 2: show it as a visible [PLACEHOLDER: warranty — confirm with the client], or remove it.`,
      );
    }
  } else {
    // Said, but not necessarily this: stronger, longer, or covering more than the client's words (qualifier bound to the guarantee word only).
    const pageBound = boundGuaranteeStrength(own);
    const intakeBound = boundGuaranteeStrength(guaranteeText, true);
    const extraStrong = pageBound.strong.filter((q) => !intakeBound.strong.includes(q));
    const durationOver = pageBound.years > intakeBound.years;
    if (extraStrong.length > 0 || durationOver) {
      add({
        id: "house.claim.overreach",
        severity: sev.old,
        needsIntake: true,
        evidence: extraStrong[0] ?? `${pageBound.years === Infinity ? "lifetime" : `${pageBound.years}-year`} vs ${intakeBound.years === Infinity ? "lifetime" : `${intakeBound.years || "none"}`}`,
        message: `The page's guarantee looks stronger than the intake's ("${guaranteeText.trim()}"): it claims ${extraStrong.length ? `"${extraStrong.join('", "')}"` : `${pageBound.years === Infinity ? "a lifetime" : `a ${pageBound.years}-year`} guarantee`}. House rule 2: don't claim more than the client gave. A person confirms the real wording or the page is brought back in line.`,
      });
    } else {
      const fieldScope = intakeScopeOf(guaranteeText);
      const pageScope = new Set<string>();
      for (const g of unnegated(own, GUARANTEE_RE)) {
        for (const word of scopeOf(clauseAround(own, g.index!).slice(0, 160))) pageScope.add(word);
      }
      const missing = [...pageScope].filter((word) => !fieldScope.has(word));
      if (missing.length > 0) {
        add({
          id: "house.claim.overreach",
          severity: sev.fresh,
          needsIntake: true,
          evidence: missing[0],
          message: `The page's guarantee covers "${missing.join('", "')}", which the intake's own words ("${guaranteeText.trim()}") do not say. House rule 2: don't claim more than the client gave. A person confirms the real wording or the page is brought back in line.`,
        });
      }
    }
  }

  // A guarantee promised without the word ("if you are not happy, we come back and fix it at no charge").
  const paraphrased = new Set<string>();
  for (const { re, kind } of GUARANTEE_PARAPHRASES) {
    if (paraphrased.has(kind)) continue;
    const found = unnegated(text, re)[0];
    if (!found) continue;
    paraphrased.add(kind);
    if (clientHas(kind === "life" ? LIFE_BACKING : SATISFACTION_BACKING)) continue;
    unsupported(
      sev.fresh,
      found[0].trim(),
      `The page promises "${found[0].trim()}", which is a guarantee in other words, and the intake's own words do not give one. House rule 2: show it as a visible [PLACEHOLDER: guarantee — confirm with the client], or remove it.`,
    );
  }

  // Free offers, read without the short text of buttons and links (a call to action is not a claim).
  const freeSource = noCta;
  const offerWithoutIntake = (claim: string): string => {
    const pending = pendingNote(OFFERS_PENDING, "Current offers");
    return pending
      ? `The page advertises "${claim.trim()}"; ${pending}`
      : `The page advertises "${claim.trim()}" but the intake has no current offers. House rule 2: show it as a visible [PLACEHOLDER: offer — confirm with the client], or remove it.`;
  };
  for (const m of [...freeSource.matchAll(FREE_OFFER_RE)]) {
    if (negatedBefore(freeSource, m.index!)) continue;
    const noun = (m[1] ?? m[2])!;
    const group = nounGroup(noun);
    if (clientHas(new RegExp(`${FREE_WORD}\\b[^.!?]{0,25}?\\b${group}\\b|\\b${group}\\b[^.!?]{0,25}?(?:\\bfree\\b|\\bcosts?\\s+nothing|no[- ]charge|no[- ]cost|complimentary)`, "i"))) continue;
    const oldKind = new RegExp(`^(?:${FREE_NOUNS_OLD})$`, "i").test(noun);
    unsupported(
      oldKind && !hasOffers ? sev.old : sev.fresh,
      m[0],
      hasOffers
        ? `The page advertises "${m[0].trim()}", which is not one of the offers the intake lists (Current offers) or anything else the client said. House rule 2: show it as a visible [PLACEHOLDER: offer — confirm with the client], or remove it.`
        : offerWithoutIntake(m[0]),
    );
  }
  for (const m of unnegated(freeSource, /\bspecial\s+offers?\b/)) {
    if (hasOffers) continue;
    unsupported(sev.old, m[0], offerWithoutIntake(m[0]));
  }

  // Offers with a number or a group in them, read on the whole text: a button that says "10% off" states an offer.
  for (const offer of SPECIFIC_OFFERS) {
    for (const m of unnegated(plain, offer.re)) {
      if (offer.backed(m, clientHas)) continue;
      unsupported(
        offer.old && !hasOffers ? sev.old : sev.fresh,
        m[0].trim(),
        !hasOffers && pendingNote(OFFERS_PENDING, "Current offers")
          ? offerWithoutIntake(m[0])
          : `The page advertises "${m[0].trim()}", which is not in what the client said${hasOffers ? ` (Current offers lists other offers: "${facts.currentOffers.trim().slice(0, 80)}")` : " (the intake has no current offers)"}. House rule 2: show it as a visible [PLACEHOLDER: offer — confirm with the client], or remove it.`,
      );
    }
  }

  // Financing. The tick box backs a general mention; a specific term needs the client's own words.
  const financingBacked = Boolean(facts.financingAvailable) || clientHas(FINANCING_BACKING);
  let financingFlagged = false;
  for (const [re, severity] of [[FINANCING_OLD, sev.old], [FINANCING_NEW, sev.fresh]] as const) {
    const financing = firstUnnegated(re);
    if (!financing || financingBacked) continue;
    financingFlagged = true;
    const pending = pendingNote(FINANCING_PENDING, "Financing");
    unsupported(
      severity,
      financing[0],
      pending
        ? `The page mentions "${financing[0].trim()}"; ${pending}`
        : `The page mentions "${financing[0].trim()}" but the intake says financing is not offered. House rule 2: remove it, or the client confirms financing in the intake.`,
    );
  }
  if (!financingFlagged) {
    const clauses = new Set<string>();
    for (const re of [FINANCING_OLD, FINANCING_NEW, FIN_PERCENT]) for (const m of unnegated(plain, re)) clauses.add(clauseAround(plain, m.index!));
    for (const clause of clauses) {
      const percents = [...clause.matchAll(FIN_PERCENT)].map((m) => m[1]!);
      const months = [...clause.matchAll(FIN_MONTHS)].map((m) => m[1]!);
      const missing = [
        ...percents.filter((p) => !clientHas(new RegExp(`\\b${p.replace(".", "\\.")}\\s*%`))).map((p) => `${p}%`),
        ...months.filter((n) => !clientHas(new RegExp(`\\b${n}\\s*[- ]?months?\\b`))).map((n) => `${n} months`),
      ];
      if (missing.length > 0) {
        unsupported(
          sev.fresh,
          clause.slice(0, 80),
          `The page states a financing term (${missing.join(", ")}) that the client never gave: "${clause.slice(0, 120)}". The financing box backs a general mention only. House rule 2: use only the terms the client gave, or show it as a visible placeholder.`,
        );
      }
    }
  }

  // Credentials, hours and counts: each needs the intake or the client's words.
  for (const credential of CREDENTIALS) {
    for (const m of unnegated(plain, credential.re)) {
      if (credential.backed(m, facts, clientHas)) continue;
      unsupported(
        sev.fresh,
        m[0].trim(),
        `The page says "${m[0].trim()}" (${credential.what}), which is nowhere in the intake (licence numbers, certifications, hours) or the client's own words. House rule 2: no invented facts. Show it as a visible placeholder to confirm, or remove it.`,
      );
    }
  }
  const lowerWords = words.toLowerCase();
  for (const award of awards) {
    if (lowerWords.includes(award.toLowerCase())) continue;
    unsupported(sev.fresh, `award: ${award}`, `The page's structured data names the award "${award}", which is nowhere in the client's own words. Search engines show it as fact. House rule 2: no invented facts.`);
  }

  /*
    Who owns the business: a claim with no intake field of its own, so it is
    judged against the client's own words (10 November 2026). Each claim
    only backs itself.
  */
  // `stated` is read with the page's punctuation, so the same words typed with another hyphen still match.
  for (const claim of OWNERSHIP_CLAIMS) {
    const found = claim.wordings.map((wording) => firstUnnegated(wording)).find(Boolean);
    if (!found) continue;
    /*
      Any wording of THIS claim in the client's own words backs it; another
      claim's does not. And it must be SAID, not denied: "We are not family
      owned" names the claim too (12 November 2026, CodeRabbit on PR #75),
      so the client's words get the same negation test as the page's.
    */
    const backed = claim.wordings.some((wording) =>
      [...stated.matchAll(new RegExp(wording, "gi"))].some((m) => !negatedBefore(stated, m.index!)),
    );
    if (backed) continue;
    add({
      id: "house.claim.unsupported",
      severity: sev.old,
      evidence: found[0],
      message: `The page says the business is "${found[0].trim()}", which is nowhere in the intake. House rule 2: no invented facts. Remove it, or show it as a visible [PLACEHOLDER: ${found[0].trim().toLowerCase()} — confirm with the client].`,
    });
  }
}

/*
  Every claim issue on a page (B2 rebuilt it on the confirmed facts): what the
  page says, against what the client said. Superlatives need the client's own
  words; a guarantee, offer, financing term, credential or count must match
  what the intake or the client's words say, not merely that a field is
  filled; a call to action is never a claim. Placeholders are removed first,
  so a claim already shown as "[PLACEHOLDER: ...]" is not flagged again; a
  negated claim ("we cannot guarantee ...") is not a claim.

  Severity: the kinds the guard had before stay "fail" where the old guard
  would also have failed. Every new kind, and everything found only in image
  alt text or structured data, follows FACT_CHECKS_BLOCK: "fail" while it is
  on (it is on now: such a finding gets a paid fix round on a concept and
  blocks go-live on a site), "warn" if it is turned off (reported only).
*/
export function findClaimIssues(html: string, facts: ClaimFacts): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: CheckIssue) => {
    const key = `${issue.id}|${issue.evidence ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  const fresh = newKindSeverity();

  claimIssuesInText(toText(html), toText(html, { dropCtas: true }), facts, { old: "fail", fresh }, [], add);
  // What only a search engine or a screen reader reads: image alt text and structured data.
  const hidden = hiddenWords(html);
  if (hidden.text || hidden.awards.length > 0) {
    claimIssuesInText(hidden.text, hidden.text, facts, { old: fresh, fresh }, hidden.awards, add);
  }

  // #1a: a whole band whose heading declares an unsupported optional fact.
  for (const issue of sectionTopicIssues(html, facts)) add(issue);
  // A band of articles whose links go nowhere: posts that do not exist (11 November 2026).
  for (const issue of articleBandIssues(html)) add(issue);

  return issues;
}

/*
  For the go-live checklist: the claim phrases still on the built site, with
  their severity. Only "fail" ones block go-live; "warn" ones are shown.
*/
export function unsupportedClaimsOnSite(
  pages: [string, string][],
  facts: ClaimFacts,
): { file: string; evidence: string; severity: CheckIssue["severity"]; message: string }[] {
  const out: { file: string; evidence: string; severity: CheckIssue["severity"]; message: string }[] = [];
  for (const [file, html] of pages) {
    for (const issue of findClaimIssues(html, facts)) {
      out.push({ file, evidence: issue.evidence ?? issue.message, severity: issue.severity, message: issue.message });
    }
  }
  return out;
}
