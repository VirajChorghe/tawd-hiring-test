import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { routePublicOnly, setLookupForTesting } from "../../../worker/src/liked-sites";
import { publicSiteContext } from "../../../worker/src/locked-context";
import { checkedAddress, setProxyNetworkForTesting } from "../../../worker/src/public-proxy";

/*
  C1 (audit F-004): the worker's browser must not reach a private address by
  any route. The audit's probe p2, made a test: a public page that answers
  302 to a private address, and a public page whose pictures and scripts
  point at one. Real Chrome, local servers only.

  Both servers really run on this machine. The test tells the proxy (and the
  older Node-side check) that "public.test" is a public address and
  "private.test" a private one, and dials the public address here.
*/

const require = createRequire(import.meta.url);

/* TAWD_TEST_CHROME, else Chrome at its usual Windows path, else the Chromium Playwright installed. Never skipped (CodeRabbit #81): a security check that can silently not run is not a check. */
function findChrome(): string | null {
  const candidates = [process.env.TAWD_TEST_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe"];
  try {
    candidates.push(require("../../../worker/node_modules/playwright-core").chromium.executablePath());
  } catch {
    // Playwright's browser isn't installed here.
  }
  return candidates.find((path): path is string => Boolean(path) && fs.existsSync(path!)) ?? null;
}
const CHROME = findChrome();
const PUBLIC_IP = "93.184.216.34";

function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe("the worker's browser and private addresses", () => {
  const hits: string[] = [];
  let priv: { server: http.Server; port: number };
  let pub: { server: http.Server; port: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;

  beforeAll(async () => {
    if (!CHROME) {
      throw new Error("No Chrome found for the private-address redirect tests. Set TAWD_TEST_CHROME to a chrome executable, or run `npx playwright-core install chromium` in apps/worker. These tests are never skipped.");
    }
    priv = await serve((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>INTERNAL METADATA</h1><p>SYNTHETIC-SECRET-VALUE</p></body></html>");
    });
    pub = await serve((req, res) => {
      if (req.url === "/redirect-top") {
        res.writeHead(302, { Location: `http://private.test:${priv.port}/metadata` });
        return res.end();
      }
      if (req.url === "/redirect-loopback") {
        res.writeHead(302, { Location: `http://127.0.0.1:${priv.port}/loopback` });
        return res.end();
      }
      if (req.url === "/img-redirect") {
        res.writeHead(302, { Location: `http://private.test:${priv.port}/img` });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      if (req.url === "/page-with-subresources") {
        return res.end(
          `<html><body><h1>Public page</h1><img src="/img-redirect"><img src="http://private.test:${priv.port}/direct-img"><img src="http://127.0.0.1:${priv.port}/loopback-img"><script>fetch("http://private.test:${priv.port}/direct-fetch").catch(()=>{})</script></body></html>`,
        );
      }
      res.end("<html><body><h1>Public home</h1></body></html>");
    });
    const names = async (host: string) => (host === "public.test" ? [PUBLIC_IP] : host === "private.test" ? ["10.0.0.5"] : []);
    setLookupForTesting(names);
    // The public address is this machine's public test server; nothing else is ever dialled.
    setProxyNetworkForTesting({ lookup: names, dial: (address) => (address === PUBLIC_IP ? "127.0.0.1" : address), anyPort: true });
    const { chromium } = require("../../../worker/node_modules/playwright-core");
    // Chrome's own resolver sends both names here too, so without the proxy the redirect is really followed (the audit's probe p2): the tests must fail then.
    browser = await chromium.launch({ executablePath: CHROME, args: ["--host-resolver-rules=MAP public.test 127.0.0.1, MAP private.test 127.0.0.1"] });
  }, 60_000);

  afterAll(async () => {
    setLookupForTesting(null);
    setProxyNetworkForTesting(null);
    await browser?.close();
    priv?.server.close();
    pub?.server.close();
  });

  const open = async (path: string) => {
    hits.length = 0;
    const context = await publicSiteContext(browser, { viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await routePublicOnly(page);
      await page.goto(`http://public.test:${pub.port}${path}`, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      return { body, url: page.url() };
    } finally {
      await context.close();
    }
  };

  it("opens an ordinary public page", async () => {
    const { body } = await open("/");
    expect(body).toContain("Public home");
  }, 30_000);

  it("does not follow a redirect to a private address", async () => {
    const { body } = await open("/redirect-top");
    expect(body).not.toContain("SYNTHETIC-SECRET-VALUE");
    expect(hits).toEqual([]);
  }, 30_000);

  it("does not follow a redirect to 127.0.0.1 (Chromium would skip the proxy for it by default)", async () => {
    const { body } = await open("/redirect-loopback");
    expect(body).not.toContain("SYNTHETIC-SECRET-VALUE");
    expect(hits).toEqual([]);
  }, 30_000);

  it("lets no picture, redirecting picture or script reach a private address", async () => {
    const { body } = await open("/page-with-subresources");
    expect(body).toContain("Public page");
    expect(hits).toEqual([]);
  }, 30_000);

  it("the proxy's own check: private, loopback, odd ports and local names are refused", async () => {
    expect(await checkedAddress("public.test", 443)).toBe(PUBLIC_IP);
    expect(await checkedAddress("private.test", 80)).toBeNull();
    expect(await checkedAddress("169.254.169.254", 80)).toBeNull();
    expect(await checkedAddress("[::1]", 443)).toBeNull();
    expect(await checkedAddress("[::ffff:7f00:1]", 443)).toBeNull();
    expect(await checkedAddress("foo.localhost", 80)).toBeNull();
    // Only the usual web ports, outside tests.
    setProxyNetworkForTesting({ lookup: async () => [PUBLIC_IP] });
    expect(await checkedAddress("public.test", 6379)).toBeNull();
    expect(await checkedAddress("public.test", 443)).toBe(PUBLIC_IP);
  });
});
