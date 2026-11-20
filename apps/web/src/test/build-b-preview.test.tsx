import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build B on 20i (5 October 2026; was Bluehost, B2 1 October 2026): the
  WordPress preview in its own 20i package. 20i is the in-memory reseller
  (worker twentyi-fake.ts), the package's SSH side and Let's Encrypt are
  stand-ins (wp-20i-fakes.ts), so a deploy, a deploy again, a failure, the
  preview domain (D1 option B) and a removal are each checked call by call
  and command by command. Nothing here reaches 20i, Cloudflare or Let's
  Encrypt.
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
import { activityLog, appSetting, hostingAccountCheck, previewDecision, project as projectTable, serviceHeartbeat, siteBuild, sshKey, wpPreview } from "@tawd/core/schema";
import { recordPreviewDecision } from "@/lib/netlify";
import { PreviewCard } from "@/components/build/preview-cards";
import { PermissionError } from "@tawd/core/permissions";
import { WP_PREVIEW_JOB } from "@tawd/core/queue";
import { decryptSecret, setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { FakeCloudflareDns, setCloudflareDnsForTesting } from "@tawd/core/cloudflare-dns";
import { SSH_HOST_KEYS_SETTING } from "@tawd/core/ssh-keys";
import { TWENTYI_KEY_PURPOSE, TWENTYI_PACKAGE_TYPE_SETTING, WP_CERT_PATH_SETTING, WP_CORE_VERSION, WP_PLUGINS, databaseNameFor, isWebRoot, onPreviewDomain, packageDomainFrom, phpProbe, pickPhp, previewHostFor, previewName, shq } from "@tawd/core/wp-preview";
import { setQueueForTesting } from "@/lib/mockups";
import { leftovers, looksLikeWordPress, MOVE_CERT_TRIES, MOVE_CHECK_EVERY_MS, MOVE_CHECK_EXTRA_TRIES, MOVE_CHECK_TRIES, moveTarget, keepsLegacyPackage, needsFreshPackage, packageOnPreviewName, parseDbSearch, PREVIEW_HOLDER_LABEL, PREVIEW_HOLDER_SETTING, type PreviewHolderState } from "@tawd/core/wp-preview";
import { createProject } from "@/lib/projects";
import { HostingError, loadHosting, setFormPlugin, setHosting } from "@/lib/hosting";
import { confirmPackageLimit, loadWpPreview, removeWpPreview, showWpLogin, startWpPreview, WpPreviewError } from "@/lib/wp-preview";
import { deleteProject, ProjectDeleteError } from "@/lib/project-deletion";
import { makeTwentyiKey } from "@/lib/twentyi";
import { WpPreviewSection } from "@/components/build/wp-preview-section";
import { HostingCard } from "@/components/build/hosting-card";

import { runHolderWatch } from "../../../worker/src/holder-watch";
import { recoverPreviewHolder, runWpPreviewJob, setHomeFetchForTesting, setWpLater, SSH_NOT_READY } from "../../../worker/src/wp-preview";
import { runTwentyiCheckJob } from "../../../worker/src/twentyi-check";
import { setSshForTesting } from "../../../worker/src/ssh";
import { setTwentyiForTesting, stagingHostFor } from "../../../worker/src/twentyi";
import { FakeTwentyi } from "../../../worker/src/twentyi-fake";
import { setAcmeForTesting, setTlsProbeForTesting } from "../../../worker/src/wp-cert";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";
import { FAKE_PRIVATE_KEY, fakeAcme, newServer, sshStandIn, tlsStandIn, type PackageServer } from "./wp-20i-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: { projectId: string; action: never; target?: "preview" | "live" } }[];
let server: PackageServer;
let twentyi: FakeTwentyi;
let cloudflare: FakeCloudflareDns;
let serving: Map<string, { issuer: string; validTo: string }>;
let acmeLog: { names: string[]; staging: boolean; tokens: string[] }[];
let targets: { host: string; username: string; expectedHostKey: string | null }[];

const page = (title: string, main: string) =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="Pest control in Sacramento, family run."><link rel="stylesheet" href="/site.css"></head><body><header><a href="#main">Skip</a></header><main id="main">${main}</main><footer><p>Website by Velocity Media Lab</p></footer></body></html>`;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
  server = newServer();
  targets = [];
  setSshForTesting(sshStandIn(server, targets));
  twentyi = new FakeTwentyi();
  setTwentyiForTesting(twentyi);
  cloudflare = new FakeCloudflareDns(["vmlpreview.com"]);
  setCloudflareDnsForTesting(cloudflare);
  serving = new Map();
  setTlsProbeForTesting(tlsStandIn(serving));
  acmeLog = [];
  setAcmeForTesting(fakeAcme(acmeLog));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setSshForTesting(null);
  setTwentyiForTesting(null);
  setCloudflareDnsForTesting(null);
  setTlsProbeForTesting(null);
  setAcmeForTesting(null);
  setQueueForTesting(null);
  setStorageForTesting(null);
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const base = { trade: "pest_control" as const, lane: "lane_1" as const, laneOption: null, conceptCount: 1, status: "build" as const, memberUserIds: [] as string[], tier: "pro" as const };

/* A WordPress project with a finished build, and 20i set up on System (TAWD's key, a passed check, a package type). */
async function ready(clientName = "Harbor Pest", packages = 3) {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
  const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
  const id = await createProject(h.ctx, admin.viewer, { ...base, clientName });
  await setHosting(h.ctx, admin.viewer, id, "wordpress");
  // The package is named after the client's domain (8 October 2026).
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainName: `${clientName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com` });
  await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [] } as never);
  const prefix = `projects/${id}/site/v1/`;
  await r2.put(`${prefix}index.html`, Buffer.from(page("Harbor Pest | Sacramento", "<h1>Harbor Pest</h1>")));
  await r2.put(`${prefix}contact/index.html`, Buffer.from(page("Contact | Harbor Pest", '<h1>Contact</h1><form name="contact"><label for="n">Name</label><input id="n" name="name" required><button type="submit">Send</button></form>')));
  await r2.put(`${prefix}thank-you/index.html`, Buffer.from(page("Thanks | Harbor Pest", "<h1>Thanks</h1>")));
  await r2.put(`${prefix}site.css`, Buffer.from("h1{color:#123456}"));
  await r2.put(`${prefix}_shots/home.jpg`, Buffer.from("x"));
  await makeTwentyiKey(h.ctx, admin.viewer, false);
  await h.db.insert(hostingAccountCheck).values({ status: "done", results: { items: [], keyWorks: true, packages, types: [{ id: "tawd-wp", label: "TAWD WordPress" }] } });
  await h.db.insert(appSetting).values({ key: TWENTYI_PACKAGE_TYPE_SETTING, value: { id: "tawd-wp", label: "TAWD WordPress" } });
  await h.db.insert(serviceHeartbeat).values({ service: "worker", version: "0.88.0", startedAt: new Date(), env: { TWENTYI_API_KEY: true, WP_PREVIEW_DOMAIN: true, CLOUDFLARE_API_TOKEN: true, CLOUDFLARE_ACCOUNT_ID: true } });
  return { admin, pm, content, id };
}

const row = async (id: string) => (await h.db.select().from(wpPreview).where(eq(wpPreview.projectId, id)))[0]!;
const states = (steps: unknown) => (steps as { key: string; state: string }[]).map((s) => `${s.key}:${s.state}`);

describe("the WordPress preview's names", () => {
  it("are made from the project, safely", () => {
    expect(previewName("Nora Beagle Site", "0b9c6a1e-0000-4000-8000-000000000000")).toBe("nora-beagle-site");
    expect(previewName("Bob's \"Best\" $(rm -rf ~) Pest", "0b9c6a1e-0000-4000-8000-000000000000")).toBe("bobs-best-rm-rf-pest");
    expect(previewName("!!!", "0b9c6a1e-0000-4000-8000-000000000000")).toBe("site-0b9c6a1e");
    // The package's main domain is a VML name, never the client's: under the preview domain, or a VML name that needs no DNS.
    expect(previewHostFor("nora-beagle-site", "vmlpreview.com")).toBe("nora-beagle-site.vmlpreview.com");
    expect(() => previewHostFor("../evil", "vmlpreview.com")).toThrow();
    expect(stagingHostFor("nora-beagle-site.com")).toBe("nora-beagle-site-com.stackstaging.com");
  });

  it("without a preview domain, names the 20i package after the client's own domain (8 October 2026)", () => {
    expect(packageDomainFrom([null, "https://www.SacPlumbingExperts.com/about?x=1"], "tawdpreviews.com")).toBe("sacplumbingexperts.com");
    expect(packageDomainFrom(["", "not a domain", "sacplumbingexperts.com."], null)).toBe("sacplumbingexperts.com");
    expect(packageDomainFrom(["sac.tawdpreviews.com", "x.stackstaging.com"], "tawdpreviews.com")).toBeNull();
    expect(packageDomainFrom([undefined], null)).toBeNull();
    expect(onPreviewDomain({ host: "sac.tawdpreviews.com", packageDomain: "sacplumbingexperts.com" })).toBe(true);
    // Option 1 (0.119.0): the package named after the preview address itself.
    expect(onPreviewDomain({ host: "sac.tawdpreviews.com", packageDomain: "sac.tawdpreviews.com" })).toBe(true);
    expect(packageOnPreviewName({ name: "sac", packageDomain: "sac.tawdpreviews.com" }, "tawdpreviews.com")).toBe(true);
    expect(packageOnPreviewName({ name: "sac", packageDomain: "sacplumbingexperts.com" }, "tawdpreviews.com")).toBe(false);
    expect(packageOnPreviewName({ name: "sac", packageDomain: "sac.tawdpreviews.com" }, null)).toBe(false);
    expect(onPreviewDomain({ host: "sacplumbingexperts-com.stackstaging.com", packageDomain: "sacplumbingexperts.com" })).toBe(false);
    expect(onPreviewDomain({ host: "old.bluehost.example", packageDomain: null })).toBe(false);
    expect(databaseNameFor("0b9c6a1e-0000-4000-8000-000000000000")).toBe("tawd0b9c6a1e");
    expect(isWebRoot("public_html")).toBe(true);
    expect(isWebRoot("../etc")).toBe(false);
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe("the WordPress preview on 20i", () => {
  it("says what's missing before it can start", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest" });
    expect(await loadWpPreview(h.db, id)).toBeNull();
    await setHosting(h.ctx, admin.viewer, id, "wordpress");
    await h.db.insert(serviceHeartbeat).values({ service: "worker", version: "0.88.0", startedAt: new Date(), env: {} });
    const view = (await loadWpPreview(h.db, id))!;
    expect(view.state).toBe("none");
    // Without a preview domain, the address is 20i's own, known once the package exists.
    expect(view.host).toBeNull();
    expect(view.blockers).toEqual([
      "Build the site first: the preview is made from the finished build.",
      "The worker's 20i key is missing: an admin adds TWENTYI_API_KEY in Coolify on tawd-worker-new only, then redeploys the worker (System, 20i).",
      // TAWD makes its own SSH key at the first deploy (8 October 2026): not a blocker.
      "20i isn't checked yet: an admin runs Check the 20i account on System.",
      "The package type TAWD uses isn't chosen yet (System, 20i).",
      "Without a preview domain, 20i names each site's package after the client's own domain: add it on the intake's Website section (Domain name), then deploy. Nothing changes at the domain itself.",
    ]);
    await expect(startWpPreview(h.ctx, admin.viewer, id)).rejects.toThrow("Build the site first");
    // The deploy made TAWD's key on its way, logged as TAWD's own action.
    const [key] = await h.db.select().from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE));
    expect(key?.publicKey).toMatch(/^ssh-(ed25519|rsa) /);
    expect(key?.createdByUserId).toBeNull();
    const [made] = await h.db.select().from(activityLog).where(eq(activityLog.action, "twentyi.key_made"));
    expect(made?.valueAfter).toMatchObject({ automatic: true });
  });

  it("is deployed by a PM on 20i's staging address: the package, its database and key by API, WordPress over SSH, the cache cleared", async () => {
    const { pm, content, id } = await ready();
    await expect(startWpPreview(h.ctx, content.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    await startWpPreview(h.ctx, pm.viewer, id);
    await expect(startWpPreview(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(WpPreviewError);
    expect(queued.map((q) => [q.name, q.data])).toEqual([[WP_PREVIEW_JOB, { projectId: id, action: "deploy" }]]);
    const started = await row(id);
    expect(started).toMatchObject({ state: "deploying", host: null, packageDomain: "harborpest.com", dbName: null });

    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    const staging = "harborpest-com.stackstaging.com";
    expect(done).toMatchObject({ state: "ready", deployedVersion: 1, host: staging, stagingHost: staging, sshHost: "ssh.us.stackcp.com", sshUser: "harborpest.com", dir: "public_html", failureReason: null });
    expect(states(done.steps)).toEqual(["hosting:done", "database:done", "ssh:done", "wordpress:done", "plugins:done", "package:done", "cache:done"]);

    // 20i: one package of TAWD's type, the web root pinned, PHP 8.3, a database (20i's own name and host), TAWD's key, the whole cache purged.
    const pkg = twentyi.packages.get(done.packageId!)!;
    expect(pkg).toMatchObject({ name: "harborpest.com", typeRef: "tawd-wp", roots: { "harborpest.com": "public_html" }, php: "8.3" });
    expect(done.packageIpv4).toBe(pkg.ipv4);
    const idPart = id.replace(/-/g, "").slice(0, 8);
    expect(pkg.databases).toEqual([{ name: `tawd${idPart}_x1`, user: `tawd${idPart}_x1`, host: "mysql.stackcp.example", password: decryptSecret(done.dbPasswordEncrypted) }]);
    expect(done).toMatchObject({ dbName: `tawd${idPart}_x1`, dbHost: "mysql.stackcp.example" });
    expect(pkg.sshKeys).toHaveLength(1);
    expect(pkg.purged).toBe(1);

    // WordPress, with 20i's database host (never localhost by assumption) and the staging address as home.
    expect(server.ran.some((c) => c.startsWith(`wp core download --version=${WP_CORE_VERSION} --skip-content`) && c.includes(`--path="$HOME"/'public_html'`))).toBe(true);
    expect(server.ran.some((c) => c.includes("config create") && c.includes("--dbhost='mysql.stackcp.example'"))).toBe(true);
    for (const p of WP_PLUGINS) expect(server.plugins.get(p.slug)).toBe(p.version);
    expect(server.ran.some((c) => c.includes(`--url='https://${staging}'`) && c.includes("--title='Harbor Pest'") && /--admin_user='tawd-[0-9a-f]{12}'/.test(c))).toBe(true);
    expect(server.adminPassword).toBe(decryptSecret(done.adminPasswordEncrypted));
    // The package went up outside the web root, without TAWD's own pictures.
    const zip = unzipSync(server.uploads.get("tawd-packages/harbor-pest-v1.zip")!);
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(["install.php", "manifest.json", "content/pages/home.html"]));
    expect(Object.keys(zip).some((k) => k.includes("_shots"))).toBe(false);

    // The gateway's own key is remembered on the first sign-in, per server name.
    const [pins] = await h.db.select().from(appSetting).where(eq(appSetting.key, SSH_HOST_KEYS_SETTING));
    expect(Object.keys(pins!.value as object)).toEqual(["ssh.us.stackcp.com"]);
    expect(targets[0]).toMatchObject({ host: "ssh.us.stackcp.com", username: "harborpest.com", expectedHostKey: null });

    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["site.wp_preview_started", "site.wp_package_created", "site.wp_preview_deployed"]));
    const text = JSON.stringify(await h.db.select().from(activityLog));
    expect(text).not.toContain(decryptSecret(done.adminPasswordEncrypted));
    expect(text).not.toContain(decryptSecret(done.dbPasswordEncrypted));
    // The speed gate can't measure 20i's staging servers: the card says so.
    expect((await loadWpPreview(h.db, id))!.onStaging).toBe(true);
  });

  it("carries on when run again: the same package, database and passwords, and the key the gateway answered with is required", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const first = await row(id);
    twentyi.calls = [];
    server.ran = [];
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    const again = await row(id);
    expect(again.state).toBe("ready");
    expect(again.packageId).toBe(first.packageId);
    expect(twentyi.calls.some((c) => c.startsWith("createPackage") || c.startsWith("createDatabase"))).toBe(false);
    expect(server.ran.some((c) => c.includes("core download") || c.includes("core install") || c.includes("plugin install") || c.includes("config create"))).toBe(false);
    // wp-config.php gets 20i's database settings again (a database made again would have new names).
    expect(server.ran.some((c) => c.includes("config set DB_HOST 'mysql.stackcp.example'"))).toBe(true);
    expect(again.dbPasswordEncrypted).toBe(first.dbPasswordEncrypted);
    expect(targets.at(-1)!.expectedHostKey).toBe(server.hostKey);
    expect(twentyi.packages.size).toBe(1);

    // A gateway answering with another key stops the run and says what to do.
    server.hostKey = "SHA256:someoneelse000000000000000000000000000000";
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[2]!.data);
    expect((await row(id)).failureReason).toContain("different key than before");
  });

  it("never makes the database again once its names are saved, even when 20i's list is empty or doesn't answer (Fable's code review, finding 5)", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const first = await row(id);
    const pkg = twentyi.packages.get(first.packageId!)!;
    // 20i's (unverified) list answers empty, then refuses: the saved database is kept both times, with a warning.
    pkg.databases = [];
    twentyi.calls = [];
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    twentyi.refuse.listDatabases = new TwentyiError("20i said no (404)", "not_found", 404);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[2]!.data);
    const again = await row(id);
    expect(again.state).toBe("ready");
    expect(twentyi.calls.some((c) => c.startsWith("createDatabase"))).toBe(false);
    expect(again).toMatchObject({ dbName: first.dbName, dbUser: first.dbUser, dbHost: first.dbHost });
    expect((again.steps as { key: string; state: string; detail: string }[]).find((s) => s.key === "database")).toMatchObject({ state: "warn", detail: expect.stringContaining("(kept)") });
    // WordPress wasn't installed afresh over it.
    expect(server.ran.filter((c) => c.includes("core install"))).toHaveLength(1);
  });

  it("backs a live site up before any step that could change it", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    await h.db.update(wpPreview).set({ liveState: "live", liveDomain: "harborpest.com" }).where(eq(wpPreview.projectId, id));
    await startWpPreview(h.ctx, pm.viewer, id);
    expect(states((await row(id)).steps)[0]).toBe("backup:waiting");
    await runWpPreviewJob(queued[1]!.data);
    const after = await row(id);
    expect(states(after.steps)).toEqual(["backup:done", "hosting:done", "database:done", "ssh:done", "wordpress:done", "plugins:done", "package:done", "cache:done"]);
    expect((after.backups as { kind: string }[]).map((b) => b.kind)).toEqual(["update"]);
    // The dump ran before anything was written to wp-config.php.
    const dump = server.ran.findIndex((c) => c.includes("wp db export"));
    const config = server.ran.findLastIndex((c) => c.includes("config set DB_HOST"));
    expect(dump).toBeGreaterThan(-1);
    expect(dump).toBeLessThan(config);
  });

  it("shows the address the deploy will really use, and a key 20i already has isn't a warning (findings 17 and 18)", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { admin, pm, id } = await ready();
    // Another project already has the name: the card says -2 before the first deploy, as the deploy does.
    const other = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest" });
    await setHosting(h.ctx, admin.viewer, other, "wordpress");
    await h.db.insert(wpPreview).values({ projectId: other, name: "harbor-pest", dbPasswordEncrypted: "x", adminUser: "tawd", adminPasswordEncrypted: "x", state: "ready" } as never);
    expect((await loadWpPreview(h.db, id))!.host).toBe("harbor-pest-2.vmlpreview.com");
    await startWpPreview(h.ctx, pm.viewer, id);
    expect((await row(id)).host).toBe("harbor-pest-2.vmlpreview.com");

    await runWpPreviewJob(queued[0]!.data);
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    twentyi.refuse.addSshKey = new TwentyiError("20i said no (409): this key already exists", "refused", 409);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    expect(states((await row(id)).steps)).toContain("ssh:done");
    twentyi.refuse.addSshKey = new TwentyiError("20i said no (400): invalid key", "refused", 400);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[2]!.data);
    expect(states((await row(id)).steps)).toContain("ssh:warn");
  });

  it("never makes a second package after a run that stopped before saving the first", async () => {
    const { pm, id } = await ready();
    const made = await twentyi.createPackage({ typeId: "tawd-wp", domain: "harborpest.com", label: "TAWD harbor-pest" });
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    expect((await row(id)).packageId).toBe(made);
    expect(twentyi.packages.size).toBe(1);
    expect(((await row(id)).steps as { detail: string }[])[0]!.detail).toContain(`Found package ${made}`);
  });

  it("fails fast while 20i is still setting up TAWD's key, and Deploy again carries on from there", async () => {
    const { pm, id } = await ready();
    server.refuseKey = true;
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const failed = await row(id);
    expect(failed.state).toBe("failed");
    expect(failed.failureReason).toBe(`TAWD's access (SSH): ${SSH_NOT_READY}`);
    expect(states(failed.steps)).toEqual(["hosting:done", "database:done", "ssh:failed", "wordpress:waiting", "plugins:waiting", "package:waiting", "cache:waiting"]);
    server.refuseKey = false;
    twentyi.calls = [];
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    expect((await row(id)).state).toBe("ready");
    expect(twentyi.calls.some((c) => c.startsWith("createPackage") || c.startsWith("createDatabase"))).toBe(false);
  });

  it("stops at a refused 20i call, in 20i's words, and nothing after it runs", async () => {
    const { pm, id } = await ready();
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    twentyi.refuse.createDatabase = new TwentyiError("20i said no (400): database quota reached", "refused", 400);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const failed = await row(id);
    expect(failed.failureReason).toBe("The database: 20i said no (400): database quota reached");
    expect(server.ran).toEqual([]);
  });

  it("asks an admin to confirm the 26th package (the next plan, its price) before making it", async () => {
    const { admin, pm, id } = await ready("Harbor Pest", 25);
    twentyi.others = 25;
    const view = (await loadWpPreview(h.db, id))!;
    expect(view.needsLimitConfirm).toBe(true);
    await expect(startWpPreview(h.ctx, pm.viewer, id)).rejects.toThrow("Reseller 25 holds 25, so VML moves to Reseller 50 ($39.99 a month)");
    await expect(confirmPackageLimit(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    await confirmPackageLimit(h.ctx, admin.viewer, id);
    expect((await loadWpPreview(h.db, id))!.limitConfirmedBy).toBe(admin.viewer.id);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    expect((await row(id)).state).toBe("ready");
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_limit_confirmed")))).toHaveLength(1);
  });

  it("and the worker counts 20i's own packages too (sites outside TAWD count), stopping without a confirm", async () => {
    const { pm, id } = await ready("Harbor Pest", 10);
    twentyi.others = 25;
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const failed = await row(id);
    expect(failed.failureReason).toContain("This would be package 26 on 20i: Reseller 25 holds 25, so 20i moves VML to Reseller 50 ($39.99 a month).");
    expect(twentyi.packages.size).toBe(0);
  });

  it("keeps a client's words out of the shell", async () => {
    const { pm, id } = await ready("Bob's \"Best\" $(rm -rf ~) Pest");
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const install = server.ran.find((c) => c.includes("core install"))!;
    expect(install).toContain(`--title='Bob'\\''s "Best" $(rm -rf ~) Pest'`);
    expect(server.ran.filter((c) => c.includes("rm -rf ~"))).toEqual([install]);
  });

  it("shows the WordPress login to admins only, and logs each showing", async () => {
    const { admin, pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await expect(showWpLogin(h.ctx, admin.viewer, id)).rejects.toThrow("no WordPress preview yet");
    await runWpPreviewJob(queued[0]!.data);
    await expect(showWpLogin(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    const login = await showWpLogin(h.ctx, admin.viewer, id);
    expect(login).toEqual({ url: "https://harborpest-com.stackstaging.com/wp-admin/", user: server.adminUser, password: server.adminPassword });
    expect(login.user).toMatch(/^tawd-[0-9a-f]{12}$/);
    const shown = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_login_shown"));
    expect(shown).toHaveLength(1);
    expect(JSON.stringify(shown)).not.toContain(login.password);
  });
});

describe("the preview domain (decision D1, option B)", () => {
  it("puts the preview at <name>.<preview domain>: its A record and its own certificate before WordPress, the key never stored", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    expect((await loadWpPreview(h.db, id))!.host).toBe("harbor-pest.vmlpreview.com");
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    const host = "harbor-pest.vmlpreview.com";
    expect(done).toMatchObject({ state: "ready", host, packageDomain: host, stagingHost: "harbor-pest-vmlpreview-com.stackstaging.com", sshUser: host });
    // Option 1 (0.119.0): the package is named after the preview address (20i, 3 November 2026), at the web root; no extra name is added.
    expect(twentyi.packages.get(done.packageId!)!).toMatchObject({ name: host, names: [host], roots: { [host]: "public_html" } });
    expect(twentyi.calls.some((c) => c.startsWith("addDomain"))).toBe(false);
    expect(states(done.steps)).toEqual(["hosting:done", "preview_record:done", "database:done", "ssh:done", "cert:warn", "wordpress:done", "plugins:done", "package:done", "cache:done"]);
    expect(cloudflare.zones.get("vmlpreview.com")!.get(host)).toBe(done.packageIpv4);

    // Let's Encrypt's check file went into the web root over SFTP and came out again; the certificate went to 20i.
    expect(acmeLog).toEqual([{ names: [host], staging: false, tokens: [expect.stringMatching(/^tok/)] }]);
    const token = acmeLog[0]!.tokens[0]!;
    expect(new TextDecoder().decode(server.uploads.get(`public_html/.well-known/acme-challenge/${token}`)!)).toBe(`${token}.keyauth`);
    expect(server.ran).toContain(`rm -f "$HOME"/'public_html/.well-known/acme-challenge/${token}' 2>&1`);
    const pkg = twentyi.packages.get(done.packageId!)!;
    expect(pkg.certificates).toEqual([{ domain: host, certificate: expect.stringContaining("leaf"), caBundle: expect.stringContaining("R11"), hasKey: true }]);
    // The order is right: the certificate before WordPress is installed at https://<host>.
    expect(twentyi.calls.findIndex((c) => c.startsWith("installCertificate"))).toBeGreaterThan(-1);
    expect(server.ran.some((c) => c.includes(`--url='https://${host}'`))).toBe(true);
    expect(done.certs).toMatchObject({ preview: { state: "installing", source: "letsencrypt", host, issuer: "R11", expiresAt: "2027-01-03T00:00:00.000Z" } });

    // The site's private key is never kept by TAWD: not on the row, not in a setting, not in the log.
    const everything = JSON.stringify([await row(id), await h.db.select().from(appSetting), await h.db.select().from(activityLog)]);
    expect(everything).not.toContain("site-private-key-material");
    expect(everything).not.toContain(FAKE_PRIVATE_KEY);
    // TAWD's ACME account key is kept, encrypted.
    const [acme] = await h.db.select().from(appSetting).where(eq(appSetting.key, "acme_account"));
    expect(JSON.stringify(acme!.value)).not.toContain("acme-account");
    expect(decryptSecret((acme!.value as { keyEncrypted: string }).keyEncrypted)).toContain("acme-account");

    // Check HTTPS, once 20i serves it: the preview's certificate is OK and the step turns Done.
    serving.set(host, { issuer: "Let's Encrypt", validTo: "2027-01-03T00:00:00Z" });
    await runWpPreviewJob({ projectId: id, action: "https" });
    const after = await row(id);
    expect(after.https).toBe(true);
    expect(after.certs).toMatchObject({ preview: { state: "ok" } });
    expect(states(after.steps)).toContain("cert:done");
    expect((await loadWpPreview(h.db, id))!.onStaging).toBe(false);
  });

  it("doesn't issue the preview's certificate again on Deploy again while 20i may still be installing it (Fable's code review, finding 8)", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    expect(acmeLog).toHaveLength(1);
    for (const n of [1, 2]) {
      await startWpPreview(h.ctx, pm.viewer, id);
      await runWpPreviewJob(queued[n]!.data);
    }
    expect(acmeLog).toHaveLength(1);
    const again = await row(id);
    expect(again.certs).toMatchObject({ preview: { state: "installing" } });
    expect((again.steps as { key: string; state: string; detail: string }[]).find((s) => s.key === "cert")).toMatchObject({ state: "warn", detail: expect.stringContaining("installed this certificate 0 minutes ago") });
    // Two hours on and still not served: the next deploy issues a new one.
    const preview = (again.certs as { preview: Record<string, unknown> }).preview;
    await h.db.update(wpPreview).set({ certs: { preview: { ...preview, installedAt: new Date(Date.now() - 2 * 3_600_000 - 60_000).toISOString() } } }).where(eq(wpPreview.projectId, id));
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[3]!.data);
    expect(acmeLog).toHaveLength(2);
  });

  it("with certificates installed by hand, says where and carries on; a Let's Encrypt refusal doesn't stop WordPress either", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done.state).toBe("ready");
    expect((done.steps as { key: string; detail: string }[]).find((s) => s.key === "cert")!.detail).toContain("Install a certificate for harbor-pest.vmlpreview.com in My20i");
    expect(acmeLog).toEqual([]);

    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    setAcmeForTesting(fakeAcme(acmeLog, { message: "urn:ietf:params:acme:error:caa: CAA record for vmlpreview.com prevents issuance" }));
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    const again = await row(id);
    expect(again.state).toBe("ready");
    expect(again.certs).toMatchObject({ preview: { state: "failed", note: expect.stringContaining("CAA record doesn't allow Let's Encrypt") } });
    // TAWD's ACME account key was saved before that first try, so a failed try doesn't throw it away (finding 11): the next one reuses it.
    const [account] = await h.db.select().from(appSetting).where(eq(appSetting.key, "acme_account"));
    expect(decryptSecret((account!.value as { keyEncrypted: string }).keyEncrypted)).toContain("acme-account");
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[2]!.data);
    const [still] = await h.db.select().from(appSetting).where(eq(appSetting.key, "acme_account"));
    expect(still!.value).toEqual(account!.value);
    expect(acmeLog).toHaveLength(2);
  });

  it("stops at the record when the preview domain isn't on the client-zones Cloudflare account, saying who adds it", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    setCloudflareDnsForTesting(new FakeCloudflareDns([]));
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    expect((await row(id)).failureReason).toBe("The preview address (DNS): vmlpreview.com isn't on VML's client-zones Cloudflare account yet: Jason adds it there, then Deploy again.");
  });
});

