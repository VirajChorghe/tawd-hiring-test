import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build A, 8c (26 September 2026): the monthly edits and the 8 dev hours.
  Claude is a stand-in; the rebuild with an edit must not call it at all.
*/

const state: { user: unknown } = { user: null };
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
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, clientDecision, concept, conceptVersion, editPage, editRequest, mockupRun, pageDraft, pageFix, pagePlanPage, pageReviewComment, project as projectTable, siteBuild } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PAGE_FIX_JOB, SITE_BUILD_JOB, SITE_EDIT_JOB } from "@tawd/core/queue";
import { PermissionError } from "@tawd/core/permissions";
import { addReviewComment, estimatePageFix, loadPageComments, markReviewComment, startPageFix } from "@/lib/page-review";
import { markPageFixFailed, runPageFixJob } from "../../../worker/src/page-fix";
import { applyPageFix, buildEditPrompt, buildPageFixPrompt, changedParts, commentPartChanged, describeFixCheck, fixableParts, hoursStanding, readPageFixReply, trackedChanges, visibleLines } from "@tawd/core/site";
import { costOf } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { FixCheck, PageReviewScreen } from "@/components/build/page-review-screen";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
import { setQueueForTesting } from "@/lib/mockups";
import { closeEditRequest, createEditRequest, estimateEdit, loadEdits, logDevTime, monthMinutesByProject, rebuildWithEdit, startEdit } from "@/lib/edits";

import { runSiteBuildJob, runSiteEditJob } from "../../../worker/src/site-build";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, turn } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: never }[];

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
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const MOCKUP = `<!doctype html><html><head><style>.band{padding:40px}</style></head><body><header class="band"><nav><a href="#">x</a></nav></header><section class="band"><h1>x</h1></section><footer class="band">x</footer></body></html>`;
const PARTS = `<header class="band"><a href="#main">Skip to content</a><nav><a href="/">Home</a></nav></header><footer class="band"><p>Website by Velocity Media Lab</p></footer>`;
const mainFor = (name: string, extra = "") => `<main id="main"><section class="band"><h1>${name}</h1><p>Open Monday to Friday.</p>${extra}</section></main>`;

/* A project with an approved mockup, approved pages and a first build with its sources saved. */
async function builtProject() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Rio Glass", trade: "glass_and_windows", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "live", memberUserIds: [] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Rio Glass", state: "NV" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Shower doors", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Reno"] });
  await makePagePlan(h.ctx, admin.viewer, id);
  const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
  const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
  const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "succeeded" } as never).returning();
  const key = `projects/${id}/concepts/${c!.id}/v1/page.html`;
  r2.objects.set(key.replace(/page\.html$/, "source.html"), Buffer.from(MOCKUP));
  await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: key } as never);
  await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "A", recordedByUserId: admin.viewer.id });
  for (const page of pages) {
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page.id, version: 1, source: "draft", status: "done", body: `# ${page.name}\n\nCopy.\n`, approvedByUserId: admin.viewer.id, approvedAt: new Date() });
  }
  // The first build, as 8a leaves it: its sources beside the files.
  const [build] = await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 1 }).returning();
  const prefix = `projects/${id}/site/v1/_source/`;
  r2.objects.set(`${prefix}parts.json`, Buffer.from(JSON.stringify({ header: PARTS.split("<footer")[0], footer: `<footer${PARTS.split("<footer")[1]}` })));
  for (const page of pages) r2.objects.set(`${prefix}pages/${page.slug || "home"}.html`, Buffer.from(mainFor(page.name)));
  return { admin, id, pages, build: build! };
}

describe("the rules", () => {
  it("asks for exactly the client's change on the page as it is", () => {
    const prompt = buildEditPrompt({ page: { name: "Contact", kind: "contact", slug: "contact" }, currentMain: mainFor("Contact"), clientWords: "Add Saturday 8 to 2", teamNote: "Under the weekday hours", pages: [] });
    expect(prompt).toContain("<client_request>\nAdd Saturday 8 to 2");
    expect(prompt).toContain("Make exactly that change on this page and nothing else");
    expect(prompt).toContain(mainFor("Contact"));
  });

  it("shows what an edit took out and put in", () => {
    expect(visibleLines(mainFor("Contact"))).toEqual(["Contact", "Open Monday to Friday."]);
    expect(trackedChanges(mainFor("Contact"), mainFor("Contact", "<p>Saturday 8 to 2.</p>"))).toEqual({ removed: [], added: ["Saturday 8 to 2."] });
    expect(trackedChanges("<p>Old line</p>", "<p>New line</p>")).toEqual({ removed: ["Old line"], added: ["New line"] });
  });

  it("counts hours against the 8 the plan includes", () => {
    expect(hoursStanding(150)).toMatchObject({ used: 2.5, over: 0, line: "2.5 of 8 dev hours this month" });
    expect(hoursStanding(9 * 60)).toMatchObject({ over: 1, line: "9 of 8 dev hours this month: 1 over the plan" });
  });
});

