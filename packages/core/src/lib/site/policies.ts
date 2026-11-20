import { formatUsPhone } from "../phone";
import { COOKIE_TEMPLATE, PRIVACY_TEMPLATE } from "./policy-templates";
export { COOKIE_TEMPLATE, PRIVACY_TEMPLATE } from "./policy-templates";
import type { TrackingConfig } from "./tracking";

/*
  Every site's /privacy/ and /cookies/ pages (28 September 2026), from VML's
  templates: each {{field}} filled from the project, each [[IF ...]] block
  kept only when that tracking or setting is on. A field the project lacks
  becomes a visible [PLACEHOLDER], which keeps the site from going live
  until it's filled.

  The effective date is the go-live date. Until then the page shows the
  build's date in a marked span, which the live deploy sets to the day the
  site goes live (and later deploys keep that first date).
*/

export const PRIVACY_POLICY_PATH = "/privacy/";
export const COOKIE_POLICY_PATH = "/cookies/";

export interface PolicyFields {
  legalName: string;
  address: string;
  phone: string;
  privacyEmail: string;
  /** https://domain, or "" before the domain is known. */
  siteUrl: string;
  hostingProvider: string;
  /** "September 28, 2026". */
  effectiveDate: string;
}

export type PolicyFlags = Record<string, boolean | string>;

/* The switches the templates test. */
export function policyFlags(tracking: TrackingConfig | null, personal = false): PolicyFlags {
  const on = (v: string | undefined) => Boolean(v?.trim());
  const ga4 = on(tracking?.ga4);
  const gtm = on(tracking?.gtm);
  const metaPixel = on(tracking?.metaPixel);
  const googleAds = on(tracking?.googleAds);
  // CallRail (Consent PR1): call tracking measures which page or ad led to a call, so it is analytics,
  // and it switches every tracking disclosure on like the others (CodeRabbit PR #52).
  const callRail = on(tracking?.callRail);
  return {
    "tracking.ga4": ga4,
    "tracking.gtm": gtm,
    "tracking.meta_pixel": metaPixel,
    "tracking.google_ads": googleAds,
    "tracking.call_rail": callRail,
    "tracking.analytics": ga4 || gtm || callRail,
    "tracking.advertising": metaPixel || googleAds,
    "tracking.any": ga4 || gtm || metaPixel || googleAds || callRail,
    // A personal site (no services: the sample client's) gets the wording without appointments, service addresses or a business phone (29 September 2026).
    "site.personal": personal,
    "site.business": !personal,
    // TAWD's "opt_in" is the templates' "ask_first".
    "tracking.consent_mode": !tracking ? "" : tracking.consentMode === "opt_in" ? "ask_first" : "opt_out",
  };
}

export class PolicyTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyTemplateError";
  }
}

function test(condition: string, flags: PolicyFlags): boolean {
  const eq = /^([\w.]+)\s*==\s*"([^"]*)"$/.exec(condition.trim());
  if (eq) {
    if (!(eq[1]! in flags)) throw new PolicyTemplateError(`The template tests "${eq[1]}", which TAWD doesn't know.`);
    return flags[eq[1]!] === eq[2];
  }
  const key = condition.trim();
  if (!(key in flags)) throw new PolicyTemplateError(`The template tests "${key}", which TAWD doesn't know.`);
  return flags[key] === true;
}

/* The [[IF ...]] ... [[END]] blocks, nested or inline; a block that is off takes its own line with it. */
export function applyConditions(template: string, flags: PolicyFlags): string {
  const token = /\[\[(IF\s+[^\]]+|END)\]\]/g;
  let out = "";
  let at = 0;
  const stack: boolean[] = [];
  const showing = () => stack.every(Boolean);
  let match: RegExpExecArray | null;
  while ((match = token.exec(template)) !== null) {
    if (showing()) out += template.slice(at, match.index);
    at = match.index + match[0].length;
    // A marker alone on its line takes the line break with it.
    const lineStart = match.index === 0 || template[match.index - 1] === "\n";
    if (lineStart && template[at] === "\n" && (out.endsWith("\n") || out === "")) at += 1;
    if (match[1] === "END") {
      if (stack.length === 0) throw new PolicyTemplateError("The template has an [[END]] without an [[IF]].");
      stack.pop();
    } else {
      stack.push(test(match[1]!.replace(/^IF\s+/, ""), flags));
    }
  }
  if (stack.length) throw new PolicyTemplateError("The template has an [[IF]] without its [[END]].");
  if (showing()) out += template.slice(at);
  return out.replace(/\n{3,}/g, "\n\n");
}

