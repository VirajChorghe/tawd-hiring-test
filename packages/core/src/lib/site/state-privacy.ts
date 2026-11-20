import type { IntakeData } from "../intake/schema";
import { STATE_LAW_RULES } from "./policy-templates";

/*
  State privacy add-ons (28 September 2026). Every site has the national
  baseline policies (VML's templates); on top, a section for each state
  whose laws apply because the business's address, another of its
  locations, or its service areas are in that state. Each rule carries the
  law, who it applies to, the wording, its official source and the date it
  was last checked against that source. The rules live in
  docs/policies/state-laws.json and docs/policies/states/*.md (the source);
  the database keeps when an admin last checked each one.
*/

export interface StateLawRule {
  /** "CA-ccpa": the state and the law. */
  key: string;
  /** Two-letter code. */
  state: string;
  stateName: string;
  lawName: string;
  citation: string;
  appliesTo: string;
  /** Whether a small local service business is likely covered. */
  coverage: "yes" | "no" | "maybe";
  /** The add-on section, Markdown with the templates' {{fields}} and [[IF]] blocks; "" for a rule with no wording (a law that's not in force, or one the baseline covers). */
  addOn: string;
  sourceUrls: string[];
  /** YYYY-MM-DD: when it was last checked against its official source. */
  checkedOn: string;
  /** false when the official source couldn't be read (a mirror or a summary was used): it counts as unchecked until an admin checks it. */
  verified: boolean;
  /** Only for projects under the health and beauty rules. */
  healthOnly?: boolean;
  notes?: string;
}

export const STATE_LAWS: StateLawRule[] = STATE_LAW_RULES as StateLawRule[];

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/* "NV", "Nevada", "nevada" or the state at the end of "Reno, NV" / "Washoe County, Nevada" → "NV". */
export function stateCode(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (US_STATES[upper]) return upper;
  const byName = Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === t.toLowerCase());
  if (byName) return byName[0];
  const tail = t.split(",").pop()!.trim().replace(/\s+\d{5}(-\d{4})?$/, "");
  if (tail !== t) return stateCode(tail);
  return null;
}

/* The states a project is in: its address, its other locations, and its service areas. */
export function projectStates(intake: IntakeData): string[] {
  const found = new Set<string>();
  const add = (text: string | null | undefined) => {
    const code = text ? stateCode(text) : null;
    if (code) found.add(code);
  };
  add(intake.business.state);
  for (const l of intake.business.locations) add(l.state);
  // Only the scope the PM chose counts (an earlier choice's list can linger in the intake).
  const areas = intake.serviceAreas;
  const scope = areas.scope ?? "cities";
  if (scope === "states") for (const s of areas.states) add(s);
  if (scope === "cities") for (const c of areas.cities) add(c);
  if (scope === "counties") for (const c of areas.counties) add(c);
  if (scope === "radius") add(areas.radius.address);
  // A TV market's name ends with its states ("Reno NV", "Sacramento-Stockton-Modesto CA").
  if (scope === "dmas") for (const d of areas.dmas) for (const code of d.name.match(/\b[A-Z]{2}\b/g) ?? []) add(code);
  // Nationwide: every state with rules.
  if (scope === "nationwide") for (const r of STATE_LAWS) found.add(r.state);
  return [...found].sort();
}

/*
  Operational consent rules, per state (Consent PR1; Jason, 8 November 2026:
  Option B — the law lives in ONE place, this table, keyed off the states the
  intake captures via projectStates(); nothing is hardcoded in the banner).
  Each rule says how the consent banner must BEHAVE in that state, as opposed
  to STATE_LAWS above, which holds policy WORDING. California's values follow
  the CCPA regulations in force for 2026: an opt-out model; Global Privacy
  Control honored as a valid opt-out request (§7025); the choices offered with
  symmetry, accept no more prominent than decline (§7004); "Opt-Out Request
  Honored" displayed once an opt-out is processed (§7025(c)(6)); and a
  persistent "Your Privacy Choices" link on every page. A state with no entry
  gets the strictest rule in the table, as does a project with no state at
  all — the safe floor everywhere.
*/
export interface ConsentRule {
  /** The weakest banner mode the law allows: "opt_in" means nothing may load before an accept; the team may always choose stricter. */
  floor: "opt_in" | "opt_out";
  /** Global Privacy Control counts as an opt-out (an explicit later accept still wins). */
  honorGpc: boolean;
  /** Accept and decline equally prominent (CA §7004 symmetry). */
  symmetricalButtons: boolean;
  /** Show "Opt-Out Request Honored" once an opt-out (clicked or via GPC) is processed (CA §7025(c)(6)). */
  optOutHonoredNotice: boolean;
  /** A persistent "Your Privacy Choices" link on every page. */
  privacyChoicesLink: boolean;
}

export const STATE_CONSENT_RULES: Record<string, ConsentRule> = {
  CA: { floor: "opt_out", honorGpc: true, symmetricalButtons: true, optOutHonoredNotice: true, privacyChoicesLink: true },
};

/* The strictest value of each dimension across the given rules. */
const strictest = (rules: ConsentRule[]): ConsentRule => ({
  floor: rules.some((r) => r.floor === "opt_in") ? "opt_in" : "opt_out",
  honorGpc: rules.some((r) => r.honorGpc),
  symmetricalButtons: rules.some((r) => r.symmetricalButtons),
  optOutHonoredNotice: rules.some((r) => r.optOutHonoredNotice),
  privacyChoicesLink: rules.some((r) => r.privacyChoicesLink),
});

/*
  The rule a project's site must follow: the strictest of its states' rules.
  No state captured, or none with an entry → the strictest rule in the whole
  table (Jason, 8 November 2026: strictest-state fallback).
*/
export function consentRuleFor(states: string[]): ConsentRule {
  const known = states.map((s) => STATE_CONSENT_RULES[s]).filter((r): r is ConsentRule => Boolean(r));
  return strictest(known.length ? known : Object.values(STATE_CONSENT_RULES));
}

/* The add-on sections for these states, in state-name order; a health-only rule only for health projects. */
export function stateAddOns(states: string[], options: { health: boolean } = { health: false }): StateLawRule[] {
  const wanted = new Set(states);
  return STATE_LAWS.filter((r) => wanted.has(r.state) && r.addOn.trim() && (!r.healthOnly || options.health)).sort(
    (a, b) => a.stateName.localeCompare(b.stateName) || STATE_LAWS.indexOf(a) - STATE_LAWS.indexOf(b),
  );
}

export const REVIEW_EVERY_DAYS = 90;

/* The rules for these states not checked within three months (their check date is the later of the repo's and an admin's). */
export function staleRules(states: string[], checked: Record<string, Date | null>, now: Date = new Date()): StateLawRule[] {
  const wanted = new Set(states);
  const limit = now.getTime() - REVIEW_EVERY_DAYS * 86_400_000;
  return STATE_LAWS.filter((r) => wanted.has(r.state)).filter((r) => lastChecked(r, checked[r.key] ?? null).getTime() < limit);
}

export function lastChecked(rule: StateLawRule, byAdmin: Date | null): Date {
  const fromRepo = rule.verified ? new Date(`${rule.checkedOn}T12:00:00Z`) : new Date(0);
  return byAdmin && byAdmin > fromRepo ? byAdmin : fromRepo;
}