describe("a monthly edit", () => {
  it("is logged, made page by page with AI, shown as tracked changes, and rebuilt into the site without AI", async () => {
    const { admin, id, pages, build } = await builtProject();
    const contact = pages.find((p) => p.kind === "contact")!;
    await expect(createEditRequest(h.ctx, admin.viewer, id, { kind: "edit", clientWords: "Add our Saturday hours", teamNote: "", requestedOn: "2026-09-26", pageIds: [] })).rejects.toThrow("Choose the page");
    const requestId = await createEditRequest(h.ctx, admin.viewer, id, { kind: "edit", clientWords: "Add our Saturday hours, 8 to 2", teamNote: "Under the weekday hours", requestedOn: "2026-09-26", pageIds: [contact.id] });

    // Two clicks together start one paid edit (13 October 2026, the whole-code review).
    const both = await Promise.allSettled([startEdit(h.ctx, admin.viewer, id, requestId), startEdit(h.ctx, admin.viewer, id, requestId)]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect(queued.map((q) => q.name)).toEqual([SITE_EDIT_JOB]);
    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const text = String((params.messages as { content: string }[])[0]!.content);
        prompts.push(text);
        return turn(mainFor("Contact", "<p>Saturday 8 to 2.</p>"), "end_turn");
      },
    });
    await runSiteEditJob(queued[0]!.data, config, claude.client as never, fakeBrowser());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Add our Saturday hours, 8 to 2");
    expect(prompts[0]).toContain("Under the weekday hours");

    const [request] = await h.db.select().from(editRequest).where(eq(editRequest.id, requestId));
    expect(request).toMatchObject({ status: "edited", baseBuildId: build.id });
    const [page] = await h.db.select().from(editPage).where(eq(editPage.requestId, requestId));
    expect(page).toMatchObject({ name: "Contact", changed: true });
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.runId, requestId));
    expect(calls.map((c) => c.step)).toEqual(["site_edit"]);

    // Into the site: a new build from the saved pages, the Contact page edited, no AI at all.
    await rebuildWithEdit(h.ctx, admin.viewer, id, requestId);
    const buildJob = queued.find((q) => q.name === SITE_BUILD_JOB)!;
    const noAi = fakeClaude(() => [], {
      builder: () => {
        throw new Error("A rebuild with an edit must not call the AI.");
      },
    });
    await runSiteBuildJob(buildJob.data, config, noAi.client as never, fakeBrowser());
    const [v2] = await h.db.select().from(siteBuild).where(eq(siteBuild.version, 2));
    expect(v2).toMatchObject({ status: "done", editRequestId: requestId });
    expect(r2.objects.get(`projects/${id}/site/v2/contact/index.html`)!.toString("utf8")).toContain("Saturday 8 to 2.");
    expect(r2.objects.get(`projects/${id}/site/v2/index.html`)!.toString("utf8")).not.toContain("Saturday");
    expect((await h.db.select().from(editRequest).where(eq(editRequest.id, requestId)))[0]).toMatchObject({ status: "rebuilt", buildId: v2!.id });

    await closeEditRequest(h.ctx, admin.viewer, id, requestId);
    const actions = (await h.db.select().from(activityLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["site.edit_requested", "site.edit_started", "site.edit_made", "site.edit_closed"]));
  }, 60_000);

  it("marks new pages and redesigns as quotes, never edits them", async () => {
    const { admin, id } = await builtProject();
    const requestId = await createEditRequest(h.ctx, admin.viewer, id, { kind: "quote", clientWords: "Add a page for commercial glass", teamNote: "", requestedOn: "2026-09-26", pageIds: [] });
    const [row] = await h.db.select().from(editRequest).where(eq(editRequest.id, requestId));
    expect(row!.status).toBe("quoted");
    await expect(startEdit(h.ctx, admin.viewer, id, requestId)).rejects.toThrow("priced separately");
  });

  it("checks the project's AI cap against the estimate for every page in the edit, not one (13 October 2026)", async () => {
    const { admin, id, pages } = await builtProject();
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const requestId = await createEditRequest(h.ctx, admin.viewer, id, { kind: "edit", clientWords: "New phone number everywhere", teamNote: "", requestedOn: "2026-09-26", pageIds: pages.slice(0, 3).map((p) => p.id) });
    const one = (await estimateEdit(h.db, 1)).cost;
    // The project's cap has room for one page's edit, not three.
    await h.db.update(projectTable).set({ aiCapCents: Math.ceil(one * 200) }).where(eq(projectTable.id, id));
    expect(one * 3 * 100).toBeGreaterThan(Math.ceil(one * 200));
    await expect(startEdit(h.ctx, admin.viewer, id, requestId)).rejects.toThrow(/cap/i);
    expect((await h.db.select().from(editRequest).where(eq(editRequest.id, requestId)))[0]!.status).toBe("open");
  });

  it("logs the team's time against the month's 8 hours, and shows it with each request's AI cost", async () => {
    const { admin, id, pages } = await builtProject();
    const requestId = await createEditRequest(h.ctx, admin.viewer, id, { kind: "edit", clientWords: "Change the phone number", teamNote: "", requestedOn: "2026-09-26", pageIds: [pages[0]!.id] });
    await expect(logDevTime(h.ctx, admin.viewer, id, { requestId, minutes: 0, note: "", workedOn: "2026-09-26" })).rejects.toThrow("between 1 minute and 10 hours");
    const now = new Date("2026-09-26T18:00:00Z");
    await logDevTime(h.ctx, admin.viewer, id, { requestId, minutes: 90, note: "Phone number in header and footer", workedOn: "2026-09-26" });
    await logDevTime(h.ctx, admin.viewer, id, { requestId: null, minutes: 45, note: "Checked the forms", workedOn: "2026-09-02" });
    await logDevTime(h.ctx, admin.viewer, id, { requestId: null, minutes: 60, note: "Last month", workedOn: "2026-08-30" });
    expect((await monthMinutesByProject(h.db, now)).get(id)).toBe(135);
    const view = await loadEdits(h.db, id, now);
    expect(view.hours.line).toBe("2.3 of 8 dev hours this month");
    expect(view.requests[0]).toMatchObject({ minutes: 90, aiCost: 0 });
  });

  it("shows the edits on Updates, the hours on the project and on Revenue", async () => {
    const { admin, id, pages } = await builtProject();
    await createEditRequest(h.ctx, admin.viewer, id, { kind: "edit", clientWords: "Add our Saturday hours", teamNote: "", requestedOn: "2026-09-26", pageIds: [pages[0]!.id] });
    await logDevTime(h.ctx, admin.viewer, id, { requestId: null, minutes: 60, note: "x", workedOn: new Date().toISOString().slice(0, 10) });
    state.user = admin.viewer;
    // On Updates since 1 October 2026.
    const { default: UpdatesPage } = await import("@/app/(app)/projects/[id]/updates/page");
    const build = renderToStaticMarkup(await UpdatesPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    expect(build).toMatch(/[A-Z][a-z]+: [01](\.\d)? of 8 included hours/);
    expect(build).toContain("Add our Saturday hours");
    expect(build).toContain("Make the edit");
    const { default: ProjectPage } = await import("@/app/(app)/projects/[id]/page");
    expect(renderToStaticMarkup(await ProjectPage({ params: Promise.resolve({ id }) }))).toMatch(/[01](\.\d)? of 8 dev hours this month/);
  });
});

