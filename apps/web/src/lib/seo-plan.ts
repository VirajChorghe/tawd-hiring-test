import { groupServices } from "@tawd/core/content";
import type { Tier, Trade } from "@tawd/core/enums";
import { US_STATES, scopeOf, type ServiceAreaInput } from "@tawd/core/intake";
import { isHomeLabel } from "@tawd/core/supplied-nav";

/*
  SEO and content, 7a (26 September 2026): the rules, with no database and
  no network, so they can be read and tested on their own.

  1. Which keywords to look up, and where: every service in every service
     area, for all four area scopes (cities, whole states, nationwide, a
     radius around an address). No AI: the candidates are built from the
     intake's own words.
  2. The first draft of the page plan: the tier's page list, each page
     with a main keyword, supporting keywords, a title, a meta description
     and an H1. The team edits it from there.
*/

export const COUNTRY = "United States";
/** Keywords looked up per research run at most; a Starter site needs far fewer. */
export const MAX_KEYWORDS = 400;

const STATE_BY_CODE = new Map<string, string>(US_STATES.map(([code, name]) => [code, name]));
const STATE_BY_NAME = new Map<string, string>(US_STATES.map(([, name]) => [name.toLowerCase(), name]));

/* "NV", "Nevada" or "nevada" to "Nevada"; null when it isn't a US state. */
export function stateName(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return STATE_BY_CODE.get(text.toUpperCase()) ?? STATE_BY_NAME.get(text.toLowerCase()) ?? null;
}

/* DataForSEO's name for a place: "Nevada,United States", or "United States". */
export function placeFor(state: string | null): string {
  return state ? `${state},${COUNTRY}` : COUNTRY;
}

/*
  A county as DataForSEO (and Google Ads) name it: "Washoe County,Nevada,United
  States". "Washoe, NV" gains "County"; a parish, borough or census area keeps
  its own word. Without a state the county can't be named, so its state's (or
  the country's) figures are used.
*/
export function countyArea(text: string, fallbackState: string | null): { name: string; place: string } {
  const { city, state } = splitCity(text, fallbackState);
  const name = /\b(county|parish|borough|census area|municipality)$/i.test(city) ? city : `${city} County`;
  return { name, place: state ? `${name},${state},${COUNTRY}` : COUNTRY };
}

/* What a person searching for the trade itself types, when the trade has one. */
const TRADE_TERMS: Partial<Record<Trade, string>> = {
  plumbing: "plumber",
  hvac: "hvac repair",
  electrical: "electrician",
  roofing: "roofer",
  legal: "lawyer",
  glass_and_windows: "window repair",
  garage_doors: "garage door repair",
  well_and_pump: "well pump repair",
  home_services: "handyman",
  pest_control: "pest control",
  med_spa: "med spa",
  interior_design: "interior designer",
  art_decorative_finishes: "decorative painter",
  photography: "photographer",
  architecture_remodeling: "remodeling contractor",
};

export function tradeTerm(trade: Trade): string | null {
  return TRADE_TERMS[trade] ?? null;
}

