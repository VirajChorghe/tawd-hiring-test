import type { IntakeData } from "../intake/schema";
import { inventedFactIssues, type CheckIssue } from "./checks";
import { statedTextFrom, type ClaimFacts } from "./claims";
import { intakePhones } from "./facts";

/*
  B1 (audit F-002, 12 November 2026): the project's confirmed facts, built
  once, and the check that holds every page to them.

  Before this, the invented-facts check ran on the homepage mockup only
  (pipeline.ts) and never on the pages of the real site. On the mockup it
  did not look at the number a call button dials, and it let through a
  price, a town, a staff name, a rating and a founding year other than the
  intake's. And the fact lists were built twice, differently: the mockup
  knew every location's phone, the site build only the main one.

  confirmedFactsFrom is now the one place the facts come from. factIssues
  checks a page against them; the go-live checklist runs it over every
  page of the built site, the 404 page included.

  Report-only first (the plan's rule), until Jason had seen how many false
  alarms they raise on real projects. The read-only count over the saved
  projects (12 November 2026: 13 projects, 6 built sites, 15 concepts) found
  five kinds of false alarm, all fixed (fact-count-false-alarms.test.ts);
  every other hit was a fact on the page the intake doesn't have. Jason
  then chose to block on all of them: a failing fact check gets a fix round
  on a concept and blocks go-live on a site. Setting this back to false
  makes every new kind of check report-only again.
*/
export const FACT_CHECKS_BLOCK = true;

export interface ConfirmedFacts {
  businessName: string;
  /** Every phone the client gave (main and each location), formatted. */
  phones: string[];
  licenseNumbers: string[];
  yearFounded: number | null;
  /** The street addresses the client gave (main and each location). */
  streetAddresses: string[];
  /** Towns the business is in or serves: its city, each location's, and the service-area cities and counties. */
  places: string[];
  /**
   * True when the service area is not a list of towns (whole states,
   * nationwide, a radius): any town may then be honest, so towns are not
   * checked.
   */
  townsUnbounded: boolean;
  /** The state the business and each location are in, as the intake wrote it: never a town. */
  states?: string[];
  /** Everything the client wrote in their own words, the business and legal names included. */
  statedText: string;
  /** The offer facts the claims check uses (gap 12). */
  claims: ClaimFacts;
}

/*
  The client's own free text, for a claim no intake field answers -
  "family owned", "second generation" (10 November 2026). Every field here
  is one where a client writes about themselves in their own words,
  including copy they supplied and notes on their photographs. A fact
  confirmed from their current site is in these fields too, because that is
  where #1b writes it once the team confirms it: so a confirmed site fact
  backs the claim and an unconfirmed one does not, which is the rule Jason
  set. (Moved here from pipeline.ts and site-build.ts, which each kept a copy.)
*/
function ownWords(data: IntakeData): string {
  return statedTextFrom([
    data.content.toneOfVoice,
    data.content.suppliedCopy,
    data.process.scheduling,
    data.process.quotingAndPricing,
    data.process.guarantees,
    data.extras.currentOffers,
    data.extras.specialFeaturesNote,
    data.photos.notes,
    (data.business.certifications ?? []).join(" . "),
    data.brand.moodWords?.join(" "),
    data.services.items.map((service) => service.description).join(" . "),
  ]);
}

