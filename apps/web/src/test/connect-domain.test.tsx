import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  F3, Connect the domain (1 October 2026; Jason: "the most valuable and
  required setup"). TAWD looks the domain up (who runs its DNS and email,
  what it points at, what's in the way), recommends the path, writes the
  client's steps for their own provider, gives them a private page, and
  checks the records on two public resolvers. DNS is a stand-in here.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});
vi.mock("@/app/connect/actions", () => ({ clientDoneAction: async () => ({ ok: true, done: false, remaining: 1 }) }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, goLive, netlifySite } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import {
  advisePath,
  caaText,
  changesFor,
  dnsHostFrom,
  dohValues,
  emailProviderFrom,
  goLiveGate,
  guideFor,
  instructionsText,
  isCloudflareIp,
  siteRecords,
  snapshotFrom,
  type DomainSnapshot,
} from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { confirmDomain } from "@/lib/golive";
import { checkRecords, choosePath, clientSaysDone, connectTick, detectDomain, loadClientPage, loadConnect, makeClientLink, pendingChecks, setConnectDnsForTesting } from "@/lib/connect";
import { GoLiveCard, type GoLiveCardProps } from "@/components/build/golive-card";
import { ClientSteps } from "@/app/connect/[token]/steps";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

/* The stand-in DNS: the same answers from both resolvers unless a test changes one. */
type Zone = Record<string, { type: number; data: string; name?: string }[]>;
let zones: { cloudflare: Zone; google: Zone };

function setZone(zone: Zone) {
  zones = { cloudflare: structuredClone(zone), google: structuredClone(zone) };
}

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setZone({});
  setConnectDnsForTesting(async (url) => {
    const u = new URL(url);
    const which = u.host.includes("google") ? "google" : "cloudflare";
    const name = u.searchParams.get("name")!;
    const type = u.searchParams.get("type")!;
    const answers = zones[which][`${name} ${type}`] ?? [];
    return { Status: 0, Answer: answers.map((a) => ({ name: a.name ?? `${name}.`, type: a.type, data: a.data })) };
  });
});

afterEach(async () => {
  setConnectDnsForTesting(null);
  vi.unstubAllEnvs();
  setDbForTesting(null);
  await h.close();
});

/* harborpest.com at GoDaddy, on an old host, with Microsoft 365 email. */
const OLD: Zone = {
  "harborpest.com NS": [{ type: 2, data: "ns51.domaincontrol.com." }, { type: 2, data: "ns52.domaincontrol.com." }],
  "harborpest.com A": [{ type: 1, data: "34.102.136.180" }],
  "harborpest.com AAAA": [{ type: 28, data: "2001:db8::1" }],
  "www.harborpest.com CNAME": [{ type: 5, data: "harborpest.com." }],
  "harborpest.com MX": [{ type: 15, data: "0 harborpest-com.mail.protection.outlook.com." }],
  "harborpest.com DS": [],
};

const NEW: Zone = {
  ...OLD,
  "harborpest.com A": [{ type: 1, data: "75.2.60.5" }],
  "harborpest.com AAAA": [],
  "www.harborpest.com CNAME": [{ type: 5, data: "tawd-harbor-abc123.netlify.app." }],
};

const snap = (over: Partial<DomainSnapshot> = {}): DomainSnapshot => ({ domain: "harborpest.com", nameservers: ["ns51.domaincontrol.com"], apexA: [], apexAAAA: [], apexCname: [], wwwA: [], wwwAAAA: [], wwwCname: [], mx: [], caa: [], dnssec: false, ...over });