describe("removing the preview", () => {
  it("deletes its 20i package (and the preview record), and the project can't be deleted before that", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { admin, pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const packageId = (await row(id)).packageId!;
    await expect(deleteProject(h.ctx, admin.viewer, id, { confirmName: "Harbor Pest", reason: "A test project, done with." })).rejects.toThrow(ProjectDeleteError);

    await removeWpPreview(h.ctx, pm.viewer, id);
    expect(states((await row(id)).steps)).toEqual(["remove_record:waiting", "remove_package:waiting"]);
    await runWpPreviewJob(queued[1]!.data);
    const removed = await row(id);
    expect(removed).toMatchObject({ state: "removed", packageId: null, dbName: null, certs: {} });
    expect(twentyi.packages.has(packageId)).toBe(false);
    expect(cloudflare.zones.get("vmlpreview.com")!.size).toBe(0);
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_package_deleted")))).toHaveLength(1);
    await expect(removeWpPreview(h.ctx, pm.viewer, id)).rejects.toThrow("no WordPress preview");
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Harbor Pest", reason: "A test project, done with." });
  });

  it("says an admin cancels a paid 20i certificate in My20i (20i's API can't), and still removes the package", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const order = await twentyi.orderCertificate({ packageId: (await row(id)).packageId!, domain: "harborpest.com", periodMonths: 12 });
    await h.db.update(wpPreview).set({ certs: { live: { state: "ok", source: "twentyi_paid", host: "harborpest.com", issuer: "DigiCert", issuedAt: null, expiresAt: null, note: null, paidId: order.id } } }).where(eq(wpPreview.projectId, id));
    await removeWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    const removed = await row(id);
    expect(states(removed.steps)).toEqual(["remove_certificate:warn", "remove_package:done"]);
    expect(JSON.stringify(removed.steps)).toContain(`harborpest.com (${order.id}) can't be cancelled through 20i's API: an admin cancels it in My20i`);
    expect(removed.state).toBe("removed");
  });

  it("marks a preview left from Bluehost removed without calling anyone, so nothing is stuck", async () => {
    const { admin, pm, id } = await ready();
    // a client's row as Bluehost left it (5 October 2026): a host and a folder, no 20i package.
    await h.db.insert(wpPreview).values({ projectId: id, name: "harbor-pest", host: "harbor-pest.fba.ici.mybluehost.me", dir: "tawd-sites/harbor-pest", dbName: "fbaicimy_tawd1", dbUser: "fbaicimy_tawd1", dbPasswordEncrypted: "x", adminUser: "tawd-vml", adminPasswordEncrypted: "x", state: "ready", deployedVersion: 1 });
    expect((await loadWpPreview(h.db, id))!.fromBluehost).toBe(true);
    await removeWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const removed = await row(id);
    expect(removed.state).toBe("removed");
    expect((removed.steps as { key: string; detail: string }[]).find((s) => s.key === "remove_package")!.detail).toContain("remove them by hand");
    expect(twentyi.calls).toEqual([]);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Harbor Pest", reason: "A test project, done with." });
  });
});

