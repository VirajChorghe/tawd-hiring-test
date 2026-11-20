import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  A homepage supplied as one HTML file runs the Lane 1 journey (Jason, 16
  November 2026): it is a mockup, which is Lane 1's own artefact, made by hand
  instead of by Claude. These tests walk that path through the same functions
  and pages the browser uses: the upload where a Lane 1 project can reach it,
  the board, the client's decision, and the stage the project then stands at.
  The photographs are a stand-in (no Chromium); no AI is involved anywhere.
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

import { setDbForTesting, type Database } from "@tawd/core/db";
import { appSetting, clientDecision, concept, conceptVersion, intakeFile, keywordResearch, mockupRun, pagePlanPage, project } from "@tawd/core/schema";
import { suppliedHomeFile, suppliedHomeNav, suppliedHomeWords } from "@tawd/core/site-read";
import { requestUpload, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { HTML_HOMEPAGE_CONCEPT, STEP_MODELS_SETTING } from "@tawd/core/mockups";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { confirmUploadAction } from "@/app/actions";
import { loadHomepageRead } from "@/lib/html-mockup-import";
import { recordClientDecision } from "@/lib/concept-review";
import { loadSeoView, makePagePlan } from "@/lib/seo-data";
import { buildCopyPack, loadDraftsOverview, moveToBuild, recordCopyDecision } from "@/lib/content-drafts";
import { loadStages, siteReadiness, stagesCardProps } from "@/lib/site-builds";
import { stageConfirmText } from "@/components/build/site-card";
import { loadJourneyFacts, journeySteps } from "@/lib/journey";
import { loadNextStepFor } from "@/lib/next-step";
import IntakePage from "@/app/(app)/projects/[id]/intake/page";
import MockupsPage from "@/app/(app)/projects/[id]/mockups/page";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import { loadPrepareView, prepareContent } from "@/lib/content-prep";
import { runHtmlMockupImportJob } from "../../../worker/src/html-mockup-import";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let jobs: { name: string; data: unknown }[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  jobs = [];
  session.user = null;
  serverState.ctx = h.ctx;
  setQueueForTesting({
    add: async (name, data) => {
      jobs.push({ name, data });
    },
    getJob: async () => null,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SUPPLIED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Supplied</title><style>body{margin:0}.band{padding:48px}</style></head>
<body><header class="band"><a href="/">Sample Marketing Co.</a></header>
<section class="band"><h1>Marketing that fills your calendar</h1><img src="data:image/png;base64,${PNG_B64}" alt="Team"></section>
<section class="band"><h2>What we do</h2><p>Plans from $499 a month.</p></section>
<footer class="band"><p>Sample Marketing Co.</p></footer></body></html>`;
/* The same page with the menu the real Sample Marketing Co. file carries: six items, one of them going nowhere, and a button that is not a page. */
const SUPPLIED_WITH_NAV = SUPPLIED.replace(
  '<header class="band"><a href="/">Sample Marketing Co.</a></header>',
  '<header class="band"><a href="/">Sample Marketing Co.</a><nav aria-label="Main"><a href="#services">Services</a><a href="#approach">Our Approach</a><a href="#sarah">About Sarah</a><a href="#">Insights</a><a href="#contact">Contact</a></nav><a class="btn" href="#contact">Start with a conversation</a></header>',
).replace("<h2>What we do</h2>", '<h2 id="services">What we do</h2><a href="#services">All services</a><a href="#">Read more</a>');
const SHOT = { fullPage: Buffer.from("full"), fold: Buffer.from("fold"), heightPx: 1200, truncated: false, bands: [], imageHeightPx: 1200 };

async function makeProject(lane: "lane_1" | "lane_2", status: "intake" | "mockups" | "content" = "intake") {
  const admin = await seedAdmin(h);
  session.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Sample Marketing Co.",
    trade: "plumbing",
    tier: "starter",
    lane,
    laneOption: lane === "lane_2" ? "a" : null,
    conceptCount: 3,
    status,
    memberUserIds: [],
  });
  return { admin, id };
}

/* The real door: sign, upload, confirm with the action the browser calls; then the worker reads the job that was queued. */
async function uploadAndRead(id: string, admin: Awaited<ReturnType<typeof seedAdmin>>, html = SUPPLIED) {
  const ticket = await requestUpload(h.ctx, admin.viewer, id, "homepage_html", "homepage.html", "text/html", html.length);
  r2.objects.set(ticket.uploadUrl, Buffer.from(html));
  expect(await confirmUploadAction(ticket.fileId)).toEqual({ ok: true });
  const queued = jobs.find((j) => j.name === "html-mockup-import")!;
  await runHtmlMockupImportJob(h.db as Database, fakeBrowser() as never, queued.data as never, { storage: r2, render: (async () => SHOT) as never });
}

const intakeHtml = async (id: string, section?: string) =>
  renderToStaticMarkup((await IntakePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(section ? { section } : {}) })) as React.ReactElement);
const mockupsHtml = async (id: string, query: Record<string, string> = {}) =>
  renderToStaticMarkup((await MockupsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) })) as React.ReactElement);

describe("the upload is where a Lane 1 project can reach it", () => {
  it("a Lane 1 project has a Homepage file item, optional until a file is read, and it opens the upload", async () => {
    const { id } = await makeProject("lane_1");
    const rail = await intakeHtml(id);
    // The Homepage-file nav item's own badge: the Business section is open by default and has "Optional" field labels of its own.
    expect(rail).toMatch(/<span>Homepage file<\/span><span[^>]*>Optional<\/span>/);
    const open = await intakeHtml(id, "homepage");
    expect(open).toContain("Finished homepage (HTML)");
    expect(open).toContain("Nothing here is required and nothing here blocks the project");
    expect(open).not.toContain("Upload the design (PDF");
  });

  it("the item says what state the file is in, from what is stored", async () => {
    const { admin, id } = await makeProject("lane_1");
    await uploadAndRead(id, admin);
    expect(await intakeHtml(id)).toContain("On the board");
    expect(await intakeHtml(id, "homepage")).toContain("Read: version 1 is on the Mockups board");
  });

  it("a Lane 2 project has no upload for it, and a Lane 2 project that already holds a file still shows it", async () => {
    const { admin, id } = await makeProject("lane_2");
    const plain = await intakeHtml(id, "figma");
    expect(plain).not.toContain("Homepage file");
    expect(plain).not.toContain("Finished homepage (HTML)");
    // ?section=homepage is ignored for Lane 2 rather than opening something it has no door for.
    expect(await intakeHtml(id, "homepage")).not.toContain("Finished homepage (HTML)");
    await uploadAndRead(id, admin);
    const held = await intakeHtml(id, "figma");
    expect(held).toContain("Finished homepage (HTML)");
    expect(held).toContain("Read: version 1 is on the Mockups board");
  });

  it("the Mockups set-up screen points at it", async () => {
    const { id } = await makeProject("lane_1", "mockups");
    expect(await mockupsHtml(id, { setup: "1" })).toContain(`/projects/${id}/intake?section=homepage`);
  });
});

describe("the whole Lane 1 path with a supplied homepage", () => {
  it("upload, read, the board, the client's decision, then Content", async () => {
    const { admin, id } = await makeProject("lane_1", "mockups");
    await uploadAndRead(id, admin);
    const view = await loadHomepageRead(h.db as Database, id);
    expect(view.state).toBe("done");
    const [row] = await h.db.select().from(concept).where(eq(concept.id, view.done!.conceptId));
    expect(row).toMatchObject({ skillId: HTML_HOMEPAGE_CONCEPT, label: "S", status: "ready" });

    // The Lane 1 board shows it, and says nothing false about it: TAWD did not check or score it.
    const board = await mockupsHtml(id);
    expect(board).toContain("Supplied page");
    expect(board).toContain("Not checked by TAWD");
    expect(board).toContain("do not judge it");
    expect(board).not.toContain("Each was checked");
    expect(board).not.toContain("scored at 4.5");
    expect(board).toContain("Record client decision");
    // The project's step is Design, waiting on the client's decision.
    const next = await loadNextStepFor(h.db as Database, admin.viewer, id);
    expect(next!.title).toBe("Get the client's decision on the concepts");

    // The decision, as for any concept: moves the project to Content, starts no AI round.
    const result = await recordClientDecision(h.ctx, admin.viewer, { conceptId: row!.id, channel: "email", changesRequested: false, clientSaid: "Love it", logoApproved: false });
    expect(result.movedToContent).toBe(true);
    const [after] = await h.db.select().from(project).where(eq(project.id, id));
    expect(after!.status).toBe("content");
    const journey = journeySteps(id, (await loadJourneyFacts(h.db as Database, id))!);
    expect(journey.find((s) => s.key === "design")!.state).toBe("done");
    expect(journey.find((s) => s.key === "content")!.state).toBe("current");
    expect((await h.db.select().from(intakeFile)).length).toBe(1);
  });

  it("a board with the supplied page and a generated concept still says the generated one was checked", async () => {
    const { admin, id } = await makeProject("lane_1", "mockups");
    await uploadAndRead(id, admin);
    const [supplied] = await h.db.select().from(concept).where(eq(concept.projectId, id));
    await h.db.insert(concept).values({ runId: supplied!.runId, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "ready" } as never);
    const board = await mockupsHtml(id);
    expect(board).toContain("2 concepts ready for team review");
    expect(board).toContain("Each was checked");
    expect(board).toContain("The supplied homepage file (S) is not judged");
  });
});

describe("which built file's own words back its facts", () => {
  async function approved(skillId: string, direction: string, withHomePlan = true) {
    const { admin, id } = await makeProject("lane_1", "content");
    if (withHomePlan) await h.db.insert(pagePlanPage).values({ projectId: id, position: 0, kind: "home", name: "Home", slug: "" });
    await h.db.insert(pagePlanPage).values({ projectId: id, position: 1, kind: "about", name: "About", slug: "about" });
    const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
    const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "S", direction, skillId, status: "ready" } as never).returning();
    await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "Yes", recordedByUserId: admin.viewer.id });
    return id;
  }

  it("is the home page's file when the client approved the supplied homepage", async () => {
    expect(await suppliedHomeFile(h.db as Database, await approved(HTML_HOMEPAGE_CONCEPT, HTML_HOMEPAGE_CONCEPT))).toBe("index.html");
  });

  it("is no file for a concept TAWD generated", async () => {
    expect(await suppliedHomeFile(h.db as Database, await approved("impeccable", "trust-first-local"))).toBeNull();
  });

  it("is no file when the plan has no Home page", async () => {
    expect(await suppliedHomeFile(h.db as Database, await approved(HTML_HOMEPAGE_CONCEPT, HTML_HOMEPAGE_CONCEPT, false))).toBeNull();
  });
});

/* Everything below runs the real door: upload, the worker's import, the client's approval; then reads what Content and go-live read. */
async function approvedSupplied(withPlan: "home-only" | "home-and-about", html = SUPPLIED) {
  const { admin, id } = await makeProject("lane_1", "mockups");
  await uploadAndRead(id, admin, html);
  const view = await loadHomepageRead(h.db as Database, id);
  await recordClientDecision(h.ctx, admin.viewer, { conceptId: view.done!.conceptId, channel: "email", changesRequested: false, clientSaid: "Love it", logoApproved: false });
  await h.db.insert(pagePlanPage).values({ projectId: id, position: 0, kind: "home", name: "Home", slug: "" });
  if (withPlan === "home-and-about") await h.db.insert(pagePlanPage).values({ projectId: id, position: 1, kind: "about", name: "About", slug: "about" });
  return { admin, id, conceptId: view.done!.conceptId };
}

describe("the words that back a supplied page come from what was supplied", () => {
  it("are the sections of the stored upload: not its header or footer, and not anything added to the stored pages afterwards", async () => {
    const { id, conceptId } = await approvedSupplied("home-and-about");
    const words = await suppliedHomeWords(h.db as Database, id, r2);
    expect(words).toContain("Plans from $499 a month.");
    expect(words).toContain("What we do");
    expect(words).not.toContain("Sample Marketing Co.");
    // Something later writes into the stored page and its source (an edit, a fix, a rebuild): the supplied words do not move, because they are read from original.html.
    const [version] = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
    const html = r2.objects.get(version!.htmlKey!)!.toString("utf8");
    for (const key of [version!.htmlKey!, version!.htmlKey!.replace(/page\.html$/, "source.html")]) r2.objects.set(key, Buffer.from(html.replace("What we do", "Rated 5 stars on Google. What we do")));
    expect(await suppliedHomeWords(h.db as Database, id, r2)).toBe(words);
    expect(await suppliedHomeWords(h.db as Database, id, r2)).not.toContain("Rated 5 stars");
  });

  it("are none for a project whose approved concept was not a supplied page, or whose upload is gone", async () => {
    const { id } = await approvedSupplied("home-and-about");
    const empty = new FakeR2();
    expect(await suppliedHomeWords(h.db as Database, id, empty)).toBeNull();
  });
});

describe("a plan whose only page is the supplied Home page", () => {
  it("has nothing to approve on Content, and the project can move to Build", async () => {
    const { admin, id } = await approvedSupplied("home-only");
    const overview = await loadDraftsOverview(h.db as Database, id);
    expect(overview.rows).toHaveLength(0);
    expect(overview.nothingToApprove).toBe(true);
    // No copy pack and no copy decision exist for it, and they say why instead of silently doing nothing.
    await expect(buildCopyPack(h.db as Database, id)).rejects.toThrow(/no copy pack/);
    await expect(recordCopyDecision(h.ctx, admin.viewer, id, { outcome: "approved", channel: "email", clientSaid: "Yes" })).rejects.toThrow(/no copy for the client to decide/);
    expect((await loadNextStepFor(h.db as Database, admin.viewer, id))!.title).toBe("Move to Build & preview");
    await moveToBuild(h.ctx, admin.viewer, id);
    const [after] = await h.db.select().from(project).where(eq(project.id, id));
    expect(after!.status).toBe("build");
    const readiness = await siteReadiness(h.db as Database, id);
    expect(readiness).toMatchObject({ ready: true, clientApprovedCopy: true });
  });

  it("is unchanged for a plan with other pages: they still need approval and a recorded decision", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    const overview = await loadDraftsOverview(h.db as Database, id);
    expect(overview.nothingToApprove).toBe(false);
    expect(overview.allApproved).toBe(false);
    await expect(moveToBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/hasn't approved the copy/);
  });
});

/*
  Prepare the content, with a supplied homepage (17 November 2026). The step
  exists to run the paid parts in order and ends with the Home page's draft.
  A supplied homepage keeps its own words, so that draft must never be asked
  for: the engine refuses it (content-drafts.ts), and before this the step
  asked for it anyway and dead-ended on "Choose at least one page to draft."
*/
describe("Prepare the content, when the home page is the supplied design", () => {
  const contentHtml = async (id: string) =>
    renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);

  it("is gone once the keywords and the plan are done, and never offers the Home page's draft", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    await h.db.insert(keywordResearch).values({ projectId: id, status: "done", sandbox: false, keywordCount: 2 });

    expect(await loadPrepareView(h.db as Database, admin.viewer, id)).toBeNull();
    const html = await contentHtml(id);
    expect(html).not.toContain("Prepare the content: Home page first");
    expect(html).not.toContain("The Home page's draft");
    // The dead end itself: the action a person could still reach says what is true, not "Choose at least one page to draft."
    await expect(prepareContent(h.ctx, admin.viewer, id, { keywords: false })).rejects.toThrow(/keeps the supplied design's own words/);
  });

  /* Keyword research has to be available for this step to have anything to consent to. */
  async function withResearchAvailable(id: string, admin: Awaited<ReturnType<typeof seedAdmin>>) {
    vi.stubEnv("DATAFORSEO_LOGIN", "sandbox-login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "sandbox-password");
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sample Marketing Co.", phone: "(530) 227-2479", city: "Reno", state: "NV" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Digital marketing", description: "" }], mainServiceId: "s1" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Reno, NV"], counties: [] });
  }

  it("offers the research and the plan, and never a Home page draft to pay for", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    await withResearchAvailable(id, admin);
    const view = await loadPrepareView(h.db as Database, admin.viewer, id);
    expect(view).not.toBeNull();
    expect(view!.homeLine).toBeNull();
    expect(view!.usable).not.toContain("The Home page comes back");
    expect(view!.total).not.toContain("Home page");
    const html = await contentHtml(id);
    expect(html).not.toContain("The Home page's draft");
    expect(html).toContain("the other pages are drafted together from the next step");
  });

  it("makes the plan and queues no draft for the home page", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    await withResearchAvailable(id, admin);
    // No plan yet: the step's own job is to make it.
    await h.db.delete(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    expect(await prepareContent(h.ctx, admin.viewer, id, { keywords: false })).toBe("planned");
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((p) => p.kind === "home")).toBe(true);
    expect(jobs.filter((j) => j.name === "content-draft")).toHaveLength(0);
  });

  /*
    No button that does nothing: with the plan made, the home page supplied
    and the research left out, pressing Start would make no plan, draft
    nothing and leave the card where it was.
  */
  it("says so rather than doing nothing, when there is nothing left for it to run", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    await withResearchAvailable(id, admin);
    await expect(prepareContent(h.ctx, admin.viewer, id, { keywords: false })).rejects.toThrow(/nothing left to prepare/);
    expect(jobs.filter((j) => j.name === "content-draft")).toHaveLength(0);
  });
});

/*
  The page plan a supplied homepage's own menu makes (Jason, option A, 17
  November 2026). Before this the plan came from the intake and the keywords
  and never looked at the design the client approved, so the built site's
  menu — which is written from the plan — named pages the design does not
  have and missed every page it does.
*/
describe("the page plan follows the approved design's menu", () => {
  it("is the Home page, then one page per menu item, in the design's own order", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    expect(await suppliedHomeNav(h.db as Database, id, r2)).toEqual([
      { label: "Services", href: "#services" },
      { label: "Our Approach", href: "#approach" },
      { label: "About Sarah", href: "#sarah" },
      { label: "Insights", href: "#" },
      { label: "Contact", href: "#contact" },
    ]);

    await makePagePlan(h.ctx, admin.viewer, id);
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    expect(pages.map((p) => p.name)).toEqual(["Home", "Services", "Our Approach", "About Sarah", "Insights", "Contact"]);
    expect(pages.map((p) => p.slug)).toEqual(["", "services", "our-approach", "about-sarah", "insights", "contact"]);
    expect(pages.map((p) => p.kind)).toEqual(["home", "hub", "other", "about", "blog", "contact"]);
  });

  /* A guard, not evidence of the fix: this passes on main too, and is here so a later change cannot quietly make a menu out of nothing. */
  it("is left to the intake and the keywords when the design has no menu", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    expect(await suppliedHomeNav(h.db as Database, id, r2)).toEqual([]);
    await makePagePlan(h.ctx, admin.viewer, id);
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    expect(pages[0]!.kind).toBe("home");
    expect(pages.map((p) => p.name)).not.toContain("Our Approach");
  });
});

/*
  A plan that does not have the design's menu items (CodeRabbit on #107).
  The plan is never remade by itself, because remaking it replaces every
  page and takes their drafts with them, so the screen says what the design
  asks for that the plan has not got, and the team decides.

  The warning names the missing items and nothing else. It is also what the
  team sees after renaming a page by hand, so it must not tell them why the
  pages are missing: the helper compares names, and it has not read when the
  plan was made or when the design was approved (CodeRabbit's third pass on
  #107, and the no-invented-facts house rule, which holds for TAWD's own
  sentences too).
*/
/*
  What the Home stage costs when the home page is the one the team supplied
  (Jason, 17 November 2026). Build A keeps that page exactly as uploaded and
  never sends it to the AI, so the only AI in the stage is the shared header
  and footer. The start path had always left it out of the price; the
  estimate on the screen had not, and read "About $0.79 of AI on Opus 5.5
  for 1 page and the shared header and footer". Spoon-feeding TAWD the
  design and then being quoted for building it is the bug.
*/
describe("the Home stage for a supplied home page", () => {
  it("prices no page, says so, and does not name a page it will not build", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await makePagePlan(h.ctx, admin.viewer, id);
    const view = (await loadStages(h.db as Database, id))!;
    expect(view.next!.stage.label).toBe("Home");
    expect(view.next!.stage.makesParts).toBe(true);
    // No page is sent to the AI in this stage at all.
    expect(view.next!.estimate.aiPages).toBe(0);
    // The sentence the team reads must not quote a page build, nor "0 pages".
    expect(view.next!.estimate.label).not.toMatch(/for 1 page|for 0 pages/);
    expect(view.next!.estimate.label).toContain("for the shared header and footer");
    expect(view.next!.estimate.label).toContain("The home page is the design the team supplied: its words are kept as they were uploaded, never sent to the AI");
    // And the confirmation before spending reads from the same count, and knows it is the home page that was supplied.
    const card = stagesCardProps(view).next!;
    expect(card.aiPages).toBe(0);
    expect(card.keptHome).toBe(true);
    expect(stageConfirmText(card)).toContain("the home page is the design the team supplied");
  });

  /*
    The model named must be the one that is actually charged. With no page
    in the stage, every penny is the shared-parts step, which is set on
    Spend separately from the page step (CodeRabbit on #108). Before this,
    the sentence named the page step's model, so a team that moved the
    header and footer onto a cheaper model would still read "Opus 5.5".
  */
  it("names the model the shared header and footer actually run on", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await makePagePlan(h.ctx, admin.viewer, id);
    await h.db.insert(appSetting).values({ key: STEP_MODELS_SETTING, value: { site_parts: "claude-sonnet-5" } });
    const view = (await loadStages(h.db as Database, id))!;
    expect(view.next!.estimate.label).toContain("Sonnet 5");
    expect(view.next!.estimate.label).not.toContain("Opus");
  });

  /*
    A stage with no AI page is not always a supplied home page: blog
    articles kept from the current site after the first are filled into
    that first one's layout by code, and that stage has no AI page either
    (CodeRabbit on #108). Saying the home page was uploaded there would be
    a fact TAWD invented, which the house rules forbid of TAWD's own words
    as much as of a client site's.
  */
  it("does not claim a supplied home page when the stage is free for another reason", () => {
    const words = stageConfirmText({ aiPages: 0, makesParts: false, keptHome: false });
    expect(words).not.toContain("supplied");
    expect(words).not.toContain("uploaded");
    expect(words).toContain("No AI pass for a page");
    expect(words).toContain("filled into a layout already built, by code");
  });

  it("still prices the pages the AI does write", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await makePagePlan(h.ctx, admin.viewer, id);
    const view = (await loadStages(h.db as Database, id))!;
    // Every page after Home is written by the AI: the kept page is the home page alone.
    expect(view.remaining).toBeNull(); // Home is not built yet, so rule 8 keeps the rest locked.
    expect(view.next!.estimate.cost).toBeGreaterThan(0); // the header and footer are still a real call
  });
});

describe("a page plan that does not have the design's menu items", () => {
  it("says which of the design's menu items it has no page for, and claims nothing it has not checked", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    const view = await loadSeoView(h.db as Database, admin.viewer, id);
    // The two things it must never say, checked before the wording, so neither guard can be skipped by an earlier failure.
    // Never a claim about history: nothing here read a date.
    expect(view.designMenuWarning).not.toMatch(/before the design was approved|was made before/i);
    // Never "Make it again": that button is not drawn for a viewer who cannot edit the plan.
    expect(view.designMenuWarning).not.toMatch(/Make it again/i);
    expect(view.designMenuWarning).toContain("Services, Our Approach, About Sarah, Insights, Contact");
    expect(view.designMenuWarning).toContain("Making the plan again follows the design's menu");
  });

  /*
    With no plan yet, the bar never points at Prepare the content for these
    projects: that step ends with a draft this home page never needs, and
    the card is not on the screen at all once the research is done or
    cannot be run.
  */
  it("sends the team to the page plan, not to a step that may not be on the screen", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await h.db.delete(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    const next = await loadNextStepFor(h.db as Database, admin.viewer, id);
    expect(next!.title).toBe("Make the page plan");
    expect(next!.action!.href).toContain("#plan");
    expect(next!.line).toContain("the menu of the design the client approved");
  });

  /*
    The bar is the other half of it. The sentence on the Page plan card was
    not enough: on live TAWD the step collapses the moment the plan is made,
    so the warning was in the page and invisible, while the bar underneath
    said "Draft 4 pages" and that drafting is paid. The team would have been
    sent to buy drafts of the pages the approved design does not have (the
    browser walk of #107).
  */
  it("stops the bar offering paid drafts of the pages the design does not have", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    const next = await loadNextStepFor(h.db as Database, admin.viewer, id);
    expect(next!.title).toBe("The page plan doesn't follow the approved design");
    expect(next!.line).toContain("Services, Our Approach, About Sarah, Insights, Contact");
    // Never the drafting step while the plan is the wrong one: that is the spend this prevents.
    expect(next!.title).not.toMatch(/^Draft /);
    expect(next!.action!.href).toContain("#plan");
    expect(next!.action!.label).not.toMatch(/Draft/i);
  });

  it("lets the bar move on once the plan follows the menu", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await makePagePlan(h.ctx, admin.viewer, id);
    const next = await loadNextStepFor(h.db as Database, admin.viewer, id);
    expect(next!.title).not.toBe("The page plan doesn't follow the approved design");
  });

  it("says nothing once the plan follows the menu", async () => {
    const { admin, id } = await approvedSupplied("home-and-about", SUPPLIED_WITH_NAV);
    await makePagePlan(h.ctx, admin.viewer, id);
    expect((await loadSeoView(h.db as Database, admin.viewer, id)).designMenuWarning).toBeNull();
  });

  it("says nothing for a project whose design has no menu", async () => {
    const { admin, id } = await approvedSupplied("home-and-about");
    expect((await loadSeoView(h.db as Database, admin.viewer, id)).designMenuWarning).toBeNull();
  });
});