export function confirmedFactsFrom(
  data: IntakeData,
  options: {
    unconfirmed?: { key: string; value: string }[];
    /*
      Batch B review, H2: on a makeover, the words kept from the client's
      current site and approved on Content (or the approved home words) are
      the client's own words, so a price, a founder or "25 years of
      experience" in them backs itself. Without this every real fact in kept
      copy failed, and a fix round would rewrite the client's own words.
      Approving them is the team confirming them, which is the rule for any
      fact read from the old site.
    */
    keptWords?: string;
  } = {},
): ConfirmedFacts {
  const b = data.business;
  const words = statedTextFrom([ownWords(data), options.keptWords]);
  const nonEmpty = (values: (string | null | undefined)[]) => values.map((v) => (v ?? "").trim()).filter(Boolean);
  const scope = data.serviceAreas.scope;
  return {
    businessName: b.name,
    phones: intakePhones(data),
    licenseNumbers: b.licenseNumbers ?? [],
    yearFounded: b.yearFounded,
    streetAddresses: nonEmpty([b.streetAddress, ...b.locations.map((l) => l.streetAddress)]),
    places: nonEmpty([b.city, ...b.locations.map((l) => l.city), ...(data.serviceAreas.cities ?? []), ...(data.serviceAreas.counties ?? [])]),
    townsUnbounded: scope !== null && scope !== undefined && scope !== "cities",
    states: nonEmpty([b.state, ...b.locations.map((l) => l.state)]),
    statedText: statedTextFrom([b.name, b.legalName, words]),
    claims: {
      guarantees: data.process.guarantees ?? "",
      currentOffers: data.extras.currentOffers ?? "",
      financingAvailable: data.extras.financingAvailable ?? false,
      statedText: words,
      licensed: (b.licenseNumbers ?? []).some((n) => n.trim().length > 0),
      certifications: (b.certifications ?? []).join(" . "),
      emergency247: b.emergency247 ?? false,
      ...(options.unconfirmed?.length ? { unconfirmed: options.unconfirmed } : {}),
    },
  };
}

/* ---------- reading a page ---------- */

const PLACEHOLDER = /\[PLACEHOLDER:[^\]]*\]/gi;

function decode(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

/* What a reader sees, without anything inside a visible placeholder (that is declared missing, not claimed). */
function claimedText(html: string): string {
  return decode(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(PLACEHOLDER, " "),
  ).replace(/\s+/g, " ");
}

const digitsOf = (value: string) => value.replace(/\D+/g, "");
const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function phoneKnown(value: string, allowed: string[]): boolean {
  const d = digitsOf(value);
  if (d.length < 10) return true; // not a phone number at all; the other checks deal with short numbers
  return allowed.map(digitsOf).filter(Boolean).some((a) => d.endsWith(a) || a.endsWith(d));
}

/* "$1,500", "$99.00", "$ 250" -> "1500", "99", "250". */
function priceValue(raw: string): string {
  const [whole, cents] = raw.replace(/[$\s,]/g, "").split(".");
  return cents && /^0+$/.test(cents) ? whole! : cents ? `${whole}.${cents}` : whole!;
}

const STREET_TYPES =
  "St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail";
// The house number is never the end of a phone number: "(760) 394-5251 Winnemucca Sylvia Ridge Ct." is a phone and a street (the count, 12 Nov).
// A street name is short: at most three words before the street type.
const STREET = new RegExp(`(?<![\\d-]|\\d{3}[\\s.])\\b(\\d{1,6})\\s+((?:[A-Z][A-Za-z.'-]*\\s+){1,3}(?:${STREET_TYPES}))\\b\\.?`, "g");
// Words that make "12 Towns Including St" a list, not a street ("Proudly Serving 12 Towns Including St. Helena").
const NOT_STREET_WORDS = new Set(["town", "towns", "city", "cities", "year", "years", "including", "county", "counties", "neighborhoods", "neighbourhoods", "communities", "locations", "areas", "homes", "customers", "clients", "families", "projects", "jobs", "miles", "services", "technicians", "plumbers", "reviews", "like", "such", "across", "around", "throughout", "and"]);

const STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
/* "Fair Oaks, CA": a town written with its state, the one shape code can be sure is a town. */
const TOWN_WITH_STATE = new RegExp(`\\b((?:[A-Z][a-z]+\\s){0,3}[A-Z][a-z]+),\\s*(${STATE_CODES})\\b`, "g");

/* "Proudly serving Shelbyville and Capital City": the towns after "serving", up to the end of the list. */
const SERVING_LIST = /\b(?:[Ss]erving|[Ss]erves?|[Ss]ervice areas?:?|[Aa]reas we serve:?)\s+((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})(?:\s*(?:,|and|&)\s*(?:and\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})*)/g;
/* Capitalised words after "serving" that are not towns. */
const NOT_TOWNS = new Set(["the", "all", "our", "your", "you", "greater", "area", "areas", "region", "every", "each", "homes", "homeowners", "businesses", "families", "customers", "residential", "commercial", "northern", "southern", "eastern", "western", "central",
  // Words that start the next phrase, not a town ("From" and "Free" in the count, 12 Nov).
  "from", "free", "call", "get", "request", "book", "contact", "today", "now", "more", "since", "with", "for", "and", "we", "us", "clients", "owners", "people", "neighbors", "communities",
  // Small words that start a slogan ("Serving Up Comfort"), not a town.
  "up", "out", "in", "on", "at", "to", "by", "as", "of", "a", "an", "it", "its", "over", "around", "right", "up-to"]);

