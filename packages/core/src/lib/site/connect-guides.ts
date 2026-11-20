import type { DnsHost } from "./connect";

/*
  F3: the client's steps, by DNS provider (1 October 2026). Written for a
  business owner, not an IT person: where to sign in, where the DNS
  records are, and what to watch for. Providers change their screens, so
  each guide names the place in words the provider uses rather than exact
  button positions, and the general guide covers everyone else.
*/

export interface ProviderGuide {
  /** Where the DNS records are, in the provider's own words. */
  where: string[];
  /** Anything that trips people up at this provider. */
  watch: string[];
  /** How to let VML in without sharing a password, when the provider offers it. */
  access: string | null;
}

const GENERAL: ProviderGuide = {
  where: [
    "Sign in where you bought the domain or where its DNS is managed.",
    "Open the domain, then its DNS settings. They may be called DNS, DNS records, Zone file, Advanced DNS or Manage DNS.",
  ],
  watch: ["The name for the bare domain is usually written @ (some screens leave it blank, or want the full domain)."],
  access: null,
};

const GUIDES: Record<string, ProviderGuide> = {
  godaddy: {
    where: ["Sign in at GoDaddy and open My Products (Domain Portfolio).", "Choose the domain, then DNS (it may say Manage DNS). The records are under DNS Records."],
    watch: [
      'GoDaddy often has an A record "@" pointing at "Parked" or a GoDaddy page: edit that one rather than adding a second.',
      "If GoDaddy shows a Forwarding rule for the domain, remove it: forwarding overrides the A record.",
    ],
    access: "In GoDaddy, Account Settings, Delegate Access: invite the VML email below with “Products, Domains & Purchase” (or “Products & Domains”). No password is shared, and you can remove it later.",
  },
  namecheap: {
    where: ["Sign in at Namecheap and open Domain List.", "Click Manage next to the domain, then the Advanced DNS tab. The records are under Host Records."],
    watch: ["Namecheap's parking page uses a CNAME for www and a URL Redirect record for @: delete both before adding the new ones."],
    access: "In Namecheap, Domain List, Manage, Sharing & Transfer: Share Access with the VML email below. No password is shared.",
  },
  cloudflare: {
    where: ["Sign in at Cloudflare and choose the domain.", "Open DNS, then Records."],
    watch: ["Set each new record's Proxy status to DNS only (a grey cloud, not orange): the new site issues its own security certificate."],
    access: "In Cloudflare, Manage Account, Members: invite the VML email below with a role that can edit DNS for this domain only.",
  },
  squarespace: {
    where: ["Sign in at Squarespace and open Domains.", "Choose the domain, then DNS (DNS Settings). Add the records under Custom records."],
    watch: ["If Squarespace shows its own website records (Squarespace Defaults) for this domain, delete those first: they point at a Squarespace site."],
    access: null,
  },
  wix: {
    where: ["Sign in at Wix and open Domains.", "Click the three dots next to the domain, then Manage DNS Records."],
    watch: ["Wix connects domains to Wix sites by default: if the domain is connected to a Wix site, disconnect it first, or the records can't be changed."],
    access: null,
  },
  networksolutions: {
    where: ["Sign in to your Network Solutions account and open My Domain Names.", "Choose the domain, then Manage, then Advanced Tools and Advanced DNS records."],
    watch: [],
    access: null,
  },
  ionos: {
    where: ["Sign in at IONOS and open Domains & SSL.", "Click the gear next to the domain and choose DNS."],
    watch: ["IONOS may ask whether to keep its own records: keep the email (MX) ones, replace the website ones."],
    access: null,
  },
  bluehost: { where: ["Sign in at Bluehost and open Domains.", "Choose the domain, then DNS (the DNS Zone Editor)."], watch: [], access: null },
  hostgator: { where: ["Sign in to the HostGator portal and open Domains.", "Choose the domain, then DNS (or Manage DNS)."], watch: [], access: null },
  hostinger: { where: ["Sign in at Hostinger (hPanel) and open Domains.", "Choose the domain, then DNS / Nameservers, DNS records."], watch: [], access: null },
  porkbun: { where: ["Sign in at Porkbun and open Domain Management.", "Click DNS next to the domain."], watch: ["Delete Porkbun's parking records (an ALIAS and a CNAME pointing at pixie.porkbun.com) first."], access: null },
  route53: {
    where: ["Sign in to the AWS console and open Route 53, Hosted zones.", "Choose the domain and use Create record (or Edit record)."],
    watch: ["Route 53 wants the bare domain's name left blank."],
    access: null,
  },
  dreamhost: { where: ["Sign in to the DreamHost panel and open Domains, Manage Domains.", "Click DNS under the domain."], watch: [], access: null },
  siteground: { where: ["Sign in at SiteGround and open Websites, Site Tools for the domain.", "Open Domain, then DNS Zone Editor."], watch: [], access: null },
  namecom: { where: ["Sign in at Name.com and open My Domains.", "Choose the domain, then Manage DNS Records."], watch: [], access: null },
  register: { where: ["Sign in at Register.com and open the domain's Manage page.", "Find Advanced Technical Settings or DNS records."], watch: [], access: null },
  domaincom: { where: ["Sign in at Domain.com and open the domain.", "Choose DNS & Nameservers, then DNS Records."], watch: [], access: null },
  dynadot: { where: ["Sign in at Dynadot and open My Domains.", "Choose the domain, then DNS Settings."], watch: [], access: null },
  hover: { where: ["Sign in at Hover and choose the domain.", "Open the DNS tab."], watch: [], access: null },
};

export function guideFor(host: DnsHost | null): ProviderGuide & { name: string; url: string | null } {
  const g = host ? GUIDES[host.id] ?? GENERAL : GENERAL;
  return { ...g, where: g === GENERAL ? GENERAL.where : g.where, watch: [...g.watch, ...(g === GENERAL ? [] : GENERAL.watch)], name: host?.name ?? "your DNS provider", url: host?.url ?? null };
}

/* The same steps for the client's IT person, as plain text (an email or a note). */
export function instructionsText(input: {
  domain: string;
  clientName: string;
  host: DnsHost | null;
  changes: { action: string; host: string; type: string; value: string; from?: string }[];
  emailProvider: string | null;
}): string {
  const guide = guideFor(input.host);
  const lines = input.changes.map((c) => {
    const what = c.action === "remove" ? "Remove" : c.action === "change" ? "Change" : "Add";
    return `- ${what}: ${c.type} record, name ${c.host}, ${c.action === "remove" ? "value" : "value"} ${c.value}${c.from ? ` (now ${c.from})` : ""}`;
  });
  return `Connecting ${input.domain} to ${input.clientName}'s new website

Where: ${guide.name}${guide.url ? ` (${guide.url})` : ""}
${guide.where.map((w) => `- ${w}`).join("\n")}

The changes:
${lines.join("\n")}

Leave everything else as it is${input.emailProvider ? `: the email records (MX and TXT, for ${input.emailProvider}) must not change` : ", especially any MX or TXT records (email)"}.
${guide.watch.length ? `\nWatch for:\n${guide.watch.map((w) => `- ${w}`).join("\n")}\n` : ""}
Changes usually show within an hour (sometimes up to a day). The new website checks them by itself.
`;
}
