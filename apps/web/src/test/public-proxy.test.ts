import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { publicProxy, setProxyNetworkForTesting } from "../../../worker/src/public-proxy";

/*
  CodeRabbit #81 on the public-only proxy (C1): headers a message names in
  Connection go with it, in both directions; and a stalled site never holds
  a socket open once the page has gone, or for longer than the idle limit.
  No Chrome: the proxy is driven directly, with local servers standing in
  for the public site ("public.test" is dialled at 127.0.0.1).
*/

const PUBLIC_IP = "93.184.216.34";
let proxy: URL;

beforeAll(async () => {
  proxy = new URL(await publicProxy());
});

afterEach(() => setProxyNetworkForTesting(null));

function useTestNetwork(idleMs?: number) {
  setProxyNetworkForTesting({ lookup: async () => [PUBLIC_IP], dial: () => "127.0.0.1", anyPort: true, idleMs });
}

function listen<T extends net.Server>(server: T): Promise<{ server: T; port: number }> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

function viaProxy(port: number, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port), method: "GET", path: `http://public.test:${port}/x`, headers }, resolve);
    req.on("error", reject);
    req.end();
  });
}

describe("headers named in Connection", () => {
  it("are removed from the request on its way to the site, with the usual hop-by-hop ones", async () => {
    useTestNetwork();
    let seen: http.IncomingHttpHeaders = {};
    const site = await listen(
      http.createServer((req, res) => {
        seen = req.headers;
        res.end("ok");
      }),
    );
    try {
      const answer = await viaProxy(site.port, { Connection: "keep-alive, X-Hop-Only", "X-Hop-Only": "secret", "X-Kept": "yes", TE: "trailers", "Proxy-Authorization": "Basic abc", Upgrade: "h2c" });
      answer.resume();
      expect(seen["x-kept"]).toBe("yes");
      expect(seen["x-hop-only"]).toBeUndefined();
      expect(seen.te).toBeUndefined();
      expect(seen["proxy-authorization"]).toBeUndefined();
      expect(seen.upgrade).toBeUndefined();
    } finally {
      site.server.close();
    }
  });

  it("are removed from the response on its way back to the browser", async () => {
    useTestNetwork();
    const site = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { Connection: "close, X-Resp-Hop", "X-Resp-Hop": "internal", "X-Resp-Kept": "yes", "Keep-Alive": "timeout=77", "Proxy-Authenticate": "Basic" });
        res.end("ok");
      }),
    );
    try {
      const answer = await viaProxy(site.port);
      answer.resume();
      expect(answer.headers["x-resp-kept"]).toBe("yes");
      expect(answer.headers["x-resp-hop"]).toBeUndefined();
      // (the proxy's own connection may carry a Keep-Alive of its own; the site's must not)
      expect(answer.headers["keep-alive"] ?? "").not.toContain("77");
      expect(answer.headers["proxy-authenticate"]).toBeUndefined();
    } finally {
      site.server.close();
    }
  });
});

describe("a site that never answers", () => {
  it("is hung up on when the browser's request goes away", async () => {
    useTestNetwork(60_000);
    const sockets: net.Socket[] = [];
    const site = await listen(http.createServer(() => undefined));
    site.server.on("connection", (s) => sockets.push(s));
    try {
      const req = http.request({ host: proxy.hostname, port: Number(proxy.port), path: `http://public.test:${site.port}/slow` });
      req.on("error", () => undefined);
      req.end();
      expect(await until(() => sockets.length === 1)).toBe(true);
      req.destroy();
      expect(await until(() => sockets[0]!.destroyed)).toBe(true);
    } finally {
      site.server.close();
    }
  });

  it("is hung up on after the idle limit, even if the browser waits", async () => {
    useTestNetwork(300);
    const sockets: net.Socket[] = [];
    const site = await listen(http.createServer(() => undefined));
    site.server.on("connection", (s) => sockets.push(s));
    try {
      const req = http.request({ host: proxy.hostname, port: Number(proxy.port), path: `http://public.test:${site.port}/slow` });
      req.on("error", () => undefined);
      req.end();
      expect(await until(() => sockets.length === 1)).toBe(true);
      expect(await until(() => sockets[0]!.destroyed, 3000)).toBe(true);
      req.destroy();
    } finally {
      site.server.close();
    }
  });

  it("an HTTPS tunnel that goes quiet is closed after the idle limit, both ends", async () => {
    useTestNetwork(300);
    const sockets: net.Socket[] = [];
    const site = await listen(net.createServer((s) => sockets.push(s)));
    try {
      const client = net.connect(Number(proxy.port), proxy.hostname);
      client.on("error", () => undefined);
      let reply = "";
      client.on("data", (d) => (reply += d.toString()));
      client.write(`CONNECT public.test:${site.port} HTTP/1.1\r\nHost: public.test:${site.port}\r\n\r\n`);
      expect(await until(() => reply.includes("200"))).toBe(true);
      expect(await until(() => sockets.length === 1)).toBe(true);
      expect(await until(() => sockets[0]!.destroyed, 3000)).toBe(true);
      expect(await until(() => client.destroyed, 3000)).toBe(true);
    } finally {
      site.server.close();
    }
  });
});
