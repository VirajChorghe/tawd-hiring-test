import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  COOKIE_TEMPLATE,
  PRIVACY_TEMPLATE,
  PolicyTemplateError,
  applyConditions,
  policyFieldsFrom,
  policyFlags,
  policyLinks,
  renderPolicy,
  setEffectiveDate,
  type TrackingConfig,
} from "@tawd/core/site";

/*
  Every site's privacy and cookie policies (28 September 2026): VML's
  templates, filled from the project, with only the parts for the tracking
  that's on. No database, no AI.
*/

const root = path.resolve(__dirname, "../../../..");
const NONE: TrackingConfig = { ga4: "", gtm: "", metaPixel: "", googleAds: "", callRail: "", consentMode: "opt_in" };
const GA4: TrackingConfig = { ...NONE, ga4: "G-AB12CD34EF" };
const ADS: TrackingConfig = { ...NONE, ga4: "G-AB12CD34EF", googleAds: "AW-123456789", metaPixel: "123456789012345", consentMode: "opt_out" };

const fields = policyFieldsFrom({
  name: "Harbor Pest Control",
  legalName: "Harbor Pest Control LLC",
  streetAddress: "1100 Melody Ln, Suite 2017",
  city: "Roseville",
  state: "CA",
  phone: "(916) 555-0147",
  email: "office@harborpest.com",
  privacyEmail: "",
  domain: "harborpest.com",
  hostingProvider: "Netlify",
  effectiveDate: new Date("2026-09-28T18:00:00Z"),
});

describe("VML's templates", () => {
  it("are exactly the files in docs/policies", () => {
    expect(PRIVACY_TEMPLATE).toBe(readFileSync(path.join(root, "docs/policies/privacy-policy.md"), "utf8"));
    expect(COOKIE_TEMPLATE).toBe(readFileSync(path.join(root, "docs/policies/cookie-policy.md"), "utf8"));
  });

  it("keep each [[IF ...]] block only when its tracking or setting is on, nested or inline", () => {
    const flags = policyFlags(GA4);
    expect(applyConditions("a\n[[IF tracking.any]]\nb\n[[END]]\nc", flags)).toBe("a\nb\nc");
    expect(applyConditions("a\n[[IF tracking.advertising]]\nb\n[[END]]\nc", flags)).toBe("a\nc");
    expect(applyConditions("x ([[IF tracking.ga4]]GA, [[END]][[IF tracking.gtm]]GTM, [[END]]y)", flags)).toBe("x (GA, y)");
    expect(applyConditions('[[IF tracking.consent_mode == "ask_first"]]ask[[END]][[IF tracking.consent_mode == "opt_out"]]out[[END]]', flags)).toBe("ask");
    expect(applyConditions("[[IF tracking.analytics]]A[[IF tracking.meta_pixel]]M[[END]]B[[END]]", flags)).toBe("AB");
    expect(() => applyConditions("[[IF tracking.unknown]]x[[END]]", flags)).toThrow(PolicyTemplateError);
    expect(() => applyConditions("[[IF tracking.any]]x", flags)).toThrow("without its [[END]]");
    // Both real templates render for every combination.
    for (const tracking of [null, GA4, ADS, { ...ADS, consentMode: "opt_in" as const }]) {
      expect(() => renderPolicy("privacy", fields, tracking)).not.toThrow();
      expect(() => renderPolicy("cookies", fields, tracking)).not.toThrow();
    }
  });
});

