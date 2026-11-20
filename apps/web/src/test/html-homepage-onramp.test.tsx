import path from "node:path";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  A homepage supplied as one finished HTML file (16 November 2026): the job
  that puts it on the board as a concept (C1) and Build A keeping its home
  page as it is (C2). Claude is a stand-in (no AI money); Astro really builds
  the files; the photographs of the import job are a stand-in too (the real
  one is Chromium, which these tests do not start).
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
const session: { user: unknown } = { user: null };
vi.mock("@/lib/session", () => ({ requireUser: async () => session.user }));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
const serverState: { ctx: unknown } = { ctx: null };
vi.mock("@/lib/server-context", () => ({ getServiceContext: async () => serverState.ctx }));
vi.mock("../../../worker/src/liked-sites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../worker/src/liked-sites")>()),
  pinnedStatusFetch: ((input: string | URL | Request, init?: RequestInit) => fetch(input, init)) as typeof fetch,
}));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, clientDecision, concept, conceptChangeRequest, conceptVersion, intakeFile, jobFailure, mockupRun, pageDraft, pagePlanPage, siteBuild } from "@tawd/core/schema";
import { requestUpload, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { HTML_HOMEPAGE_CONCEPT, directionInfo } from "@tawd/core/mockups";
import { HTML_MOCKUP_IMPORT_JOB, type HtmlMockupImportJobData, type SiteBuildJobData } from "@tawd/core/queue";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
import { setQueueForTesting } from "@/lib/mockups";
import { SiteError, siteReadiness, startSiteBuild } from "@/lib/site-builds";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import { HtmlMockupImportError, loadHomepageRead, queueHtmlMockupImport } from "@/lib/html-mockup-import";
import { confirmUploadAction, readHomepageAgainAction } from "@/app/actions";
import { HomepageHtmlSection } from "@/components/intake/homepage-html-section";
import { ConceptDetailView } from "@/components/mockups/concept-detail";
import { SUPPLIED_NO_CHANGES, conceptsMissingReview, recordClientDecision, requestChanges } from "@/lib/concept-review";
import { loadConceptDetail } from "@/lib/concept-detail";
import { startPolish } from "@/lib/polish";
import { startLogoSwap } from "@/lib/logo-after-approval";
import { loadDraftsOverview, startDrafts } from "@/lib/content-drafts";
import { isGeneratedConcept } from "@tawd/core/mockups";
import { usesSuppliedHome } from "@tawd/core/site-read";
import { extractDesignSystem, visibleWordsLine } from "@tawd/core/site";
import { runReviewJob } from "../../../worker/src/review";

import { loadSuppliedHome, runHtmlMockupImportJob, suppliedHomeMain } from "../../../worker/src/html-mockup-import";
import { runSiteBuildJob } from "../../../worker/src/site-build";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, turn } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: unknown; jobId?: string }[];
/*
  The queue stand-in: remembers each job by id (so getJob answers like BullMQ's
  does while a job is waiting) and, like BullMQ, ignores a second add with an
  id it already holds, unless a test switches that off to prove the web side
  guards by itself. A test can also make the queue refuse (Redis down).
*/
let jobs: Map<string, string>;
let dedupeById: boolean;
let queueDown: boolean;

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  jobs = new Map();
  dedupeById = true;
  queueDown = false;
  session.user = null;
  serverState.ctx = h.ctx;
  setQueueForTesting({
    add: async (name, data, options) => {
      if (queueDown) throw new Error("connection refused");
      const id = options?.jobId;
      if (id && dedupeById && jobs.has(id)) return;
      if (id) jobs.set(id, "waiting");
      queued.push({ name, data, jobId: id });
    },
    getJob: async (id) => (jobs.has(id) ? { remove: async () => undefined, getState: async () => jobs.get(id)! } : null),
  });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

// A real 1x1 PNG, so readHtmlMockup's "is it really a PNG" check passes.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const FONT_B64 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60, 7)]).toString("base64");

