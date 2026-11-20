import { normalizeDomain } from "./golive";

/*
  F3, Connect the domain (1 October 2026, docs/plans/forms-email-domains.md,
  Jason: "the most valuable and required setup"). The rules, with no
  network: who runs the domain's DNS and its email (from its NS and MX
  records), the records the site needs, what's in the way, and which path
  to take. The default is Todd's: the client points two records at the
  site and their email isn't touched; nameservers move to VML's Cloudflare
  only when VML manages the domain.
*/

/* ---------- who runs the DNS ---------- */

export interface DnsHost {
  id: string;
  name: string;
  /** Where the client signs in. */
  url: string | null;
}

const DNS_HOSTS: { test: RegExp; host: DnsHost }[] = [
  { test: /domaincontrol\.com$/, host: { id: "godaddy", name: "GoDaddy", url: "https://dcc.godaddy.com/control/portfolio" } },
  { test: /registrar-servers\.com$/, host: { id: "namecheap", name: "Namecheap", url: "https://ap.www.namecheap.com/domains/list/" } },
  { test: /ns\.cloudflare\.com$/, host: { id: "cloudflare", name: "Cloudflare", url: "https://dash.cloudflare.com/" } },
  { test: /googledomains\.com$/, host: { id: "squarespace", name: "Squarespace (formerly Google Domains)", url: "https://account.squarespace.com/domains" } },
  { test: /squarespacedns\.com$/, host: { id: "squarespace", name: "Squarespace", url: "https://account.squarespace.com/domains" } },
  { test: /wixdns\.net$/, host: { id: "wix", name: "Wix", url: "https://manage.wix.com/account/domains" } },
  { test: /worldnic\.com$/, host: { id: "networksolutions", name: "Network Solutions (or Web.com)", url: "https://www.networksolutions.com/my-account/login" } },
  { test: /ui-dns\.(com|de|org|biz)$/, host: { id: "ionos", name: "IONOS", url: "https://my.ionos.com/domains" } },
  { test: /bluehost\.com$/, host: { id: "bluehost", name: "Bluehost", url: "https://my.bluehost.com/" } },
  { test: /hostgator\.com$/, host: { id: "hostgator", name: "HostGator", url: "https://portal.hostgator.com/" } },
  { test: /(dns-parking\.com|hostinger\.com)$/, host: { id: "hostinger", name: "Hostinger", url: "https://hpanel.hostinger.com/domains" } },
  { test: /porkbun\.com$/, host: { id: "porkbun", name: "Porkbun", url: "https://porkbun.com/account/domainsSpeedy" } },
  { test: /awsdns-\d+\.(com|net|org|co\.uk)$/, host: { id: "route53", name: "Amazon Route 53", url: "https://console.aws.amazon.com/route53/" } },
  { test: /dreamhost\.com$/, host: { id: "dreamhost", name: "DreamHost", url: "https://panel.dreamhost.com/" } },
  { test: /(siteground\.net|sgvps\.net)$/, host: { id: "siteground", name: "SiteGround", url: "https://my.siteground.com/" } },
  { test: /name\.com$/, host: { id: "namecom", name: "Name.com", url: "https://www.name.com/account/domain" } },
  { test: /(register\.com)$/, host: { id: "register", name: "Register.com", url: "https://www.register.com/myaccount/" } },
  { test: /domain\.com$/, host: { id: "domaincom", name: "Domain.com", url: "https://www.domain.com/my-account/" } },
  { test: /dyna-ns\.net$/, host: { id: "dynadot", name: "Dynadot", url: "https://www.dynadot.com/account/" } },
  { test: /hover\.com$/, host: { id: "hover", name: "Hover", url: "https://www.hover.com/control_panel" } },
];

/** Who runs the domain's DNS, from its nameservers; null when TAWD doesn't know the provider. */
export function dnsHostFrom(nameservers: string[]): DnsHost | null {
  for (const ns of nameservers.map((n) => n.toLowerCase().replace(/\.$/, ""))) {
    const hit = DNS_HOSTS.find((h) => h.test.test(ns));
    if (hit) return hit.host;
  }
  return null;
}

/* ---------- who runs the email ---------- */

export interface EmailProvider {
  id: string;
  name: string;
}