/* ---------- Fix these (step 3b, 3 October 2026) ---------- */

describe("Fix these on the page review", () => {
  async function reviewed() {
    const built = await builtProject();
    const pages = built.pages.map((p) => ({ pageId: p.id, name: p.name, path: p.slug ? `/${p.slug}/` : "/", shotKey: null, placeholders: [] }));
    await h.db.update(siteBuild).set({ pages }).where(eq(siteBuild.id, built.build.id));
    const contact = built.pages.find((p) => p.kind === "contact")!;
    return { ...built, contact };
  }

  const textOf = (params: Record<string, unknown>) => {
    const content = (params.messages as { content: unknown }[])[0]!.content;
    return typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("\n");
  };

  it("sends only the commented parts, then builds the next version from the saved pages with no other AI", async () => {
    const { admin, id, contact } = await reviewed();
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Add the Saturday hours, 8 to 2", area: "main", section: 0, sectionLabel: "Contact", pinX: 30, pinY: 60 });
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Put the phone in the footer", area: "footer", pinX: 10, pinY: 50 });
    await expect(startPageFix(h.ctx, admin.viewer, id, "nope")).rejects.toThrow("isn't in the latest build");

    await startPageFix(h.ctx, admin.viewer, id, contact.id);
    const job = queued.find((q) => q.name === PAGE_FIX_JOB)!;
    expect(job).toBeTruthy();
    expect((await h.db.select().from(pageReviewComment)).every((c) => c.fixId && c.tries === 1)).toBe(true);
    // One fix at a time on a site.
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Later" });
    await expect(startPageFix(h.ctx, admin.viewer, id, contact.id)).rejects.toThrow("already being made");

    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        prompts.push(textOf(params));
        return turn(
          `<tawd-part id="0"><section class="band"><h1>Contact</h1><p>Open Monday to Friday.</p><p>Saturday 8 to 2.</p></section></tawd-part>\n<tawd-part id="footer"><footer class="band"><p>Call (775) 555-0100</p><p>Website by Velocity Media Lab</p></footer></tawd-part>`,
          "end_turn",
        );
      },
    });
    await runPageFixJob(job.data, config, claude.client as never, fakeBrowser());

    // One AI call: the commented section and the footer only, never the whole page or another page.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Add the Saturday hours, 8 to 2");
    expect(prompts[0]).toContain('<tawd-part id="0">');
    expect(prompts[0]).toContain('<tawd-part id="footer">');
    expect(prompts[0]).not.toContain('<tawd-part id="header">');
    expect(prompts[0]).not.toContain("Later");
    expect((await h.db.select().from(aiCall).where(eq(aiCall.step, "site_page_fix"))).length).toBe(1);

    const [v2] = await h.db.select().from(siteBuild).where(eq(siteBuild.version, 2));
    expect(v2).toMatchObject({ status: "done" });
    expect(r2.objects.get(`projects/${id}/site/v2/contact/index.html`)!.toString("utf8")).toContain("Saturday 8 to 2.");
    // The footer is shared: every page has the new one; the other pages' own content is as it was.
    const home = r2.objects.get(`projects/${id}/site/v2/index.html`)!.toString("utf8");
    expect(home).toContain("Call (775) 555-0100");
    expect(home).not.toContain("Saturday");

    const [fix] = await h.db.select().from(pageFix);
    expect(fix).toMatchObject({ status: "done", resultVersion: 2, changed: [0, "footer"], retried: false });
    // TAWD's check found nothing, so there was no retry (3c).
    expect(fix!.checkFindings).toEqual({ firstVersion: 2, first: [], finalVersion: 2, final: [], retryNote: null });
    const sent = (await h.db.select().from(pageReviewComment)).filter((c) => c.fixId === fix!.id);
    expect(sent.map((c) => c.sentInVersion)).toEqual([2, 2]);
    expect((await h.db.select().from(activityLog)).map((a) => a.action)).toEqual(expect.arrayContaining(["site.page_fix_started", "site.page_fixed"]));
  }, 60_000);

  it("gives the comments back when nothing comes back to change, and the try doesn't count", async () => {
    const { admin, id, contact } = await reviewed();
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Bigger heading", area: "main", section: 0 });
    await startPageFix(h.ctx, admin.viewer, id, contact.id);
    const job = queued.find((q) => q.name === PAGE_FIX_JOB)!;
    const empty = fakeClaude(() => [], { builder: () => turn("Nothing to change.", "end_turn") });
    await expect(runPageFixJob(job.data, config, empty.client as never, fakeBrowser())).rejects.toThrow(/didn't return any changed part/);
    await markPageFixFailed((job.data as { fixId: string }).fixId, "The AI didn't return any changed part.");
    expect((await h.db.select().from(pageReviewComment))[0]).toMatchObject({ fixId: null, tries: 0, sentInVersion: null });
    expect((await h.db.select().from(siteBuild)).map((b) => b.version)).toEqual([1]);
  }, 60_000);

  it("is for Lane 1 sites and people who review pages, with the estimate on Sonnet 5", async () => {
    const { admin, id, contact } = await reviewed();
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "x" });
    await expect(startPageFix(h.ctx, content.viewer, id, contact.id)).rejects.toBeInstanceOf(PermissionError);
    expect((await estimatePageFix(h.db as never)).label).toMatch(/^About \$0\.\d\d of AI on Sonnet 5 \(a first guess until a fix has run\)/);
    await h.db.update(projectTable).set({ lane: "lane_2" }).where(eq(projectTable.id, id));
    await expect(startPageFix(h.ctx, admin.viewer, id, contact.id)).rejects.toThrow("Lane 1");
  });
});

