import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build B on 20i (5 October 2026; was Bluehost, B3 1 October 2026): a
  WordPress site's go-live. The domain on the site's own package, the
  certificate by each of the three ways (TAWD's Let's Encrypt one, 20i's
  paid one after an admin's confirm, one installed by hand) with Check
  HTTPS confirming it, backups streamed to R2 and back, VML-run DNS now
  allowed, Suspend, Restore and Purge, and the daily work (IP watch,
  renewals, warnings) with its hourly tick. Every outside service is a
  stand-in.
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

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, appSetting, goLive, hostingAccountCheck, project as projectTable, serviceHeartbeat, siteBuild, wpPreview } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { WP_SITES_DAILY_JOB } from "@tawd/core/queue";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { isMissingObject, setStorageForTesting } from "@tawd/core/intake/storage";
import { FakeCloudflareDns, setCloudflareDnsForTesting } from "@tawd/core/cloudflare-dns";
import { goLiveGate } from "@tawd/core/site";
import { BACKUPS_KEPT, TWENTYI_PACKAGE_TYPE_SETTING, WP_CERT_PATH_SETTING, WP_SITES_DAILY_SETTING, certRetryDue, expiryWarningDue, renewalDue, rollbackTarget, type WpCert } from "@tawd/core/wp-preview";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setHosting } from "@/lib/hosting";
import { loadWpPreview, removeWpPreview, showWpLogin, startWpPreview } from "@/lib/wp-preview";
import { WpPreviewSection, type WpPreviewSectionProps } from "@/components/build/wp-preview-section";
import { deleteBlocker } from "@/lib/project-deletion";
import { attachWpDomain, checkWpHttps, confirmPaidCertificate, loadWpLive, purgeWpCache, requestWpCertificate, setWpSuspended, wpRollback, wpUndoRollback } from "@/lib/wp-golive";
import { checkRecords, choosePath, setConnectDnsForTesting } from "@/lib/connect";
import { setGoLiveFetchForTesting, setUpCloudflare } from "@/lib/golive";
import { makeTwentyiKey } from "@/lib/twentyi";
import { wpSitesTick } from "@/lib/wp-sites-daily";
import { WpCertificateStep, WpLiveSteps, type WpGoLiveProps } from "@/components/build/wp-golive-panels";

import { markWpPreviewFailed, runWpPreviewJob, Site } from "../../../worker/src/wp-preview";
import { runWpSitesDailyJob, setDailyDnsForTesting } from "../../../worker/src/wp-sites-daily";
import { setSshForTesting } from "../../../worker/src/ssh";
import { setTwentyiForTesting } from "../../../worker/src/twentyi";
import { FakeTwentyi } from "../../../worker/src/twentyi-fake";
import { setAcmeForTesting, setCertDnsForTesting, setTlsProbeForTesting } from "../../../worker/src/wp-cert";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";
import { dohStandIn, fakeAcme, newServer, pointedZone, sshStandIn, tlsStandIn, type PackageServer, type Zone } from "./wp-20i-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: Record<string, unknown> }[];
let server: PackageServer;
let twentyi: FakeTwentyi;
let cloudflare: FakeCloudflareDns;
let serving: Map<string, { issuer: string; validTo: string }>;
let acmeLog: { names: string[]; staging: boolean; tokens: string[] }[];
let zone: Zone;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async () => null });
  server = newServer();
  setSshForTesting(sshStandIn(server, []));
  twentyi = new FakeTwentyi();
  setTwentyiForTesting(twentyi);
  cloudflare = new FakeCloudflareDns(["vmlpreview.com", "harborpest.com"]);
  setCloudflareDnsForTesting(cloudflare);
  serving = new Map();
  setTlsProbeForTesting(tlsStandIn(serving));
  acmeLog = [];
  setAcmeForTesting(fakeAcme(acmeLog));
  zone = {};
  setCertDnsForTesting(dohStandIn(() => zone));
  setDailyDnsForTesting(dohStandIn(() => zone));
  setConnectDnsForTesting(dohStandIn(() => zone));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setSshForTesting(null);
  setTwentyiForTesting(null);
  setCloudflareDnsForTesting(null);
  setTlsProbeForTesting(null);
  setAcmeForTesting(null);
  setCertDnsForTesting(null);
  setDailyDnsForTesting(null);
  setConnectDnsForTesting(null);
  setGoLiveFetchForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const base = { trade: "pest_control" as const, lane: "lane_1" as const, laneOption: null, conceptCount: 1, status: "build" as const, memberUserIds: [] as string[], tier: "pro" as const };
const row = async (id: string) => (await h.db.select().from(wpPreview).where(eq(wpPreview.projectId, id)))[0]!;
const gl = async (id: string) => (await h.db.select().from(goLive).where(eq(goLive.projectId, id)))[0]!;
const lastJob = () => queued.at(-1)!.data as never;
const cardProps: WpGoLiveProps = { domain: "harborpest.com", previewHost: "x", onHost: true, onHostLine: null, note: null, liveState: null, liveSteps: [], hasBackup: false, backupLine: null, certPath: "manual", cert: null, paidPrice: 34.99, isAdmin: false, ipLine: null, suspended: false };
const sectionProps: WpPreviewSectionProps = { projectId: "p1", state: "ready", host: "harbor-pest.vmlpreview.com", version: 1, deployedVersion: 1, latestBuild: 1, https: true, steps: [], removing: false, blockers: [], canDeploy: true, isAdmin: true, statusLine: null };
const certPath = (path: string) => h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path } }).onConflictDoUpdate({ target: appSetting.key, set: { value: { path } } });

/* A deployed WordPress preview on 20i, with the client's domain confirmed. */
async function deployed() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
  const id = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest" });
  await setHosting(h.ctx, admin.viewer, id, "wordpress");
  // The 20i package is named after the client's domain (0.103.1).
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainName: "harborpest.com" });
  await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never);
  await r2.put(`projects/${id}/site/v1/index.html`, Buffer.from("<!doctype html><html><head><title>Harbor Pest</title></head><body><main><h1>Harbor</h1></main></body></html>"));
  await makeTwentyiKey(h.ctx, admin.viewer, false);
  await h.db.insert(hostingAccountCheck).values({ status: "done", results: { items: [], keyWorks: true, packages: 1, types: [{ id: "tawd-wp", label: "TAWD WordPress" }] } });
  await h.db.insert(appSetting).values({ key: TWENTYI_PACKAGE_TYPE_SETTING, value: { id: "tawd-wp", label: "TAWD WordPress" } });
  await h.db.insert(serviceHeartbeat).values({ service: "worker", version: "0.88.0", startedAt: new Date(), env: { TWENTYI_API_KEY: true } });
  await startWpPreview(h.ctx, pm.viewer, id);
  await runWpPreviewJob(lastJob());
  await h.db.insert(goLive).values({ projectId: id, domain: "harborpest.com", domainConfirmedAt: new Date() } as never);
  const ip = (await row(id)).packageIpv4!;
  return { admin, pm, id, ip };
}

async function onHost(r: Awaited<ReturnType<typeof deployed>>) {
  await attachWpDomain(h.ctx, r.pm.viewer, r.id);
  await runWpPreviewJob(lastJob());
}

