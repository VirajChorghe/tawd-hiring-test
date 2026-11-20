import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Design + content's "improve the words" (0.100.0, B2) and Content as one
  step (Part C): the instructions and the free checks, Home first, putting a
  page back, the accordion's steps by project type, and Prepare the
  content's one consent. Claude is a stand-in: no AI money.
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
import { activityLog, aiCall, pageDraft, pagePlanPage } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { type ContentDraftJobData } from "@tawd/core/queue";
import { buildImproveSystemPrompt, buildImproveUserPrompt, changedShare, factTokens, improveFactsCheck, wordDiff } from "@tawd/core/content";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import { approvePage, requestRedraft, startDrafts } from "@/lib/content-drafts";
import { improveCompare, loadImproveView, revertToKept, startImprove } from "@/lib/content-improve";
import { loadPrepareView, prepareContent, prepareStopped } from "@/lib/content-prep";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { contentSteps, openStep, type ContentStepsInput } from "@/lib/content-steps";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { runContentDraftJob } from "../../../worker/src/content-draft";
import type { WorkerConfig } from "../../../worker/src/config";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude, turn } from "./worker-fakes";

const KEPT_HOME = `# Sacramento's 24/7 plumbers

Preferred Plumbing has fixed leaks in Sacramento since 1998. Call (916) 555-0142 for a visit.

## Services

- [Drain cleaning](/drain-cleaning/)
- Water heaters from $1,200

> They came the same day and fixed it. Mary, Folsom

## Call us

Call (916) 555-0142.
`;

