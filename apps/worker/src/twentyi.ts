import { createHash } from "node:crypto";

/*
  20i's reseller API (Build B on 20i, 5 October 2026; docs/plans/build-b-20i.md).

  The only file that knows 20i's addresses and payloads: one function per
  call. Each says where it was checked: "VERIFIED: 20i.apib, <section>
  (line)" is 20i's own Reseller API reference (API Blueprint, exported from
  My20i by the account owner, 6 October 2026; kept outside the repo at
  E:\tawd-work\tawd-docs\20i\20i.apib), or "NOT IN THE API: <what TAWD does instead>".
  Line numbers are that file's.

  TWENTYI_API_KEY is read by the worker only (Fable's review, finding 3),
  sent to api.20i.com and nowhere else, never logged, stored or shown to an
  AI. Everything 20i answers is checked against a strict pattern before it
  reaches a command, a file path or a DNS record.
*/

/** VERIFIED: 20i.apib, header (line 2, HOST https://api.20i.com/). */
export const TWENTYI_BASE = "https://api.20i.com";

/** NOT IN THE API (no SSH host, user or host key in 20i.apib): https://docs.20i.com/reseller-hosting/connect-via-ssh (every US package: domain@ssh.us.stackcp.com). */
export const TWENTYI_SSH_HOST = "ssh.us.stackcp.com";
export const TWENTYI_SSH_PORT = 22;

/**
  Where a package's website lives, from the SSH user's home folder. VERIFIED by construction: TAWD sets it itself, in addWeb's
  required documentRoots (20i.apib, Package Add, line 3157) and for every name it adds (Document Roots line 1855, updateDocRoot line 2200).
*/
export const TWENTYI_WEB_ROOT = "public_html";

/** 20i's paid certificate product TAWD orders: "Simple SSL" (RapidSSL, sold through Tucows). VERIFIED: 20i.apib, Order SSL Certificates (line 763). */
export const PAID_CERT_CLASS = "tucows-rapidssl";

export type TwentyiErrorKind = "config" | "auth" | "payment" | "not_found" | "rate" | "server" | "refused" | "network" | "answer";

export class TwentyiError extends Error {
  constructor(
    message: string,
    readonly kind: TwentyiErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "TwentyiError";
  }
}

export interface TwentyiPackageSummary {
  id: string;
  /** The package's main domain. */
  name: string;
  names: string[];
  typeRef: string | null;
  enabled: boolean;
}

export interface TwentyiPackage {
  id: string;
  name: string;
  names: string[];
  typeRef: string | null;
  /** The IPv4 visitors reach the site on (what the client's A record points at). */
  ipv4: string | null;
  /** 20i's IPv6 for the site (never used for records: TAWD points A records only). */
  ipv6: string | null;
  /** 20i's temporary (staging) address for the main domain, as 20i answers it; null when it didn't say. */
  stagingHost: string | null;
  /** False while 20i is still setting the package up (addWeb answers before it's ready). */
  setupComplete: boolean;
}

export interface TwentyiPackageType {
  id: string;
  label: string;
  platform: string | null;
}

export interface TwentyiDatabase {
  name: string;
  /** 20i makes a user with the same name as the database. */
  user: string;
  /** The host PHP uses to reach it (never assumed to be localhost). */
  host: string;
}

export interface TwentyiCertificateOrder {
  id: string;
  /** 20i's answer has no price: always null from the API (the price is PAID_CERT_PRICE, from 20i's sales). */
  price: number | null;
  renewsAt: string | null;
}

export interface CertificateFiles {
  /** The names the certificate covers (the domain and www): 20i installs one per name, so it goes on each. */
  names: string[];
  certificate: string;
  privateKey: string;
  caBundle: string;
}