describe("what TAWD reads from DNS", () => {
  it("names the DNS provider and the email provider", () => {
    expect(dnsHostFrom(["pdns01.domaincontrol.com"])?.name).toBe("GoDaddy");
    expect(dnsHostFrom(["dns1.registrar-servers.com"])?.id).toBe("namecheap");
    expect(dnsHostFrom(["selah.ns.cloudflare.com."])?.id).toBe("cloudflare");
    expect(dnsHostFrom(["ns-cloud-a1.googledomains.com"])?.id).toBe("squarespace");
    expect(dnsHostFrom(["ns-1234.awsdns-12.org"])?.id).toBe("route53");
    expect(dnsHostFrom(["ns1.some-unknown-host.net"])).toBeNull();
    expect(emailProviderFrom("harborpest.com", ["aspmx.l.google.com"])?.name).toBe("Google Workspace");
    expect(emailProviderFrom("harborpest.com", ["harborpest-com.mail.protection.outlook.com."])?.name).toBe("Microsoft 365");
    expect(emailProviderFrom("harborpest.com", ["mailstore1.secureserver.net"])?.id).toBe("godaddy");
    expect(emailProviderFrom("harborpest.com", ["mx.zoho.com"])?.id).toBe("zoho");
    expect(emailProviderFrom("harborpest.com", ["mail.harborpest.com"])?.id).toBe("host");
    expect(emailProviderFrom("harborpest.com", [])).toBeNull();
  });

  it("reads DNS-over-HTTPS answers, MX hosts and CAA in either form", () => {
    expect(dohValues({ Status: 0, Answer: [{ type: 15, data: "10 aspmx.l.google.com." }] }, 15)).toEqual(["aspmx.l.google.com"]);
    expect(dohValues({ Status: 2 }, 1)).toBeNull();
    // "0 issue letsencrypt.org" in the generic form some resolvers send.
    const hex = [0, 5, ..."issue".split("").map((c) => c.charCodeAt(0)), ..."letsencrypt.org".split("").map((c) => c.charCodeAt(0))].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    expect(caaText(`\\# 22 ${hex}`)).toBe('0 issue "letsencrypt.org"');
    expect(caaText('0 issue "sectigo.com"')).toBe('0 issue "sectigo.com"');
    expect(isCloudflareIp("104.21.5.57")).toBe(true);
    expect(isCloudflareIp("75.2.60.5")).toBe(false);
  });

  it("doesn't count a CNAME's target addresses as www's own", async () => {
    setZone({
      ...OLD,
      "www.harborpest.com CNAME": [],
      "www.harborpest.com A": [
        { type: 5, data: "old-host.example.", name: "www.harborpest.com." },
        { type: 1, data: "9.9.9.9", name: "old-host.example." },
      ],
    });
    const s = (await snapshotFrom("https://cloudflare-dns.com/dns-query", "harborpest.com", async (url) => {
      const u = new URL(url);
      const answers = zones.cloudflare[`${u.searchParams.get("name")} ${u.searchParams.get("type")}`] ?? [];
      return { Status: 0, Answer: answers.map((a) => ({ name: a.name ?? "x.", type: a.type, data: a.data })) };
    }))!;
    expect(s.wwwCname).toEqual(["old-host.example"]);
    expect(s.wwwA).toEqual([]);
    expect(s.mx).toEqual(["harborpest-com.mail.protection.outlook.com"]);
  });
});

