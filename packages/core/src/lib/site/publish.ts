/*
  Build A, 8b (26 September 2026): what every built site gets besides its
  pages, all without AI.

  - SEO in each page's head: canonical URL and Open Graph (once the domain
    is known), and LocalBusiness schema on Home and Contact from the intake
    (never a rating or review; a missing required fact is the same visible
    [PLACEHOLDER] the page shows, so the go-live check finds it).
  - robots.txt, sitemap.xml and Netlify's _headers. Before go-live every
    deploy is a preview: robots.txt disallows everything and every file is
    sent with "noindex". Phase 9 switches a site to live.
  - Netlify Forms: every form gets Netlify's attributes, its hidden name
    field, a honeypot and the thank-you page as its action.
  - A custom 404 page and the thank-you page.
  - The go-live checklist (TAWD-PROFILE section 10), run on the built files.
*/

import { pagePath } from "./build";
import { formatUsPhone, phoneHref, schemaPhone } from "../phone";
import { US_STATES, scopeOf, type ServiceAreaInput } from "../intake/service-area";
import { unsupportedClaimsOnSite, type ClaimFacts } from "../mockups/claims";
import { FACT_CHECKS_BLOCK, factIssuesOnSite, type ConfirmedFacts } from "../mockups/confirmed-facts";
import { checkSiteFeatures, type SiteFeature } from "../mockups/site-features";
import { labelledPhotoFrames } from "../mockups/pictures";

const STATE_NAMES = new Map<string, string>(US_STATES.map(([code, name]) => [code, name]));

/*
  The supplied home page's own words back its own facts (Jason, 16 November
  2026, decided with the trade-off told to him: no person checks them). His
  basis: a person wrote and approved those words and answers for them. So
  only words a person SUPPLIED back anything: the words are the supplied
  file's own sections as stored at import (suppliedHomeWords in site-read.ts),
  never the built page as it stands now. A built page can have drifted (a
  client edit asked the AI to "add that we are rated 5 stars", and the AI's
  words carry the kept mark too), and drifted words are not backed.

  A finding is backed when the thing it found is, whole word for whole word,
  in those supplied words. Nothing else is: a finding from the page's header
  or footer (TAWD's own) whose evidence is not also in those words, from its
  structured data or head, or one whose evidence the supplied words do not
  show (a number dialled that the page never shows) is still reported, and so
  is every finding on every other page.

  Why "the finding is in the page's words" and not "add the words to the
  intake's stated text": the checks do not all read stated text (the older
  rating pattern, a reviews band, a street address read only the intake), so
  adding words there would back some findings and leave "Rated 5 stars on
  Google" blocking go-live. Matching the finding's own evidence against the
  words backs them all the same way, and only ever backs what the page shows.

  Matching is by whole token, never by raw substring: "$150" is not backed by
  "$1,150" and "100" is not backed by "555-0100". A price keeps its "$" or
  "%" and loses its thousands commas, so "$49" is one token and "$1,150" is
  "$1150". Evidence of fewer than 3 letters and digits is trivial ("5") and is
  never backed, with one exception: a price or percentage ("$49", "5%", "$20
  off") is specific enough on its own, and these are the commonest short
  facts a trades page states.
*/
const squashed = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const TOKEN = /\$?\d[\d,]*(?:\.\d+)?%?|[a-z0-9]+/g;
const tokensOf = (value: string) => (value.toLowerCase().match(TOKEN) ?? []).map((t) => t.replace(/,/g, ""));
const PRICE_TOKEN = /^\$\d|\d%$/;
// A phone number as a person writes it: ten digits (an optional leading 1), not part of a longer run of digits.
const PHONE_SHAPE = /(?<!\d)(?:\+?1[\s.\-–]*)?\(?\d{3}\)?[\s.\-–]*\d{3}[\s.\-–]*\d{4}(?!\d)/g;
const lastTen = (value: string) => value.replace(/\D+/g, "").slice(-10);
/*
  Is this run of words somewhere in that run of words? Both sides are the
  visible text of a web page - a price, a rating, a sentence a visitor reads -
  so there is no secret here and nothing an attacker could learn from how long
  the comparison takes. Semgrep's timing-attack rule reads any `===` between
  strings as a password check, which this is not.
*/
function hasRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack
  for (let i = 0; i + needle.length <= haystack.length; i += 1) if (needle.every((token, n) => haystack[i + n] === token)) return true;
  return false;
}
export function backedByOwnWords(evidence: string, words: string): boolean {
  const needle = tokensOf(evidence);
  // Too short to be proof the page said it ("5", "$"): left reported, unless it is a price or a percentage.
  if (squashed(evidence).length < 3 && !needle.some((t) => PRICE_TOKEN.test(t))) return false;
  if (hasRun(tokensOf(words), needle)) return true;
  // A dialled number, "+1 916-555-0100", against a number the page shows, "(916) 555-0100": each shown number on its own, never digits joined across two.
  const digits = evidence.replace(/\D+/g, "");
  if (digits.length < 10) return false;
  return (words.match(PHONE_SHAPE) ?? []).some((shown) => lastTen(shown) === digits.slice(-10));
}

