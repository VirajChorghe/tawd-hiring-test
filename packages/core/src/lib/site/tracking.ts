/*
  Tracking codes on the built site (Todd's request, 26 September 2026).

  The PM enters IDs only: a GA4 measurement ID, a Google Tag Manager
  container, a Meta Pixel, a Google Ads conversion ID. TAWD writes the code
  into every page itself, so nobody pastes a snippet and every ID is
  checked against its exact format first (an ID can never carry code).

  Nothing loads before the visitor's consent. The consent banner has two
  modes, chosen per project:
  - "ask first" (opt_in): tracking loads only after the visitor accepts;
  - "on unless the visitor opts out" (opt_out): tracking loads unless the
    visitor has opted out, or their browser sends Global Privacy Control.
  Every page gets a "Do not sell or share my information" link that opts
  the visitor out at once. The choice is kept in the visitor's browser.

  The privacy and cookie policies are VML's templates, filled from the
  project (policies.ts, 28 September 2026). "Cookie settings" in the footer
  opens the banner again.
*/

import { policyLinks } from "./policies";
import type { ConsentRule } from "./state-privacy";

export const consentModes = ["opt_in", "opt_out"] as const;
export type ConsentMode = (typeof consentModes)[number];

export const consentModeLabels: Record<ConsentMode, string> = {
  opt_in: "Ask first: nothing loads until the visitor accepts",
  opt_out: "On unless the visitor opts out",
};

export interface TrackingIds {
  ga4: string;
  gtm: string;
  metaPixel: string;
  googleAds: string;
  /** "companyId/scriptKey", the two path parts of CallRail's own snippet URL (Consent PR1, 8 November 2026). */
  callRail: string;
}

export interface TrackingConfig extends TrackingIds {
  consentMode: ConsentMode;
}

/* The exact formats. Anything else is refused, so an ID can never carry code into a page. */
export const TRACKING_FORMATS: Record<keyof TrackingIds, { pattern: RegExp; example: string; label: string }> = {
  ga4: { pattern: /^G-[A-Z0-9]{4,12}$/, example: "G-AB12CD34EF", label: "GA4 measurement ID" },
  gtm: { pattern: /^GTM-[A-Z0-9]{4,10}$/, example: "GTM-AB12CD3", label: "Google Tag Manager container ID" },
  metaPixel: { pattern: /^\d{10,20}$/, example: "123456789012345", label: "Meta Pixel ID" },
  googleAds: { pattern: /^AW-\d{6,12}(?:\/[A-Za-z0-9_-]{1,40})?$/, example: "AW-123456789 or AW-123456789/AbC-dEfGh", label: "Google Ads conversion ID" },
  // The two path parts of CallRail's snippet URL (cdn.callrail.com/companies/<company>/<key>/12/swap.js). TAWD composes the URL itself.
  callRail: { pattern: /^\d{6,12}\/[a-f0-9]{12,40}$/i, example: "515180123/60e10556ab4e9108ff3a", label: "CallRail company and script ID" },
};

export const trackingKeys = Object.keys(TRACKING_FORMATS) as (keyof TrackingIds)[];

/* Plain words for each ID that doesn't fit its format; empty when all are fine. Blank IDs are fine. */
export function checkTrackingIds(ids: TrackingIds): { key: keyof TrackingIds; message: string }[] {
  return trackingKeys.flatMap((key) => {
    const value = ids[key].trim();
    const format = TRACKING_FORMATS[key];
    return value && !format.pattern.test(value) ? [{ key, message: `The ${format.label} should look like ${format.example}.` }] : [];
  });
}

export function hasTracking(config: TrackingConfig | null): config is TrackingConfig {
  return Boolean(config && trackingKeys.some((key) => config[key].trim()));
}

export const PRIVACY_PATH = "/privacy/";

