import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Lane 2, simply (Jason, 29 September 2026): the site built close to the
  design in three steps. With a stand-in AI and a real Chrome: the home page
  first (the estimate on Sonnet 5), the header and footer once, the Preview
  with the design beside the built page, the check's notes and a suggested
  search listing; feedback reworking only its page; the $0 refresh; the
  old tools hidden from non-admins. Skipped where Chrome isn't installed.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { checkReadiness, uploadToFigmaFile } from "@tawd/core/figma";
import { getStorage, projectStoragePrefix, setStorageForTesting } from "@tawd/core/intake/storage";
import type { SiteBuildJobData } from "@tawd/core/queue";
import { activityLog, aiCall, designFinding, designReview, figmaDesign, project as projectTable, siteBuild, siteDeploy, styleKit } from "@tawd/core/schema";
import { replaceAssetTokens } from "@tawd/core/site";
import { DesignSiteFlow } from "@/components/mockups/design-site-flow";
import { checkDesignBuild, decideOpenSuggestions, decideSuggestion, loadDesignFlow, refreshDesignSite, reworkDesignPage, skipDesignReview, startDesignBuild } from "@/lib/design-site";
import { recordPreviewDecision } from "@/lib/netlify";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { SiteError, startSiteBuild } from "@/lib/site-builds";

import type { WorkerConfig } from "../../../worker/src/config";
import { markSiteBuildFailed, runSiteBuildJob, startSiteBuildHeartbeat } from "../../../worker/src/site-build";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeClaude, turn } from "./worker-fakes";

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

const READ = {
  number: 1,
  width: 1440,
  height: 900,
  background: "#ffffff",
  readBy: "vision",
  sections: [
    { name: "Top", top: 0, height: 120, background: "#0b1a4a" },
    { name: "Hero", top: 120, height: 600, background: "#ffffff" },
    { name: "Footer", top: 720, height: 180, background: "#0b1a4a" },
  ],
  texts: [
    { text: "HOME", x: 400, y: 50, w: 60, h: 20, size: 16, weight: 400, color: "#ffffff", font: null },
    { text: "Welcome to Beagle Chaos", x: 100, y: 200, w: 600, h: 60, size: 48, weight: 700, color: "#0b1a4a", font: null },
    { text: "Five Beagles. Plenty of naps, every single day of the year, and all of it on camera.", x: 100, y: 300, w: 600, h: 24, size: 18, weight: 400, color: "#1a1a2a", font: null },
    { text: "© 2026 Nora", x: 100, y: 800, w: 200, h: 20, size: 14, weight: 400, color: "#ffffff", font: null },
  ],
  images: [],
};