describe("the card", () => {
  const props = { projectId: "p1", host: "harbor-pest.vmlpreview.com", version: 1, deployedVersion: null, latestBuild: 1, https: false, steps: [], removing: false, blockers: [], canDeploy: true, isAdmin: false, statusLine: null };

  it("offers the deploy, or says what's missing", () => {
    const html = renderToStaticMarkup(<WpPreviewSection {...props} state="none" />);
    expect(html).toContain("Makes the site its own 20i hosting package at harbor-pest.vmlpreview.com");
    expect(html).toContain("Deploy the WordPress preview");
    const blocked = renderToStaticMarkup(<WpPreviewSection {...props} state="none" blockers={["Build the site first: the preview is made from the finished build."]} />);
    expect(blocked).toContain("Build the site first");
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*>Deploy the WordPress preview/);
    expect(renderToStaticMarkup(<WpPreviewSection {...props} host={null} state="none" />)).toContain("at 20i&#x27;s private address for it");
  });

  it("shows the preview, its HTTPS, the staging fallback and the admin's tools once ready", () => {
    const ready = renderToStaticMarkup(
      <WpPreviewSection {...props} state="ready" deployedVersion={1} latestBuild={2} stagingHost="harbor-pest-vmlpreview-com.stackstaging.com" previewCert={{ state: "installing", note: "Installed at 20i; it can take up to 30 minutes to show.", expires: null }} />,
    );
    expect(ready).toContain('href="https://harbor-pest.vmlpreview.com/"');
    expect(ready).toContain("own address ↗");
    expect(ready).toContain("up to 30 minutes");
    expect(ready).toContain("Check HTTPS");
    expect(ready).toContain("Deploy version 2");
    expect(ready).toContain("Remove the preview");
    expect(ready).toContain("Purge 20i");
    expect(ready).not.toContain("Suspend the site");
    const admin = renderToStaticMarkup(<WpPreviewSection {...props} state="ready" deployedVersion={1} isAdmin https />);
    expect(admin).toContain("Show the WordPress login");
    expect(admin).toContain("Suspend the site");
    const staging = renderToStaticMarkup(<WpPreviewSection {...props} host="x.stackstaging.com" onStaging state="ready" deployedVersion={1} https />);
    expect(staging).toContain("Speed check can");
    expect(staging).toContain("measure it, so a founder lets the build go live");
  });

  it("asks an admin to confirm the 26th site", () => {
    const plan = { name: "Reseller 25", limit: 25, next: "Reseller 50 ($39.99 a month)" };
    const pm = renderToStaticMarkup(<WpPreviewSection {...props} state="none" needsLimitConfirm packagesUsed={25} plan={plan} />);
    expect(pm).toContain("has 25 of 25 packages: this site would move it to Reseller 50 ($39.99 a month).");
    expect(pm).toContain("An admin confirms it here first.");
    expect(pm).toMatch(/<button[^>]*disabled[^>]*>Deploy the WordPress preview/);
    expect(renderToStaticMarkup(<WpPreviewSection {...props} state="none" needsLimitConfirm packagesUsed={25} plan={plan} isAdmin />)).toContain("Confirm site 26");
  });
});

