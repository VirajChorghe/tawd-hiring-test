import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The Speed check (1 October 2026): Google PageSpeed on a project's
  Netlify and WordPress previews, phone and computer, from the Build page,
  before anything goes live. Google is a stand-in here.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects/p1/build",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/app/actions", () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => ({ ok: true })), has: () => true }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, goLive, netlifySite, siteBuild, siteDeploy, speedCheck, wpPreview } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { SPEED_CHECK_JOB } from "@tawd/core/queue";
import { goLiveGate, pageSpeedUrl, readPageSpeed, scoreBand } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { loadSpeedChecks, overrideSpeed, speedForGate, SpeedCheckError, startSpeedCheck } from "@/lib/speed-check";
import { startSpeedUp } from "@/lib/site-builds";
import { SiteError } from "@/lib/site-builds";
import { SpeedCheckCard } from "@/components/build/speed-check-card";
import { runSpeedCheckJob, setSpeedCheckFetchForTesting } from "../../../worker/src/speed-check";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
let queued: { name: string; data: { checkId: string } }[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setSpeedCheckFetchForTesting(null);
  vi.unstubAllEnvs();
  setDbForTesting(null);
  await h.close();
});

/* PageSpeed's answer, the parts TAWD reads. */
const answer = (performance: number, crawlable = 0) => ({
  lighthouseResult: {
    categories: { performance: { score: performance }, accessibility: { score: 0.96 }, "best-practices": { score: 1 }, seo: { score: 0.61 } },
    audits: {
      "first-contentful-paint": { title: "First Contentful Paint", score: 0.4, scoreDisplayMode: "numeric", displayValue: "3.3 s" },
      "largest-contentful-paint": { title: "Largest Contentful Paint", score: 0.1, scoreDisplayMode: "numeric", displayValue: "6.0 s" },
      "cumulative-layout-shift": { title: "Cumulative Layout Shift", score: 1, scoreDisplayMode: "numeric", displayValue: "0.031" },
      "render-blocking-insight": { title: "Render-blocking requests", score: 0, scoreDisplayMode: "metricSavings", displayValue: "Est savings of 2,890 ms" },
      "image-delivery-insight": { title: "Improve image delivery", score: 0.5, scoreDisplayMode: "metricSavings", displayValue: "Est savings of 1,279 KiB" },
      "link-name": { title: "Links do not have a discernible name", score: 0, scoreDisplayMode: "binary" },
      "is-crawlable": { title: "Page is blocked from indexing", score: crawlable, scoreDisplayMode: "binary" },
      "dom-size-insight": { title: "Optimize DOM size", score: null, scoreDisplayMode: "informative" },
    },
  },
});

describe("Google's answer", () => {
  it("is read into the four scores, the timings and the main things to fix, worst first", () => {
    const read = readPageSpeed(answer(0.69))!;
    expect(read.scores).toEqual({ performance: 69, accessibility: 96, bestPractices: 100, seo: 61 });
    expect(read.metrics).toMatchObject({ fcp: "3.3 s", lcp: "6.0 s", cls: "0.031" });
    expect(read.issues).toEqual([
      { title: "Render-blocking requests", saves: "Est savings of 2,890 ms" },
      { title: "Links do not have a discernible name", saves: null },
      { title: "Improve image delivery", saves: "Est savings of 1,279 KiB" },
    ]);
    expect(read.hiddenFromSearch).toBe(true);
    expect(readPageSpeed({ error: { message: "x" } })).toBeNull();
    expect([95, 89, 49, null].map(scoreBand)).toEqual(["good", "fair", "poor", "none"]);
    expect(pageSpeedUrl("https://nora.example/", "mobile", "k1")).toBe("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https%3A%2F%2Fnora.example%2F&strategy=mobile&category=performance&category=accessibility&category=best-practices&category=seo&key=k1");
  });
});