/* ---------- 3c: TAWD's check, one retry, Done / Not done (5 October 2026) ---------- */

describe("After a fix: TAWD's check and one retry", () => {
  /* A header comment sent to Fix these; the stand-in's calls cost more than the first guess, so the estimate is set to fit them unless a test says otherwise. */
  async function headerFix(estimateCost = 1) {
    const built = await builtProject();
    const pages = built.pages.map((p) => ({ pageId: p.id, name: p.name, path: p.slug ? `/${p.slug}/` : "/", shotKey: null, placeholders: [] }));
    await h.db.update(siteBuild).set({ pages }).where(eq(siteBuild.id, built.build.id));
    const contact = built.pages.find((p) => p.kind === "contact")!;
    await addReviewComment(h.ctx, built.admin.viewer, { projectId: built.id, pageId: contact.id, body: "Put the menu on one line", area: "header", pinX: 50, pinY: 50 });
    const fixId = await startPageFix(h.ctx, built.admin.viewer, built.id, contact.id);
    await h.db.update(pageFix).set({ estimateCost }).where(eq(pageFix.id, fixId));
    return { ...built, contact, job: queued.find((q) => q.name === PAGE_FIX_JOB)! };
  }

  it("never lets the retry pass twice the estimate: it stops, and the first version stays", async () => {
    const { job } = await headerFix(0.01);
    const claude = fakeClaude(() => [], { builder: (params) => turn(textOf(params).includes("This is a second try") ? SECOND : FIRST, "end_turn") });
    await runPageFixJob(job.data, config, claude.client as never, fakeBrowser({ fixCheck: (arg) => (arg.width === "computer" ? [WRAP] : []) }));
    expect((await h.db.select().from(aiCall).where(eq(aiCall.step, "site_page_fix"))).length).toBe(1);
    const [fix] = await h.db.select().from(pageFix);
    expect(fix).toMatchObject({ status: "done", resultVersion: 2, retried: true });
    expect(fix!.checkFindings).toMatchObject({ final: [LINE], retryNote: expect.stringMatching(/^Stopped at twice its estimate/) });
  }, 60_000);
  const FIRST = `<tawd-part id="header"><header class="band"><nav><a href="/">Home</a><a href="/contact/">Contact</a></nav><a href="tel:+17755550100">(775) 555-0100</a></header></tawd-part>`;
  const SECOND = `<tawd-part id="header"><header class="band"><nav><a href="/">Home</a><a href="/contact/">Contact</a></nav><a href="tel:+17755550100" style="white-space:nowrap">(775) 555-0100</a></header></tawd-part>`;
  const WRAP = { part: "header", kind: "wrap", what: "phone number", text: "(775) 555-0100", lines: 2 };
  const LINE = 'Header at computer width: the phone number "(775) 555-0100" wraps onto two lines.';
  const textOf = (params: Record<string, unknown>) => {
    const content = (params.messages as { content: unknown }[])[0]!.content;
    return typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("\n");
  };

  it("finds a problem by code, sends it with the parts as they are now, and tries exactly once more", async () => {
    const { id, job } = await headerFix();
    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const text = textOf(params);
        prompts.push(text);
        return turn(text.includes("This is a second try") ? SECOND : FIRST, "end_turn");
      },
    });
    const checked: { parts: string[]; width: string }[] = [];
    // The check finds the wrap every time: the retry still happens only once.
    const browser = fakeBrowser({ fixCheck: (arg) => (checked.push(arg), arg.width === "computer" ? [WRAP] : []) });
    await runPageFixJob(job.data, config, claude.client as never, browser);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("This is a second try");
    expect(prompts[1]).toContain(LINE);
    // The parts as the first answer left them.
    expect(prompts[1]).toContain('<a href="/contact/">Contact</a>');
    expect(prompts[1]).toContain("Put the menu on one line");
    expect((await h.db.select().from(aiCall).where(eq(aiCall.step, "site_page_fix"))).length).toBe(2);
    // Two checks of the header, each at both widths.
    expect(checked.map((c) => `${c.width}:${c.parts.join(",")}`)).toEqual(["computer:header", "phone:header", "computer:header", "phone:header"]);

    const versions = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id)).orderBy(siteBuild.version);
    expect(versions.map((v) => [v.version, v.status])).toEqual([[1, "done"], [2, "done"], [3, "done"]]);
    expect(r2.objects.get(`projects/${id}/site/v3/index.html`)!.toString("utf8")).toContain("white-space:nowrap");
    const [fix] = await h.db.select().from(pageFix);
    expect(fix).toMatchObject({ status: "done", resultVersion: 3, retried: true, changed: ["header"] });
    expect(fix!.checkFindings).toEqual({ firstVersion: 2, first: [LINE], finalVersion: 3, final: [LINE], retryNote: null });
    expect((await h.db.select().from(pageReviewComment)).map((c) => c.sentInVersion)).toEqual([3]);
    const [log] = (await h.db.select().from(activityLog)).filter((a) => a.action === "site.page_fixed");
    expect(log!.valueAfter).toMatchObject({ version: 3, firstVersion: 2, retried: true, checkFound: [LINE] });
  }, 60_000);

  it("keeps the first version, with what the check found, when the one retry makes nothing", async () => {
    const { id, job } = await headerFix();
    let calls = 0;
    const claude = fakeClaude(() => [], { builder: () => turn(++calls === 1 ? FIRST : "Nothing to change.", "end_turn") });
    await runPageFixJob(job.data, config, claude.client as never, fakeBrowser({ fixCheck: (arg) => (arg.width === "computer" ? [WRAP] : []) }));
    expect((await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id))).map((b) => b.version).sort()).toEqual([1, 2]);
    const [fix] = await h.db.select().from(pageFix);
    expect(fix).toMatchObject({ status: "done", resultVersion: 2, retried: true });
    expect(fix!.checkFindings).toMatchObject({ firstVersion: 2, finalVersion: 2, final: [LINE], retryNote: expect.stringMatching(/didn't return any changed part/) });
    expect((await h.db.select().from(pageReviewComment)).map((c) => c.sentInVersion)).toEqual([2]);
  }, 60_000);

  it("prices one call per fix and per retry, and shows the most a retry adds", async () => {
    const { job } = await headerFix();
    expect((await estimatePageFix(h.db as never)).label).toMatch(/a first guess.*; up to \$0\.\d\d if TAWD's check finds a problem and it tries once more$/);
    const claude = fakeClaude(() => [], { builder: (params) => turn(textOf(params).includes("This is a second try") ? SECOND : FIRST, "end_turn") });
    await runPageFixJob(job.data, config, claude.client as never, fakeBrowser({ fixCheck: (arg) => (arg.width === "computer" ? [WRAP] : []) }));
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.step, "site_page_fix"));
    expect(calls).toHaveLength(2);
    const config5 = await stepModelConfig(h.db as never, "site_page_fix");
    const one = costOf(calls[0]!, config5);
    const estimate = await estimatePageFix(h.db as never);
    // Shared out over the two calls, not charged to the one fix.
    expect(estimate.cost).toBeCloseTo((one + costOf(calls[1]!, config5)) / 2, 6);
    expect(estimate.upTo).toBeCloseTo(estimate.cost * 2, 6);
    expect(estimate.label).toMatch(/from the 1 fix so far; the rebuild after it is free; up to \$/);
  }, 60_000);
});

