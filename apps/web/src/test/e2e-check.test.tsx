import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { unzipSync } from "fflate";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The end-to-end check (29 September 2026): a test project built with
  stand-in answers by the real worker code in a real Chrome, deployed to a
  stand-in Netlify, and its share link opened from exactly the files the
  deploy sent. Run twice: the second run removes the first's project and
  its Netlify site. Skipped where Chrome isn't installed.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import type { SiteBuildJobData } from "@tawd/core/queue";
import { activityLog, aiCall, appSetting, e2eCheck, project as projectTable, projectSlack, siteBuild } from "@tawd/core/schema";
import { E2E_CHECK_CLIENT } from "@tawd/core/site";
import { E2eCheckCard } from "@/components/admin/e2e-check-card";
import { loadE2eCheck, setE2eCheckForTesting, settleE2eChecks, startE2eCheck } from "@/lib/e2e-check";
import { setQueueForTesting } from "@/lib/mockups";
import { setNetlifyFetchForTesting, settleDeploys } from "@/lib/netlify";
import { createProject } from "@/lib/projects";

import type { WorkerConfig } from "../../../worker/src/config";
import { runStandInSiteBuild, standInTurnsFor } from "../../../worker/src/e2e-check";
import { replayingClient } from "../../../worker/src/replay";
import { markSiteBuildFailed } from "../../../worker/src/site-build";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeClaude } from "./worker-fakes";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof runStandInSiteBuild>[3];
let browser: Browser;
let h: Harness;
const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});