const EMAIL: { test: RegExp; provider: EmailProvider }[] = [
  { test: /(aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com)$/, provider: { id: "google", name: "Google Workspace" } },
  { test: /mail\.protection\.outlook\.com$/, provider: { id: "microsoft", name: "Microsoft 365" } },
  { test: /secureserver\.net$/, provider: { id: "godaddy", name: "GoDaddy email" } },
  { test: /zoho(mail)?\.(com|eu|in|com\.au)$/, provider: { id: "zoho", name: "Zoho Mail" } },
  { test: /yahoodns\.net$/, provider: { id: "yahoo", name: "Yahoo" } },
  { test: /mail\.icloud\.com$/, provider: { id: "icloud", name: "iCloud+" } },
  { test: /messagingengine\.com$/, provider: { id: "fastmail", name: "Fastmail" } },
  { test: /protonmail\.ch$/, provider: { id: "proton", name: "Proton Mail" } },
  { test: /titan\.email$/, provider: { id: "titan", name: "Titan" } },
  { test: /privateemail\.com$/, provider: { id: "namecheap", name: "Namecheap Private Email" } },
  { test: /emailsrvr\.com$/, provider: { id: "rackspace", name: "Rackspace Email" } },
  { test: /(ionos\.(com|de)|1and1\.com|perfora\.net|kundenserver\.de)$/, provider: { id: "ionos", name: "IONOS email" } },
  { test: /mx\.cloudflare\.net$/, provider: { id: "cloudflare", name: "Cloudflare Email Routing (forwarding)" } },
  { test: /(improvmx\.com|forwardemail\.net)$/, provider: { id: "forwarding", name: "an email forwarding service" } },
  { test: /(mimecast\.com|pphosted\.com|barracudanetworks\.com)$/, provider: { id: "gateway", name: "an email security service in front of their mailbox" } },
];

/** Who runs the domain's email, from its MX hosts; "host" when the mail server is the web host's own. */
export function emailProviderFrom(domain: string, mxHosts: string[]): EmailProvider | null {
  if (mxHosts.length === 0) return null;
  const d = normalizeDomain(domain);
  for (const mx of mxHosts.map((m) => m.toLowerCase().replace(/\.$/, ""))) {
    const hit = EMAIL.find((e) => e.test.test(mx));
    if (hit) return hit.provider;
  }
  if (mxHosts.some((m) => m.toLowerCase().replace(/\.$/, "").endsWith(d))) return { id: "host", name: "email at their web host (cPanel or similar)" };
  return { id: "other", name: mxHosts[0]!.toLowerCase().replace(/\.$/, "") };
}

/* ---------- what the site needs ---------- */

export type Hosting = "netlify" | "wordpress";

/** Netlify's load balancer, for a bare domain on another DNS provider (Netlify's docs). */
export const NETLIFY_APEX_IP = "75.2.60.5";
/** Shown in place of a WordPress site's IP until its 20i package exists (the preview makes it). */
export const WORDPRESS_IP_UNKNOWN = "(the site's IP: deploy the WordPress preview first)";

export interface WantedRecord {
  /** "@" or "www", as most DNS screens write the name. */
  host: "@" | "www";
  type: "A" | "CNAME";
  value: string;
}

/**
 * The two records the site needs at the client's DNS provider. A WordPress site points at its own 20i
 * package's IPv4 (20i, 5 October 2026; it can change, and the daily IP watch notices).
 */
export function siteRecords(hosting: Hosting, domain: string, netlifySiteName: string | null, wordpressIp: string | null = null): WantedRecord[] {
  const d = normalizeDomain(domain);
  if (hosting === "wordpress") return [{ host: "@", type: "A", value: wordpressIp ?? WORDPRESS_IP_UNKNOWN }, { host: "www", type: "CNAME", value: d }];
  return [
    { host: "@", type: "A", value: NETLIFY_APEX_IP },
    { host: "www", type: "CNAME", value: `${netlifySiteName ?? "your-site"}.netlify.app` },
  ];
}

/** Who issues the HTTPS certificate: a CAA record has to allow them. WordPress: TAWD's Let's Encrypt, or 20i's paid RapidSSL (DigiCert's CAA name; 20i.apib, Order SSL Certificates). */
export const CERT_ISSUERS: Record<Hosting, string[]> = { netlify: ["letsencrypt.org"], wordpress: ["letsencrypt.org", "digicert.com"] };

/* ---------- what's there now, and what to change ---------- */

