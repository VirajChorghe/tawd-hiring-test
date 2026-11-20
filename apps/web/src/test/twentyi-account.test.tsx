import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build B on 20i (5 October 2026): System's 20i section. TAWD's own 20i SSH
  key (admins, logged, the private half never shown), Check the 20i account
  (a worker job: the API key is on the worker only), the package type, the
  HTTPS way for WordPress sites, the remembered server keys, and when the
  daily work last ran. Replaces bluehost.test.tsx. Nothing reaches 20i.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/admin/system",
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
import { activityLog, appSetting, hostingAccountCheck, serviceHeartbeat, sshKey } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { TWENTYI_CHECK_JOB } from "@tawd/core/queue";
import { decryptSecret, setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { SSH_HOST_KEYS_SETTING } from "@tawd/core/ssh-keys";
import { ENV_VARS } from "@tawd/core/settings-check";
import { TWENTYI_PACKAGE_TYPE_SETTING, WP_SITES_DAILY_SETTING } from "@tawd/core/wp-preview";
import { setQueueForTesting } from "@/lib/mockups";
import { chooseCertPath, choosePackageType, forgetServerKey, loadTwentyi, makeTwentyiKey, startTwentyiCheck, TwentyiSettingsError } from "@/lib/twentyi";
import { CertPathCard, TwentyiCheckCard, TwentyiKeyCard } from "@/components/admin/twentyi-cards";

import { runTwentyiCheckJob } from "../../../worker/src/twentyi-check";
import { setTwentyiForTesting, TwentyiError } from "../../../worker/src/twentyi";
import { FakeTwentyi } from "../../../worker/src/twentyi-fake";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
let queued: { name: string; data: { checkId: string } }[];
let twentyi: FakeTwentyi;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
  twentyi = new FakeTwentyi();
  setTwentyiForTesting(twentyi);
});

afterEach(async () => {
  setTwentyiForTesting(null);
  setQueueForTesting(null);
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

describe("TAWD's 20i SSH key", () => {
  it("is made by an admin only, kept encrypted, logged by fingerprint only, and replaced on purpose", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(makeTwentyiKey(h.ctx, pm.viewer, false)).rejects.toBeInstanceOf(PermissionError);
    await makeTwentyiKey(h.ctx, admin.viewer, false);
    const [key] = await h.db.select().from(sshKey).where(eq(sshKey.purpose, "twentyi"));
    expect(key!.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ tawd-20i@velocitymedialab\.com$/);
    expect(key!.privateKeyEncrypted).not.toContain("OPENSSH");
    expect(decryptSecret(key!.privateKeyEncrypted)).toContain("BEGIN OPENSSH PRIVATE KEY");
    await expect(makeTwentyiKey(h.ctx, admin.viewer, false)).rejects.toBeInstanceOf(TwentyiSettingsError);
    await makeTwentyiKey(h.ctx, admin.viewer, true);
    const log = await h.db.select().from(activityLog).where(eq(activityLog.action, "twentyi.key_made"));
    expect(log).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain("PRIVATE KEY");
    const card = renderToStaticMarkup(<TwentyiKeyCard publicKey={key!.publicKey} fingerprint={key!.fingerprint} madeLine="Made today." />);
    expect(card).toContain(key!.fingerprint);
    expect(card).toContain("My20i, Security, SSH keys");
  });
});

describe("Check the 20i account", () => {
  it("is queued by an admin, run by the worker through the API (read-only), and lists the types and the packages used", async () => {
    const admin = await seedAdmin(h);
    twentyi.others = 22;
    await startTwentyiCheck(h.ctx, admin.viewer);
    await expect(startTwentyiCheck(h.ctx, admin.viewer)).rejects.toThrow("already running");
    expect(queued.map((q) => q.name)).toEqual([TWENTYI_CHECK_JOB]);
    await runTwentyiCheckJob(queued[0]!.data);
    const view = await loadTwentyi(h.db);
    expect(view.check).toMatchObject({ status: "done", results: { keyWorks: true, packages: 22, types: [{ id: "tawd-wp", label: "TAWD WordPress" }] } });
    // 20 or more (Reseller 25): amber, with how many are left before the next plan.
    expect(view.check!.results!.items.find((i) => i.key === "packages")).toMatchObject({ state: "warn", detail: "22 of 25: 3 left before Reseller 50." });
    // Read-only: nothing made, changed or deleted at 20i.
    // 20i's API has no list of data centres (20i.apib), so the check doesn't ask for one.
    expect(twentyi.calls).toEqual(["listPackages", "listPackageTypes"]);
  });

  it("says plainly when the key is missing or wrong, and where it goes (the worker only)", async () => {
    const admin = await seedAdmin(h);
    twentyi.refuse.listPackages = new TwentyiError("20i refused TAWD's API key. Check TWENTYI_API_KEY on the worker (tawd-worker-new): it's the General API key from My20i, Reseller API.", "auth", 401);
    await startTwentyiCheck(h.ctx, admin.viewer);
    await runTwentyiCheckJob(queued[0]!.data);
    const [check] = await h.db.select().from(hostingAccountCheck);
    expect(check!.results).toMatchObject({ keyWorks: false, items: [{ key: "key", state: "no", detail: expect.stringContaining("TWENTYI_API_KEY on the worker") }] });
    expect(twentyi.calls).toEqual(["listPackages"]);
    const card = renderToStaticMarkup(<TwentyiCheckCard keySet={false} state={null} doneLine={null} failure={null} items={[]} types={[]} chosen={null} chosenLine={null} />);
    expect(card).toContain("tawd-worker-new only (never the web app)");
  });

  it("lets an admin choose the package type it listed, and only that", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(choosePackageType(h.ctx, admin.viewer, "tawd-wp")).rejects.toThrow("the last 20i check listed");
    await startTwentyiCheck(h.ctx, admin.viewer);
    await runTwentyiCheckJob(queued[0]!.data);
    await expect(choosePackageType(h.ctx, pm.viewer, "tawd-wp")).rejects.toBeInstanceOf(PermissionError);
    await expect(choosePackageType(h.ctx, admin.viewer, "other")).rejects.toBeInstanceOf(TwentyiSettingsError);
    await choosePackageType(h.ctx, admin.viewer, "tawd-wp");
    const [type] = await h.db.select().from(appSetting).where(eq(appSetting.key, TWENTYI_PACKAGE_TYPE_SETTING));
    expect(type!.value).toMatchObject({ id: "tawd-wp", label: "TAWD WordPress" });
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "twentyi.package_type_chosen"))).toHaveLength(1);
  });
});

