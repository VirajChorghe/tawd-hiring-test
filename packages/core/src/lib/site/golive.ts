import type { ChecklistItem } from "./publish";

/*
  Phase 9, go-live (28 September 2026). The rules, with no network: which
  of the client's DNS records keep their email working, the records the
  Netlify site needs, how the copied records are compared, and the gate.

  The domain is always registered in the client's name. DNS moves to a
  zone on VML's Cloudflare account; the client's email records are copied
  there first and checked before the nameservers are switched, because a
  switch without them stops the client's email.
*/

export type DnsRecordType = "MX" | "TXT" | "CNAME" | "SRV" | "A";

export interface DnsRecord {
  type: DnsRecordType;
  /** The full name, lower case, no trailing dot: "example.com", "_dmarc.example.com". */
  name: string;
  content: string;
  priority?: number;
}

/*
  DKIM selectors can't be listed from DNS, so the common ones are tried
  (Google Workspace, Microsoft 365, Zoho, Fastmail, Mailchimp and others)
  and the PM adds any the client's email provider names.
*/
export const COMMON_DKIM_SELECTORS = ["google", "selector1", "selector2", "k1", "k2", "default", "dkim", "mail", "s1", "s2", "zoho", "zmail", "fm1", "fm2", "fm3", "mandrill", "protonmail", "protonmail2", "protonmail3"];

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export function isDomain(input: string): boolean {
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalizeDomain(input));
}

/** Where to look, in public DNS, for what keeps the client's email working. */
export function emailLookups(domain: string, selectors: string[] = []): { type: DnsRecordType; name: string }[] {
  const d = normalizeDomain(domain);
  const dkim = [...new Set([...COMMON_DKIM_SELECTORS, ...selectors.map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9._-]{1,63}$/.test(s))])];
  return [
    { type: "MX", name: d },
    { type: "TXT", name: d },
    { type: "TXT", name: `_dmarc.${d}` },
    ...dkim.map((s) => ({ type: "TXT" as const, name: `${s}._domainkey.${d}` })),
    ...dkim.map((s) => ({ type: "CNAME" as const, name: `${s}._domainkey.${d}` })),
    { type: "CNAME", name: `autodiscover.${d}` },
    { type: "CNAME", name: `mail.${d}` },
    { type: "CNAME", name: `webmail.${d}` },
    { type: "SRV", name: `_autodiscover._tcp.${d}` },
  ];
}

/*
  Which apex TXT records to keep: all of them except none. SPF and the
  providers' domain verifications (google-site-verification, MS=) matter
  for email; other TXT records are kept too, since dropping one is the
  riskier mistake.
*/
export function keepRecord(record: DnsRecord): boolean {
  return record.content.trim().length > 0;
}

export function normalizeContent(record: DnsRecord): string {
  const content = record.type === "TXT" ? record.content.replace(/^"|"$/g, "").replace(/"\s*"/g, "") : record.content.toLowerCase().replace(/\.$/, "");
  return content.trim();
}

export function recordKey(record: DnsRecord): string {
  return `${record.type} ${record.name.toLowerCase().replace(/\.$/, "")} ${record.priority ?? ""} ${normalizeContent(record)}`;
}

/*
  What the Netlify site needs: the bare domain and www, both pointing at the
  site. Cloudflare flattens a CNAME at the bare domain. Never proxied (grey
  cloud), so Netlify can issue the HTTPS certificate.
*/
export function netlifyRecords(domain: string, netlifySiteName: string): DnsRecord[] {
  const d = normalizeDomain(domain);
  const target = `${netlifySiteName}.netlify.app`;
  return [
    { type: "CNAME", name: d, content: target },
    { type: "CNAME", name: `www.${d}`, content: target },
  ];
}

/*
  What a WordPress site on 20i needs on VML's Cloudflare (5 October 2026):
  the bare domain and www at the package's IPv4, never proxied (visitors and
  the certificate reach 20i directly; the IP watch can rewrite both).
*/
export function twentyiRecords(domain: string, ipv4: string): DnsRecord[] {
  const d = normalizeDomain(domain);
  return [
    { type: "A", name: d, content: ipv4 },
    { type: "A", name: `www.${d}`, content: ipv4 },
  ];
}

/** Every wanted record, found or not, as the check shows it. */
export function compareRecords(wanted: DnsRecord[], found: DnsRecord[]): { record: DnsRecord; ok: boolean }[] {
  const have = new Set(found.map(recordKey));
  return wanted.map((record) => ({ record, ok: have.has(recordKey(record)) }));
}

export function describeRecord(record: DnsRecord): string {
  return `${record.type} ${record.name}${record.priority !== undefined ? ` ${record.priority}` : ""} ${normalizeContent(record)}`;
}

/* ---------- the gate ---------- */

