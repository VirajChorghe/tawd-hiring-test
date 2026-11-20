/*
  The mechanical checks every concept has to pass.

  These run on the built HTML before a human ever sees it. They are
  deliberately the checks a machine can actually settle - counting, matching,
  measuring contrast - and nothing that needs judgment. Judgment is the
  Creative Director's job in 3b, and the team's after that.

  The most important group is the house rules from TAWD-PROFILE section 7.
  Be clear about what they can and cannot prove: TAWD cannot detect every
  invented sentence. What it can prove is that every phone number, license
  number, founding year and review count on the page either matches the
  intake exactly or sits inside a visible [PLACEHOLDER: ...]. That is the
  category the house rules name, and it is checkable.
*/

import { checkPictures } from "./pictures";
import { siteFeatureIssues, type SiteFeature } from "./site-features";
import { checkIcons } from "./icons";
import { checkPageIntegrity } from "./page-integrity";
import { checkPageRules } from "./page-checks";
import { checkAssets, type PageAsset } from "./assets";
import {
  checkPlaceholderRule,
  checkPlaceholdersAgainstIntake,
  type IntakeFact,
} from "./facts";
import { findClaimIssues, type ClaimFacts } from "./claims";
import { factIssues, type ConfirmedFacts } from "./confirmed-facts";

/*
  fail: must be fixed before the concept is client-ready.
  warn: worth a look; never blocks.
  info: true, but not a problem for a desktop mockup (for example the 44px
  tap-target rule, which is checked on mobile in the WordPress build).
*/
export type CheckSeverity = "fail" | "warn" | "info";

/** Automatic fix rounds after the first build, each followed by a re-check. */
export const MAX_FIX_ROUNDS = 2;

/*
  A concept step's states. "failed" is shown as "Didn't finish" and
  "not_run" as "Not run" (9 November 2026): when a run stops, the step that
  was running didn't finish, while the ones after it never started.
  SETTLED_STEPS is every state a step no longer moves on from — the
  progress bar, the step's finishedAt and the re-run picker all read it, so
  a new state is added here once rather than missed in three places.

  "needs_fixes" is the state that was missing (Jason's run, 10 November
  2026). The checks step was being written as "failed" whenever the page
  still had something to fix, so the screen said "Didn't finish" on both of
  New Dawn's concepts - on a run that produced two finished, reviewed
  pages. The step did finish; what it found was a page with fixes
  outstanding, which is a normal outcome and the team's decision.

  It had to be its own state rather than "done", because "failed" is also
  what let the team run that step again (RERUNNABLE_STEPS), and because a
  page with failing checks is not a page that passed.
*/
export const SETTLED_STEPS = ["done", "skipped", "failed", "not_run", "needs_fixes"] as const;
export const UNSETTLED_STEPS = ["waiting", "working"] as const;
/** The states a re-run may reset: anything that didn't reach "done". */
export const RERUNNABLE_STEPS = ["failed", "not_run", "waiting", "working", "needs_fixes"] as const;


export interface CheckIssue {
  id: string;
  severity: CheckSeverity;
  message: string;
  /** Where to look, when the check can say. */
  where?: string;
  /*
    Set when only the client can fix it: the intake is missing the fact the
    check needs (no phone number to make a tap-to-call link from, say). Such
    issues are shown as "needs intake info" and never get a fix round.
  */
  needsIntake?: boolean;
  /** The bands of the page it is in, when a rendered check can tell. */
  sections?: number[];
  /** Text on the page that shows where it is, for finding its band. */
  evidence?: string;
}

/** Whether an automatic fix round should be spent on this issue. */
export function isFixable(issue: CheckIssue): boolean {
  return issue.severity === "fail" && !issue.needsIntake;
}

export interface CheckOutcome {
  passed: boolean;
  issues: CheckIssue[];
  placeholderCount: number;
}

