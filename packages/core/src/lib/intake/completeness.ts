import type { IntakeData } from "./schema";
import { hasServiceArea } from "./service-area";
import { phoneProblem } from "../phone";
import { hasCurrentWebsite, projectTypeOf } from "./project-type";

/*
  What "complete enough to start building" means.

  These are the questions a mockup cannot be built without. Everything else on
  the form is useful but optional, and anything missing later shows up on the
  page as a visible [PLACEHOLDER] rather than being quietly invented
  (TAWD-PROFILE house rules 2 to 4).
*/

export interface IntakeFileSummary {
  kind: string;
  status: string;
}

export interface CompletenessInput {
  /** The trade lives on the project record, so it is not asked twice. */
  projectTrade: string | null;
  /** The project's lane: Lane 2 takes its words from the design and has no project type. */
  projectLane?: string | null;
  intake: IntakeData;
  files: IntakeFileSummary[];
}

export interface Requirement {
  key: string;
  label: string;
  /** Which section of the form to go and fix it in. */
  section: string;
  /*
    Why this answer matters, shown under the field when it is missing.

    A field that just says "Missing" invites someone to type anything to make
    the amber go away. Saying where the answer ends up on the finished site
    makes it obvious why a guess would be worse than a gap.
  */
  whyItMatters: string;
  /** The input to focus when somebody clicks this in the Required info card. */
  fieldId: string;
  /*
    A missing item that stops Design and Generate, even with "Continue without these"
    (Jason, 30 September 2026). Only the current website, for now.
  */
  blocking?: boolean;
}

export interface CompletenessResult {
  requirements: Requirement[];
  missing: Requirement[];
  satisfiedCount: number;
  totalCount: number;
  /** 0 to 100, rounded. */
  percent: number;
  isComplete: boolean;
}

/*
  Trades whose work needs a state license, so the site should show one.
  Legal, med spa, the creative trades (interior design, art and decorative
  finishes, photography) and "other" have no license requirement here.
  Architecture and remodeling does: an architect's or contractor's license.
*/
const UNLICENSED_TRADES = ["legal", "med_spa", "interior_design", "art_decorative_finishes", "photography", "other"];

export function isLicensedTrade(trade: string | null): boolean {
  return Boolean(trade) && !UNLICENSED_TRADES.includes(trade!);
}

function hasLogo(files: IntakeFileSummary[]): boolean {
  return files.some((f) => f.kind === "logo" && f.status === "ready");
}

interface Rule extends Requirement {
  isSatisfied: (input: CompletenessInput) => boolean;
  /** When the question applies at all; every project if left out. */
  appliesTo?: (input: CompletenessInput) => boolean;
}

export const requirementIds = {
  businessName: "intake-business-name",
  businessPhone: "intake-business-phone",
  googleBusinessProfile: "intake-business-gbp",
  licenseNumber: "intake-business-license",
  yearFounded: "intake-business-year",
  address: "intake-business-street",
  services: "intake-services-first",
  serviceAreas: "intake-areas-add",
  logo: "intake-brand-logo",
  trade: "intake-business-name",
  currentWebsite: "intake-website-current",
  projectType: "intake-content-type",
} as const;