export interface GoLiveSteps {
  domainConfirmed: boolean;
  emailVerified: boolean;
  emailConfirmed: boolean;
  netlifyDomain: boolean;
  nameserversSwitched: boolean;
  httpsConfirmed: boolean;
  ga4Recorded: boolean;
  /** F3: the client's two records are in place (the records and access paths). */
  recordsOk?: boolean;
}

export interface GoLiveGateInput {
  buildFeePaid: boolean;
  /** The latest build's checklist, with health flags and the SEO sign-off already folded in. */
  checklist: ChecklistItem[];
  steps: GoLiveSteps;
  /** For the founders, never a block: a licensed trade with no license number yet. */
  founderFlags: string[];
  hasBuild: boolean;
  /** Hosting is WordPress (B3, 1 October 2026; on 20i since 5 October 2026): its own steps, below. */
  wordpress?: boolean;
  /** B3: the WordPress preview on the build being put live, and the domain added on the site's 20i package. */
  wordpressSteps?: { previewCurrent: boolean; latestBuild: number | null; onHost: boolean };
  /** DNSSEC is on at the registrar and the nameservers aren't switched yet (28 September 2026). */
  dnssecOn?: { domain: string; registrar: string | null };
  /** F3: how the domain is connected; the nameserver steps only for vml_dns (and before F3, when it's unset). */
  path?: "records" | "access" | "vml_dns" | null;
  /** F2: a recipient confirmed the test message; null while messages don't go through TAWD (Postmark not set up). */
  formsConfirmed?: boolean | null;
  /**
   * The speed gate (Jason, 1 October 2026): the Speed check on the preview of the build going live (null: none yet),
   * and whether a founder let it go live below the minimum.
   */
  speed?: { checked: { phone: number | null; computer: number | null } | null; overridden: boolean; preview: string };
}

export interface GoLiveGate {
  ready: boolean;
  blockers: string[];
  /** Shown, never blocking. */
  flags: string[];
}

/* The speed gate (Jason, 1 October 2026): aim for 90 on a phone and a computer; 85 to 89 is the buffer; under 85 blocks go-live. */
export const SPEED_TARGET = 90;
export const SPEED_MINIMUM = 85;

export function goLiveGate(input: GoLiveGateInput): GoLiveGate {
  const blockers: string[] = [];
  if (!input.hasBuild) blockers.push("There is no finished build to put live.");
  if (!input.buildFeePaid) blockers.push("The build fee isn't recorded as paid (an admin or a founder records it).");
  for (const item of input.checklist) {
    if (item.blocksGoLive && !item.ok) blockers.push(`${item.label}: ${item.detail}`);
  }
  const s = input.steps;
  if (!s.domainConfirmed) blockers.push("The domain isn't confirmed as registered in the client's name.");
  if (input.wordpress) {
    // B3 on 20i: the domain is added on the site's own package; two records point it there, or VML runs its DNS (Cloudflare). No Netlify.
    const wp = input.wordpressSteps ?? { previewCurrent: false, latestBuild: null, onHost: false };
    if (!wp.previewCurrent) blockers.push(`The WordPress preview isn't on the latest build${wp.latestBuild ? ` (version ${wp.latestBuild})` : ""}: deploy it again first (Hosting).`);
    if (!wp.onHost) blockers.push("The domain isn't on the site's 20i package yet (Put the domain on 20i).");
    if (input.path === "vml_dns") {
      if (!s.emailVerified) blockers.push("The client's email records haven't been checked on Cloudflare.");
      if (!s.emailConfirmed) blockers.push("The PM hasn't confirmed the email records with the client's email provider.");
      if (!s.nameserversSwitched && input.dnssecOn) blockers.push(DNSSEC_ON_MESSAGE(input.dnssecOn.domain, input.dnssecOn.registrar));
      if (!s.nameserversSwitched) blockers.push("The domain's nameservers haven't been switched to Cloudflare yet.");
    } else if (!s.recordsOk) blockers.push("The domain's two records aren't pointing at the site's 20i package yet (Connect the domain).");
  } else if (input.path === "records" || input.path === "access") {
    // F3: two records at the client's DNS provider; their email is never touched, so there's nothing to copy or confirm.
    if (!s.recordsOk) blockers.push("The domain's two records aren't pointing at the new site yet (Connect the domain).");
    if (!s.netlifyDomain) blockers.push("The domain isn't on the Netlify site yet.");
  } else {
    if (!s.emailVerified) blockers.push("The client's email records haven't been checked on Cloudflare.");
    if (!s.emailConfirmed) blockers.push("The PM hasn't confirmed the email records with the client's email provider.");
    if (!s.netlifyDomain) blockers.push("The domain isn't on the Netlify site yet.");
    if (!s.nameserversSwitched && input.dnssecOn) blockers.push(DNSSEC_ON_MESSAGE(input.dnssecOn.domain, input.dnssecOn.registrar));
    if (!s.nameserversSwitched) blockers.push("The domain's nameservers haven't been switched to Cloudflare yet.");
  }
  if (!s.httpsConfirmed) blockers.push("HTTPS isn't confirmed on the domain yet.");
  if (input.formsConfirmed === false) blockers.push("Form messages: the client hasn't confirmed the test message yet (Form messages, Send a test message).");
  const flags = [...input.founderFlags];
  if (input.speed) {
    const sp = input.speed;
    const low = sp.checked ? Math.min(sp.checked.phone ?? 0, sp.checked.computer ?? 0) : null;
    const scores = sp.checked ? `phone ${sp.checked.phone ?? "no score"}, computer ${sp.checked.computer ?? "no score"}` : "";
    if (!sp.checked) blockers.push(`Speed: run the Speed check on the ${sp.preview} of this build first (Speed check, Go live).`);
    else if (low! < SPEED_MINIMUM && sp.overridden) flags.push(`Speed: ${scores}, below ${SPEED_MINIMUM}; a founder let it go live.`);
    else if (low! < SPEED_MINIMUM) blockers.push(`Speed: ${scores}. Both need ${SPEED_MINIMUM} or more to go live (the aim is ${SPEED_TARGET}); improve the site, or a founder lets it go live (Speed check).`);
    else if (low! < SPEED_TARGET) flags.push(`Speed: ${scores}, within the buffer (the aim is ${SPEED_TARGET}).`);
  }
  if (!s.ga4Recorded) flags.push("GA4 isn't recorded yet (a client-owned property with VML as Editor).");
  return { ready: blockers.length === 0, blockers, flags };
}