/*
  The head part: the banner's look, and the one script that decides and
  loads. The IDs are checked (checkTrackingIds) and then written as JSON.
  The rule (consentRuleFor, state-privacy.ts) is the state law's floor: the
  team's own choice may be stricter ("ask first") but never weaker, Global
  Privacy Control is honored when the rule says so, and once an opt-out is
  processed every opt-out link reads "Opt-Out Request Honored" (CA
  §7025(c)(6)). An explicit later accept still wins over GPC (§7025 allows
  asking the visitor to consent); closing the banner never counts as either.
*/
export function trackingHead(config: TrackingConfig, rule: ConsentRule): string {
  if (checkTrackingIds(config).length) throw new Error("A tracking ID doesn't fit its format.");
  const ids = JSON.stringify({
    mode: effectiveConsentMode(config, rule),
    gpc: rule.honorGpc,
    honored: rule.optOutHonoredNotice,
    ga4: config.ga4.trim(),
    gtm: config.gtm.trim(),
    pixel: config.metaPixel.trim(),
    ads: config.googleAds.trim().split("/")[0],
    cr: config.callRail.trim(),
  });
  return `<style>.tawd-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:720px;margin:0 auto;background:#fff;color:#1d232b;border:1px solid #d7dbe0;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:16px 20px;font:15px/1.5 system-ui,sans-serif}.tawd-consent p{margin:0 0 12px}.tawd-consent-actions{display:flex;gap:8px;flex-wrap:wrap}.tawd-consent button{font:inherit;min-height:44px;padding:8px 16px;border-radius:8px;border:1px solid #1d232b;background:#fff;color:#1d232b;cursor:pointer}.tawd-consent button.tawd-consent-yes{background:#1d232b;color:#fff}.tawd-privacy-links{font-size:14px}</style>
<script>(function(){var C=${ids};var K="tawd-consent";function g(){try{return localStorage.getItem(K)}catch(e){return null}}function s(v){try{localStorage.setItem(K,v)}catch(e){}}var gpc=C.gpc&&navigator.globalPrivacyControl===true;function ok(){var v=g();if(v==="denied")return false;if(C.mode==="opt_in")return v==="granted";return v==="granted"||!gpc}var done=false;function add(src){var t=document.createElement("script");t.async=true;t.src=src;document.head.appendChild(t)}function load(){if(done)return;done=true;if(C.gtm){window.dataLayer=window.dataLayer||[];window.dataLayer.push({"gtm.start":Date.now(),event:"gtm.js"});add("https://www.googletagmanager.com/gtm.js?id="+encodeURIComponent(C.gtm))}if(C.ga4||C.ads){window.dataLayer=window.dataLayer||[];window.gtag=function(){window.dataLayer.push(arguments)};window.gtag("js",new Date());if(C.ga4)window.gtag("config",C.ga4);if(C.ads)window.gtag("config",C.ads);add("https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(C.ga4||C.ads))}if(C.pixel){var f=window.fbq=function(){f.callMethod?f.callMethod.apply(f,arguments):f.queue.push(arguments)};if(!window._fbq)window._fbq=f;f.push=f;f.loaded=true;f.version="2.0";f.queue=[];add("https://connect.facebook.net/en_US/fbevents.js");window.fbq("init",C.pixel);window.fbq("track","PageView")}if(C.cr){add("https://cdn.callrail.com/companies/"+C.cr+"/12/swap.js")}}function banner(show){var b=document.getElementById("tawd-consent");if(b)b.hidden=!show}function mark(){if(!C.honored)return;var l=document.querySelectorAll("[data-tawd-optout]");for(var i=0;i<l.length;i++)l[i].textContent="Opt-Out Request Honored"}window.tawdConsent=function(v){s(v);banner(false);if(v==="granted")load();else{mark();if(done)location.reload()}};document.addEventListener("DOMContentLoaded",function(){if(ok())load();var v=g();banner(!v&&!(C.mode==="opt_out"&&gpc));if(v==="denied"||(gpc&&v!=="granted"))mark();var links=document.querySelectorAll("[data-tawd-optout]");for(var i=0;i<links.length;i++){links[i].addEventListener("click",function(e){e.preventDefault();s("denied");if(C.honored)mark();else this.textContent="You have opted out";if(done)location.reload()})}var settings=document.querySelectorAll("[data-tawd-cookie-settings],[data-tawd-privacy-choices]");for(var j=0;j<settings.length;j++){settings[j].addEventListener("click",function(e){e.preventDefault();banner(true)})}})})();</script>`;
}

/*
  The banner itself, at the end of the body: hidden until the script decides
  to show it. There is no close button on purpose: under the rule, dismissing
  a banner is neither an accept nor a decline, so the only ways out are the
  two symmetrical choices (CA §7004: accept must be no more prominent than
  decline, so under a symmetry rule both buttons carry the same style).
*/
export function consentBanner(config: TrackingConfig, rule: ConsentRule): string {
  const askFirst = effectiveConsentMode(config, rule) === "opt_in";
  const yes = rule.symmetricalButtons ? "" : ' class="tawd-consent-yes"';
  return `<div id="tawd-consent" class="tawd-consent" role="region" aria-label="Cookie choices" hidden><p>${
    askFirst
      ? "We'd like to use cookies to measure visits to this site and our advertising. Nothing is tracked unless you accept."
      : "This site uses cookies to measure visits and for advertising. You can opt out at any time."
  } <a href="/cookies/">Cookie Policy</a> · <a href="${PRIVACY_PATH}">Privacy Policy</a></p><div class="tawd-consent-actions">${
    askFirst
      ? `<button type="button"${yes} onclick="tawdConsent('granted')">Accept</button><button type="button" onclick="tawdConsent('denied')">Decline</button>`
      : `<button type="button"${yes} onclick="tawdConsent('granted')">OK</button><button type="button" onclick="tawdConsent('denied')">Opt out</button>`
  }</div></div>`;
}

/* The team's choice, floored by the state rule: the team may be stricter than the law, never weaker. */
export function effectiveConsentMode(config: TrackingConfig, rule: ConsentRule): ConsentMode {
  return config.consentMode === "opt_in" || rule.floor === "opt_in" ? "opt_in" : "opt_out";
}

/* The footer's links with tracking on (policies.ts has them all, with or without tracking), plus the persistent "Your Privacy Choices" link where the rule asks for one. */
export function privacyLinks(rule: ConsentRule): string {
  return policyLinks(true, { privacyChoicesLink: rule.privacyChoicesLink });
}