describe("the improve step's rules (core, free)", () => {
  it("keeps facts, quotes, links and tables, and puts the intake first", () => {
    const system = buildImproveSystemPrompt("profile");
    expect(system).toContain("Never change a number");
    expect(system).toContain("A quote from a customer on the current page stays word for word");
    expect(system).toContain("use the intake's");
    expect(system).toContain("Keep every link as written, [text](/path/)");
    const user = buildImproveUserPrompt({
      clientName: "Preferred Plumbing",
      tradeLabel: "plumbing",
      page: { name: "Home", kind: "home", mainKeyword: "plumber sacramento", supportingKeywords: [], h1: "", title: "" },
      facts: { known: "- name", required: "- (none)" },
      tone: "",
      current: KEPT_HOME,
      suggestions: ["Titles without a city: \"Home\""],
      wireframe: ["Hero", "Services"],
      note: null,
      previous: null,
      healthRules: false,
    });
    expect(user).toContain("<current_page>");
    expect(user).toContain("Titles without a city");
    expect(user).toContain("Hero > Services");
  });

  it("finds new and missing numbers, phones, prices and years by code", () => {
    expect(factTokens(KEPT_HOME)).toEqual(expect.arrayContaining(["(916) 555-0142", "$1200", "24/7", "1998"]));
    const improved = KEPT_HOME.replace("since 1998", "for 25 years").replace("from $1,200", "from $999");
    const check = improveFactsCheck(KEPT_HOME, improved, "Phone: (916) 555-0142");
    expect(check.added).toEqual(expect.arrayContaining(["25", "$999"]));
    expect(check.removed).toEqual(expect.arrayContaining(["1998", "$1200"]));
    // A fact from the intake isn't new.
    expect(improveFactsCheck("Call us.", "Call (916) 555-0142.", "(916) 555-0142").added).toEqual([]);
  });

  it("compares word by word and says how much is new", () => {
    const parts = wordDiff("We fix leaks fast.", "We fix every leak fast.");
    expect(parts.map((p) => p.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(parts.filter((p) => p.kind === "added").map((p) => p.text.trim()).join(" ")).toBe("every leak");
    expect(changedShare(parts)).toBe(40);
  });
});

describe("Content's steps, by project type", () => {
  const base: ContentStepsInput = { type: "everything_new", hasSite: false, read: "none", quick: "none", research: "none", planPages: 0, words: { total: 0, approved: 0, ready: 0, working: 0, failed: 0, notStarted: 0 }, clientDecision: null, suggestions: 0, audit: "none" };

  it("Everything new without a site: the site's steps aren't needed, keywords are next", () => {
    const steps = contentSteps(base);
    expect(steps.filter((s) => s.need === "no").map((s) => s.key)).toEqual(["read", "quick", "suggestions", "audit"]);
    expect(steps.find((s) => s.key === "read")!.why).toBe("No current website: nothing to read.");
    expect(openStep(steps)).toBe("keywords");
    const planned = contentSteps({ ...base, research: "done", planPages: 8, words: { ...base.words, total: 8, ready: 1, notStarted: 7 } });
    expect(openStep(planned)).toBe("words");
  });

  /*
    A plan that is made but does not follow the approved design (the browser
    walk of #107, on live TAWD). "Done" ticks the step, which collapses it
    and hides the only sentence that says the plan is the wrong one, and the
    step after a tick is paid drafting. It needs a look, and the reason has
    to be on the step's own line so it shows with the step closed.
  */
  it("a plan that does not follow the approved design needs a look, and says so on its own line", () => {
    const warning = "The design the client approved has 5 menu items this plan has no page for: Services, Our Approach, About Sarah, Testimonials, Insights.";
    const steps = contentSteps({ ...base, research: "done", planPages: 5, planMismatch: warning, words: { ...base.words, total: 4, notStarted: 4 } });
    const plan = steps.find((s) => s.key === "plan")!;
    expect(plan.state).toBe("problem");
    // On the step's line, where a closed step still shows it: never only inside the body.
    expect(plan.warn).toBe(warning);
    // And it is the step that opens, instead of the paid drafting step.
    expect(openStep(steps)).toBe("plan");
  });

  it("a plan that does follow the design is done, with nothing on its line", () => {
    const steps = contentSteps({ ...base, research: "done", planPages: 5, planMismatch: null, words: { ...base.words, total: 4, notStarted: 4 } });
    const plan = steps.find((s) => s.key === "plan")!;
    expect(plan.state).toBe("done");
    expect(plan.warn).toBeNull();
    expect(openStep(steps)).toBe("words");
  });

  it("keyword research that can't run is optional, says why, and the plan opens instead", () => {
    const steps = contentSteps({ ...base, researchBlocked: "DataForSEO isn't set up yet: an admin adds DATAFORSEO_LOGIN in Coolify." });
    const keywords = steps.find((s) => s.key === "keywords")!;
    expect(keywords.need).toBe("optional");
    expect(keywords.why).toBe("Can't run now: DataForSEO isn't set up yet: an admin adds DATAFORSEO_LOGIN in Coolify. The page plan can be made without it, from the intake's words.");
    expect(openStep(steps)).toBe("plan");
  });

  it("Design only: no keywords, no words to write, no client approval, each saying why", () => {
    const steps = contentSteps({ ...base, type: "design_only", hasSite: true, read: "done", planPages: 12 });
    const why = Object.fromEntries(steps.map((s) => [s.key, s.need === "no" ? s.why : null]));
    expect(why.keywords).toContain("Design only keeps the current site's words");
    // The kept pages stay readable (and a page the read couldn't give can get its words), with nothing to approve.
    const words = steps.find((s) => s.key === "words")!;
    expect(words.need).toBe("optional");
    expect(words.why).toContain("the build checks them word for word");
    expect(why.client).toBe("The words are the client's own.");
    expect(steps.find((s) => s.key === "words")!.title).toBe("The kept pages");
  });

  it("Design + content: keywords optional, the words are improved and approved", () => {
    const steps = contentSteps({ ...base, type: "design_content", hasSite: true, read: "done", planPages: 12, words: { ...base.words, total: 12, ready: 12 } });
    expect(steps.find((s) => s.key === "keywords")!.need).toBe("optional");
    expect(steps.find((s) => s.key === "words")!.title).toBe("Improve and approve each page");
    expect(openStep(steps)).toBe("words");
    // A read that failed shows on the plan too.
    expect(contentSteps({ ...base, type: "design_content", hasSite: true, read: "failed" }).find((s) => s.key === "plan")!.state).toBe("problem");
  });
});

let h: Harness;
let queued: { name: string; data: ContentDraftJobData }[];
const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

async function runQueued(write: (userText: string) => string) {
  const claude = fakeClaude(() => [], {
    builder: (params) => {
      const messages = params.messages as { content: string | { text?: string }[] }[];
      const first = messages[0]!.content;
      return turn(write(typeof first === "string" ? first : first.map((b) => b.text ?? "").join("")), "end_turn");
    },
  });
  for (const job of queued.splice(0)) await runContentDraftJob(job.data, config, claude.client as never);
}

describe("on the database", () => {
  beforeEach(async () => {
    h = await createHarness();
    setDbForTesting(h.db as Database);
    setStorageForTesting(new FakeR2());
    queued = [];
    setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as ContentDraftJobData }), getJob: async () => null });
  });
  afterEach(async () => {
    state.user = null;
    setQueueForTesting(null);
    setStorageForTesting(null);
    setDbForTesting(null);
    await h.close();
  });

  async function designAndContent() {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Preferred Plumbing", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "content", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Preferred Plumbing", phone: "(916) 555-0142", city: "Sacramento", state: "CA" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://preferred.example" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "improve" });
    const pages = await h.db
      .insert(pagePlanPage)
      .values([
        { projectId: id, position: 0, kind: "home", name: "Home", slug: "", title: "Home", metaDescription: "Plumbers." },
        { projectId: id, position: 1, kind: "service", name: "Drain cleaning", slug: "drain-cleaning", title: "Drains", metaDescription: "Drains." },
        { projectId: id, position: 2, kind: "article", name: "Winter pipes", slug: "blog/winter-pipes", title: "Winter pipes", metaDescription: "Pipes." },
      ])
      .returning();
    const long = `# Drain cleaning\n\n${"We clear kitchen and bathroom drains in Sacramento homes. ".repeat(12)}\n`;
    for (const [i, p] of pages.entries()) await h.db.insert(pageDraft).values({ projectId: id, pageId: p.id, version: 1, source: "kept", status: "done", body: i === 0 ? KEPT_HOME : i === 1 ? long : "# Winter pipes\n\nShort.\n" });
    return { admin, id, home: pages[0]!, drains: pages[1]!, article: pages[2]! };
  }

  it("improves the Home page first, checks its facts, and unlocks the rest once it's approved or put back", async () => {
    const { admin, id, home, drains, article } = await designAndContent();
    const view = (await loadImproveView(h.db as never, id))!;
    expect(view.rows.map((r) => [r.name, r.suggested])).toEqual([["Home", true], ["Drain cleaning", true], ["Winter pipes", false]]);
    expect(view.rows.find((r) => r.pageId === article.id)!.why).toBe("Blog articles stay as they are unless you tick them.");
    expect(view.restUnlocked).toBe(false);
    expect(view.rows.every((r) => r.cost > 0)).toBe(true);
    await expect(startImprove(h.ctx, admin.viewer, id, { pageIds: [drains.id] })).rejects.toThrow(/Improve the Home page first/);

    expect(await startImprove(h.ctx, admin.viewer, id, { pageIds: [home.id] })).toBe(1);
    // The improved words add a claim ("24 hours") and drop the year.
    await runQueued((text) => {
      expect(text).toContain("<current_page>");
      return KEPT_HOME.replace("Preferred Plumbing has fixed leaks in Sacramento since 1998.", "Preferred Plumbing fixes leaks across Sacramento, with a plumber on call 24 hours a day.");
    });
    const versions = await h.db.select().from(pageDraft).where(eq(pageDraft.pageId, home.id)).orderBy(pageDraft.version);
    expect(versions.map((v) => [v.version, v.source, v.status])).toEqual([[1, "kept", "done"], [2, "improved", "done"]]);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.projectId, id))).map((c) => c.step)).toEqual(["content_improve"]);
    const compare = (await improveCompare(h.db as never, id, [...versions].reverse(), versions[1]!))!;
    expect(compare.factsLine).toBe("New in this version (not on the current page or in the intake): 24. On the current page but not in this version: 1998.");
    expect(compare.changed).toBeGreaterThan(0);

    await approvePage(h.ctx, admin.viewer, id, home.id);
    expect((await loadImproveView(h.db as never, id))!.restUnlocked).toBe(true);
    // A request for changes improves again from the current words, with the note: never a redraft from the intake.
    await requestRedraft(h.ctx, admin.viewer, id, home.id, "Keep the year we started.");
    expect(queued).toHaveLength(1);
    await runQueued((text) => {
      expect(text).toContain("Keep the year we started.");
      expect(text).toContain("<last_improved_version>");
      return KEPT_HOME;
    });
    const [third] = await h.db.select().from(pageDraft).where(eq(pageDraft.pageId, home.id)).orderBy(pageDraft.version).offset(2);
    expect(third).toMatchObject({ version: 3, source: "improved", note: "Keep the year we started." });

    // Put back: a kept version again, free, logged; the kept words rule applies again.
    expect(await revertToKept(h.ctx, admin.viewer, id, home.id)).toBe(4);
    const [fourth] = await h.db.select().from(pageDraft).where(eq(pageDraft.pageId, home.id)).orderBy(pageDraft.version).offset(3);
    expect(fourth).toMatchObject({ source: "kept", body: KEPT_HOME });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "content.page_reverted_to_kept")))).toHaveLength(1);
    // A failed improvement can be kept as the current words too.
    await startImprove(h.ctx, admin.viewer, id, { pageIds: [drains.id] });
    queued.splice(0);
    await h.db.update(pageDraft).set({ status: "failed", failureReason: "The writer declined." }).where(eq(pageDraft.pageId, drains.id));
    await h.db.update(pageDraft).set({ status: "done" }).where(eq(pageDraft.version, 1));
    expect((await loadImproveView(h.db as never, id))!.rows.find((r) => r.pageId === drains.id)!.state).toBe("failed");
    await revertToKept(h.ctx, admin.viewer, id, drains.id);
    expect((await loadImproveView(h.db as never, id))!.rows.find((r) => r.pageId === drains.id)!.state).toBe("kept_back");
    // Pages with the current site's words are never drafted from the intake.
    await expect(startDrafts(h.ctx, admin.viewer, id)).rejects.toThrow(/Every page already has a draft/);
  });

  it("Content shows one list of steps with the Improve card; Design only greys the steps it doesn't need", async () => {
    const { admin, id } = await designAndContent();
    const render = async () => renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);
    let html = await render();
    expect(html).toContain("Improve and approve each page");
    expect(html).toContain("Improve the Home page first");
    // No DataForSEO keys in the tests: keyword research is optional and says why it can't run.
    expect(html).toContain("Can&#x27;t run now: DataForSEO isn&#x27;t set up yet");
    expect(html).not.toContain("Prepare the content: Home page first");
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "keep" });
    html = await render();
    expect(html).toContain("Not needed for this project");
    expect(html).toContain("Design only keeps the current site&#x27;s words and addresses");
    expect(html).not.toContain("Improve the Home page first");
  });

  it("Fable's review: Put back and Compare use the newest kept words; a stopped Prepare says why; Lane 2 gets no Prepare", async () => {
    const { admin, id, home } = await designAndContent();
    // A re-read refreshed the kept words (version 2), then the page was improved (version 3).
    await h.db.insert(pageDraft).values({ projectId: id, pageId: home.id, version: 2, source: "kept", status: "done", body: KEPT_HOME.replace("since 1998", "since 1999") });
    await h.db.insert(pageDraft).values({ projectId: id, pageId: home.id, version: 3, source: "improved", status: "done", body: KEPT_HOME.replace("since 1998", "since 1999").replace("Call us", "Call today") });
    const versions = await h.db.select().from(pageDraft).where(eq(pageDraft.pageId, home.id)).orderBy(pageDraft.version);
    const compare = (await improveCompare(h.db as never, id, versions, versions[2]!))!;
    expect(compare.parts.filter((p) => p.kind === "removed").map((p) => p.text).join("")).not.toContain("1998");
    await revertToKept(h.ctx, admin.viewer, id, home.id);
    const [back] = await h.db.select().from(pageDraft).where(eq(pageDraft.pageId, home.id)).orderBy(pageDraft.version).offset(3);
    expect(back!.body).toContain("since 1999");

    // Prepare the content stopped after the research: the reason shows until a page is drafted.
    expect(await prepareStopped(h.db as never, id)).toBeNull();
    await recordActivity(h.db, { action: "content.prepare_stopped", entityType: "project", entityId: id, ...actorFields(SYSTEM_ACTOR), valueAfter: { reason: "The monthly AI limit is reached." }, ipAddress: null, userAgent: null } as never);
    expect(await prepareStopped(h.db as never, id)).toBe("Prepare the content stopped after the keyword research: The monthly AI limit is reached. Draft the Home page from this step, or make the plan first.");

    const lane2 = await createProject(h.ctx, admin.viewer, { clientName: "a client's design", trade: "plumbing", tier: "starter", lane: "lane_2", laneOption: "a", conceptCount: 1, status: "content", memberUserIds: [] });
    expect(await loadPrepareView(h.db as never, admin.viewer, lane2)).toBeNull();
  });

  it("Prepare the content: one consent runs the plan and the Home page's draft (keywords left out here), logged", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Sac Plumbing Experts", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "content", memberUserIds: [] });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sac Plumbing Experts", phone: "(916) 555-0100", city: "Sacramento", state: "CA" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "website", { noCurrentWebsite: true });
    const view = (await loadPrepareView(h.db as never, admin.viewer, id))!;
    expect(view.planLine).toBe("Page plan: made by code from the tier, the intake and the keywords (free).");
    expect(view.homeLine).toMatch(/^The Home page's draft: About \$/);
    expect(view.cheaper).toContain("leave keyword research out");
    const html = renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);
    expect(html).toContain("Prepare the content: Home page first");
    expect(html).toContain("No current website: nothing to read.");

    expect(await prepareContent(h.ctx, admin.viewer, id, { keywords: false })).toBe("drafting");
    const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    expect(pages.length).toBeGreaterThan(1);
    expect(queued).toHaveLength(1);
    const [draft] = await h.db.select().from(pageDraft).where(eq(pageDraft.projectId, id));
    expect(pages.find((p) => p.id === draft!.pageId)!.kind).toBe("home");
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "content.prepare_started"))).toHaveLength(1);
    // Once the Home page has words, the card is gone.
    expect(await loadPrepareView(h.db as never, admin.viewer, id)).toBeNull();
    await expect(prepareContent(h.ctx, admin.viewer, id, { keywords: false })).rejects.toThrow(/already has words/);
  });
});