const SUPPLIED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Supplied</title>
<style>@font-face{font-family:Brand;src:url(data:font/woff2;base64,${FONT_B64}) format("woff2")}body{font-family:Brand,sans-serif;margin:0}.band{padding:48px}.hero{background:#7A1F3D;color:#fff}.hero h1{font-size:44px}</style></head>
<body><header class="band"><a href="/">Pat Rivera Plumbing</a><nav><a href="#services">Services</a></nav></header>
<section class="band hero"><h1>Supplied hero words that must survive</h1><img src="data:image/png;base64,${PNG_B64}" alt="The van"></section>
<section class="band" id="services"><h2>Supplied services band</h2><p>Kitchen drains, same day.</p></section>
<footer class="band"><p>Pat Rivera Plumbing</p></footer>
<script>document.title = "x"</script></body></html>`;

const STAND_IN_SHOT = { fullPage: Buffer.from("full"), fold: Buffer.from("fold"), heightPx: 1200, truncated: false, bands: [], imageHeightPx: 1200 };

async function readyProject() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Pat Rivera Plumbing",
    trade: "plumbing",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "build",
    memberUserIds: [],
  });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Pat Rivera Plumbing", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  await makePagePlan(h.ctx, admin.viewer, id);
  const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
  return { admin, id, pages };
}

async function uploadHtml(id: string, userId: string, html = SUPPLIED, name = "homepage.html") {
  const storageKey = `projects/${id}/intake/homepage_html/${name}`;
  r2.objects.set(storageKey, Buffer.from(html));
  await h.db.insert(intakeFile).values({ projectId: id, kind: "homepage_html", storageKey, fileName: name, contentType: "text/html", sizeBytes: html.length, status: "ready", uploadedByUserId: userId });
}

const renders: { javaScript: boolean }[] = [];
const countingRender = async (_b: unknown, _html: string, options: { javaScript: boolean }) => {
  renders.push(options);
  return STAND_IN_SHOT;
};
const importIt = (id: string, userId: string, again = false) =>
  runHtmlMockupImportJob(h.db as Database, fakeBrowser() as never, { projectId: id, startedByUserId: userId, ...(again ? { again: true } : {}) }, { storage: r2, render: countingRender as never });

describe("C1: the supplied homepage becomes a concept", () => {
  it("stores it the way a Lane 1 version is stored, with no client decision", async () => {
    const { admin, id } = await readyProject();
    await uploadHtml(id, admin.viewer.id);
    const { conceptId, version } = await importIt(id, admin.viewer.id);

    const [row] = await h.db.select().from(concept).where(eq(concept.id, conceptId));
    expect(row).toMatchObject({ projectId: id, direction: HTML_HOMEPAGE_CONCEPT, skillId: HTML_HOMEPAGE_CONCEPT, status: "ready", label: "S" });
    expect(directionInfo(HTML_HOMEPAGE_CONCEPT).label).toBe("The supplied homepage");

    const [v] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
    expect(v).toMatchObject({ version, pngKey: `projects/${id}/concepts/${conceptId}/v1/full.png` });
    const base = `projects/${id}/concepts/${conceptId}/v1`;
    const source = r2.objects.get(`${base}/source.html`)!.toString("utf8");
    const page = r2.objects.get(`${base}/page.html`)!.toString("utf8");
    // The source carries the token (never the megabytes); the page the client sees carries the picture.
    expect(source).toContain("tawd-asset:photo-page-1");
    expect(source).not.toContain("data:image");
    expect(source).not.toContain("<script");
    // Never the client's own photo-1: a project with an uploaded photo-1 would have one overwrite the other on the site.
    expect(source).not.toMatch(/tawd-asset:photo-1(?![w-])/);
    expect(page).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(page).not.toContain("tawd-asset:");
    // The picture is kept as a file Build A can write.
    expect(r2.objects.get(`${base}/images/photo-page-1.png`)!.toString("base64")).toBe(PNG_B64);
    expect(r2.objects.has(`${base}/original.html`)).toBe(true);
    expect(r2.objects.get(`${base}/full.png`)!.toString()).toBe("full");

    // Nobody approved anything: the team records the client's approval on the existing screen.
    expect(await h.db.select().from(clientDecision).where(eq(clientDecision.projectId, id))).toHaveLength(0);
    const logged = (await h.db.select().from(activityLog)).filter((a) => a.entityId === id && a.action === "mockups.concept_built");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actorUserId).toBe(admin.viewer.id);
    expect(JSON.stringify(logged[0]!.valueAfter)).toContain("homepage.html");
  });

  // The second run, not just the first (CODE-REVIEW-STANDARD, check 1).
  it("a second upload is a new version of the same concept, and its pictures are its own", async () => {
    const { admin, id } = await readyProject();
    await uploadHtml(id, admin.viewer.id);
    const first = await importIt(id, admin.viewer.id);
    await h.db.delete(intakeFile).where(eq(intakeFile.projectId, id));
    await uploadHtml(id, admin.viewer.id, SUPPLIED.replace("Supplied hero words", "Second hero words"), "second.html");
    const second = await importIt(id, admin.viewer.id);
    expect(second.conceptId).toBe(first.conceptId);
    expect(second.version).toBe(2);
    expect(await h.db.select().from(concept).where(eq(concept.projectId, id))).toHaveLength(1);
    expect(r2.objects.get(`projects/${id}/concepts/${first.conceptId}/v2/source.html`)!.toString("utf8")).toContain("Second hero words");
    expect(r2.objects.has(`projects/${id}/concepts/${first.conceptId}/v2/images/photo-page-1.png`)).toBe(true);
    // The first version is untouched.
    expect(r2.objects.get(`projects/${id}/concepts/${first.conceptId}/v1/source.html`)!.toString("utf8")).toContain("Supplied hero words");
  });

  it("says plainly when there is no file, and queues the job when there is", async () => {
    const { admin, id } = await readyProject();
    await expect(queueHtmlMockupImport(h.ctx, admin.viewer, id)).rejects.toThrow(HtmlMockupImportError);
    await expect(importIt(id, admin.viewer.id)).rejects.toThrow("There is no homepage HTML file to read");
    await uploadHtml(id, admin.viewer.id);
    await queueHtmlMockupImport(h.ctx, admin.viewer, id);
    expect(queued[0]!.name).toBe(HTML_MOCKUP_IMPORT_JOB);
    expect((queued[0]!.data as HtmlMockupImportJobData).projectId).toBe(id);
  });
});

const PARTS = `<header class="band"><a class="skip" href="#main">Skip to content</a><a href="/">Pat Rivera Plumbing</a><nav><a href="/">Home</a> <a href="/drain-cleaning/">Drain cleaning</a></nav></header>
<footer class="band"><p>Pat Rivera Plumbing</p><p>Website by Velocity Media Lab</p></footer>`;
const mainFor = (name: string) => `<main><section class="band"><h1>${name} written by the AI</h1></section></main>`;

async function approveCopy(id: string, pages: (typeof pagePlanPage.$inferSelect)[], userId: string) {
  for (const page of pages) {
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page.id, version: 1, source: "draft", status: "done", body: `# ${page.name}\n\nCopy.\n`, approvedByUserId: userId, approvedAt: new Date() });
  }
}