/* Lower case, plain words, one space: how keywords are looked up and cached. */
export function normalizeKeyword(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

/* "Reno, NV" or "Reno NV" to a city and its state; the business's state when none is written. */
export function splitCity(text: string, fallbackState: string | null): { city: string; state: string | null } {
  const match = /^(.*?)[,\s]+([A-Za-z]{2}|[A-Za-z][A-Za-z ]+)$/.exec(text.trim());
  if (match) {
    const state = stateName(match[2]);
    if (state && match[1]!.trim()) return { city: match[1]!.trim(), state };
  }
  return { city: text.trim(), state: fallbackState };
}

/*
  The city at the middle of a radius, from its address: "4105 Kietzke Ln,
  Reno, NV 89502" is Reno, Nevada. Null when the address doesn't say.
*/
export function radiusCenter(address: string, fallbackState: string | null): { city: string; state: string | null } | null {
  const parts = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts.at(-1)!.replace(/\b\d{5}(-\d{4})?\b/, "").trim();
  const state = stateName(last);
  if (state) {
    const city = parts.at(-2)!;
    return /\d/.test(city) ? null : { city, state };
  }
  const city = parts.at(-1)!;
  return /\d/.test(city) ? null : { city, state: fallbackState };
}

export interface KeywordCandidate {
  keyword: string;
  /** The intake service it was made from; null for the trade itself. */
  service: string | null;
  /** The city, state or country, as the team reads it. */
  area: string;
}

export interface KeywordGroup {
  /** Where DataForSEO measures the searches. */
  place: string;
  keywords: KeywordCandidate[];
}

export interface KeywordPlanInput {
  trade: Trade;
  /** Service names, the main service first. */
  services: string[];
  areas: ServiceAreaInput;
  /** The business's own state (intake, Business), for cities written without one. */
  businessState: string | null;
}

/* The areas the keywords are made for, whatever the scope. */
export function keywordAreas(input: KeywordPlanInput): { kind: "city" | "county" | "state" | "dma" | "country"; name: string; place: string }[] {
  const home = stateName(input.businessState);
  switch (scopeOf(input.areas)) {
    case "counties":
      return (input.areas.counties ?? []).map((text) => ({ kind: "county" as const, ...countyArea(text, home) }));
    case "dmas":
      // A DMA is measured as the market Google knows; its name is never put in the words.
      return (input.areas.dmas ?? []).map((dma) => ({ kind: "dma" as const, name: `${dma.name} area`, place: dma.canonical }));
    case "cities":
      return input.areas.cities.map((text) => {
        const { city, state } = splitCity(text, home);
        return { kind: "city" as const, name: city, place: placeFor(state) };
      });
    case "states":
      return input.areas.states.flatMap((code) => {
        const name = stateName(code);
        return name ? [{ kind: "state" as const, name, place: placeFor(name) }] : [];
      });
    case "nationwide":
      return [{ kind: "country", name: COUNTRY, place: COUNTRY }];
    case "radius": {
      const center = radiusCenter(input.areas.radius.address, home);
      return center ? [{ kind: "city", name: center.city, place: placeFor(center.state) }] : [];
    }
  }
}

/*
  Every service in every area. A city goes into the words ("drain cleaning
  reno"), measured across its state; a state or the country is where the
  plain words and "near me" are measured. The trade's own term is added
  the same way. Grouped by place, one lookup each; capped at MAX_KEYWORDS.
*/
export function keywordPlan(input: KeywordPlanInput): KeywordGroup[] {
  const services = input.services.map((s) => s.trim()).filter(Boolean);
  const term = tradeTerm(input.trade);
  const topics: { words: string; service: string | null }[] = [
    ...services.map((s) => ({ words: s, service: s })),
    ...(term ? [{ words: term, service: null }] : []),
  ];

  const groups = new Map<string, KeywordGroup>();
  const seen = new Set<string>();
  let total = 0;
  const add = (place: string, candidate: KeywordCandidate) => {
    const keyword = normalizeKeyword(candidate.keyword);
    if (!keyword || total >= MAX_KEYWORDS || seen.has(`${place}|${keyword}`)) return;
    seen.add(`${place}|${keyword}`);
    total += 1;
    if (!groups.has(place)) groups.set(place, { place, keywords: [] });
    groups.get(place)!.keywords.push({ ...candidate, keyword });
  };

  const areas = keywordAreas(input);
  // Main service first across every area, so a cap cuts the least important.
  for (const topic of topics) {
    for (const area of areas) {
      if (area.kind === "city" || area.kind === "county") {
        add(area.place, { keyword: `${topic.words} ${area.name}`, service: topic.service, area: area.name });
        add(area.place, { keyword: `${topic.words} near me`, service: topic.service, area: area.kind === "county" ? area.name : area.place.split(",")[0]! });
      } else {
        add(area.place, { keyword: topic.words, service: topic.service, area: area.name });
        add(area.place, { keyword: `${topic.words} near me`, service: topic.service, area: area.name });
      }
    }
  }
  return [...groups.values()];
}

/* ---------- the estimate ---------- */

/*
  DataForSEO's list prices as TAWD understands them (26 September 2026;
  check dataforseo.com/pricing before switching live calls on): Google Ads
  search volume costs about $0.075 a request of up to 1,000 keywords, and
  DataForSEO Labs keyword difficulty about $0.01 a request plus $0.0001 a
  keyword. The ledger records what DataForSEO actually charges.
*/
export const PRICES = { volumePerRequest: 0.075, difficultyPerRequest: 0.01, difficultyPerKeyword: 0.0001 };

export function estimateLookups(groups: { place: string; uncached: number }[], uncachedDifficulty: number): number {
  const volume = groups.reduce((sum, g) => sum + (g.uncached > 0 ? Math.ceil(g.uncached / 1000) * PRICES.volumePerRequest : 0), 0);
  const difficulty = uncachedDifficulty > 0 ? Math.ceil(uncachedDifficulty / 1000) * PRICES.difficultyPerRequest + uncachedDifficulty * PRICES.difficultyPerKeyword : 0;
  return Math.round((volume + difficulty) * 10000) / 10000;
}

/* ---------- the page plan ---------- */

export const TIER_MAX_PAGES: Record<Tier, number> = { starter: 10, growth: 20, pro: 50 };
export const PAGE_KINDS = ["home", "about", "contact", "service", "hub", "service_areas", "city", "faq", "reviews", "pricing", "blog", "article", "other"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  home: "Home",
  about: "About",
  contact: "Contact",
  service: "Service",
  hub: "Service hub",
  service_areas: "Service areas",
  city: "City page",
  faq: "FAQ",
  reviews: "Reviews",
  // Keep the current site (6 October 2026): a pricing or specials page, the blog page and its articles.
  pricing: "Pricing",
  blog: "Blog",
  article: "Article",
  other: "Other",
};

export const TITLE_LIMIT = 60;
export const META_LIMIT = 155;

export interface MeasuredKeyword {
  keyword: string;
  service: string | null;
  area: string;
  searchVolume: number | null;
  difficulty: number | null;
}

export interface PlannedPage {
  kind: PageKind;
  name: string;
  slug: string;
  mainKeyword: string;
  supportingKeywords: string[];
  title: string;
  metaDescription: string;
  h1: string;
  /** The hub a detailed page belongs to (its slug); null when none. */
  parentSlug?: string | null;
}

export interface PagePlanInput {
  tier: Tier;
  trade: Trade;
  businessName: string;
  services: string[];
  areas: ServiceAreaInput & { wantsIndividualCityPages: boolean | null };
  businessState: string | null;
  /** The latest keyword research; empty when none has run (the plan still works, with unmeasured keywords). */
  keywords: MeasuredKeyword[];
  /** The city the business is based in: it leads the titles, H1s and keywords whatever the service area's scope (audit F-025, 13 November 2026), unless a makeover's current site focuses on another served city. */
  businessCity?: string | null;
  /** The crawled current site's home H1/title/meta (#4): a makeover's primary city follows its SEO focus. Absent for a project with no current site. */
  siteHome?: SiteFocusText | null;
  /*
    Whether the intake has anything true to say on an About page and a FAQ
    page (8 October 2026: both were always planned). Absent: both planned,
    as before.
  */
  pageFacts?: { about: boolean; faq: boolean };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "page"
  );
}