export interface TwentyiApi {
  listPackages(): Promise<TwentyiPackageSummary[]>;
  getPackage(packageId: string): Promise<TwentyiPackage | null>;
  listPackageTypes(): Promise<TwentyiPackageType[]>;
  createPackage(input: { typeId: string; domain: string; label: string }): Promise<string>;
  deletePackage(packageId: string): Promise<void>;
  setPackageEnabled(packageId: string, enabled: boolean): Promise<void>;
  addDomain(packageId: string, domain: string): Promise<void>;
  /** Each name's website folder, from the package's home folder ("public_html"). */
  documentRoots(packageId: string): Promise<Record<string, string>>;
  createDatabase(packageId: string, input: { name: string; password: string }): Promise<TwentyiDatabase>;
  listDatabases(packageId: string): Promise<TwentyiDatabase[]>;
  /** "added", or "present" when the package already had it. */
  addSshKey(packageId: string, publicKey: string): Promise<"added" | "present">;
  setPhpVersion(packageId: string, version: string): Promise<void>;
  /** Everything 20i's CDN holds for the package (every name on it). */
  purgeCache(packageId: string): Promise<void>;
  installCertificate(packageId: string, files: CertificateFiles): Promise<void>;
  orderCertificate(input: { packageId: string; domain: string; periodMonths: number }): Promise<TwentyiCertificateOrder>;
}

/* ---------- checks on what 20i answers ---------- */

const HOST = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;
/** Database and user names: 20i may add a suffix; always quoted when they reach a command. */
const DB_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PHP = /^\d+\.\d+$/;

export const isHostName = (value: string) => HOST.test(value);
export const isIpv4 = (value: string) => IPV4.test(value);

function idFrom(value: unknown, what: string): string {
  const id = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!ID.test(id)) throw new TwentyiError(`20i's answer had no usable ${what}.`, "answer");
  return id;
}

const hostOrNull = (value: unknown) => (typeof value === "string" && HOST.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);
const ipOrNull = (value: unknown) => (typeof value === "string" && IPV4.test(value.trim()) ? value.trim() : null);
const ip6OrNull = (value: unknown) => (typeof value === "string" && value.includes(":") && IPV6.test(value.trim()) ? value.trim().toLowerCase() : null);