describe("Gravity Forms, the second form option (1 October 2026)", () => {
  it("is chosen by PMs and admins, logged, and locked once the site is live", async () => {
    const { pm, content, admin, id } = await ready();
    expect((await loadHosting(h.db, id))!.formPlugin).toBe("cf7");
    await expect(setFormPlugin(h.ctx, content.viewer, id, "gravityforms")).rejects.toBeInstanceOf(PermissionError);
    await setFormPlugin(h.ctx, pm.viewer, id, "gravityforms");
    expect((await loadHosting(h.db, id))!.formPlugin).toBe("gravityforms");
    await expect(setFormPlugin(h.ctx, admin.viewer, id, "nope" as never)).rejects.toBeInstanceOf(HostingError);
    await h.db.update(projectTable).set({ status: "live", liveAt: new Date() }).where(eq(projectTable.id, id));
    await expect(setFormPlugin(h.ctx, admin.viewer, id, "cf7")).rejects.toBeInstanceOf(HostingError);
  });

  it("is installed with VML's licence instead of Contact Form 7, the key never in the log", async () => {
    const { pm, id } = await ready();
    await setFormPlugin(h.ctx, pm.viewer, id, "gravityforms");
    vi.stubEnv("GRAVITY_FORMS_LICENSE_KEY", "gf-key-123");
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done.state).toBe("ready");
    expect(server.plugins.get("gravityformscli")).toBe("1.9.1");
    expect(server.plugins.has("gravityforms")).toBe(true);
    expect(server.plugins.has("contact-form-7")).toBe(false);
    expect(server.ran.some((c) => c.includes("gf install --key='gf-key-123' --activate"))).toBe(true);
    const plugins = (done.steps as { key: string; label: string; detail: string | null }[]).find((s) => s.key === "plugins")!;
    expect(plugins.label).toBe("Gravity Forms, Rank Math and MalCare");
    const zip = unzipSync(server.uploads.get("tawd-packages/harbor-pest-v1.zip")!);
    expect(JSON.parse(new TextDecoder().decode(zip["manifest.json"]!)).formPlugin).toBe("gravityforms");
    expect(JSON.stringify(await h.db.select().from(activityLog))).not.toContain("gf-key-123");
    expect(JSON.stringify(await row(id))).not.toContain("gf-key-123");
  });

  it("stops at the plugins step, saying what to add, when the worker has no licence key", async () => {
    const { pm, id } = await ready();
    await setFormPlugin(h.ctx, pm.viewer, id, "gravityforms");
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const failed = await row(id);
    expect(failed.state).toBe("failed");
    expect(failed.failureReason).toContain("GRAVITY_FORMS_LICENSE_KEY");
  });

  it("shows on the Hosting card as WordPress on 20i, with the missing key in amber", () => {
    const props = { projectId: "p1", canChange: true, locked: false, isPro: true, showPrices: true, addonPrice: null, addonLine: null, changedLine: null, hosting: "wordpress" } as const;
    const cf7 = renderToStaticMarkup(<HostingCard {...props} formPlugin={{ value: "cf7", keyMissing: true }} />);
    expect(cf7).toContain("WordPress on 20i (Build B)");
    expect(cf7).toContain("Forms: Contact Form 7 (free)");
    expect(cf7).not.toContain("Bluehost");
    const gf = renderToStaticMarkup(<HostingCard {...props} formPlugin={{ value: "gravityforms", keyMissing: true }} />);
    expect(gf).toContain("GRAVITY_FORMS_LICENSE_KEY");
  });
});