describe("HTTPS, server keys and the daily work on System", () => {
  it("chooses the HTTPS way (by hand until day one decides), logged", async () => {
    const admin = await seedAdmin(h);
    expect((await loadTwentyi(h.db)).certPath).toBe("manual");
    await expect(chooseCertPath(h.ctx, admin.viewer, "free-for-all")).rejects.toBeInstanceOf(TwentyiSettingsError);
    await chooseCertPath(h.ctx, admin.viewer, "letsencrypt");
    await chooseCertPath(h.ctx, admin.viewer, "letsencrypt");
    expect((await loadTwentyi(h.db)).certPath).toBe("letsencrypt");
    const log = await h.db.select().from(activityLog).where(eq(activityLog.action, "twentyi.cert_path_chosen"));
    expect(log.map((l) => [l.valueBefore, l.valueAfter])).toEqual([[{ path: "manual" }, { path: "letsencrypt" }]]);
    const view = await loadTwentyi(h.db);
    const card = renderToStaticMarkup(<CertPathCard path={view.certPath} paths={view.certPaths} previewDomain={null} acmeStaging />);
    expect(card).toContain("20i&#x27;s certificate ($34.99 a year per site)");
    expect(card).toContain("test certificates that browsers don");
    expect(card).toContain("staging address, which the speed gate can");
  });

  it("forgets a remembered server key on an admin's word only, logged", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await h.db.insert(appSetting).values({ key: SSH_HOST_KEYS_SETTING, value: { "ssh.us.stackcp.com": { fingerprint: "SHA256:twentyigatewaykey0000000000000000000000000", firstSeenAt: "2026-10-05T10:00:00Z" } } });
    expect((await loadTwentyi(h.db)).serverKeys).toEqual([{ host: "ssh.us.stackcp.com", fingerprint: "SHA256:twentyigatewaykey0000000000000000000000000", firstSeenAt: "2026-10-05T10:00:00Z" }]);
    await expect(forgetServerKey(h.ctx, pm.viewer, "ssh.us.stackcp.com")).rejects.toBeInstanceOf(PermissionError);
    await expect(forgetServerKey(h.ctx, admin.viewer, "ssh.uk.stackcp.com")).rejects.toBeInstanceOf(TwentyiSettingsError);
    await forgetServerKey(h.ctx, admin.viewer, "ssh.us.stackcp.com");
    expect((await loadTwentyi(h.db)).serverKeys).toEqual([]);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "ssh.host_key_forgotten"))).toHaveLength(1);
  });

  it("says when the daily work last ran, amber after two days", async () => {
    expect((await loadTwentyi(h.db)).daily).toMatchObject({ finishedAt: null, late: true });
    await h.db.insert(appSetting).values({ key: WP_SITES_DAILY_SETTING, value: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: { sites: 2 } } });
    expect((await loadTwentyi(h.db)).daily).toMatchObject({ late: false, summary: { sites: 2 } });
    await h.db.update(appSetting).set({ value: { finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } }).where(eq(appSetting.key, WP_SITES_DAILY_SETTING));
    expect((await loadTwentyi(h.db)).daily.late).toBe(true);
  });

  it("reads the worker's settings by name only; TWENTYI_API_KEY is the worker's alone and Cloudflare's pair is on both", async () => {
    await h.db.insert(serviceHeartbeat).values({ service: "worker", version: "0.88.0", startedAt: new Date(), env: { TWENTYI_API_KEY: true, CLOUDFLARE_API_TOKEN: true, CLOUDFLARE_ACCOUNT_ID: false } });
    expect((await loadTwentyi(h.db)).workerSettings).toEqual({ missing: [], previewDomain: false, cloudflare: false, acmeStaging: false });
    const services = (name: string) => ENV_VARS.find((v) => v.name === name)!.services;
    expect(services("TWENTYI_API_KEY")).toEqual(["worker"]);
    expect(services("WP_PREVIEW_DOMAIN")).toEqual(["web", "worker"]);
    expect(services("CLOUDFLARE_API_TOKEN")).toEqual(["web", "worker"]);
    expect(services("CLOUDFLARE_ACCOUNT_ID")).toEqual(["web", "worker"]);
    expect(ENV_VARS.some((v) => v.name.startsWith("BLUEHOST_"))).toBe(false);
  });
});
