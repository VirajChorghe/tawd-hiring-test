import { afterEach, describe, expect, it } from "vitest";

import { httpCloudflareDns, setCloudflareDnsFetchForTesting } from "@tawd/core/cloudflare-dns";
import { MAX_FIGMA_IMAGE_BYTES, figmaApi } from "@tawd/core/figma";

/*
  The whole-code review's Lows (13 October 2026) that have no test file of
  their own. No network: every outside call is answered here.
*/

afterEach(() => {
  setCloudflareDnsFetchForTesting(null);
});

describe("a VML-run domain's A record", () => {
  it("adds the new record before removing the old one, so a refused add leaves the old one in place", async () => {
    const calls: string[] = [];
    let refuseAdd = false;
    setCloudflareDnsFetchForTesting((async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      calls.push(`${init?.method} ${path.split("?")[0]}`);
      if (init?.method === "GET") return Response.json({ success: true, result: [{ id: "old", type: "A", name: "harborpest.com", content: "1.1.1.1" }] });
      if (init?.method === "POST" && refuseAdd) return Response.json({ success: false, errors: [{ message: "refused" }] }, { status: 400 });
      return Response.json({ success: true, result: {} });
    }) as typeof fetch);
    const dns = httpCloudflareDns("token", "account");

    await dns.setA("zone", "harborpest.com", "2.2.2.2");
    expect(calls).toEqual(["GET /zones/zone/dns_records", "POST /zones/zone/dns_records", "DELETE /zones/zone/dns_records/old"]);

    calls.length = 0;
    refuseAdd = true;
    await expect(dns.setA("zone", "harborpest.com", "3.3.3.3")).rejects.toThrow("refused");
    expect(calls).toEqual(["GET /zones/zone/dns_records", "POST /zones/zone/dns_records"]);
  });
});

describe("an image downloaded from Figma", () => {
  it("is refused over the size limit, by its declared size or as it arrives", async () => {
    const realFetch = globalThis.fetch;
    let declared = true;
    globalThis.fetch = (async () => {
      const big = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(10_000_000));
          controller.close();
        },
      });
      return new Response(big, { headers: declared ? { "content-length": String(MAX_FIGMA_IMAGE_BYTES + 1) } : {} });
    }) as typeof fetch;
    try {
      await expect(figmaApi.download("https://figma-images.example/huge")).rejects.toThrow("over 50 MB");
      declared = false;
      await expect(figmaApi.download("https://figma-images.example/huge")).rejects.toThrow("over 50 MB");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the booking and review link check in the worker", () => {
  it("connects only to the address that was checked: a name pointing at a private address is refused at the connection", async () => {
    const { pinnedStatusFetch } = await import("../../../worker/src/liked-sites");
    const http = await import("node:http");
    let served = 0;
    const server = http.createServer((_req, res) => {
      served += 1;
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await expect(pinnedStatusFetch(`http://localhost:${port}/book`, { method: "HEAD" })).rejects.toThrow("private network");
      expect(served).toBe(0);
    } finally {
      server.close();
    }
  });
});
