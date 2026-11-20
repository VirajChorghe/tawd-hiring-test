import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Audit F-005 (12 November 2026): after "Speed up this build" the consent
  banner's buttons did nothing and the banner could not be closed. The
  finishing step saves pages as the browser rewrote them (`hidden` becomes
  `hidden=""`); the speed pass's cleanup then failed to recognise TAWD's
  own banner and took its onclick away; and the go-live check was copied
  from the old version instead of being run again, so it still said OK.
  Real Chrome runs the speed pass here, as it does in the worker.
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

import { setDbForTesting, type Database } from "@tawd/core/db";
import { getStorage, projectStoragePrefix, setStorageForTesting } from "@tawd/core/intake/storage";
import type { SiteBuildJobData } from "@tawd/core/queue";
import { projectTracking, siteBuild } from "@tawd/core/schema";
import { consentBanner, consentBannerWorks, stripActiveContent, type TrackingConfig } from "@tawd/core/site";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { startSpeedUp } from "@/lib/site-builds";
import type { WorkerConfig } from "../../../worker/src/config";
import { runSiteBuildJob } from "../../../worker/src/site-build";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude } from "./worker-fakes";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);
const require = createRequire(import.meta.url);
type Browser = Parameters<typeof runSiteBuildJob>[3];
let browser: Browser;
let h: Harness;
let queued: { name: string; data: SiteBuildJobData }[];
const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteBuildJobData }), getJob: async () => null });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const banner = consentBanner({ consentMode: "opt_in" } as TrackingConfig, { floor: "opt_out", honorGpc: false, symmetricalButtons: false, optOutHonoredNotice: false, privacyChoicesLink: false });
// The banner as the finishing step saved it: what Chrome's outerHTML gave back in the audit's run.
const savedBanner = banner.replace(" hidden><p>", ' hidden=""><p>');
const page = (title: string, consent: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><script>window.tawdConsent=function(){}</script></head><body><header><a href="/">Home</a></header><main id="main"><h1>${title}</h1><p>Words.</p></main><footer><a href="/privacy/" data-tawd-optout="">Do not sell or share my information</a></footer>${consent}</body></html>`;

async function seedVersion(consent: string) {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Synthetic Awning Co", trade: "home_services", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [] } as never);
  await h.db.insert(projectTracking).values({ projectId: id, ga4: "G-TEST000000", consentMode: "opt_in" });
  const prefix = `${projectStoragePrefix(id)}site/v1/`;
  await getStorage().put(`${prefix}index.html`, Buffer.from(page("Home", consent)), "text/html");
  await getStorage().put(`${prefix}privacy/index.html`, Buffer.from(page("Privacy", consent)), "text/html");
  await h.db.insert(siteBuild).values({
    projectId: id,
    version: 1,
    status: "done",
    checks: [{ key: "tracking", label: "Tracking codes behind the visitor's consent", ok: true, detail: "2 pages; consent: ask first", blocksGoLive: true }],
  } as never);
  await startSpeedUp(h.ctx, admin.viewer, id);
  await runSiteBuildJob(queued.at(-1)!.data, config, fakeClaude(() => []).client as never, browser);
  const [v2] = await h.db.select().from(siteBuild).where(eq(siteBuild.version, 2));
  const html = (await getStorage().get(`${projectStoragePrefix(id)}site/v2/index.html`))!.toString("utf8");
  return { v2: v2!, html, tracking: (v2!.checks as { key: string; ok: boolean; detail: string }[]).find((c) => c.key === "tracking")! };
}

describe.skipIf(!hasChrome)("Speed up this build and the consent banner", () => {
  it("keeps TAWD's banner working when the saved page has the browser's spelling of it", async () => {
    const { v2, html, tracking } = await seedVersion(savedBanner);
    expect(v2.status).toBe("done");
    expect(consentBannerWorks(html)).toBe(true);
    expect(html).toContain("tawdConsent('granted')");
    expect(tracking).toMatchObject({ ok: true });
  }, 120_000);

  it("runs the tracking check again instead of copying it, so a banner already broken is reported", async () => {
    const { tracking } = await seedVersion(stripActiveContent(banner));
    expect(tracking.ok).toBe(false);
    expect(tracking.detail).toContain("The cookie banner's buttons don't work on index.html");
  }, 120_000);
});
