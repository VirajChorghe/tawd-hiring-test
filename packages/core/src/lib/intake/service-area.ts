/*
  Where the business works (the founders' request, 25 September 2026): a
  list of cities or towns (as before), whole states, the whole country, or
  a radius around an address; and (Todd's request, 26 September 2026)
  counties, or DMAs (TV and ad markets, from DataForSEO's free locations
  list, loaded once by an admin; each chosen market is kept whole in the
  intake). One description of it in words, for the
  mockup prompts and the facts ("Serving all of Nevada"), and one for SEO
  (schema.org areaServed: cities, states or the country).

  No database here: the intake form uses it in the browser.
*/

export const serviceAreaScopes = ["cities", "counties", "states", "dmas", "nationwide", "radius"] as const;
export type ServiceAreaScope = (typeof serviceAreaScopes)[number];

export const SERVICE_AREA_SCOPE_LABELS: Record<ServiceAreaScope, string> = {
  cities: "Specific cities or towns",
  counties: "Counties",
  states: "Whole state(s)",
  dmas: "DMA (TV and ad market)",
  nationwide: "Nationwide (USA)",
  radius: "A radius around an address",
};

export const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
] as const;
export type UsStateCode = (typeof US_STATES)[number][0];
export const US_STATE_CODES = US_STATES.map(([code]) => code) as unknown as [UsStateCode, ...UsStateCode[]];
const STATE_NAMES = new Map<string, string>(US_STATES.map(([code, name]) => [code, name]));

/* A US DMA as DataForSEO lists it: its location code, name ("Reno NV") and full location name, which its lookups take. */
export interface Dma {
  id: string;
  name: string;
  canonical: string;
}

export interface ServiceAreaInput {
  scope: ServiceAreaScope | null;
  cities: string[];
  /** "Washoe County, NV", as the team writes them. */
  counties?: string[];
  states: string[];
  /** The chosen markets, each kept whole (DataForSEO's list). */
  dmas?: Dma[];
  radius: { miles: number | null; address: string };
}

/* Cities is the scope when none was chosen: every intake before the choice existed. */
export const scopeOf = (areas: ServiceAreaInput): ServiceAreaScope => areas.scope ?? "cities";

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/* Whether the answer is complete enough to build from. */
export function hasServiceArea(areas: ServiceAreaInput): boolean {
  switch (scopeOf(areas)) {
    case "cities":
      return areas.cities.length > 0;
    case "counties":
      return (areas.counties ?? []).length > 0;
    case "states":
      return areas.states.length > 0;
    case "dmas":
      return (areas.dmas ?? []).length > 0;
    case "nationwide":
      return true;
    case "radius":
      return Boolean(areas.radius.miles && areas.radius.miles > 0 && areas.radius.address.trim());
  }
}

/*
  The service area in words, as the site should say it: "Reno, Sparks and
  Carson City", "All of Nevada and California", "Nationwide across the
  USA", "Within 50 miles of 4105 Kietzke Ln, Reno, NV". Null when it isn't
  answered yet.
*/
export function describeServiceArea(areas: ServiceAreaInput): string | null {
  if (!hasServiceArea(areas)) return null;
  switch (scopeOf(areas)) {
    case "cities":
      return list(areas.cities);
    case "counties":
      return list(areas.counties ?? []);
    case "states":
      return `All of ${list(areas.states.map((code) => STATE_NAMES.get(code) ?? code))}`;
    case "dmas":
      return `The ${list((areas.dmas ?? []).map((d) => d.name))} area${(areas.dmas ?? []).length === 1 ? "" : "s"}`;
    case "nationwide":
      return "Nationwide across the USA";
    case "radius":
      return `Within ${areas.radius.miles} miles of ${areas.radius.address.trim()}`;
  }
}

/* The line for the builder: what to say on the page, in the business's own terms. */
export function serviceAreaGuidance(areas: ServiceAreaInput): string | null {
  const words = describeServiceArea(areas);
  if (!words) return null;
  switch (scopeOf(areas)) {
    case "cities":
      return `${words} (name these places; don't add others)`;
    case "counties":
      return `${words} (name these counties; don't list towns the client didn't name)`;
    case "dmas":
      return `${words} (a TV and ad market: name the area in plain words, for example "the Reno area"; don't list towns the client didn't name)`;
    case "states":
      return `${words} (the whole state${areas.states.length === 1 ? "" : "s"}: say "Serving all of ${list(areas.states.map((c) => STATE_NAMES.get(c) ?? c))}", and don't list towns the client didn't name)`;
    case "nationwide":
      return `${words} (say "Serving customers nationwide" or "across the USA"; don't list states or towns)`;
    case "radius":
      return `${words} (say "Serving the area within ${areas.radius.miles} miles of" the town, and don't list towns the client didn't name)`;
  }
}

/*
  schema.org areaServed for the site's LocalBusiness data (the build, Phase
  8): each city, each state, the country, or a circle around the address.
*/
export function areaServed(areas: ServiceAreaInput): Record<string, unknown>[] {
  if (!hasServiceArea(areas)) return [];
  switch (scopeOf(areas)) {
    case "cities":
      return areas.cities.map((name) => ({ "@type": "City", name }));
    case "counties":
      return (areas.counties ?? []).map((name) => ({ "@type": "AdministrativeArea", name }));
    case "dmas":
      return (areas.dmas ?? []).map((d) => ({ "@type": "AdministrativeArea", name: `${d.name} area` }));
    case "states":
      return areas.states.map((code) => ({ "@type": "State", name: STATE_NAMES.get(code) ?? code }));
    case "nationwide":
      return [{ "@type": "Country", name: "United States" }];
    case "radius":
      return [
        {
          "@type": "GeoCircle",
          geoMidpoint: { "@type": "Place", address: areas.radius.address.trim() },
          // schema.org measures a GeoCircle's radius in metres.
          geoRadius: Math.round(areas.radius.miles! * 1609.344),
        },
      ];
  }
}

/* A page per place only exists for a list of cities or counties: only they count toward Growth. */
export function wantsCityPages(areas: ServiceAreaInput & { wantsIndividualCityPages: boolean | null }): boolean {
  return (scopeOf(areas) === "cities" || scopeOf(areas) === "counties") && areas.wantsIndividualCityPages === true;
}