/* schema.org areaServed from the intake's service-area scope. */
export function areaServedFrom(areas: ServiceAreaInput): BusinessFacts["areaServed"] {
  switch (scopeOf(areas)) {
    case "cities":
      return areas.cities.map((c) => ({ type: "City" as const, name: c.trim() })).filter((c) => c.name);
    case "counties":
      return (areas.counties ?? []).map((c) => ({ type: "AdministrativeArea" as const, name: c.trim() })).filter((c) => c.name);
    case "dmas":
      return (areas.dmas ?? []).map((d) => ({ type: "AdministrativeArea" as const, name: `${d.name} area` }));
    case "states":
      return areas.states.map((code) => ({ type: "State" as const, name: STATE_NAMES.get(code) ?? code }));
    case "nationwide":
      return [{ type: "Country", name: "United States" }];
    case "radius": {
      const parts = areas.radius.address.split(",").map((p) => p.trim()).filter(Boolean);
      const city = parts.length >= 2 ? parts.at(-2)! : "";
      return city && !/\d/.test(city) ? [{ type: "City", name: city }] : [];
    }
  }
}

export type SiteMode = "preview" | "live";

export interface BusinessFacts {
  name: string;
  phone: string;
  email: string;
  streetAddress: string;
  city: string;
  state: string;
  isServiceAreaBusiness: boolean;
  /** "example.com", when known; canonical URLs, Open Graph URLs and the sitemap wait for it. */
  domain: string | null;
  trade: string;
  /** areaServed: cities, counties and DMAs (AdministrativeArea), states or the country, from the intake's service-area scope. */
  areaServed: { type: "City" | "State" | "Country" | "AdministrativeArea"; name: string }[];
  logoPath: string | null;
  /** The picture shared on social sites: a photo (Facebook and others don't show SVG), else the logo when it isn't SVG (8 October 2026). */
  shareImagePath?: string | null;
  /** The intake's opening hours, as typed ("7:00 AM"); written into the structured data where they can be read (F-044). */
  hours?: { day: string; closed: boolean; open: string; close: string }[];
}

/* "7:00 AM", "7am", "5 pm", "17:00" → "07:00" / "17:00"; null when it isn't a clock time (never guessed). */
function clockTime(text: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i.exec(text.trim()) ?? /^(\d{1,2}):(\d{2})()$/.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const meridiem = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/*
  schema.org openingHoursSpecification from the intake's hours: one entry per
  open day whose opening and closing times both read as clock times. Closed
  days and anything unreadable are left out, never guessed.
*/
export function openingHoursSpecification(hours: BusinessFacts["hours"]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const row of hours ?? []) {
    if (row.closed) continue;
    const opens = clockTime(row.open);
    const closes = clockTime(row.close);
    if (!opens || !closes || !row.day) continue;
    out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: row.day.charAt(0).toUpperCase() + row.day.slice(1).toLowerCase(), opens, closes });
  }
  return out;
}