/* The live version of a build's robots.txt and _headers (every other file is the same). */
export const LIVE_FILES = ["robots.txt", "_headers"] as const;

/* A GA4 property is numeric; its measurement ID is G- then letters and digits. */
export function checkGa4(input: { propertyId: string; measurementId: string }): string | null {
  if (!/^\d{6,12}$/.test(input.propertyId.trim())) return "The GA4 property ID is the number in GA4's Admin, Property details (6 to 12 digits).";
  if (!/^G-[A-Z0-9]{4,12}$/.test(input.measurementId.trim().toUpperCase())) return "The measurement ID looks like G-ABC123XYZ (GA4's Admin, Data streams).";
  return null;
}

/* ---------- the registrar and DNSSEC (28 September 2026) ---------- */

/*
  Before the nameserver switch the PM needs to know where the domain is
  registered (that is where the switch is made) and whether DNSSEC is on:
  switching nameservers with DNSSEC still on at the registrar breaks the
  domain (the site and the client's email) until it is turned off.
*/

export interface RegistryInfo {
  registrar: string | null;
  registrarUrl: string | null;
  nameservers: string[];
  /** What RDAP says about DNSSEC (secureDNS.delegationSigned); null when it doesn't say. */
  rdapSigned: boolean | null;
}

/* The registrar, its web address and the nameservers from an RDAP domain answer (RFC 9083). */
export function readRdap(json: unknown): RegistryInfo {
  const o = (json ?? {}) as {
    entities?: { roles?: string[]; vcardArray?: unknown[]; links?: { href?: string; rel?: string }[]; publicIds?: unknown[] }[];
    nameservers?: { ldhName?: string }[];
    secureDNS?: { delegationSigned?: boolean };
  };
  const registrarEntity = (o.entities ?? []).find((e) => e.roles?.includes("registrar"));
  const card = Array.isArray(registrarEntity?.vcardArray?.[1]) ? (registrarEntity!.vcardArray![1] as unknown[][]) : [];
  const fn = card.find((field) => Array.isArray(field) && field[0] === "fn");
  const registrar = fn && typeof fn[3] === "string" && fn[3].trim() ? fn[3].trim() : null;
  const url = card.find((field) => Array.isArray(field) && field[0] === "url");
  const registrarUrl = (url && typeof url[3] === "string" ? url[3] : null) ?? registrarEntity?.links?.find((l) => l.rel === "about" || l.rel === "related")?.href ?? null;
  const nameservers = (o.nameservers ?? []).map((n) => (n.ldhName ?? "").toLowerCase().replace(/\.$/, "")).filter(Boolean);
  const signed = o.secureDNS?.delegationSigned;
  return { registrar, registrarUrl, nameservers, rdapSigned: typeof signed === "boolean" ? signed : null };
}