async function buildAndCollect(id: string, userId: string, pageMain: (name: string) => string = mainFor) {
  await startSiteBuild(h.ctx, { id: userId, email: "admin@velocitymedialab.com", isAdmin: true, isDisabled: false, roles: [], kind: "team" }, id);
  const job = queued.find((q) => (q.data as SiteBuildJobData).buildId)!;
  const prompts: string[] = [];
  const claude = fakeClaude(() => [], {
    builder: (params) => {
      const text = String((params.messages as { content: string }[])[0]!.content);
      prompts.push(text);
      return turn(text.startsWith("# The shared parts") ? PARTS : pageMain(/# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page"), "end_turn");
    },
  });
  await runSiteBuildJob(job.data as SiteBuildJobData, config, claude.client as never, fakeBrowser());
  return { prompts };
}

describe("C2: Build A keeps the supplied home page", () => {
  it("writes the supplied home page as it is, writes its pictures, and asks the AI only for the other pages", async () => {
    const { admin, id, pages } = await readyProject();
    await uploadHtml(id, admin.viewer.id);
    const { conceptId } = await importIt(id, admin.viewer.id);
    // The team records the client's approval, as for any concept.
    await h.db.insert(clientDecision).values({ projectId: id, conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    await approveCopy(id, pages, admin.viewer.id);

    const { prompts } = await buildAndCollect(id, admin.viewer.id);
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect(build).toMatchObject({ status: "done", conceptId });

    const prefix = `projects/${id}/site/v1/`;
    const home = r2.objects.get(`${prefix}index.html`)!.toString("utf8");
    // Kept: the supplied words are there, and the AI's version of the home page is not.
    expect(home).toContain("Supplied hero words that must survive");
    expect(home).toContain("Supplied services band");
    expect(home).not.toContain("written by the AI");
    // By code, as on every page: the token is a site file, never left in the page, and the scripts are gone.
    expect(home).not.toContain("tawd-asset:");
    expect(home).toMatch(/\/images\/photo-page-1\.png/);
    expect(r2.objects.has(`${prefix}images/photo-page-1.png`)).toBe(true);
    // The font: a real file on the site, the shared stylesheet pointing at it, and no token of any kind left in any deployed text file (the _source folder keeps tokens on purpose, for later edits).
    expect(r2.objects.get(`${prefix}fonts/font-1.woff2`)!.toString("base64")).toBe(FONT_B64);
    expect(r2.objects.get(`${prefix}site.css`)!.toString("utf8")).toContain("url(/fonts/font-1.woff2)");
    const leftovers = [...r2.objects].filter(([key, body]) => key.startsWith(prefix) && !key.startsWith(`${prefix}_source/`) && /.(html|css|json|txt|xml)$/.test(key) && body.toString("utf8").includes("tawd-asset:")).map(([key]) => key);
    expect(leftovers).toEqual([]);
    expect(home).toContain("Website by Velocity Media Lab");
    // The other pages are still written by the AI, from the supplied page's design system.
    expect(prompts.some((p) => /^# The page: Home/.test(p))).toBe(false);
    const planned = pages.filter((p) => p.kind !== "home");
    expect(prompts.filter((p) => p.startsWith("# The page:"))).toHaveLength(planned.length);
    expect(r2.objects.get(`${prefix}site.css`)!.toString("utf8")).toContain(".hero h1");
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.runId, build!.id));
    expect(calls.filter((c) => c.step === "site_page")).toHaveLength(planned.length);
  }, 60_000);

  it("a generated Lane 1 mockup is built exactly as before: the home page is written by the AI", async () => {
    const { admin, id, pages } = await readyProject();
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "succeeded" } as never).returning();
    const key = `projects/${id}/concepts/${c!.id}/v1/page.html`;
    r2.objects.set(key.replace(/page\.html$/, "source.html"), Buffer.from(SUPPLIED.replace(/data:image[^"]+/, "tawd-asset:photo-1")));
    await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: key } as never);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "A", recordedByUserId: admin.viewer.id });
    await approveCopy(id, pages, admin.viewer.id);

    const { prompts } = await buildAndCollect(id, admin.viewer.id);
    expect(prompts.some((p) => /^# The page: Home/.test(p))).toBe(true);
    expect(prompts.filter((p) => p.startsWith("# The page:"))).toHaveLength(pages.length);
    const home = r2.objects.get(`projects/${id}/site/v1/index.html`)!.toString("utf8");
    expect(home).toContain("Home written by the AI");
    expect(home).not.toContain("Supplied hero words that must survive");
  }, 60_000);
});

describe("what Build A is given for a supplied homepage", () => {
  // The second run: a logo swap makes a later version of the same concept, with no picture list of its own.
  it("finds the pictures of the newest earlier version when a logo-swap version is the approved one", async () => {
    const { admin, id } = await readyProject();
    await uploadHtml(id, admin.viewer.id);
    const { conceptId } = await importIt(id, admin.viewer.id);
    const swapped = `projects/${id}/concepts/${conceptId}/v2/page.html`;
    const home = await loadSuppliedHome(r2, { id: conceptId, direction: HTML_HOMEPAGE_CONCEPT }, { htmlKey: swapped, version: 2 });
    expect(home!.images.map((i) => [i.token, i.path])).toEqual([["tawd-asset:photo-page-1", "/images/photo-page-1.png"], ["tawd-asset:font-1", "/fonts/font-1.woff2"]]);
    expect(home!.images[0]!.bytes.toString("base64")).toBe(PNG_B64);
  });

  it("is nothing at all for any other concept", async () => {
    expect(await loadSuppliedHome(r2, { id: "c", direction: "trust-first-local" }, { htmlKey: "projects/p/concepts/c/v1/page.html", version: 1 })).toBeNull();
  });

  it("keeps everything between the header and the footer, and refuses a page with nothing in it", () => {
    expect(suppliedHomeMain({ sections: ["<section>A</section>", "<section>B</section>"] })).toBe(['<main id="main" data-tawd-kept>', '<section>A</section>', '<section>B</section>', '</main>'].join(String.fromCharCode(10)));
    expect(() => suppliedHomeMain({ sections: [] })).toThrow("nothing between its header and its footer");
  });
});

/* ======================================================================
   The wiring (16 November 2026): three people built the parts and nobody
   owned the joins. These tests are the joins.
   ====================================================================== */

async function projectAt(status: "intake" | "mockups" | "content" | "build" = "mockups") {
  const admin = await seedAdmin(h);
  session.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Pat Rivera Plumbing", trade: "plumbing", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: 1, status, memberUserIds: [] });
  return { admin, id };
}

/* The real route: sign, upload to storage, confirm through the same action the browser calls. */
async function uploadThroughTheDoor(id: string, admin: Awaited<ReturnType<typeof seedAdmin>>, html = SUPPLIED, name = "homepage.html") {
  const ticket = await requestUpload(h.ctx, admin.viewer, id, "homepage_html", name, "text/html", html.length);
  r2.objects.set(ticket.uploadUrl, Buffer.from(html));
  return { ticket, confirmed: await confirmUploadAction(ticket.fileId) };
}

const onlyJobs = () => queued.filter((q) => q.name === HTML_MOCKUP_IMPORT_JOB);
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("W1: confirming an upload reads the file by itself", () => {
  it("an upload reaches the import and the board, end to end, with nothing pressed", async () => {
    const { admin, id } = await projectAt();
    const { confirmed } = await uploadThroughTheDoor(id, admin);
    expect(confirmed).toEqual({ ok: true });

    // The confirm queued exactly one read, for this project, by this person.
    expect(onlyJobs()).toHaveLength(1);
    const data = onlyJobs()[0]!.data as HtmlMockupImportJobData;
    expect(data).toMatchObject({ projectId: id, startedByUserId: admin.viewer.id });
    expect((await loadHomepageRead(h.db as Database, id)).state).toBe("reading");

    // The worker takes that very job and the page is on the board.
    await runHtmlMockupImportJob(h.db as Database, fakeBrowser() as never, data, { storage: r2, render: countingRender as never });
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view.state).toBe("done");
    expect(view.done!.version).toBe(1);
    const [row] = await h.db.select().from(concept).where(eq(concept.id, view.done!.conceptId));
    expect(row).toMatchObject({ direction: HTML_HOMEPAGE_CONCEPT, label: "S" });
    // The page was photographed with script OFF.
    expect(renders.at(-1)).toEqual({ javaScript: false });
  });

  it("a repeated confirm, a double click and two clicks together are one read", async () => {
    const { admin, id } = await projectAt();
    const { ticket } = await uploadThroughTheDoor(id, admin);
    // The same confirm again: the file is already ready, so nothing new starts.
    expect(await confirmUploadAction(ticket.fileId)).toEqual({ ok: true });
    expect(onlyJobs()).toHaveLength(1);

    // Even with the queue's own duplicate-id guard switched off, the screen's state stops a second read...
    dedupeById = false;
    expect(await queueHtmlMockupImport(h.ctx, admin.viewer, id)).toBe("already_reading");
    expect(await readHomepageAgainAction(id)).toEqual({ ok: true });
    expect(onlyJobs()).toHaveLength(1);

    // ...and two "read it again" clicks at the very same moment are one job, because the job id is the file's plus the minute (the queue ignores a second add).
    dedupeById = true;
    jobs.clear();
    const clicks = await Promise.all([queueHtmlMockupImport(h.ctx, admin.viewer, id, { again: true }), queueHtmlMockupImport(h.ctx, admin.viewer, id, { again: true })]);
    expect(clicks).toEqual(["queued", "queued"]);
    expect(onlyJobs()).toHaveLength(2);
  });

  it("a job queued twice for one file stores and photographs it once", async () => {
    const { admin, id } = await projectAt();
    await uploadThroughTheDoor(id, admin);
    const before = renders.length;
    await importIt(id, admin.viewer.id);
    const again = await importIt(id, admin.viewer.id);
    expect(renders.length - before).toBe(1);
    expect(again.version).toBe(1);
    expect(await h.db.select().from(conceptVersion)).toHaveLength(1);
    // Only "Read it again" reads it a second time.
    expect((await importIt(id, admin.viewer.id, true)).version).toBe(2);
  });

  it("only a homepage file starts a read: any other upload queues nothing", async () => {
    const { admin, id } = await projectAt();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
    const ticket = await requestUpload(h.ctx, admin.viewer, id, "photo", "van.png", "image/png", png.length);
    r2.objects.set(ticket.uploadUrl, png);
    expect(await confirmUploadAction(ticket.fileId)).toEqual({ ok: true });
    expect(onlyJobs()).toHaveLength(0);
  });

  it("the queue being down never fails the upload: the screen says it is not read yet, with a way to run it", async () => {
    const { admin, id } = await projectAt();
    queueDown = true;
    const { confirmed } = await uploadThroughTheDoor(id, admin);
    expect(confirmed).toEqual({ ok: true });
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view.state).toBe("not_read");
    const html = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={view} />);
    expect(html).toContain("Saved, but not read yet");
    expect(html).toContain("Read it now");
    // The button's own action reports the queue plainly while it is down, and starts the read once it is back.
    expect(await readHomepageAgainAction(id)).toEqual({ ok: false, message: "The homepage couldn't be queued: the job queue isn't answering. Try again in a minute." });
    queueDown = false;
    expect(await readHomepageAgainAction(id)).toEqual({ ok: true });
    expect(onlyJobs()).toHaveLength(1);
  });

  it("a failed read is shown with its reason and a button, and running it again queues a fresh job", async () => {
    const { admin, id } = await projectAt();
    await uploadThroughTheDoor(id, admin);
    await h.db.insert(jobFailure).values({ queue: "tawd-mockups", jobName: HTML_MOCKUP_IMPORT_JOB, jobId: "j", projectId: id, label: "Supplied homepage", errorClass: "HtmlMockupImportError", message: "The homepage file has no <body>, so there is no page in it to show." });
    // The first job has finished (failed): it is no longer waiting.
    for (const key of jobs.keys()) jobs.set(key, "completed");
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view).toMatchObject({ state: "failed", failure: expect.stringContaining("no <body>") });
    const html = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={view} />);
    expect(html).toContain("The homepage file could not be read");
    expect(html).toContain("The homepage file has no &lt;body&gt;");
    expect(html).toContain("Read it again");
    expect(await readHomepageAgainAction(id)).toEqual({ ok: true });
    expect(onlyJobs()).toHaveLength(2);
    expect((onlyJobs()[1]!.data as HtmlMockupImportJobData).again).toBe(true);
    expect(onlyJobs()[1]!.jobId).not.toBe(onlyJobs()[0]!.jobId);
  });

  it("says it is being read while it is, and shows what happened in full when it is done", async () => {
    const { admin, id } = await projectAt();
    await uploadThroughTheDoor(id, admin);
    const reading = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={await loadHomepageRead(h.db as Database, id)} />);
    expect(reading).toContain("Reading the homepage file");
    await importIt(id, admin.viewer.id);
    const view = await loadHomepageRead(h.db as Database, id);
    const done = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={view} />);
    expect(done).toContain("Read: version 1 is on the Mockups board");
    // Every note, in full (the board used to say "3 notes" and show none).
    expect(view.done!.removed.length).toBeGreaterThan(0);
    for (const note of [...view.done!.removed, ...view.done!.warnings]) expect(done).toContain(escapeHtml(note));
    // True of the code: the page is cleaned, not read as it came; no TAWD check ran.
    expect(done).toContain("cleaned, not read as it came");
    expect(done).toContain("did not run on it");
  });

  it("lists a picture or font that was left out, in full, beside what was taken out", async () => {
    const { admin, id } = await projectAt();
    const broken = SUPPLIED.replace("<h2>Supplied services band</h2>", '<h2>Supplied services band</h2><img src="data:image/png;base64,AAAAAAAAAAAAAAAA" alt="Broken">');
    await uploadThroughTheDoor(id, admin, broken);
    await importIt(id, admin.viewer.id);
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view.done!.warnings.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={view} />);
    for (const note of view.done!.warnings) expect(html).toContain(escapeHtml(note));
    expect(html).toContain(`${view.done!.removed.length + view.done!.warnings.length} notes from reading the file`);
  });

  it("tells the team when a new file leaves the approved version in charge, and when the plan has no Home page", async () => {
    const { admin, id } = await projectAt();
    await uploadThroughTheDoor(id, admin);
    const first = await importIt(id, admin.viewer.id);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId: first.conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    expect((await loadHomepageRead(h.db as Database, id)).done!.approvedOlder).toBeNull();
    await h.db.delete(intakeFile).where(eq(intakeFile.projectId, id));
    await uploadThroughTheDoor(id, admin, SUPPLIED.replace("Supplied hero", "Second hero"), "second.html");
    await importIt(id, admin.viewer.id);
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view.done!.approvedOlder).toEqual({ approved: 1, latest: 2 });
    const html = renderToStaticMarkup(<HomepageHtmlSection projectId={id} canEdit files={[]} read={view} />);
    expect(html).toContain("The client approved version 1, not version 2");
    expect(html).toContain("still builds from the approved version 1");
    // A plan with pages but no Home page: said at once.
    await h.db.insert(pagePlanPage).values({ projectId: id, name: "Drain cleaning", kind: "service", slug: "drain-cleaning", position: 1 } as never);
    expect((await loadHomepageRead(h.db as Database, id)).done!.planHasNoHome).toBe(true);
  });
});

