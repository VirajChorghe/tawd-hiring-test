import { afterEach, describe, expect, it } from "vitest";

import { FakeCloudflareDns, httpCloudflareDns, setCloudflareDnsFetchForTesting } from "@tawd/core/cloudflare-dns";

import { getTwentyi, httpTwentyi, phpValueFor, setTwentyiFetchForTesting, setTwentyiForTesting, sshAccessFor, stagingHostFor, TwentyiError } from "./twentyi";
import { FakeTwentyi } from "./twentyi-fake";

/*
  Build B on 20i (5 October 2026): the 20i client's requests (address,
  method, auth header, payload) and how it reads 20i's answers and errors,
  against the shapes in 20i's API reference (20i.apib, 6 October 2026); the fake reseller the job tests use; and the
  worker's Cloudflare DNS client. Nothing here reaches 20i or Cloudflare.
*/

const KEY = "test-general-key-123";

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function stand(answers: Record<string, { status?: number; body: unknown }>, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    seen.push({ url, method, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.replace("https://api.20i.com", "")}`;
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: "no stand-in" }), { status: 500 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => {
  setTwentyiFetchForTesting(null);
  setTwentyiForTesting(null);
  setCloudflareDnsFetchForTesting(null);
  delete process.env.TWENTYI_API_KEY;
});

describe("the 20i client", () => {
  // 8 October 2026: the first real package was refused with "20i said no (400)" and nothing else.
  it("shows 20i's whole refusal when it has none of the usual fields, and sends the package type as text", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(stand({ "POST /reseller/*/addWeb": { status: 400, body: { exception: "InvalidRequest", errors: { domain_name: "not allowed" } } } }, seen));
    await expect(httpTwentyi(KEY).createPackage({ typeId: 12345 as unknown as string, domain: "a-b.tawdpreviews.com", label: "TAWD A B" })).rejects.toThrow(
      '20i said no (400): {"exception":"InvalidRequest","errors":{"domain_name":"not allowed"}}',
    );
    expect(seen[0]!.body).toMatchObject({ type: "12345", domain_name: "a-b.tawdpreviews.com", documentRoots: { "a-b.tawdpreviews.com": "public_html" } });
  });

  it("sends the General API key as Bearer + base64 to api.20i.com (VERIFIED auth)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(stand({ "GET /package": { body: [{ id: 7, name: "Nora-Beagle-Site.vmlpreview.com", names: ["nora-beagle-site.vmlpreview.com"], typeRef: "tawd-wp", enabled: true }] } }, seen));
    const packages = await httpTwentyi(KEY).listPackages();
    expect(seen[0]!.url).toBe("https://api.20i.com/package");
    expect(seen[0]!.auth).toBe(`Bearer ${Buffer.from(KEY).toString("base64")}`);
    expect(packages).toEqual([{ id: "7", name: "nora-beagle-site.vmlpreview.com", names: ["nora-beagle-site.vmlpreview.com"], typeRef: "tawd-wp", enabled: true }]);
  });

  it("reads a package from GET /package/{id}/web: IPv4, IPv6, the staging address, setupComplete (VERIFIED: 20i.apib, Package)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(
      stand(
        {
          "GET /package/7/web": {
            body: {
              id: "7",
              name: "a.vmlpreview.com",
              names: ["a.vmlpreview.com"],
              typeRef: "tawd-wp",
              setupComplete: true,
              info: { ip4Address: "185.151.30.12", ip6Address: "2a07:7800::12", temporaryUrls: { "a.vmlpreview.com": "https://a-vmlpreview-com.stackstaging.com" } },
            },
          },
          "GET /package/8/web": { body: { id: "8", name: "b.vmlpreview.com", setupComplete: false, info: { ip4Address: "1.2.3.4; rm -rf /", temporaryUrls: { "b.vmlpreview.com": "not a host!" } } } },
          "GET /package/9/web": { status: 404, body: { error: "not found" } },
        },
        seen,
      ),
    );
    const api = httpTwentyi(KEY);
    expect(await api.getPackage("7")).toEqual({ id: "7", name: "a.vmlpreview.com", names: ["a.vmlpreview.com"], typeRef: "tawd-wp", ipv4: "185.151.30.12", ipv6: "2a07:7800::12", stagingHost: "a-vmlpreview-com.stackstaging.com", setupComplete: true });
    expect(await api.getPackage("8")).toMatchObject({ ipv4: null, stagingHost: null, setupComplete: false });
    // 20i's SDK reads a 404 as "nothing there".
    expect(await api.getPackage("9")).toBeNull();
  });

  it("makes a package with addWeb, the web root in documentRoots, and reads the bare id (VERIFIED: 20i.apib, Package Add)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(stand({ "POST /reseller/*/addWeb": { body: 4242 } }, seen));
    const id = await httpTwentyi(KEY).createPackage({ typeId: "tawd-wp", domain: "nora.vmlpreview.com", label: "nora" });
    expect(id).toBe("4242");
    expect(seen[0]!.body).toEqual({ type: "tawd-wp", domain_name: "nora.vmlpreview.com", label: "nora", documentRoots: { "nora.vmlpreview.com": "public_html" } });
  });

  it("deletes with a list of ids and says when 20i answers false; suspends with includeRepeated (VERIFIED: 20i.apib)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(stand({ "POST /reseller/*/deleteWeb": { body: { "7": true } }, "POST /package/7/userStatus": { body: true } }, seen));
    const api = httpTwentyi(KEY);
    await api.deletePackage("7");
    await api.setPackageEnabled("7", false);
    expect(seen.map((s) => s.body)).toEqual([{ "delete-id": ["7"] }, { includeRepeated: true, subservices: { default: false } }]);
    setTwentyiFetchForTesting(stand({ "POST /reseller/*/deleteWeb": { body: { "8": false } } }, []));
    await expect(api.deletePackage("8")).rejects.toThrow("didn't delete package 8");
  });

  it("adds a name to the package and pins its document root to the web root (VERIFIED: 20i.apib, names, documentRoots, updateDocRoot)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(
      stand(
        {
          "POST /package/7/names": { body: null },
          "GET /package/7/web/documentRoots": { body: { "nora.vmlpreview.com": "public_html", "harborpest.com": "public_html/harborpest.com", "www.harborpest.com": "/public_html/" } },
          "POST /package/7/web/updateDocRoot": { body: ["harborpest.com"] },
        },
        seen,
      ),
    );
    const api = httpTwentyi(KEY);
    await api.addDomain("7", "harborpest.com");
    await api.addDomain("7", "www.harborpest.com");
    expect(seen.filter((s) => s.method === "POST").map((s) => `${s.url.replace("https://api.20i.com", "")} ${JSON.stringify(s.body)}`)).toEqual([
      '/package/7/names {"add":["harborpest.com"]}',
      '/package/7/web/updateDocRoot {"update":{"harborpest.com":"public_html"}}',
      '/package/7/names {"add":["www.harborpest.com"]}',
    ]);
  });

  it("makes a database, then reads its names and host from 20i's list (the POST answers []; VERIFIED: 20i.apib, MySQL Databases)", async () => {
    const seen: Seen[] = [];
    let made = false;
    setTwentyiFetchForTesting((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace("https://api.20i.com", "");
      seen.push({ url, method: init?.method ?? "GET", auth: null, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "POST") {
        made = true;
        return Response.json([]);
      }
      return Response.json(made ? [{ id: "55", name: "tawd1234abcd-3530", host: "mysql-1.stackcp.example", server: "mysql-1.stackcp.example", type: "mysql" }] : []);
    }) as typeof fetch);
    const api = httpTwentyi(KEY);
    expect(await api.createDatabase("7", { name: "tawd1234abcd", password: "pw" })).toEqual({ name: "tawd1234abcd-3530", user: "tawd1234abcd-3530", host: "mysql-1.stackcp.example" });
    expect(seen.find((s) => s.method === "POST")!.body).toEqual({ name: "tawd1234abcd", password: "pw" });
    setTwentyiFetchForTesting(stand({ "GET /package/8/web/mysqlDatabases": { body: [{ name: "bad name; drop", host: "x.example.com" }] }, "POST /package/8/web/mysqlDatabases": { body: [] } }, []));
    await expect(api.createDatabase("8", { name: "x", password: "pw" })).rejects.toThrow("list doesn't show it");
  });

  it("adds TAWD's SSH key to the package only when it isn't there (VERIFIED: 20i.apib, SSH Keys)", async () => {
    const seen: Seen[] = [];
    const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc tawd-20i";
    setTwentyiFetchForTesting(stand({ "GET /package/7/web/sshkeys": { body: [] }, "POST /package/7/web/sshkeys": { body: [{}] }, "GET /package/8/web/sshkeys": { body: [{ handle: "x", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc" }] } }, seen));
    const api = httpTwentyi(KEY);
    expect(await api.addSshKey("7", pub)).toBe("added");
    expect(seen.at(-1)!.body).toEqual({ add: [{ key: pub, handle: expect.stringMatching(/^tawd-[0-9a-f]{8}$/) }], delete: [] });
    expect(await api.addSshKey("8", pub)).toBe("present");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("sets PHP as php83, purges the whole CDN cache and installs a certificate on each name (VERIFIED: 20i.apib)", async () => {
    const seen: Seen[] = [];
    const cert = "-----BEGIN CERTIFICATE-----\nNEWCERT\n-----END CERTIFICATE-----\n";
    setTwentyiFetchForTesting(
      stand(
        {
          "POST /package/7/web/phpVersion": { body: {} },
          "POST /package/7/web/purgeCdnByUrl": { body: true },
          "POST /package/7/web/externalSSL": { body: true },
          "GET /package/7/web/certificates": {
            body: [
              { id: "c1", commonName: "harborpest.com", provider: "external", certificatePem: "-----BEGIN CERTIFICATE-----\nOLDCERT\n-----END CERTIFICATE-----" },
              { id: "c2", commonName: "harborpest.com", provider: "external", certificatePem: cert },
              { id: "c3", commonName: "www.harborpest.com", provider: "letsencrypt/standard", certificatePem: "x" },
              { id: "c4", commonName: "nora.vmlpreview.com", provider: "external", certificatePem: "y" },
            ],
          },
          "POST /package/7/web/certificates": { body: [true] },
        },
        seen,
      ),
    );
    const api = httpTwentyi(KEY);
    await api.setPhpVersion("7", "8.3");
    await api.purgeCache("7");
    await api.installCertificate("7", { names: ["harborpest.com", "www.harborpest.com"], certificate: cert, privateKey: "-----BEGIN PRIVATE KEY-----", caBundle: "ca" });
    expect(seen.filter((s) => s.method === "POST").map((s) => [s.url.replace("https://api.20i.com", ""), s.body])).toEqual([
      ["/package/7/web/phpVersion", { value: "php83" }],
      ["/package/7/web/purgeCdnByUrl", {}],
      ["/package/7/web/externalSSL", { name: "harborpest.com", certificate: cert, key: "-----BEGIN PRIVATE KEY-----", ca: "ca" }],
      ["/package/7/web/externalSSL", { name: "www.harborpest.com", certificate: cert, key: "-----BEGIN PRIVATE KEY-----", ca: "ca" }],
      // Only the older external certificate for these names goes: not TAWD's new one, 20i's own Let's Encrypt, or another name's.
      ["/package/7/web/certificates", { delete: ["c1"] }],
    ]);
  });

  it("orders 20i's paid certificate with its class code; the answer is only the id (VERIFIED: 20i.apib, Order SSL Certificates)", async () => {
    const seen: Seen[] = [];
    setTwentyiFetchForTesting(stand({ "POST /reseller/*/addTlsCertificate": { body: "tls-991" } }, seen));
    expect(await httpTwentyi(KEY).orderCertificate({ packageId: "7", domain: "harborpest.com", periodMonths: 12 })).toEqual({ id: "tls-991", price: null, renewsAt: null });
    expect(seen[0]!.body).toEqual({ "class-code": "tucows-rapidssl", name: "harborpest.com", periodMonths: 12, configuration: {} });
  });

  it("explains 20i's errors in plain words and never repeats the key", async () => {
    const api = httpTwentyi(KEY);
    for (const [status, kind, words] of [
      [401, "auth", "refused TAWD's API key"],
      [402, "payment", "wants payment"],
      [429, "rate", "slow down"],
      [503, "server", "had a problem"],
      [400, "refused", "said no (400): nope"],
      // A 403 with 20i's own reason is that request refused, not the key (8 October 2026).
      [403, "refused", "said no (403): nope"],
    ] as const) {
      setTwentyiFetchForTesting(stand({ "GET /package": { status, body: { error: "nope" } } }, []));
      const error = await api.listPackages().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TwentyiError);
      expect((error as TwentyiError).kind).toBe(kind);
      expect((error as Error).message).toContain(words);
      expect((error as Error).message).not.toContain(KEY);
    }
    setTwentyiFetchForTesting(stand({ "GET /package": { status: 403, body: {} } }, []));
    expect(((await api.listPackages().catch((e: unknown) => e)) as TwentyiError).kind).toBe("auth");
  });

  it("refuses to call without TWENTYI_API_KEY and says where it goes (the worker only)", async () => {
    const error = await getTwentyi().listPackages().catch((e: unknown) => e);
    expect((error as TwentyiError).kind).toBe("config");
    expect((error as Error).message).toContain("tawd-worker-new only");
  });

  it("reads 20i's words from \"message\" too (error bodies aren't in 20i.apib)", async () => {
    setTwentyiFetchForTesting(stand({ "GET /package": { status: 400, body: { type: "InvalidRequest", message: "Bad name" } } }, []));
    await expect(httpTwentyi(KEY).listPackages()).rejects.toThrow("said no (400): Bad name");
  });

  it("builds the fallback staging address, the SSH sign-in (20i's public docs) and 20i's PHP value", () => {
    expect(stagingHostFor("nora-beagle-site.vmlpreview.com")).toBe("nora-beagle-site-vmlpreview-com.stackstaging.com");
    expect(sshAccessFor("Nora-Beagle-Site.vmlpreview.com")).toEqual({ host: "ssh.us.stackcp.com", port: 22, user: "nora-beagle-site.vmlpreview.com" });
    expect(phpValueFor("8.3")).toBe("php83");
    expect(() => phpValueFor("8.3; rm")).toThrow("Not a PHP version");
  });
});

describe("the fake 20i reseller", () => {
  it("makes packages with their own IP, suffixes database names, counts other packages and can refuse", async () => {
    const fake = new FakeTwentyi();
    fake.others = 2;
    const id = await fake.createPackage({ typeId: "tawd-wp", domain: "nora.com", label: "nora" });
    expect((await fake.getPackage(id))?.ipv4).toMatch(/^203\.0\.113\./);
    expect((await fake.createDatabase(id, { name: "tawd_nora", password: "pw" })).name).toBe("tawd_nora_x1");
    expect(await fake.listPackages()).toHaveLength(3);
    fake.moveIp(id, "198.51.100.9");
    expect((await fake.getPackage(id))?.ipv4).toBe("198.51.100.9");
    fake.refuse.deletePackage = new TwentyiError("20i said no.", "refused", 400);
    await expect(fake.deletePackage(id)).rejects.toThrow("20i said no.");
  });
});

describe("Cloudflare DNS on the worker", () => {
  it("finds the zone a preview name sits in and keeps exactly one A record, not proxied", async () => {
    const seen: { method: string; url: string; body?: unknown }[] = [];
    const records = new Map<string, { id: string; type: string; name: string; content: string }>([["old", { id: "old", type: "A", name: "nora.vmlpreview.com", content: "1.1.1.1" }]]);
    setCloudflareDnsFetchForTesting((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace("https://api.cloudflare.com/client/v4", "");
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
      if (url.startsWith("/zones?name=nora.vmlpreview.com")) return ok([]);
      if (url.startsWith("/zones?name=vmlpreview.com")) return ok([{ id: "z1", name: "vmlpreview.com" }]);
      if (method === "GET" && url.startsWith("/zones/z1/dns_records")) return ok([...records.values()]);
      if (method === "DELETE") {
        records.delete(url.split("/").pop()!);
        return ok({});
      }
      if (method === "POST") return ok({ id: "new" });
      return new Response("{}", { status: 500 });
    }) as typeof fetch);
    const cf = httpCloudflareDns("token", "acct");
    const zone = await cf.zoneFor("nora.vmlpreview.com");
    expect(zone).toEqual({ id: "z1", name: "vmlpreview.com" });
    await cf.setA("z1", "nora.vmlpreview.com", "203.0.113.10");
    // The new record first, then the old one (13 October 2026, the whole-code review).
    expect(seen.filter((s) => s.method !== "GET").map((s) => `${s.method} ${s.url}`)).toEqual(["POST /zones/z1/dns_records", "DELETE /zones/z1/dns_records/old"]);
    expect(seen.find((s) => s.method === "POST")!.body).toEqual({ type: "A", name: "nora.vmlpreview.com", content: "203.0.113.10", ttl: 300, proxied: false });
    await expect(cf.setA("z1", "nora.vmlpreview.com", "not-an-ip")).rejects.toThrow("Not an IPv4");
  });

  it("says which services need the token when it's missing", async () => {
    await expect(httpCloudflareDns("", "").zoneFor("a.example.com")).rejects.toThrow("tawd-web-new and tawd-worker-new");
  });

  it("has an in-memory stand-in for the job tests", async () => {
    const fake = new FakeCloudflareDns(["vmlpreview.com"]);
    const zone = await fake.zoneFor("nora.vmlpreview.com");
    await fake.setA(zone!.id, "nora.vmlpreview.com", "203.0.113.10");
    expect(await fake.aRecords(zone!.id, "nora.vmlpreview.com")).toEqual([{ id: "nora.vmlpreview.com-a", content: "203.0.113.10" }]);
    expect(await fake.zoneFor("other.example.com")).toBeNull();
  });
});