async function upload(options: { photo?: "stored" | "lost"; optionB?: boolean } = {}) {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "NoraHappyBeagleLady", trade: "photography", tier: "starter", lane: "lane_2", laneOption: options.optionB ? "b" : "a", conceptCount: options.optionB ? 1 : null, status: "mockups", memberUserIds: [] });
  // A photo on the home page's design, as an uploaded PDF's pictures are (a client's build stopped on one, 29 September 2026).
  const photo = options.photo ? { images: [{ ref: "p1", kind: "photo", x: 700, y: 150, w: 300, h: 200 }] } : {};
  const file = uploadToFigmaFile([{ ...READ, ...photo } as never, { ...READ, number: 2 } as never], "Nora.pdf", "upload-1");
  const imageFiles = options.photo ? { p1: `${projectStoragePrefix(id)}figma/images/p1.png` } : null;
  const frames = file.document.children![0]!.children!.map((f, i) => ({ id: f.id, name: i === 0 ? "Home" : "About", width: 1440, height: 900, isHome: i === 0, imageKey: `${projectStoragePrefix(id)}frames/page-${i + 1}.png`, scale: 1 }));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  await tab.setContent('<body style="margin:0"><div style="height:120px;background:#0b1a4a"></div><h1 style="font:48px Arial;margin:80px 100px">Welcome to Beagle Chaos</h1></body>');
  const png = await tab.screenshot();
  await context.close();
  for (const f of frames) await getStorage().put(f.imageKey, png, "image/png");
  if (options.photo === "stored") await getStorage().put(imageFiles!.p1, png, "image/png");
  const fileJsonKey = `${projectStoragePrefix(id)}design.json`;
  await getStorage().put(fileJsonKey, Buffer.from(JSON.stringify(file)), "application/json");
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "u", source: "upload", fileName: "Nora.pdf", importStatus: "done", importedVersion: "upload-1", importedAt: new Date(Date.now() - 60_000), fileJsonKey, readiness: checkReadiness(file), frames, imageFiles });
  // A kit read already (the build reads one quietly when there's none; that fetches fonts, so the test gives one).
  const kit = { version: 1, colors: [{ token: "--kit-color-1", hex: "#0b1a4a", uses: ["text"] }], fonts: [{ role: "sans", family: "Arial", score: 0.9, alternatives: [], weights: [400], files: [] }], parts: [], icons: [{ ref: "kit-icon-1", svg: '<svg viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>', label: "paw", frame: null, frameColor: null, color: "#0b1a4a", uses: ["s2-icon-1"] }], map: {}, notes: [], sharedLayouts: [] };
  await h.db.insert(styleKit).values({ projectId: id, designVersion: "upload-1", status: "done", kit });
  // Opening Mockups proposes the design's pages.
  await loadDesignFlow(h.db, id, admin.viewer);
  return { admin, id };
}

const PARTS = `<header class="site-header"><style>.site-header{background:#0b1a4a}</style><a class="skip" href="#main">Skip to content</a><nav><a href="/">HOME</a><a href="/about/">ABOUT</a><a href="#">CONTACT</a></nav></header><footer class="site-footer"><p>© 2026 Nora</p><a href="/privacy/">Privacy Policy</a><a href="/cookies/">Cookie Policy</a><p>Website by Velocity Media Lab</p></footer>`;
const MAIN = (h1: string) => `<main id="main" class="page-home"><style>.page-home h1{font-size:48px}@media (max-width:767px){.page-home h1{font-size:30px}}</style><section><h1>${h1}</h1><p>Five Beagles. Plenty of naps, every single day of the year, and all of it on camera.</p><span data-kit-icon="kit-icon-1"></span><span data-kit-icon="kit-icon-9"></span><a href="#">ABOUT</a></section></main>`;

describe("image tokens", () => {
  it("swaps whole tokens only, so photo 1's address never lands inside photo 10's", () => {
    const html = '<img src="tawd-asset:home-design-image-1"><img src="tawd-asset:home-design-image-10"><img src="tawd-asset:home-design-image-14">';
    const map = new Map([
      ["tawd-asset:home-design-image-1", "/images/home/design-image-1.jpg"],
      ["tawd-asset:home-design-image-10", "/images/home/design-image-10.jpg"],
    ]);
    expect(replaceAssetTokens(html, map)).toBe('<img src="/images/home/design-image-1.jpg"><img src="/images/home/design-image-10.jpg"><img src="tawd-asset:home-design-image-14">');
  });
});

