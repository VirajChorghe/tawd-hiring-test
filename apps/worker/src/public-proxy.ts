import { promises as dns } from "node:dns";
import http from "node:http";
import net from "node:net";

import { isPrivateAddress } from "@tawd/core/public-address";

/*
  C1 (audit F-004, 12 November 2026): no request from the worker's browser
  reaches a private address, by any route.

  The guard used to be a Playwright route handler (routePublicOnly) that
  checked each request's host name in Node and then let Chromium make the
  request itself. Two holes, both executed by the audit's probe p2:
  - Chromium follows a redirect on its own, and route handlers never see
    the hop. A public page answering 302 to a private address was followed,
    and its body (the stand-in "INTERNAL METADATA") was read and stored.
  - The name was resolved twice: once by Node for the check, once by
    Chromium for the connection. A name that answers public then private
    (DNS rebinding) passes the check and connects privately.

  So every context that opens a client's real website now goes through this
  proxy (locked-context.ts, publicSiteContext). The proxy resolves the name
  itself, refuses if any of its addresses is private, and connects to the
  exact address it checked. A redirect is just another request through it.
  HTTPS goes through as a CONNECT tunnel, to the checked address; the TLS
  stays end to end between Chromium and the site. Only the usual web ports.

  The route handlers stay as a second wall. The proxy listens on 127.0.0.1
  inside the worker's own container only.
*/

const WEB_PORTS = new Set([80, 443, 8080, 8443]);

type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);
let lookup: Lookup = systemLookup;
/* Where a checked address is actually dialled. Identity in production. */
let dial: (address: string) => string = (address) => address;
let anyPort = false;
/* A connection to a site that sends and receives nothing for this long is closed (CodeRabbit #81): a stalled site can't hold sockets for ever. */
const IDLE_MS = 30_000;
let idleMs = IDLE_MS;

/** Only for tests: how names resolve, where a checked (public) address is dialled, whether a test server's random port may be used, and the idle limit. */
export function setProxyNetworkForTesting(next: { lookup?: Lookup; dial?: (address: string) => string; anyPort?: boolean; idleMs?: number } | null): void {
  lookup = next?.lookup ?? systemLookup;
  dial = next?.dial ?? ((address) => address);
  anyPort = next?.anyPort ?? false;
  idleMs = next?.idleMs ?? IDLE_MS;
}

/* The one public address a host may be reached at, or null when it must be refused. */
export async function checkedAddress(host: string, port: number): Promise<string | null> {
  if (!anyPort && !WEB_PORTS.has(port)) return null;
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!name || name === "localhost" || /\.(?:localhost|internal|local)$/.test(name)) return null;
  const addresses = net.isIP(name) ? [name] : await lookup(name).catch(() => [] as string[]);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return null;
  return addresses[0]!;
}

/* "example.com:443" or "[2606:4700::1]:443" -> host and port. */
function splitHostPort(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  return m ? { host: m[1]!, port: Number(m[2]) } : null;
}

const HOP_HEADERS = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"];

/* The headers that belong to one hop only: the fixed set, and every header the message's Connection header names (RFC 9110, 7.6.1). */
function withoutHopHeaders<T extends http.OutgoingHttpHeaders>(headers: T): T {
  const out: http.OutgoingHttpHeaders = { ...headers };
  const connection = out.connection;
  const named = (Array.isArray(connection) ? connection.join(",") : String(connection ?? "")).split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...named]) if (name) delete out[name];
  return out as T;
}

function createProxy(): http.Server {
  const server = http.createServer(async (req, res) => {
    // A plain-HTTP request through a proxy carries the whole address.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const address = await checkedAddress(url.hostname, port);
    if (!address) {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Refused: not a public web address.");
      return;
    }
    const headers = withoutHopHeaders({ ...req.headers, host: url.host });
    const upstream = http.request({ host: dial(address), port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: idleMs }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, withoutHopHeaders(answer.headers));
      answer.pipe(res);
      // The site hung up part-way: the browser's copy ends as an error, not as a short page that looks complete.
      answer.on("close", () => {
        if (!answer.complete) res.destroy();
      });
    });
    // A socket timeout only reports; it takes destroy() to hang up.
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => res.destroy());
    // The browser went away (page closed, request abandoned): hang up on the site too.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on("close", () => {
      if (!req.complete) upstream.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS (and WebSockets): a tunnel to the checked address only.
  server.on("connect", async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => undefined);
    const target = splitHostPort(req.url ?? "");
    const address = target ? await checkedAddress(target.host, target.port) : null;
    if (!target || !address) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(target.port, dial(address), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    // Quiet in both directions for the idle limit: close both ends.
    const hangUp = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.setTimeout(idleMs, hangUp);
    socket.setTimeout(idleMs, hangUp);
  });
  return server;
}

let started: Promise<string> | null = null;

/* The proxy's address ("http://127.0.0.1:PORT"), started once per process. */
export function publicProxy(): Promise<string> {
  started ??= new Promise((resolve, reject) => {
    const server = createProxy();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    });
  });
  return started;
}
