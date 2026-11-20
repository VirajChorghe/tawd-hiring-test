import { formatUsPhone, phoneProblem, validPhoneOrBlank } from "../phone";
import { isLicensedTrade } from "../intake/completeness";
import type { IntakeData } from "../intake/schema";
import { serviceAreaGuidance } from "../intake/service-area";
import type { CheckIssue } from "./checks";

/*
  What the intake actually says, one fact at a time.

  The first real concept (Pat Rivera) came back with around 35
  placeholders, several of them for things like the business name and the
  city. The whole intake was in the prompt, but as one large JSON block, and
  a model skimming JSON for "the phone number" can miss it. So the prompt now
  also gets this list: every fact TAWD knows, by name, in plain lines, and
  separately every fact it does not know.

  The same list is what the checks use to catch a placeholder standing in
  for something the intake does have, and what the "Needs intake info"
  status uses to name the required fields a concept is still waiting on.
*/

/*
  How a missing fact is handled on the page (Jason's rule, 2026-09-24):

  - required: a visible placeholder. The gate says these must exist, so the
    gap has to be seen until it is filled.
  - detail: left out entirely (since 8 October 2026 every optional field,
    reviews, booking and pricing included: Jason, "if no info has been
    added why does the mockup have it as a placeholder?"). A page dotted with "[PLACEHOLDER: current
    offer]" and "[PLACEHOLDER: founders' names]" reads as unfinished; a page
    without an offers band reads as a page.
*/
export type FactTier = "required" | "detail";

export interface IntakeFact {
  /** Stable, dotted, matches the intake shape where there is one. */
  key: string;
  label: string;
  /** Null when the intake does not have it. */
  value: string | null;
  /**
   * The completeness rule this fact satisfies, for the fields the gate
   * treats as required. Absent for optional fields.
   */
  requirementKey?: string;
  tier: FactTier;
}

export interface IntakeAssetSummary {
  kind: string;
}

const LONG_TEXT = 240;

function textValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Long answers are in the intake block in full; the fact list only needs
  // to say that they exist and what they start with.
  return trimmed.length > LONG_TEXT
    ? `${trimmed.slice(0, LONG_TEXT)}... (full text in the intake block)`
    : trimmed;
}

function listValue(values: string[]): string | null {
  return values.length === 0 ? null : values.join("; ");
}

/* "Bishop: (760) 555-0142, 12 Main St, Bishop, CA", leaving out what's empty. */
export function describeLocation(location: IntakeData["business"]["locations"][number]): string {
  const place = [location.streetAddress, location.city, location.state].filter(Boolean).join(", ");
  const details = [formatUsPhone(validPhoneOrBlank(location.phone)), place].filter(Boolean).join(", ");
  const name = location.name || location.city;
  return name && details ? `${name}: ${details}` : name || details;
}

/* Every phone number the client has given: the main one and each location's. */
export function intakePhones(intake: IntakeData): string[] {
  // A stored value nobody could dial is dropped, never passed on as a fact (F-035).
  return [intake.business.phone, ...intake.business.locations.map((l) => l.phone)].filter((p) => p && phoneProblem(p) === null).map(formatUsPhone);
}

function yesNo(value: boolean | null): string | null {
  return value === null ? null : value ? "Yes" : "No";
}

