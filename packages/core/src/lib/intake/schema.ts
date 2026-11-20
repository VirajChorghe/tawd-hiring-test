import { z } from "zod";
import { formatUsPhone } from "../phone";

import { specialFeatureKeys } from "./fit";
import { integrationKinds } from "./integrations";
import { US_STATE_CODES, serviceAreaScopes } from "./service-area";

/*
  The shape of the client intake.

  Two rules govern this file.

  First, everything is optional. This is a form the team fills in over days,
  a section at a time, so a half-finished intake must be storable. What is
  *required* is a separate question, answered by completeness.ts, which is
  what the gate consults before a project can leave Intake.

  Second, nothing is ever invented. House rules 2 and 3 in
  skills/TAWD-PROFILE.md: no made-up license numbers, years, phone numbers,
  addresses or credentials. An empty field stays empty and surfaces later as
  a visible placeholder on the mockup, unless the client's own design or
  current website proves it: then TAWD fills it, marked "From the design"
  or "From the current site" until the team confirms or corrects it
  (prefill.ts, core site/site-prefill.ts). Never licence numbers, years,
  hours, prices or reviews from the site.
*/

const text = z.string().trim().max(2000);
const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(20000);

/** Blank strings come back from empty inputs; treat them as "not answered". */
const optionalText = text.optional().default("");
const optionalShortText = shortText.optional().default("");
/*
  A phone number, kept as "(916) 555-0142" however it was typed (Jason,
  6 October 2026). Applied when a section is saved and when the intake is
  read, so numbers saved before show the same way. Not a US number: kept
  exactly as typed.
*/
const phoneText = optionalShortText.transform(formatUsPhone);

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value === "" || /^https?:\/\/\S+$/i.test(value),
    "Enter a full web address starting with http:// or https://",
  )
  .optional()
  .default("");

/** A tri-state: yes, no, or nobody has said yet. */
const optionalBoolean = z.boolean().nullable().optional().default(null);

const stringList = z
  .array(shortText)
  .max(50)
  .optional()
  .default([])
  // Empty rows are what a half-filled list input produces.
  .transform((values) => values.filter((v) => v.length > 0));

export const dayNames = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type DayName = (typeof dayNames)[number];

/*
  Hours are structured rather than a free-text box because the site build
  (Phase 8) needs them as opening-hours schema markup. Asking once, properly, beats
  re-asking every client later.
*/
export const businessHoursSchema = z.object({
  day: z.enum(dayNames),
  closed: z.boolean().default(false),
  open: optionalShortText,
  close: optionalShortText,
});

/*
  A business with more than one office (Reno, Bishop and Winnemucca, say):
  each extra location has its own phone and address. The main one stays in
  the fields above; these are the others, in the order the client gives.
*/
export const locationSchema = z.object({
  name: optionalShortText,
  phone: phoneText,
  streetAddress: optionalShortText,
  city: optionalShortText,
  state: optionalShortText,
});
export type BusinessLocation = z.infer<typeof locationSchema>;

export const businessSchema = z.object({
  name: optionalShortText,
  // For the privacy and cookie policies (28 September 2026): blank uses the business name and email.
  legalName: optionalShortText,
  phone: phoneText,
  email: optionalShortText,
  privacyEmail: optionalShortText,
  streetAddress: optionalShortText,
  // A service-area business works from customers' premises and has no
  // address to publish. Ticking this removes the address requirement.
  isServiceAreaBusiness: z.boolean().optional().default(false),
  city: optionalShortText,
  state: optionalShortText,
  locations: z
    .array(locationSchema)
    .max(20)
    .optional()
    .default([])
    // An empty row is what "Add another location" leaves before it's filled in.
    .transform((rows) => rows.filter((row) => Object.values(row).some((v) => v.length > 0))),
  googleBusinessProfileUrl: optionalUrl,
  // A new business with no Google Business Profile yet: the concepts leave
  // the reviews section out rather than showing placeholders for it.
  noGoogleBusinessProfile: z.boolean().optional().default(false),
  licenseNumbers: stringList,
  // Applied for, not issued yet: nothing to show, flagged at go-live.
  licenseInProgress: z.boolean().optional().default(false),
  yearFounded: z
    .union([z.coerce.number().int().min(1800).max(2100), z.literal("")])
    .nullable()
    .optional()
    .default(null)
    .transform((value) => (value === "" ? null : value)),
  hours: z.array(businessHoursSchema).max(7).optional().default([]),
  emergency247: optionalBoolean,
  certifications: stringList,
});

