import { connect as tlsConnect } from "node:tls";

import { fetchDoh, snapshotDomain, type DohGet } from "@tawd/core/site";

/*
  HTTPS for WordPress sites on 20i (5 October 2026; plan 3.4). 20i's free
  certificate needs 20i's nameservers, which clients keep, so a site's
  certificate comes one of three ways, chosen by an admin on System
  (wp_cert_path): TAWD's own Let's Encrypt certificate installed at 20i by
  API, 20i's paid certificate ordered by API (an admin confirms each), or
  one Jason installs by hand in My20i. Every way ends the same: the job
  hands the certificate over and returns (20i can take up to 30 minutes to
  serve a new one), and Check HTTPS (probeTls) confirms it later. Nothing
  waits inside a job.

  Let's Encrypt (HTTP-01): acme-client 5.4.0, pure JavaScript (no native
  modules, no install scripts). The challenge files are written into the
  site's web root over SFTP by the caller. The certificate's private key
  lives only in this process while it's handed to 20i: TAWD never stores
  it. TAWD's ACME account key is kept encrypted (app_setting acme_account).
*/

export interface IssueInput {
  /** The names on the certificate (the domain and www, or the preview's name). */
  names: string[];
  /** Let's Encrypt's staging directory (TWENTYI_ACME_STAGING=on): its certificates aren't trusted by browsers. */
  staging: boolean;
  /** TAWD's ACME account key (PEM), or null to make one. */
  accountKeyPem: string | null;
  setChallenge(token: string, content: string): Promise<void>;
  clearChallenge(token: string): Promise<void>;
}

export interface IssuedCertificate {
  certificate: string;
  caBundle: string;
  privateKey: string;
  /** The account key used (a new one is saved, encrypted, by the caller). */
  accountKeyPem: string;
  issuer: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface AcmeIssuer {
  issue(input: IssueInput): Promise<IssuedCertificate>;
  /** A new ACME account key (PEM), made once and saved before the first certificate is asked for. */
  createAccountKey(): Promise<string>;
}

/* Let's Encrypt through acme-client, loaded only when a certificate is really issued. */
const letsEncrypt: AcmeIssuer = {
  async createAccountKey() {
    const mod = await import("acme-client");
    const acme = (mod as unknown as { default?: typeof mod }).default ?? mod;
    return (await acme.crypto.createPrivateKey()).toString();
  },
  async issue(input) {
    const mod = await import("acme-client");
    const acme = (mod as unknown as { default?: typeof mod }).default ?? mod;
    const accountKey = input.accountKeyPem ?? (await acme.crypto.createPrivateKey()).toString();
    const client = new acme.Client({ directoryUrl: input.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: input.names[0]!, altNames: input.names });
    const chain = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ["http-01"],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type !== "http-01") throw new Error("Only the HTTP check (a file on the site) is used.");
        await input.setChallenge(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        await input.clearChallenge(challenge.token);
      },
    });
    const [leaf, ...rest] = acme.crypto.splitPemChain(chain);
    if (!leaf) throw new Error("Let's Encrypt's answer had no certificate.");
    const info = acme.crypto.readCertificateInfo(leaf);
    return {
      certificate: leaf,
      caBundle: rest.join("\n"),
      privateKey: key.toString(),
      accountKeyPem: accountKey,
      issuer: info.issuer.commonName ?? "Let's Encrypt",
      issuedAt: info.notBefore,
      expiresAt: info.notAfter,
    };
  },
};

let issuerOverride: AcmeIssuer | null = null;

/** Tests issue stand-in certificates (they still write and remove the challenge files). */
export function setAcmeForTesting(issuer: AcmeIssuer | null): void {
  issuerOverride = issuer;
}

export const getAcme = (): AcmeIssuer => issuerOverride ?? letsEncrypt;