export function listIntakeFacts(
  intake: IntakeData,
  files: IntakeAssetSummary[],
  options: { trade?: string | null } = {},
): IntakeFact[] {
  const b = intake.business;
  // Only licensed trades show a license; see isLicensedTrade.
  const showsLicense = options.trade === undefined || isLicensedTrade(options.trade ?? null);

  const hours = b.hours
    .filter((row) => row.closed || row.open || row.close)
    .map((row) =>
      row.closed
        ? `${row.day}: closed`
        : `${row.day}: ${row.open || "?"} to ${row.close || "?"}`,
    );

  const services = intake.services.items.map((item) =>
    item.description ? `${item.name} (${item.description})` : item.name,
  );
  const mainService = intake.services.items.find(
    (item) => item.id === intake.services.mainServiceId,
  );

  const logoCount = files.filter((f) => f.kind === "logo").length;
  const photoCount = files.filter((f) => f.kind === "photo").length;

  const facts: IntakeFact[] = [
    {
      key: "business.name",
      label: "Business name",
      value: textValue(b.name),
      requirementKey: "business.name",
      tier: "required",
    },
    {
      key: "business.phone",
      label: "Phone number",
      value: textValue(formatUsPhone(validPhoneOrBlank(b.phone))),
      requirementKey: "business.phone",
      tier: "required",
    },
    { key: "business.email", label: "Email address", value: textValue(b.email), tier: "detail" },
    {
      key: "business.streetAddress",
      label: "Street address",
      value: b.isServiceAreaBusiness
        ? "None to publish: a service-area business that works at customers' premises"
        : textValue(b.streetAddress),
      requirementKey: "business.address",
      tier: "required",
    },
    { key: "business.city", label: "City the business is based in", value: textValue(b.city), tier: "detail" },
    { key: "business.state", label: "State", value: textValue(b.state), tier: "detail" },
    ...(b.locations.length > 0
      ? [
          {
            key: "business.locations",
            label: "Other locations (each with its own phone and address)",
            value: listValue(b.locations.map(describeLocation)),
            tier: "detail" as const,
          },
        ]
      : []),
    b.noGoogleBusinessProfile && !b.googleBusinessProfileUrl
      ? {
          // A new business: no profile to link, and no reviews to show.
          key: "business.googleBusinessProfileUrl",
          label: "Google Business Profile link (a new business with none yet: no Google link and no reviews section)",
          value: null,
          tier: "detail",
        }
      : {
          key: "business.googleBusinessProfileUrl",
          label: "Google Business Profile link",
          value: textValue(b.googleBusinessProfileUrl),
          requirementKey: "business.googleBusinessProfileUrl",
          tier: "required",
        },
    b.licenseNumbers.length === 0 && (b.licenseInProgress || !showsLicense)
      ? {
          // In progress, or a trade with no license: leave it out entirely.
          key: "business.licenseNumbers",
          label: b.licenseInProgress
            ? "License number (applied for, not issued yet: leave it out, no placeholder)"
            : "License number (not needed for this trade: leave it out)",
          value: null,
          tier: "detail",
        }
      : {
          key: "business.licenseNumbers",
          label: "License numbers",
          value: listValue(b.licenseNumbers),
          requirementKey: "business.licenseNumber",
          tier: "required",
        },
    {
      key: "business.yearFounded",
      label: "Year founded",
      value: b.yearFounded === null ? null : String(b.yearFounded),
      requirementKey: "business.yearFounded",
      tier: "required",
    },
    // Jason, 1 October 2026: no hours in the intake, no hours on the page (not even a placeholder).
    { key: "business.hours", label: "Opening hours", value: listValue(hours), tier: "detail" },
    {
      key: "business.emergency247",
      label: "24/7 emergency service",
      value: yesNo(b.emergency247),
      tier: "detail",
    },
    {
      key: "business.certifications",
      label: "Certifications",
      value: listValue(b.certifications),
      tier: "detail",
    },
    {
      key: "services.items",
      label: "Services",
      value: listValue(services),
      requirementKey: "services.atLeastOne",
      tier: "required",
    },
    {
      key: "services.main",
      label: "Main service",
      value: mainService ? mainService.name : null,
      tier: "detail",
    },
    {
      key: "serviceAreas.cities",
      label: "Service areas",
      value: serviceAreaGuidance(intake.serviceAreas),
      requirementKey: "serviceAreas.atLeastOne",
      // Jason, 1 October 2026: no service areas in the intake, no service-area section and no placeholder for one.
      tier: "detail",
    },
    {
      key: "brand.logo",
      label: "Logo",
      value: logoCount > 0 ? "Uploaded (see the images list)" : null,
      requirementKey: "brand.logo",
      tier: "required",
    },
    {
      key: "photos",
      label: "Photos",
      value:
        photoCount > 0
          ? `${photoCount} uploaded (see the images list)`
          : null,
      tier: "detail",
    },
    { key: "brand.colors", label: "Brand colors", value: listValue(intake.brand.colors), tier: "detail" },
    { key: "brand.fonts", label: "Brand fonts", value: textValue(intake.brand.fonts), tier: "detail" },
    {
      key: "content.toneOfVoice",
      label: "Tone of voice",
      value: textValue(intake.content.toneOfVoice),
      tier: "detail",
    },
    {
      key: "content.suppliedCopy",
      label: "Copy supplied by the client",
      value: textValue(intake.content.suppliedCopy),
      tier: "detail",
    },
    {
      key: "process.scheduling",
      label: "How scheduling works",
      value: textValue(intake.process.scheduling),
      tier: "detail",
    },
    {
      key: "process.quotingAndPricing",
      label: "Quoting and pricing",
      value: textValue(intake.process.quotingAndPricing),
      tier: "detail",
    },
    {
      key: "process.guarantees",
      label: "Guarantees and warranties",
      value: textValue(intake.process.guarantees),
      tier: "detail",
    },
    {
      key: "extras.currentOffers",
      label: "Current offers",
      value: textValue(intake.extras.currentOffers),
      tier: "detail",
    },
    {
      key: "extras.financingAvailable",
      label: "Financing available",
      value: yesNo(intake.extras.financingAvailable),
      tier: "detail",
    },
  ];

  if (b.noGoogleBusinessProfile && !b.googleBusinessProfileUrl) {
    facts.push({
      key: "page.reviews",
      label: "Google rating and reviews (a new business with no Google profile yet: leave the reviews section out entirely)",
      value: null,
      tier: "detail",
    });
  }

  return facts;
}