describe("Done / Not done on a sent comment", () => {
  it("shows by code whether each comment's part changed, and the reviewer marks it Done or Not done", async () => {
    const built = await builtProject();
    const pages = built.pages.map((p) => ({ pageId: p.id, name: p.name, path: p.slug ? `/${p.slug}/` : "/", shotKey: null, placeholders: [] }));
    await h.db.update(siteBuild).set({ pages }).where(eq(siteBuild.id, built.build.id));
    const { admin, id } = built;
    const contact = built.pages.find((p) => p.kind === "contact")!;
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Add the Saturday hours", area: "main", section: 0, pinX: 30, pinY: 60 });
    await addReviewComment(h.ctx, admin.viewer, { projectId: id, pageId: contact.id, body: "Bigger menu", area: "header", pinX: 10, pinY: 50 });
    const [saturday, menu] = await h.db.select().from(pageReviewComment).orderBy(pageReviewComment.createdAt);
    // Nothing to mark before a fix.
    await expect(markReviewComment(h.ctx, admin.viewer, id, saturday!.id, "done")).rejects.toThrow("hasn't been through Fix these");

    await startPageFix(h.ctx, admin.viewer, id, contact.id);
    // The answer only changes the section; the header comes back as it was.
    const claude = fakeClaude(() => [], {
      builder: () =>
        turn(`<tawd-part id="0"><section class="band"><h1>Contact</h1><p>Open Monday to Friday.</p><p>Saturday 8 to 2.</p></section></tawd-part><tawd-part id="header">${PARTS.split("<footer")[0]}</tawd-part>`, "end_turn"),
    });
    await runPageFixJob(queued.find((q) => q.name === PAGE_FIX_JOB)!.data, config, claude.client as never, fakeBrowser());
    const people = new Map<string, string>();
    let comments = await loadPageComments(h.db, id, contact.id, people);
    expect(comments.map((c) => [c.tag.kind, c.tag.version, c.change])).toEqual([
      ["sent", 2, "changed"],
      ["sent", 2, "unchanged"],
    ]);

    // Only people who review pages.
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await expect(markReviewComment(h.ctx, content.viewer, id, saturday!.id, "done")).rejects.toBeInstanceOf(PermissionError);

    await markReviewComment(h.ctx, admin.viewer, id, saturday!.id, "done");
    await markReviewComment(h.ctx, admin.viewer, id, menu!.id, "not_done");
    comments = await loadPageComments(h.db, id, contact.id, people);
    expect(comments[0]).toMatchObject({ resolved: true, outcome: { kind: "done", version: 2 }, askDesigner: false });
    // Not done: open again as Not sent, so it goes with the next Fix these.
    expect(comments[1]).toMatchObject({ resolved: false, tag: { kind: "not_sent" }, outcome: { kind: "not_done", version: 2 }, change: null, askDesigner: false });
    await expect(markReviewComment(h.ctx, admin.viewer, id, saturday!.id, "not_done")).rejects.toThrow("already resolved");
    const actions = (await h.db.select().from(activityLog)).filter((a) => a.action.startsWith("site.page_comment_"));
    expect(actions.map((a) => [a.action, (a.valueAfter as { version: number; commentId: string }).version, (a.valueAfter as { commentId: string }).commentId])).toEqual([
      ["site.page_comment_done", 2, saturday!.id],
      ["site.page_comment_not_done", 2, menu!.id],
    ]);

    // The second try: only the reopened comment goes, marked as asked before.
    queued.length = 0;
    await startPageFix(h.ctx, admin.viewer, id, contact.id);
    const prompts: string[] = [];
    const again = fakeClaude(() => [], {
      builder: (params) => {
        prompts.push(String((params.messages as { content: unknown }[])[0]!.content));
        return turn(`<tawd-part id="header"><header class="band"><a href="#main">Skip to content</a><nav style="font-size:18px"><a href="/">Home</a></nav></header></tawd-part>`, "end_turn");
      },
    });
    await runPageFixJob(queued.find((q) => q.name === PAGE_FIX_JOB)!.data, config, again.client as never, fakeBrowser());
    expect(prompts.join("\n")).toContain("Bigger menu (Asked before and not done");
    expect(prompts.join("\n")).not.toContain("Add the Saturday hours");
    comments = await loadPageComments(h.db, id, contact.id, people);
    expect(comments[1]).toMatchObject({ tag: { kind: "sent", version: 3 }, change: "changed" });
    // A second Not done: "Ask the Web Designer", without blocking anything.
    await markReviewComment(h.ctx, admin.viewer, id, menu!.id, "not_done");
    comments = await loadPageComments(h.db, id, contact.id, people);
    expect(comments[1]).toMatchObject({ tag: { kind: "not_sent" }, outcome: { kind: "not_done", version: 3 }, askDesigner: true });
  }, 90_000);

  it("shows TAWD's check above the comments, the tags and the Done / Not done buttons", () => {
    const base = { id: "c1", number: 1, version: 2, author: "Sam", body: "Menu on one line", area: "header" as const, section: null, sectionLabel: null, pinX: 1, pinY: 1, when: "today", replies: [] };
    const html = renderToStaticMarkup(
      <>
        <FixCheck
          version={3}
          fix={{ status: "done", detail: null, failureReason: null, resultVersion: 3, changed: ["the header"], retried: true, check: { firstVersion: 2, first: ["x"], finalVersion: 3, final: ["Header at computer width: the button \"Send a question\" wraps onto two lines."], retryNote: null } }}
        />
        <PageReviewScreen
          projectId="p"
          version={3}
          page={{ pageId: "pg", name: "Home", path: "/" }}
          frameSrc="/x"
          position={{ index: 1, of: 1 }}
          approvedCount={0}
          approvedLine={null}
          partsChangedOnly={false}
          next={null}
          pages={[{ pageId: "pg", name: "Home", approved: false }]}
          canApprove
          canFix
          fix={null}
          fixEstimate="About $0.10"
          comments={[
            { ...base, resolved: false, tag: { kind: "sent", version: 3 }, change: "unchanged", outcome: null, askDesigner: false },
            { ...base, id: "c2", number: 2, resolved: false, tag: { kind: "not_sent", version: null }, change: null, outcome: { kind: "not_done", version: 3 }, askDesigner: true },
          ]}
        />
      </>,
    );
    expect(html).toContain("TAWD’s check found:");
    expect(html).toContain("wraps onto two lines.");
    expect(html).toContain("It tried once more (version 3) and stopped there.");
    expect(html).toContain("Nothing changed here");
    expect(html).toContain(">Done<");
    expect(html).toContain(">Not done<");
    expect(html).toContain("Not done in v3");
    expect(html).toContain("Ask the Web Designer");
    const passed = renderToStaticMarkup(
      <FixCheck version={3} fix={{ status: "done", detail: null, failureReason: null, resultVersion: 3, changed: [], retried: true, check: { firstVersion: 2, first: ["x"], finalVersion: 3, final: [], retryNote: null } }} />,
    );
    expect(passed).toContain("version 3 passed the check");
  });
});