export const websiteSchema = z.object({
  // Whether the client already owns a domain, or VML buys one as an add-on.
  domainStatus: z
    .enum(["client_has", "vml_buys"])
    .nullable()
    .optional()
    .default(null),
  domainName: optionalShortText,
  currentWebsiteUrl: optionalUrl,
  // "No current website available" (Jason, 30 September 2026): with the address, the one item that blocks Design.
  noCurrentWebsite: optionalBoolean,
  likedWebsites: z
    .array(optionalUrl)
    .max(3)
    .optional()
    .default([])
    .transform((values) => values.filter((v) => v.length > 0)),
  // "What do they like about it?" for each reference site, by its address (Jason, 7 October 2026): what the builder follows first.
  likedWebsiteNotes: z
    .record(z.string().max(2_000), z.string().max(600))
    .optional()
    .default({})
    .transform((notes) => Object.fromEntries(Object.entries(notes).map(([url, note]) => [url.trim(), note.trim()]).filter(([url, note]) => url && note))),
});

/* What the client likes about one reference site, or "". */
export function likedNoteFor(website: { likedWebsiteNotes?: Record<string, string> }, url: string): string {
  return website.likedWebsiteNotes?.[url.trim()] ?? "";
}

export const serviceSchema = z.object({
  id: z.string().min(1),
  name: optionalShortText,
  description: optionalText,
});

export const servicesSchema = z.object({
  items: z
    .array(serviceSchema)
    .max(50)
    .optional()
    .default([])
    .transform((items) => items.filter((item) => item.name.length > 0)),
  mainServiceId: z.string().nullable().optional().default(null),
});

export const serviceAreasSchema = z.object({
  // Specific cities or towns, whole states, nationwide, or a radius around an address (service-area.ts).
  // Null is cities: every intake from before the choice existed.
  scope: z.enum(serviceAreaScopes).nullable().optional().default(null),
  cities: stringList,
  // Todd's request (26 September 2026): counties ("Washoe County, NV") and DMAs (from DataForSEO's list, kept whole).
  counties: stringList,
  states: z.array(z.enum(US_STATE_CODES)).max(51).optional().default([]),
  dmas: z.array(z.object({ id: z.string().regex(/^\d{3,9}$/), name: shortText, canonical: shortText })).max(50).optional().default([]),
  radius: z
    .object({
      miles: z
        .union([z.coerce.number().int().min(1).max(3000), z.literal("")])
        .nullable()
        .optional()
        .default(null)
        .transform((value) => (value === "" ? null : value)),
      address: optionalShortText,
    })
    .optional()
    .default({ miles: null, address: "" }),
  // Triggers the Growth tier check, for a list of cities or counties only. See tier.ts.
  wantsIndividualCityPages: optionalBoolean,
});

export const typeSizes = ["compact", "regular", "large"] as const;
export type TypeSize = (typeof typeSizes)[number];

const hexColor = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value),
    "Use a hex color such as #1f5f4f",
  );

export const brandSchema = z.object({
  // Locked inputs: if these are supplied, every mockup uses them and the
  // three concepts differ in layout only. See TAWD-PROFILE section 4.
  colors: z
    .array(hexColor)
    .max(12)
    .optional()
    .default([])
    .transform((values) => values.filter((v) => v.length > 0)),
  // The colours were taken from the logo automatically (27 September 2026): the brand, not a guess, until the PM changes them.
  colorsFromLogo: z.boolean().optional().default(false),
  // The client has no logo, so TAWD designs one (a paid add-on, Jason, 26 September 2026).
  tawdDesignsLogo: z.boolean().optional().default(false),
  // An older free-text note of the fonts; kept so nothing is lost.
  fonts: optionalShortText,
  // Jason, 26 September 2026: a font for headings and one for body text; blank means TAWD chooses.
  headingFont: optionalShortText,
  bodyFont: optionalShortText,
  typeSize: z.enum(typeSizes).nullable().optional().default(null),
  moodWords: stringList,
  competitorsToAvoid: stringList,
});

export const photosSchema = z.object({
  // The files themselves live in the intake_file table. This holds only the
  // note the team writes about them as a set.
  notes: optionalText,
  // Health and beauty rules (26 September 2026): before-and-after photos only with the
  // client's permission. The intake save logs who ticked it and when.
  beforeAfterPermission: z.boolean().optional().default(false),
  beforeAfterPermissionNote: optionalText,
});

export const contentSchema = z.object({
  // auto: New site (TAWD writes). manual: Content provided by the client. keep: Keep all content as is (1 October 2026).
  // The project type (0.100.0, project-type.ts): keep = Design only, improve = Design + content, auto = Everything new, manual = the client's words.
  mode: z.enum(["auto", "manual", "keep", "improve"]).nullable().optional().default(null),
  // Used when the mode is manual and the client pastes their own copy.
  suppliedCopy: longText.optional().default(""),
  toneOfVoice: optionalText,
});