/*
  Which intake field a placeholder is standing in for.

  Read from the words inside "[PLACEHOLDER: ...]". Deliberately narrow: a
  placeholder the patterns do not recognize maps to nothing, which is the
  safe direction - "[PLACEHOLDER: real Google review]" is a genuine gap the
  intake cannot fill, not a field that was ignored.

  Order matters only for the handful of words that overlap, and those are
  handled by the patterns themselves (an "email address" is not a street
  address; "service area cities" are not the city the business is in).
*/
const FIELD_PATTERNS: { key: string; pattern: RegExp }[] = [
  { key: "business.name", pattern: /\b(?:business|company|trading|brand)\s*name\b/ },
  // Not "call": "what happens when you call" is a gap in the process, not the number.
  { key: "business.phone", pattern: /\b(?:tele)?phone\b/ },
  { key: "business.email", pattern: /\be-?mail\b/ },
  {
    key: "business.streetAddress",
    pattern: /\b(?:street|business|office|shop|physical|mailing)?\s*address\b/,
  },
  { key: "business.city", pattern: /\bcity\b/ },
  { key: "business.state", pattern: /\bstate\b(?!\s*licen)/ },
  {
    key: "business.googleBusinessProfileUrl",
    pattern: /\bgoogle\s*business\b|\bbusiness\s*profile\b|\bgbp\b|\bgoogle\s*maps?\s*(?:link|url)\b/,
  },
  { key: "business.licenseNumbers", pattern: /\blicen[cs]e|\blic\s*#|\bcslb\b/ },
  {
    key: "business.yearFounded",
    pattern: /\bfound(?:ed|ing)\b|\bestablished\b|\bsince\b|\byears? in business\b/,
  },
  { key: "business.hours", pattern: /\b(?:opening|business|office)?\s*hours\b|\bopening times\b/ },
  { key: "business.emergency247", pattern: /\b24\s*\/\s*7\b|\bemergency (?:availability|service hours)\b/ },
  { key: "business.certifications", pattern: /\bcertifi|\baccredit/ },
  {
    key: "services.items",
    pattern: /\bservices? (?:list|names?|descriptions?|offered)\b|\blist of services\b/,
  },
  { key: "services.main", pattern: /\bmain service\b/ },
  {
    key: "serviceAreas.cities",
    pattern: /\bservice[- ]?areas?\b|\bareas? (?:we )?serve[ds]?\b|\b(?:cities|towns) (?:served|we serve)\b/,
  },
  { key: "brand.logo", pattern: /\blogo\b/ },
  { key: "process.scheduling", pattern: /\bschedul|\bbooking\b|\bappointment/ },
  {
    key: "process.quotingAndPricing",
    pattern: /\bquot(?:e|es|ing)\b|\bpricing\b|\bprices?\b|\bestimates?\b/,
  },
  { key: "page.reviews", pattern: /\breviews?\b|\bratings?\b|\btestimonials?\b|\bstars?\b/ },
  {
    key: "page.people",
    pattern: /\bfounders?'?s?\b|\bowners?'?s?\s*names?\b|\b(?:staff|team|technician|crew)(?: member)?'?s?\s*names?\b/,
  },
  { key: "page.history", pattern: /\bhistory\b|\bour story\b|\bbackstory\b|\bhow (?:we|it) (?:started|began)\b/ },
  { key: "page.callbackTimes", pattern: /\bcall ?backs?\b|\bresponse times?\b/ },
  { key: "process.guarantees", pattern: /\bguarantee|\bwarrant(?:y|ies)\b/ },
  {
    key: "extras.currentOffers",
    pattern: /\b(?:current|special|seasonal) offers?\b|\bpromotion|\bcoupon|\bdiscount/,
  },
  { key: "extras.financingAvailable", pattern: /\bfinanc/ },
];

/** The field keys a placeholder's own words point at. */
export function fieldsForPlaceholder(placeholder: string): string[] {
  const inner = placeholder
    .replace(/^\[PLACEHOLDER:\s*/i, "")
    .replace(/\]$/, "")
    .toLowerCase();

  const keys = FIELD_PATTERNS.filter(({ pattern }) => pattern.test(inner)).map(
    ({ key }) => key,
  );

  const set = new Set(keys);
  // "Service area cities" is the service areas, not where the office is.
  if (set.has("serviceAreas.cities")) set.delete("business.city");
  // An email address is not a street address.
  if (set.has("business.email") && !/\bstreet\b/.test(inner)) {
    set.delete("business.streetAddress");
  }
  return [...set];
}

/*
  Things a homepage often states that the intake form never asks for. They
  are always missing at this stage, so they only matter for deciding how a
  placeholder for one is handled. Not shown in the "Not in the intake" card,
  since there is no field for the team to fill.
*/
export const PAGE_ONLY_FACTS: IntakeFact[] = [
  { key: "page.reviews", label: "Google rating and reviews", value: null, tier: "detail" },
  { key: "page.people", label: "Founders' or staff names", value: null, tier: "detail" },
  { key: "page.history", label: "Company history detail", value: null, tier: "detail" },
  { key: "page.callbackTimes", label: "Callback or response times", value: null, tier: "detail" },
];

const PLACEHOLDER_ANYWHERE = /\[PLACEHOLDER:[^\]]*\]/gi;