/* Let's Encrypt's refusals, in plain words (https://letsencrypt.org/docs/rate-limits/). */
export function explainAcme(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/caa/i.test(message)) return "The domain's CAA record doesn't allow Let's Encrypt. Add 0 issue \"letsencrypt.org\" at its DNS provider (Connect the domain lists it), then try again.";
  if (/too many failed authorizations|failed validations/i.test(message)) return "Let's Encrypt saw 5 failed checks for this name in the last hour. Wait an hour, check the records point at the site, then try again.";
  if (/too many certificates|rate ?limit/i.test(message)) return "Let's Encrypt's weekly limit for this domain is reached. Try again in a few days, or use another HTTPS way (System).";
  // "Request failed with status code 401": acme-client's own look at the check file before it asks Let's Encrypt (the new name not served yet).
  if (/connection|timeout|unauthorized|invalid response|status code 40\d|404/i.test(message)) return `Let's Encrypt couldn't read the check file on the site (${message.slice(0, 160)}). The records may not point at the site yet, or an old AAAA record sends it elsewhere.`;
  return `Let's Encrypt didn't issue it: ${message.slice(0, 240)}`;
}

/* ---------- Check HTTPS ---------- */

export interface TlsProbe {
  /** The site answered over HTTPS with a certificate the browser trusts for this name. */
  ok: boolean;
  issuer: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  /** Why not, in TLS's words. */
  reason: string | null;
}

type Probe = (host: string) => Promise<TlsProbe>;
let probeOverride: Probe | null = null;

/** Tests answer Check HTTPS themselves. */
export function setTlsProbeForTesting(probe: Probe | null): void {
  probeOverride = probe;
}

/* Opens host:443 the way a browser does (the name checked, the chain trusted) and reads the certificate. */
export function probeTls(host: string): Promise<TlsProbe> {
  if (probeOverride) return probeOverride(host);
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: true, timeout: 10_000 });
    const finish = (probe: TlsProbe) => {
      socket.destroy();
      resolve(probe);
    };
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const issuer = (cert.issuer as { O?: string; CN?: string } | undefined) ?? {};
      finish({ ok: true, issuer: issuer.O ?? issuer.CN ?? null, validFrom: cert.valid_from ? new Date(cert.valid_from) : null, validTo: cert.valid_to ? new Date(cert.valid_to) : null, reason: null });
    });
    socket.once("timeout", () => finish({ ok: false, issuer: null, validFrom: null, validTo: null, reason: "It didn't answer within 10 seconds." }));
    socket.once("error", (error: Error) => finish({ ok: false, issuer: null, validFrom: null, validTo: null, reason: error.message.slice(0, 200) }));
  });
}

/* ---------- Do the records point at the package? ---------- */

let dohOverride: DohGet | null = null;

/** Tests answer the DNS questions themselves. */
export function setCertDnsForTesting(get: DohGet | null): void {
  dohOverride = get;
}

/**
 * Whether the bare domain and www reach the package's IPv4 on both public resolvers (www by A, or by a CNAME to the domain),
 * and no AAAA sends visitors (or Let's Encrypt, which tries IPv6 first) elsewhere. Null when it's right; otherwise why not.
 */
export async function recordsPointAt(domain: string, ipv4: string): Promise<string | null> {
  const views = await snapshotDomain(domain, dohOverride ?? fetchDoh);
  if (views.length === 0) return `Public DNS didn't answer about ${domain}. Try again in a minute.`;
  for (const { snapshot } of views) {
    if (snapshot.apexA.length !== 1 || snapshot.apexA[0] !== ipv4) return `${domain} doesn't point at the site yet (it shows ${snapshot.apexA.join(", ") || "no address"}, the site is ${ipv4}).`;
    if (snapshot.apexAAAA.length) return `${domain} still has an IPv6 (AAAA) record for the old site: it has to go first (Connect the domain lists it).`;
    const wwwOk = snapshot.wwwCname.some((c) => c.toLowerCase().replace(/\.$/, "") === domain) || (snapshot.wwwA.length === 1 && snapshot.wwwA[0] === ipv4);
    if (!wwwOk) return `www.${domain} doesn't point at the site yet.`;
    if (snapshot.wwwAAAA.length) return `www.${domain} still has an IPv6 (AAAA) record for the old site.`;
  }
  return null;
}