/* A page's address with folders ("blog/a-post"): each part slugified, at most 3 deep. */
export function slugPath(text: string): string {
  const parts = text
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map(slugify);
  return parts.length ? parts.join("/") : "page";
}

/* Short enough for search results: cut at a word, never mid-word, and never adding "...". */
export function fitTo(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit + 1);
  const at = cut.lastIndexOf(" ");
  return (at > limit * 0.6 ? cut.slice(0, at) : clean.slice(0, limit)).replace(/[\s,;:|-]+$/, "");
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/*
  A makeover's primary city follows the current site's SEO focus, not the intake address (#4,
  7 November 2026: New Dawn's site is "Patio Covers in Sacramento" but its shop address is Fair Oaks;
  the plan was flipping the money city to Fair Oaks). Among the cities the business actually serves
  (the candidates — never a new one, so a real focus is honoured but nothing is invented), this picks
  the one most prominent in the crawled home's H1 (weighted highest), then its <title>, then its meta.
  Returns null when none of the served cities appears there, so the intake order is kept as the fallback.
*/
export interface SiteFocusText {
  h1s: string[];
  title: string;
  metaDescription: string;
}
export function dominantSiteCity(home: SiteFocusText | null | undefined, candidateCities: string[]): string | null {
  if (!home) return null;
  // Whole-word match with no dynamic RegExp (the city names are user-entered — a built regex would be a
  // ReDoS/injection surface): collapse each text to space-delimited lowercase words and test membership.
  const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const h1 = words(home.h1s.join(" "));
  const title = words(home.title ?? "");
  const meta = words(home.metaDescription ?? "");
  const hit = (city: string, text: string) => {
    const c = words(city);
    return c.trim().length > 0 && text.includes(c);
  };
  let best: { city: string; score: number } | null = null;
  for (const raw of candidateCities) {
    const city = raw.trim();
    if (!city) continue;
    const score = (hit(city, h1) ? 3 : 0) + (hit(city, title) ? 2 : 0) + (hit(city, meta) ? 1 : 0);
    // On a tie, a longer candidate that contains the shorter one wins: "West Sacramento" in the
    // H1 also scores "Sacramento" (its words contain it), and the site means the specific city.
    const moreSpecific = best !== null && score === best.score && words(city).includes(words(best.city));
    if (score > 0 && (!best || score > best.score || moreSpecific)) best = { city, score };
  }
  return best?.city ?? null;
}