export interface PlaceholderMatch {
  placeholder: string;
  fact: IntakeFact;
}

/** Every placeholder on the page that stands in for a known intake field. */
export function matchPlaceholders(
  html: string,
  facts: IntakeFact[],
): PlaceholderMatch[] {
  const byKey = new Map(
    [...PAGE_ONLY_FACTS, ...facts].map((fact) => [fact.key, fact]),
  );
  const out: PlaceholderMatch[] = [];

  for (const placeholder of html.match(PLACEHOLDER_ANYWHERE) ?? []) {
    for (const key of fieldsForPlaceholder(placeholder)) {
      const fact = byKey.get(key);
      if (fact) out.push({ placeholder, fact });
    }
  }
  return out;
}

/*
  A placeholder for something the intake already has is a failed check: the
  page is asking the client for information they already gave. The fix
  round is then told exactly which value to use.
*/
export function checkPlaceholdersAgainstIntake(
  html: string,
  facts: IntakeFact[],
): CheckIssue[] {
  const seen = new Set<string>();
  const issues: CheckIssue[] = [];

  for (const { placeholder, fact } of matchPlaceholders(html, facts)) {
    if (fact.value === null || seen.has(fact.key)) continue;
    seen.add(fact.key);
    issues.push({
      id: "house.placeholder.filled",
      severity: "fail",
      evidence: placeholder,
      message: `The page shows "${placeholder}", but the intake has the ${fact.label.toLowerCase()}: "${fact.value}". Use the real value; a placeholder is only for what the intake does not have.`,
      where: fact.key,
    });
  }

  return issues;
}

export interface NeedsIntakeField {
  key: string;
  label: string;
}

/*
  The required fields a concept still shows a placeholder for.

  Only fields the intake is genuinely missing: a placeholder for something
  the intake has is a failed check (above), a bug in the build rather than
  information the team has to go and get.
*/
export function requiredFieldsStillMissing(
  html: string,
  facts: IntakeFact[],
): NeedsIntakeField[] {
  const found = new Map<string, NeedsIntakeField>();

  for (const { fact } of matchPlaceholders(html, facts)) {
    if (!fact.requirementKey || fact.value !== null) continue;
    found.set(fact.key, { key: fact.key, label: fact.label });
  }

  return [...found.values()];
}