/* 8 October 2026: on a WordPress project the client decides on the WordPress preview, and no Netlify card is offered. */
describe("the client's decision on a WordPress preview", () => {
  it("is recorded against the WordPress preview's version, and needs it deployed first", async () => {
    const { admin, id } = await ready();
    const said = { outcome: "approved" as const, channel: "email", clientSaid: "Looks right, go ahead." };
    await expect(recordPreviewDecision(h.ctx, admin.viewer, id, said)).rejects.toThrow("Deploy the WordPress preview first");

    await h.db.insert(wpPreview).values({ projectId: id, name: "harbor-pest", host: "harbor-pest.tawdpreviews.com", dbPasswordEncrypted: "x", adminUser: "tawd", adminPasswordEncrypted: "x", state: "ready", deployedVersion: 1 } as never);
    await recordPreviewDecision(h.ctx, admin.viewer, id, said);
    const [decision] = await h.db.select().from(previewDecision).where(eq(previewDecision.projectId, id));
    expect(decision).toMatchObject({ deployId: null, wpVersion: 1, outcome: "approved" });
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "site.preview_decision"));
    expect(logged!.valueAfter).toMatchObject({ version: 1, url: "https://harbor-pest.tawdpreviews.com", wordpress: true });
  });

  it("shows only the decision, never the Netlify deploy, on a WordPress project", () => {
    const props = { projectId: "p", canDeploy: true, missing: [], hasBuild: true, staleLine: null, uploading: false, deploys: [], site: null, decisionLine: null, decisionChanges: false };
    const wp = renderToStaticMarkup(<PreviewCard {...props} wordpress={{ ready: true }} />);
    expect(wp).toContain("The client’s decision on the preview");
    expect(wp).toContain("Record the client");
    expect(wp).not.toContain("Netlify");
    expect(wp).not.toContain("Deploy a preview");
    expect(renderToStaticMarkup(<PreviewCard {...props} wordpress={{ ready: false }} />)).toContain("Deploy the WordPress preview first");
    expect(renderToStaticMarkup(<PreviewCard {...props} />)).toContain("Deploy a preview");
  });
});


describe("the 20i package's name (8 October 2026, the first real deploy)", () => {
  it("names the package after the preview address, once the preview domain's placeholder is there (option 1, 0.119.0)", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    // The preview domain's placeholder first (12 October 2026), then the preview's own package; the client's domain isn't needed yet.
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toEqual(["createPackage vmlpreview.com", "createPackage harbor-pest.vmlpreview.com"]);
    expect((await row(id)).state).toBe("ready");
    expect((await loadWpPreview(h.db, id))!.blockers).toEqual([]);
  });

  it("stops in 20i's words, with nothing made, if 20i won't make a package named after the preview address", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    const { TwentyiError } = await import("../../../worker/src/twentyi");
    // The placeholder is already in the account; 20i refuses only the preview's own package.
    await twentyi.createPackage({ typeId: "tawd-wp", domain: "vmlpreview.com", label: "placeholder" });
    twentyi.refuse.createPackage = new TwentyiError('20i said no (400): {"error":{"code":0,"message":"Subdomain not valid for request","data":null}}', "refused", 400);
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done).toMatchObject({ state: "failed", packageId: null });
    expect(done.failureReason).toContain("20i wouldn't make a package named harbor-pest.vmlpreview.com (20i said no (400)");
    expect(done.failureReason).toContain("Nothing was made.");
  });

  it("no longer needs the client's domain to start, with the preview domain set", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { admin, pm, id } = await ready();
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainName: "" });
    expect((await loadWpPreview(h.db, id))!.blockers).toEqual([]);
    await startWpPreview(h.ctx, pm.viewer, id);
    expect((await row(id)).packageDomain).toBe("harbor-pest.vmlpreview.com");
  });

  it("asks for the client's domain when the intake has none", async () => {
    const { admin, pm, id } = await ready();
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainName: "" });
    const blocker = "Without a preview domain, 20i names each site's package after the client's own domain: add it on the intake's Website section (Domain name), then deploy. Nothing changes at the domain itself.";
    expect((await loadWpPreview(h.db, id))!.blockers).toContain(blocker);
    await expect(startWpPreview(h.ctx, pm.viewer, id)).rejects.toThrow(blocker);
    // The current site's address does as well.
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { domainName: "", currentWebsiteUrl: "https://www.harborpest.com/" });
    await startWpPreview(h.ctx, pm.viewer, id);
    expect((await row(id)).packageDomain).toBe("harborpest.com");
  });

  it("never puts two projects' sites in one package", async () => {
    const { admin, pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const other = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Harbor Pest Test" });
    await setHosting(h.ctx, admin.viewer, other, "wordpress");
    await saveIntakeSection(h.ctx, admin.viewer, other, "website", { domainName: "harborpest.com" });
    await h.db.insert(siteBuild).values({ projectId: other, version: 1, status: "done", checks: [] } as never);
    await expect(startWpPreview(h.ctx, pm.viewer, other)).rejects.toThrow("Harbor Pest's WordPress site already has the 20i package for harborpest.com.");
  });

  it("starts again under the new naming when the first try never made a package", async () => {
    const { pm, id } = await ready();
    await h.db.insert(wpPreview).values({ projectId: id, name: "harbor-pest", packageDomain: "harbor-pest.preview.velocitymedialab.com", dbPasswordEncrypted: "x", adminUser: "tawd", adminPasswordEncrypted: "x", state: "failed" } as never);
    await startWpPreview(h.ctx, pm.viewer, id);
    expect((await row(id)).packageDomain).toBe("harborpest.com");
  });
});

describe("the package's website folder (8 October 2026, the first real deploy)", () => {
  it("is made by TAWD when 20i serves the site from it but a new package doesn't have it yet", async () => {
    const { pm, id } = await ready();
    server.webRoot = false;
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done.state).toBe("ready");
    expect(server.ran).toContain(`mkdir -p "$HOME"/'public_html' && echo yes || echo no`);
    expect((done.steps as { key: string; state: string; detail: string }[]).find((s) => s.key === "ssh")).toMatchObject({ state: "warn", detail: expect.stringContaining("TAWD made the website folder (~/public_html), where 20i serves the site from.") });
  });

  it("says which folder 20i names, and what the home folder holds, when it isn't TAWD's", async () => {
    const { pm, id } = await ready();
    server.webRoot = false;
    await startWpPreview(h.ctx, pm.viewer, id);
    const original = twentyi.documentRoots.bind(twentyi);
    twentyi.documentRoots = async (packageId: string) => ({ ...(await original(packageId)), "harborpest.com": "httpdocs" });
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done.state).toBe("failed");
    expect(done.failureReason).toContain("The package's website folder (~/public_html) isn't there, and 20i serves harborpest.com from ~/httpdocs. The home folder holds: logs, private.");
    expect(server.ran.some((c) => c.startsWith("mkdir -p"))).toBe(false);
  });
});

describe("PHP on 20i's command line (8 October 2026, the first real deploy)", () => {
  it("picks the newest PHP that meets the theme's need, and plain wp when the default does", () => {
    expect(pickPhp("php /usr/bin/php 8.3.12\nwp /usr/local/bin/wp #!/usr/bin/env php")).toMatchObject({ wp: null, chosen: { version: "8.3.12" } });
    const old = pickPhp("php /usr/bin/php 7.4.33\nphp /usr/bin/php8.1 8.1.29\nphp /usr/local/php83/bin/php 8.3.12\nwp /usr/local/bin/wp #!/usr/bin/env php");
    expect(old.chosen).toEqual({ path: "/usr/local/php83/bin/php", version: "8.3.12" });
    expect(old.wp).toBe("'/usr/local/php83/bin/php' '/usr/local/bin/wp'");
    // A shell launcher instead of a phar reads WP_CLI_PHP.
    expect(pickPhp("php /usr/bin/php 7.4.33\nphp /usr/bin/php8.2 8.2.1\nwp /usr/bin/wp #!/bin/sh").wp).toBe("WP_CLI_PHP='/usr/bin/php8.2' wp");
    expect(pickPhp("php /usr/bin/php 7.4.33").chosen).toBeNull();
    expect(phpProbe()).toContain("command -v");
  });

  it("runs WordPress's tools on the newer PHP when 20i's default is too old", async () => {
    const { pm, id } = await ready();
    server.phpList = "php /usr/bin/php 7.4.33\nphp /usr/local/php83/bin/php 8.3.12\nwp /usr/local/bin/wp #!/usr/bin/env php";
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const done = await row(id);
    expect(done.state).toBe("ready");
    expect(server.ran.some((c) => c.startsWith(`'/usr/local/php83/bin/php' '/usr/local/bin/wp' core download`))).toBe(true);
    expect(server.ran.some((c) => c.startsWith("wp "))).toBe(false);
    expect((done.steps as { key: string; detail: string }[]).find((s) => s.key === "ssh")!.detail).toContain("WordPress's tools run on PHP 8.3.12 (/usr/local/php83/bin/php, not the server's default).");
  });

  it("says which PHP versions it found when none is new enough", async () => {
    const { pm, id } = await ready();
    server.phpList = "php /usr/bin/php 7.4.33\nwp /usr/local/bin/wp #!/usr/bin/env php";
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    expect((await row(id)).failureReason).toContain("TAWD's theme needs PHP 8.1 or newer on the command line, and 20i's SSH has 7.4.33 (/usr/bin/php).");
  });
});