export interface CheckFacts {
  /** Exactly as the intake holds them. Anything else is invented. */
  phones: string[];
  licenseNumbers: string[];
  yearFounded: number | null;
  businessName: string;
  cities: string[];
  /*
    Everything the intake knows, so a placeholder standing in for a filled
    field is caught. Optional so a check can run without a whole intake.
  */
  intakeFacts?: IntakeFact[];
  /** The uploaded images the page was given tokens for. */
  assets?: PageAsset[];
  /** The intake's service names, for the render check's "services are on the page" (27 September 2026). */
  serviceNames?: string[];
  /*
    The picture rules (8 October 2026: which bands get stock, every frame
    asked for, a hero with a picture), for TAWD's own concepts; never for a
    copy of the designer's design.
  */
  pictures?: { stockAvailable: boolean; brandColors?: string[]; trade?: string };
  /** What the client's current website has (5 November 2026): each must be on the page, or left out with a reason. */
  siteFeatures?: SiteFeature[];
  /**
   * Intake facts a "[PLACEHOLDER: ... to confirm with the client]" may stand
   * for: a rating or licence the current site shows, a testimonial copied from it.
   */
  confirmablePlaceholders?: string[];
  /**
   * The intake's offer facts (gap 12), so a warranty, free consultation or
   * financing on the page is checked against what the client actually gave.
   */
  claims?: ClaimFacts;
  /** The project's confirmed facts (B1, confirmed-facts.ts): the call buttons, prices, years, addresses, towns, names and ratings are checked against them. */
  confirmed?: ConfirmedFacts;
}

export const PLACEHOLDER_PATTERN = /\[PLACEHOLDER:[^\]]*\]/gi;

/** Digits only, so "(916) 555-0147" and "916-555-0147" compare equal. */
function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/*
  Phrases TAWD-PROFILE house rule 5 rules out, plus the review-shaped
  language that tends to accompany an invented testimonial.
*/
const BANNED_FILLER = [
  "elevate",
  "seamless",
  "unleash",
  "revolutionize",
  "revolutionise",
  "cutting-edge",
  "world-class",
  "lorem ipsum",
];

const REVIEW_SHAPED = [
  /\b\d(?:\.\d)?\s*(?:out of|\/)\s*5\b/i,
  /\b\d{2,}\s*(?:five[- ]star|5[- ]star)\s*reviews?\b/i,
  /\b(?:rated|rating of)\s*\d(?:\.\d)?\b/i,
];