describe("the Speed check", () => {
  const setup = async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "pro", clientName: "Nora Beagle Site" });
    return { admin, pm, content, id };
  };
  // Previews are drafts (13 October 2026): the check opens the latest preview's own address.
  const readyPreview = async (projectId: string) => {
    const [build] = await h.db.insert(siteBuild).values({ projectId, version: 1, status: "done", checks: [] } as never).returning();
    await h.db.insert(siteDeploy).values({ projectId, buildId: build!.id, version: 1, state: "ready", url: "https://abc123--tawd-nora.netlify.app", readyAt: new Date() } as never);
  };

  it("runs on each preview, phone and computer, started by a PM, and keeps the scores", async () => {
    const { pm, content, id } = await setup();
    await expect(startSpeedCheck(h.ctx, pm.viewer, id, "netlify")).rejects.toThrow("Deploy the Netlify preview first.");
    await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-nora", url: "https://tawd-nora.netlify.app" } as never);
    await readyPreview(id);
    await h.db.insert(wpPreview).values({ projectId: id, name: "nora-beagle-site", host: "nora-beagle-site.fba.ici.mybluehost.me", dir: "x", dbName: "x", dbUser: "x", dbPasswordEncrypted: "x", adminUser: "x", adminPasswordEncrypted: "x", state: "ready", deployedVersion: 3 } as never);
    await expect(startSpeedCheck(h.ctx, content.viewer, id, "netlify")).rejects.toBeInstanceOf(PermissionError);

    await startSpeedCheck(h.ctx, pm.viewer, id, "wordpress");
    await expect(startSpeedCheck(h.ctx, pm.viewer, id, "wordpress")).rejects.toBeInstanceOf(SpeedCheckError);
    expect(queued.map((q) => q.name)).toEqual([SPEED_CHECK_JOB]);

    const asked: string[] = [];
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a made-up key for the test
    vi.stubEnv("PAGESPEED_API_KEY", "vml-key");
    setSpeedCheckFetchForTesting(async (url) => {
      asked.push(url);
      return Response.json(answer(url.includes("strategy=mobile") ? 0.94 : 1));
    });
    await runSpeedCheckJob(queued[0]!.data);
    expect(asked).toHaveLength(2);
    expect(asked.every((u) => u.includes("url=https%3A%2F%2Fnora-beagle-site.fba.ici.mybluehost.me%2F") && u.includes("key=vml-key"))).toBe(true);
    const [row] = await h.db.select().from(speedCheck).where(eq(speedCheck.projectId, id));
    // It records the build the preview was serving, for the go-live gate.
    expect(row).toMatchObject({ status: "done", target: "wordpress", error: null, buildVersion: 3 });

    const views = await loadSpeedChecks(h.db, id);
    expect(views.map((v) => [v.target, v.url])).toEqual([
      ["netlify", "https://abc123--tawd-nora.netlify.app/"],
      ["wordpress", "https://nora-beagle-site.fba.ici.mybluehost.me/"],
    ]);
    expect(views[1]!.last).toMatchObject({ status: "done" });
    expect(views[1]!.last!.mobile!.scores.performance).toBe(94);
    expect(views[1]!.last!.desktop!.scores.performance).toBe(100);
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.speed_checked"))).length).toBe(1);
  });

  it("says what to do when Google's free allowance is used up", async () => {
    const { pm, id } = await setup();
    await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-nora", url: "https://tawd-nora.netlify.app" } as never);
    await readyPreview(id);
    await startSpeedCheck(h.ctx, pm.viewer, id, "netlify");
    setSpeedCheckFetchForTesting(async () => Response.json({ error: { message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" } }, { status: 429 }));
    await runSpeedCheckJob(queued[0]!.data);
    const [row] = await h.db.select().from(speedCheck).where(eq(speedCheck.projectId, id));
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toContain("PAGESPEED_API_KEY (Coolify, tawd-web-new and tawd-worker-new)");
  });

  it("shows the scores in Google's bands and the main things to fix", () => {
    const read = readPageSpeed(answer(0.69))!;
    const card = renderToStaticMarkup(
      <SpeedCheckCard
        projectId="p1"
        canCheck
        targets={[
          { target: "netlify", url: "https://tawd-nora.netlify.app/", last: null },
          { target: "wordpress", url: "https://nora.example/", last: { status: "done", when: "1 Oct, 9:12 pm", mobile: read, desktop: { ...read, scores: { ...read.scores, performance: 100 } }, error: null, url: "https://nora.example/", version: 4 } },
        ]}
      />,
    );
    expect(card).toContain("Speed check");
    expect(card).toContain("Check speed");
    expect(card).toContain("Check again");
    expect(card).toContain('<span class="speed-score speed-fair">69</span>');
    expect(card).toContain('<span class="speed-score speed-good">100</span>');
    expect(card).toContain("Render-blocking requests");
    expect(card).toContain("https://nora.example/ (v4)");
    expect(card).toContain("SEO reads lower on a preview");
    expect(renderToStaticMarkup(<SpeedCheckCard projectId="p1" canCheck targets={[]} />)).toContain("Deploy a preview first");
  });
});

describe("the speed gate (Jason, 1 October 2026: aim 90, 85 to 89 the buffer, under 85 blocks go-live)", () => {
  const steps = { domainConfirmed: true, emailVerified: true, emailConfirmed: true, netlifyDomain: true, nameserversSwitched: true, httpsConfirmed: true, ga4Recorded: true };
  const gate = (speed: Parameters<typeof goLiveGate>[0]["speed"]) => goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true, speed });

  it("blocks with no check or under 85, notes the buffer, and lets a founder's decision through", () => {
    expect(gate(undefined).ready).toBe(true);
    expect(gate({ preview: "Netlify preview", checked: null, overridden: false }).blockers).toEqual(["Speed: run the Speed check on the Netlify preview of this build first (Speed check, Go live)."]);
    expect(gate({ preview: "Netlify preview", checked: { phone: 69, computer: 92 }, overridden: false }).blockers).toEqual(["Speed: phone 69, computer 92. Both need 85 or more to go live (the aim is 90); improve the site, or a founder lets it go live (Speed check)."]);
    const buffer = gate({ preview: "Netlify preview", checked: { phone: 87, computer: 95 }, overridden: false });
    expect(buffer.ready).toBe(true);
    expect(buffer.flags).toEqual(["Speed: phone 87, computer 95, within the buffer (the aim is 90)."]);
    const let_ = gate({ preview: "Netlify preview", checked: { phone: 69, computer: 78 }, overridden: true });
    expect(let_.ready).toBe(true);
    expect(let_.flags).toEqual(["Speed: phone 69, computer 78, below 85; a founder let it go live."]);
    expect(gate({ preview: "Netlify preview", checked: { phone: 94, computer: 100 }, overridden: false })).toMatchObject({ ready: true, flags: [] });
  });

  it("reads the newest check made after the build, and a founder's decision holds for that build only", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const founder = await seedUser(h, admin.viewer, { email: "cofounder@velocitymedialab.com", roles: ["founder"] });
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "pro", clientName: "Nora Beagle Site" });
    const built = new Date(Date.now() - 60_000);
    await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", checks: [], finishedAt: built } as never);
    const mobile = readPageSpeed(answer(0.69))!;
    const desktop = readPageSpeed(answer(0.78))!;
    // A check from before the build doesn't count.
    await h.db.insert(speedCheck).values({ projectId: id, target: "netlify", url: "https://x/", status: "done", results: { mobile, desktop }, createdAt: new Date(built.getTime() - 1000) });
    expect((await speedForGate(h.db, id)).checked).toBeNull();
    await h.db.insert(speedCheck).values({ projectId: id, target: "netlify", url: "https://x/", status: "done", results: { mobile, desktop } });
    expect(await speedForGate(h.db, id)).toEqual({ preview: "Netlify preview", checked: { phone: 69, computer: 78 }, overridden: false });

    await expect(overrideSpeed(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    await overrideSpeed(h.ctx, founder.viewer, id);
    expect((await speedForGate(h.db, id)).overridden).toBe(true);
    expect((await h.db.select().from(goLive).where(eq(goLive.projectId, id)))[0]).toMatchObject({ speedOverrideVersion: 1, speedOverrideBy: founder.viewer.id });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "site.speed_overridden"))).length).toBe(1);
    // A new build needs its own check, and its own decision.
    await h.db.insert(siteBuild).values({ projectId: id, version: 2, status: "done", checks: [], finishedAt: new Date(Date.now() + 1000) } as never);
    expect(await speedForGate(h.db, id)).toMatchObject({ checked: null, overridden: false });

    // Fable's B1 (3 October 2026): a check made after v2 finished, but while the preview still served v1, doesn't count for v2.
    await h.db.insert(speedCheck).values({ projectId: id, target: "netlify", url: "https://x/", status: "done", results: { mobile, desktop }, buildVersion: 1, createdAt: new Date(Date.now() + 2000) });
    expect((await speedForGate(h.db, id)).checked).toBeNull();
    await h.db.insert(speedCheck).values({ projectId: id, target: "netlify", url: "https://x/", status: "done", results: { mobile, desktop }, buildVersion: 2, createdAt: new Date(Date.now() + 3000) });
    expect((await speedForGate(h.db, id)).checked).toEqual({ phone: 69, computer: 78 });
  });

  it("can speed up the last build, free, as a new version", async () => {
    const admin = await seedAdmin(h);
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "pro", clientName: "Nora Beagle Site" });
    await expect(startSpeedUp(h.ctx, admin.viewer, id)).rejects.toBeInstanceOf(SiteError);
    await h.db.insert(siteBuild).values({ projectId: id, version: 3, status: "done", checks: [] } as never);
    await expect(startSpeedUp(h.ctx, content.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    await startSpeedUp(h.ctx, admin.viewer, id);
    const rows = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect(rows.find((r) => r.version === 4)).toMatchObject({ status: "queued", options: { kind: "speed", from: 3 } });
    await expect(startSpeedUp(h.ctx, admin.viewer, id)).rejects.toThrow("already being built");
  });
});