/** When the domain's registration runs out, from an RDAP domain answer (its "expiration" event); null when it doesn't say. */
export function rdapExpiry(json: unknown): Date | null {
  const events = ((json ?? {}) as { events?: { eventAction?: string; eventDate?: string }[] }).events ?? [];
  const at = events.find((e) => e.eventAction === "expiration")?.eventDate;
  const date = at ? new Date(at) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/*
  Where to ask RDAP about a domain (0.122.1, 4 November 2026). rdap.org, the redirect service TAWD used before, answers TAWD's
  server with a 403 page (found by the preview domain's first watch run; the go-live registrar check was hit too): the domain's own
  registry is asked instead, found in IANA's RDAP bootstrap list (RFC 9224; .com is Verisign's https://rdap.verisign.com/com/v1/).
  The list is read once a day per process; only a real list is kept (an error object answered with 200 is not), a failed refresh
  keeps the older list, and lookups at the same moment share one download. rdap.org stays as the last resort when no list has been
  read yet or it has no registry for the domain's ending, but it refuses TAWD's server, so in practice that lookup fails and is
  tried again at the next run (the watch's hour, the next go-live check).
*/
export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const RDAP_FALLBACK_BASE = "https://rdap.org/";
const RDAP_BOOTSTRAP_EVERY_MS = 24 * 3_600_000;

/** The registry's RDAP base for a domain from IANA's bootstrap list: the longest matching ending, https only; null when none. */
export function rdapBaseFor(bootstrap: unknown, domain: string): string | null {
  const services = (bootstrap as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return null;
  const name = domain.toLowerCase().replace(/\.$/, "");
  let best: { length: number; base: string } | null = null;
  for (const service of services) {
    if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
    const base = (service[1] as unknown[]).find((u): u is string => typeof u === "string" && u.startsWith("https://"));
    if (!base) continue;
    for (const ending of service[0] as unknown[]) {
      if (typeof ending !== "string" || !ending) continue;
      const e = ending.toLowerCase();
      if ((name === e || name.endsWith(`.${e}`)) && (!best || e.length > best.length)) best = { length: e.length, base };
    }
  }
  return best ? (best.base.endsWith("/") ? best.base : `${best.base}/`) : null;
}

type JsonGet = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
let bootstrapCache: { at: number; list: unknown } | null = null;
let bootstrapLoading: Promise<void> | null = null;

/** Tests start each case without a remembered bootstrap list. */
export function resetRdapBootstrapForTesting(): void {
  bootstrapCache = null;
  bootstrapLoading = null;
}

async function loadBootstrap(get: JsonGet, now: number): Promise<void> {
  try {
    const response = await get(RDAP_BOOTSTRAP_URL);
    if (!response.ok) return;
    const list = await response.json();
    // Only a real list replaces what is kept: anything else (an error object with a 200) leaves the older list in place.
    if (Array.isArray((list as { services?: unknown } | null)?.services)) bootstrapCache = { at: now, list };
  } catch {
    // The older list (or the last resort) below; the list is asked again next time.
  }
}

/** The RDAP address to ask about a domain: its registry's (IANA's list), or rdap.org when the list can't say. Never throws. */
export async function rdapDomainUrl(domain: string, get: JsonGet, now = Date.now()): Promise<string> {
  if (!bootstrapCache || now - bootstrapCache.at >= RDAP_BOOTSTRAP_EVERY_MS) {
    // Lookups at the same moment share one download.
    bootstrapLoading ??= loadBootstrap(get, now).finally(() => {
      bootstrapLoading = null;
    });
    await bootstrapLoading;
  }
  const base = bootstrapCache ? rdapBaseFor(bootstrapCache.list, domain) : null;
  return `${base ?? RDAP_FALLBACK_BASE}domain/${encodeURIComponent(domain.toLowerCase().replace(/\.$/, ""))}`;
}

/*
  Whether the domain's parent zone publishes a DS record for it, from a
  DNS-over-HTTPS JSON answer (Cloudflare's or Google's). A DS record means
  DNSSEC is on. null when the answer can't be read.
*/
export function dnssecFromDoh(json: unknown): boolean | null {
  const o = json as { Status?: number; Answer?: { type?: number }[] } | null;
  if (!o || typeof o.Status !== "number") return null;
  // 0 is NOERROR, 3 is NXDOMAIN (no such domain: nothing signed).
  if (o.Status !== 0 && o.Status !== 3) return null;
  return (o.Answer ?? []).some((a) => a.type === 43);
}

export const DNSSEC_ON_MESSAGE = (domain: string, registrar: string | null) =>
  `DNSSEC is on for ${domain}. Switching the nameservers now would take the website and the client's email offline until it's fixed. Turn DNSSEC off at ${registrar ?? "the registrar"} first (it's usually under DNSSEC or DS records in the domain's settings), wait until it's gone (a few hours, sometimes a day or two), then check again. Cloudflare can turn DNSSEC back on after the switch.`;
