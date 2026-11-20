import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
  Go-live, 28 September 2026 (Jason): before the nameserver switch, the
  domain's registrar and nameservers from RDAP, and DNSSEC from public DNS;
  the switch is refused, in plain words, while DNSSEC is on. Stand-ins for
  RDAP and DNS-over-HTTPS.
*/

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, goLive } from "@tawd/core/schema";
import { dnssecFromDoh, goLiveGate, rdapBaseFor, rdapDomainUrl, readRdap, resetRdapBootstrapForTesting, RDAP_BOOTSTRAP_URL } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { checkNameservers, checkRegistry, loadGoLive, setDnsForTesting, setRegistryFetchForTesting } from "@/lib/golive";

import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

// IANA's RDAP bootstrap list, trimmed: .com is Verisign's (0.122.1: the registry is asked, not rdap.org).
const BOOTSTRAP = { services: [[["net", "com"], ["https://rdap.verisign.com/com/v1/"]], [["uk", "co.uk"], ["https://rdap.nominet.uk/uk/"]]] };
const REGISTRY = "https://rdap.verisign.com/com/v1/domain/";

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  resetRdapBootstrapForTesting();
});

afterEach(async () => {
  setRegistryFetchForTesting(null);
  setDnsForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* An RDAP domain answer in the shape registries send (RFC 9083), trimmed. */
const RDAP = {
  objectClassName: "domain",
  ldhName: "HARBORPEST.COM",
  entities: [
    { objectClassName: "entity", roles: ["registrant"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "REDACTED FOR PRIVACY"]]] },
    {
      objectClassName: "entity",
      roles: ["registrar"],
      publicIds: [{ type: "IANA Registrar ID", identifier: "146" }],
      vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "GoDaddy.com, LLC"]]],
      links: [{ rel: "about", href: "https://www.godaddy.com" }],
    },
  ],
  nameservers: [{ objectClassName: "nameserver", ldhName: "NS07.DOMAINCONTROL.COM" }, { objectClassName: "nameserver", ldhName: "NS08.DOMAINCONTROL.COM." }],
  secureDNS: { delegationSigned: true },
};
const DS_ON = { Status: 0, Answer: [{ name: "harborpest.com.", type: 43, TTL: 3600, data: "2371 13 2 1F987..." }] };
const DS_OFF = { Status: 0, Answer: [] };

describe("reading the registry and DNS", () => {
  it("finds the registrar, its site, the nameservers and DNSSEC", () => {
    expect(readRdap(RDAP)).toEqual({ registrar: "GoDaddy.com, LLC", registrarUrl: "https://www.godaddy.com", nameservers: ["ns07.domaincontrol.com", "ns08.domaincontrol.com"], rdapSigned: true });
    expect(readRdap({})).toEqual({ registrar: null, registrarUrl: null, nameservers: [], rdapSigned: null });
    expect([dnssecFromDoh(DS_ON), dnssecFromDoh(DS_OFF), dnssecFromDoh({ Status: 3 }), dnssecFromDoh({ Status: 2 }), dnssecFromDoh("nonsense")]).toEqual([true, false, false, null, null]);
  });

  it("puts DNSSEC in the go-live blockers, in plain words, until the switch", () => {
    const steps = { domainConfirmed: true, emailVerified: true, emailConfirmed: true, netlifyDomain: true, nameserversSwitched: false, httpsConfirmed: false, ga4Recorded: true };
    const gate = goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true, dnssecOn: { domain: "harborpest.com", registrar: "GoDaddy.com, LLC" } });
    expect(gate.blockers[0]).toMatch(/^DNSSEC is on for harborpest\.com\. Switching the nameservers now would take the website and the client's email offline/);
    expect(gate.blockers[0]).toContain("Turn DNSSEC off at GoDaddy.com, LLC first");
  });
});

