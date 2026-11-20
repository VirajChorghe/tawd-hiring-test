import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, netlifySite, project, projectTracking, seoGoLiveCheck, siteBuild, speedCheck } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { can } from "@tawd/core/permissions";
import { compareRecords, emailLookups, goLiveGate, netlifyRecords, type DnsRecord, type DnsRecordType } from "@tawd/core/site";
import { GateError, createProject, updateProject } from "@/lib/projects";
import { setNetlifyFetchForTesting } from "@/lib/netlify";
import {
  attachNetlifyDomain,
  checkEmailRecords,
  checkHttps,
  checkNameservers,
  confirmDomain,
  confirmEmailRecords,
  goLiveNow,
  loadGoLive,
  readEmailRecords,
  recordBuildFeePaid,
  recordGa4,
  rollBack,
  rollbackTarget,
  setDnsForTesting,
  setRegistryFetchForTesting,
  setGoLiveFetchForTesting,
  setGoLiveWaitForTesting,
  setUpCloudflare,
} from "@/lib/golive";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  Phase 9, go-live (28 September 2026), end to end with stand-ins for
  Cloudflare, Netlify, DNS and the live site. No network, no AI.
*/

let h: Harness;
let r2: FakeR2;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-test");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
  setGoLiveWaitForTesting(async () => undefined);
  // DNSSEC off, never the network (28 September 2026).
  setRegistryFetchForTesting((async () => new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 })) as typeof fetch);
});

afterEach(async () => {
  setNetlifyFetchForTesting(null);
  setGoLiveFetchForTesting(null);
  setDnsForTesting(null);
  setRegistryFetchForTesting(null);
  setGoLiveWaitForTesting(null);
  vi.unstubAllEnvs();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const DOMAIN = "harborpest.com";
const EMAIL: DnsRecord[] = [
  { type: "MX", name: DOMAIN, content: "aspmx.l.google.com", priority: 1 },
  { type: "TXT", name: DOMAIN, content: "v=spf1 include:_spf.google.com ~all" },
  { type: "TXT", name: `_dmarc.${DOMAIN}`, content: "v=DMARC1; p=none" },
  { type: "TXT", name: `google._domainkey.${DOMAIN}`, content: "v=DKIM1; k=rsa; p=MIIB" },
];
const NAMESERVERS = ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"];

/* Public DNS: the client's records before the switch; Cloudflare's nameserver answers from the zone. */
function dnsStand(state: { switched: boolean; zone: DnsRecord[] }) {
  setDnsForTesting({
    async lookup(type: DnsRecordType | "NS", name: string, server?: string) {
      if (type === "NS") return (state.switched ? NAMESERVERS : ["ns1.registrar.com"]).map((content) => ({ type: "CNAME" as const, name, content }));
      const source = server ? state.zone : EMAIL;
      return source.filter((r) => r.type === type && r.name === name);
    },
  });
}

/* Cloudflare: one account, zones created on demand, records kept in memory. */
function cloudflareStand(zone: DnsRecord[], options: { drop?: string } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchStand = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path.startsWith("/zones?")) return Response.json({ success: true, result: calls.some((c) => c.method === "POST" && c.path === "/zones") ? [{ id: "zone-1", name_servers: NAMESERVERS }] : [] });
    if (path === "/zones" && init?.method === "POST") return Response.json({ success: true, result: { id: "zone-1", name_servers: NAMESERVERS } });
    if (path.endsWith("/dns_records") && init?.method === "POST") {
      const r = body as { type: DnsRecordType; name: string; content: string; priority?: number };
      if (options.drop && r.content.includes(options.drop)) return Response.json({ success: true, result: {} });
      zone.push({ type: r.type, name: r.name, content: r.content, ...(r.type === "MX" ? { priority: r.priority } : {}) });
      return Response.json({ success: true, result: { id: `rec-${zone.length}` } });
    }
    if (path.includes("/dns_records")) return Response.json({ success: true, result: zone.map((r, i) => ({ id: `rec-${i}`, type: r.type, name: r.name, content: r.content, priority: r.priority })) });
    return Response.json({ success: true, result: {} });
  }) as typeof fetch;
  const site = (async () => new Response(`<html><head><script>gtag('config','G-ABC123XYZ')</script></head></html>`, { status: 200 })) as typeof fetch;
  setGoLiveFetchForTesting(fetchStand, site);
  return calls;
}