describe("what the client changes", () => {
  const netlify = siteRecords("netlify", "harborpest.com", "tawd-harbor-abc123");

  it("asks for the two records Netlify needs, and a WordPress site's own 20i package IP", () => {
    expect(netlify).toEqual([
      { host: "@", type: "A", value: "75.2.60.5" },
      { host: "www", type: "CNAME", value: "tawd-harbor-abc123.netlify.app" },
    ]);
    expect(siteRecords("wordpress", "harborpest.com", null, "185.151.30.12")).toEqual([
      { host: "@", type: "A", value: "185.151.30.12" },
      { host: "www", type: "CNAME", value: "harborpest.com" },
    ]);
    // Before the package exists, the record says where its value comes from.
    expect(siteRecords("wordpress", "harborpest.com", null)[0]!.value).toContain("deploy the WordPress preview first");
  });

  it("lists every change in order, old addresses to remove, and never an email record", () => {
    const changes = changesFor(snap({ apexA: ["34.102.136.180", "34.102.136.181"], apexAAAA: ["2001:db8::1"], wwwA: ["34.102.136.180"], mx: ["x.outlook.com"] }), netlify, "netlify");
    expect(changes.map((c) => `${c.action} ${c.type} ${c.host} ${c.value}${c.from ? ` from ${c.from}` : ""}`)).toEqual([
      "change A @ 75.2.60.5 from 34.102.136.180",
      "remove A @ 34.102.136.181",
      "remove AAAA @ 2001:db8::1",
      "remove A www 34.102.136.180",
      "add CNAME www tawd-harbor-abc123.netlify.app",
    ]);
    expect(changes.some((c) => c.type === "MX" || c.type === "TXT")).toBe(false);
    expect(changesFor(snap({ apexA: ["75.2.60.5"], wwwCname: ["tawd-harbor-abc123.netlify.app"] }), netlify, "netlify")).toEqual([]);
  });

  it("adds a CAA record when one stands in the way of the certificate", () => {
    const changes = changesFor(snap({ apexA: ["75.2.60.5"], wwwCname: ["tawd-harbor-abc123.netlify.app"], caa: ['0 issue "digicert.com"'] }), netlify, "netlify");
    expect(changes).toEqual([expect.objectContaining({ action: "add", type: "CAA", value: '0 issue "letsencrypt.org"' })]);
    expect(changesFor(snap({ apexA: ["75.2.60.5"], wwwCname: ["tawd-harbor-abc123.netlify.app"], caa: ['0 issue "letsencrypt.org"'] }), netlify, "netlify")).toEqual([]);
  });

  it("behind Cloudflare's proxy, says to edit the record and switch the proxy off, not to remove addresses it can't see", () => {
    const changes = changesFor(snap({ nameservers: ["selah.ns.cloudflare.com"], apexA: ["104.21.5.57", "172.67.133.4"], apexAAAA: ["2606:4700::1"], wwwA: ["104.21.5.57"] }), netlify, "netlify");
    expect(changes.map((c) => `${c.action} ${c.type} ${c.host}`)).toEqual(["change A @", "change CNAME www"]);
    expect(changes[0]!.why).toContain("DNS only (grey cloud)");
  });

  it("recommends the records unless VML runs the DNS or bought the domain", () => {
    expect(advisePath({ snapshot: snap(), vmlNameservers: [], vmlBought: false }).path).toBe("records");
    expect(advisePath({ snapshot: snap(), vmlNameservers: [], vmlBought: true }).path).toBe("vml_dns");
    expect(advisePath({ snapshot: snap({ nameservers: ["anna.ns.cloudflare.com", "bob.ns.cloudflare.com"] }), vmlNameservers: ["anna.ns.cloudflare.com", "bob.ns.cloudflare.com"], vmlBought: false }).path).toBe("vml_dns");
  });

  it("writes the steps for the client's provider, in plain text for their IT person too", () => {
    const g = guideFor(dnsHostFrom(["ns51.domaincontrol.com"]));
    expect(g.name).toBe("GoDaddy");
    expect(g.where[0]).toContain("GoDaddy");
    expect(g.access).toContain("Delegate Access");
    expect(guideFor(null).name).toBe("your DNS provider");
    const text = instructionsText({ domain: "harborpest.com", clientName: "Harbor Pest", host: dnsHostFrom(["ns51.domaincontrol.com"]), changes: [{ action: "change", host: "@", type: "A", value: "75.2.60.5", from: "34.102.136.180" }], emailProvider: "Microsoft 365" });
    expect(text).toContain("Where: GoDaddy");
    expect(text).toContain("- Change: A record, name @, value 75.2.60.5 (now 34.102.136.180)");
    expect(text).toContain("for Microsoft 365) must not change");
  });
});

describe("the gate", () => {
  const steps = { domainConfirmed: true, emailVerified: false, emailConfirmed: false, netlifyDomain: true, nameserversSwitched: false, httpsConfirmed: true, ga4Recorded: true };

  it("on the records path, needs the records and no email or nameserver step", () => {
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps: { ...steps, recordsOk: false }, founderFlags: [], hasBuild: true, path: "records" }).blockers).toEqual(["The domain's two records aren't pointing at the new site yet (Connect the domain)."]);
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps: { ...steps, recordsOk: true }, founderFlags: [], hasBuild: true, path: "records" }).ready).toBe(true);
    // The nameserver path is as it was.
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps: { ...steps, recordsOk: true }, founderFlags: [], hasBuild: true, path: "vml_dns" }).blockers).toContain("The domain's nameservers haven't been switched to Cloudflare yet.");
  });
});

async function project() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
  const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
  const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "growth", clientName: "Harbor Pest" });
  await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-harbor-abc123", url: "https://tawd-harbor-abc123.netlify.app", formEmails: [] });
  await confirmDomain(h.ctx, pm.viewer, id, { domain: "HarborPest.com", registrar: "GoDaddy", registrant: "Harbor Pest LLC", inClientsName: true });
  return { admin, pm, content, id };
}