describe("W6: the import's own refusals say what to do", () => {
  it("refuses a file with no <body>, naming the way forward", async () => {
    const { admin, id } = await projectAt();
    await uploadHtml(id, admin.viewer.id, "<!doctype html><html><head><title>x</title></head></html>");
    await expect(importIt(id, admin.viewer.id)).rejects.toThrow(/no <body>.*remove this file and upload the right one/);
    expect(await h.db.select().from(concept)).toHaveLength(0);
  });

  it("says that the old file has to be removed first when the stored one is gone", async () => {
    const { admin, id } = await projectAt();
    await uploadHtml(id, admin.viewer.id);
    r2.objects.clear();
    await expect(importIt(id, admin.viewer.id)).rejects.toThrow(/Remove it on Intake, then upload it again/);
  });
});

async function suppliedOnBoard(options: { withGenerated?: boolean } = {}) {
  const { admin, id } = await projectAt("mockups");
  const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
  let generated: string | null = null;
  if (options.withGenerated) {
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "ready" } as never).returning();
    generated = c!.id;
  }
  await uploadHtml(id, admin.viewer.id);
  const { conceptId } = await importIt(id, admin.viewer.id);
  return { admin, id, run: run!, generated, conceptId };
}

describe("W2 and W3: the supplied concept is not a generated one", () => {
  it("gets its own label, in the latest run, never colliding with a generated or the designer's concept", async () => {
    const { run, generated, conceptId } = await suppliedOnBoard({ withGenerated: true });
    const rows = await h.db.select().from(concept).where(eq(concept.runId, run.id));
    expect(rows.map((r) => r.label).sort()).toEqual(["A", "S"]);
    expect(rows.find((r) => r.id === conceptId)!.runId).toBe(run.id);
    expect(generated).not.toBeNull();
  });

  it("knows which concepts a skill built", () => {
    expect(isGeneratedConcept("impeccable")).toBe(true);
    expect(isGeneratedConcept("designer")).toBe(false);
    expect(isGeneratedConcept(HTML_HOMEPAGE_CONCEPT)).toBe(false);
  });

  it("is never sent to the paid Creative Director review, and a review run with only it makes no AI call", async () => {
    const { id, run, conceptId } = await suppliedOnBoard();
    const { client, calls } = fakeClaude(() => []);
    await runReviewJob({ runId: run.id, projectId: id }, config, client as never, fakeBrowser());
    expect(calls).toHaveLength(0);
    const [row] = await h.db.select().from(concept).where(eq(concept.id, conceptId));
    expect(row!.status).toBe("ready");
    expect(await h.db.select().from(aiCall)).toHaveLength(0);
    // "Run the review again" does not list it as missing its review either.
    expect(await conceptsMissingReview(h.db as Database, run.id)).toEqual([]);
  });

  it("is not judged by TAWD's page checks: nothing says it passed, and the screen says so", async () => {
    const { admin, id, conceptId } = await suppliedOnBoard();
    const [v] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
    const checks = v!.checks as Record<string, unknown>;
    expect(checks).not.toHaveProperty("passed");
    expect(checks).toMatchObject({ checked: false, source: "html_homepage", issues: [] });
    const detail = (await loadConceptDetail(h.db as Database, admin.viewer, id, conceptId, {}))!;
    expect(detail.selected.checksPassed).toBeNull();
    expect(detail.selected.supplied).toMatchObject({ fileName: "homepage.html" });
    expect(detail.concept).toMatchObject({ supplied: true, skillLabel: "" });
    const html = renderToStaticMarkup(<ConceptDetailView detail={detail} initialTab="checks" polish={null} />);
    expect(html).toContain(escapeHtml("Not judged by TAWD's page checks"));
    expect(html).not.toContain("All checks passed");
    // The notes the board used to count and never show.
    expect(detail.selected.supplied!.removed.length).toBeGreaterThan(0);
    for (const note of [...detail.selected.supplied!.removed, ...detail.selected.supplied!.warnings]) expect(html).toContain(escapeHtml(note));
    expect(v!.summary).not.toContain("read as it came");
    expect(v!.summary).toContain("cleaned");
  });

  it("is not changed, polished or logo-swapped by AI, and the client's changes are recorded without starting any", async () => {
    const { admin, id, conceptId } = await suppliedOnBoard();
    await expect(requestChanges(h.ctx, admin.viewer, { conceptId, notes: "Make the hero bigger", includeComments: false })).rejects.toThrow(SUPPLIED_NO_CHANGES);
    await expect(startPolish(h.ctx, admin.viewer, conceptId)).rejects.toThrow(/does not critique or polish it with AI/);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "ok", recordedByUserId: admin.viewer.id });
    await expect(startLogoSwap(h.ctx, admin.viewer, id)).rejects.toThrow(/no logo spot TAWD can swap/);
    await h.db.delete(clientDecision);
    const detail = (await loadConceptDetail(h.db as Database, admin.viewer, id, conceptId, {}))!;
    expect(detail.changesBlocked).toBe(SUPPLIED_NO_CHANGES);

    // The client wants changes: the decision is recorded (no dead end), and no AI round is queued.
    const result = await recordClientDecision(h.ctx, admin.viewer, { conceptId, channel: "email", changesRequested: true, clientSaid: "Wants a bigger hero" });
    expect(result.changeRequestId).toBeNull();
    expect(await h.db.select().from(conceptChangeRequest)).toHaveLength(0);
    expect(queued.filter((q) => q.name !== HTML_MOCKUP_IMPORT_JOB)).toHaveLength(0);
    expect(await h.db.select().from(clientDecision).where(eq(clientDecision.conceptId, conceptId))).toHaveLength(1);
  });
});