/* "Title | Business", dropping the business name before cutting the title. */
function titleWith(main: string, business: string): string {
  const full = `${main} | ${business}`;
  return full.length <= TITLE_LIMIT ? full : fitTo(main, TITLE_LIMIT);
}

/* Best first: most searched, then easiest; unmeasured last. */
function ranked(list: MeasuredKeyword[]): MeasuredKeyword[] {
  return [...list].sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1) || (a.difficulty ?? 101) - (b.difficulty ?? 101) || a.keyword.localeCompare(b.keyword));
}

function keywordsFor(all: MeasuredKeyword[], fallback: string[], match: (k: MeasuredKeyword) => boolean): { main: string; supporting: string[] } {
  const found = ranked(all.filter(match)).map((k) => k.keyword);
  const list = [...new Set([...found, ...fallback.map(normalizeKeyword)])].filter(Boolean);
  return { main: list[0] ?? "", supporting: list.slice(1, 5) };
}

/*
  The first draft: Home, About, Contact, the services the tier allows, one
  Service Areas page (or, on Growth and Pro with city pages asked for, a
  page per city), and an FAQ. Starter keeps to its 10 pages by listing at
  most 5 services (TAWD-PROFILE section 1). Missing facts stay visible as
  [PLACEHOLDER: ...] rather than being made up.
*/
export function draftPagePlan(input: PagePlanInput): PlannedPage[] {
  const business = input.businessName.trim() || "[PLACEHOLDER: business name]";
  const services = input.services.map((s) => s.trim()).filter(Boolean);
  const areas = keywordAreas(input);
  /*
    The business's own city, city part only ("Fair Oaks, CA" -> "Fair Oaks"); null when blank or a
    [PLACEHOLDER...] string. Local searches are by city, so it leads the titles, H1s and keywords
    (Sample Plumbing Co., 8 October 2026: every title said "in California"; audit F-025,
    13 November 2026: a Fair Oaks business listing "Lincoln, Fair Oaks" had every title "in Lincoln").
  */
  const ownCity = (input.businessCity ?? "").trim().replace(/,.*$/, "").trim();
  const baseCity = ownCity && !/^\[?\s*placeholder/i.test(ownCity) ? ownCity : null;
  // #4: a makeover follows the current site's SEO focus. Candidates are the cities the business serves
  // plus its base city, so a real focus wins but no new city is invented. Only city areas count: a
  // state, county, DMA or country name on the home page must never override a base city (a statewide
  // plan stays "Plumber in Sacramento", not "Plumber in California").
  const focusCity = dominantSiteCity(input.siteHome, [...areas.filter((a) => a.kind === "city").map((a) => a.name), ...(baseCity ? [baseCity] : [])]);
  // Order: the current site's focus city (makeovers), then the business's own city, and only when there
  // is none the first service area (the country reads "the USA"; no area at all is a visible placeholder).
  const mainArea = focusCity ?? baseCity ?? (areas[0]?.name === COUNTRY ? "the USA" : (areas[0]?.name ?? "[PLACEHOLDER: service area]"));
  /*
    A page's keyword never names a different place from its title (Fable's review of F-025): a
    measured keyword whose words name another served city or county ("plumber lincoln") never leads a
    page titled "Plumber in Fair Oaks". It is judged by its words, not by which lookup it came from:
    a county's "plumber near me" names no place and still counts, and so do a state's or the
    country's plain words. Names are compared as keywords are (lower case, punctuation as spaces), so
    "fair oaks" typed in the areas is the main city "Fair Oaks". When the main city was not measured,
    the page keeps the unmeasured "plumber fair oaks" rather than borrowing another city's numbers.
    City and county pages keep their own place's keywords.
  */
  const mainName = normalizeKeyword(mainArea);
  const elsewhere = [...new Set(areas.filter((a) => a.kind === "city" || a.kind === "county").map((a) => normalizeKeyword(a.name)))].filter((n) => n && n !== mainName);
  /*
    Read word by word; at each word the longest place name that starts there is taken, so "west
    sacramento" is West Sacramento (not Sacramento), and "fair oaks" is Fair Oaks (not Oaks).
  */
  const places = [mainName, ...elsewhere].map((name) => name.split(" ")).sort((a, b) => b.length - a.length);
  const forMainArea = (k: MeasuredKeyword) => {
    const words = normalizeKeyword(k.keyword).split(" ");
    let i = 0;
    while (i < words.length) {
      const place = places.find((p) => p.every((w, n) => words[i + n] === w));
      if (!place) {
        i += 1;
        continue;
      }
      if (place.join(" ") !== mainName) return false;
      i += place.length;
    }
    return true;
  };
  const term = tradeTerm(input.trade);
  const mainService = services[0] ?? (term ? capitalize(term) : "[PLACEHOLDER: main service]");
  const maxServices = input.tier === "starter" ? 5 : input.tier === "growth" ? 10 : 20;
  // A page per city, or per county (Todd's request: county pages count toward the tier like city pages).
  const cityPages = input.tier !== "starter" && input.areas.wantsIndividualCityPages === true && (scopeOf(input.areas) === "cities" || scopeOf(input.areas) === "counties");
  const inArea = (thing: string, area = mainArea) => `${thing} in ${area}`;
  const pages: PlannedPage[] = [];

  const push = (page: Omit<PlannedPage, "slug" | "title" | "metaDescription"> & { titleMain: string; meta: string; slug?: string }) => {
    pages.push({
      parentSlug: page.parentSlug ?? null,
      kind: page.kind,
      name: page.name,
      slug: page.slug ?? slugify(page.name),
      mainKeyword: page.mainKeyword,
      supportingKeywords: page.supportingKeywords,
      h1: page.h1,
      title: titleWith(page.titleMain, business),
      metaDescription: fitTo(page.meta, META_LIMIT),
    });
  };

  /*
    Home targets the trade and the place ("plumber in Sacramento"), never
    one service (8 October 2026: the official run's Home became "Drain
    cleaning in California" from the first service and a sandbox keyword).
  */
  const homeTopic = term ?? mainService;
  const home = keywordsFor(input.keywords, [`${homeTopic} ${mainArea}`], (k) => k.service === null && forMainArea(k));
  push({
    kind: "home",
    name: "Home",
    slug: "",
    mainKeyword: home.main,
    supportingKeywords: home.supporting,
    h1: inArea(capitalize(homeTopic)),
    titleMain: inArea(capitalize(homeTopic)),
    meta: `${business}: ${services.length > 1 ? services.slice(0, 3).join(", ").toLowerCase() : mainService.toLowerCase()} in ${mainArea}. Call or send a message to book.`,
  });

  /*
    The hub rule (Jason, 28 September 2026): 3 or more services in one of
    the trade playbook's families get a hub page that targets the family's
    broad term and links to them; each keeps its own page and keyword.
    True duplicates (the same search intent) become one page, the other
    name kept as a supporting keyword.
  */
  const grouped = groupServices(services.slice(0, maxServices), input.trade);
  const folded = new Map(grouped.duplicates.map((d) => [d.kept, d.folded]));
  const serviceSlugs = new Set(grouped.kept.map(slugify));
  const hubSlug = (hub: string) => (serviceSlugs.has(slugify(hub)) ? slugify(`${hub} services`) : slugify(hub));
  const pushService = (service: string, parentSlug: string | null) => {
    const k = keywordsFor(input.keywords, [`${service} ${mainArea}`, ...(folded.get(service) ?? []).map((f) => `${f} ${mainArea}`)], (m) => m.service === service && forMainArea(m));
    push({
      kind: "service",
      name: service,
      mainKeyword: k.main,
      supportingKeywords: k.supporting,
      h1: inArea(service),
      titleMain: inArea(service),
      meta: `${service} in ${mainArea} from ${business}. Call or send a message to book.`,
      parentSlug,
    });
  };
  const placed = new Set<string>();
  for (const service of grouped.kept) {
    if (placed.has(service)) continue;
    const hub = grouped.hubs.find((h) => h.services.includes(service));
    if (!hub) {
      pushService(service, null);
      placed.add(service);
      continue;
    }
    const slug = hubSlug(hub.family.hub);
    const k = keywordsFor(input.keywords, [`${hub.family.broad} ${mainArea}`], (m) => m.service !== null && hub.services.includes(m.service) && m.keyword.includes(normalizeKeyword(hub.family.broad)) && forMainArea(m));
    push({
      kind: "hub",
      name: hub.family.hub,
      slug,
      mainKeyword: k.main,
      supportingKeywords: k.supporting,
      h1: inArea(hub.family.hub),
      titleMain: inArea(hub.family.hub),
      meta: `${hub.family.hub} in ${mainArea} from ${business}: ${hub.services.join(", ").toLowerCase()}.`,
    });
    for (const member of hub.services) {
      pushService(member, slug);
      placed.add(member);
    }
  }

  if (cityPages) {
    for (const area of areas.slice(0, input.tier === "growth" ? 8 : 25)) {
      const k = keywordsFor(input.keywords, [`${mainService} ${area.name}`], (m) => m.area === area.name && m.keyword.includes(normalizeKeyword(area.name)));
      push({
        kind: "city",
        name: area.name,
        mainKeyword: k.main,
        supportingKeywords: k.supporting,
        h1: inArea(capitalize(mainService), area.name),
        titleMain: inArea(capitalize(mainService), area.name),
        meta: `${capitalize(mainService)} in ${area.name} from ${business}. Call or send a message to book.`,
      });
    }
  } else if (areas.length) {
    // Jason, 1 October 2026: a Service areas page only when the intake lists service areas.
    push({
      kind: "service_areas",
      name: "Service areas",
      mainKeyword: home.supporting.find((k) => areas.some((a) => k.includes(normalizeKeyword(a.name)))) ?? "",
      supportingKeywords: [],
      h1: "Areas we serve",
      titleMain: "Areas we serve",
      meta: `Where ${business} works: ${areas.map((a) => (a.name === COUNTRY ? "across the USA" : a.name)).join(", ") || "[PLACEHOLDER: service area]"}.`,
    });
  }

  if (input.pageFacts?.about ?? true) push({ kind: "about", name: "About", mainKeyword: "", supportingKeywords: [], h1: `About ${business}`, titleMain: "About us", meta: `Who ${business} is and how they work.` });
  if (input.pageFacts?.faq ?? true) push({
    kind: "faq",
    name: "FAQ",
    mainKeyword: "",
    supportingKeywords: [],
    h1: "Frequently asked questions",
    titleMain: `${capitalize(mainService)} questions`,
    meta: `Answers to common questions about ${mainService.toLowerCase()} from ${business}.`,
  });
  push({ kind: "contact", name: "Contact", mainKeyword: "", supportingKeywords: [], h1: `Contact ${business}`, titleMain: "Contact us", meta: `How to reach ${business} in ${mainArea}.` });

  return pages;
}

/*
  Pages with no main keyword (New Dawn Awning's SEO audit, 10 November
  2026, which found this itself): "No page in the plan has a main keyword
  assigned", and so the pages compete with each other and with the
  client's own ranking blog post.

  The plan screen already says "None yet" on each row, which is easy to
  read past when it says it nine times. This says it once, as a number,
  where the tier warning is - and it does not invent a keyword: which
  search a page should win is the SEO team's call, and keyword research is
  the step that answers it.
*/
export function planKeywordWarning(pages: { mainKeyword: string }[]): string | null {
  const missing = pages.filter((page) => !page.mainKeyword.trim()).length;
  if (missing === 0 || pages.length === 0) return null;
  const all = missing === pages.length;
  return `${all ? "No page" : `${missing} of the ${pages.length} pages`} in the plan has a main keyword. Without one TAWD cannot tell which page should win which search, so two pages can end up competing for the same one. Run keyword research, or set the keyword on each page.`;
}

/* The tier check for the plan: a warning only, never a change of tier (that is a PM's conversation with the client). */
export function planTierWarning(pageCount: number, tier: Tier): string | null {
  const max = TIER_MAX_PAGES[tier];
  if (pageCount <= max) return null;
  if (tier === "pro") return `${pageCount} pages: Pro covers up to 50. Remove ${pageCount - 50} or agree a custom price with the client.`;
  const next = pageCount <= 20 ? "Growth" : "Pro";
  return `${pageCount} pages: ${tier === "starter" ? "Starter" : "Growth"} covers up to ${max}. Remove ${pageCount - max}, or talk to the client about ${next}. TAWD won't change the tier.`;
}

/* ---------- the plan a supplied homepage's own menu makes ---------- */

/*
  A homepage supplied as one HTML file (Jason, option A, 17 November 2026):
  the design the client approved carries a menu, and that menu says what
  pages the site has. Its items become real pages, in the order the design
  writes them, and the links in the kept page that pointed at one of its own
  sections point at those pages instead (site-build.ts).

  Before this the plan came from the intake and the keywords alone and never
  looked at the approved design, so Sample Marketing Co.'s design (Services, Our
  Approach, About Sarah, Testimonials, Insights, Contact) was built as a plan
  of Home, Digital Marketing, Service areas, About and Contact, and the
  shared header's menu, which is written from the plan, then disagreed with
  the page kept underneath it.
*/
const NAV_KINDS: [RegExp, PageKind][] = [
  [/\b(contact|get in touch|reach us|enquir|inquir)/i, "contact"],
  [/\b(about|our story|who we are|meet|team|founder)/i, "about"],
  [/\b(testimonial|review|what (our )?clients say|happy clients)/i, "reviews"],
  [/\b(insight|blog|news|article|resource|guide)/i, "blog"],
  [/\b(faq|question)/i, "faq"],
  [/\b(pricing|price|plans?|packages?|rates?)\b/i, "pricing"],
  [/\b(service areas?|areas we serve|locations?|where we work|coverage)/i, "service_areas"],
  [/\b(services?|what we do|our work|solutions?)\b/i, "hub"],
];

/** What kind of page a menu item names, by its words alone (no AI). */
export function navKind(label: string): PageKind {
  for (const [words, kind] of NAV_KINDS) if (words.test(label)) return kind;
  return "other";
}

/*
  The plan the design's menu makes: the Home page exactly as the keywords
  and the intake built it (it is the page being kept), then one page per
  menu item. A menu item whose kind the ordinary plan also made keeps that
  page's keywords, so the SEO work already done is not thrown away; its name
  and its place in the menu come from the design.
*/
export function planFromNav(nav: { label: string; href: string }[], drafted: PlannedPage[], businessName: string): PlannedPage[] {
  if (nav.length === 0) return drafted;
  // Missing information is visible, never a title ending in a bare "|" (CodeRabbit on #107).
  const business = businessName.trim() || "[PLACEHOLDER: business name]";
  const home = drafted.find((p) => p.kind === "home");
  const pages: PlannedPage[] = home ? [home] : [];
  const spare = drafted.filter((p) => p.kind !== "home");
  /*
    Taken already: the home page's own empty slug, and the pages every site
    gets whether the menu names them or not. A menu item called "Privacy
    Policy" must not plan a page at /privacy/, where the build writes the
    policy it generates itself.
  */
  const taken = new Set<string>([...(home ? [""] : []), "privacy", "cookies"]);
  for (const item of nav) {
    // "Home" in a menu is the page being kept, not a new page of its own.
    if (isHomeLabel(item.label)) continue;
    const kind = navKind(item.label);
    const name = item.label.slice(0, 80);
    let slug = slugify(name);
    for (let n = 2; taken.has(slug); n += 1) slug = `${slugify(name)}-${n}`;
    taken.add(slug);
    // The ordinary plan's page of the same kind, used once: its measured keywords are real work.
    const match = spare.findIndex((p) => p.kind === kind);
    const from = match === -1 ? null : spare.splice(match, 1)[0]!;
    pages.push({
      parentSlug: null,
      kind,
      name,
      slug,
      mainKeyword: from?.mainKeyword ?? "",
      supportingKeywords: from?.supportingKeywords ?? [],
      h1: from?.h1 ?? name,
      title: from?.title ?? fitTo(`${name} | ${business}`, TITLE_LIMIT),
      metaDescription: from?.metaDescription ?? fitTo(`${name} — ${business}.`, META_LIMIT),
    });
  }
  return pages;
}