const SCHEMA_TYPES: Record<string, string> = {
  plumbing: "Plumber",
  hvac: "HVACBusiness",
  electrical: "Electrician",
  roofing: "RoofingContractor",
  legal: "LegalService",
  glass_and_windows: "HomeAndConstructionBusiness",
  garage_doors: "HomeAndConstructionBusiness",
  well_and_pump: "HomeAndConstructionBusiness",
  home_services: "HomeAndConstructionBusiness",
  pest_control: "HomeAndConstructionBusiness",
  med_spa: "MedicalBusiness",
  interior_design: "ProfessionalService",
  art_decorative_finishes: "ProfessionalService",
  photography: "ProfessionalService",
  architecture_remodeling: "GeneralContractor",
};

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function siteUrl(domain: string | null, path: string): string | null {
  if (!domain) return null;
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return host ? `https://${host}${path}` : null;
}

/*
  The business as schema.org sees it. No aggregateRating, no review, ever:
  a business's own review markup is against the house rules unless the
  reviews are real, and TAWD does not add it either way.
*/
export function localBusinessSchema(facts: BusinessFacts): Record<string, unknown> {
  const missing = (what: string) => `[PLACEHOLDER: ${what}]`;
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPES[facts.trade] ?? "LocalBusiness",
    name: facts.name.trim() || missing("business name"),
    telephone: schemaPhone(facts.phone) || missing("phone number"),
  };
  const url = siteUrl(facts.domain, "/");
  if (url) schema.url = url;
  if (facts.email.trim()) schema.email = facts.email.trim();
  if (facts.logoPath && url) schema.logo = siteUrl(facts.domain, facts.logoPath);
  if (!facts.isServiceAreaBusiness) {
    schema.address = {
      "@type": "PostalAddress",
      streetAddress: facts.streetAddress.trim() || missing("street address"),
      addressLocality: facts.city.trim() || missing("city"),
      ...(facts.state.trim() ? { addressRegion: facts.state.trim() } : {}),
      addressCountry: "US",
    };
  }
  const hours = openingHoursSpecification(facts.hours);
  if (hours.length) schema.openingHoursSpecification = hours;
  if (facts.areaServed.length) {
    schema.areaServed = facts.areaServed.map((a) => ({ "@type": a.type, name: a.name }));
  }
  return schema;
}

/* The shared picture: the photo given, else a logo that isn't SVG; none rather than an SVG nobody shows. */
function shareImage(facts: BusinessFacts): string | null {
  if (facts.shareImagePath) return facts.shareImagePath;
  return facts.logoPath && !/\.svg$/i.test(facts.logoPath) ? facts.logoPath : null;
}

/* The extra tags in one page's head. */
export function seoHead(input: { facts: BusinessFacts; path: string; kind: string; title: string; description: string }): string {
  const url = siteUrl(input.facts.domain, input.path);
  const tags = [
    url ? `<link rel="canonical" href="${escapeAttr(url)}" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeAttr(input.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(input.description)}" />`,
    `<meta property="og:site_name" content="${escapeAttr(input.facts.name || "")}" />`,
    url ? `<meta property="og:url" content="${escapeAttr(url)}" />` : "",
    url && shareImage(input.facts) ? `<meta property="og:image" content="${escapeAttr(siteUrl(input.facts.domain, shareImage(input.facts)!)!)}" />` : "",
  ];
  if (input.kind === "home" || input.kind === "contact") {
    // "<" escaped so nothing in the business's details can close the script.
    tags.push(`<script type="application/ld+json">${JSON.stringify(localBusinessSchema(input.facts)).replace(/</g, "\\u003c")}</script>`);
  }
  return tags.filter(Boolean).join("\n");
}

export function robotsTxt(mode: SiteMode, domain: string | null): string {
  if (mode === "preview") return "# A preview: not for search engines until the site goes live.\nUser-agent: *\nDisallow: /\n";
  const sitemap = siteUrl(domain, "/sitemap.xml");
  return `User-agent: *\nAllow: /\n${sitemap ? `\nSitemap: ${sitemap}\n` : ""}`;
}