describe("each site's own WordPress login name (13 October 2026)", () => {
  it("is made for each new site, used to install WordPress, and never shown on pages (a public name instead)", async () => {
    const { admin, pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[0]!.data);
    const user = (await row(id)).adminUser;
    expect(user).toMatch(/^tawd-[0-9a-f]{12}$/);
    expect(server.adminUser).toBe(user);
    expect(server.publicName).toBe("Website team");
    expect(server.ran.some((c) => c.includes(`user update '${user}' --display_name='Website team' --user_nicename='website-team'`))).toBe(true);
    // Deploy again keeps the same login and sets its password again.
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued[1]!.data);
    expect((await row(id)).adminUser).toBe(user);
    expect(server.ran.some((c) => c.includes(`user update '${user}' --user_pass=`))).toBe(true);
    expect((await row(id)).state).toBe("ready");
    // Another project's site gets a different one.
    const other = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Kelly Glass" });
    await h.db.insert(wpPreview).values({ projectId: other, name: "kelly-glass", packageDomain: "kellyglass.com", dbPasswordEncrypted: "x", adminUser: "tawd-vml", adminPasswordEncrypted: "x", state: "removed" } as never);
    await setHosting(h.ctx, admin.viewer, other, "wordpress");
    await saveIntakeSection(h.ctx, admin.viewer, other, "website", { domainName: "kellyglass.com" });
    await h.db.insert(siteBuild).values({ projectId: other, version: 1, status: "done", checks: [] } as never);
    await startWpPreview(h.ctx, pm.viewer, other);
    const otherUser = (await row(other)).adminUser;
    expect(otherUser).toMatch(/^tawd-[0-9a-f]{12}$/);
    expect(otherUser).not.toBe(user);
  });

  it("keeps the old shared login on a site WordPress already has it on (WordPress can't rename a login)", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await h.db.update(wpPreview).set({ adminUser: "tawd-vml" }).where(eq(wpPreview.projectId, id));
    await runWpPreviewJob(queued[0]!.data);
    expect(server.adminUser).toBe("tawd-vml");
    await startWpPreview(h.ctx, pm.viewer, id);
    expect((await row(id)).adminUser).toBe("tawd-vml");
    await runWpPreviewJob(queued[1]!.data);
    expect((await row(id)).state).toBe("ready");
  });

  it("never puts a login name TAWD didn't make into a command", async () => {
    const { pm, id } = await ready();
    await startWpPreview(h.ctx, pm.viewer, id);
    await h.db.update(wpPreview).set({ adminUser: "admin'; rm -rf ~" }).where(eq(wpPreview.projectId, id));
    await runWpPreviewJob(queued[0]!.data);
    expect((await row(id)).failureReason).toContain("isn't one TAWD makes: remove the preview and deploy it again");
    expect(server.ran.some((c) => c.includes("rm -rf ~"))).toBe(false);
  });
});