describe("W5: approved home copy is not required when the homepage is supplied", () => {
  async function planned() {
    const { admin, id, pages } = await readyProject();
    session.user = admin.viewer;
    await uploadHtml(id, admin.viewer.id);
    const { conceptId } = await importIt(id, admin.viewer.id);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    return { admin, id, pages, conceptId };
  }

  it("a build is ready without the home page's copy, and still waits for every other page's", async () => {
    const { admin, id, pages } = await planned();
    const others = pages.filter((p) => p.kind !== "home");
    expect(await usesSuppliedHome(h.db as Database, id)).toBe(true);
    expect((await siteReadiness(h.db as Database, id)).waiting).not.toContain("Home");
    expect((await siteReadiness(h.db as Database, id)).ready).toBe(false);
    await approveCopy(id, others, admin.viewer.id);
    const readiness = await siteReadiness(h.db as Database, id);
    expect(readiness.waiting).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it("the worker builds with no copy for the home page and keeps the supplied words", async () => {
    const { admin, id, pages } = await planned();
    await approveCopy(id, pages.filter((p) => p.kind !== "home"), admin.viewer.id);
    const { prompts } = await buildAndCollect(id, admin.viewer.id);
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect(build).toMatchObject({ status: "done" });
    expect(r2.objects.get(`projects/${id}/site/v1/index.html`)!.toString("utf8")).toContain("Supplied hero words that must survive");
    expect(prompts.some((p) => /^# The page: Home/.test(p))).toBe(false);
  }, 60_000);

  it("Content does not draft, count or ask approval for the home page", async () => {
    const { admin, id, pages } = await planned();
    const overview = await loadDraftsOverview(h.db as Database, id);
    expect(overview.suppliedHome).toBe(true);
    expect(overview.rows.map((r) => r.page.kind)).not.toContain("home");
    expect(overview.allApproved).toBe(false);
    await approveCopy(id, pages.filter((p) => p.kind !== "home"), admin.viewer.id);
    expect((await loadDraftsOverview(h.db as Database, id)).allApproved).toBe(true);
    // No draft is paid for the home page.
    await expect(startDrafts(h.ctx, admin.viewer, id)).rejects.toThrow("Every page already has a draft");
  });

  it("a generated mockup still needs the home page's copy (nothing changes for other projects)", async () => {
    const { admin, id, pages } = await readyProject();
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "ready" } as never).returning();
    await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "A", recordedByUserId: admin.viewer.id });
    await approveCopy(id, pages.filter((p) => p.kind !== "home"), admin.viewer.id);
    expect(await usesSuppliedHome(h.db as Database, id)).toBe(false);
    expect((await siteReadiness(h.db as Database, id)).waiting).toContain("Home");
  });

  it("a plan with no Home page stops the build with the reason, instead of using the supplied page nowhere", async () => {
    const { admin, id, pages } = await planned();
    await h.db.delete(pagePlanPage).where(and(eq(pagePlanPage.projectId, id), eq(pagePlanPage.kind, "home")));
    await approveCopy(id, pages.filter((p) => p.kind !== "home"), admin.viewer.id);
    await expect(startSiteBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/has no Home page to keep it as/);
    await expect(startSiteBuild(h.ctx, admin.viewer, id)).rejects.toBeInstanceOf(SiteError);
  });
});

