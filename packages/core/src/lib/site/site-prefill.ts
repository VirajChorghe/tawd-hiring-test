import { formatUsPhone, phoneProblem } from "../phone";
import type { IntakeData } from "../intake/schema";
import { US_STATES } from "../intake/service-area";
import type { PrefillKey } from "../intake/prefill-fields";
import type { SiteHome } from "../mockups/current-site";
import type { ImportedPageSummary } from "./site-import-seo";

/*
  Empty intake answers filled from the current site, by code (Jason,
  7 October 2026; docs/plans/flow-a-one-read.md section 6). Only what the
  site proves:

  - the phone: the one tel: link on the home page, or the one number on at
    least half the pages read; two main numbers fill nothing (listed);
  - the email: the one mailto: on the home or contact page;
  - the address: only from the site's own schema.org PostalAddress (free
    text is never parsed into an address);
  - the services: the names of the pages read as service pages;
  - the service-area towns: the names of the pages read as city pages
    (when the intake's areas are towns).

  Never the name, licence numbers, years, hours, prices or reviews. The
  site's words are data, never instructions: values are plain text, capped
  at the intake's lengths. The team's answers always win: only an empty
  field is filled, and a field the team corrected is never filled again.
  Pure: the worker applies it (core site/site-read.ts).
*/

export interface SitePrefillProposal {
  key: PrefillKey;
  value: unknown;
  /** The address it was read from (shown on the field's mark). */
  from: string;
}

export interface SitePrefillPlan {
  /** Empty fields to fill now. */
  fill: SitePrefillProposal[];
  /** Found but not filled, in words for the Intake panel (amber). */
  notes: string[];
}

const MAX_TEXT = 200;
// eslint-disable-next-line no-control-regex
const plain = (value: string) => value.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
const phoneKey = (value: string) => value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const readPages = (pages: ImportedPageSummary[]) => pages.filter((p) => !p.gap);

/* The site's main phone number, or why there isn't one. */
function mainPhone(pages: ImportedPageSummary[]): { phone: string; from: string } | { ambiguous: string[] } | null {
  const read = readPages(pages);
  const home = read.find((p) => p.path === "/");
  const homeTels = [...new Map((home?.contact?.tels ?? []).map((t) => [phoneKey(t), t])).values()];
  if (home && homeTels.length === 1) return { phone: formatUsPhone(homeTels[0]!), from: home.url };
  // No single tel: link on the home page: the number on at least half the pages read.
  const counts = new Map<string, { phone: string; pages: number; from: string }>();
  for (const page of read) {
    const numbers = new Map<string, string>();
    for (const n of [...(page.contact?.tels ?? []), ...page.phones]) if (phoneKey(n).length === 10) numbers.set(phoneKey(n), n);
    for (const [key, phone] of numbers) {
      const entry = counts.get(key) ?? { phone, pages: 0, from: page.url };
      entry.pages += 1;
      counts.set(key, entry);
    }
  }
  const main = [...counts.values()].filter((c) => c.pages * 2 >= read.length && c.pages > 0);
  if (main.length === 1) return { phone: formatUsPhone(main[0]!.phone), from: main[0]!.from };
  if (main.length > 1) return { ambiguous: main.map((m) => formatUsPhone(m.phone)) };
  if (homeTels.length > 1) return { ambiguous: homeTels.map(formatUsPhone) };
  return null;
}

function mainEmail(pages: ImportedPageSummary[]): { email: string; from: string } | { ambiguous: string[] } | null {
  const sources = readPages(pages).filter((p) => p.path === "/" || p.kind === "contact");
  const found = new Map<string, string>();
  for (const page of sources) for (const e of page.contact?.emails ?? []) if (!found.has(e)) found.set(e, page.url);
  if (found.size === 1) {
    const [email, from] = [...found.entries()][0]!;
    return { email: plain(email), from };
  }
  return found.size > 1 ? { ambiguous: [...found.keys()] } : null;
}