/** What public DNS says about the domain now (from connect lookups). */
export interface DomainSnapshot {
  domain: string;
  nameservers: string[];
  apexA: string[];
  apexAAAA: string[];
  apexCname: string[];
  wwwA: string[];
  wwwAAAA: string[];
  wwwCname: string[];
  mx: string[];
  /** CAA records as "0 issue \"letsencrypt.org\"". */
  caa: string[];
  dnssec: boolean | null;
}

export interface Change {
  action: "add" | "change" | "remove";
  host: "@" | "www";
  type: string;
  /** The value to set (add, change) or the one to take out (remove). */
  value: string;
  /** What's there now, for a change. */
  from?: string;
  why: string;
}

const clean = (v: string) => v.toLowerCase().replace(/\.$/, "").trim();

/*
  The changes at the client's DNS provider, in the order to make them: the
  two records, anything old that would send visitors elsewhere, and a CAA
  record if one is in the way of the certificate. Email records are never
  in the list.
*/
export function changesFor(snapshot: DomainSnapshot, wanted: WantedRecord[], hosting: Hosting): Change[] {
  const out: Change[] = [];
  const apex = wanted.find((w) => w.host === "@")!;
  const www = wanted.find((w) => w.host === "www")!;

  /*
    Behind Cloudflare's proxy (the orange cloud), public DNS shows
    Cloudflare's own addresses, not the client's records: there is one
    record to edit for each name, and switching the proxy off takes the
    IPv6 addresses away with it.
  */
  if (proxiedByCloudflare(snapshot)) {
    const apexOk = snapshot.apexA.length === 1 && clean(snapshot.apexA[0]!) === clean(apex.value);
    const wwwOk = snapshot.wwwCname.some((c) => clean(c) === clean(www.value));
    const note = "Your site is behind Cloudflare's proxy (orange cloud): edit the existing record, and set its Proxy status to DNS only (grey cloud).";
    if (!apexOk) out.push({ action: "change", host: "@", type: "A", value: apex.value, from: "your current website (proxied)", why: note });
    if (!wwwOk) out.push({ action: "change", host: "www", type: "CNAME", value: www.value, from: "your current website (proxied)", why: `${note} If www is an A record, delete it and add this CNAME instead.` });
    return out;
  }

  const apexOther = snapshot.apexA.filter((ip) => clean(ip) !== clean(apex.value));
  if (!snapshot.apexA.some((ip) => clean(ip) === clean(apex.value))) {
    out.push(
      apexOther.length
        ? { action: "change", host: "@", type: "A", value: apex.value, from: apexOther[0], why: "The bare domain points at your old website." }
        : { action: "add", host: "@", type: "A", value: apex.value, why: "The bare domain doesn't point anywhere yet." },
    );
  }
  for (const ip of apexOther.slice(snapshot.apexA.some((x) => clean(x) === clean(apex.value)) ? 0 : 1)) out.push({ action: "remove", host: "@", type: "A", value: ip, why: "A second address for the bare domain would send some visitors to the old site." });
  for (const ip of snapshot.apexAAAA) out.push({ action: "remove", host: "@", type: "AAAA", value: ip, why: "An IPv6 address for the old site: phones on IPv6 would still see it." });

  const wwwOk = snapshot.wwwCname.some((c) => clean(c) === clean(www.value));
  if (!wwwOk) {
    if (snapshot.wwwCname.length) out.push({ action: "change", host: "www", type: "CNAME", value: www.value, from: snapshot.wwwCname[0], why: "www points at your old website." });
    else if (snapshot.wwwA.length) {
      out.push({ action: "remove", host: "www", type: "A", value: snapshot.wwwA.join(", "), why: "www points at your old website by address; a CNAME takes its place." });
      out.push({ action: "add", host: "www", type: "CNAME", value: www.value, why: "So www.yourdomain works too." });
    } else out.push({ action: "add", host: "www", type: "CNAME", value: www.value, why: "So www.yourdomain works too." });
  }
  for (const ip of snapshot.wwwAAAA) out.push({ action: "remove", host: "www", type: "AAAA", value: ip, why: "An IPv6 address for the old site at www." });

  // A CAA record that doesn't name the certificate's issuer stops HTTPS on the new site.
  const issuers = CERT_ISSUERS[hosting];
  const issues = snapshot.caa.filter((c) => /\bissue(wild)?\b/i.test(c));
  if (issues.length && !issuers.some((i) => issues.some((c) => c.toLowerCase().includes(i)))) {
    for (const i of issuers) out.push({ action: "add", host: "@", type: "CAA", value: `0 issue "${i}"`, why: "Your domain only lets certain companies issue its security certificate; this adds the one the new site uses." });
  }
  return out;
}