export function runHtmlChecks(html: string, facts: CheckFacts): CheckOutcome {
  const issues: CheckIssue[] = [];
  const text = stripTags(html);

  const placeholders = html.match(PLACEHOLDER_PATTERN) ?? [];
  const placeholderCount = placeholders.length;

  /* ---------- structure ---------- */

  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  if (h1Count === 0) {
    issues.push({
      id: "structure.h1.missing",
      severity: "fail",
      message: "The page has no H1. Every page needs exactly one.",
    });
  } else if (h1Count > 1) {
    issues.push({
      id: "structure.h1.multiple",
      severity: "fail",
      message: `The page has ${h1Count} H1 headings. It should have exactly one.`,
    });
  }

  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  if (title.length === 0) {
    issues.push({
      id: "seo.title.missing",
      severity: "fail",
      message: "The page has no title.",
    });
  } else if (title.length > 60) {
    // A fail, so the fix round shortens it: search results cut it off.
    issues.push({
      id: "seo.title.long",
      severity: "fail",
      message: `The title is ${title.length} characters; it must be 60 or fewer.`,
    });
  }

  const description =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(
      html,
    )?.[1] ?? "";
  if (description.length === 0) {
    issues.push({
      id: "seo.description.missing",
      severity: "warn",
      message: "The page has no meta description.",
    });
  } else if (description.length > 160) {
    issues.push({
      id: "seo.description.long",
      severity: "warn",
      message: `The meta description is ${description.length} characters; it should be 160 or fewer.`,
    });
  }

  /* ---------- the conversion floor ---------- */

  const telLinks = html.match(/href=["']tel:([^"']+)["']/gi) ?? [];
  if (telLinks.length === 0) {
    issues.push({
      id: "conversion.tel.missing",
      severity: "fail",
      message:
        "No tap-to-call link. The phone number must be a tel: link, not just text.",
    });
  }

  const hasForm = /<form\b/i.test(html);
  if (!hasForm) {
    issues.push({
      id: "conversion.form.missing",
      severity: "fail",
      message: "No lead form on the page.",
    });
  }

  /* ---------- labeled fields ---------- */

  const inputs = html.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? [];
  const unlabelled = inputs.filter((tag) => {
    if (/type=["'](?:hidden|submit|button)["']/i.test(tag)) return false;
    if (/aria-label=/i.test(tag) || /aria-labelledby=/i.test(tag)) return false;
    const id = /\bid=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!id) return true;
    // The id comes from the page, so it is matched as plain text, never as a pattern.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`<label[^>]+for=["']${escaped}["']`, "i").test(html);
  });
  if (unlabelled.length > 0) {
    issues.push({
      id: "a11y.labels",
      severity: "fail",
      message: `${unlabelled.length} form ${unlabelled.length === 1 ? "field has" : "fields have"} no label; every field needs a <label for> or an aria-label.`,
    });
  }

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = images.filter((tag) => !/\balt=/i.test(tag));
  if (missingAlt.length > 0) {
    issues.push({
      id: "a11y.alt",
      severity: "fail",
      message: `${missingAlt.length} ${missingAlt.length === 1 ? "image has" : "images have"} no alt text.`,
    });
  }

  /* ---------- house rules ---------- */

  issues.push(...checkInventedFacts(html, text, facts));
  // B1: the wider fact check (report-only until FACT_CHECKS_BLOCK); a rating the older check already failed is not said twice.
  if (facts.confirmed) {
    const reviewsFailed = issues.some((i) => i.id === "house.reviews.invented");
    issues.push(...factIssues(html, facts.confirmed).filter((i) => !(reviewsFailed && i.id === "facts.rating")));
  }

  // Invented or over-stated claims the number check can't see (gap 12): a warranty, free offer or financing not backed by the intake, and superlatives.
  if (facts.claims) issues.push(...findClaimIssues(html, facts.claims));

  if (facts.intakeFacts) {
    issues.push(...checkPlaceholdersAgainstIntake(html, facts.intakeFacts));
    issues.push(...checkPlaceholderRule(html, facts.intakeFacts, facts.confirmablePlaceholders ?? []));
  }
  if (facts.siteFeatures) issues.push(...siteFeatureIssues(html, facts.siteFeatures));

  if (facts.pictures) issues.push(...checkPictures(html, facts.pictures));
  // Jason's comments on the official run's concept (8 October 2026), on TAWD's own concepts.
  if (facts.pictures) issues.push(...checkPageRules(html, { businessName: facts.businessName, cities: facts.cities, phones: facts.phones, yearFounded: facts.yearFounded, licenseNumbers: facts.licenseNumbers, keepReviewsToConfirm: (facts.confirmablePlaceholders ?? []).includes("page.reviews") }));
  // Empty icon slots, on any page: code fills them (8 October 2026).
  issues.push(...checkIcons(html));
  /*
    Is it still a page? (9 November 2026.) A document cut short, a band
    container never closed, two elements with the same id, or the same band
    shown twice. Every other check here asks whether something is present,
    and all of them pass on a page that is nothing but its hero.
  */
  issues.push(...checkPageIntegrity(html));

  for (const word of BANNED_FILLER) {
    if (new RegExp(`\\b${word}\\b`, "i").test(text)) {
      issues.push({
        id: `house.filler.${word}`,
        severity: "warn",
        evidence: word,
        message: `The copy uses "${word}". House rule 5: plain, specific copy, no filler.`,
      });
    }
  }

  /* ---------- images ---------- */

  const remoteImages = images.filter((tag) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    return /^https?:\/\//i.test(src) && !/fonts\.(googleapis|gstatic)\.com/i.test(src);
  });
  if (remoteImages.length > 0) {
    issues.push({
      id: "images.remote",
      severity: "fail",
      message: `${remoteImages.length} image${remoteImages.length === 1 ? "" : "s"} loaded from the internet. Mockups use the client's uploaded images or labeled placeholder frames, never random stock URLs.`,
    });
  }

  if (facts.assets) {
    issues.push(...checkAssets(html, facts.assets));
  }

  return {
    passed: issues.every((issue) => issue.severity !== "fail"),
    issues,
    placeholderCount,
  };
}