const FIELD_NAMES: Record<string, keyof PolicyFields | "cookieUrl" | "privacyUrl"> = {
  "business.legal_name": "legalName",
  "business.address": "address",
  "business.phone": "phone",
  "business.privacy_email": "privacyEmail",
  "site.url": "siteUrl",
  "site.hosting_provider": "hostingProvider",
  "policy.effective_date": "effectiveDate",
  "site.cookie_policy_url": "cookieUrl",
  "site.privacy_policy_url": "privacyUrl",
};

const PLACEHOLDERS: Record<string, string> = {
  legalName: "[PLACEHOLDER: legal business name]",
  address: "[PLACEHOLDER: business address]",
  phone: "[PLACEHOLDER: phone number]",
  privacyEmail: "[PLACEHOLDER: privacy email]",
  siteUrl: "[PLACEHOLDER: website address]",
  hostingProvider: "[PLACEHOLDER: hosting provider]",
  effectiveDate: "[PLACEHOLDER: effective date]",
};

export const EFFECTIVE_DATE_MARK = "\u0000tawd-effective-date\u0000";

/* The {{fields}}: the project's values, a visible placeholder for any it lacks. */
export function fillFields(text: string, fields: PolicyFields): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, name: string) => {
    const key = FIELD_NAMES[name];
    if (!key) throw new PolicyTemplateError(`The template has {{${name}}}, which TAWD doesn't fill.`);
    if (key === "cookieUrl") return COOKIE_POLICY_PATH;
    if (key === "privacyUrl") return PRIVACY_POLICY_PATH;
    if (key === "effectiveDate") return EFFECTIVE_DATE_MARK;
    const value = fields[key].trim();
    return value || PLACEHOLDERS[key]!;
  });
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The inline parts: bold and links (site paths, https and mailto only). */
function inline(text: string, effectiveDate: string): string {
  const escaped = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(((?:\/|https:\/\/|mailto:)[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/\[PLACEHOLDER:[^\]]*\]/gi, (p) => `<mark class="tawd-placeholder">${p}</mark>`);
  return escaped.split(EFFECTIVE_DATE_MARK).join(`<span data-tawd-effective-date>${escapeHtml(effectiveDate)}</span>`);
}

/* The small Markdown the templates use: headings, paragraphs, lists, bold, links; each line of the contact block its own line. */
export function policyHtml(markdown: string, effectiveDate: string): string {
  const blocks = markdown.trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return "";
      const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]!);
      if (heading && lines.length === 1) {
        const level = heading[1]!.length;
        return `<h${level}>${inline(heading[2]!, effectiveDate)}</h${level}>`;
      }
      if (lines.every((l) => /^\s*-\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*-\s+/, ""), effectiveDate)}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map((l) => inline(l, effectiveDate)).join("<br />")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/*
  The privacy policy's state sections (state-privacy.ts) go just before
  "Contact us", each filled and switched like the baseline.
*/
export function withStateAddOns(template: string, addOns: string[]): string {
  if (addOns.length === 0) return template;
  const at = template.search(/^## Contact us/m);
  const sections = addOns.map((a) => a.trim()).join("\n\n");
  return at < 0 ? `${template.trimEnd()}\n\n${sections}\n` : `${template.slice(0, at)}${sections}\n\n${template.slice(at)}`;
}

export function renderPolicy(kind: "privacy" | "cookies", fields: PolicyFields, tracking: TrackingConfig | null, stateAddOns: string[] = [], options: { personal?: boolean } = {}): string {
  const base = kind === "privacy" ? PRIVACY_TEMPLATE : COOKIE_TEMPLATE;
  const template = kind === "privacy" ? withStateAddOns(base, stateAddOns) : base;
  const text = fillFields(applyConditions(template, policyFlags(tracking, options.personal ?? false)), fields);
  return `<main id="main"><section class="tawd-simple-page tawd-policy">${policyHtml(text, fields.effectiveDate)}</section></main>`;
}

/* At go-live: the policies' effective date becomes the day the site went live. */
export function setEffectiveDate(html: string, date: string): string {
  return html.replace(/<span data-tawd-effective-date>[^<]*<\/span>/g, `<span data-tawd-effective-date>${escapeHtml(date)}</span>`);
}

export function formatPolicyDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

/* The fields, from the intake and the site. */
export function policyFieldsFrom(input: {
  name: string;
  legalName: string;
  streetAddress: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  privacyEmail: string;
  domain: string | null;
  hostingProvider: string;
  effectiveDate: Date;
}): PolicyFields {
  const place = [input.city.trim(), input.state.trim()].filter(Boolean).join(", ");
  return {
    legalName: input.legalName.trim() || input.name.trim(),
    address: [input.streetAddress.trim(), place].filter(Boolean).join(", "),
    phone: formatUsPhone(input.phone.trim()),
    privacyEmail: input.privacyEmail.trim() || input.email.trim(),
    siteUrl: input.domain ? `https://${input.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}` : "",
    hostingProvider: input.hostingProvider,
    effectiveDate: formatPolicyDate(input.effectiveDate),
  };
}

/*
  The footer's links, on every page: both policies; with tracking also
  "Cookie settings" (opens the banner again) and "Do Not Sell or Share My
  Personal Information" (opts out at once).
*/
/*
  The footer with the policy links it doesn't have yet (Jason, 29 September
  2026: a design's footer that already links both policies got a second,
  unstyled "Privacy Policy · Cookie Policy" line under it). Only what is
  missing is added; nothing when the footer has them all.
*/
export function withPolicyLinks(footer: string, withTracking: boolean, options: { privacyChoicesLink?: boolean } = {}): string {
  const has = (pattern: RegExp) => pattern.test(footer);
  const links: string[] = [];
  if (!has(new RegExp(`href=["']${PRIVACY_POLICY_PATH}["']`, "i"))) links.push(`<a href="${PRIVACY_POLICY_PATH}">Privacy Policy</a>`);
  if (!has(new RegExp(`href=["']${COOKIE_POLICY_PATH}["']`, "i"))) links.push(`<a href="${COOKIE_POLICY_PATH}">Cookie Policy</a>`);
  if (withTracking) {
    if (!has(/data-tawd-cookie-settings/)) links.push(`<a href="${COOKIE_POLICY_PATH}" data-tawd-cookie-settings>Cookie settings</a>`);
    if (!has(/data-tawd-optout/)) links.push(`<a href="${PRIVACY_POLICY_PATH}" data-tawd-optout>Do Not Sell or Share My Personal Information</a>`);
    // The persistent "Your Privacy Choices" link, where the state's consent rule asks for one (Consent PR1): it reopens the banner.
    if (options.privacyChoicesLink && !has(/data-tawd-privacy-choices/)) links.push(`<a href="${PRIVACY_POLICY_PATH}" data-tawd-privacy-choices>Your Privacy Choices</a>`);
  }
  if (links.length === 0) return footer;
  return footer.replace(/<\/footer>\s*$/i, `<p class="tawd-privacy-links">${links.join(" · ")}</p></footer>`);
}

export function policyLinks(withTracking: boolean, options: { privacyChoicesLink?: boolean } = {}): string {
  const links = [`<a href="${PRIVACY_POLICY_PATH}">Privacy Policy</a>`, `<a href="${COOKIE_POLICY_PATH}">Cookie Policy</a>`];
  if (withTracking) {
    links.push(`<a href="${COOKIE_POLICY_PATH}" data-tawd-cookie-settings>Cookie settings</a>`);
    links.push(`<a href="${PRIVACY_POLICY_PATH}" data-tawd-optout>Do Not Sell or Share My Personal Information</a>`);
    if (options.privacyChoicesLink) links.push(`<a href="${PRIVACY_POLICY_PATH}" data-tawd-privacy-choices>Your Privacy Choices</a>`);
  }
  return `<p class="tawd-privacy-links">${links.join(" · ")}</p>`;
}