export function sitemapXml(domain: string | null, paths: string[]): string | null {
  if (!domain) return null;
  const urls = paths.map((p) => `  <url><loc>${escapeAttr(siteUrl(domain, p)!)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/* Netlify's _headers file: a preview is never indexed; every mode gets the basic security headers. */
export function headersFile(mode: SiteMode): string {
  const lines = ["/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", "  X-Frame-Options: SAMEORIGIN"];
  if (mode === "preview") lines.push("  X-Robots-Tag: noindex, nofollow");
  // The speed pass's pictures and fonts carry their content in their names, so browsers may keep them a year.
  lines.push("/assets/*", "  Cache-Control: public, max-age=31536000, immutable");
  return `${lines.join("\n")}\n`;
}

export const THANK_YOU_PATH = "/thank-you/";

/*
  Every <form> becomes a Netlify form: a name, POST, data-netlify, a
  honeypot field named bot-field (hidden from people), the hidden
  form-name input Netlify needs, and the thank-you page as its action.
*/
export function netlifyForms(main: string): string {
  let count = 0;
  return main.replace(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi, (_whole, attrs: string, inner: string) => {
    count += 1;
    const name = /\bname=(["'])([^"']+)\1/i.exec(attrs)?.[2] ?? (count === 1 ? "contact" : `contact-${count}`);
    const kept = attrs
      // Longest names first, and whole names only, so netlify-honeypot never leaves "-honeypot" behind.
      .replace(/\s(?:data-netlify-honeypot|netlify-honeypot|data-netlify|netlify|name|method|action)(?=[\s=>/]|$)(?:=(["'])[^"']*\1)?/gi, "")
      .trim();
    const cleanInner = inner
      .replace(/<input\b[^>]*name=(["'])form-name\1[^>]*>/gi, "")
      .replace(/<p class="tawd-honeypot"[\s\S]*?<\/p>/gi, "");
    return `<form name="${escapeAttr(name)}" method="POST" action="${THANK_YOU_PATH}" data-netlify="true" netlify-honeypot="bot-field"${kept ? ` ${kept}` : ""}><input type="hidden" name="form-name" value="${escapeAttr(name)}" /><p class="tawd-honeypot" hidden><label>Leave this empty: <input name="bot-field" /></label></p>${cleanInner}</form>`;
  });
}

// The number as "(916) 555-0142", tap to call (6 October 2026); none yet: a visible placeholder.
const phoneLink = (phone: string) => {
  const href = phoneHref(phone);
  return href ? `<a href="${escapeAttr(href)}">${escapeAttr(formatUsPhone(phone.trim()))}</a>` : `<mark class="tawd-placeholder">[PLACEHOLDER: phone number]</mark>`;
};

export function thankYouMain(facts: BusinessFacts, line = ""): string {
  return `<main id="main"><section class="tawd-simple-page"><h1>Thanks, we got your message</h1><p>${line.trim() ? escapeAttr(line.trim()) : `${escapeAttr(facts.name || "We")} will get back to you as soon as we can.`}</p><p>If it's urgent, call ${phoneLink(facts.phone)}.</p><p><a href="/">Back to the home page</a></p></section></main>`;
}

export function notFoundMain(facts: BusinessFacts, pages: { name: string; slug: string; kind: string }[]): string {
  const services = pages.filter((p) => p.kind === "service").slice(0, 6);
  return `<main id="main"><section class="tawd-simple-page"><h1>We can't find that page</h1><p>It may have moved. Call ${phoneLink(facts.phone)}, or try one of these:</p><ul>${[{ name: "Home", slug: "" }, ...services, ...pages.filter((p) => p.kind === "contact")].map((p) => `<li><a href="${pagePath(p.slug)}">${escapeAttr(p.name)}</a></li>`).join("")}</ul></section></main>`;
}

/* A little CSS for the pages TAWD writes itself, in the site's own fonts and colours. */
export const SIMPLE_PAGE_CSS = `.tawd-simple-page{max-width:720px;margin:0 auto;padding:96px 24px}.tawd-simple-page h1{margin-top:0}.tawd-honeypot{display:none}mark.tawd-placeholder{background:#fff4dd;color:#6b3a00;padding:0 4px;border-radius:4px}`;

/* ---------- the go-live checklist ---------- */

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Blocks go-live (Phase 9); a preview can still be deployed and shown to the client. */
  blocksGoLive: boolean;
  /** Health and beauty rules: each flag to fix or confirm with the client. */
  flags?: { id: string; rule: string; found: string }[];
  /** Every line of a list the detail only shows the start of (what a kept page's rules would have changed), for a fold-out under it. */
  every?: string[];
}