describe("3c by code: what changed, the check's words, the standing rules", () => {
  const shared = { header: "<header>H</header>", footer: "<footer>F</footer>" };
  const main = `<main><section>A</section><section>B</section><section>C</section></main>`;

  it("finds which parts really changed, numbered as before the fix", () => {
    expect(changedParts({ main, ...shared }, { main, ...shared })).toEqual([]);
    expect(changedParts({ main, ...shared }, { main: main.replace("B", "B2"), ...shared, footer: "<footer>F2</footer>" })).toEqual([1, "footer"]);
    // Spacing alone is no change.
    expect(changedParts({ main: "<main><section>A B</section></main>", ...shared }, { main: "<main><section>A \n  B</section></main>", ...shared, header: "\n  <header>H</header>  " })).toEqual([]);
    // A part added after B: counted at the place it went in (part 3); A and B unchanged.
    expect(changedParts({ main, ...shared }, { main: main.replace("<section>B</section>", "<section>B</section><section>B+</section>"), ...shared })).toEqual([2]);
    expect(commentPartChanged("header", [1, "footer"])).toBe(false);
    expect(commentPartChanged(1, [1, "footer"])).toBe(true);
    expect(commentPartChanged(null, [])).toBe(false);
    expect(commentPartChanged(null, ["footer"])).toBe(true);
  });

  it("says what the check found in plain English, once each, and leaves out what isn't a problem", () => {
    expect(
      describeFixCheck([
        {
          width: "computer",
          found: [
            { part: "header", kind: "wrap", what: "phone number", text: "(555) 555-5555", lines: 2 },
            { part: "header", kind: "wrap", what: "phone number", text: "(555) 555-5555", lines: 2 },
            { part: "header", kind: "wrap", what: "button", text: "Send a question", lines: 1 },
            { part: "0", kind: "overflow", what: "element", text: "Call now", by: 24 },
            { part: "0", kind: "overflow", what: "element", text: "Tiny", by: 1 },
          ],
        },
        { width: "phone", found: [{ part: "footer", kind: "image", what: "picture", text: "logo.webp" }, { part: "header", kind: "overflow", what: "part", text: "", by: 40 }] },
      ]),
    ).toEqual([
      'Header at computer width: the phone number "(555) 555-5555" wraps onto two lines.',
      'Part 1 at computer width: "Call now" sticks out 24 px past the edge of the page.',
      "Footer at phone width: a picture doesn't load (logo.webp).",
      "Header at phone width: the header is 40 px wider than the page.",
    ]);
  });

  it("gives the fix step its standing rules, and the retry the problems found", () => {
    const input = { page: { name: "Home", kind: "home", slug: "" }, comments: [{ number: 1, body: "Menu on one line", part: "header" as const, label: null }], parts: [{ id: "header" as const, html: "<header>H</header>" }], pages: [], withPictures: false };
    const text = buildPageFixPrompt(input);
    expect(text).toContain("Phone numbers and buttons never wrap onto a second line: give them white-space: nowrap.");
    expect(text).toContain("At computer width (1,280 px) the header fits on one line");
    expect(text).toContain("Keep the logo at its size");
    expect(text).toContain("shrink gaps and padding first");
    expect(text).toContain("opens on hover and on keyboard focus");
    expect(text).not.toContain("This is a second try");
    const retry = buildPageFixPrompt({ ...input, problems: ['Header at computer width: the phone number "(555) 555-5555" wraps onto two lines.'] });
    expect(retry).toContain("This is a second try");
    expect(retry).toContain('<problems>\n- Header at computer width: the phone number "(555) 555-5555" wraps onto two lines.\n</problems>');
  });
});