const RULES: Rule[] = [
  {
    key: "website.current",
    label: "Current website, or No current website",
    section: "website",
    whyItMatters: "Missing. Design can't start without it: it decides where the mockup's words come from.",
    fieldId: requirementIds.currentWebsite,
    blocking: true,
    isSatisfied: ({ intake }) => intake.website.currentWebsiteUrl.length > 0 || intake.website.noCurrentWebsite === true,
  },
  {
    // The project type (0.100.0): with a current website, Design can't start until it's chosen.
    key: "content.projectType",
    label: "Project type",
    section: "content",
    whyItMatters: "Missing. With a current website, choose Design only, Design + content, Everything new or the client's own words: it decides the steps and where the words come from.",
    fieldId: requirementIds.projectType,
    blocking: true,
    appliesTo: ({ intake, projectLane }) => projectLane !== "lane_2" && hasCurrentWebsite(intake.website),
    isSatisfied: ({ intake, projectLane }) => projectTypeOf({ lane: projectLane, mode: intake.content.mode, hasCurrentWebsite: true }) !== null,
  },
  {
    key: "business.name",
    label: "Business name",
    section: "business",
    whyItMatters: "Missing. Used in the hero, the footer and the page titles.",
    fieldId: requirementIds.businessName,
    isSatisfied: ({ intake }) => intake.business.name.length > 0,
  },
  {
    key: "business.phone",
    label: "Phone number",
    section: "business",
    whyItMatters: "Missing, or not a US phone number (10 digits). This becomes the tap-to-call link a visitor uses first.",
    fieldId: requirementIds.businessPhone,
    isSatisfied: ({ intake }) => intake.business.phone.length > 0 && phoneProblem(intake.business.phone) === null,
  },
  {
    key: "project.trade",
    label: "Trade",
    section: "business",
    whyItMatters: "Missing. Set on the project, and it decides the design directions.",
    fieldId: requirementIds.trade,
    isSatisfied: ({ projectTrade }) => Boolean(projectTrade),
  },
  {
    key: "services.atLeastOne",
    label: "At least one service",
    section: "services",
    whyItMatters: "Missing. There is no homepage without at least one service.",
    fieldId: requirementIds.services,
    isSatisfied: ({ intake }) => intake.services.items.length > 0,
  },
  {
    key: "serviceAreas.atLeastOne",
    label: "At least one service area",
    section: "serviceAreas",
    whyItMatters: "Missing. Names the real cities, states or area in the service-area section.",
    fieldId: requirementIds.serviceAreas,
    isSatisfied: ({ intake }) => hasServiceArea(intake.serviceAreas),
  },
  {
    key: "business.licenseNumber",
    label: "License number",
    section: "business",
    whyItMatters: "Missing. Shown in the trust band and footer. Never invented.",
    fieldId: requirementIds.licenseNumber,
    isSatisfied: ({ intake }) =>
      intake.business.licenseNumbers.length > 0 || intake.business.licenseInProgress,
    // Only licensed trades are asked; see isLicensedTrade.
    appliesTo: ({ projectTrade }) => isLicensedTrade(projectTrade),
  },
  {
    key: "business.yearFounded",
    label: "Year founded",
    section: "business",
    whyItMatters: "Missing. Never estimated, so the site cannot claim it otherwise.",
    fieldId: requirementIds.yearFounded,
    isSatisfied: ({ intake }) => intake.business.yearFounded !== null,
  },
  {
    key: "business.googleBusinessProfileUrl",
    label: "Google Business Profile link",
    section: "business",
    whyItMatters: "Missing. Needed for reviews, the map and the schema markup.",
    fieldId: requirementIds.googleBusinessProfile,
    isSatisfied: ({ intake }) =>
      intake.business.googleBusinessProfileUrl.length > 0 ||
      intake.business.noGoogleBusinessProfile,
  },
  {
    key: "brand.logo",
    label: "Logo",
    section: "brand",
    whyItMatters: "Missing. Every concept needs it before a mockup can be rendered.",
    fieldId: requirementIds.logo,
    isSatisfied: ({ files }) => hasLogo(files),
  },
  {
    key: "business.address",
    // A service-area business has no address to publish, so ticking that box
    // answers this requirement rather than skipping it.
    label: "Street address, or the service-area business box ticked",
    section: "business",
    whyItMatters: "Missing. Name, address and phone must match the Business Profile exactly.",
    fieldId: requirementIds.address,
    isSatisfied: ({ intake }) =>
      intake.business.isServiceAreaBusiness ||
      intake.business.streetAddress.length > 0,
  },
];

export function assessCompleteness(
  input: CompletenessInput,
): CompletenessResult {
  const strip = ({ key, label, section, whyItMatters, fieldId, blocking }: Rule) => ({
    key,
    label,
    section,
    whyItMatters,
    fieldId,
    // Only the item nothing can skip carries the flag.
    ...(blocking ? { blocking: true } : {}),
  });

  const rules = RULES.filter((rule) => !rule.appliesTo || rule.appliesTo(input));
  const requirements = rules.map(strip);
  const missing = rules.filter((rule) => !rule.isSatisfied(input)).map(strip);

  const totalCount = rules.length;
  const satisfiedCount = totalCount - missing.length;

  return {
    requirements,
    missing,
    satisfiedCount,
    totalCount,
    percent: Math.round((satisfiedCount / totalCount) * 100),
    isComplete: missing.length === 0,
  };
}

/*
  What the founders must see at the go-live check. It never blocks design
  work: a licensed trade without a license number yet can have its mockups,
  content and build, but cannot quietly go live without one.
*/
export interface GoLiveFlag {
  key: string;
  label: string;
  line: string;
}

export function goLiveFlags(input: CompletenessInput): GoLiveFlag[] {
  const flags: GoLiveFlag[] = [];
  if (isLicensedTrade(input.projectTrade) && input.intake.business.licenseNumbers.length === 0) {
    flags.push({
      key: "business.licenseNumber",
      label: "License number",
      line: input.intake.business.licenseInProgress
        ? "The license is in progress. A licensed trade shows its license number before going live."
        : "No license number yet. A licensed trade shows its license number before going live.",
    });
  }
  return flags;
}