/* "[PLACEHOLDER: photo of the rig]": a frame for a picture, which the photo plan and stock handle. */
export function isPicturePlaceholder(placeholder: string): boolean {
  return /^\[PLACEHOLDER:\s*(?:an?\s+|the\s+)?(?:photo|picture|image|video|logo)\b/i.test(placeholder);
}

/*
  The placeholder rule, as checks (8 October 2026: only required fields).

  A placeholder is allowed only where a required intake field is empty.
  Every other one fails: one for an optional field the client left blank
  (placeholders.detail), and one for something the intake never asks
  (placeholders.notRequired: "how often service visits happen"). Code
  removes most of them free (placeholder-cleanup.ts); what is left goes to
  the fix round, told to leave each out.
*/
export function checkPlaceholderRule(
  html: string,
  facts: IntakeFact[],
  /** Facts the client's current site shows: their placeholder "to confirm with the client" stays (5 November 2026). */
  confirmable: string[] = [],
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const all = [...new Set(html.match(PLACEHOLDER_ANYWHERE) ?? [])];
  const matches = matchPlaceholders(html, facts);

  const byPlaceholderIndex = (placeholder: string) =>
    matches.filter((m) => m.placeholder === placeholder).map((m) => m.fact);

  /* Optional fields: leave the element out. */
  const details = new Map<string, { label: string; examples: string[] }>();
  /* Nothing in the intake asks for it: leave it out. */
  const unasked: string[] = [];

  for (const placeholder of all) {
    // A picture's frame is the photo plan's business, not a missing fact.
    if (isPicturePlaceholder(placeholder)) continue;
    const mapped = byPlaceholderIndex(placeholder);

    // A placeholder for a filled field is caught by its own check.
    if (mapped.some((fact) => fact.value !== null)) continue;

    // Empty required fields are expected.
    if (mapped.some((fact) => fact.tier === "required")) continue;

    // A rating, a licence or a review the current site shows, waiting for the client's word.
    if (/\bconfirm with the client\b/i.test(placeholder) && mapped.some((fact) => confirmable.includes(fact.key))) continue;

    const detail = mapped.find((fact) => fact.tier === "detail");
    if (detail) {
      const seen = details.get(detail.key) ?? { label: detail.label, examples: [] };
      seen.examples.push(placeholder);
      details.set(detail.key, seen);
    } else {
      unasked.push(placeholder);
    }
  }

  for (const [key, { label, examples }] of details) {
    issues.push({
      id: "placeholders.detail",
      severity: "fail",
      evidence: examples[0],
      message: `${label} is not in the intake and isn't required, so leave that element out entirely: remove ${examples.join(
        ", ",
      )} and whatever sits around it. No placeholder.`,
      where: key,
    });
  }

  if (unasked.length > 0) {
    issues.push({
      id: "placeholders.notRequired",
      severity: "fail",
      evidence: unasked[0],
      message: `${unasked.join(", ")} ${unasked.length === 1 ? "isn't" : "aren't"} for a required intake field, so leave ${
        unasked.length === 1 ? "it" : "each"
      } out entirely, with whatever sits around it (its card, line or section). Only an empty required field gets a placeholder.`,
    });
  }

  return issues;
}

/* Lines for the prompt: what TAWD knows, and how to treat what it does not. */
export function describeFactsForPrompt(facts: IntakeFact[]): {
  known: string;
  required: string;
  detail: string;
} {
  const lines = (list: IntakeFact[], empty: string) =>
    list.length > 0 ? list.map((f) => `- ${f.label}`).join("\n") : empty;

  const own = new Set(facts.map((f) => f.key));
  const missing = [...facts, ...PAGE_ONLY_FACTS.filter((f) => !own.has(f.key))].filter(
    (f) => f.value === null,
  );
  const known = facts
    .filter((fact) => fact.value !== null)
    .map((fact) => `- ${fact.label}: ${fact.value}`);

  return {
    known: known.length > 0 ? known.join("\n") : "- (nothing)",
    required: lines(
      missing.filter((f) => f.tier === "required"),
      "- (none: every required field is filled)",
    ),
    detail: lines(missing.filter((f) => f.tier === "detail"), "- (none)"),
  };
}