/*
  F1, Website forms (1 October 2026, docs/plans/forms-email-domains.md):
  who gets the site's messages and what its forms ask. Nothing set means
  the standard form (Name, Phone, Email, Message) sent to the business
  email, as before.
*/
export const formFieldKeys = ["phone", "email", "message", "service", "address", "bestTime", "heardAbout", "photos", "emergency", "textConsent"] as const;
export type FormFieldKey = (typeof formFieldKeys)[number];

export const formsSchema = z.object({
  recipients: z
    .array(optionalShortText)
    .max(5)
    .optional()
    .default([])
    .transform((values) => values.map((v) => v.trim()).filter((v) => v.length > 0)),
  // Empty: the standard fields. Name is always on the form and isn't listed.
  fields: z
    .array(z.object({ key: z.enum(formFieldKeys), required: z.boolean().optional().default(false) }))
    .max(formFieldKeys.length)
    .optional()
    .default([]),
  // The Contact page's form becomes "Request a quote" with every field; the others stay short.
  quoteForm: optionalBoolean,
  thankYouLine: optionalText,
});

export const processSchema = z.object({
  scheduling: optionalText,
  quotingAndPricing: optionalText,
  // Only what the client actually offers. Nothing here is ever invented.
  guarantees: optionalText,
});

export const extrasSchema = z.object({
  currentOffers: optionalText,
  financingAvailable: optionalBoolean,
  // Things outside TAWD, for the "TAWD fit" check (fit.ts). Ticking one only warns.
  specialFeatures: z.array(z.enum(specialFeatureKeys)).max(10).optional().default([]),
  specialFeaturesNote: optionalText,
  // Booking, shop, portal and review links (integrations.ts). A link only, never a code snippet.
  integrations: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(integrationKinds),
        provider: optionalShortText,
        url: optionalUrl,
        embed: z.boolean().optional().default(false),
      }),
    )
    .max(20)
    .optional()
    .default([])
    // An empty row is what "Add a link" leaves before it's filled in.
    .transform((rows) => rows.filter((row) => row.url.length > 0 || row.provider.length > 0)),
});

export const intakeSectionKeys = [
  "business",
  "website",
  "services",
  "serviceAreas",
  "brand",
  "photos",
  "content",
  "forms",
  "process",
  "extras",
] as const;
export type IntakeSectionKey = (typeof intakeSectionKeys)[number];

export const sectionSchemas = {
  business: businessSchema,
  website: websiteSchema,
  services: servicesSchema,
  serviceAreas: serviceAreasSchema,
  brand: brandSchema,
  photos: photosSchema,
  content: contentSchema,
  forms: formsSchema,
  process: processSchema,
  extras: extrasSchema,
} as const;

/*
  A section nobody has opened yet is an empty section, not a missing one.

  Filling the gaps in before validating is what lets a row written months ago
  parse cleanly after a new question is added, with no migration.
*/
export const intakeSchema = z.preprocess((value) => {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const filled: Record<string, unknown> = {};
  for (const key of intakeSectionKeys) {
    filled[key] = source[key] ?? {};
  }
  return filled;
}, z.object(sectionSchemas));

export type IntakeData = z.infer<typeof intakeSchema>;

export const sectionLabels: Record<IntakeSectionKey, string> = {
  business: "Business",
  website: "Website",
  services: "Services",
  serviceAreas: "Service areas",
  brand: "Brand",
  photos: "Photos",
  content: "Content",
  forms: "Website forms",
  process: "Process",
  extras: "Extras",
};

/**
 * Parses whatever is in the database into a complete, well-formed intake.
 *
 * Old rows written before a field existed simply come back with that field at
 * its empty default, which is what makes adding a question migration-free.
 *
 * Section by section (13 October 2026, the whole-code review): a stored value
 * a later rule refuses empties only that field (or, failing that, only that
 * section), never the whole intake.
 */
export function parseIntake(raw: unknown): IntakeData {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of intakeSectionKeys) {
    out[key] = parseSection(key, source[key] ?? {});
  }
  return out as IntakeData;
}

function parseSection(key: IntakeSectionKey, value: unknown): unknown {
  const schema = sectionSchemas[key];
  const first = schema.safeParse(value);
  if (first.success) return first.data;
  // Drop the fields the rule refused and try once more.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const bad = new Set(first.error.issues.map((issue) => issue.path[0]).filter((p) => p !== undefined));
    const kept = Object.fromEntries(Object.entries(value).filter(([field]) => !bad.has(field)));
    const second = schema.safeParse(kept);
    if (second.success) return second.data;
  }
  return schema.parse({});
}

/** A blank intake, used for a project that has never been filled in. */
export function emptyIntake(): IntakeData {
  return intakeSchema.parse({});
}

/** Seven closed rows, so the hours form has something to render. */
export function emptyHours(): z.infer<typeof businessHoursSchema>[] {
  return dayNames.map((day) => ({ day, closed: false, open: "", close: "" }));
}
