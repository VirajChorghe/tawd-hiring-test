/*
  The client's online tools (Jason, 26 September 2026): booking links and
  widgets, a shop, a patient or client portal, a reviews page or widget.

  The intake keeps a kind, the provider's name and the link. The builder
  places each one where it belongs (site/integrations.ts) and the build's
  checklist confirms each link answers. Only a link is kept, never a code
  snippet: a snippet from outside is data, and a script on the client's
  site would be one nobody at VML wrote. Providers whose booking page can
  sit inside the site (a frame) can be shown on the page; every other one
  is a clear button to the provider's own page.
*/

export const integrationKinds = ["booking", "shop", "portal", "reviews"] as const;
export type IntegrationKind = (typeof integrationKinds)[number];

export const integrationKindLabels: Record<IntegrationKind, string> = {
  booking: "Online booking",
  shop: "Shop",
  portal: "Patient or client portal",
  reviews: "Reviews",
};

/* Offered as suggestions while typing; any name can be written. */
export const integrationProviders: Record<IntegrationKind, string[]> = {
  booking: ["Boulevard", "Vagaro", "Calendly", "Acuity Scheduling", "Square Appointments", "Mindbody", "Jane", "Housecall Pro", "Jobber", "ServiceTitan"],
  shop: ["Shopify", "Square Online", "Etsy", "Amazon"],
  portal: ["Patient portal", "Client portal", "Jane", "Mindbody"],
  reviews: ["Google", "Yelp", "Facebook", "Trustpilot", "Healthgrades", "Houzz"],
};

/*
  Booking pages that are made to sit inside another site, and the address
  of that version. Anything else is shown as a button.
*/
const EMBEDDABLE: { host: RegExp; src: (url: URL) => string }[] = [
  {
    host: /(^|\.)calendly\.com$/i,
    src: (url) => {
      url.searchParams.set("embed_type", "Inline");
      url.searchParams.set("hide_gdpr_banner", "1");
      return url.toString();
    },
  },
  { host: /(^|\.)acuityscheduling\.com$/i, src: (url) => url.toString() },
];

/* The address to frame on the page, or null when the provider's page can't be shown inside the site. */
export function embedSrc(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const match = EMBEDDABLE.find((e) => e.host.test(url.hostname));
  return match ? match.src(url) : null;
}

export function canEmbed(kind: IntegrationKind, link: string): boolean {
  return kind === "booking" && embedSrc(link) !== null;
}
