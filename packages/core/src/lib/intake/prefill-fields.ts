/*
  The intake fields that "Pre-fill the intake from the design" can fill,
  with their names in words. Kept apart from the reading and saving code so
  screens and History can use the names without either.
*/

export const PREFILL_LABELS = {
  "business.name": "Business name",
  "business.phone": "Phone",
  "business.email": "Email",
  "business.streetAddress": "Street address",
  "business.city": "City",
  "business.state": "State",
  "business.locations": "Other locations",
  "business.licenseNumbers": "License number",
  "business.yearFounded": "Year founded",
  "services.items": "Services",
  "serviceAreas.cities": "Service areas",
  // Read only from the current site's own words, never a Figma design (site-prefill.ts, #1b).
  "process.guarantees": "Guarantees",
  "extras.currentOffers": "Current offers",
  "extras.financingAvailable": "Financing available",
} as const;

export type PrefillKey = keyof typeof PREFILL_LABELS;

export const PREFILL_KEYS = Object.keys(PREFILL_LABELS) as PrefillKey[];

/*
  Keys a Figma design can never supply, only the current site's words (#1b,
  7 November 2026): a stated warranty, a free offer, financing. The "pre-fill
  from the design" flow leaves these out of what it reports as not found.
*/
export const SITE_ONLY_PREFILL_KEYS = [
  "process.guarantees",
  "extras.currentOffers",
  "extras.financingAvailable",
] as const satisfies readonly PrefillKey[];