/* The client's domain points at the package and serves a working certificate: what Go live's first step checks (3 November 2026). */
function httpsReady(r: Awaited<ReturnType<typeof deployed>>) {
  zone = pointedZone(r.ip);
  serving.set("harborpest.com", { issuer: "R11", validTo: "2027-01-03T00:00:00Z" });
}

describe("a WordPress button when the job queue doesn't answer (the whole-code review, 13 October 2026)", () => {
  it("takes its busy mark back, so the buttons and project deletion aren't blocked for 75 minutes", async () => {
    const r = await deployed();
    const before = await row(r.id);
    setQueueForTesting({ add: async () => { throw new Error("Redis isn't answering"); }, getJob: async () => null });
    await expect(attachWpDomain(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("The job queue isn't answering. Try again in a minute.");
    expect((await row(r.id)).liveState).toBe(before.liveState);
    await expect(removeWpPreview(h.ctx, r.admin.viewer, r.id)).rejects.toThrow("The job queue isn't answering. Try again in a minute.");
    expect((await row(r.id)).state).toBe(before.state);
    setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async () => null });
    // The queue back: the same button works at once.
    await attachWpDomain(h.ctx, r.pm.viewer, r.id);
    expect((await row(r.id)).liveState).toBe("attaching");
  });

  it("keeps the busy mark when the queue took the job but answered with an error, so no second job can follow", async () => {
    const r = await deployed();
    const taken = new Set<string>();
    setQueueForTesting({
      add: async (_name, _data, opts) => {
        taken.add((opts as { jobId: string }).jobId);
        throw new Error("Connection is closed.");
      },
      getJob: async (id) => (taken.has(id) ? { remove: async () => undefined } : null),
    });
    await attachWpDomain(h.ctx, r.pm.viewer, r.id);
    expect((await row(r.id)).liveState).toBe("attaching");
    await expect(attachWpDomain(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("already working on the live site");
    expect(taken.size).toBe(1);
  });

  it("keeps the busy mark when the queue can't even say whether it took the job (CodeRabbit, PR #15)", async () => {
    const r = await deployed();
    setQueueForTesting({
      add: async () => {
        throw new Error("Connection is closed.");
      },
      getJob: async () => {
        throw new Error("Connection is closed.");
      },
    });
    await expect(attachWpDomain(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("didn't confirm the job");
    expect((await row(r.id)).liveState).toBe("attaching");
    await expect(attachWpDomain(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("already working on the live site");
  });

  it("queues one job when the button is pressed twice at once (CodeRabbit, PR #7)", async () => {
    const r = await deployed();
    const before = queued.length;
    const both = await Promise.allSettled([attachWpDomain(h.ctx, r.pm.viewer, r.id), attachWpDomain(h.ctx, r.pm.viewer, r.id)]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect(queued.length - before).toBe(1);
    expect((await row(r.id)).liveState).toBe("attaching");
  });
});

describe("putting the domain on 20i", () => {
  it("adds the domain and www to the site's own package, or says 20i's reason with Try again", async () => {
    const r = await deployed();
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    twentyi.refuse.addDomain = new TwentyiError("20i said no (400): domain is on another account", "refused", 400);
    await attachWpDomain(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    let wp = (await loadWpLive(h.db, r.id))!;
    expect(wp).toMatchObject({ onHost: false, note: "20i didn't add harborpest.com: 20i said no (400): domain is on another account", liveState: null });
    delete twentyi.refuse.addDomain;
    await onHost(r);
    wp = (await loadWpLive(h.db, r.id))!;
    expect(wp).toMatchObject({ onHost: true, note: null, domain: "harborpest.com", previewCurrent: true, ipv4: r.ip });
    expect(twentyi.packages.get((await row(r.id)).packageId!)!.names).toEqual(expect.arrayContaining(["harborpest.com", "www.harborpest.com"]));
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_domain_on_host")))).toHaveLength(1);
  });
});

describe("HTTPS on the client's domain", () => {
  it("TAWD's Let's Encrypt certificate: asked for by itself when the records first point at the site, for the domain and www, confirmed by Check HTTPS", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    // The records aren't there yet: nothing is asked of Let's Encrypt ($0, no failed tries against its limits).
    zone = { "harborpest.com NS": [{ type: 2, data: "ns51.domaincontrol.com." }], "harborpest.com A": [{ type: 1, data: "34.102.136.180" }] };
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    expect(queued.at(-1)!.data).toEqual({ projectId: r.id, action: "cert", target: "live" });
    await runWpPreviewJob(lastJob());
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "failed", note: expect.stringContaining("doesn't point at the site yet") } });
    expect(acmeLog).toEqual([]);

    // The client points the records: the check that sees it first queues the certificate itself (Fable's finding 1).
    zone = pointedZone(r.ip);
    const check = await checkRecords(h.ctx, r.pm.viewer, r.id);
    expect(check.ok).toBe(true);
    expect(queued.at(-1)!.data).toEqual({ projectId: r.id, action: "cert", target: "live" });
    await runWpPreviewJob(lastJob());
    expect(acmeLog.map((a) => a.names)).toEqual([["harborpest.com", "www.harborpest.com"]]);
    expect(twentyi.packages.get((await row(r.id)).packageId!)!.certificates).toEqual([expect.objectContaining({ domain: "harborpest.com", hasKey: true }), expect.objectContaining({ domain: "www.harborpest.com", hasKey: true })]);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", source: "letsencrypt", host: "harborpest.com", issuer: "R11" } });
    // 20i hasn't served it yet: the card says so, nothing waits inside the job.
    expect((await gl(r.id)).httpsConfirmedAt).toBeNull();
    expect((await gl(r.id)).lastError).toContain("HTTPS isn't ready on harborpest.com yet");

    serving.set("harborpest.com", { issuer: "Let's Encrypt", validTo: "2027-01-03T00:00:00Z" });
    await checkWpHttps(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await gl(r.id)).httpsConfirmedAt).not.toBeNull();
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "ok", expiresAt: "2027-01-03T00:00:00.000Z" } });
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.https_confirmed"))).toHaveLength(1);
    expect((await loadWpLive(h.db, r.id))!.cert).toMatchObject({ state: "ok" });
  });

  it("asks for TAWD's certificate when the domain goes on 20i after the records already pass: the order of the two clicks doesn't matter (finding 12)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    zone = pointedZone(r.ip);
    // The records are checked first: nothing to ask for yet (the domain isn't on the package).
    expect((await checkRecords(h.ctx, r.pm.viewer, r.id)).ok).toBe(true);
    expect(queued.some((q) => q.data.action === "cert")).toBe(false);
    await onHost(r);
    expect(acmeLog.map((a) => a.names)).toEqual([["harborpest.com", "www.harborpest.com"]]);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", source: "letsencrypt" } });
    const [asked] = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_cert_requested"));
    expect(asked!.valueAfter).toMatchObject({ by: "auto" });
  });

  it("20i's paid certificate: only after an admin confirms its price, never by itself", async () => {
    const r = await deployed();
    await certPath("twentyi_paid");
    await onHost(r);
    await expect(requestWpCertificate(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("$34.99 a year");
    await expect(confirmPaidCertificate(h.ctx, r.pm.viewer, r.id)).rejects.toBeInstanceOf(PermissionError);
    // The records passing doesn't buy anything.
    zone = pointedZone(r.ip);
    const before = queued.length;
    await checkRecords(h.ctx, r.pm.viewer, r.id);
    expect(queued.length).toBe(before);
    await confirmPaidCertificate(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(twentyi.orders).toEqual([expect.objectContaining({ domain: "harborpest.com", periodMonths: 12 })]);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", source: "twentyi_paid", paidId: "tls-1", paidPrice: 34.99, confirmedBy: r.admin.viewer.id } });
    const [bought] = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_paid_cert_confirmed"));
    expect(bought!.valueAfter).toMatchObject({ price: 34.99, yearly: true });
    await expect(confirmPaidCertificate(h.ctx, r.admin.viewer, r.id)).rejects.toThrow("already bought");
  });

  it("by hand in My20i: the card says where, and Check HTTPS confirms it", async () => {
    const r = await deployed();
    await onHost(r);
    const before = queued.length;
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    expect(queued.length).toBe(before);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", source: "manual", note: expect.stringContaining("in My20i") } });
    zone = pointedZone(r.ip);
    serving.set("harborpest.com", { issuer: "Sectigo", validTo: "2027-10-01T00:00:00Z" });
    await checkWpHttps(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await gl(r.id)).httpsConfirmedAt).not.toBeNull();
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "ok", issuer: "Sectigo" } });
  });

  it("never confirms the old site's certificate: Check HTTPS waits for the records, and TAWD's own certificate must be the one served (Fable's code review, finding 2)", async () => {
    const r = await deployed();
    await onHost(r);
    // A client replacing a live site: the domain still points at the old host, which serves a valid certificate.
    zone = { "harborpest.com NS": [{ type: 2, data: "ns51.domaincontrol.com." }], "harborpest.com A": [{ type: 1, data: "34.102.136.180" }] };
    serving.set("harborpest.com", { issuer: "Sectigo", validTo: "2027-06-01T00:00:00Z" });
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await checkWpHttps(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await gl(r.id)).httpsConfirmedAt).toBeNull();
    expect((await gl(r.id)).lastError).toContain("Check HTTPS can't confirm yet: harborpest.com doesn't point at the site yet");
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", issuer: null } });
    // Nor does the daily re-check.
    await h.db.update(wpPreview).set({ liveState: "live" }).where(eq(wpPreview.projectId, r.id));
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect((await gl(r.id)).httpsConfirmedAt).toBeNull();
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.https_confirmed"))).toHaveLength(0);

    // TAWD's own certificate: an older one still being served (another end date) doesn't count; the one TAWD installed does.
    await h.db.update(wpPreview).set({ liveState: null, certs: {} }).where(eq(wpPreview.projectId, r.id));
    await certPath("letsencrypt");
    zone = pointedZone(r.ip);
    serving.set("harborpest.com", { issuer: "R10", validTo: "2026-11-20T00:00:00Z" });
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", expiresAt: "2027-01-03T00:00:00.000Z" } });
    expect((await gl(r.id)).lastError).toContain("still serves another certificate (R10, until 2026-11-20), not the one TAWD installed (until 2027-01-03)");
    expect((await gl(r.id)).httpsConfirmedAt).toBeNull();
    serving.set("harborpest.com", { issuer: "R11", validTo: "2027-01-03T00:00:00Z" });
    await checkWpHttps(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await gl(r.id)).httpsConfirmedAt).not.toBeNull();
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "ok", issuer: "R11" } });
  });

  it("never leaves a certificate stuck at 'requested': a stopped job marks it failed, a lost one can be asked for again, and the card says Try again (Fable's code review, finding 3)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    zone = pointedZone(r.ip);
    // The worker restarted before the job finished: the request is still "requested", half an hour on.
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    await h.db.update(wpPreview).set({ certs: { live: { state: "requested", source: "letsencrypt", host: "harborpest.com", issuer: null, issuedAt: null, expiresAt: null, note: null, requestedAt: old } } }).where(eq(wpPreview.projectId, r.id));
    expect(certRetryDue((await loadWpLive(h.db, r.id))!.cert!)).toBe(true);
    const card = renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={{ ...cardProps, certPath: "letsencrypt", cert: { state: "requested", line: "x", note: null, paidId: null, retry: true } }} />);
    expect(card).toContain(">Try again</button>");
    expect(card).not.toContain("refresh in a minute");
    const before = queued.length;
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    expect(queued.length).toBe(before + 1);
    expect(queued.at(-1)!.data).toEqual({ projectId: r.id, action: "cert", target: "live" });
    // A fresh request isn't queued twice.
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    expect(queued.length).toBe(before + 1);

    // The job stops outside its own steps (the worker's catch-all): the certificate says why.
    await markWpPreviewFailed(r.id, "The connection to the database dropped.", { action: "cert", target: "live" });
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "failed", note: "The connection to the database dropped." } });

    // Something throws inside the job (public DNS here): failed with the reason, never left "requested".
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    setCertDnsForTesting(async () => {
      throw new Error("resolver timed out");
    });
    await runWpPreviewJob(lastJob());
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "failed" } });
    expect(((await row(r.id)).certs as { live: WpCert }).live.note).not.toBeNull();
  });

  it("doesn't issue TAWD's certificate again within two hours of installing one, then offers Get the certificate again (findings 8 and 14)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    zone = pointedZone(r.ip);
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(acmeLog).toHaveLength(1);
    // Asked again minutes later: nothing is issued, the card says when it was installed.
    await h.db.update(wpPreview).set({ certs: { live: { ...((await row(r.id)).certs as { live: WpCert }).live, state: "failed" } } }).where(eq(wpPreview.projectId, r.id));
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(acmeLog).toHaveLength(1);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", note: expect.stringContaining("installed this certificate 0 minutes ago") } });
    expect(certRetryDue((await loadWpLive(h.db, r.id))!.cert!)).toBe(false);
    // Three hours on and still not served: Get the certificate again shows, and issues a new one.
    const certs = (await row(r.id)).certs as { live: WpCert };
    await h.db.update(wpPreview).set({ certs: { live: { ...certs.live, installedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } } }).where(eq(wpPreview.projectId, r.id));
    expect(certRetryDue((await loadWpLive(h.db, r.id))!.cert!)).toBe(true);
    expect(renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={{ ...cardProps, certPath: "letsencrypt", cert: { state: "installing", line: "x", note: null, paidId: null, retry: true } }} />)).toContain(">Get the certificate again</button>");
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(acmeLog).toHaveLength(2);
  });

  it("writes one certificate at a time, so the web's request and the worker's write never undo each other (finding 9)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    // The worker read the row before the PM's request landed.
    const stale = new Site(await row(r.id));
    zone = pointedZone(r.ip);
    await requestWpCertificate(h.ctx, r.pm.viewer, r.id);
    await stale.setCert("preview", { state: "ok", source: "manual", host: "x", issuer: "R11", issuedAt: null, expiresAt: null, note: null });
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "requested" }, preview: { state: "ok" } });
    expect(stale.certs().live?.state).toBe("requested");
  });

  it("shows each way on the Go live card, the paid one with its price and a confirm for admins only", () => {
    const wp: WpGoLiveProps = { domain: "harborpest.com", previewHost: "x", onHost: true, onHostLine: null, note: null, liveState: null, liveSteps: [], hasBackup: false, backupLine: null, certPath: "twentyi_paid", cert: null, paidPrice: 34.99, isAdmin: false, ipLine: null, suspended: false };
    const pm = renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={wp} />);
    expect(pm).toContain("$34.99 a year");
    expect(pm).toContain("An admin buys it.");
    expect(pm).not.toContain("Buy 20i");
    expect(renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={{ ...wp, isAdmin: true }} />)).toContain("certificate ($34.99 a year)</button>");
    const le = renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk={false} wp={{ ...wp, certPath: "letsencrypt" }} />);
    expect(le).toContain("Encrypt for harborpest.com and www");
    expect(le).toMatch(/<button[^>]*disabled[^>]*>Get the certificate/);
    // Check HTTPS only once the records point at the site (finding 2).
    expect(le).not.toContain("Check HTTPS</button>");
    expect(renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={{ ...wp, certPath: "manual" }} />)).toContain("Check HTTPS</button>");
    expect(renderToStaticMarkup(<WpCertificateStep projectId="p1" canEdit recordsOk wp={{ ...wp, certPath: "manual" }} />)).toContain("Manage hosting, SSL/TLS");
    const amber = renderToStaticMarkup(<WpLiveSteps wp={{ ...wp, ipLine: "20i moved the site to 203.0.113.99", suspended: true }} />);
    expect(amber).toContain("20i moved the site");
    expect(amber).toContain("suspended at 20i");
  });
});