/** A host from 20i's temporary URL, which may come as an address or a bare host. */
function hostFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return hostOrNull(new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`).hostname);
  } catch {
    return null;
  }
}

/** 20i's staging address for a main domain: dots become dashes, then .stackstaging.com. Used when 20i's answer has no temporaryUrls: https://docs.20i.com/web-hosting/temporary-urls */
export function stagingHostFor(mainDomain: string): string {
  return `${mainDomain.toLowerCase().replace(/\./g, "-")}.stackstaging.com`;
}

/** Where TAWD signs in to a package (NOT IN THE API: https://docs.20i.com/reseller-hosting/connect-via-ssh). */
export function sshAccessFor(mainDomain: string): { host: string; port: number; user: string } {
  return { host: TWENTYI_SSH_HOST, port: TWENTYI_SSH_PORT, user: mainDomain.toLowerCase() };
}

/** "8.3" → "php83", the form 20i's phpVersion uses (20i.apib, PHP Version, line 13641: "e.g. php82"). */
export function phpValueFor(version: string): string {
  if (!PHP.test(version)) throw new TwentyiError(`Not a PHP version: ${version}.`, "answer");
  return `php${version.replace(".", "")}`;
}

/** An OpenSSH public key's type and body, without its comment (20i may keep or drop the comment). */
export function sshKeyBody(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** The first certificate's body in a PEM text, whitespace removed (to find TAWD's own certificate in 20i's list). */
function pemBody(pem: string): string {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  return (match?.[1] ?? "").replace(/\s+/g, "");
}

/* ---------- the HTTP client ---------- */

type Fetch = typeof fetch;
let fetchOverride: Fetch | null = null;
let apiOverride: TwentyiApi | null = null;

/** Tests answer 20i's HTTP calls themselves (to check the payloads). */
export function setTwentyiFetchForTesting(stand: Fetch | null): void {
  fetchOverride = stand;
}

/** Tests replace the whole client with the in-memory reseller (twentyi-fake.ts). */
export function setTwentyiForTesting(api: TwentyiApi | null): void {
  apiOverride = api;
}

export function twentyiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TWENTYI_API_KEY?.trim());
}

/** The client: the stand-in in tests, otherwise 20i's API with the worker's key. */
export function getTwentyi(): TwentyiApi {
  return apiOverride ?? httpTwentyi(process.env.TWENTYI_API_KEY?.trim() ?? "");
}

/*
  NOT IN THE API: 20i.apib documents only the 200 answers; error bodies, status codes and rate limits aren't described (it names the
  exceptions ConflictingObject, InvalidRequest and NotFoundException, lines 3175 and 4198). So TAWD reads any "error", "message" or
  "type" text 20i sends and maps the usual HTTP statuses; a 429 is read as "slow down" in case 20i ever sends one.
*/
export function explain(status: number, body: unknown): TwentyiError {
  let said = "";
  if (typeof body === "string") said = body;
  else if (typeof body === "object" && body) {
    const b = body as Record<string, unknown>;
    said = [b.error, b.message, b.type, b.reason, b.detail].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? "";
    /*
      Whatever else 20i sent, as it came (8 October 2026: the first real
      package was refused with "20i said no (400)" and nothing else shown,
      because its answer had none of the fields above).
    */
    const whole = JSON.stringify(body);
    if (whole && whole !== "{}" && !said) said = whole;
    else if (whole && whole !== "{}" && !whole.includes(said)) said = `${said} ${whole}`;
  }
  said = said.replace(/\s+/g, " ").trim().slice(0, 400);
  /*
    A 403 with 20i's own reason is a refusal of that one request, not a bad key (8 October 2026: adding the preview address answered
    403 "Refused (platform policy): ... first add ... its root domain", and the card blamed the key).
  */
  if (status === 403 && said && !/api key|token|unauthori[sz]ed|authenticat|credential/i.test(said))
    return new TwentyiError(`20i said no (${status}): ${said}`, "refused", status);
  if (status === 401 || status === 403) return new TwentyiError("20i refused TAWD's API key. Check TWENTYI_API_KEY on the worker (tawd-worker-new): it's the General API key from My20i, Reseller API.", "auth", status);
  if (status === 402) return new TwentyiError("20i wants payment on VML's reseller account before it does this. Check the account's balance in My20i.", "payment", status);
  if (status === 404) return new TwentyiError(`20i doesn't know that${said ? `: ${said}` : ""}.`, "not_found", status);
  if (status === 429) return new TwentyiError("20i is asking TAWD to slow down. Try again in a minute.", "rate", status);
  if (status >= 500) return new TwentyiError(`20i's API had a problem (${status}). Try again in a few minutes.`, "server", status);
  return new TwentyiError(`20i said no (${status})${said ? `: ${said}` : "."}`, "refused", status);
}