describe("a site's policies", () => {
  it("fill the fields from the project, the privacy email defaulting to the business email", () => {
    const privacy = renderPolicy("privacy", fields, GA4);
    expect(privacy).toContain("Harbor Pest Control LLC");
    expect(privacy).toContain("https://harborpest.com");
    expect(privacy).toContain("1100 Melody Ln, Suite 2017, Roseville, CA");
    expect(privacy).toContain("Email: office@harborpest.com");
    expect(privacy).toContain("our website host and form service (Netlify), Google Analytics, and our scheduling");
    expect(privacy).toContain('<span data-tawd-effective-date>September 28, 2026</span>');
    expect(privacy).toContain('<a href="/cookies/">Cookie Policy</a>');
    expect(privacy).not.toMatch(/\{\{|\[\[|PLACEHOLDER/);
    // No advertising: no "Do Not Sell or Share" paragraph.
    expect(privacy).not.toContain("cross-context behavioral advertising");
  });

  it("say only what's true for the tracking that's on", () => {
    const none = renderPolicy("cookies", fields, null);
    expect(none).toContain("Strictly necessary");
    expect(none).not.toContain("Google Analytics");
    expect(none).not.toContain("Cookie settings");
    const ads = renderPolicy("cookies", fields, ADS);
    expect(ads).toContain("Meta Pixel (Meta Platforms)");
    expect(ads).toContain("Google Ads conversion tracking");
    expect(ads).toContain("This site also honors the Global Privacy Control");
    expect(ads).not.toContain("are only set after you accept them");
    expect(renderPolicy("privacy", fields, ADS)).toContain("<strong>&quot;Do Not Sell or Share My Personal Information&quot;</strong>");
  });

  // CodeRabbit on PR #52: a site that loads CallRail must disclose it — on its own, and alongside other tools.
  it("disclose CallRail: alone it still switches the tracking disclosures on, and it joins the provider lists", () => {
    const callOnly: TrackingConfig = { ...NONE, callRail: "515180123/60e10556ab4e9108ff3a" };
    const privacy = renderPolicy("privacy", fields, callOnly);
    expect(privacy).toContain("Calls to our tracking numbers");
    expect(privacy).toContain("CallRail (call tracking)");
    expect(privacy).toContain("analytics and advertising tools that use cookies"); // tracking.any is on
    const cookies = renderPolicy("cookies", fields, callOnly);
    expect(cookies).toContain("CallRail call tracking (CallRail)");
    expect(cookies).toContain("**Analytics.**".replace(/\*\*/g, "")); // the analytics block renders for CallRail alone
    // CallRail is analytics, not advertising: no "sale or sharing" wording for a CallRail-only site.
    expect(privacy).not.toContain("cross-context behavioral advertising");
    // Mixed: CallRail joins the other providers; without it, it appears nowhere.
    const mixed = renderPolicy("privacy", fields, { ...ADS, callRail: "515180123/60e10556ab4e9108ff3a" });
    expect(mixed).toContain("Google Ads, CallRail (call tracking),");
    expect(renderPolicy("privacy", fields, ADS)).not.toContain("CallRail");
    expect(renderPolicy("cookies", fields, ADS)).not.toContain("CallRail");
  });

  it("show a visible placeholder for anything the intake lacks, which keeps the site from going live", () => {
    const thin = policyFieldsFrom({ name: "Harbor", legalName: "", streetAddress: "", city: "", state: "", phone: "", email: "", privacyEmail: "", domain: null, hostingProvider: "Netlify", effectiveDate: new Date() });
    const page = renderPolicy("privacy", thin, null);
    expect(page).toContain("Harbor");
    for (const missing of ["business address", "phone number", "privacy email", "website address"]) {
      expect(page).toContain(`<mark class="tawd-placeholder">[PLACEHOLDER: ${missing}]</mark>`);
    }
  });

  it("take effect the day the site goes live, and link from every footer", () => {
    const page = renderPolicy("privacy", fields, null);
    expect(setEffectiveDate(page, "October 2, 2026")).toContain("<span data-tawd-effective-date>October 2, 2026</span>");
    expect(policyLinks(false)).toBe('<p class="tawd-privacy-links"><a href="/privacy/">Privacy Policy</a> · <a href="/cookies/">Cookie Policy</a></p>');
    expect(policyLinks(true)).toContain("data-tawd-cookie-settings>Cookie settings</a>");
    expect(policyLinks(true)).toContain("data-tawd-optout>Do Not Sell or Share My Personal Information</a>");
  });
});