describe("going live and rolling back, with backups in R2", () => {
  it("stops before changing anything when the client's domain has no working certificate, and asks for one again (Jason, 3 November 2026)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    // The gate saw HTTPS once; by the time Go live runs, the domain doesn't serve a working certificate.
    zone = pointedZone(r.ip);
    await h.db.update(goLive).set({ httpsConfirmedAt: new Date() }).where(eq(goLive.projectId, r.id));
    const preview = (await row(r.id)).host!;
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    const acmeBefore = acmeLog.length;
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    const after = await row(r.id);
    expect(after.liveState).toBe("failed");
    const steps = after.liveSteps as { key: string; state: string; detail: string }[];
    expect(steps.map((s) => `${s.key}:${s.state}`)).toEqual(["https:failed", "backup:waiting", "address:waiting", "search:waiting", "cache:waiting", "check:waiting"]);
    expect(steps[0]!.detail).toContain("Stopped before changing anything: HTTPS isn't ready on harborpest.com yet");
    expect(steps[0]!.detail).toContain(`The site is still on its preview at ${preview}, and search engines are still kept out.`);
    expect(steps[0]!.detail).toContain("TAWD asked for the certificate again");
    // Nothing changed: no backup, no address move, not live; the gate asks for HTTPS again.
    expect(after.backups).toEqual([]);
    expect(server.ran.some((c) => c.includes("search-replace"))).toBe(false);
    expect((await h.db.select().from(projectTable).where(eq(projectTable.id, r.id)))[0]!.status).not.toBe("live");
    expect((await gl(r.id)).httpsConfirmedAt).toBeNull();
    expect((await gl(r.id)).liveUrl).toBeNull();
    // TAWD's own certificate was asked for again, and the stop is in the log.
    expect(acmeLog.length).toBe(acmeBefore + 1);
    const [stopped] = await h.db.select().from(activityLog).where(eq(activityLog.action, "golive.https_not_ready"));
    expect(stopped!.valueAfter).toMatchObject({ domain: "harborpest.com", stillAt: preview });

    // Once the certificate is served, Go live runs through.
    serving.set("harborpest.com", { issuer: "R11", validTo: "2027-01-03T00:00:00Z" });
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    expect((await row(r.id)).liveState).toBe("live");
    expect((await gl(r.id)).httpsConfirmedAt).not.toBeNull();
  });

  it("never asks Let's Encrypt again from Go live when a certificate is in place, paid or TAWD's own, or the records don't point yet (hand review of PR #24)", async () => {
    const r = await deployed();
    await certPath("letsencrypt");
    await onHost(r);
    const acmeBefore = acmeLog.length;
    const tryGoLive = async () => {
      await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
      await runWpPreviewJob({ projectId: r.id, action: "golive" });
      return (await row(r.id)).liveSteps as { key: string; state: string; detail: string }[];
    };
    // The records don't point at the package yet: Let's Encrypt couldn't check, so nothing is asked for.
    let steps = await tryGoLive();
    expect(steps[0]!.state).toBe("failed");
    expect(steps[0]!.detail).not.toContain("TAWD asked for the certificate again");
    expect(acmeLog.length).toBe(acmeBefore);
    zone = pointedZone(r.ip);
    // TAWD's own certificate shows "ok" but the domain doesn't answer (a blip): left to Check HTTPS, never issued again.
    const ok: WpCert = { state: "ok", source: "letsencrypt", host: "harborpest.com", issuer: "R11", issuedAt: null, expiresAt: "2027-01-03T00:00:00.000Z", note: null, warned: [] };
    await h.db.update(wpPreview).set({ certs: { live: ok } }).where(eq(wpPreview.projectId, r.id));
    steps = await tryGoLive();
    expect(steps[0]!.state).toBe("failed");
    expect(acmeLog.length).toBe(acmeBefore);
    // A paid certificate's record is never replaced by Let's Encrypt's.
    const paid: WpCert = { ...ok, state: "failed", source: "twentyi_paid", paidId: "ord-1" };
    await h.db.update(wpPreview).set({ certs: { live: paid } }).where(eq(wpPreview.projectId, r.id));
    steps = await tryGoLive();
    expect(acmeLog.length).toBe(acmeBefore);
    expect((await row(r.id)).certs).toMatchObject({ live: { source: "twentyi_paid", paidId: "ord-1" } });
  });

  it("checks HTTPS first, backs up to R2 (streamed), moves the site to its domain, clears 20i's cache; Roll back streams the backup back", async () => {
    const r = await deployed();
    await onHost(r);
    httpsReady(r);
    const staging = (await row(r.id)).host!;
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    const live = await row(r.id);
    expect(live).toMatchObject({ liveState: "live", liveDomain: "harborpest.com", liveFormId: 12 });
    expect((live.liveSteps as { key: string; state: string }[]).map((s) => `${s.key}:${s.state}`)).toEqual(["https:done", "backup:done", "address:done", "search:done", "cache:done", "check:done"]);
    expect((live.liveSteps as { detail: string }[])[0]!.detail).toBe("https://harborpest.com serves an active certificate from R11, valid until 2027-01-03.");
    const [backup] = live.backups as { kind: string; sqlKey: string; filesKey: string; bytes: number }[];
    expect(backup).toMatchObject({ kind: "golive", sqlKey: expect.stringMatching(/\/wp-backups\/\d{8}-\d{6}\/db\.sql\.gz$/), filesKey: expect.stringContaining("/files.tgz") });
    expect(backup!.sqlKey.startsWith(`projects/${r.id.toLowerCase()}/`)).toBe(true);
    expect(r2.objects.get(backup!.sqlKey)!.subarray(0, 4).toString()).toBe("SQL:");
    expect(r2.objects.get(backup!.filesKey)!.subarray(0, 4).toString()).toBe("TAR:");
    expect(backup!.bytes).toBeGreaterThan(200_000);
    // Streamed in parts by the same multipart code R2 runs, each upload completed.
    expect(r2.uploads.map((u) => [u.key, u.parts > 1, u.completed, u.aborted])).toEqual([
      [backup!.sqlKey, true, true, false],
      [backup!.filesKey, true, true, false],
    ]);
    expect(server.ran).toContain(`set -o pipefail; wp db export - --path="$HOME"/'public_html' | gzip -c`);
    expect(server.ran).toContain(`tar czf - -C "$HOME"/'public_html' .`);
    expect(server.ran).toContain(`wp search-replace 'https://${staging}' 'https://harborpest.com' --all-tables --skip-columns=guid --precise --path="$HOME"/'public_html' 2>&1`);
    expect(twentyi.packages.get(live.packageId!)!.purged).toBeGreaterThan(0);
    expect((await h.db.select().from(projectTable).where(eq(projectTable.id, r.id)))[0]!.status).toBe("live");

    // A later deploy backs the live site up first.
    await startWpPreview(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(((await row(r.id)).backups as { kind: string }[]).map((b) => b.kind)).toEqual(["update", "golive"]);

    // Roll back: the files then the database, streamed from R2 into the package.
    await wpRollback(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await row(r.id)).liveState).toBe("live");
    expect(server.restored.map((x) => x.command)).toEqual([
      `cd "$HOME" && rm -rf 'public_html.restoring' 'public_html.old' && mkdir 'public_html.restoring' && tar xzf - -C 'public_html.restoring' && mv 'public_html' 'public_html.old' && mv 'public_html.restoring' 'public_html' && rm -rf 'public_html.old'`,
      `set -o pipefail; gunzip -c | wp db import - --path="$HOME"/'public_html'`,
    ]);
    expect(server.restored.every((x) => x.bytes > 100_000)).toBe(true);
    // The site as it was is backed up first (finding 10); the restored backup is used up, its R2 files removed too.
    let kept = (await row(r.id)).backups as { kind: string; stamp: string; sqlKey: string }[];
    expect(kept.map((b) => b.kind)).toEqual(["rollback", "golive"]);
    expect([...r2.objects.keys()].filter((k) => k.includes("/wp-backups/"))).toHaveLength(4);
    expect((await row(r.id)).liveSteps).toMatchObject([{ key: "backup", state: "done" }, { key: "restore", state: "done" }]);
    // Roll back again skips its own backup: back to before go-live.
    await wpRollback(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect((await row(r.id)).liveState).toBe("rolled_back");
    expect((await h.db.select().from(projectTable).where(eq(projectTable.id, r.id)))[0]!.status).toBe("build");
    await expect(wpRollback(h.ctx, r.admin.viewer, r.id)).rejects.toThrow("no backup");

    // A wrong click: Undo the roll back puts the live site back, on its domain, the project Live again.
    kept = (await row(r.id)).backups as { kind: string; stamp: string; sqlKey: string }[];
    expect(kept.map((b) => b.kind)).toEqual(["rollback", "rollback"]);
    expect((await loadWpLive(h.db, r.id))!.undoTo!.stamp).toBe(kept[0]!.stamp);
    await expect(wpUndoRollback(h.ctx, r.pm.viewer, r.id)).rejects.toBeInstanceOf(PermissionError);
    await wpUndoRollback(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(await row(r.id)).toMatchObject({ liveState: "live", liveDomain: "harborpest.com" });
    expect((await gl(r.id)).liveUrl).toBe("https://harborpest.com/");
    expect((await h.db.select().from(projectTable).where(eq(projectTable.id, r.id)))[0]!.status).toBe("live");
    expect(((await row(r.id)).backups as { stamp: string }[]).map((b) => b.stamp)).toEqual([kept[1]!.stamp]);
    expect(r2.objects.has(kept[0]!.sqlKey)).toBe(false);
  });

  /*
    Audit F-051 (12 November 2026): a worker stopped mid-restore leaves the
    site half restored and the job is delivered again. The second delivery
    used to back up that half-restored site first, so Undo the roll back
    would have restored a broken site. It keeps the first delivery's backup.
  */
  it("a Roll back delivered again after the worker stopped mid-restore keeps the first backup and finishes the restore", async () => {
    const r = await deployed();
    await onHost(r);
    httpsReady(r);
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    await startWpPreview(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());

    await wpRollback(h.ctx, r.admin.viewer, r.id);
    // The first delivery: its backup taken, then the worker stopped during the restore.
    const before = await row(r.id);
    const firstBackup = { kind: "rollback", stamp: "20261112-090000", at: "2026-11-12T09:00:00.000Z", sqlKey: `projects/${r.id}/wp-backups/20261112-090000/db.sql.gz`, filesKey: `projects/${r.id}/wp-backups/20261112-090000/files.tgz`, bytes: 1, version: 1 };
    await h.db
      .update(wpPreview)
      .set({
        backups: [firstBackup, ...((before.backups as object[]) ?? [])],
        liveSteps: [
          { key: "backup", label: "Back up the live site", state: "done", detail: "Saved in TAWD's storage (0.1 MB). Undo the roll back restores it." },
          { key: "restore", label: "Restore the backup", state: "working", detail: null },
        ],
      })
      .where(eq(wpPreview.projectId, r.id));
    const exportsBefore = server.ran.filter((c) => c.includes("wp db export")).length;

    // The same job, delivered again.
    await runWpPreviewJob(lastJob());
    const after = await row(r.id);
    expect(after.liveState).toBe("live");
    expect(server.ran.filter((c) => c.includes("wp db export")).length).toBe(exportsBefore);
    expect((after.backups as { kind: string; stamp: string }[]).filter((b) => b.kind === "rollback").map((b) => b.stamp)).toEqual([firstBackup.stamp]);
    expect((after.liveSteps as { key: string; state: string; detail: string }[])[0]).toMatchObject({ key: "backup", state: "done" });
    expect((after.liveSteps as { detail: string }[])[0]!.detail).toContain("not taken again");
  });

  it("stops at the backup when R2 refuses the upload after the dump finished, or the dump is empty: no backup recorded, nothing moved (Fable's code review, finding 1)", async () => {
    const r = await deployed();
    await onHost(r);
    httpsReady(r);
    r2.refusePart = 2;
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    let after = await row(r.id);
    expect(after.liveState).toBe("failed");
    expect((after.liveSteps as { key: string; state: string }[]).map((s) => `${s.key}:${s.state}`)).toEqual(["https:done", "backup:failed", "address:waiting", "search:waiting", "cache:waiting", "check:waiting"]);
    expect((after.liveSteps as { detail: string }[])[1]!.detail).toContain("R2 refused the upload");
    expect(after.backups).toEqual([]);
    expect(r2.uploads[0]).toMatchObject({ aborted: true, completed: false });
    expect([...r2.objects.keys()].some((k) => k.includes("wp-backups"))).toBe(false);
    expect(server.ran.some((c) => c.includes("search-replace"))).toBe(false);
    expect((await h.db.select().from(projectTable).where(eq(projectTable.id, r.id)))[0]!.status).not.toBe("live");

    r2.refusePart = null;
    server.emptyDump = true;
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    after = await row(r.id);
    expect(after.liveState).toBe("failed");
    expect((after.liveSteps as { detail: string }[])[1]!.detail).toMatch(/it was empty \(\d+ bytes compressed\)/);
    expect(after.backups).toEqual([]);
    expect(server.ran.some((c) => c.includes("search-replace"))).toBe(false);
  });

  it("says R2's own answer, with Try again, when a backup can't be read: never 'gone' unless it is (Fable's code review, finding 16)", async () => {
    const r = await deployed();
    await onHost(r);
    httpsReady(r);
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    r2.refuseRead = new Error("503 SlowDown");
    await wpRollback(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    const steps = (await row(r.id)).liveSteps as { key: string; state: string; detail: string }[];
    expect(steps.find((s) => s.key === "restore")).toMatchObject({ state: "failed", detail: "The backup's files couldn't be read from TAWD's storage (R2 answered: 503 SlowDown). Try again." });
    // R2 really has nothing: then it says so.
    r2.refuseRead = null;
    const golive = rollbackTarget((await row(r.id)).backups as never)!;
    r2.objects.delete(golive.filesKey!);
    await wpRollback(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(((await row(r.id)).liveSteps as { key: string; detail: string }[]).find((s) => s.key === "restore")!.detail).toBe("The backup's files are gone from TAWD's storage.");
    // And core's R2 reader only calls a 404 "missing".
    expect(isMissingObject({ name: "NoSuchKey" })).toBe(true);
    expect(isMissingObject({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isMissingObject({ name: "InternalError", $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isMissingObject(new Error("socket hang up"))).toBe(false);
  });

  it("keeps the newest ten backups (older ones deleted from R2) and refuses a Bluehost-era backup plainly", async () => {
    const r = await deployed();
    await onHost(r);
    const prefix = `projects/${r.id.toLowerCase()}/wp-backups`;
    const old = Array.from({ length: BACKUPS_KEPT }, (_, i) => {
      const stamp = `202610${String(i + 1).padStart(2, "0")}-120000`;
      return { at: `2026-10-${String(i + 1).padStart(2, "0")}T12:00:00Z`, kind: "update", version: 1, stamp, sqlKey: `${prefix}/${stamp}/db.sql.gz`, filesKey: `${prefix}/${stamp}/files.tgz` };
    }).reverse();
    for (const b of old) {
      await r2.put(b.sqlKey, Buffer.from("x"));
      await r2.put(b.filesKey, Buffer.from("x"));
    }
    await h.db.update(wpPreview).set({ liveState: "live", liveDomain: "harborpest.com", backups: old }).where(eq(wpPreview.projectId, r.id));
    await startWpPreview(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    const kept = (await row(r.id)).backups as { stamp: string }[];
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.some((b) => b.stamp === "20261001-120000")).toBe(false);
    expect(r2.objects.has(`${prefix}/20261001-120000/db.sql.gz`)).toBe(false);

    await h.db.update(wpPreview).set({ backups: [{ at: "2026-10-01T00:00:00Z", kind: "golive", version: 1, stamp: "20261001-000000" }] }).where(eq(wpPreview.projectId, r.id));
    await expect(wpRollback(h.ctx, r.admin.viewer, r.id)).rejects.toThrow("made on Bluehost");
  });
});

describe("VML-run DNS for a WordPress site (newly possible on 20i)", () => {
  it("can be chosen, writes both names at the package's IP (never proxied), and the gate wants the nameserver steps", async () => {
    const r = await deployed();
    await h.db.update(goLive).set({ connectFound: { snapshot: {}, host: null, email: null, advice: { path: "records", why: "" }, at: "" } as never }).where(eq(goLive.projectId, r.id));
    await choosePath(h.ctx, r.pm.viewer, r.id, "vml_dns");
    expect((await gl(r.id)).connectPath).toBe("vml_dns");

    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
    const posted: { type: string; name: string; content: string; proxied?: boolean }[] = [];
    setGoLiveFetchForTesting((async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.cloudflare.com/client/v4", "");
      if (path.startsWith("/zones?")) return Response.json({ success: true, result: [{ id: "z1", name_servers: ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"] }] });
      if (path.endsWith("/dns_records") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ success: true, result: {} });
      }
      return Response.json({ success: true, result: [] });
    }) as typeof fetch);
    await h.db.update(goLive).set({ emailReadAt: new Date(), emailRecords: [{ type: "MX", name: "harborpest.com", content: "aspmx.l.google.com", priority: 1 }] }).where(eq(goLive.projectId, r.id));
    await setUpCloudflare(h.ctx, r.pm.viewer, r.id);
    expect(posted.filter((p) => p.type === "A")).toEqual([
      expect.objectContaining({ type: "A", name: "harborpest.com", content: r.ip, proxied: false }),
      expect.objectContaining({ type: "A", name: "www.harborpest.com", content: r.ip, proxied: false }),
    ]);

    const steps = { domainConfirmed: true, emailVerified: false, emailConfirmed: false, netlifyDomain: false, nameserversSwitched: false, httpsConfirmed: true, ga4Recorded: true };
    const gate = { buildFeePaid: true, checklist: [], founderFlags: [], hasBuild: true, wordpress: true, path: "vml_dns" as const, wordpressSteps: { previewCurrent: true, latestBuild: 1, onHost: true } };
    expect(goLiveGate({ ...gate, steps }).blockers).toEqual([
      "The client's email records haven't been checked on Cloudflare.",
      "The PM hasn't confirmed the email records with the client's email provider.",
      "The domain's nameservers haven't been switched to Cloudflare yet.",
    ]);
    expect(goLiveGate({ ...gate, steps: { ...steps, emailVerified: true, emailConfirmed: true, nameserversSwitched: true } }).ready).toBe(true);
    expect(goLiveGate({ ...gate, path: "records", steps: { ...steps, recordsOk: true }, wordpressSteps: { previewCurrent: true, latestBuild: 1, onHost: false } }).blockers).toEqual([
      "The domain isn't on the site's 20i package yet (Put the domain on 20i).",
    ]);
  });
});

describe("Suspend, Restore and Purge the cache", () => {
  it("are admin-only for Suspend and Restore, run at 20i by the worker, logged, and a suspended site can't be deployed", async () => {
    const r = await deployed();
    await expect(setWpSuspended(h.ctx, r.pm.viewer, r.id, true)).rejects.toBeInstanceOf(PermissionError);
    // 20i refuses first: the card says so (finding 15), and the click shows at once while it's with 20i.
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    twentyi.refuse.setPackageEnabled = new TwentyiError("20i said no (402): balance", "refused", 402);
    await setWpSuspended(h.ctx, r.admin.viewer, r.id, true);
    expect((await loadWpPreview(h.db, r.id))!.suspendJob).toEqual({ pending: "suspend" });
    await expect(setWpSuspended(h.ctx, r.admin.viewer, r.id, true)).rejects.toThrow("already asking 20i to suspend");
    expect(renderToStaticMarkup(<WpPreviewSection {...sectionProps} suspendPending="suspend" />)).toContain("Asking 20i to suspend the site");
    expect(renderToStaticMarkup(<WpPreviewSection {...sectionProps} suspendPending="suspend" />)).not.toContain("Suspend the site</button>");
    await runWpPreviewJob(lastJob());
    expect((await loadWpPreview(h.db, r.id))!.suspendJob).toMatchObject({ refused: "suspend", reason: "20i said no (402): balance" });
    expect(renderToStaticMarkup(<WpPreviewSection {...sectionProps} suspendRefused="20i didn't suspend the site: balance" />)).toContain("20i didn&#x27;t suspend the site");
    delete twentyi.refuse.setPackageEnabled;

    await setWpSuspended(h.ctx, r.admin.viewer, r.id, true);
    expect(queued.at(-1)!.data).toEqual({ projectId: r.id, action: "suspend", by: r.admin.viewer.id });
    await runWpPreviewJob(lastJob());
    expect((await loadWpPreview(h.db, r.id))!.suspendJob).toBeNull();
    const packageId = (await row(r.id)).packageId!;
    expect(twentyi.packages.get(packageId)!.enabled).toBe(false);
    expect((await row(r.id)).suspendedAt).not.toBeNull();
    await expect(startWpPreview(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("suspended at 20i");
    await expect(setWpSuspended(h.ctx, r.admin.viewer, r.id, true)).rejects.toThrow("already suspended");
    await setWpSuspended(h.ctx, r.admin.viewer, r.id, false);
    await runWpPreviewJob(lastJob());
    expect(twentyi.packages.get(packageId)!.enabled).toBe(true);
    expect((await row(r.id)).suspendedAt).toBeNull();
    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, r.id));
    expect(log.filter((l) => l.action === "site.wp_suspended" || l.action === "site.wp_restored").map((l) => [l.action, (l.valueAfter as { ok: boolean }).ok, (l.valueAfter as { requestedBy: string }).requestedBy])).toEqual([
      ["site.wp_suspended", false, r.admin.viewer.id],
      ["site.wp_suspended", true, r.admin.viewer.id],
      ["site.wp_restored", true, r.admin.viewer.id],
    ]);

    const purgedBefore = twentyi.packages.get(packageId)!.purged;
    await purgeWpCache(h.ctx, r.pm.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(twentyi.packages.get(packageId)!.purged).toBe(purgedBefore + 1);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_cache_purged"))).toHaveLength(1);
  });

  it("and an admin can take a live site down, which a PM can't", async () => {
    const r = await deployed();
    await h.db.update(wpPreview).set({ liveState: "live", liveDomain: "harborpest.com", liveAt: new Date() }).where(eq(wpPreview.projectId, r.id));
    await h.db.update(goLive).set({ liveUrl: "https://harborpest.com/", liveVersion: 1, wentLiveAt: new Date(), httpsConfirmedAt: new Date() }).where(eq(goLive.projectId, r.id));
    await h.db.update(projectTable).set({ status: "live", liveAt: new Date() }).where(eq(projectTable.id, r.id));
    const { removeWpPreview } = await import("@/lib/wp-preview");
    await expect(removeWpPreview(h.ctx, r.pm.viewer, r.id)).rejects.toThrow("only an admin can take it down");
    await removeWpPreview(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    expect(await row(r.id)).toMatchObject({ state: "removed", liveState: null, packageId: null, liveDomain: null, liveAt: null });
    // The project leaves Live (findings 7 and 23) and nothing offers the dead domain. It has gone live, so it is never deleted (Jason, 13 October 2026).
    const [proj] = await h.db.select().from(projectTable).where(eq(projectTable.id, r.id));
    expect(proj!.status).toBe("paused");
    expect(deleteBlocker(proj!.status, proj!.liveAt)).toContain("has gone live");
    expect(await gl(r.id)).toMatchObject({ liveUrl: null, liveVersion: null, httpsConfirmedAt: null });
    const changed = (await h.db.select().from(activityLog).where(eq(activityLog.action, "project.status_changed"))).at(-1);
    expect(changed!.valueAfter).toMatchObject({ status: "paused", reason: expect.stringContaining("harborpest.com was taken down") });
    await expect(showWpLogin(h.ctx, r.admin.viewer, r.id)).rejects.toThrow("no WordPress preview");
  });
});

describe("the daily work: IP watch, renewals, warnings", () => {
  async function liveSite(path: "records" | "vml_dns" = "records") {
    const r = await deployed();
    await onHost(r);
    await h.db.update(wpPreview).set({ liveState: "live", liveDomain: "harborpest.com" }).where(eq(wpPreview.projectId, r.id));
    await h.db.update(goLive).set({ connectPath: path, cloudflareZoneId: path === "vml_dns" ? "harborpest.com" : null, wentLiveAt: new Date() }).where(eq(goLive.projectId, r.id));
    zone = pointedZone(r.ip);
    return r;
  }

  it("notices when 20i moves a site, saves the new IP, tells the PM once a day, and the card shows it", async () => {
    const r = await liveSite();
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect((await row(r.id)).ipNote).toMatchObject({ ok: true, apiIp: r.ip });

    twentyi.moveIp((await row(r.id)).packageId!, "203.0.113.99");
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    const moved = await row(r.id);
    expect(moved.packageIpv4).toBe("203.0.113.99");
    const alertedAt = (moved.ipNote as { alertedAt: string }).alertedAt;
    expect(moved.ipNote).toMatchObject({ ok: false, apiIp: "203.0.113.99", apex: [r.ip] });
    expect(alertedAt).toBeTruthy();
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_ip_changed"))).toHaveLength(1);
    // Again the same day: no second alert.
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(((await row(r.id)).ipNote as { alertedAt: string }).alertedAt).toBe(alertedAt);
    // A day public DNS doesn't answer keeps the last alert's time, so the next answer can't alert twice (finding 19).
    setDailyDnsForTesting(async () => {
      throw new Error("resolver down");
    });
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(((await row(r.id)).ipNote as { alertedAt: string }).alertedAt).toBe(alertedAt);
    setDailyDnsForTesting(dohStandIn(() => zone));
    expect((await loadWpLive(h.db, r.id))!.ipProblem).toEqual({ apiIp: "203.0.113.99", apex: [r.ip], fixedAt: null });
    const [stamp] = await h.db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING));
    expect(stamp!.value).toMatchObject({ finishedAt: expect.any(String), summary: { sites: 1 } });
  });

  it("fixes the records itself when VML runs the client's DNS", async () => {
    const r = await liveSite("vml_dns");
    twentyi.moveIp((await row(r.id)).packageId!, "203.0.113.77");
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(cloudflare.zones.get("harborpest.com")!.get("harborpest.com")).toBe("203.0.113.77");
    expect(cloudflare.zones.get("harborpest.com")!.get("www.harborpest.com")).toBe("203.0.113.77");
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_ip_fixed"))).toHaveLength(1);
  });

  it("renews TAWD's own certificate with a third of its life left, and warns at 14 and 7 days for any kind", async () => {
    const r = await liveSite();
    await certPath("letsencrypt");
    const day = 86_400_000;
    const due: WpCert = { state: "ok", source: "letsencrypt", host: "harborpest.com", issuer: "R11", issuedAt: new Date(Date.now() - 70 * day).toISOString(), expiresAt: new Date(Date.now() + 20 * day).toISOString(), note: null, warned: [] };
    expect(renewalDue(due)).toBe(true);
    expect(renewalDue({ ...due, issuedAt: new Date(Date.now() - 10 * day).toISOString(), expiresAt: new Date(Date.now() + 80 * day).toISOString() })).toBe(false);
    expect(renewalDue({ ...due, source: "manual" })).toBe(false);
    await h.db.update(wpPreview).set({ certs: { live: due } }).where(eq(wpPreview.projectId, r.id));
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(acmeLog.map((a) => a.names)).toEqual([["harborpest.com", "www.harborpest.com"]]);
    expect((await row(r.id)).certs).toMatchObject({ live: { state: "installing", expiresAt: "2027-01-03T00:00:00.000Z" } });
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_cert_renewed"))).toHaveLength(1);

    const handmade: WpCert = { state: "ok", source: "manual", host: "harborpest.com", issuer: "Sectigo", issuedAt: null, expiresAt: new Date(Date.now() + 6 * day).toISOString(), note: null, warned: [] };
    expect(expiryWarningDue(handmade)).toBe(7);
    expect(expiryWarningDue({ ...handmade, expiresAt: new Date(Date.now() + 12 * day).toISOString() })).toBe(14);
    expect(expiryWarningDue({ ...handmade, warned: [7] })).toBeNull();
    await h.db.update(wpPreview).set({ certs: { live: handmade } }).where(eq(wpPreview.projectId, r.id));
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect((await row(r.id)).certs).toMatchObject({ live: { warned: [7] } });
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect((await row(r.id)).certs).toMatchObject({ live: { warned: [7] } });
  });

  it("after Replace the key, says the package needs Deploy again instead of 'refused', and the daily work holds renewals and lists the site (finding 13)", async () => {
    const r = await liveSite();
    await certPath("letsencrypt");
    // An admin replaces TAWD's 20i key; the package still has the old one, so the gateway refuses the new one.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await makeTwentyiKey(h.ctx, r.admin.viewer, true);
    server.refuseKey = true;
    httpsReady(r);
    await h.db.update(wpPreview).set({ liveState: "going_live" }).where(eq(wpPreview.projectId, r.id));
    await runWpPreviewJob({ projectId: r.id, action: "golive" });
    expect(((await row(r.id)).liveSteps as { key: string; detail: string }[]).find((s) => s.key === "backup")!.detail).toMatch(/TAWD's 20i key was replaced on \d{4}-\d{2}-\d{2}, after this site's last deploy: Deploy again \(Hosting\) adds the new key/);

    const day = 86_400_000;
    const due: WpCert = { state: "ok", source: "letsencrypt", host: "harborpest.com", issuer: "R11", issuedAt: new Date(Date.now() - 70 * day).toISOString(), expiresAt: new Date(Date.now() + 20 * day).toISOString(), note: null, warned: [] };
    await h.db.update(wpPreview).set({ liveState: "live", certs: { live: due } }).where(eq(wpPreview.projectId, r.id));
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(acmeLog).toEqual([]);
    const [stamp] = await h.db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING));
    expect((stamp!.value as { summary: { problems: string[] } }).summary.problems).toEqual([expect.stringContaining("harborpest.com: TAWD's 20i key was replaced after its last deploy; Deploy again adds it")]);

    // Deploy again adds the new key: the renewal goes ahead.
    server.refuseKey = false;
    await startWpPreview(h.ctx, r.admin.viewer, r.id);
    await runWpPreviewJob(lastJob());
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(acmeLog).toHaveLength(1);
  });

  it("skips a suspended site", async () => {
    const r = await liveSite();
    await h.db.update(wpPreview).set({ suspendedAt: new Date() }).where(eq(wpPreview.projectId, r.id));
    twentyi.calls = [];
    await runWpSitesDailyJob({ at: new Date().toISOString() });
    expect(twentyi.calls).toEqual([]);
  });

  it("is queued by the web's hourly tick at most once every 20 hours (a 24-hour timer would never fire across deploys)", async () => {
    const now = new Date("2026-10-06T08:00:00Z");
    expect(await wpSitesTick(h.db, now)).toBe(true);
    expect(queued.map((q) => q.name)).toEqual([WP_SITES_DAILY_JOB]);
    expect(await wpSitesTick(h.db, new Date(now.getTime() + 3_600_000))).toBe(false);
    expect(await wpSitesTick(h.db, new Date(now.getTime() + 21 * 3_600_000))).toBe(true);
    expect(queued).toHaveLength(2);
  });

  it("costs an hour, not a day, when the queue doesn't answer; keeps the worker's finish; re-queues a run that never finished (Fable's code review, finding 6)", async () => {
    const now = new Date("2026-10-06T08:00:00Z");
    setQueueForTesting({ add: async () => { throw new Error("Redis isn't answering"); }, getJob: async () => null });
    expect(await wpSitesTick(h.db, now)).toBe(false);
    expect(await h.db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING))).toEqual([]);
    setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async () => null });
    // The next hourly tick queues it.
    expect(await wpSitesTick(h.db, new Date(now.getTime() + 3_600_000))).toBe(true);
    expect(queued.map((q) => q.name)).toEqual([WP_SITES_DAILY_JOB]);

    // The stamp sets startedAt only: a finish the worker already wrote stays.
    await h.db.update(appSetting).set({ value: { startedAt: "2026-10-06T09:00:00.000Z", finishedAt: "2026-10-06T09:00:05.000Z", summary: { sites: 3 } } }).where(eq(appSetting.key, WP_SITES_DAILY_SETTING));
    expect(await wpSitesTick(h.db, new Date(now.getTime() + 22 * 3_600_000))).toBe(true);
    const [stamp] = await h.db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING));
    expect(stamp!.value).toMatchObject({ startedAt: "2026-10-07T06:00:00.000Z", finishedAt: "2026-10-06T09:00:05.000Z", summary: { sites: 3 } });

    // That run never finishes: three hours on, System says so and the tick starts it again.
    const later = new Date(now.getTime() + 25 * 3_600_000);
    const { loadDailyRun } = await import("@/lib/twentyi");
    expect(await loadDailyRun(h.db, later)).toMatchObject({ unfinished: true, late: true });
    expect(await wpSitesTick(h.db, later)).toBe(true);
    expect(queued).toHaveLength(3);
  });

  it("looks a few minutes after the web server starts, not only an hour later", async () => {
    const { scheduleWpSitesDaily, FIRST_TICK_MS } = await import("@/lib/wp-sites-daily");
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      scheduleWpSitesDaily(h.db);
      const first = timeouts.mock.calls.find((c) => c[1] === FIRST_TICK_MS);
      expect(FIRST_TICK_MS).toBeLessThanOrEqual(5 * 60_000);
      expect(intervals.mock.calls.some((c) => c[1] === 60 * 60_000)).toBe(true);
      // When it fires, the work is queued (nothing has run yet).
      (first![0] as () => void)();
      await vi.waitFor(() => expect(queued.map((q) => q.name)).toEqual([WP_SITES_DAILY_JOB]));
    } finally {
      for (const call of intervals.mock.results) clearInterval(call.value as NodeJS.Timeout);
      for (const call of timeouts.mock.results) clearTimeout(call.value as NodeJS.Timeout);
      timeouts.mockRestore();
      intervals.mockRestore();
    }
  });
});
