import { DNS_TYPES, dohValues, type DomainSnapshot } from "./connect";
import { dnssecFromDoh, normalizeDomain } from "./golive";

/*
  F3: what public DNS says about a domain, asked of two independent
  resolvers over HTTPS (Cloudflare's 1.1.1.1 and Google's 8.8.8.8), so a
  stale answer in one cache doesn't fool the check. Free, read-only; the
  web app and the worker both use it.
*/

export const RESOLVERS = [
  { id: "cloudflare", url: "https://cloudflare-dns.com/dns-query" },
  { id: "google", url: "https://dns.google/resolve" },
] as const;

/** Fetches a DNS-over-HTTPS JSON answer; null when the resolver didn't answer. */
export type DohGet = (url: string) => Promise<unknown | null>;

export const fetchDoh: DohGet = async (url) => {
  try {
    const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

type Name = keyof typeof DNS_TYPES;

/* One resolver's view of the domain; null when it didn't answer the basic questions. */
export async function snapshotFrom(resolver: string, domain: string, get: DohGet): Promise<DomainSnapshot | null> {
  const d = normalizeDomain(domain);
  const ask = async (name: string, type: Name) => {
    const json = await get(`${resolver}?name=${encodeURIComponent(name)}&type=${type}`);
    return { json, values: json === null ? null : dohValues(json, DNS_TYPES[type]) };
  };
  const [ns, apexA, apexAAAA, apexCname, wwwCname, wwwA, wwwAAAA, mx, caa, ds] = await Promise.all([
    ask(d, "NS"),
    ask(d, "A"),
    ask(d, "AAAA"),
    ask(d, "CNAME"),
    ask(`www.${d}`, "CNAME"),
    ask(`www.${d}`, "A"),
    ask(`www.${d}`, "AAAA"),
    ask(d, "MX"),
    ask(d, "CAA"),
    ask(d, "DS"),
  ]);
  if (ns.values === null || apexA.values === null) return null;
  // A www that is a CNAME answers A and AAAA questions with the target's addresses: those aren't www's own.
  const wwwIsCname = (wwwCname.values ?? []).length > 0 || ((wwwA.json as { Answer?: { type?: number }[] } | null)?.Answer ?? []).some((a) => a.type === DNS_TYPES.CNAME);
  const wwwCnames = (wwwCname.values ?? []).length
    ? wwwCname.values!
    : ((wwwA.json as { Answer?: { type?: number; data?: string; name?: string }[] } | null)?.Answer ?? [])
        .filter((a) => a.type === DNS_TYPES.CNAME && (a.name ?? "").toLowerCase().replace(/\.$/, "") === `www.${d}`)
        .map((a) => (a.data ?? "").replace(/\.$/, ""));
  return {
    domain: d,
    nameservers: ns.values,
    apexA: apexA.values,
    apexAAAA: apexAAAA.values ?? [],
    apexCname: apexCname.values ?? [],
    wwwA: wwwIsCname ? [] : wwwA.values ?? [],
    wwwAAAA: wwwIsCname ? [] : wwwAAAA.values ?? [],
    wwwCname: wwwCnames,
    mx: mx.values ?? [],
    caa: caa.values ?? [],
    dnssec: ds.json === null ? null : dnssecFromDoh(ds.json),
  };
}

/* Both resolvers' views; at least one must answer. */
export async function snapshotDomain(domain: string, get: DohGet = fetchDoh): Promise<{ resolver: string; snapshot: DomainSnapshot }[]> {
  const views = await Promise.all(RESOLVERS.map(async (r) => ({ resolver: r.id, snapshot: await snapshotFrom(r.url, domain, get) })));
  return views.filter((v): v is { resolver: (typeof RESOLVERS)[number]["id"]; snapshot: DomainSnapshot } => v.snapshot !== null);
}