describe("the step", () => {
  async function confirmedDomain() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Harbor Pest Control", trade: "pest_control", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [] });
    await h.db.insert(goLive).values({ projectId: id, domain: "harborpest.com", registrar: "GoDaddy", registrant: "Harbor Pest Control LLC", domainConfirmedAt: new Date(), nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], emailConfirmedAt: new Date() });
    return { admin, id };
  }
  const answering = (ds: unknown) => {
    const asked: string[] = [];
    setRegistryFetchForTesting((async (url: string | URL) => {
      asked.push(String(url));
      const body = String(url) === RDAP_BOOTSTRAP_URL ? BOOTSTRAP : String(url).startsWith(REGISTRY) ? RDAP : ds;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    return asked;
  };

  it("shows where the domain is registered and refuses the switch while DNSSEC is on", async () => {
    const { admin, id } = await confirmedDomain();
    const asked = answering(DS_ON);
    const found = await checkRegistry(h.ctx, admin.viewer, id);
    expect(found).toMatchObject({ registrar: "GoDaddy.com, LLC", nameservers: ["ns07.domaincontrol.com", "ns08.domaincontrol.com"], dnssec: true });
    expect([...asked].sort()).toEqual([RDAP_BOOTSTRAP_URL, "https://cloudflare-dns.com/dns-query?name=harborpest.com&type=DS", "https://rdap.verisign.com/com/v1/domain/harborpest.com"].sort());
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.registry_checked"));
    expect(logged!.valueAfter).toMatchObject({ registrar: "GoDaddy.com, LLC", dnssec: true });
    expect((await loadGoLive(h.db, id)).gate.blockers.some((b) => b.startsWith("DNSSEC is on for harborpest.com"))).toBe(true);

    // The switch check asks again and refuses; nothing is looked up at the nameservers.
    let nsLookups = 0;
    setDnsForTesting({ lookup: async () => (nsLookups++, []) });
    await expect(checkNameservers(h.ctx, admin.viewer, id)).rejects.toThrow("DNSSEC is on for harborpest.com");
    expect(nsLookups).toBe(0);

    // Turned off at the registrar: the check goes ahead and the blocker goes.
    answering(DS_OFF);
    await checkNameservers(h.ctx, admin.viewer, id);
    expect(nsLookups).toBe(1);
    const [row] = await h.db.select().from(goLive).where(eq(goLive.projectId, id));
    expect((row!.registry as { dnssec: boolean }).dnssec).toBe(false);
    expect((await loadGoLive(h.db, id)).gate.blockers.some((b) => b.startsWith("DNSSEC"))).toBe(false);
  });

  it("falls back to Google's resolver, and needs the domain confirmed first", async () => {
    const { admin, id } = await confirmedDomain();
    setRegistryFetchForTesting((async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://cloudflare-dns.com/")) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify(u === RDAP_BOOTSTRAP_URL ? BOOTSTRAP : u.startsWith(REGISTRY) ? RDAP : DS_OFF), { status: 200 });
    }) as typeof fetch);
    expect((await checkRegistry(h.ctx, admin.viewer, id)).dnssec).toBe(false);

    await h.db.update(goLive).set({ domainConfirmedAt: null }).where(eq(goLive.projectId, id));
    await expect(checkRegistry(h.ctx, admin.viewer, id)).rejects.toThrow("Confirm the domain first.");
  });
});