/*
  Jason, 16 November 2026: "if we are providing a supplied home page why is TAWD
  changing it?" A supplied home page is kept: TAWD may adjust structure and
  attributes so it works, never the words a visitor reads. This page is made to
  set off every rule that rewrites words on a page a model wrote.
*/
const RICH = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Supplied</title>
<style>body{margin:0}.band{padding:48px}.btn,.button{display:inline-block}</style></head>
<body><header class="band"><a href="/">Pat Rivera Plumbing</a><nav><a href="#services">Services</a></nav></header>
<section class="band hero"><p class="eyebrow">Pat Rivera Plumbing</p><h1>Clean drains, honest plumbing</h1>
<a class="btn" href="#contact">Start with a conversation</a>
<a class="button" href="tel:+15302272479">Ring the office</a>
<p>Call 530-227-2479 or 530.227.2479 any day.</p></section>
<section class="band" id="services"><h2>Services</h2><div data-tawd-photo="van">Photo: the van</div><p>Kitchen drains, same day.</p></section>
<section class="band" id="contact"><h2>Contact</h2><a class="btn" href="/contact/">Start with a conversation</a>
<form action="/x" method="post"><label for="n">Your name please</label><input id="n" name="n" placeholder="Full name"><label for="m">Tell us what happened</label><textarea id="m" name="m"></textarea><button type="submit">Go on then</button></form>
<p>Phone: 530-227-2479</p></section>
<footer class="band"><p>Pat Rivera Plumbing</p></footer></body></html>`;

// A page's <main>, from its opening tag to its last closing tag.
const mainOf = (html: string): string => html.slice(html.indexOf("<main"), html.lastIndexOf("</main>") + "</main>".length);

describe("a supplied home page keeps every word the visitor reads", () => {
  async function builtHome(supplied = RICH) {
    const { admin, id, pages } = await readyProject();
    await uploadHtml(id, admin.viewer.id, supplied);
    const { conceptId } = await importIt(id, admin.viewer.id);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    await approveCopy(id, pages, admin.viewer.id);
    // The other pages are written by the stand-in AI with the very things the rules rewrite.
    const aiMain = (name: string) => `<main><section class="band"><h1>${name} by the AI</h1><a class="btn" href="/contact/">Describe the problem</a><p>Call 530-227-2479</p></section></main>`;
    await buildAndCollect(id, admin.viewer.id, aiMain);
    const prefix = `projects/${id}/site/v1/`;
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    const source = r2.objects.get(`projects/${id}/concepts/${conceptId}/v1/source.html`)!.toString("utf8");
    return { id, prefix, build: build!, source, pages };
  }

  it("builds a home page whose visible text is identical to the supplied page, phone number and all", async () => {
    const { prefix, build, source } = await builtHome();
    expect(build.status).toBe("done");
    const built = mainOf(r2.objects.get(`${prefix}index.html`)!.toString("utf8"));
    const supplied = suppliedHomeMain(extractDesignSystem(source));
    // The assertion that would have caught it: the same words, in the same order, in the same form.
    expect(visibleWordsLine(built)).toBe(visibleWordsLine(supplied));
    // And the specific things that were rewritten on the 16 November run.
    expect(visibleWordsLine(built)).toContain("Start with a conversation");
    expect(visibleWordsLine(built)).toContain("530-227-2479");
    expect(visibleWordsLine(built)).toContain("530.227.2479");
    expect(visibleWordsLine(built)).not.toContain("Request a quote");
    expect(visibleWordsLine(built)).not.toContain("(530) 227-2479");
    expect(visibleWordsLine(built)).not.toContain("PLACEHOLDER");
    expect(visibleWordsLine(built)).toContain("Your name please");
    expect(visibleWordsLine(built)).toContain("Go on then");
    expect(visibleWordsLine(built)).toContain("Photo: the van");
  }, 60_000);

  it("still does what a built page needs: the form submits, no scripts, the head and the shared parts are there", async () => {
    const { prefix } = await builtHome();
    const built = r2.objects.get(`${prefix}index.html`)!.toString("utf8");
    expect(built).toMatch(/<form name="contact"[^>]*data-netlify="true"/);
    expect(built).not.toContain("<script>document");
    expect(built).toContain('rel="stylesheet"');
    expect(built).toContain("application/ld+json");
    expect(built).toContain("data-tawd-kept");
  }, 60_000);

  it("tells the team what its rules would have changed, in plain words, and changes nothing", async () => {
    const { build } = await builtHome();
    const item = (build.checks as { key: string; ok: boolean; detail: string; blocksGoLive: boolean }[]).find((c) => c.key === "suppliedHomeKept")!;
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(false);
    expect(item.detail).toContain("exactly as the client approved");
    expect(item.detail).toContain('"Start with a conversation" would have become "Request a quote"');
    expect(item.detail).toContain("530-227-2479");
    expect(item.detail).toContain("(530) 227-2479");
    expect(item.detail).toContain("The form");
    expect(item.detail).toContain("picture frame");
  }, 60_000);

  it("never says TAWD rewords what it left alone, and never ends a sentence with two full stops", async () => {
    const { build } = await builtHome();
    const checks = build.checks as { key: string; detail: string }[];
    const rules = checks.find((c) => c.key === "pageRules")!;
    // The finding is still made (the kept button is not worded "Request a quote"), but it says what happened.
    expect(rules.detail).toContain(`index.html: A button that leads to the form isn't worded "Request a quote"; the supplied page is kept as written, so TAWD left it as it is.`);
    expect(rules.detail).not.toContain("TAWD rewords it");
    const kept = checks.find((c) => c.key === "suppliedHomeKept")!;
    expect(kept.detail).not.toMatch(/\.\./);
    expect(kept.detail.endsWith(".")).toBe(true);
  }, 60_000);

  it("shows every change the rules would have made, not only the first few", async () => {
    const phones = [1, 2, 3, 4, 5, 6].map((n) => `<p>Line ${n}: 530-227-100${n}</p>`).join("");
    const { build } = await builtHome(RICH.replace("<p>Phone: 530-227-2479</p>", `<p>Phone: 530-227-2479</p>${phones}`)); 

    const item = (build.checks as { key: string; detail: string; every?: string[] }[]).find((c) => c.key === "suppliedHomeKept")!;
    expect(item.detail).toMatch(/and \d+ more, all listed in full below/);
    // All eight changed pieces (the six new lines and the two the page already had) are there in full, none dropped.
    const lines = (item.every ?? []).filter((l) => l.startsWith("The phone number layout: "));
    expect(lines).toHaveLength(8);
    for (let n = 1; n <= 6; n += 1) expect(lines.join("\n")).toContain(`"Line ${n}: 530-227-100${n}" would have become "Line ${n}: (530) 227-100${n}"`);
  }, 60_000);

  it("builds every other page exactly as before: the rules still rewrite them", async () => {
    const { prefix, pages } = await builtHome();
    const other = pages.find((p) => p.kind !== "home")!;
    const html = r2.objects.get(`${prefix}${other.slug}/index.html`)!.toString("utf8");
    const text = visibleWordsLine(mainOf(html));
    expect(text).toContain("Request a quote");
    expect(text).not.toContain("Describe the problem");
    expect(text).toContain("(530) 227-2479");
    expect(text).not.toContain("530-227-2479");
    expect(html).not.toContain("data-tawd-kept");
  }, 60_000);
});