describe("Fix these: the parts, the prompt and the answer", () => {
  const main = `<main id="main"><section><h1>Contact</h1></section><section><h2>Hours</h2><p>Mon to Fri</p></section><script>1</script><section><form></form></section></main>`;

  it("numbers the page's parts as the review screen does, and puts changed ones back in place", () => {
    expect(fixableParts(main).map((p) => p.index)).toEqual([0, 1, 2]);
    const out = applyPageFix(main, { header: "<header>H</header>", footer: "<footer>F</footer>" }, readPageFixReply(`<tawd-part id="1"><section><h2>Hours</h2><p>Mon to Sat</p></section></tawd-part><tawd-part id="9">x</tawd-part><tawd-part id="header"><header>H2</header></tawd-part>`, [1, "header"]));
    expect(out.main).toBe(`<main id="main"><section><h1>Contact</h1></section><section><h2>Hours</h2><p>Mon to Sat</p></section><script>1</script><section><form></form></section></main>`);
    expect(out).toMatchObject({ header: "<header>H2</header>", footer: "<footer>F</footer>", changed: [1, "header"] });
  });

  it("asks for exactly the comments, marks a second try, and says the header and footer are shared", () => {
    const text = buildPageFixPrompt({
      page: { name: "Contact", kind: "contact", slug: "contact" },
      comments: [
        { number: 1, body: "Add Saturday", part: 1, label: "Hours" },
        { number: 2, body: "Phone in the footer", part: "footer", label: null, secondTry: true },
      ],
      parts: [{ id: 1, html: "<section>Hours</section>" }, { id: "footer", html: "<footer>F</footer>" }],
      pages: [{ name: "Contact", kind: "contact", slug: "contact" }],
      withPictures: true,
    });
    expect(text).toContain('1. On part 1 ("Hours"): Add Saturday');
    expect(text).toContain("2. On the footer: Phone in the footer (Asked before and not done");
    expect(text).toContain("shared by every page");
    expect(text).toContain("pictures of them as they look now");
    expect(text).toContain('<tawd-part id="footer">');
  });
});