describe("where RDAP is asked (0.122.1)", () => {
  it("picks the domain's registry from IANA's list: the longest ending, https only", () => {
    expect(rdapBaseFor(BOOTSTRAP, "harborpest.com")).toBe("https://rdap.verisign.com/com/v1/");
    expect(rdapBaseFor(BOOTSTRAP, "HarborPest.COM.")).toBe("https://rdap.verisign.com/com/v1/");
    expect(rdapBaseFor(BOOTSTRAP, "joes.co.uk")).toBe("https://rdap.nominet.uk/uk/");
    expect(rdapBaseFor({ services: [[["com"], ["https://a.example/rdap"]], [["example.com"], ["https://b.example/"]]] }, "x.example.com")).toBe("https://b.example/");
    expect(rdapBaseFor({ services: [[["com"], ["http://plain.example/"]]] }, "harborpest.com")).toBeNull();
    expect(rdapBaseFor(BOOTSTRAP, "harborpest.dev")).toBeNull();
    expect(rdapBaseFor("garbage", "harborpest.com")).toBeNull();
    expect(rdapBaseFor({ services: [["x", null], [[1], [2]]] }, "harborpest.com")).toBeNull();
  });

  it("reads the list once a day, and falls back to rdap.org only when the list can't say", async () => {
    let lists = 0;
    const get = async (url: string) => {
      if (url === RDAP_BOOTSTRAP_URL) lists += 1;
      return { ok: true, json: async () => BOOTSTRAP };
    };
    const t = Date.parse("2026-11-04T06:00:00Z");
    expect(await rdapDomainUrl("tawdpreviews.com", get, t)).toBe("https://rdap.verisign.com/com/v1/domain/tawdpreviews.com");
    expect(await rdapDomainUrl("harborpest.com", get, t + 3_600_000)).toBe("https://rdap.verisign.com/com/v1/domain/harborpest.com");
    expect(lists).toBe(1);
    await rdapDomainUrl("harborpest.com", get, t + 25 * 3_600_000);
    expect(lists).toBe(2);
    expect(await rdapDomainUrl("harborpest.dev", get, t + 25 * 3_600_000)).toBe("https://rdap.org/domain/harborpest.dev");
    resetRdapBootstrapForTesting();
    const down = async () => ({ ok: false, json: async () => ({}) });
    expect(await rdapDomainUrl("harborpest.com", down, t)).toBe("https://rdap.org/domain/harborpest.com");
    const throws = async () => { throw new Error("offline"); };
    expect(await rdapDomainUrl("harborpest.com", throws, t)).toBe("https://rdap.org/domain/harborpest.com");
  });

  it("never keeps an answer that isn't a list, and keeps the older list when a refresh fails (review of PR #29)", async () => {
    const t = Date.parse("2026-11-04T06:00:00Z");
    // A 200 with an error object: not kept, so the next lookup asks again.
    let lists = 0;
    const odd = async () => (lists++, { ok: true, json: async () => ({ error: "busy" }) });
    expect(await rdapDomainUrl("harborpest.com", odd, t)).toBe("https://rdap.org/domain/harborpest.com");
    expect(await rdapDomainUrl("harborpest.com", odd, t + 60_000)).toBe("https://rdap.org/domain/harborpest.com");
    expect(lists).toBe(2);
    // A good list, then a day on IANA fails: the older list is still used.
    await rdapDomainUrl("harborpest.com", async () => ({ ok: true, json: async () => BOOTSTRAP }), t);
    const down = async () => ({ ok: false, json: async () => ({}) });
    expect(await rdapDomainUrl("harborpest.com", down, t + 25 * 3_600_000)).toBe("https://rdap.verisign.com/com/v1/domain/harborpest.com");
    const bad = async () => ({ ok: true, json: async () => "<html>" });
    expect(await rdapDomainUrl("harborpest.com", bad, t + 26 * 3_600_000)).toBe("https://rdap.verisign.com/com/v1/domain/harborpest.com");
  });

  it("downloads the list once for lookups at the same moment (review of PR #29)", async () => {
    let lists = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const get = async () => {
      lists += 1;
      await gate;
      return { ok: true, json: async () => BOOTSTRAP };
    };
    const both = Promise.all([rdapDomainUrl("harborpest.com", get), rdapDomainUrl("tawdpreviews.com", get)]);
    release();
    expect(await both).toEqual(["https://rdap.verisign.com/com/v1/domain/harborpest.com", "https://rdap.verisign.com/com/v1/domain/tawdpreviews.com"]);
    expect(lists).toBe(1);
  });
});