describe.skipIf(!hasChrome)("the site from the design, in three steps", () => {
  it("builds the home page first on Sonnet 5, then shows it beside its design with the check's notes and a search listing", async () => {
    const { admin, id } = await upload();
    const flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.step).toBe("build");
    expect(flow.pages.map((p) => p.name)).toEqual(["Home", "About"]);
    expect(flow.estimates.home.label).toMatch(/^About \$[0-9.]+ of AI on Sonnet 5: the header and footer, 1 page built from its design \(a first guess until a page has been built\)\.$/);
    expect(renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />)).toContain("Build Home first");

    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    await expect(startDesignBuild(h.ctx, admin.viewer, id, ["home"])).rejects.toThrow("already being built");
    const claude = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn")) });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser);
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[0]!.data.buildId));
    expect(build).toMatchObject({ status: "done", options: { kind: "design", only: ["home"] } });
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.projectId, id));
    expect(calls.map((c) => [c.step, c.model]).sort()).toEqual([["design_site_page", "claude-sonnet-5"], ["design_site_parts", "claude-sonnet-5"]]);
    // The page's picture went to the AI with its words.
    const pageCall = claude.calls.find((c) => JSON.stringify(c.params.messages).includes("# The page: Home"))!;
    expect(JSON.stringify(pageCall.params.messages)).toContain('"type":"image"');
    expect(JSON.stringify(pageCall.params.messages)).toContain("Welcome to Beagle Chaos");

    const source = (await getStorage().get(`${projectStoragePrefix(id)}site/v${build!.version}/_source/pages/home.html`))!.toString("utf8");
    expect(source).toContain('<span data-kit-icon="kit-icon-1" aria-hidden="true"><svg');
    // An icon the design's own kit lacks is filled from TAWD's own set (gap 9), not removed.
    expect(source).toContain('<span data-kit-icon="kit-icon-9" aria-hidden="true" data-kit-fallback=""><svg');
    expect(source).toContain('<a href="/about/">ABOUT</a>');
    const index = (await getStorage().get(`${projectStoragePrefix(id)}site/v${build!.version}/index.html`))!.toString("utf8");
    expect(index).not.toContain(">CONTACT<");
    expect(index).toContain('href="/site.css"');
    expect((await getStorage().get(`${projectStoragePrefix(id)}site/v${build!.version}/site.css`))!.toString("utf8")).toContain("--kit-color-1:#0b1a4a");

    const after = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(after.step).toBe("preview");
    const home = after.preview!.pages[0]!;
    expect(home).toMatchObject({ key: "home", name: "Home", path: "/" });
    expect(home.designUrl).toBeTruthy();
    expect(home.shotUrl).toBeTruthy();
    expect(home.notes).toContain("An icon (kit-icon-9) isn't in the design's kit; filled from TAWD's own set.");
    expect(home.listing).toMatchObject({ title: "NoraHappyBeagleLady", approved: false });
    expect(home.listing!.description.startsWith("Five Beagles. Plenty of naps")).toBe(true);
    expect(after.pages.find((p) => p.key === "about")!.built).toBe(false);
    const html = renderToStaticMarkup(<DesignSiteFlow projectId={id} view={after} />);
    expect(html).toContain("The design");
    expect(html).toContain("Built");
    expect(html).toContain("Build the other 1 page");
    expect(html).toContain("Rework this page");

    // Feedback: only its page goes back to the AI, the header and footer are kept.
    await reworkDesignPage(h.ctx, admin.viewer, id, "home", "Make the heading say Welcome to the Pack");
    const rework = fakeClaude(() => [], { builder: () => turn(MAIN("Welcome to the Pack"), "end_turn") });
    await runSiteBuildJob(queued[1]!.data, config, rework.client as never, browser);
    expect(rework.calls).toHaveLength(1);
    expect(JSON.stringify(rework.calls[0]!.params.messages)).toContain("Make the heading say Welcome to the Pack");
    const [reworked] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[1]!.data.buildId));
    expect(reworked!.status).toBe("done");
    expect((await getStorage().get(`${projectStoragePrefix(id)}site/v${reworked!.version}/_source/pages/home.html`))!.toString("utf8")).toContain("Welcome to the Pack");

    // The refresh ($0): no AI at all.
    await refreshDesignSite(h.ctx, admin.viewer, id);
    const none = fakeClaude(() => []);
    await runSiteBuildJob(queued[2]!.data, config, none.client as never, browser);
    expect(none.calls).toHaveLength(0);
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[2]!.data.buildId)))[0]!.status).toBe("done");
  }, 240_000);

  it("puts the design's photos in the site (in each page's own folder), and stops for $0 before any AI call when one is missing", async () => {
    const { admin, id } = await upload({ photo: "stored" });
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const withPhoto = MAIN("Welcome to Beagle Chaos").replace("</section>", '<img src="tawd-asset:home-design-image-1" alt="Five beagles"></section>');
    const claude = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(withPhoto, "end_turn")) });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser);
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[0]!.data.buildId));
    expect(build!.status).toBe("done");
    const r2 = getStorage() as unknown as FakeR2;
    expect([...r2.objects.keys()].some((k) => k.startsWith(`${projectStoragePrefix(id)}site/v${build!.version}/images/home/design-image-1.`))).toBe(true);
  }, 180_000);

  it("stops for $0, before any AI call, when one of the design's photos is missing", async () => {
    const lost = await upload({ photo: "lost" });
    await startDesignBuild(h.ctx, lost.admin.viewer, lost.id, ["home"]);
    const none = fakeClaude(() => []);
    await expect(runSiteBuildJob(queued[0]!.data, config, none.client as never, browser)).rejects.toThrow(/missing from storage \(Home: design-image-1\).*Nothing was spent/);
    expect(none.calls).toHaveLength(0);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.projectId, lost.id))).toHaveLength(0);
  }, 180_000);

  it("retries a build that stopped after paying on its saved answers, for $0, and says so on the button", async () => {
    const { admin, id } = await upload({ photo: "stored" });
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    // The first build pays for its two answers, then stops while saving the site (as a client's did).
    const r2 = getStorage() as unknown as FakeR2;
    const put = r2.put.bind(r2);
    let failing = true;
    r2.put = async (key: string, body: Buffer) => {
      if (failing && key.includes("/site/v1/")) throw new Error("ENOENT: no such file or directory");
      return put(key, body);
    };
    const paid = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn")) });
    await runSiteBuildJob(queued[0]!.data, config, paid.client as never, browser).catch((error: Error) => markSiteBuildFailed(queued[0]!.data.buildId, error.message));
    failing = false;
    expect(paid.calls).toHaveLength(2);
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[0]!.data.buildId)))[0]!.status).toBe("failed");

    const flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.estimates.home).toMatchObject({ cost: 0, reused: 2, label: "$0, reusing saved answers: the header and footer and Home, from the build that didn't finish." });
    const html = renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />);
    expect(html).toContain("Build Home first ($0, reusing saved answers)");
    expect(html).toContain("the answers it already paid for are reused, for $0");

    // The page's answer as one saved before fingerprints (a client's): still reused, from the latest unfinished build.
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.projectId, id));
    const pageKey = calls.find((c) => c.step === "design_site_page")!.responseKey!;
    const saved = JSON.parse((await r2.get(pageKey))!.toString("utf8"));
    expect(saved.requestHash).toMatch(/^[0-9a-f]{64}$/);
    delete saved.requestHash;
    await put(pageKey, Buffer.from(JSON.stringify(saved)));

    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const retry = fakeClaude(() => []);
    await runSiteBuildJob(queued[1]!.data, config, retry.client as never, browser);
    expect(retry.calls).toHaveLength(0);
    const [done] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[1]!.data.buildId));
    expect(done!.status).toBe("done");
    expect(await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).toHaveLength(2);
    const home = (done!.pages as { name: string; notes?: string[] }[]).find((p) => p.name === "Home")!;
    expect(home.notes).toContain("Built from the answer the last, unfinished build paid for, reused ($0).");

    // Once a build has finished, those answers aren't offered again: a new build is a new question.
    expect((await loadDesignFlow(h.db, id, admin.viewer))!.estimates.home.reused).toBe(0);
  }, 240_000);

  it("reuses a fingerprinted answer only for the very same question", async () => {
    const { admin, id } = await upload();
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const paid = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : { stopReason: "end_turn", content: [{ type: "text", text: "not a page" }] } as never) });
    await runSiteBuildJob(queued[0]!.data, config, paid.client as never, browser).catch((error: Error) => markSiteBuildFailed(queued[0]!.data.buildId, error.message));
    // The header and footer's saved fingerprint no longer matches (as if the design had changed): asked again, paid.
    const r2 = getStorage() as unknown as FakeR2;
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.projectId, id));
    const partsKey = calls.find((c) => c.step === "design_site_parts")!.responseKey!;
    const saved = JSON.parse((await r2.get(partsKey))!.toString("utf8"));
    await r2.put(partsKey, Buffer.from(JSON.stringify({ ...saved, requestHash: "0".repeat(64) })));
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const retry = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn")) });
    await runSiteBuildJob(queued[1]!.data, config, retry.client as never, browser);
    // The page's saved answer couldn't be used ("not a page"), so it was asked again too.
    expect(retry.calls.map((c) => (JSON.stringify(c.params.messages).includes("shared header and footer") ? "parts" : "page"))).toEqual(["parts", "page"]);
  }, 240_000);

  it("Option B: the review first, a yes or no per suggestion, the accepted ones in the build; the client's approval moves it to Build", async () => {
    const { admin, id } = await upload({ optionB: true });
    let flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow).toMatchObject({ optionB: true, step: "review", review: { status: "none", done: false } });
    expect(flow.review!.estimate.label).toContain("of AI on Sonnet 5");
    let html = renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />);
    for (const text of ["Review &amp; suggestions", "Review the design", "Skip the review ($0)", "Building opens once the review is done (or skipped).", "Build alternatives or open the concept board"]) expect(html).toContain(text);
    expect(html).not.toContain("Build Home first");
    await expect(startDesignBuild(h.ctx, admin.viewer, id, ["home"])).rejects.toThrow("Review the design first (or skip the review)");

    // A finished review (the worker's part is tested with the review itself): a must-fix starts accepted, the rest open.
    const [figma] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, id));
    const home = (figma!.frames as { id: string; name: string; isHome: boolean }[]).find((f) => f.isHome)!;
    const [review] = await h.db
      .insert(designReview)
      .values({ projectId: id, status: "done", figmaVersion: "upload-1", frameId: home.id, frameName: home.name, review: { questions: [], average: 3.8, lowest: 3, summary: "A warm, clear page; the call to action is hard to find.", safetyAdvice: [], reviewedAt: new Date().toISOString() }, finishedAt: new Date() })
      .returning();
    const finding = (number: number, grade: string, title: string, change: string, ticked = false) => ({ reviewId: review!.id, projectId: id, number, grade, category: "layout", title, problem: `${title}: the problem`, change, why: "why", layerName: "Hero", pinX: 50, pinY: 20, ticked });
    const inserted = await h.db
      .insert(designFinding)
      .values([
        finding(1, "must_fix", "Make the button stand out", "Give FOLLOW OUR PACK the kit's filled button.", true),
        finding(2, "should_fix", "Tighten the hero", "Cut the hero's height to one screen."),
        finding(3, "recommendation", "Add a wave divider", "Add a wave between the hero and the pack."),
        finding(4, "confirm_fact", "Five beagles?", "Confirm there are five."),
      ])
      .returning();
    flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.step).toBe("build");
    expect(flow.review!.suggestions.map((s) => [s.number, s.decision, s.byDefault])).toEqual([[1, "accepted", true], [2, "open", false], [3, "open", false]]);
    expect(flow.review!.facts).toHaveLength(1);
    html = renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />);
    for (const text of ["A warm, clear page", "3 suggestions: 1 accepted, 2 still to decide.", "Accepted (must-fix)", "To decide", "Accept the 2 still open", "1 fact in the design to check", "Build Home first"]) expect(html).toContain(text);

    // Yes to 2, no to 1, and the rest (3) rejected in one go; each logged.
    const byNumber = (n: number) => inserted.find((f) => f.number === n)!.id;
    await decideSuggestion(h.ctx, admin.viewer, id, byNumber(2), "accepted");
    await decideSuggestion(h.ctx, admin.viewer, id, byNumber(1), "rejected");
    expect(await decideOpenSuggestions(h.ctx, admin.viewer, id, "rejected")).toBe(1);
    await expect(decideSuggestion(h.ctx, admin.viewer, id, byNumber(4), "accepted")).rejects.toThrow("no longer exists");
    const log = await h.db.select().from(activityLog).where(eq(activityLog.action, "design.suggestion_decided"));
    expect(log).toHaveLength(3);
    expect(log.find((e) => (e.valueAfter as { number?: number }).number === 1)).toMatchObject({ valueBefore: { decision: "accepted" }, valueAfter: { decision: "rejected" } });
    flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.review!.suggestions.map((s) => s.decision)).toEqual(["rejected", "accepted", "rejected"]);

    // The build: only the accepted suggestion goes into the home page's prompt.
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const claude = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn")) });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser);
    const page = JSON.stringify(claude.calls.find((c) => JSON.stringify(c.params.messages).includes("# The page: Home"))!.params.messages);
    expect(page).toContain("Changes the team accepted from the design review");
    expect(page).toContain("Tighten the hero (at: Hero): Cut the hero's height to one screen.");
    expect(page).not.toContain("Make the button stand out");
    expect(page).not.toContain("wave divider");
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[0]!.data.buildId));
    expect(build!.status).toBe("done");

    // The client approves the preview: a Lane 2 project moves to Build, logged.
    await h.db.insert(siteDeploy).values({ projectId: id, buildId: build!.id, version: build!.version, url: "https://nora-preview.netlify.app", kind: "preview", state: "ready" });
    await recordPreviewDecision(h.ctx, admin.viewer, id, { outcome: "approved", channel: "email", clientSaid: "Love it, go ahead." });
    const [after] = await h.db.select().from(projectTable).where(eq(projectTable.id, id));
    expect(after!.status).toBe("build");
    const moved = await h.db.select().from(activityLog).where(eq(activityLog.action, "project.status_changed"));
    expect(moved.at(-1)).toMatchObject({ valueBefore: { status: "mockups" }, valueAfter: { status: "build", reason: "The client approved the preview" } });
  }, 240_000);

  it("Option B: skipping the review opens Build for $0, logged", async () => {
    const { admin, id } = await upload({ optionB: true });
    await skipDesignReview(h.ctx, admin.viewer, id);
    const flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow).toMatchObject({ step: "build", review: { skipped: true, done: true } });
    expect(renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />)).toContain("Review skipped: the site is built from the design as drawn.");
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "design.review_skipped"))).toHaveLength(1);
    // A PM with no project rights can't skip it.
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(skipDesignReview(h.ctx, seo.viewer, id)).rejects.toThrow();
  }, 120_000);

  it("checks a build for free first, stops a build at twice its estimate, and reports each build's cost against its estimate", async () => {
    const { admin, id } = await upload({ photo: "stored" });
    // The free check: the whole build with stand-ins, no AI, nothing kept.
    await checkDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const none = fakeClaude(() => []);
    await runSiteBuildJob(queued[0]!.data, config, none.client as never, browser);
    expect(none.calls).toHaveLength(0);
    expect(await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).toHaveLength(0);
    let flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.step).toBe("build");
    expect(flow.check).toMatchObject({ state: "passed" });
    expect(flow.check!.line).toMatch(/^The free check passed: the build would ask the AI 2 times, about \$0\.\d\d \(Home\)\. 1 picture ready, 1 trimmed of design marks\. Nothing was spent\.$/);
    expect(renderToStaticMarkup(<DesignSiteFlow projectId={id} view={flow} />)).toContain("Check first ($0)");

    // A build that runs past twice its estimate stops before the next call (each stand-in call here costs $0.32).
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    await h.db.update(siteBuild).set({ options: { kind: "design", only: ["home"], estimate: 0.1 } }).where(eq(siteBuild.id, queued[1]!.data.buildId));
    const claude = fakeClaude(() => [], { builder: (params) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn")) });
    await expect(runSiteBuildJob(queued[1]!.data, config, claude.client as never, browser)).rejects.toThrow(/^Stopped at twice its estimate: this build has spent \$0\.32 \(estimate \$0\.10\)\. Nothing more was spent; Home wasn't built\./);
    expect(claude.calls).toHaveLength(1);
    await markSiteBuildFailed(queued[1]!.data.buildId, "Stopped at twice its estimate");
    flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.building!.cost).toBe("Version 2 cost $0.32 of AI (estimated $0.10).");

    // Built for real (the header and footer reused for $0): its cost beside its estimate on the Preview.
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    await runSiteBuildJob(queued[2]!.data, config, claude.client as never, browser);
    flow = (await loadDesignFlow(h.db, id, admin.viewer))!;
    expect(flow.costLine).toMatch(/^Version 3 cost \$0\.32 of AI \(estimated \$0\.\d\d\); 1 saved answer reused, \$0\.$/);
  }, 300_000);

  it("keeps the exact build from the copies for admins only", async () => {
    const { admin, id } = await upload();
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(startSiteBuild(h.ctx, pm.viewer, id)).rejects.toBeInstanceOf(SiteError);
  }, 60_000);

  const builder = (params: Record<string, unknown>) => (JSON.stringify(params.messages).includes("shared header and footer") ? turn(PARTS, "end_turn") : turn(MAIN("Welcome to Beagle Chaos"), "end_turn"));

  it("a build delivered twice at once is built once: one claim wins, the AI is asked for one build, the row ends done", async () => {
    const { admin, id } = await upload();
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const claude = fakeClaude(() => [], { builder });
    await Promise.all([
      runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser),
      runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser),
    ]);
    // One build asks twice (the header and footer, then Home); a second build would make it four.
    expect(claude.calls).toHaveLength(2);
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[0]!.data.buildId)))[0]!.status).toBe("done");
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.built"))).toHaveLength(1);
  }, 120_000);

  it("a build swept as stalled while it was still running stays failed: it records no site.built", async () => {
    const { admin, id } = await upload();
    await startDesignBuild(h.ctx, admin.viewer, id, ["home"]);
    const buildId = queued[0]!.data.buildId;
    // The sweep marks the row failed while the worker is still inside its AI calls.
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        void h.db.update(siteBuild).set({ status: "failed", failureReason: "The worker stopped part-way through this build." }).where(eq(siteBuild.id, buildId)).execute();
        return builder(params);
      },
    });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, browser);
    const [row] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, buildId));
    expect(row).toMatchObject({ status: "failed", failureReason: "The worker stopped part-way through this build." });
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.built"))).toEqual([]);
  }, 120_000);
});

describe("the heartbeat of a running job", () => {
  it("stamps a working build's row on each beat, only while it is working, and stops when cleared", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Beat Co", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [] } as never);
    const old = new Date("2026-01-01T00:00:00Z");
    const [row] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "working", heartbeatAt: old } as never).returning();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const beat = startSiteBuildHeartbeat(h.db as never, row!.id, 20);
    await wait(250);
    const stamped = (await h.db.select().from(siteBuild).where(eq(siteBuild.id, row!.id)))[0]!.heartbeatAt!;
    expect(stamped.getTime()).toBeGreaterThan(old.getTime() + 86_400_000);
    // Once the row is no longer working (swept, finished), a beat leaves it alone.
    await h.db.update(siteBuild).set({ status: "failed", heartbeatAt: old }).where(eq(siteBuild.id, row!.id));
    await wait(150);
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.id, row!.id)))[0]!.heartbeatAt!.getTime()).toBe(old.getTime());
    // Cleared: working again, and nothing stamps it.
    await h.db.update(siteBuild).set({ status: "working" }).where(eq(siteBuild.id, row!.id));
    clearInterval(beat);
    await wait(150);
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.id, row!.id)))[0]!.heartbeatAt!.getTime()).toBe(old.getTime());
  }, 30_000);
});