/*
  The client's decision on a supplied homepage, on a Lane 2 project (16 November
  2026). Every Lane 2 project used to show the design view and nothing else, so
  the concept existed ("1 concept built") but its board, Checks tab and
  Record the client's decision were unreachable.
*/
describe("the Mockups page for a Lane 2 project with a supplied homepage", () => {
  const renderPage = async (id: string, query: Record<string, string> = {}) =>
    renderToStaticMarkup((await MockupsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) })) as React.ReactElement);

  it("shows the concept board with the decision, and honours ?decide=", async () => {
    const { id, conceptId } = await suppliedOnBoard();
    for (const query of [{}, { decide: conceptId }] as Record<string, string>[]) {
      const html = await renderPage(id, query);
      expect(html).toContain("The supplied homepage");
      expect(html).toContain(`/projects/${id}/mockups/${conceptId}`);
      expect(html).toContain("Record client decision");
      // Neither the design view's own cards nor a Lane 1 button to generate concepts this project does not use.
      expect(html).not.toContain("Regenerate concepts");
      expect(html).not.toContain("Advanced (admins)");
    }
    // ?setup=1 can't reach the Lane 1 setup for Option A either.
    expect(await renderPage(id, { setup: "1" })).toContain("Record client decision");
  });

  it("keeps the design view one link away, and links back from it: neither hides the other", async () => {
    const { id } = await suppliedOnBoard();
    expect(await renderPage(id)).toContain(`/projects/${id}/mockups?design=1`);
    const design = await renderPage(id, { design: "1" });
    expect(design).toContain("A homepage file was supplied");
    expect(design).toContain(`href="/projects/${id}/mockups"`);
    expect(design).not.toContain("Record client decision");
  });

  it("a Lane 2 project with no supplied homepage still shows only the design view", async () => {
    const { id } = await projectAt("mockups");
    const html = await renderPage(id);
    expect(html).not.toContain("Record client decision");
    expect(html).not.toContain("A homepage file was supplied");
    expect(html).not.toContain("The client&rsquo;s design</p>");
    expect(html).not.toContain("mockups?design=1");
    // ... even with a decision query on it.
    expect(await renderPage(id, { decide: "whatever" })).not.toContain("Record client decision");
  });

  it("records the decision for the concept from this route without starting any AI round", async () => {
    const { admin, id, conceptId } = await suppliedOnBoard();
    await renderPage(id, { decide: conceptId });
    const result = await recordClientDecision(h.ctx, admin.viewer, { conceptId, channel: "email", changesRequested: true, clientSaid: "A bigger hero" });
    expect(result.changeRequestId).toBeNull();
    expect(await h.db.select().from(conceptChangeRequest)).toHaveLength(0);
  });
});