describe("connecting a real project", () => {
  it("looks the domain up, recommends the records, and the PM can choose another way (logged)", async () => {
    const { pm, content, id } = await project();
    setZone(OLD);
    await expect(detectDomain(h.ctx, content.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    const found = await detectDomain(h.ctx, pm.viewer, id);
    expect(found.host?.name).toBe("GoDaddy");
    expect(found.email?.name).toBe("Microsoft 365");
    expect(found.advice.path).toBe("records");
    const view = await loadConnect(h.db, id);
    expect(view.path).toBe("records");
    expect(view.changes.map((c) => `${c.action} ${c.type} ${c.host}`)).toEqual(["change A @", "remove AAAA @", "change CNAME www"]);

    await choosePath(h.ctx, pm.viewer, id, "access");
    expect((await loadConnect(h.db, id)).path).toBe("access");
    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["golive.domain_detected", "golive.path_chosen"]));
  });

  it("checks the records on both resolvers, and is right only when both agree", async () => {
    const { pm, id } = await project();
    setZone(OLD);
    await detectDomain(h.ctx, pm.viewer, id);
    let check = await checkRecords(h.ctx, pm.viewer, id);
    expect(check.ok).toBe(false);
    expect(check.resolvers).toEqual([{ id: "cloudflare", ok: false }, { id: "google", ok: false }]);

    // One resolver has the new records, the other's cache still has the old ones.
    zones.cloudflare = structuredClone(NEW);
    check = await checkRecords(h.ctx, pm.viewer, id);
    expect(check.ok).toBe(false);
    expect(check.resolvers).toEqual([{ id: "cloudflare", ok: true }, { id: "google", ok: false }]);
    expect((await h.db.select().from(goLive).where(eq(goLive.projectId, id)))[0]!.recordsOkAt).toBeNull();

    setZone(NEW);
    check = await checkRecords(h.ctx, pm.viewer, id);
    expect(check).toMatchObject({ ok: true, changes: [], by: "pm" });
    const [row] = await h.db.select().from(goLive).where(eq(goLive.projectId, id));
    expect(row!.recordsOkAt).not.toBeNull();
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.records_ok"))).length).toBe(1);
  });

  it("gives the client a private link (only its hash is kept); their I've done it checks at once and tells the PM", async () => {
    const { pm, id } = await project();
    vi.stubEnv("BETTER_AUTH_URL", "https://tawd.velocitymedialab.com");
    setZone(OLD);
    await expect(makeClientLink(h.ctx, pm.viewer, id)).rejects.toThrow("look it up first");
    await detectDomain(h.ctx, pm.viewer, id);
    const url = await makeClientLink(h.ctx, pm.viewer, id);
    expect(url).toMatch(/^https:\/\/tawd\.velocitymedialab\.com\/connect\/[A-Za-z0-9_-]{32}$/);
    const token = url.split("/").pop()!;
    const [row] = await h.db.select().from(goLive).where(eq(goLive.projectId, id));
    expect(row!.clientLinkHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);

    const page = (await loadClientPage(h.db, token))!;
    expect(page).toMatchObject({ clientName: "Harbor Pest", domain: "harborpest.com", emailProvider: "Microsoft 365", path: "records" });
    expect(page.host?.name).toBe("GoDaddy");
    expect(page.changes.length).toBe(3);
    expect(await loadClientPage(h.db, "not-a-real-token-at-all-xx")).toBeNull();

    // A new link stops the old one.
    const second = await makeClientLink(h.ctx, pm.viewer, id);
    expect(await loadClientPage(h.db, token)).toBeNull();
    const token2 = second.split("/").pop()!;

    setZone(NEW);
    const check = (await clientSaysDone(h.ctx, token2))!;
    expect(check).toMatchObject({ ok: true, by: "client" });
    expect((await loadClientPage(h.db, token2))!.check?.ok).toBe(true);
    const said = await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.client_said_done"));
    expect(said).toHaveLength(1);
    // Logged as TAWD itself: the client has no login.
    expect(said[0]!.actorUserId).toBeNull();
  });

  it("checks pending domains every 15 minutes, and stops once they're right", async () => {
    const { pm, id } = await project();
    setZone(OLD);
    await detectDomain(h.ctx, pm.viewer, id);
    expect(await pendingChecks(h.db)).toEqual([]);
    await makeClientLink(h.ctx, pm.viewer, id);
    expect(await pendingChecks(h.db)).toEqual([id]);
    expect(await connectTick(h.db)).toBe(1);
    setZone(NEW);
    await connectTick(h.db);
    expect(await pendingChecks(h.db)).toEqual([]);
    const [row] = await h.db.select().from(goLive).where(eq(goLive.projectId, id));
    expect((row!.connectCheck as { by: string }).by).toBe("auto");
  });
});