/* Cloudflare's published IPv4 ranges (cloudflare.com/ips): an address in them is Cloudflare's proxy, not a server. */
const CLOUDFLARE_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];

const ipNumber = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

export function isCloudflareIp(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ipNumber(ip);
  return CLOUDFLARE_V4.some((range) => {
    const [base, bits] = range.split("/");
    const size = 2 ** (32 - Number(bits));
    const start = ipNumber(base!);
    return n >= start && n < start + size;
  });
}

/** The site is behind Cloudflare's proxy: every address for the bare domain is Cloudflare's. */
export function proxiedByCloudflare(snapshot: DomainSnapshot): boolean {
  return snapshot.apexA.length > 0 && snapshot.apexA.every(isCloudflareIp);
}

/** Whether the site's two records are in place and nothing old is left in the way. */
export function recordsReady(snapshot: DomainSnapshot, wanted: WantedRecord[], hosting: Hosting): boolean {
  return changesFor(snapshot, wanted, hosting).length === 0;
}

/* ---------- the path ---------- */

export type ConnectPath = "records" | "access" | "vml_dns";

export interface PathAdvice {
  path: ConnectPath;
  why: string;
}

/*
  Path A (records) unless VML runs the domain's DNS already, or VML bought
  the domain: then path C (vml_dns), today's Cloudflare flow. Path B
  (access) is A done by the PM with access the client granted; the PM
  picks it when the client can't make the changes.
*/
export function advisePath(input: { snapshot: DomainSnapshot; vmlNameservers: string[]; vmlBought: boolean }): PathAdvice {
  const ns = new Set(input.snapshot.nameservers.map(clean));
  if (input.vmlNameservers.length && input.vmlNameservers.every((n) => ns.has(clean(n)))) return { path: "vml_dns", why: "The domain already uses VML's Cloudflare, so TAWD sets the records itself." };
  if (input.vmlBought) return { path: "vml_dns", why: "VML bought this domain, so its DNS is on VML's Cloudflare and TAWD sets everything itself." };
  return { path: "records", why: "The client keeps the domain where it is: two changes at their DNS provider, and their email isn't touched." };
}

export const PATH_LABELS: Record<ConnectPath, string> = {
  records: "The client points two records",
  access: "VML points them (the client gives access)",
  vml_dns: "VML runs the DNS (Cloudflare)",
};

/* ---------- reading DNS-over-HTTPS answers ---------- */

/** The values of one record type in a DNS-over-HTTPS JSON answer (Cloudflare's or Google's). */
export function dohValues(json: unknown, type: number): string[] | null {
  const o = json as { Status?: number; Answer?: { type?: number; data?: string }[] } | null;
  if (!o || typeof o.Status !== "number") return null;
  if (o.Status !== 0 && o.Status !== 3) return null;
  return (o.Answer ?? [])
    .filter((a) => a.type === type && typeof a.data === "string")
    .map((a) => {
      const data = type === 257 ? caaText(a.data!) : a.data!;
      // MX answers are "10 aspmx.l.google.com."; keep the host.
      return type === 15 ? data.split(/\s+/).pop()!.replace(/\.$/, "") : data.replace(/\.$/, "");
    });
}

export const DNS_TYPES = { A: 1, NS: 2, CNAME: 5, MX: 15, AAAA: 28, DS: 43, CAA: 257 } as const;

/*
  A CAA answer as text ("0 issue \"letsencrypt.org\""). Some resolvers send
  it in the generic form ("\# 19 00 05 69 73 73 75 65 ..."): flags, the
  tag's length, the tag, then the value.
*/
export function caaText(data: string): string {
  const generic = /^\\#\s+\d+\s+([0-9a-f\s]+)$/i.exec(data.trim());
  if (!generic) return data;
  const bytes = generic[1]!.replace(/\s+/g, "").match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  if (bytes.length < 2) return data;
  const flags = bytes[0]!;
  const tagLength = bytes[1]!;
  const tag = String.fromCharCode(...bytes.slice(2, 2 + tagLength));
  const value = String.fromCharCode(...bytes.slice(2 + tagLength));
  return `${flags} ${tag} "${value}"`;
}