export function runChecklist(input: {
  /** "index.html", "drain-cleaning/index.html", "404.html", "robots.txt" ... */
  files: Map<string, string>;
  pagePaths: string[];
  /** Every file in the build (stylesheet and images too), for the link check; defaults to the text files. */
  fileNames?: string[];
  domain: string | null;
  /** Pages wider than a phone screen, from the rendered check; null when it couldn't run. */
  mobileOverflow: string[] | null;
  gbpUrl: string;
  /** The intake's offer facts (gap 12): a go-live blocker for a warranty, free offer or financing the intake doesn't back, and for superlatives. */
  claims?: ClaimFacts;
  /** The features the client's current site has (crawl-%): a go-live blocker when the built home page drops one the approved concept kept. */
  siteFeatures?: SiteFeature[];
  /** The project's confirmed facts (B1): every page, the 404 page included, is checked against them. */
  facts?: ConfirmedFacts;
  /**
    The built file that holds a homepage the team supplied and the client approved (suppliedHomeFile), and the words that page was
    SUPPLIED with (suppliedHomeWords: from the stored upload, never the built file). Those words back the facts and claims on that
    file (backedByOwnWords) and on no other file. Either null or left out: every file is checked as usual.
  */
  suppliedHomeFile?: string | null;
  suppliedWords?: string | null;
}): ChecklistItem[] {
  const htmlFiles = [...input.files.entries()].filter(([file]) => file.endsWith(".html"));
  const pages = htmlFiles.filter(([file]) => file !== "404.html");
  const names = new Set(input.fileNames ?? [...input.files.keys()]);
  const exists = (href: string) => {
    const clean = href.split(/[?#]/)[0]!;
    if (clean === "/") return names.has("index.html");
    const trimmed = clean.replace(/^\//, "");
    return names.has(trimmed) || names.has(`${trimmed.replace(/\/$/, "")}/index.html`);
  };
  const broken = new Set<string>();
  const noAlt: string[] = [];
  const h1Problems: string[] = [];
  const placeholders = new Set<string>();
  let skip = true;
  let footer = true;
  for (const [file, html] of pages) {
    for (const m of html.matchAll(/\bhref="(\/[^"]*)"/g)) if (!m[1]!.startsWith("//") && !exists(m[1]!)) broken.add(m[1]!);
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\balt="[^"]+"/i.test(m[0]) && !/\balt=""[^>]*aria-hidden/i.test(m[0])) noAlt.push(file);
    const h1 = html.match(/<h1\b/gi)?.length ?? 0;
    if (h1 !== 1) h1Problems.push(`${file} (${h1})`);
    if (!/href="#main"/.test(html)) skip = false;
    if (!/Website by Velocity Media Lab/i.test(html)) footer = false;
  }
  // The placeholder gate reads every HTML file, the 404 page included (F-036); the checks above keep their own exclusions.
  // A labeled photo frame ("Photo: ...") left where a picture belongs counts too: the site build only fills or removes frames marked for stock photos.
  for (const [file, html] of htmlFiles) {
    for (const p of html.replace(/<[^>]+>/g, " ").match(/\[PLACEHOLDER:[^\]]*\]/gi) ?? []) placeholders.add(p);
    for (const p of html.match(/\[PLACEHOLDER:[^\]]*\]/gi) ?? []) placeholders.add(p);
    for (const label of labelledPhotoFrames(html)) placeholders.add(`[photo frame in ${file}: ${label}]`);
  }
  const home = input.files.get("index.html") ?? "";
  const faq = pages.find(([file]) => file.startsWith("faq/"))?.[1] ?? pages.map(([, h]) => h).join("");
  const forms = pages.flatMap(([, html]) => html.match(/<form\b[^>]*>/gi) ?? []);
  const titles = pages.filter(([, html]) => !/<title>[^<]{3,}<\/title>/i.test(html) || !/<meta name="description" content="[^"]{20,}"/i.test(html)).map(([f]) => f);
  const tel = /href="tel:\+?\d{10,}"/.test(home);
  // Claims the intake doesn't back (gap 12): a go-live blocker, scanned across every page.
  const ownFile = input.suppliedHomeFile ?? null;
  const ownWords = ownFile ? (input.suppliedWords ?? null) : null;
  // The findings on the supplied page that its own words back, set apart (not counted) and kept to tell the team.
  const splitOwn = <T extends { file: string; evidence: string }>(hits: T[]): { counted: T[]; backed: T[] } => {
    const backed = hits.filter((hit) => ownWords !== null && hit.file === ownFile && backedByOwnWords(hit.evidence, ownWords));
    return { counted: hits.filter((hit) => !backed.includes(hit)), backed };
  };
  const claimSplit = splitOwn(input.claims ? unsupportedClaimsOnSite(pages, input.claims) : []);
  const claimHits = claimSplit.counted;
  const claimBlocking = claimHits.filter((c) => c.severity === "fail");
  const claimReported = claimHits.filter((c) => c.severity !== "fail");
  // Features the approved concept kept from the current site (crawl-%): the built home page must keep them too.
  const featuresMissing = input.siteFeatures?.length ? checkSiteFeatures(home, input.siteFeatures).missing : [];
  // B1: every page against the intake's facts, the 404 page included (it shows the phone number too).
  const factSplit = splitOwn(input.facts ? factIssuesOnSite(htmlFiles, input.facts) : []);
  const factHits = factSplit.counted;
  // Said whenever it applied, so the team is never left thinking the page passed the check: it was not held to it.
  const ownNote = (count: number) =>
    count > 0 ? ` The supplied home page's own words back ${count} finding${count === 1 ? "" : "s"} on it (${ownFile}), so TAWD did not count ${count === 1 ? "it" : "them"} as ${count === 1 ? "a problem" : "problems"}: whoever supplied the page answers for what it says.` : "";
  const factItem: ChecklistItem[] = input.facts
    ? [
        {
          key: "facts",
          label: FACT_CHECKS_BLOCK ? "Facts match the intake" : "Facts match the intake (report only for now: does not block go-live)",
          ok: factHits.length === 0,
          detail:
            (factHits.length
              ? `${factHits.length}: ${factHits.slice(0, 6).map((h) => `${h.file}: ${h.evidence}`).join("; ")}${factHits.length > 6 ? ", ..." : ""}`
              : "Every call button, phone number, price, year, address, town, name and rating on the site is one the intake has") + ownNote(factSplit.backed.length),
          blocksGoLive: FACT_CHECKS_BLOCK,
          flags: factHits.map((h) => ({ id: h.id, rule: h.message, found: `${h.file}: ${h.evidence}` })),
        },
      ]
    : [];

  return [
    { key: "404", label: "Custom 404 page", ok: input.files.has("404.html"), detail: "With the phone number, the main service links and a way home", blocksGoLive: true },
    { key: "skip", label: "Skip-to-content link on every page", ok: skip, detail: skip ? "Every page" : "Missing on at least one page", blocksGoLive: true },
    { key: "faq", label: "Expandable FAQ", ok: /<details\b/i.test(faq), detail: /<details\b/i.test(faq) ? "Questions open and close (<details>)" : "The FAQ isn't built with <details>", blocksGoLive: false },
    {
      key: "forms",
      label: "Contact form, with a thank-you page",
      ok: forms.length > 0 && forms.every((f) => /data-netlify="true"/.test(f)) && input.files.has("thank-you/index.html"),
      detail: forms.length ? `${forms.length} form${forms.length === 1 ? "" : "s"}, sent to Netlify Forms; "we got it" page at ${THANK_YOU_PATH}` : "No form on the site",
      blocksGoLive: true,
    },
    { key: "footer", label: '"Website by Velocity Media Lab" in the footer', ok: footer, detail: footer ? "On every page" : "Missing on at least one page", blocksGoLive: true },
    { key: "h1", label: "One H1 per page", ok: h1Problems.length === 0, detail: h1Problems.length ? h1Problems.join(", ") : "Every page", blocksGoLive: false },
    { key: "meta", label: "Title and meta description on every page", ok: titles.length === 0, detail: titles.length ? `Missing or too short: ${titles.join(", ")}` : "Every page", blocksGoLive: false },
    { key: "links", label: "Internal links all work", ok: broken.size === 0, detail: broken.size ? `Broken: ${[...broken].slice(0, 8).join(", ")}` : "Every link goes to a page on the site", blocksGoLive: true },
    { key: "alt", label: "Every image has alt text", ok: noAlt.length === 0, detail: noAlt.length ? `Missing on ${[...new Set(noAlt)].join(", ")}` : "Every image", blocksGoLive: false },
    { key: "tel", label: "Tap-to-call phone number on the home page", ok: tel, detail: tel ? "A tel: link" : "No tel: link with a real number yet", blocksGoLive: true },
    {
      key: "mobile",
      label: "Fits a phone screen",
      ok: input.mobileOverflow !== null && input.mobileOverflow.length === 0,
      detail: input.mobileOverflow === null ? "Not measured" : input.mobileOverflow.length ? `Wider than the screen: ${input.mobileOverflow.join(", ")}` : "Every page at 390px wide",
      blocksGoLive: false,
    },
    { key: "domain", label: "Domain, canonical URLs and sitemap", ok: Boolean(input.domain), detail: input.domain ? `https://${input.domain}` : "No domain in the intake yet: canonical URLs, Open Graph URLs and sitemap.xml are added once it is known (go-live, Phase 9)", blocksGoLive: true },
    {
      key: "placeholders",
      label: "No placeholders left",
      ok: placeholders.size === 0,
      detail: placeholders.size ? `${placeholders.size}: ${[...placeholders].slice(0, 6).join(", ")}${placeholders.size > 6 ? ", ..." : ""}` : "None",
      blocksGoLive: true,
    },
    {
      key: "claims",
      label: "No unconfirmed or over-stated claims",
      // Only a "fail" claim blocks; a report-only ("warn") one (B2) is shown in the detail and the flags.
      ok: claimBlocking.length === 0,
      detail:
        ([
        claimBlocking.length ? `${claimBlocking.length}: ${[...new Set(claimBlocking.map((c) => c.evidence))].slice(0, 6).join("; ")}${claimBlocking.length > 6 ? ", ..." : ""}` : "",
        claimReported.length
          ? `${claimBlocking.length ? "Also reported, not blocking" : "Reported, not blocking"} (${claimReported.length}): ${[...new Set(claimReported.map((c) => c.evidence))].slice(0, 6).join("; ")}${claimReported.length > 6 ? ", ..." : ""}`
          : "",
      ]
        .filter(Boolean)
        .join(". ") || "No invented warranty, offer, financing, credential or superlative") + ownNote(claimSplit.backed.length),
      blocksGoLive: true,
      flags: claimReported.map((c) => ({ id: "claims.warn", rule: c.message, found: `${c.file}: ${c.evidence}` })),
    },
    ...factItem,
    {
      key: "siteFeatures",
      label: "Keeps the current site's features",
      ok: featuresMissing.length === 0,
      detail: featuresMissing.length
        ? `Dropped from the current site: ${featuresMissing.map((f) => f.label).join("; ")} (on the home page)`
        : input.siteFeatures?.length
          ? "Every feature the approved concept kept is on the built home page"
          : "No current-site features to keep",
      blocksGoLive: true,
    },
    {
      key: "gbp",
      label: "Google Business Profile link tagged",
      ok: Boolean(input.gbpUrl && input.domain),
      detail: input.domain
        ? `Set the profile's website to https://${input.domain}/?utm_source=google&utm_medium=organic&utm_campaign=gbp-listing`
        : "Once the domain is known, the profile's website link gets UTM tags so its visits show in analytics",
      blocksGoLive: false,
    },
  ];
}