/* A US state is never a town (full names, and the two-letter codes). */
const US_STATE_NAMES = new Set(
  ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia"],
);
function isStateName(name: string): boolean {
  return US_STATE_NAMES.has(name.toLowerCase()) || new RegExp(`^(?:${STATE_CODES})$`).test(name.trim());
}

/* "founded by Jane Doe", "owner Mike Smith", "I'm Dave": a person named as part of the business. */
const PERSON_PATTERNS = [
  /\b(?:founded|owned|run|started|operated|led)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/g,
  // The role word in either case, the name capitalised: an "i" flag here read "owner questions come from" as a name (the count, 12 Nov).
  /\b(?:[Oo]wner|[Ff]ounder|[Cc]o-founder|[Pp]resident|CEO|[Ll]ead technician|[Mm]aster plumber|[Hh]ead chef)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g,
  /\b(?:I'm|I am|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
];

/* Common English words that make a captured "name" a heading, not a person. */
const NOT_NAME_WORDS = new Set(["operated", "here", "ready", "proud", "proudly", "since", "your", "our", "the", "happy", "glad", "available", "committed", "on", "always", "licensed", "local", "locally", "family", "not", "just", "a", "an", "to", "for", "with", "and", "in", "at", "of", "here's", "there", "serving", "owned", "trusted", "dedicated", "excited", "pleased", "honored", "standing", "looking", "working", "offering", "providing", "also", "now", "today"]);

/* A rating or a review count, written any of the usual ways. */
const RATING_PATTERNS = [
  // Not a date: "Last updated 3/5/2026" is not a 3 out of 5 (nothing before the first digit, nothing after the 5 but a word break).
  /(?<![\d/.])\b[1-5](?:\.\d)?\s*(?:out of|\/)\s*5\b(?![/\d])/i,
  // "5 Star Service" is a rating too; claims.ts no longer reads it, so it is read once, here.
  /\b(?:[1-5](?:\.\d)?|five)[- ]?stars?\b/i,
  /\b(?:rated|rating of)\s*[1-5](?:\.\d)?\b/i,
  /\b\d{1,3}(?:,\d{3})*\+?\s+(?:(?:five|5)[- ]star\s+|google\s+|verified\s+|happy\s+customer\s+)?reviews\b/i,
  /★{3,}/,
];

/*
  A founding claim, not any "since": "Since 2023, federal rules require new
  refrigerants" is a date, not the business's start. About the business:
  "serving ... since", "in business since", "family owned since",
  "established / est. / founded (in)", or a bare "since YEAR" that is not
  an opening clause closed by a comma.
*/
const SINCE_YEAR =
  /\b(?:serving\b[^.!?]{0,30}?\bsince|in\s+business\s+since|(?:family[- ]|locally[- ]|veteran[- ])?(?:owned|operated)(?:\s+and\s+operated)?\s+since|established(?:\s+in)?|est\.?|founded(?:\s+in)?|since(?=\s*(?:18|19|20)\d{2}\b(?!\s*,)))\s*((?:18|19|20)\d{2})\b/gi;
/*
  The business's own years, not a product's lifespan ("a furnace gives 15
  to 20 years of service"): "years of experience", "in business",
  "serving", "for N years" beside we/our/family/business, and "years of
  service" only beside our/we've.
*/
const YEARS_CLAIMS = [
  /\b(\d{1,3})\+?\s+years?\s+(?:of\s+experience|in\s+business|serving|experience)\b/gi,
  /\b(?:we|our|we've|family|business)\b[^.!?]{0,40}?\bfor\s+(?:over\s+|more\s+than\s+|nearly\s+)?(\d{1,3})\+?\s+years?\b/gi,
  /\b(?:our|we've|we\s+have)\b[^.!?]{0,40}?\b(\d{1,3})\+?\s+years?\s+of\s+service\b/gi,
];

export interface FactCheckOptions {
  /** The year "today" (for "30 years in business"); defaults to the clock. */
  year?: number;
}

/*
  The page against the confirmed facts. Each issue names the kind of fact
  and what the page said. Placeholders are skipped: a visible placeholder
  declares a fact missing, which is the honest way to show a gap.
*/
export function factIssues(html: string, facts: ConfirmedFacts, options: FactCheckOptions = {}): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const severity = FACT_CHECKS_BLOCK ? "fail" : "warn";
  const text = claimedText(html);
  const stated = facts.statedText;
  const statedSquashed = squash(stated);
  const add = (id: string, evidence: string, message: string) => {
    if (!issues.some((i) => i.id === id && i.evidence === evidence)) issues.push({ id, severity, evidence, message });
  };

  // The number a call button dials: a page can show the right number and dial another.
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const dialled = decode(m[1]!).trim();
    if (!phoneKnown(dialled, facts.phones)) {
      add(
        "facts.tel",
        dialled,
        facts.phones.length
          ? `A call button dials ${dialled}, which is not a phone number in the intake (${facts.phones.join(", ")}).`
          : `A call button dials ${dialled}, but the intake has no phone number.`,
      );
    }
  }

  // Prices: every dollar amount must be one the client wrote somewhere.
  const statedPrices = new Set([...stated.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)].map((m) => priceValue(m[0])));
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)) {
    if (statedPrices.has(priceValue(m[0]))) continue;
    add("facts.price", m[0], `The page states the price "${m[0]}", which is nowhere in the intake.`);
  }

  // The founding year, and "N years in business" against it.
  for (const m of text.matchAll(SINCE_YEAR)) {
    const year = Number(m[1]);
    if (facts.yearFounded !== null && year !== facts.yearFounded && !stated.includes(m[1]!)) {
      add("facts.year", m[0], `The page says "${m[0]}", but the intake's founding year is ${facts.yearFounded}.`);
    }
  }
  const thisYear = options.year ?? new Date().getFullYear();
  for (const m of YEARS_CLAIMS.flatMap((re) => [...text.matchAll(re)])) {
    const n = Number(m[1]);
    const said = new RegExp(`\\b${n}\\+?\\s+years?\\b`, "i").test(stated);
    if (said) continue;
    if (facts.yearFounded !== null && n <= thisYear - facts.yearFounded + 1) continue;
    add(
      "facts.years",
      m[0],
      facts.yearFounded === null
        ? `The page says "${m[0]}", but the intake has no founding year and the client never said it.`
        : `The page says "${m[0]}", but a business founded in ${facts.yearFounded} is ${thisYear - facts.yearFounded} years old.`,
    );
  }

  // Street addresses: a house number and street the client gave.
  const known = facts.streetAddresses.map(squash);
  for (const m of text.matchAll(STREET)) {
    const shown = squash(`${m[1]} ${m[2]}`);
    const nameWords = m[2]!.split(/\s+/);
    // A list of places, not a street ("12 Towns Including St. Helena").
    if (nameWords.slice(0, -1).some((w) => NOT_STREET_WORDS.has(w.toLowerCase()))) continue;
    // "St." followed by a capitalised word is a saint ("St. Helena"), not a street.
    if (/^St$/.test(nameWords.at(-1)!) && /^\.\s+[A-Z][a-z]/.test(text.slice(m.index! + m[0].length - (m[0].endsWith(".") ? 1 : 0)))) continue;
    const firstWord = squash(nameWords[0]!);
    if (known.some((k) => k.includes(shown) || k.startsWith(squash(m[1]!) + firstWord))) continue;
    add("facts.address", m[0].trim(), `The page shows the address "${m[0].trim()}", which is not an address in the intake.`);
  }

  // Towns written with their state ("Fair Oaks, CA"), when the service area is a list of towns.
  if (!facts.townsUnbounded) {
    const places = facts.places.map((p) => squash(p.split(",")[0]!));
    // The intake's own state is never a town either.
    const ownStates = new Set((facts.states ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const m of text.matchAll(TOWN_WITH_STATE)) {
      const town = squash(m[1]!);
      if (places.some((p) => p === town || p.endsWith(town) || town.endsWith(p))) continue;
      if (statedSquashed.includes(town)) continue;
      add("facts.town", `${m[1]}, ${m[2]}`, `The page names ${m[1]}, ${m[2]}, which is not a town the business is in or serves according to the intake.`);
    }
    for (const m of text.matchAll(SERVING_LIST)) {
      for (const raw of m[1]!.split(/\s*(?:,|\band\b|&)\s*/)) {
        // "Springfield Homeowners" -> "Springfield": trailing words that are not part of a town name.
        const words = raw.trim().split(/\s+/).filter(Boolean);
        while (words.length && NOT_TOWNS.has(words[words.length - 1]!.toLowerCase())) words.pop();
        if (!words.length || NOT_TOWNS.has(words[0]!.toLowerCase())) continue;
        const name = words.join(" ");
        if (isStateName(name) || ownStates.has(name.toLowerCase())) continue;
        const town = squash(name);
        if (places.some((p) => p === town || p.startsWith(town) || town.startsWith(p))) continue;
        if (statedSquashed.includes(town)) continue;
        add("facts.town", name, `The page says it serves ${name}, which is not a town the business is in or serves according to the intake.`);
      }
    }
  }

  // The page's structured data (JSON-LD), which search engines show as fact: its phone and its rating.
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const json = block[1]!;
    for (const tel of json.matchAll(/"telephone"\s*:\s*"([^"]+)"/g)) {
      if (!phoneKnown(tel[1]!, facts.phones)) add("facts.tel", tel[1]!, `The page's structured data gives the phone ${tel[1]}, which is not a phone number in the intake.`);
    }
    if (/"aggregateRating"|"reviewCount"|"ratingValue"/.test(json)) {
      const value = /"ratingValue"\s*:\s*"?([\d.]+)/.exec(json)?.[1];
      const count = /"reviewCount"\s*:\s*"?(\d+)/.exec(json)?.[1];
      const said = [value, count].filter(Boolean).every((v) => stated.includes(v!));
      if (!said) add("facts.rating", `structured data: ${[value && `rating ${value}`, count && `${count} reviews`].filter(Boolean).join(", ")}`, "The page's structured data states a rating or review count the client never gave. Search engines show it as fact.");
    }
  }

  // People named as part of the business.
  for (const pattern of PERSON_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const name = m[1]!.trim();
      // A Title Case heading ("Owner Operated Since 2020", "I'm Here To Help") is not a name.
      if (name.split(/\s+/).some((w) => NOT_NAME_WORDS.has(w.toLowerCase()))) continue;
      const parts = name.split(/\s+/).filter((p) => p.length > 1);
      if (parts.every((p) => statedSquashed.includes(squash(p)))) continue;
      add("facts.name", m[0].trim(), `The page names "${name}" ("${m[0].trim()}"), but that name is nowhere in the client's own words in the intake.`);
    }
  }

  // Ratings and review counts.
  for (const pattern of RATING_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    if (stated.toLowerCase().includes(m[0].toLowerCase())) continue;
    add("facts.rating", m[0], `The page states "${m[0]}". A rating or review count must come from the client, or be a visible placeholder.`);
  }

  return issues;
}

/* For the go-live checklist: every page of the built site, the 404 page included. */
export function factIssuesOnSite(
  pages: [string, string][],
  facts: ConfirmedFacts,
  options: FactCheckOptions = {},
): { file: string; id: string; evidence: string; message: string }[] {
  const out: { file: string; id: string; evidence: string; message: string }[] = [];
  for (const [file, html] of pages) {
    // The mockup's own checks (a phone in the text, a licence, a year with none in the intake, a rating), never run on built pages before.
    const older = inventedFactIssues(html, facts);
    const newer = factIssues(html, facts, options).filter((i) => !(i.id === "facts.rating" && older.some((o) => o.id === "house.reviews.invented")));
    for (const issue of [...older, ...newer]) out.push({ file, id: issue.id, evidence: issue.evidence ?? "", message: issue.message });
  }
  return out;
}