describe("the screens", () => {
  const base: Omit<GoLiveCardProps, "connect"> = {
    projectId: "p1",
    canEdit: true,
    canGoLive: false,
    canMoney: false,
    cloudflareMissing: ["CLOUDFLARE_API_TOKEN"],
    fee: { line: "Paid" },
    domainFromIntake: "harborpest.com",
    steps: {
      domain: { done: true, line: "harborpest.com, at GoDaddy", domain: "harborpest.com", registrar: "GoDaddy", registrant: "Harbor" },
      email: { done: false, line: "", records: [], selectors: [] },
      cloudflare: { done: false, line: "", nameservers: [] },
      check: { done: false, line: "", results: [] },
      confirm: { done: false, line: "" },
      netlify: { done: true, line: "On Netlify" },
      switched: { done: false, line: "" },
      registry: null,
      https: { done: false, line: "" },
      ga4: { done: false, line: "" },
    },
    gate: { ready: false, blockers: [], flags: [] },
    live: null,
    canRollBack: false,
    lastError: null,
    pmLine: "Pat",
  };
  const connect = {
    path: "records" as const,
    found: { dns: "GoDaddy", dnsUrl: "https://dcc.godaddy.com/control/portfolio", email: "Microsoft 365", pointsAt: "34.102.136.180", advice: "records" as const, adviceWhy: "Recommended: the client keeps the domain where it is.", lookedUpLine: "Looked up today." },
    wanted: [{ type: "A", host: "@", value: "75.2.60.5" }, { type: "CNAME", host: "www", value: "tawd-harbor-abc123.netlify.app" }],
    changes: [{ action: "change" as const, type: "A", host: "@", value: "75.2.60.5", from: "34.102.136.180", why: "The bare domain points at your old website." }],
    checkLine: "Checked today (automatically): not yet. 1 change to go.",
    recordsOk: false,
    okLine: null,
    clientLinkLine: "Link made today by Pat.",
    clientDoneLine: null,
    instructions: "steps",
    access: null,
    emailLine: "Leave everything else alone: the email records (MX, TXT) for Microsoft 365 must not change.",
    locked: false,
  };

  it("shows the records path's steps: no email copy, no Cloudflare, no nameservers", () => {
    const html = renderToStaticMarkup(<GoLiveCard {...base} connect={connect} />);
    expect(html).toContain("Connect the domain");
    expect(html).toContain("Point the domain at the new site");
    expect(html).toContain("<code>75.2.60.5</code>");
    expect(html).toContain("The bare domain points at your old website.");
    expect(html).toContain("for Microsoft 365 must not change");
    expect(html).toContain("Make a new link");
    expect(html).toContain("Check now");
    expect(html).not.toContain("Switch the nameservers");
    expect(html).not.toContain("Read the client&#x27;s email records");
    expect(html).not.toContain("Cloudflare isn&#x27;t set up yet");
    expect(html).toContain("their email isn");

    const ns = renderToStaticMarkup(<GoLiveCard {...base} connect={{ ...connect, path: "vml_dns" }} />);
    expect(ns).toContain("Switch the nameservers");
    expect(ns).not.toContain("Point the domain at the new site");
  });

  it("gives the client their provider's steps, each value to copy, and I've done it", () => {
    const html = renderToStaticMarkup(
      <ClientSteps
        token="t"
        domain="harborpest.com"
        providerName="GoDaddy"
        providerUrl="https://dcc.godaddy.com/control/portfolio"
        where={["Sign in at GoDaddy and open My Products (Domain Portfolio)."]}
        watch={["GoDaddy often has a parked page."]}
        changes={connect.changes}
        done={false}
        doneAt={null}
        instructions="steps"
        access="In GoDaddy, Account Settings, Delegate Access: invite sites@vml.example"
      />,
    );
    expect(html).toContain("1. Sign in at");
    expect(html).toContain("2. Make this change");
    expect(html).toContain("<strong>Change</strong>");
    expect(html).toContain("<code>75.2.60.5</code>");
    expect(html).toContain("I&#x27;ve done it");
    expect(html).toContain("Copy these steps for your IT person");
    expect(html).toContain("Or give us access instead");
    expect(renderToStaticMarkup(<ClientSteps {...{ token: "t", domain: "harborpest.com", providerName: "GoDaddy", providerUrl: null, where: [], watch: [], changes: [], done: true, doneAt: null, instructions: "", access: null }} />)).toContain("All set");
  });
});
