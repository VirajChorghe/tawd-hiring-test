/*
  A small Cloudflare DNS client for the worker (Build B on 20i, 5 October
  2026): the WordPress previews' A records under WP_PREVIEW_DOMAIN, and the
  IP watch's fix when VML runs a client's DNS. It finds the zone a name
  sits in and sets, reads or removes that name's A record (never proxied,
  so visitors and certificates reach 20i directly).

  CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the client-zones account,
  which can never touch velocitymedialab.com) are read on the web and the
  worker; sent to Cloudflare only, never logged or shown to an AI. The web
  app's go-live flow keeps its own client (apps/web/src/lib/golive.ts).
*/

export class CloudflareDnsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareDnsError";
  }
}

export interface CloudflareDns {
  /** The zone a host name sits in (the longest zone on the account that it ends with); null when none. */
  zoneFor(host: string): Promise<{ id: string; name: string } | null>;
  /** The A records at a name. */
  aRecords(zoneId: string, name: string): Promise<{ id: string; content: string }[]>;
  /** Makes the name's only A record point at the IP (DNS only). */
  setA(zoneId: string, name: string, ip: string): Promise<void>;
  /** Removes the name's A records. */
  removeA(zoneId: string, name: string): Promise<void>;
}

type Fetch = typeof fetch;
let fetchOverride: Fetch | null = null;
let dnsOverride: CloudflareDns | null = null;

/** Tests answer Cloudflare's HTTP calls themselves. */
export function setCloudflareDnsFetchForTesting(stand: Fetch | null): void {
  fetchOverride = stand;
}

/** Tests replace the whole client. */
export function setCloudflareDnsForTesting(stand: CloudflareDns | null): void {
  dnsOverride = stand;
}

export function cloudflareDnsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CLOUDFLARE_API_TOKEN?.trim() && env.CLOUDFLARE_ACCOUNT_ID?.trim());
}

export function getCloudflareDns(): CloudflareDns {
  return dnsOverride ?? httpCloudflareDns(process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "", process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "");
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function httpCloudflareDns(token: string, accountId: string): CloudflareDns {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!token || !accountId) throw new CloudflareDnsError("Cloudflare isn't set up on this service: an admin adds CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Coolify (tawd-web-new and tawd-worker-new), then redeploys.");
    let response: Response;
    try {
      response = await (fetchOverride ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new CloudflareDnsError(`TAWD couldn't reach Cloudflare (${error instanceof Error ? error.message : "no answer"}).`);
    }
    const json = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (response.status === 401 || response.status === 403) throw new CloudflareDnsError("Cloudflare refused the token. Check CLOUDFLARE_API_TOKEN (it needs Zone Read and DNS Edit on the client-zones account).");
    if (!response.ok || json.success === false) throw new CloudflareDnsError(`Cloudflare answered ${response.status}: ${json.errors?.map((e) => e.message).join("; ") || "no reason given"}.`);
    return json.result as T;
  }

  const records = async (zoneId: string, name: string) =>
    (await call<{ id: string; type: string; name: string; content: string }[]>("GET", `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`)).filter((r) => r.type === "A").map((r) => ({ id: r.id, content: r.content }));

  return {
    async zoneFor(host) {
      const labels = host.toLowerCase().replace(/\.$/, "").split(".");
      for (let i = 0; i < labels.length - 1; i += 1) {
        const candidate = labels.slice(i).join(".");
        const zones = await call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(candidate)}&account.id=${encodeURIComponent(accountId)}`);
        if (zones[0]) return { id: zones[0].id, name: zones[0].name };
      }
      return null;
    },
    aRecords: records,
    async setA(zoneId, name, ip) {
      if (!IPV4.test(ip)) throw new CloudflareDnsError(`Not an IPv4 address: ${ip}`);
      const existing = await records(zoneId, name);
      const keep = existing.find((r) => r.content === ip);
      // The new record first, then the old ones: a refused POST never leaves the name with no A record (13 October 2026, the whole-code review).
      if (!keep) await call("POST", `/zones/${zoneId}/dns_records`, { type: "A", name, content: ip, ttl: 300, proxied: false });
      for (const r of existing) if (r !== keep) await call("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
    },
    async removeA(zoneId, name) {
      for (const r of await records(zoneId, name)) await call("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
    },
  };
}

/* An in-memory Cloudflare for tests: zones by name, A records by name. */
export class FakeCloudflareDns implements CloudflareDns {
  zones = new Map<string, Map<string, string>>();
  calls: string[] = [];
  constructor(zoneNames: string[] = []) {
    for (const z of zoneNames) this.zones.set(z, new Map());
  }
  async zoneFor(host: string) {
    const h = host.toLowerCase();
    const zone = [...this.zones.keys()].filter((z) => h === z || h.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0];
    return zone ? { id: zone, name: zone } : null;
  }
  async aRecords(zoneId: string, name: string) {
    const ip = this.zones.get(zoneId)?.get(name);
    return ip ? [{ id: `${name}-a`, content: ip }] : [];
  }
  async setA(zoneId: string, name: string, ip: string) {
    this.calls.push(`setA ${name} ${ip}`);
    this.zones.get(zoneId)?.set(name, ip);
  }
  async removeA(zoneId: string, name: string) {
    this.calls.push(`removeA ${name}`);
    this.zones.get(zoneId)?.delete(name);
  }
}