function netlifyStand() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  setNetlifyFetchForTesting(
    (async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.netlify.com/api/v1", "");
      const body = init?.body instanceof Uint8Array ? unzipSync(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path, body });
      if (path.endsWith("/deploys") && init?.method === "POST") return Response.json({ id: `nd-${++n}`, state: "uploaded" });
      if (path.startsWith("/deploys/")) return Response.json({ state: "ready", ssl_url: "https://tawd-harbor.netlify.app" });
      if (path.endsWith("/ssl")) return Response.json({ state: "issued" });
      return Response.json({});
    }) as typeof fetch,
    async () => undefined,
  );
  return calls;
}

async function readyProject() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Harbor Pest Control", trade: "pest_control", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 3, status: "qa", memberUserIds: [] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Harbor Pest Control" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainStatus: "client_has", domainName: DOMAIN });
  const checks = [
    { key: "placeholders", label: "No placeholders left", ok: true, detail: "None", blocksGoLive: true },
    { key: "tracking", label: "Consent banner and privacy page", ok: true, detail: "On every page", blocksGoLive: true },
    { key: "faq", label: "FAQ", ok: false, detail: "No FAQ", blocksGoLive: false },
  ];
  const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 3, checks }).returning();
  await h.db.insert(seoGoLiveCheck).values({ projectId: id, buildId: build!.id, version: 1, status: "done", signedOffAt: new Date(), signedOffByUserId: admin.viewer.id });
  await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-harbor", url: "https://tawd-harbor.netlify.app", formEmails: [] });
  await h.db.insert(projectTracking).values({ projectId: id, ga4: "G-ABC123XYZ" });
  for (const [file, text] of [["index.html", "<h1>Home</h1>"], ["robots.txt", "User-agent: *\nDisallow: /\n"], ["_headers", "/*\n  X-Robots-Tag: noindex, nofollow\n"]]) {
    r2.objects.set(`projects/${id}/site/v1/${file}`, Buffer.from(text!));
  }
  return { admin, id, buildId: build!.id };
}