/* A state as its two-letter code ("California" and "CA" are the same state); anything else as written. */
export function usStateCode(state: string): string {
  const s = plain(state).replace(/\.$/, "");
  const hit = US_STATES.find(([code, name]) => code.toLowerCase() === s.toLowerCase() || name.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : s;
}

/*
  A schema address tidied (0.97.0): the state as its code, and a city that
  carries the state too ("Roseville, California" with "CA", seen on
  finleypest.com 7 October 2026) without it.
*/
export function tidyAddress(a: { streetAddress: string; city: string; state: string }): { streetAddress: string; city: string; state: string } {
  let city = plain(a.city);
  let state = usStateCode(a.state);
  const tail = /,\s*([A-Za-z .]+)$/.exec(city);
  if (tail) {
    const code = usStateCode(tail[1]!);
    if (US_STATES.some(([c]) => c === code) && (!state || state === code)) {
      city = city.slice(0, tail.index).trim();
      state = code;
    }
  }
  return { streetAddress: plain(a.streetAddress), city, state };
}

const STREET_WORDS: Record<string, string> = { street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", boulevard: "blvd", court: "ct", place: "pl", suite: "ste", highway: "hwy", parkway: "pkwy", north: "n", south: "s", east: "e", west: "w" };
/* Two addresses' parts compared loosely: case, punctuation, "Lane" and "Ln", "California" and "CA" don't count. */
export function sameAddressPart(a: string, b: string): boolean {
  const key = (t: string) =>
    usStateCode(t)
      .toLowerCase()
      .replace(/[.,#]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => STREET_WORDS[w] ?? w)
      .join(" ");
  return key(a) === key(b);
}

function mainAddress(pages: ImportedPageSummary[]): { address: { streetAddress: string; city: string; state: string }; from: string } | { ambiguous: string[] } | null {
  const found = new Map<string, { address: { streetAddress: string; city: string; state: string }; from: string }>();
  // Only the business's own address: the home or contact page's business schema (Fable's review M2).
  for (const page of readPages(pages).filter((p) => p.path === "/" || p.kind === "contact")) {
    for (const a of page.contact?.addresses ?? []) {
      const address = tidyAddress(a);
      const key = `${address.streetAddress}|${address.city}|${address.state}`.toLowerCase();
      if (!found.has(key)) found.set(key, { address, from: page.url });
    }
  }
  if (found.size === 1) return [...found.values()][0]!;
  return found.size > 1 ? { ambiguous: [...found.values()].map((f) => [f.address.streetAddress, f.address.city, f.address.state].filter(Boolean).join(", ")) } : null;
}

const STATE_CODES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
/** Words that name the trade or pad a page name, never part of a town ("Pest Control In Elk Grove"). */
const NOT_TOWN = /\b(pest|control|exterminators?|extermination|termites?|ants?|rodents?|spiders?|services?|plumbing|plumbers?|hvac|heating|cooling|air|conditioning|roofing|roofers?|glass|windows?|doors?|law|lawyers?|attorneys?|injury|repairs?|installation|cleaning|removal|treatment|company|companies|near|me|best|top|local|in|and|the|of|for|serving|areas?|services)\b|&|\|/gi;

/*
  A city page's town, only when it reads cleanly (Fable's review M1): "Pest
  Control In Elk Grove, CA" gives "Elk Grove, CA"; "Folsom" on
  /pest-control-folsom-ca/ gives "Folsom, CA". The state comes from the
  name, the title or the address's last part; with no state, or anything
  but a plain place name left, nothing is filled.
*/
export function townOf(page: Pick<ImportedPageSummary, "name" | "title" | "path">): string | null {
  const name = plain(page.name);
  const title = plain(page.title ?? "");
  const named = /\b(?:in|near|serving)\s+([A-Z][A-Za-z .'-]+?),\s*([A-Z]{2})\b/.exec(name) ?? /\b(?:in|near|serving)\s+([A-Z][A-Za-z .'-]+?),\s*([A-Z]{2})\b/i.exec(title);
  const pathState = /-([a-z]{2})$/.exec(page.path.replace(/\/$/, "").split("/").at(-1) ?? "")?.[1]?.toUpperCase();
  const nameState = /,\s*([A-Z]{2})$/.exec(name)?.[1];
  const state = [named?.[2]?.toUpperCase(), nameState, pathState].find((s) => s && STATE_CODES.has(s));
  const raw = named ? named[1]! : name.replace(/,\s*[A-Z]{2}$/, "");
  const town = raw.replace(NOT_TOWN, " ").replace(/\s+/g, " ").trim();
  if (!state || !town || town.length > 40) return null;
  const words = town.split(" ");
  if (words.length > 4 || !words.every((w) => /^[A-Z][a-zA-Z.'-]*$/.test(w))) return null;
  return `${town}, ${state}`;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/*
  #1b (7 November 2026): warranty, offer and financing facts the current
  site states in its own words, captured as suggestions the team confirms
  (never used as a fact until then), so a real on-site fact isn't treated as
  unsupported later on. Only the clearest phrasings are taken, to keep a
  wrong capture rare; a wrongly-read warranty is as bad as an invented one,
  so the team confirms every one. The site's words are data, never
  instructions: the captured phrase is plain text, capped, like every other
  prefilled value. Reviews are the customers' words, not the business's own
  claims, so they're left out.
*/
const GUARANTEE_RE = /\b(?:lifetime|money[- ]?back|satisfaction|workmanship|labou?r|parts?|material|manufacturer'?s?|\d{1,2}[- ]?years?|\d{1,2}[- ]?yrs?|100%)(?:\s+[\w'%-]+){0,3}?\s+(?:warrant(?:y|ies)|guarantee[ds]?)\b/i;
// (?<![\w-]) keeps "worry-free estimate" out, and (?!to\b) keeps "feel free
// to quote" out — the same two false positives the claims-guard fixed (0.128.0).
const OFFER_RE = /(?<![\w-])free\b(?:\s+(?!to\b)[\w'-]+){0,2}?\s+(?:consultations?|estimates?|quotes?|inspections?|assessments?|evaluations?)\b/i;
const FINANCING_RE = /\bfinancing\s+(?:is\s+)?(?:available|options?|plans?)\b|\bwe\s+(?:offer|provide|have)\s+financing\b|\bpayment\s+plans?\b|\bbuy\s+now,?\s+pay\s+later\b/i;
/*
  A negated claim never reads as a fact (CodeRabbit PR #49, two rounds):
  every fact is judged sentence by sentence, and a sentence that carries a
  negation word is skipped for that fact — whether the negation comes before
  the noun ("No lifetime warranty") or after it ("Payment plans are not
  available"). A positive claim in ANOTHER sentence of the same band still
  counts ("No warranty gimmicks. Our 10-year workmanship warranty covers
  every job." captures the real warranty). Positive wordings that merely
  contain a negation word — "no-obligation", "no cost", "no questions
  (asked)", "no credit check", "why not …" — are not negations and don't
  skip their sentence. Conservative by design: a sentence that mixes a
  negation word with a real claim is dropped, because a wrongly-read fact
  is worse than a missed one the team can type in.
*/
// The apostrophe class takes the curly ’ (U+2019) too: WordPress and the
// other builders TAWD scrapes emit it by default, so "don’t" is the norm in
// band text (hand review, 8 Nov). The split keeps a decimal ("4.9% APR")
// and anything else a terminator touches without a following space in one
// sentence, so a negation can't be stranded from its own clause.
const NEGATION_RE = /(?<!\bwhy\s)\b(?:no|not|without|never|don['’]?t|doesn['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|won['’]?t|wouldn['’]?t|couldn['’]?t|cannot|can['’]?t)\b(?![- ]?(?:obligat(?:ions?|ed)|costs?|questions|hidden\s+fees|(?:a\s+)?credit\s+check)\b)/i;
const sentencesOf = (band: string) => band.split(/[.!?]+(?=\s|$)/);

export function statedSiteFacts(home: SiteHome | null, from: string): SitePrefillProposal[] {
  if (!home || !from) return [];
  // Each section on its own (never joined), so a phrase can't be stitched
  // across two bands. A reviews band is the customers' voice, not a claim.
  const bands = home.sections.filter((s) => s.kind !== "reviews").map((s) => s.words);
  const first = (re: RegExp): string | null => {
    for (const band of bands) {
      for (const sentence of sentencesOf(band)) {
        if (NEGATION_RE.test(sentence)) continue;
        const hit = re.exec(sentence)?.[0];
        if (hit) return plain(hit);
      }
    }
    return null;
  };
  const out: SitePrefillProposal[] = [];
  const guarantee = first(GUARANTEE_RE);
  if (guarantee) out.push({ key: "process.guarantees", value: guarantee, from });
  const offer = first(OFFER_RE);
  if (offer) out.push({ key: "extras.currentOffers", value: offer, from });
  if (bands.some((b) => sentencesOf(b).some((s) => FINANCING_RE.test(s) && !NEGATION_RE.test(s)))) out.push({ key: "extras.financingAvailable", value: true, from });
  return out;
}

/*
  The town the current site actually sells to, when the intake's service
  areas don't list it (New Dawn Awning, 10 November 2026).

  Its home page is "Patio Covers in Sacramento" and it ranks #1 for that;
  Sacramento is not one of its service areas in the intake. So the builder
  carried the site's own focus into the concept, the Creative Director -
  handed the intake and nothing else - called it an invented location and
  marked the concept down, while the SEO audit said the opposite: keep the
  Sacramento focus. Two paid steps disagreeing, with nothing able to settle
  it.

  Code cannot settle it either. Whether the client serves Sacramento is a
  fact only the client knows, so this returns a NOTE for the team and never
  fills or changes the intake's list - the rule Jason set for a fact read
  off a site: a suggestion until somebody confirms it.

  Read only from the home page's H1, title and description, because the
  places a site puts there are the ones it sells to. A capitalised phrase
  after "in", "serving" or "near" (either case), with everything that is not a town
  thrown out: the state, the business's own name, the places the intake
  already names, and any phrase holding a lower-case or everyday word,
  which is how an ordinary sentence ("in Business Since 1970") is kept out.
  It names a CANDIDATE, not a verified town - a person decides, and that is
  the whole point of it.
*/
/*
  The lead word in either case ("in" in a sentence, "In" or "Serving" in a
  Title Case heading - 12 November 2026, CodeRabbit on PR #75: "Serving
  Sacramento" found nothing); the place itself must still be capitalised.
*/
const PLACE_LEAD = /\b(?:[Ii]n|[Ss]erving|[Ss]erves|[Ss]erve|[Nn]ear|[Aa]round|[Tt]hroughout)\s+([A-Z][a-zA-Z]+(?:[ -][A-Z][a-zA-Z]+){0,2})\b/g;
/* Words that can follow "in" looking like a place and never are. */
const NOT_A_PLACE = new Set([
  "business", "since", "stock", "minutes", "hours", "days", "time", "times", "need", "order", "person",
  "house", "home", "homes", "town", "city", "cities", "county", "state", "area", "areas", "style",
  "styles", "fact", "mind", "touch", "place", "places", "between", "addition", "general", "detail",
  "details", "service", "services", "most", "many", "all", "both", "every", "your", "our", "their",
  "the", "and", "for", "with", "about", "under", "over", "same", "week", "weeks",
  "month", "months", "year", "years", "day", "summer", "winter", "autumn", "fall",
  "homeowners", "customers", "clients", "families", "fifty", "forty", "thirty", "twenty", "today", "now",
  "me", "you", "case", "emergency", "residential", "commercial",
]);
/* A place ends at one of these ("Sacramento County", "Sacramento And Roseville", "Sacramento Since 1990"). */
const PLACE_STOP = new Set(["and", "since", "county", "of", "areas"]);
/*
  Words that start real town names (New Orleans, Old Bridge, Spring Hill)
  but are never a place on their own: refused only as the whole phrase.
*/
const NOT_A_PLACE_ALONE = new Set(["new", "old", "spring"]);

export function focusPlacesNotInIntake(home: ImportedPageSummary | null | undefined, data: IntakeData): string[] {
  if (!home) return [];
  const text = [...(home.h1s ?? []), home.title ?? "", home.metaDescription ?? ""].join(" . ");
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  /* Everywhere the intake already names, and the business itself: none of this is news. */
  const known = [
    ...data.serviceAreas.cities,
    ...data.serviceAreas.counties,
    data.business.city,
    data.business.state,
    data.business.name,
    data.business.legalName,
    ...US_STATES.flatMap(([code, name]) => [code, name]),
    ...data.serviceAreas.states.map((code) => US_STATES.find(([c]) => c === code)?.[1] ?? code),
  ]
    .map((value) => norm(value ?? ""))
    .filter(Boolean);
  const out: string[] = [];
  for (const match of text.matchAll(PLACE_LEAD)) {
    /*
      Cut at the first stop word ("Sacramento County", "Sacramento And
      Roseville", "Sacramento Since 1990" give "Sacramento"); nothing before
      it means no candidate. The cut is on the joined text, so the original
      separators ("Spring-Hill") are kept.
    */
    const parts = match[1]!.trim().split(/([\s-]+)/);
    const stopAt = parts.findIndex((part, i) => i % 2 === 0 && PLACE_STOP.has(part.toLowerCase()));
    const found = (stopAt >= 0 ? parts.slice(0, stopAt).join("") : parts.join("")).replace(/[\s-]+$/, "");
    if (!found) continue;
    const words = found.split(/[\s-]+/);
    if (words.some((word) => !/^[A-Z]/.test(word) || NOT_A_PLACE.has(word.toLowerCase()))) continue;
    if (words.length === 1 && NOT_A_PLACE_ALONE.has(words[0]!.toLowerCase())) continue;
    // A phrase that is a state's whole name ("West Virginia", "New Mexico") is no town and is not cut down to its last word.
    const isState = (text: string) => US_STATES.some(([code, name]) => text === code || text.toLowerCase() === name.toLowerCase());
    if (isState(words.join(" "))) continue;
    /*
      A state after the town ("Sacramento CA") is taken off first. Every
      state is in `known`, so left on, the state alone made the town look
      known and the note never appeared (12 November 2026, CodeRabbit on
      PR #75).
    */
    const lastTwo = words.slice(-2).join(" ");
    const last = words.at(-1)!;
    const tail = words.length > 2 && isState(lastTwo) ? lastTwo : words.length > 1 && isState(last) ? last : "";
    const phrase = tail ? found.slice(0, found.length - tail.length).replace(/[\s-]+$/, "") : found;
    const key = norm(phrase);
    /*
      Whole words, never substrings. "Sacramento" counts as known against a
      listed "West Sacramento", and "Placer County" against "Placer" - but
      a substring test also made "Sacramento" known because it contains
      "me", Maine's state code, so the note never appeared. The test for
      this change caught that before it shipped.
    */
    const inWords = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);
    if (!key || known.some((place) => place === key || inWords(place, key) || inWords(key, place))) continue;
    if (!out.some((seen) => norm(seen) === key)) out.push(phrase);
    if (out.length === 3) break;
  }
  return out;
}

/*
  What the read proves, checked against the intake as it is now: the
  empty fields to fill (never one in `corrected`, a field the team changed
  after it was filled), and lines for what was found but not filled.
*/
export function planSitePrefill(data: IntakeData, pages: ImportedPageSummary[], corrected: Set<string> = new Set(), home: SiteHome | null = null): SitePrefillPlan {
  const fill: SitePrefillProposal[] = [];
  const notes: string[] = [];
  const open = (key: PrefillKey, empty: boolean) => empty && !corrected.has(key);

  const phone = mainPhone(pages);
  if (phone && "phone" in phone) {
    // A number nobody could dial as a US number ("tel:9165550142,123", a UK number) is never filled in: the save would refuse it and take every other prefill down with it (B5 review, M3).
    if (open("business.phone", !data.business.phone.trim()) && phoneProblem(phone.phone)) notes.push(`The site shows ${phone.phone}, which isn't a US number TAWD can dial: the phone wasn't filled in.`);
    else if (open("business.phone", !data.business.phone.trim())) fill.push({ key: "business.phone", value: phone.phone, from: phone.from });
    else if (data.business.phone.trim() && phoneKey(data.business.phone) !== phoneKey(phone.phone)) notes.push(`The site shows ${phone.phone}; the intake says ${data.business.phone}: the intake's stays.`);
  } else if (phone && "ambiguous" in phone && !data.business.phone.trim()) {
    notes.push(`The site shows more than one main number (${phone.ambiguous.slice(0, 3).join(", ")}): the phone wasn't filled in. Check which is the business's.`);
  }

  const email = mainEmail(pages);
  if (email && "email" in email) {
    if (open("business.email", !data.business.email.trim())) fill.push({ key: "business.email", value: email.email, from: email.from });
    else if (data.business.email.trim() && !same(data.business.email, email.email)) notes.push(`The site shows ${email.email}; the intake says ${data.business.email}: the intake's stays.`);
  } else if (email && "ambiguous" in email && !data.business.email.trim()) {
    notes.push(`The site shows more than one email (${email.ambiguous.slice(0, 3).join(", ")}): the email wasn't filled in.`);
  }

  const address = mainAddress(pages);
  if (address && "address" in address) {
    const parts = [
      ["business.streetAddress", data.business.streetAddress, address.address.streetAddress],
      ["business.city", data.business.city, address.address.city],
      ["business.state", data.business.state, address.address.state],
    ] as const;
    // An intake address that differs from the site's: nothing of the site's is mixed into it.
    const differs = parts.some(([, typed, found]) => typed.trim() && found && !sameAddressPart(typed, found));
    if (differs) notes.push(`The site's address is ${parts.map(([, , f]) => f).filter(Boolean).join(", ")}; the intake's differs: the intake's stays.`);
    else for (const [key, typed, found] of parts) if (found && open(key, !typed.trim())) fill.push({ key, value: found, from: address.from });
  } else if (address && "ambiguous" in address && !data.business.streetAddress.trim()) {
    notes.push(`The site lists more than one address (${address.ambiguous.slice(0, 3).join("; ")}): the address wasn't filled in.`);
  }

  const read = readPages(pages);
  const services = [...new Map(read.filter((p) => p.kind === "service").map((p) => [plain(p.name).toLowerCase(), plain(p.name)])).values()].filter(Boolean).slice(0, 50);
  if (services.length && open("services.items", data.services.items.length === 0)) {
    fill.push({ key: "services.items", value: services.map((name) => ({ name, description: "" })), from: read.find((p) => p.kind === "service")!.url });
  }

  const townsMode = data.serviceAreas.scope === null || data.serviceAreas.scope === "cities";
  const towns = [...new Map(read.filter((p) => p.kind === "city").flatMap((p) => (townOf(p) ? [[townOf(p)!.toLowerCase(), townOf(p)!] as const] : []))).values()].slice(0, 50);
  if (townsMode && towns.length && open("serviceAreas.cities", data.serviceAreas.cities.length === 0)) {
    fill.push({ key: "serviceAreas.cities", value: towns, from: read.find((p) => p.kind === "city")!.url });
  }

  // #1b: warranty, offer and financing facts the home page states in words.
  const homeUrl = read.find((p) => p.path === "/")?.url ?? read[0]?.url ?? "";
  const factEmpty = (key: PrefillKey): boolean =>
    key === "process.guarantees" ? !data.process.guarantees.trim()
    : key === "extras.currentOffers" ? !data.extras.currentOffers.trim()
    : key === "extras.financingAvailable" ? data.extras.financingAvailable === null
    : false;
  for (const fact of statedSiteFacts(home, homeUrl)) {
    if (open(fact.key, factEmpty(fact.key))) fill.push(fact);
  }

  /*
    A town the site's own home page names that the service areas don't
    list: a line for the team, never a change to their list. It says the
    page MENTIONS the place, because that is all the code knows ("We do not
    serve Sacramento" names Sacramento too - 12 November 2026, CodeRabbit
    on PR #75).
  */
  const homeSummary = read.find((p) => p.kind === "home") ?? read.find((p) => p.path === "/");
  for (const place of focusPlacesNotInIntake(homeSummary, data)) {
    notes.push(
      `The site's home page mentions ${place} in its title, main heading or description, and it isn't in the service areas: if the client serves it, add it, or the new pages will target somewhere else. The intake's list stays as it is.`,
    );
  }
  return { fill, notes };
}