describe("previews on the preview domain at 20i (12 October 2026; option 1, own packages, since 0.119.0)", () => {
  type Later = { data: { projectId: string; action: string; from?: string; to?: string; tries?: number }; delay: number; jobId: string };
  let laterLog: Later[];
  let homes: Map<string, { ok: boolean; status: number | null; html: string; reason: string | null }>;
  const MOVED = "harbor-pest.vmlpreview.com";
  const OWN_STAGING = "harbor-pest-vmlpreview-com.stackstaging.com";
  const WP_HOME = '<html><head><link rel="stylesheet" href="/wp-content/themes/tawd-harbor-pest/style.css"></head><body>Harbor Pest</body></html>';

  beforeEach(() => {
    laterLog = [];
    setWpLater(async (data, delay, jobId) => void laterLog.push({ data: data as Later["data"], delay, jobId }));
    homes = new Map();
    setHomeFetchForTesting(async (host) => homes.get(host) ?? { ok: false, status: null, html: "", reason: "ECONNREFUSED" });
  });

  afterEach(() => {
    setWpLater(null);
    setHomeFetchForTesting(null);
  });

  const holderState = async () => ((await h.db.select().from(appSetting).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING)))[0]?.value ?? {}) as PreviewHolderState;
  const saveHolder = async (value: PreviewHolderState) => h.db.update(appSetting).set({ value }).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING));
  const logged = async (action: string) => (await h.db.select().from(activityLog).where(eq(activityLog.action, action as never))).map((a) => a.valueAfter as Record<string, unknown>);
  const step = async (id: string, key: string) => ((await row(id)).steps as { key: string; state: string; detail: string }[]).find((s) => s.key === key)!;
  const deploy = async (pm: { viewer: Parameters<typeof startWpPreview>[1] }, id: string) => {
    await startWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued.at(-1)!.data);
  };
  const runLater = async () => {
    const job = laterLog.at(-1)!.data;
    laterLog = [];
    await runWpPreviewJob(job as never);
  };

  /* A preview made before 0.119.0 on 20i's address: its package named after the client's domain (sacplumbingexperts.com's case). */
  async function legacyOnStaging() {
    const r = await ready();
    await deploy(r.pm, r.id);
    const staging = (await row(r.id)).host!;
    expect(staging).toBe("harborpest-com.stackstaging.com");
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    return { ...r, staging };
  }

  /*
    A preview with its own package (named after the preview address) that is on 20i's address: as after a Deploy again that found the
    placeholder gone with every package used. Deploy again moves it back to the preview address.
  */
  async function ownOnStaging() {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const r = await ready();
    await deploy(r.pm, r.id);
    const staging = (await row(r.id)).stagingHost!;
    expect(staging).toBe(OWN_STAGING);
    await h.db.update(wpPreview).set({ host: staging }).where(eq(wpPreview.projectId, r.id));
    server.home = `https://${staging}`;
    server.data = [
      { table: "wp_options", column: "option_value", value: `a:1:{s:4:"logo";s:51:"https://${staging}/wp-content/logo.png";}` },
      { table: "wp_posts", column: "guid", value: `https://${staging}/?p=1` },
    ];
    acmeLog.length = 0;
    return { ...r, staging };
  }

  /*
    Moved and loading, with a switch-off check that a worker before 0.119.0 had already started (the placeholder switched off): it
    still runs to its end and switches the placeholder back on. New checks never start.
  */
  async function movedAndLoading() {
    const r = await ownOnStaging();
    await deploy(r.pm, r.id);
    homes.set(MOVED, { ok: true, status: 200, html: WP_HOME, reason: null });
    await runLater();
    const state = await holderState();
    const holderId = state.packageId!;
    const now = new Date().toISOString();
    await saveHolder({ ...state, test: { phase: "switching_off", projectId: r.id, host: MOVED, startedAt: now, phaseAt: now, seq: 1 } });
    twentyi.packages.get(holderId)!.enabled = false;
    laterLog = [{ data: { projectId: r.id, action: "holder_test" }, delay: 5 * 60_000, jobId: "wp-holder-test-1" }];
    return { ...r, holderId };
  }

  it("makes the preview domain's placeholder before the preview's own package, once, and says so in the log", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    await deploy(pm, id);
    expect(await row(id)).toMatchObject({ state: "ready", host: MOVED, packageDomain: MOVED });
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toEqual(["createPackage vmlpreview.com", `createPackage ${MOVED}`]);
    const holder = [...twentyi.packages.values()].find((p) => p.name === "vmlpreview.com")!;
    expect((await holderState()).packageId).toBe(holder.id);
    expect(await logged("site.wp_preview_holder_created")).toEqual([{ packageId: holder.id, domain: "vmlpreview.com", forProject: id }]);
    expect(PREVIEW_HOLDER_LABEL).toBe("TAWD preview domain: keep (never suspend or delete)");
    // Deploy again finds both: never a second one.
    await deploy(pm, id);
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toHaveLength(2);
  });

  it("at the plan's limit with no placeholder, makes nothing and says what frees the way; an admin's confirm of the next plan does", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { admin, pm, id } = await ready("Harbor Pest", 25);
    twentyi.others = 25;
    // System's last check counted fewer: the deploy starts, and the worker, counting 20i's own list, stops without a confirm.
    await h.db.update(hostingAccountCheck).set({ results: { items: [], keyWorks: true, packages: 3, types: [{ id: "tawd-wp", label: "TAWD WordPress" }] } });
    await deploy(pm, id);
    expect(await row(id)).toMatchObject({ state: "failed", packageId: null });
    expect((await row(id)).failureReason).toContain(`20i makes a package named ${MOVED} only once the account has a package for vmlpreview.com itself (TAWD's placeholder), and all 25 of Reseller 25's packages are used.`);
    expect((await row(id)).failureReason).toContain("an admin confirms the next plan");
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toEqual([]);
    // Never a dead end (hand review of PR #24): the admin's confirm lets the placeholder, then the preview's package, be made.
    await confirmPackageLimit(h.ctx, admin.viewer, id);
    await deploy(pm, id);
    expect(await row(id)).toMatchObject({ state: "ready", host: MOVED });
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toEqual(["createPackage vmlpreview.com", `createPackage ${MOVED}`]);
  });

  it("stops while 20i is still setting the placeholder up, before the preview's package, and Deploy again carries on", async () => {
    vi.stubEnv("WP_PREVIEW_DOMAIN", "vmlpreview.com");
    const { pm, id } = await ready();
    twentyi.slowSetup.add("vmlpreview.com");
    await deploy(pm, id);
    expect((await row(id)).failureReason).toContain("20i is still setting up vmlpreview.com (TAWD's placeholder package, which lets previews use vmlpreview.com). Deploy again in a few minutes");
    expect(twentyi.calls.filter((c) => c.startsWith("createPackage"))).toEqual(["createPackage vmlpreview.com"]);
    twentyi.finishSetup("vmlpreview.com");
    await deploy(pm, id);
    expect(await row(id)).toMatchObject({ state: "ready", host: MOVED });
    expect(twentyi.calls.filter((c) => c === "createPackage vmlpreview.com")).toHaveLength(1);
  });

  it("leaves a preview whose package is named after the client's domain on 20i's address, and says Remove, then Deploy again (20i, 2 November 2026)", async () => {
    const { pm, id, staging } = await legacyOnStaging();
    expect(moveTarget(await row(id), "vmlpreview.com")).toBeNull();
    expect(needsFreshPackage(await row(id), "vmlpreview.com")).toBe(true);
    await deploy(pm, id);
    // Deploy again keeps it where it is: the preview address is never added to a package named after another domain.
    expect(await row(id)).toMatchObject({ state: "ready", host: staging, packageDomain: "harborpest.com" });
    expect(twentyi.calls.some((c) => c.startsWith("addDomain"))).toBe(false);
    const view = (await loadWpPreview(h.db, id))!;
    expect(view).toMatchObject({ onStaging: true, needsFreshPackage: true });
    const card = renderToStaticMarkup(<WpPreviewSection {...cardProps} host={staging} onStaging needsFreshPackage previewDomain="vmlpreview.com" />);
    expect(card).toContain("Its 20i package is named after the client’s domain");
    expect(card).toContain("Remove the preview (Hosting), then Deploy again.");

    // Remove, then Deploy again: a new package named after the preview address, the old one deleted.
    const oldPackage = (await row(id)).packageId!;
    await removeWpPreview(h.ctx, pm.viewer, id);
    await runWpPreviewJob(queued.at(-1)!.data);
    expect(twentyi.packages.has(oldPackage)).toBe(false);
    // A new package starts empty: its own server, without the old WordPress.
    server = newServer();
    setSshForTesting(sshStandIn(server, targets));
    await deploy(pm, id);
    const fresh = await row(id);
    expect(fresh).toMatchObject({ state: "ready", host: MOVED, packageDomain: MOVED });
    expect(twentyi.packages.get(fresh.packageId!)!.name).toBe(MOVED);
    expect((await loadWpPreview(h.db, id))!.needsFreshPackage).toBe(false);
  });

  it("moves its own package's preview from 20i's address on Deploy again: WP-CLI's search-replace, WordPress's address, then a search for anything left", async () => {
    const { pm, id, staging } = await ownOnStaging();
    expect(moveTarget(await row(id), "vmlpreview.com")).toBe(MOVED);
    await deploy(pm, id);
    expect(await row(id)).toMatchObject({ state: "ready", host: MOVED });
    // The bare host name, every table, PHP's stored data rewritten safely (--precise), guid left alone.
    expect(server.ran.some((c) => c.includes(`search-replace '${staging}' '${MOVED}' --all-tables --skip-columns=guid --precise`))).toBe(true);
    expect(server.home).toBe(`https://${MOVED}`);
    expect(server.data![0]!.value).toContain(`https://${MOVED}/wp-content/logo.png`);
    expect(server.data![1]!.value).toContain(staging);
    expect(server.ran.some((c) => c.includes(`db search '${staging}' --all-tables --table_column_once --matches_only`))).toBe(true);
    expect(await step(id, "wordpress")).toMatchObject({
      state: "done",
      detail: `Already installed; the login is TAWD's. WordPress's address moved from ${staging} to ${MOVED}. Nothing in the database points at ${staging} any more.`,
    });
    expect(cloudflare.zones.get("vmlpreview.com")?.get(MOVED)).toBeDefined();
    expect(twentyi.calls.some((c) => c.startsWith("addDomain"))).toBe(false);
    expect(await logged("site.wp_preview_moved")).toEqual([{ from: staging, to: MOVED, leftovers: `Nothing in the database points at ${staging} any more.` }]);
    expect(laterLog).toEqual([{ data: { projectId: id, action: "move_check", from: staging, to: MOVED, tries: 1 }, delay: MOVE_CHECK_EVERY_MS, jobId: expect.stringMatching(/^wp-move-check-.+-1$/) }]);
    const view = (await loadWpPreview(h.db, id))!;
    expect(view.move).toMatchObject({ state: "checking", to: MOVED });
    expect(view.onStaging).toBe(false);
  });

  it("lists what's still pointing at the old address after the move", async () => {
    const { pm, id, staging } = await ownOnStaging();
    server.data!.push({ table: "wp_postmeta", column: "meta_value", value: `https://${staging}/x`, frozen: true });
    await deploy(pm, id);
    expect(await step(id, "wordpress")).toMatchObject({ state: "warn", detail: expect.stringContaining(`Still pointing at ${staging}: wp_postmeta.meta_value (1).`) });
  });

  it("keeps the move once the moved preview loads, and never starts the placeholder's switch-off check (0.119.0)", async () => {
    const { pm, id } = await ownOnStaging();
    await deploy(pm, id);
    homes.set(MOVED, { ok: true, status: 200, html: WP_HOME, reason: null });
    await runLater();
    expect(await logged("site.wp_preview_move_confirmed")).toHaveLength(1);
    expect((await row(id)).host).toBe(MOVED);
    // A preview's package is now a subdomain package of the preview domain: switching the placeholder off would take it down.
    expect(twentyi.calls.some((c) => c.startsWith("setPackageEnabled"))).toBe(false);
    expect((await holderState()).test).toBeUndefined();
    expect(laterLog).toEqual([]);
    expect((await loadWpPreview(h.db, id))!.move).toMatchObject({ state: "loads" });
  });

  it("gets a certificate that failed at the move again by itself, and gives one just installed time to show (14 October 2026)", async () => {
    const { pm, id, staging } = await ownOnStaging();
    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    // sacplumbingexperts.com's move: acme-client's own look at the check file got a 401 before 20i served the new name.
    setAcmeForTesting(fakeAcme(acmeLog, { message: "Request failed with status code 401" }));
    await deploy(pm, id);
    expect((await row(id)).certs).toMatchObject({ preview: { state: "failed", host: MOVED, note: expect.stringContaining("couldn't read the check file") } });
    const before = acmeLog.length;

    // By the first check (5 minutes later) 20i serves the name: the certificate is got and installed, and the card says so.
    setAcmeForTesting(fakeAcme(acmeLog));
    await runLater();
    expect(acmeLog.length).toBe(before + 1);
    expect((await row(id)).certs).toMatchObject({ preview: { state: "installing", source: "letsencrypt", host: MOVED } });
    expect(await step(id, "cert")).toMatchObject({ state: "warn", detail: expect.stringContaining("Let's Encrypt issued it") });

    // 20i is slow to show it: the checks go on half an hour past the hour before moving back, and never ask Let's Encrypt again.
    for (let n = 2; n < MOVE_CHECK_TRIES + MOVE_CHECK_EXTRA_TRIES; n++) {
      await runLater();
      expect(laterLog).toHaveLength(1);
    }
    await runLater();
    expect(laterLog).toEqual([]);
    expect((await row(id)).host).toBe(staging);
    expect(acmeLog.length).toBe(before + 1);
  });

  it("gives no extra time to a certificate installed longer ago than 20i takes to show one (CodeRabbit, PR #12)", async () => {
    const { pm, id, staging } = await ownOnStaging();
    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    setAcmeForTesting(fakeAcme(acmeLog, { message: "Request failed with status code 401" }));
    await deploy(pm, id);
    setAcmeForTesting(fakeAcme(acmeLog));
    await runLater();
    // As if it was installed 40 minutes ago (the clock in these tests doesn't move).
    const certs = (await row(id)).certs as { preview: Record<string, unknown> };
    await h.db.update(wpPreview).set({ certs: { ...certs, preview: { ...certs.preview, installedAt: new Date(Date.now() - 40 * 60_000).toISOString() } } }).where(eq(wpPreview.projectId, id));
    for (let n = 2; n < MOVE_CHECK_TRIES; n++) await runLater();
    await runLater();
    expect(laterLog).toEqual([]);
    expect((await row(id)).host).toBe(staging);
  });

  it("tries a failing certificate four times in the hour, the deploy's own included, then moves the preview back", async () => {
    const { pm, id, staging } = await ownOnStaging();
    await h.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value: { path: "letsencrypt" } });
    setAcmeForTesting(fakeAcme(acmeLog, { message: "Request failed with status code 401" }));
    await deploy(pm, id);
    const before = acmeLog.length;
    for (let n = 1; n < MOVE_CHECK_TRIES; n++) await runLater();
    await runLater();
    expect(laterLog).toEqual([]);
    expect(acmeLog.length).toBe(before + MOVE_CERT_TRIES.length);
    expect(1 + MOVE_CERT_TRIES.length).toBe(4);
    expect((await row(id)).host).toBe(staging);
  });

  it("moves the preview back by itself when it hasn't loaded within an hour, and the card says why", async () => {
    const { pm, id, staging } = await ownOnStaging();
    await deploy(pm, id);
    for (let n = 1; n < MOVE_CHECK_TRIES; n++) {
      await runLater();
      expect(laterLog).toHaveLength(1);
      expect(laterLog[0]!.data.tries).toBe(n + 1);
    }
    await runLater();
    expect(laterLog).toEqual([]);
    expect((await row(id)).host).toBe(staging);
    expect(server.home).toBe(`https://${staging}`);
    expect(server.ran.some((c) => c.includes(`search-replace '${MOVED}' '${staging}'`))).toBe(true);
    expect(await step(id, "hosting")).toMatchObject({
      state: "warn",
      detail: expect.stringContaining(`Moved back to 20i's own address: ${MOVED} didn't load over HTTPS within an hour (ECONNREFUSED). Deploy again tries ${MOVED} again.`),
    });
    const view = (await loadWpPreview(h.db, id))!;
    expect(view).toMatchObject({ onStaging: true, needsFreshPackage: false, move: { state: "moved_back", to: MOVED } });
    const card = renderToStaticMarkup(<WpPreviewSection {...cardProps} host={staging} onStaging move={view.move} previewDomain="vmlpreview.com" />);
    expect(card).toContain("TAWD moved this preview back to 20i&#x27;s address");
    expect(card).toContain(`Deploy again tries ${MOVED} again`);
    expect(twentyi.calls.some((c) => c.startsWith("setPackageEnabled"))).toBe(false);
    expect(moveTarget(await row(id), "vmlpreview.com")).toBe(MOVED);
  });

  it("a switch-off check already running still waits for 20i each way, watches for 30 minutes, and switches the placeholder back on", async () => {
    const { holderId } = await movedAndLoading();
    const phaseAgo = async (minutes: number) => {
      const st = await holderState();
      await saveHolder({ ...st, test: { ...st.test!, phaseAt: new Date(Date.now() - minutes * 60_000).toISOString() } });
    };
    await runLater();
    expect((await holderState()).test).toMatchObject({ phase: "watching", seq: 2 });
    await runLater();
    expect((await holderState()).test).toMatchObject({ phase: "watching", seq: 3 });
    await phaseAgo(31);
    await runLater();
    expect((await holderState()).test).toMatchObject({ phase: "switching_on", dependsOn: false });
    expect(twentyi.calls.at(-1)).toBe(`setPackageEnabled ${holderId} true`);
    await runLater();
    const done = await holderState();
    expect(done.test).toBeUndefined();
    expect(done.result).toMatchObject({ previewsDependOnIt: false, note: expect.stringContaining("they don't depend on it") });
    expect(await logged("site.wp_preview_holder_test_done")).toHaveLength(1);
    expect(laterLog).toEqual([]);
  });

  it("records that previews depend on the placeholder when the preview stops loading while it's off, and switches it back on", async () => {
    const { holderId } = await movedAndLoading();
    await runLater();
    homes.delete(MOVED);
    await runLater();
    expect((await holderState()).test).toMatchObject({ phase: "switching_on", dependsOn: true });
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
    await runLater();
    expect((await holderState()).result).toMatchObject({ previewsDependOnIt: true, note: expect.stringContaining("Previews depend on the placeholder") });
  });

  it("never leaves the placeholder off: the worker's start queues the next step again, the daily job switches it on after a silent half hour, the hourly watch when found off", async () => {
    const { id, holderId } = await movedAndLoading();
    laterLog = [];
    expect(await recoverPreviewHolder("start")).toBe("The placeholder's switch-off check carries on.");
    expect(laterLog).toEqual([{ data: { projectId: id, action: "holder_test" }, delay: 0, jobId: "wp-holder-test-1" }]);
    expect(await recoverPreviewHolder("daily")).toBeNull();
    await h.db.update(appSetting).set({ updatedAt: new Date(Date.now() - 40 * 60_000) }).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING));
    expect(await recoverPreviewHolder("daily")).toContain("being switched back on");
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
    expect((await holderState()).test).toMatchObject({ phase: "switching_on", reason: "the check was interrupted" });
    await runLater();
    expect((await holderState()).result).toMatchObject({ previewsDependOnIt: null, note: expect.stringContaining("the check was interrupted") });
    // With no check running, a placeholder found off is the hourly watch's (0.122.0, holder-watch.test.ts): the daily job leaves it.
    twentyi.packages.get(holderId)!.enabled = false;
    expect(await recoverPreviewHolder("daily")).toBeNull();
    expect(await runHolderWatch()).toContain("The placeholder was off: asked back on.");
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
    expect(await logged("site.wp_preview_holder_switched_on")).toHaveLength(1);
  });

  it("refuses to suspend or remove the placeholder's package", async () => {
    const { id, holderId } = await movedAndLoading();
    await h.db.update(wpPreview).set({ packageId: holderId }).where(eq(wpPreview.projectId, id));
    await expect(runWpPreviewJob({ projectId: id, action: "suspend", by: "someone" })).rejects.toThrow("is TAWD's placeholder for the preview domain");
    await h.db.update(wpPreview).set({ state: "removing" }).where(eq(wpPreview.projectId, id));
    await expect(runWpPreviewJob({ projectId: id, action: "remove" })).rejects.toThrow("TAWD never suspends or removes it");
    expect(twentyi.packages.has(holderId)).toBe(true);
  });

  it("shows the placeholder on System's 20i check, with the switch-off check's state", async () => {
    const { holderId } = await movedAndLoading();
    const [check] = await h.db.insert(hostingAccountCheck).values({ status: "queued" }).returning();
    await runTwentyiCheckJob({ checkId: check!.id });
    const [done] = await h.db.select().from(hostingAccountCheck).where(eq(hostingAccountCheck.id, check!.id));
    const item = (done!.results as { items: { key: string; state: string; detail: string }[] }).items.find((i) => i.key === "holder");
    expect(item).toMatchObject({ state: "yes", detail: expect.stringContaining(`Package ${holderId}`) });
    expect(item!.detail).toContain("Never suspend or delete it in My20i. The switch-off check is running.");
  });

  it("never counts a redirect to another site as the moved preview loading (CodeRabbit, PR #3)", async () => {
    const { pm, id } = await ownOnStaging();
    await deploy(pm, id);
    setHomeFetchForTesting(null);
    vi.stubGlobal("fetch", async () => ({ url: "https://someone-else.example/", ok: true, status: 200, text: async () => WP_HOME }));
    try {
      await runLater();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await logged("site.wp_preview_move_confirmed")).toHaveLength(0);
    expect(laterLog[0]!.data).toMatchObject({ action: "move_check", tries: 2 });
  });

  it("stops a running switch-off check and switches the placeholder back on when another preview goes onto the domain (CodeRabbit, PR #3)", async () => {
    const { admin, holderId } = await movedAndLoading();
    const other = await createProject(h.ctx, admin.viewer, { ...base, clientName: "Kelly Glass" });
    await h.db
      .insert(wpPreview)
      .values({ projectId: other, name: "kelly-glass", packageDomain: "kelly-glass.vmlpreview.com", host: "kelly-glass.vmlpreview.com", dbPasswordEncrypted: "x", adminUser: "tawd", adminPasswordEncrypted: "x", state: "deploying" } as never);
    await runLater();
    expect((await holderState()).test).toMatchObject({ phase: "switching_on", reason: "another preview went onto vmlpreview.com, so the check was stopped" });
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
  });

  it("reads WP-CLI's search output and what counts as left over, and only moves previews whose own package is on 20i's address", () => {
    expect(parseDbSearch("wp_options:option_value\n1:old.example\n2:old.example\nwp_posts:guid\n9:old.example\nSuccess: Found 3 matches")).toEqual([
      { table: "wp_options", column: "option_value", count: 2 },
      { table: "wp_posts", column: "guid", count: 1 },
    ]);
    expect(leftovers(parseDbSearch("wp_posts:guid\n9:old.example"))).toEqual([]);
    expect(looksLikeWordPress(WP_HOME)).toBe(true);
    expect(looksLikeWordPress("<html>This site is disabled</html>")).toBe(false);
    const one = { name: "harbor-pest", packageId: "1001", packageDomain: MOVED, liveState: null };
    expect(moveTarget({ ...one, host: OWN_STAGING }, "vmlpreview.com")).toBe(MOVED);
    expect(moveTarget({ ...one, host: OWN_STAGING }, null)).toBeNull();
    expect(moveTarget({ ...one, host: MOVED }, "vmlpreview.com")).toBeNull();
    expect(moveTarget({ ...one, host: OWN_STAGING, liveState: "live" }, "vmlpreview.com")).toBeNull();
    expect(moveTarget({ ...one, packageId: null, host: OWN_STAGING }, "vmlpreview.com")).toBeNull();
    // A package named after the client's domain never moves: Remove, then Deploy again.
    const legacy = { ...one, packageDomain: "harborpest.com", host: "harborpest-com.stackstaging.com" };
    expect(moveTarget(legacy, "vmlpreview.com")).toBeNull();
    expect(needsFreshPackage(legacy, "vmlpreview.com")).toBe(true);
    expect(needsFreshPackage({ ...legacy, liveState: "live" }, "vmlpreview.com")).toBe(false);
    // Once the client's domain is on the package (an early Connect the domain, a go-live that stopped), never Remove: it stays put.
    expect(needsFreshPackage({ ...legacy, domainOnHostAt: new Date() }, "vmlpreview.com")).toBe(false);
    expect(needsFreshPackage({ ...legacy, liveState: "failed" }, "vmlpreview.com")).toBe(false);
    expect(keepsLegacyPackage({ ...legacy, domainOnHostAt: new Date() }, "vmlpreview.com")).toBe(true);
    expect(keepsLegacyPackage(legacy, "vmlpreview.com")).toBe(false);
    const kept = renderToStaticMarkup(<WpPreviewSection {...cardProps} host={legacy.host} onStaging keepsLegacyPackage previewDomain="vmlpreview.com" />);
    expect(kept).toContain("so TAWD leaves it where it is");
    expect(kept).not.toContain("Remove the preview (Hosting), then Deploy again.");
    expect(needsFreshPackage({ ...one, host: OWN_STAGING }, "vmlpreview.com")).toBe(false);
    expect(needsFreshPackage(legacy, null)).toBe(false);
  });

  const cardProps = { projectId: "p1", state: "ready" as const, host: MOVED, version: 1, deployedVersion: 1, latestBuild: 1, https: true, steps: [], removing: false, blockers: [], canDeploy: true, isAdmin: false, statusLine: null };

  it("the card says while the moved preview is being checked, and that Deploy again moves a staging preview with its own package", () => {
    const checking = renderToStaticMarkup(<WpPreviewSection {...cardProps} move={{ state: "checking", to: MOVED, reason: null }} />);
    expect(checking).toContain("Moved here from 20i");
    expect(checking).toContain("TAWD moves it back to 20i’s address by itself");
    const staging = renderToStaticMarkup(<WpPreviewSection {...cardProps} host="x.stackstaging.com" onStaging previewDomain="vmlpreview.com" />);
    expect(staging).toContain("Deploy again moves it to vmlpreview.com, on 20i&#x27;s real servers.");
  });
});