/*
  The invented-facts check.

  Each category is only allowed to contain values the intake supplied. A
  number that appears nowhere in the intake and is not wrapped in a visible
  placeholder is, by definition, made up.
*/
function checkInventedFacts(
  html: string,
  text: string,
  facts: CheckFacts,
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  // Text with the placeholders removed: anything inside one is declared
  // missing rather than claimed, which is exactly what we want.
  const claimed = stripTags(html.replace(PLACEHOLDER_PATTERN, " "));

  const allowedPhones = new Set(facts.phones.map(digits).filter(Boolean));
  const licenceDigits = new Set(facts.licenseNumbers.map(digits).filter((d) => d.length >= 4));
  /*
    Phone-shaped only: an optional +1, three digits, three, four, never
    glued to other digits. A run of digits is not a phone number: "Since
    1981 775-238-9814" is a year and a number, not one 14-digit phone.
  */
  for (const found of claimed.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g)) {
    const candidate = found[0];
    const value = digits(candidate);
    if (value.length < 10) continue;
    // A license number is not a phone number: the intake's own license, or
    // any number written just after "License", "Lic." or "CSLB".
    if (licenceDigits.has(value)) continue;
    const before = claimed.slice(Math.max(0, found.index - 30), found.index);
    if (/\b(?:licen[cs]e[ds]?|lic\.?|cslb)(?:\s+(?:no\.?|number))?[\s:#.-]*$/i.test(before)) continue;
    const known = [...allowedPhones].some(
      (allowed) => value.endsWith(allowed) || allowed.endsWith(value),
    );
    if (!known) {
      issues.push({
        id: "house.phone.invented",
        severity: "fail",
        evidence: candidate.trim(),
        message: `The page shows the phone number "${candidate.trim()}", which is not the one from the intake. House rule 3: contact details come only from the intake form.`,
      });
    }
  }

  if (facts.yearFounded === null) {
    // Nothing to stand behind, so any "since 1998" is invented.
    const since = /\b(?:since|established|serving\D{0,20}since|est\.?)\s*(1[89]\d{2}|20\d{2})\b/i.exec(
      claimed,
    );
    if (since) {
      issues.push({
        id: "house.year.invented",
        severity: "fail",
        evidence: since[0],
        message: `The page claims "${since[0]}" but the intake has no founding year. House rule 2: no invented facts.`,
      });
    }
  }

  for (const pattern of REVIEW_SHAPED) {
    const found = pattern.exec(claimed);
    if (found) {
      issues.push({
        id: "house.reviews.invented",
        severity: "fail",
        evidence: found[0],
        message: `The page states "${found[0]}". Ratings and review counts must come from the intake or be a visible placeholder. House rules 1 and 2.`,
      });
    }
  }

  // License numbers are distinctive enough to match directly.
  /*
    "License: 6291155686", "Lic. #C57-998877", "CSLB 1234567". The word
    must end where it ends (so "License" is never read as "Lic" + "ense"),
    punctuation may follow, and the value must contain a digit.
  */
  const licencePattern =
    /\b(?:licen[cs]e(?:\s+(?:no\.?|number))?|lic\.|lic(?=\s*[#:])|CSLB)(?![A-Za-z])[\s:#.-]*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,})/gi;
  const allowedLicences = new Set(
    facts.licenseNumbers.map((l) => l.replace(/\W+/g, "").toUpperCase()),
  );
  let match: RegExpExecArray | null;
  /*
    A licence written with a space in it (10 November 2026, found by the
    canary's first run). A California contractor's licence is often typed
    as a classification and a number - "C-36 998811" - and the pattern
    above stops at the space, so it captured "C-36", normalised that to
    "C36", compared it with "C36998811" and reported the page as inventing
    a licence number. A client stating their own licence correctly failed
    the house rule for it.

    So when the captured value is not one TAWD knows, the next word is
    tried with it before anything is reported. One extra word only: a
    licence is a classification and a number, not a sentence, and swallowing
    more would let "License 1234567 and fully insured" read as a licence.
  */
  const joinedWithNext = (after: number) => {
    const next = /^[\s:#.-]*([A-Z0-9][A-Z0-9-]*)/i.exec(claimed.slice(after));
    return next ? { value: next[1]!, end: after + next[0].length } : null;
  };
  /*
    An intake licence typed with its label (the count of 12 November 2026):
    "NV Lic #23095" normalises to "NVLIC23095", and the page's "NV Lic #23095"
    is read from after "Lic #" as "23095", so the client's own licence failed.
    The page's number is the client's when an intake licence ends with it.
  */
  const isKnown = (value: string) => allowedLicences.has(value) || (value.length >= 4 && [...allowedLicences].some((a) => a.endsWith(value)));
  while ((match = licencePattern.exec(claimed)) !== null) {
    const shown = match[1]!;
    const value = shown.replace(/\W+/g, "").toUpperCase();
    if (isKnown(value)) continue;
    const next = joinedWithNext(match.index + match[0].length);
    if (next && allowedLicences.has(`${value}${next.value.replace(/\W+/g, "").toUpperCase()}`)) {
      // The page states the whole licence; move past the part already read.
      licencePattern.lastIndex = next.end;
      continue;
    }
    issues.push({
      id: "house.license.invented",
      severity: "fail",
      evidence: shown,
      message: `The page shows license "${shown}", which is not in the intake. House rule 2: no invented license numbers.`,
    });
  }

  void text;
  return issues;
}

/*
  B4 (audit F-017): a concept that still breaks a house rule after its fix
  rounds is not presented as ready. The hold used to look at the review's
  score only, so a page with a phone number the client never gave was shown
  with a 5.0. House rules only (an invented fact, an unbacked claim, a
  section built on nothing); a layout fault is the review's business.
*/
export function houseRuleFailures(issues: CheckIssue[]): CheckIssue[] {
  // B1's fact checks ("facts.*") are house rule 2 too: a fact the intake doesn't have, once they block (FACT_CHECKS_BLOCK).
  return issues.filter((issue) => issue.severity === "fail" && !issue.needsIntake && (issue.id.startsWith("house.") || issue.id.startsWith("facts.")));
}

/* How a concept held because its review didn't finish is marked (its reason starts with this), so "Run the review again" can find it and lift the hold. */
export const REVIEW_UNFINISHED = "wasn't reviewed: the review didn't finish";

/* The hold reason, written to follow "it" on the concept card: "it breaks a house rule: a phone number not in the intake." */
export function houseRuleHoldReason(issues: CheckIssue[]): string | null {
  const failures = houseRuleFailures(issues);
  if (failures.length === 0) return null;
  const words = [...new Set(failures.map((issue) => checkWords(issue.id)))];
  return `breaks a house rule: ${words.join("; ")}.`;
}

/* The invented-facts check on its own, for a page of the built site (B1). */
export function inventedFactIssues(html: string, facts: Pick<CheckFacts, "phones" | "licenseNumbers" | "yearFounded">): CheckIssue[] {
  return checkInventedFacts(html, "", { ...facts, businessName: "", cities: [] });
}

/*
  A check in the team's own words (Jason's run, 10 November 2026).

  Concept A's card read "1 fix: headingonecolumn" - a check id with its dots
  taken out, shown to the team as if it were English - and Concept B's read
  "2 fixes needed", which names nothing at all.

  An id not listed here falls back to its own last word with the words
  separated: never raw, and never claiming to know more than it does. The
  ids listed are ones real runs have actually produced.
*/
const CHECK_WORDS: Record<string, string> = {
  "a11y.contrast": "text that cannot be read",
  "a11y.labels": "a form field with no label",
  "a11y.alt": "a picture with no description",
  "conversion.callButton": "no tap-to-call",
  "conversion.form": "no contact form",
  "design.colourRhythm": "the brand colour missing from the bands",
  "design.invisibleRule": "a line nobody can see",
  "house.claim.unsupported": "a claim the intake does not support",
  "house.claim.overreach": "a claim that goes further than the intake",
  "house.claim.superlative": "a boast the intake cannot back",
  "house.license.invented": "a licence number not in the intake",
  "house.phone.invented": "a phone number not in the intake",
  "house.placeholder.filled": "a placeholder for something the intake has",
  "house.reviews.invented": "a rating or review count not from the client",
  "house.year.invented": "a founding year the intake doesn't have",
  "facts.tel": "a call button that dials a number not in the intake",
  "facts.price": "a price the client never gave",
  "facts.year": "a founding year other than the intake's",
  "facts.years": "more years in business than the founding year allows",
  "facts.address": "an address not in the intake",
  "facts.town": "a town the service area doesn't list",
  "facts.name": "a person the client never named",
  "facts.rating": "a rating or review count not from the client",
  "house.section.unsupported": "a section built on something the intake never said",
  "icons.unfilled": "an empty icon slot",
  "images.empty": "an empty picture box",
  "images.logo.invisible": "the logo lost against its background",
  "images.stockOutOfPlace": "a stock picture in the wrong place",
  "layout.headingOneColumn": "a heading squeezed into one column",
  "layout.headingWrap": "a heading breaking badly",
  "layout.overflow": "something running off the screen",
  "layout.gridOrphan": "one card left alone on a row",
  "render.footer": "no footer",
  "render.sections": "a planned section missing",
  "render.clipped": "something cut off",
  "render.faceText": "text over somebody's face",
  "seo.title": "no page title",
  "seo.description": "no page description",
  "structure.truncated": "the page stops part-way",
  "structure.h1.missing": "no main heading",
  "structure.h1.multiple": "more than one main heading",
  "structure.collapsed": "bands that did not lay out",
};

/** A check in words a person can read, for a summary line. */
export function checkWords(id: string): string {
  const known = CHECK_WORDS[id];
  if (known) return known;
  const last = id.split(".").slice(-1)[0] ?? id;
  return last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** One line for the generating screen: "All passed", or "2 fixes: no footer, text that cannot be read". */
export function describeChecks(outcome: CheckOutcome): string {
  const fails = outcome.issues.filter(isFixable);
  if (fails.length === 0) {
    const warns = outcome.issues.length;
    return warns === 0 ? "All passed" : `Passed, ${warns} to look at`;
  }
  // Named, not counted: "2 fixes needed" told the team nothing about what to look at.
  const named = [...new Set(fails.map((issue) => checkWords(issue.id)))];
  const rest = named.length - 2;
  return `${fails.length} ${fails.length === 1 ? "fix" : "fixes"}: ${named.slice(0, 2).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}