describe("the go-live rules", () => {
  it("looks for every email record, points the domain and www at the Netlify site, and gates on everything Jason listed", () => {
    const lookups = emailLookups(DOMAIN, ["mysel"]);
    expect(lookups).toEqual(expect.arrayContaining([{ type: "MX", name: DOMAIN }, { type: "TXT", name: `_dmarc.${DOMAIN}` }, { type: "TXT", name: `google._domainkey.${DOMAIN}` }, { type: "TXT", name: `mysel._domainkey.${DOMAIN}` }]));
    expect(netlifyRecords("www.HarborPest.com", "tawd-harbor")).toEqual([
      { type: "CNAME", name: DOMAIN, content: "tawd-harbor.netlify.app" },
      { type: "CNAME", name: `www.${DOMAIN}`, content: "tawd-harbor.netlify.app" },
    ]);
    expect(compareRecords(EMAIL, [{ ...EMAIL[0]!, content: "ASPMX.L.GOOGLE.COM." }]).map((c) => c.ok)).toEqual([true, false, false, false]);

    const steps = { domainConfirmed: true, emailVerified: true, emailConfirmed: true, netlifyDomain: true, nameserversSwitched: true, httpsConfirmed: true, ga4Recorded: false };
    const gate = goLiveGate({
      buildFeePaid: false,
      hasBuild: true,
      founderFlags: ["License number: No license number yet."],
      steps,
      checklist: [
        { key: "placeholders", label: "No placeholders left", ok: false, detail: "3 left", blocksGoLive: true },
        { key: "faq", label: "FAQ", ok: false, detail: "No FAQ", blocksGoLive: false },
      ],
    });
    expect(gate.ready).toBe(false);
    expect(gate.blockers).toEqual(["The build fee isn't recorded as paid (an admin or a founder records it).", "No placeholders left: 3 left"]);
    // The license and GA4 are for the founders, never a block.
    expect(gate.flags).toEqual(["License number: No license number yet.", "GA4 isn't recorded yet (a client-owned property with VML as Editor)."]);
  });

  it("lets only founders and admins go live, and only admins record the build fee", async () => {
    const { admin, id } = await readyProject();
    const founder = await seedUser(h, admin.viewer, { email: "founder@velocitymedialab.com", roles: ["founder"] });
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    expect(can(founder.viewer, "site.golive")).toBe(true);
    expect(can(pm.viewer, "site.golive")).toBe(false);
    await expect(recordBuildFeePaid(h.ctx, pm.viewer, id, { paidOn: "2026-09-28", method: "card" })).rejects.toBeInstanceOf(PermissionError);
    await expect(goLiveNow(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("going live, step by step", () => {
  it("copies the email records first, checks them, and only then lets the switch, HTTPS and the live deploy happen", async () => {
    const { admin, id } = await readyProject();
    const founder = await seedUser(h, admin.viewer, { email: "founder@velocitymedialab.com", roles: ["founder"] });
    const state = { switched: false, zone: [] as DnsRecord[] };
    dnsStand(state);
    const cf = cloudflareStand(state.zone);
    const nf = netlifyStand();

    let view = await loadGoLive(h.db, id);
    expect(view.domainFromIntake).toBe(DOMAIN);
    expect(view.gate.blockers[0]).toContain("build fee");

    await recordBuildFeePaid(h.ctx, admin.viewer, id, { paidOn: "2026-09-28", method: "card", note: "INV-1042" });
    await expect(confirmDomain(h.ctx, admin.viewer, id, { domain: DOMAIN, registrar: "GoDaddy", registrant: "Harbor Pest Control LLC", inClientsName: false })).rejects.toThrow("client's name");
    await confirmDomain(h.ctx, admin.viewer, id, { domain: `https://www.${DOMAIN}/`, registrar: "GoDaddy", registrant: "Harbor Pest Control LLC", inClientsName: true });

    const found = await readEmailRecords(h.ctx, admin.viewer, id);
    expect(found).toHaveLength(4);

    const ns = await setUpCloudflare(h.ctx, admin.viewer, id);
    expect(ns).toEqual(NAMESERVERS);
    expect(cf.find((c) => c.path === "/zones" && c.method === "POST")!.body).toMatchObject({ name: DOMAIN, account: { id: "acct-1" } });
    // The four email records and the two Netlify ones, never proxied.
    const added = cf.filter((c) => c.method === "POST" && c.path.endsWith("/dns_records")).map((c) => c.body as { type: string; proxied?: boolean });
    expect(added).toHaveLength(6);
    expect(added.every((r) => r.proxied === false)).toBe(true);

    // No switch before the email records are confirmed.
    await expect(checkNameservers(h.ctx, admin.viewer, id)).rejects.toThrow("stops the client's email");

    const check = await checkEmailRecords(h.ctx, admin.viewer, id);
    expect(check.every((c) => c.ok)).toBe(true);
    await expect(confirmEmailRecords(h.ctx, admin.viewer, id, { confirmedWithProvider: false, note: "x" })).rejects.toThrow("Confirmed with the client");
    await confirmEmailRecords(h.ctx, admin.viewer, id, { confirmedWithProvider: true, note: "Google Workspace admin, by phone" });

    await attachNetlifyDomain(h.ctx, admin.viewer, id);
    expect(nf.find((c) => c.method === "PATCH")!.body).toEqual({ custom_domain: DOMAIN, domain_aliases: [`www.${DOMAIN}`] });

    expect((await checkNameservers(h.ctx, admin.viewer, id)).switched).toBe(false);
    state.switched = true;
    expect((await checkNameservers(h.ctx, admin.viewer, id)).switched).toBe(true);
    expect(await checkHttps(h.ctx, admin.viewer, id)).toBe(true);

    await expect(recordGa4(h.ctx, admin.viewer, id, { propertyId: "412345678", measurementId: "G-OTHER1", vmlIsEditor: true })).rejects.toThrow("Tracking card has G-ABC123XYZ");
    await recordGa4(h.ctx, admin.viewer, id, { propertyId: "412345678", measurementId: "g-abc123xyz", vmlIsEditor: true });

    // The speed gate (1 October 2026): a Speed check of the preview after the build, 85 or more on both.
    view = await loadGoLive(h.db, id);
    expect(view.gate.blockers).toEqual(["Speed: run the Speed check on the Netlify preview of this build first (Speed check, Go live)."]);
    const fast = { scores: { performance: 94, accessibility: 100, bestPractices: 100, seo: 100 }, metrics: {}, issues: [], hiddenFromSearch: false };
    await h.db.insert(speedCheck).values({ projectId: id, target: "netlify", url: "https://x/", status: "done", results: { mobile: fast, desktop: fast } });

    view = await loadGoLive(h.db, id);
    // Ready. Pest control is a licensed trade with no license number yet: a flag for the founders, not a block.
    expect(view.gate.ready).toBe(true);
    expect(view.gate.blockers).toEqual([]);
    expect(view.gate.flags).toEqual([expect.stringContaining("License number")]);

    const live = await goLiveNow(h.ctx, founder.viewer, id);
    expect(live).toEqual({ url: `https://${DOMAIN}/`, version: 1 });
    const upload = nf.find((c) => c.method === "POST" && c.path === "/sites/site-1/deploys")!.body as Record<string, Uint8Array>;
    // The same files, with the live robots.txt and _headers: search engines allowed.
    expect(new TextDecoder().decode(upload["robots.txt"])).toContain("Allow: /");
    expect(new TextDecoder().decode(upload["robots.txt"])).toContain(`Sitemap: https://${DOMAIN}/sitemap.xml`);
    expect(new TextDecoder().decode(upload["_headers"])).not.toContain("noindex");
    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    expect(row!.status).toBe("live");
    expect(row!.liveAt).not.toBeNull();

    const actions = (await h.db.select().from(activityLog).where(eq(activityLog.entityId, id))).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(["golive.fee_paid", "golive.domain_confirmed", "golive.email_read", "golive.cloudflare_ready", "golive.email_verified", "golive.email_confirmed", "golive.netlify_domain", "golive.nameservers_switched", "golive.https_confirmed", "golive.ga4_recorded", "golive.went_live", "project.status_changed"]),
    );
    const wentLive = (await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.went_live")))[0]!;
    expect(wentLive.valueAfter).toMatchObject({ ga4OnPage: true });

    // A second build goes live; one click brings the first back.
    const [b2] = await h.db.insert(siteBuild).values({ projectId: id, version: 2, status: "done", pages: [], fileCount: 3, checks: [{ key: "placeholders", label: "No placeholders left", ok: true, detail: "None", blocksGoLive: true }] }).returning();
    await h.db.update(seoGoLiveCheck).set({ buildId: b2!.id, version: 2 }).where(eq(seoGoLiveCheck.projectId, id));
    for (const file of ["index.html", "robots.txt", "_headers"]) r2.objects.set(`projects/${id}/site/v2/${file}`, Buffer.from("x"));
    expect(await goLiveNow(h.ctx, admin.viewer, id)).toMatchObject({ version: 2 });
    expect((await loadGoLive(h.db, id)).canRollBack).toBe(true);
    expect(await rollBack(h.ctx, founder.viewer, id)).toEqual({ version: 1 });
    expect(nf.some((c) => c.method === "POST" && c.path === "/sites/site-1/deploys/nd-1/restore")).toBe(true);
    expect((await loadGoLive(h.db, id)).row.liveVersion).toBe(1);
    // Back at the first live deploy there's nothing earlier: no Roll back, never forward to version 2 (13 October 2026).
    expect((await loadGoLive(h.db, id)).canRollBack).toBe(false);
    await expect(rollBack(h.ctx, founder.viewer, id)).rejects.toThrow("There is no earlier live deploy to go back to.");
  });

  it("steps further back on a second Roll back, never forward again (the whole-code review, 13 October 2026)", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 13, 10, minutes));
    const d = (id: string, kind: string, deployId: string, version: number, minutes: number) =>
      ({ id, kind, netlifyDeployId: deployId, version, state: "ready", readyAt: at(minutes) }) as never;
    const v1 = d("a", "live", "nd-1", 1, 1);
    const v2 = d("b", "live", "nd-2", 2, 2);
    const v3 = d("c", "live", "nd-3", 3, 3);
    expect(rollbackTarget([v1, v2, v3])!.previous).toBe(v2);
    const back1 = d("r1", "rollback", "nd-2", 2, 4);
    expect(rollbackTarget([v1, v2, v3, back1])!.previous).toBe(v1);
    const back2 = d("r2", "rollback", "nd-1", 1, 5);
    expect(rollbackTarget([v1, v2, v3, back1, back2])).toBeNull();
    expect(rollbackTarget([v1])).toBeNull();
  });

  it("won't mark the email records checked while one is missing on Cloudflare", async () => {
    const { admin, id } = await readyProject();
    const state = { switched: false, zone: [] as DnsRecord[] };
    dnsStand(state);
    cloudflareStand(state.zone, { drop: "DMARC1" });
    netlifyStand();
    await confirmDomain(h.ctx, admin.viewer, id, { domain: DOMAIN, registrar: "GoDaddy", registrant: "Harbor Pest Control LLC", inClientsName: true });
    await readEmailRecords(h.ctx, admin.viewer, id);
    await setUpCloudflare(h.ctx, admin.viewer, id);
    const check = await checkEmailRecords(h.ctx, admin.viewer, id);
    expect(check.filter((c) => !c.ok).map((c) => c.record)).toEqual([`TXT _dmarc.${DOMAIN} v=DMARC1; p=none`]);
    expect((await loadGoLive(h.db, id)).row.emailVerifiedAt).toBeNull();
    await expect(confirmEmailRecords(h.ctx, admin.viewer, id, { confirmedWithProvider: true, note: "Checked by phone" })).rejects.toThrow("every one must match");
  });

  it("only lets a project become Live through Go live", async () => {
    const { admin, id } = await readyProject();
    const [row] = await h.db.select().from(project).where(eq(project.id, id));
    await expect(
      updateProject(h.ctx, admin.viewer, id, { clientName: row!.clientName, trade: "pest_control", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 3, status: "live", memberUserIds: [] }),
    ).rejects.toBeInstanceOf(GateError);
  });
});
