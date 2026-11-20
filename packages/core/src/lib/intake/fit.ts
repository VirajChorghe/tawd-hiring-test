import type { IntakeData } from "./schema";

/*
  The "TAWD fit" check (Jason, 26 September 2026).

  TAWD builds fast, static websites for local service businesses. A few
  things are outside that: a full online store, member logins, complex
  animation, a custom web app. When the intake asks for one, the team sees
  it plainly as "Better as a custom VML build", with the reason. It only
  ever warns: the PM decides, and the project carries on either way.

  Two sources: the features ticked in Extras, and the intake's own words
  (services, process, offers, notes), for when nobody ticked anything. A
  link to the client's existing shop or portal is fine and is not flagged:
  those go under Integrations.
*/

export const specialFeatureKeys = [
  "online_store",
  "member_logins",
  "complex_animation",
  "custom_app",
] as const;
export type SpecialFeature = (typeof specialFeatureKeys)[number];

export const specialFeatureLabels: Record<SpecialFeature, string> = {
  online_store: "A full online store (products, a cart and checkout on the site)",
  member_logins: "Member or customer logins on the site",
  complex_animation: "Complex animation (3D, heavy scroll effects)",
  custom_app: "A custom web app or tool (calculators, dashboards, booking engines)",
};

const REASONS: Record<SpecialFeature, string> = {
  online_store: "a full online store needs a shop platform, stock and payments, which a TAWD site doesn't run",
  member_logins: "member logins need accounts and a server behind the site, which a TAWD site doesn't have",
  complex_animation: "complex animation is custom front-end work, outside TAWD's templates and speed rules",
  custom_app: "a custom web app is software, not a website",
};

const WORDS: Record<SpecialFeature, RegExp> = {
  online_store:
    /\b(online (?:store|shop)|e-?commerce|shopping cart|add to cart|sell (?:products|merch\w*|online)|product catalog(?:ue)? with (?:prices|checkout))\b/i,
  member_logins:
    /\b(members?(?:hip)? (?:login|log-in|area|portal|only)|(?:client|customer|patient|user) (?:logins?|log-ins?|accounts?)|log ?in (?:for|to) (?:their|an?) account|(?:clients|customers|patients|members) (?:can |could |to |will )?log ?in|password[- ]protected)\b/i,
  complex_animation:
    /\b(3d (?:model|animation|tour)\w*|webgl|three\.js|complex animations?|scroll(?:ing)? animations?|animated (?:intro|scroll))\b/i,
  custom_app:
    /\b(web app|custom (?:app|software|dashboard|calculator|tool)|(?:quote|price|cost) calculator|instant quote tool|booking engine)\b/i,
};

export interface FitWarning {
  title: "Better as a custom VML build";
  reasons: { feature: SpecialFeature; reason: string; source: string }[];
}

function intakeTexts(intake: IntakeData): { text: string; source: string }[] {
  return [
    ...intake.services.items.flatMap((s) => [
      { text: s.name, source: `the service "${s.name}"` },
      { text: s.description, source: `the service "${s.name}"` },
    ]),
    { text: intake.process.scheduling, source: "Process" },
    { text: intake.process.quotingAndPricing, source: "Process" },
    { text: intake.extras.currentOffers, source: "Extras" },
    { text: intake.extras.specialFeaturesNote, source: "Extras" },
    { text: intake.photos.notes, source: "Photos" },
    { text: intake.content.toneOfVoice, source: "Content" },
  ].filter((t) => t.text.trim().length > 0);
}

export function checkTawdFit(intake: IntakeData): FitWarning | null {
  const reasons: FitWarning["reasons"] = [];
  const texts = intakeTexts(intake);
  for (const feature of specialFeatureKeys) {
    if (intake.extras.specialFeatures.includes(feature)) {
      reasons.push({ feature, reason: REASONS[feature], source: "ticked in Extras" });
      continue;
    }
    const hit = texts.find((t) => WORDS[feature].test(t.text));
    if (hit) reasons.push({ feature, reason: REASONS[feature], source: `mentioned in ${hit.source}` });
  }
  return reasons.length > 0 ? { title: "Better as a custom VML build", reasons } : null;
}

export function describeFitWarning(warning: FitWarning): string {
  const parts = warning.reasons.map((r) => `${r.reason} (${r.source})`);
  return `This project asks for something outside TAWD: ${parts.join("; ")}. A PM should talk to the client about a custom VML build for that part. A warning only: TAWD can still build the rest.`;
}