/*
  The design's own menu makes the plan, and the kept page's links follow it
  (Jason, option A, 17 November 2026). The menu below is the shape of the
  real Sample Marketing Co. file: items that point at sections of the home page, one
  that points nowhere, and links inside the page doing the same.
*/
const MENU_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Supplied</title>
<style>body{margin:0}.band{padding:48px}</style></head>
<body><header class="band"><a href="/">Pat Rivera Plumbing</a>
<nav aria-label="Main"><a href="#services">Services</a><a href="#approach">Our Approach</a><a href="#">Insights</a><a href="#contact">Contact</a></nav></header>
<section class="band hero"><h1>Clean drains, honest plumbing</h1><a class="btn" href="#services">See what we do</a><a class="btn" href="#">Read the latest</a></section>
<section class="band" id="services"><h2>Services</h2><p>Kitchen drains, same day.</p><a href="#services-list">The list</a></section>
<section class="band" id="approach"><h2>Our Approach</h2><p>We turn up when we say.</p></section>
<section class="band" id="contact"><h2>Contact</h2><p>Call the office.</p></section>
<footer class="band"><p>Pat Rivera Plumbing</p></footer></body></html>`;

describe("the supplied design's menu decides the pages, and the kept page's links follow", () => {
  async function builtFromMenu() {
    const { admin, id } = await readyProject();
    await uploadHtml(id, admin.viewer.id, MENU_PAGE);
    const { conceptId } = await importIt(id, admin.viewer.id);
    await h.db.insert(clientDecision).values({ projectId: id, conceptId, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    // The plan is made on Content, after the client's decision: it is then the design's menu that makes it.
    await makePagePlan(h.ctx, admin.viewer, id);
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    await approveCopy(id, pages.filter((p) => p.kind !== "home"), admin.viewer.id);
    const { prompts } = await buildAndCollect(id, admin.viewer.id);
    const prefix = `projects/${id}/site/v1/`;
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    return { id, prefix, build: build!, pages, prompts, home: r2.objects.get(`${prefix}index.html`)!.toString("utf8") };
  }

  it("builds the pages the menu names, and the shared header is told to link to exactly those", async () => {
    const { build, pages, prompts } = await builtFromMenu();
    expect(build.status).toBe("done");
    expect(pages.map((p) => p.name)).toEqual(["Home", "Services", "Our Approach", "Insights", "Contact"]);
    // The shared header is written once, to the menu the plan makes: it is now the design's own menu.
    const shared = prompts.find((p) => p.startsWith("# The shared parts"))!;
    expect(shared).toContain("Home (/), Services (/services/), Our Approach (/our-approach/), Insights (/insights/), Contact (/contact/)");
    // Every page the menu named was built.
    for (const page of pages.filter((p) => p.kind !== "home")) expect(prompts.some((p) => p.startsWith(`# The page: ${page.name} `))).toBe(true);
  }, 60_000);

  it("sends a link that pointed at a section of the home page to the page that now holds it, and changes nothing else", async () => {
    const { home } = await builtFromMenu();
    const main = mainOf(home);
    expect(main).toContain('href="/services/"');
    expect(main).toContain("See what we do");
    // Not a menu item: left exactly as the design wrote it.
    expect(main).toContain('href="#services-list"');
    // The words a visitor reads are untouched.
    expect(main).toContain("Kitchen drains, same day.");
    expect(main).toContain("We turn up when we say.");
  }, 60_000);

  it("lists the links the design left going nowhere, for the team, and blocks nothing", async () => {
    const { build } = await builtFromMenu();
    const item = (build.checks as { key: string; ok: boolean; detail: string; blocksGoLive: boolean }[]).find((c) => c.key === "suppliedHomeLinks")!;
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(false);
    expect(item.detail).toContain("Read the latest");
    expect(item.detail).toContain("Decide with the client where each should go");
    expect(item.detail).toContain("#services -> /services/");
  }, 60_000);
});
