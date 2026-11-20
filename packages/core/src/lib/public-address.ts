import dns from "node:dns";
import net from "node:net";

/*
  Which addresses TAWD never opens when it fetches a page for a project
  (the worker's site reads and liked sites, the web app's SEO check):
  loopback, private, link-local, carrier-grade NAT, multicast and reserved
  ranges, IPv4 and IPv6, including IPv4 written inside IPv6 in either form
  ("::ffff:127.0.0.1" or "::ffff:7f00:1", which is how Node writes it).
*/
export function isPrivateAddress(ip: string): boolean {
  if (isOwnServer(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    const inner = (high: number, low: number) => isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    const top = (n: number) => g.slice(0, n).every((x) => x === 0);
    // ::, ::1
    if (top(7)) return true;
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d) and the old IPv4-compatible (::a.b.c.d)
    if ((top(5) && g[5] === 0xffff) || (top(4) && g[4] === 0xffff && g[5] === 0) || top(6)) return inner(g[6]!, g[7]!);
    // NAT64: 64:ff9b::/96 carries an IPv4 address; 64:ff9b:1::/48 is local-use
    if (g[0] === 0x64 && g[1] === 0xff9b) {
      if (g.slice(2, 6).every((x) => x === 0)) return inner(g[6]!, g[7]!);
      if (g[2] === 1) return true;
    }
    // 6to4 (2002::/16) carries its IPv4 address in the next 32 bits
    if (g[0] === 0x2002) return inner(g[1]!, g[2]!);
    // Teredo (2001::/32): refused to be safe
    if (g[0] === 0x2001 && g[1] === 0) return true;
    return (
      (g[0]! & 0xfe00) === 0xfc00 || // fc00::/7, unique local
      (g[0]! & 0xffc0) === 0xfe80 || // fe80::/10, link-local
      (g[0]! & 0xffc0) === 0xfec0 || // fec0::/10, deprecated site-local
      (g[0]! & 0xff00) === 0xff00 // ff00::/8, multicast
    );
  }
  return true;
}

/* An IPv6 address as its eight 16-bit groups (:: expanded, an IPv4 tail turned into two groups, a zone id dropped); null when it can't be read. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0]!;
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = [tail[2], tail[3], tail[4], tail[5]].map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = read(halves[0]!);
  const rest = halves.length === 2 ? read(halves[1]!) : [];
  const groups = halves.length === 2 ? [...head, ...Array<number>(Math.max(0, 8 - head.length - rest.length)).fill(0), ...rest] : head;
  return groups.length === 8 && groups.every((x) => Number.isInteger(x)) ? groups : null;
}

/*
  VML's own servers are public addresses, but not public to TAWD (Fable's
  review of #81): from inside TAWD's containers a connection to the
  droplet's own address never crosses its DigitalOcean firewall, so a client
  page redirecting there would reach ports the internet can't (Coolify's
  proxy listens on 8080), and the Coolify server's firewall lets TAWD's
  droplet in on 8000 on purpose. So TAWD's droplet (IPv4 and IPv6) and the
  Coolify server are refused like private ranges, in any IPv6 spelling
  (mapped forms reach them through the IPv4 check below). TAWD_OWN_ADDRESSES
  (comma-separated) adds to the list, so a new address can be refused
  before a release, and an empty or mistyped setting can't switch the list
  off (an entry that isn't an address is logged and skipped). When a
  server's address changes, the built-in list follows it like the other
  lists in CLAUDE.md (Infrastructure).
*/
const OWN_SERVERS_DEFAULT = ["203.0.113.10", "2001:db8::10", "203.0.113.20"];
function canonicalIp(ip: string): string {
  const trimmed = ip.trim();
  if (!net.isIPv6(trimmed)) return trimmed;
  try {
    return new URL(`http://[${trimmed}]/`).hostname.slice(1, -1);
  } catch {
    return trimmed.toLowerCase();
  }
}
const extraOwn = (process.env.TAWD_OWN_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (const bad of extraOwn.filter((s) => net.isIP(s) === 0)) console.warn(`[public-address] TAWD_OWN_ADDRESSES: "${bad}" is not an IP address; skipped`);
const ownServers = new Set([...OWN_SERVERS_DEFAULT, ...extraOwn.filter((s) => net.isIP(s) !== 0)].map(canonicalIp));
function isOwnServer(ip: string): boolean {
  return ownServers.has(canonicalIp(ip));
}

/*
  A DNS lookup for node:http and node:https that refuses private addresses
  at the moment of connecting (13 October 2026, CodeRabbit on the review's
  fourth batch). Checking a host first and letting fetch look it up again
  leaves a gap: a host can answer a public address to the check and a
  private one to the connection. With this lookup the connection uses
  exactly the addresses that were checked.
*/
export const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const list = addresses as unknown as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const refused: NodeJS.ErrnoException = new Error(`${hostname} points at a private network, so it isn't opened.`);
      refused.code = "EPRIVATE";
      return callback(refused, "", 4);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};