export function httpTwentyi(apiKey: string): TwentyiApi {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { nullOn404?: boolean } = {}): Promise<T | null> {
    if (!apiKey) throw new TwentyiError("TWENTYI_API_KEY isn't set on the worker. An admin adds it in Coolify on tawd-worker-new only, then redeploys the worker.", "config");
    let response: Response;
    try {
      // VERIFIED: 20i.apib, header (lines 4-39): "Authorization: Bearer <base64 of the General API key>", JSON bodies accepted,
      // the reseller id written "*".
      response = await (fetchOverride ?? fetch)(`${TWENTYI_BASE}${path}`, {
        method,
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the key comes from the environment; none is written in the code
        headers: { Authorization: `Bearer ${Buffer.from(apiKey, "utf8").toString("base64")}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new TwentyiError(`TAWD couldn't reach 20i's API (${error instanceof Error ? error.message : "no answer"}). Try again in a few minutes.`, "network");
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text || null;
    }
    // 20i's SDK treats a 404 on a read as "nothing there".
    if (response.status === 404 && opts.nullOn404) return null;
    if (!response.ok) {
      // The worker's log keeps 20i's whole answer (the key never is: it's only in the header).
      console.error(`[20i] ${method} ${path} -> ${response.status}: ${(text || "(empty)").slice(0, 2000)}`);
      throw explain(response.status, json);
    }
    return json as T;
  }

  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const pkgPath = (id: string, rest = "") => `/package/${encodeURIComponent(id)}${rest}`;

  /** VERIFIED: 20i.apib, MySQL Databases, GET (line 13234): [{ id, name, host, server, externalHostname, ... }]; the user has the database's name. */
  /** VERIFIED: 20i.apib, Document Roots, GET /package/{id}/web/documentRoots (line 1855): { name: folder }; slashes trimmed here. */
  async function documentRoots(packageId: string): Promise<Record<string, string>> {
    const roots = await call<Record<string, unknown>>("GET", pkgPath(packageId, "/web/documentRoots"));
    if (!roots || typeof roots !== "object" || Array.isArray(roots)) return {};
    return Object.fromEntries(Object.entries(roots).map(([name, folder]) => [name, String(folder ?? "").replace(/^\/+|\/+$/g, "")]));
  }

  async function databases(packageId: string, nullOn404: boolean): Promise<TwentyiDatabase[]> {
    const rows = list<Record<string, unknown>>(await call("GET", pkgPath(packageId, "/web/mysqlDatabases"), undefined, { nullOn404 }));
    return rows
      .map((r) => {
        const name = String(r.name ?? "");
        return { name, user: String(r.username ?? r.user ?? name), host: hostOrNull(r.host) ?? hostOrNull(r.server) ?? "" };
      })
      .filter((d) => DB_NAME.test(d.name) && DB_NAME.test(d.user) && d.host);
  }

  return {
    /** VERIFIED: 20i.apib, List Packages, GET /package (line 2813): [{ id, enabled, name, names, typeRef, ... }]. */
    async listPackages() {
      const rows = list<Record<string, unknown>>(await call("GET", "/package"));
      return rows.map((r) => ({
        id: idFrom(r.id, "package id"),
        name: String(r.name ?? "").toLowerCase(),
        names: list<string>(r.names).map((n) => String(n).toLowerCase()),
        typeRef: r.typeRef === undefined || r.typeRef === null ? null : String(r.typeRef),
        enabled: r.enabled !== false,
      }));
    },

    /**
      VERIFIED: 20i.apib, Package, GET /package/{id}/web (line 3002): { name, names, typeRef, setupComplete, info: { ip4Address,
      ip6Address, temporaryUrls: { <domain>: <address> } } }. (GET /package/{id}, line 3075, leaves "web" undescribed, so it's read here.)
    */
    async getPackage(packageId) {
      const r = await call<Record<string, unknown>>("GET", pkgPath(packageId, "/web"), undefined, { nullOn404: true });
      if (!r || typeof r !== "object") return null;
      const info = (r.info ?? {}) as { ip4Address?: unknown; ip6Address?: unknown; temporaryUrls?: unknown };
      const name = String(r.name ?? "").toLowerCase();
      const temporary = info.temporaryUrls && typeof info.temporaryUrls === "object" ? (info.temporaryUrls as Record<string, unknown>) : {};
      const tempKey = Object.keys(temporary).find((k) => k.toLowerCase() === name) ?? Object.keys(temporary)[0];
      return {
        id: idFrom(packageId, "package id"),
        name,
        names: list<string>(r.names).map((n) => String(n).toLowerCase()),
        typeRef: r.typeRef === undefined || r.typeRef === null ? null : String(r.typeRef),
        ipv4: ipOrNull(info.ip4Address),
        ipv6: ip6OrNull(info.ip6Address),
        stagingHost: tempKey ? hostFromUrl(temporary[tempKey]) : null,
        setupComplete: r.setupComplete !== false,
      };
    },

    /** VERIFIED: 20i.apib, Package Types, GET /reseller/*\/packageTypes (line 3614): [{ id, label, platform, limits, extraData, ... }]. */
    async listPackageTypes() {
      const rows = list<Record<string, unknown>>(await call("GET", "/reseller/*/packageTypes"));
      return rows.map((r) => ({ id: idFrom(r.id, "package type id"), label: String(r.label ?? r.id), platform: typeof r.platform === "string" ? r.platform : null }));
    },

    /*
      NOT IN THE API: data centres. 20i.apib has no list of locations and addWeb takes none (only stack-user allowances do, line 3268), so
      a package lands where VML's account puts it (day-one check: the US).
    */

    /**
      VERIFIED: 20i.apib, Package Add, POST /reseller/*\/addWeb (line 3157): { type, domain_name, label, documentRoots } (documentRoots
      required) → the new id, a bare number. It answers before the package is ready: getPackage's setupComplete says when it is.
    */
    async createPackage(input) {
      const answer = await call<unknown>("POST", "/reseller/*/addWeb", {
        // 20i's reference: a string ("A web type reference, equivalent to the id in /packageTypes").
        type: String(input.typeId),
        domain_name: input.domain,
        label: input.label,
        documentRoots: { [input.domain]: TWENTYI_WEB_ROOT },
      });
      return idFrom(answer && typeof answer === "object" ? (answer as { result?: unknown }).result : answer, "package id");
    },

    /** VERIFIED: 20i.apib, Package Delete, POST /reseller/*\/deleteWeb (line 3522): { "delete-id": [id] } → { <id>: true }. */
    async deletePackage(packageId) {
      const answer = await call<unknown>("POST", "/reseller/*/deleteWeb", { "delete-id": [packageId] });
      if (answer && typeof answer === "object" && (answer as Record<string, unknown>)[packageId] === false)
        throw new TwentyiError(`20i didn't delete package ${packageId} (a site move is running on it, or another site depends on it). Try again later, or delete it in My20i.`, "refused");
    },

    /** VERIFIED: 20i.apib, Activate/Deactivate package, POST /package/{id}/userStatus (line 1504): { includeRepeated, subservices: { default: bool } }. */
    async setPackageEnabled(packageId, enabled) {
      await call("POST", pkgPath(packageId, "/userStatus"), { includeRepeated: true, subservices: { default: enabled } });
    },

    /**
      VERIFIED: 20i.apib, Domain Names/Subdomains, POST /package/{id}/names { add: [name] } (line 1996; names already there are
      skipped), then the name's document root read (Document Roots, line 1855) and set to the web root if 20i chose another (updateDocRoot, line 2200).
    */
    async addDomain(packageId, domain) {
      await call("POST", pkgPath(packageId, "/names"), { add: [domain] });
      const roots = await documentRoots(packageId);
      if (roots[domain] !== TWENTYI_WEB_ROOT) await call("POST", pkgPath(packageId, "/web/updateDocRoot"), { update: { [domain]: TWENTYI_WEB_ROOT } });
    },

    documentRoots,

    /**
      VERIFIED: 20i.apib, MySQL Databases, POST /package/{id}/web/mysqlDatabases { name, password } (line 13234): makes the database and a
      user of the same name, and answers [] (no names, no host). So TAWD reads the list after it for the names and host 20i gave.
    */
    async createDatabase(packageId, input) {
      const before = await databases(packageId, true);
      await call("POST", pkgPath(packageId, "/web/mysqlDatabases"), { name: input.name, password: input.password });
      const after = await databases(packageId, false);
      const made = after.find((d) => d.name === input.name) ?? after.find((d) => d.name.startsWith(input.name) && !before.some((b) => b.name === d.name));
      if (!made) throw new TwentyiError("20i took the database but its list doesn't show it (or shows names or a host TAWD can't use). Deploy again in a few minutes.", "answer");
      return made;
    },

    /** VERIFIED: 20i.apib, MySQL Databases, GET /package/{id}/web/mysqlDatabases (line 13234). */
    async listDatabases(packageId) {
      return databases(packageId, true);
    },

    /**
      VERIFIED: 20i.apib, SSH Keys, GET and POST /package/{id}/web/sshkeys (line 12095): per package (there is no account-wide call);
      GET [{ handle, key }], POST { add: [{ key, handle }], delete: [] }. Read first, so a key the package has isn't sent again.
      How long 20i takes to accept a new key isn't in the reference (20i's docs: up to 30 minutes for keys added in My20i).
    */
    async addSshKey(packageId, publicKey) {
      const body = sshKeyBody(publicKey);
      const keys = list<Record<string, unknown>>(await call("GET", pkgPath(packageId, "/web/sshkeys")));
      if (keys.some((k) => typeof k.key === "string" && sshKeyBody(k.key) === body)) return "present";
      const handle = `tawd-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
      await call("POST", pkgPath(packageId, "/web/sshkeys"), { add: [{ key: publicKey.trim(), handle }], delete: [] });
      return "added";
    },

    /** VERIFIED: 20i.apib, PHP Version, POST /package/{id}/web/phpVersion { value } (line 13641), value like "php82". */
    async setPhpVersion(packageId, version) {
      await call("POST", pkgPath(packageId, "/web/phpVersion"), { value: phpValueFor(version) });
    },

    /**
      VERIFIED: 20i.apib, CDN Purge Cache, POST /package/{id}/web/purgeCdnByUrl (line 10869): no "path" purges everything cached for the
      site. (StackCache, line 13994, only sets cache lifetimes; it has no purge.)
    */
    async purgeCache(packageId) {
      await call("POST", pkgPath(packageId, "/web/purgeCdnByUrl"), {});
    },

    /**
      VERIFIED: 20i.apib, SSL Install, POST /package/{id}/web/externalSSL { name, certificate, key, ca } (line 9364): one name per call, so
      once for each name. A renewal installs again; then any older external certificate for those names is removed (SSL Certificates, GET
      and POST { delete: [id] }, line 9190), keeping TAWD's new one and 20i's own Let's Encrypt. That tidy-up is best effort.
    */
    async installCertificate(packageId, files) {
      for (const name of files.names) {
        await call("POST", pkgPath(packageId, "/web/externalSSL"), { name, certificate: files.certificate, key: files.privateKey, ca: files.caBundle });
      }
      try {
        const ours = pemBody(files.certificate);
        const installed = list<Record<string, unknown>>(await call("GET", pkgPath(packageId, "/web/certificates")));
        const mine = (c: Record<string, unknown>) => Boolean(ours) && String(c.certificatePem ?? "").replace(/\s+/g, "").includes(ours);
        const old = installed.filter(
          (c) => (typeof c.id === "string" || typeof c.id === "number") && files.names.includes(String(c.commonName ?? "").toLowerCase()) && c.provider !== "letsencrypt/standard" && !mine(c),
        );
        if (installed.some(mine) && old.length) await call("POST", pkgPath(packageId, "/web/certificates"), { delete: old.map((c) => String(c.id)) });
      } catch {
        // A leftover old certificate only expires; the new one is installed.
      }
    },

    /**
      VERIFIED: 20i.apib, Order SSL Certificates, POST /reseller/*\/addTlsCertificate (line 763): { "class-code", name, periodMonths,
      configuration } → the certificate's service id (a string). It charges VML's balance at once. The answer has no price or renewal
      date, and what "configuration" takes is "contact your account manager" (day-one check). NOT IN THE API: cancelling one (TAWD says
      to do it in My20i), and its price (PAID_CERT_PRICE, from 20i's sales).
    */
    async orderCertificate(input) {
      const answer = await call<unknown>("POST", "/reseller/*/addTlsCertificate", { "class-code": PAID_CERT_CLASS, name: input.domain, periodMonths: input.periodMonths, configuration: {} });
      const raw = answer && typeof answer === "object" ? ((answer as { result?: unknown }).result ?? (answer as { id?: unknown }).id) : answer;
      return { id: idFrom(raw, "certificate id"), price: null, renewsAt: null };
    },
  };
}