let deployed: Record<string, Uint8Array> = {};
let netlifyCalls: string[] = [];
let aiClient: ReturnType<typeof fakeClaude>;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  vi.stubEnv("NETLIFY_AUTH_TOKEN", "nf-test-token");
  netlifyCalls = [];
  aiClient = fakeClaude(() => []);
  // The worker, in the same process: a queued build runs on the stand-ins.
  setQueueForTesting({
    add: async (_name, data) => {
      const job = data as SiteBuildJobData;
      void runStandInSiteBuild(job, config, replayingClient(aiClient.client as never), browser).catch((error: Error) => markSiteBuildFailed(job.buildId, error.message));
    },
    getJob: async () => null,
  });
  // Netlify: the zip it would publish is kept, and the "share link" is served from it, headers included.
  setNetlifyFetchForTesting(
    (async (url: string, init?: RequestInit) => {
      const p = url.replace("https://api.netlify.com/api/v1", "");
      netlifyCalls.push(`${init?.method ?? "GET"} ${p}`);
      if (p === "/sites" && init?.method === "POST") return Response.json({ id: "site-check", name: "tawd-check", ssl_url: "https://tawd-check.netlify.app", admin_url: "https://app.netlify.com/sites/tawd-check" });
      if (/\/deploys(\?draft=true)?$/.test(p)) {
        deployed = unzipSync(init!.body as Uint8Array);
        return Response.json({ id: "deploy-1", state: "uploaded", deploy_ssl_url: "https://abc--tawd-check.netlify.app" });
      }
      if (p.startsWith("/deploys/")) return Response.json({ state: "ready", deploy_ssl_url: "https://abc--tawd-check.netlify.app" });
      if (p.startsWith("/sites/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({});
    }) as never,
    async () => undefined,
  );
  setE2eCheckForTesting({
    sleep: () => new Promise((resolve) => setTimeout(resolve, 50)),
    fetch: async (url: string) => {
      // The app's own stage pages: signed out, each asks you to sign in (it exists).
      if (url.includes("/projects/")) return new Response(null, { status: 307, headers: { location: "/login" } });
      const p = new URL(url).pathname.replace(/^\//, "");
      const file = deployed[p] ?? deployed[`${p}index.html`] ?? deployed[`${p}/index.html`];
      if (!file) return new Response("Not found", { status: 404 });
      const headers = new Headers({ "content-type": /\.html$|\/$|^$/.test(p) || !path.extname(p) ? "text/html" : /\.png$/.test(p) ? "image/png" : /\.jpe?g$/.test(p) ? "image/jpeg" : /\.css$/.test(p) ? "text/css" : /\.woff2$/.test(p) ? "font/woff2" : "text/plain" });
      if (/X-Robots-Tag:\s*noindex/i.test(new TextDecoder().decode(deployed["_headers"] ?? new Uint8Array()))) headers.set("x-robots-tag", "noindex, nofollow");
      return new Response(Buffer.from(file), { status: 200, headers });
    },
  });
});

afterEach(async () => {
  setE2eCheckForTesting(null);
  setNetlifyFetchForTesting(null);
  setQueueForTesting(null);
  vi.unstubAllEnvs();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

describe.skipIf(!hasChrome)("the end-to-end check", () => {
  it("builds, deploys and opens the share link for $0; a second run replaces the first's project and Netlify site", async () => {
    const admin = await seedAdmin(h);
    // With a team channel set, the check's own test project still never joins it (0.118.0).
    await h.db.insert(appSetting).values({ key: "team_slack", value: { webhookEncrypted: "encrypted-team-webhook", hint: "WXYZ", connectedAt: new Date().toISOString() } });
    await startE2eCheck(h.ctx, admin.viewer);
    await expect(startE2eCheck(h.ctx, admin.viewer)).rejects.toThrow("already running");
    await settleE2eChecks();
    await settleDeploys();
    let check = (await loadE2eCheck(h.db))!;
    expect(check.steps.map((s) => [s.key, s.status, s.status === "failed" ? s.detail : ""])).toEqual([
      ["clear", "passed", ""],
      ["project", "passed", ""],
      ["stages", "passed", ""],
      ["build", "passed", ""],
      ["deploy", "passed", ""],
      ["link", "passed", ""],
    ]);
    expect(check.status).toBe("passed");
    expect(await h.db.select().from(projectSlack).where(eq(projectSlack.projectId, check.projectId!))).toHaveLength(0);
    expect(check.previewUrl).toBe("https://abc--tawd-check.netlify.app");
    expect(aiClient.calls).toHaveLength(0);
    expect(await h.db.select().from(aiCall)).toHaveLength(0);
    expect(Object.keys(deployed).some((k) => /^images\/home\/design-image-1\.(png|jpg)$/.test(k))).toBe(true);

    const html = renderToStaticMarkup(<E2eCheckCard status={check.status} steps={check.steps} previewUrl={check.previewUrl} projectId={check.projectId} doneLine="Run today." />);
    expect(html).toContain("Passed. Run today.");
    expect(html).toContain("Run the check again ($0)");

    // Again: the first test project and its Netlify site go; a real project with the same name stays (13 October 2026).
    const firstProject = check.projectId!;
    const real = await createProject(h.ctx, admin.viewer, { clientName: E2E_CHECK_CLIENT, trade: "home_services", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "intake", memberUserIds: [] });
    await startE2eCheck(h.ctx, admin.viewer);
    await settleE2eChecks();
    await settleDeploys();
    check = (await loadE2eCheck(h.db))!;
    expect(check.status).toBe("passed");
    expect(check.steps[0]!.detail).toBe("Removed 1 test project.");
    expect(await h.db.select().from(projectTable).where(eq(projectTable.id, firstProject))).toHaveLength(0);
    expect(await h.db.select().from(projectTable).where(eq(projectTable.id, real))).toHaveLength(1);
    expect(netlifyCalls).toContain("DELETE /sites/site-check");
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "system.e2e_check"))).map((e) => (e.valueAfter as { result?: string }).result).filter(Boolean)).toEqual(["passed", "passed"]);
  }, 300_000);

  it("after a deploy, stops before Netlify: no deploy, no credits used (Jason, 1 October 2026)", async () => {
    const admin = await seedAdmin(h);
    await startE2eCheck(h.ctx, admin.viewer, { automatic: { version: "0.75.2" } });
    await settleE2eChecks();
    await settleDeploys();
    const check = (await loadE2eCheck(h.db))!;
    expect(check.steps.map((s) => [s.key, s.status])).toEqual([
      ["clear", "passed"],
      ["project", "passed"],
      ["stages", "passed"],
      ["build", "passed"],
    ]);
    expect(check.status).toBe("passed");
    expect(netlifyCalls.some((c) => c.includes("/deploys"))).toBe(false);
  }, 300_000);

  it("says which step failed and why, and never runs stand-ins for a client's project or for a non-admin", async () => {
    const admin = await seedAdmin(h);
    // Netlify keeping the preview private: the last step fails, naming the setting.
    setE2eCheckForTesting({ sleep: () => new Promise((resolve) => setTimeout(resolve, 50)), fetch: async () => new Response("Private project", { status: 401 }) });
    await startE2eCheck(h.ctx, admin.viewer);
    await settleE2eChecks();
    await settleDeploys();
    const check = (await loadE2eCheck(h.db))!;
    expect(check.status).toBe("failed");
    const link = check.steps.find((s) => s.key === "link")!;
    expect(link.status).toBe("failed");
    expect(link.detail).toContain("/ is refused to visitors (401). Netlify is keeping this preview private");
    expect(renderToStaticMarkup(<E2eCheckCard status={check.status} steps={check.steps} previewUrl={check.previewUrl} projectId={check.projectId} doneLine={null} />)).toContain("Failed at the step marked below.");

    const client = await createProject(h.ctx, admin.viewer, { clientName: "Nora", trade: "photography", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: null, status: "mockups", memberUserIds: [] });
    await expect(standInTurnsFor(client)).rejects.toThrow("only for the end-to-end check's own project");
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(startE2eCheck(h.ctx, pm.viewer)).rejects.toThrow();
    expect((await h.db.select().from(projectTable).where(eq(projectTable.clientName, E2E_CHECK_CLIENT))).length).toBe(1);
    expect(await h.db.select().from(siteBuild)).toHaveLength(1);
    expect((await h.db.select().from(e2eCheck)).length).toBe(1);
  }, 300_000);
});
