import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Staged site builds (Jason, 6 October 2026): Lane 1 sites built Home
  first (with the header and footer), then each main page, then each
  group's first page alone and the rest as one bundle. Claude is a
  stand-in (no AI money); Astro really builds the files.
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
import { aiCall, clientDecision, concept, conceptVersion, mockupRun, pageDraft, pagePlanPage, siteBuild } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { type SiteBuildJobData } from "@tawd/core/queue";
import { builtCountLine, comingSoonMain, planStages, stagePageTokens, stageStates, type StageBuildOptions } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { goLiveChecklist } from "@/lib/golive";
import { estimateStage, loadStages, stagesCardProps, startStageBuild, type BuiltPage } from "@/lib/site-builds";
import { currentBuildPart } from "@/lib/build-parts";

import { runSiteBuildJob } from "../../../worker/src/site-build";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2, fakeBrowser, fakeClaude, turn } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: SiteBuildJobData }[];

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
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteBuildJobData }), getJob: async () => null });
});

afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* ---------- the stages, by code ---------- */

/* A Harbor-like plan: home, 5 main pages, 12 services, 9 areas, 22 articles. */
function harborPlan() {
  const services = ["Ant control", "Bed bugs", "Cockroaches", "Fleas", "Mice", "Rats", "Scorpions", "Spiders", "Termites", "Wasps", "Mosquitoes", "Crickets"];
  const cities = ["Mesa", "Gilbert", "Chandler", "Tempe", "Scottsdale", "Phoenix", "Queen Creek", "Apache Junction", "Gold Canyon"];
  return [
    { name: "Home", kind: "home", slug: "" },
    { name: "About", kind: "about", slug: "about" },
    // Groups may sit anywhere in the plan; their stages come after the main pages.
    ...services.map((n) => ({ name: n, kind: "service", slug: n.toLowerCase().replace(/ /g, "-") })),
    { name: "Pricing", kind: "pricing", slug: "pricing" },
    ...cities.map((n) => ({ name: n, kind: "city", slug: n.toLowerCase().replace(/ /g, "-") })),
    { name: "Blog", kind: "blog", slug: "blog" },
    ...Array.from({ length: 22 }, (_, i) => ({ name: `Article ${i + 1}`, kind: "article", slug: `blog/article-${i + 1}` })),
    { name: "Service areas", kind: "service_areas", slug: "service-areas" },
    { name: "Contact", kind: "contact", slug: "contact" },
  ];
}

describe("the stages", () => {
  it("orders a Harbor-like plan: Home, each main page alone, then each group's first page alone and the rest together", () => {
    const stages = planStages(harborPlan());
    expect(stages.map((s) => s.label)).toEqual([
      "Home",
      "About",
      "Pricing",
      "Blog",
      "Service areas",
      "Contact",
      "The first service page: Ant control",
      "The other 11 service pages",
      "The first service-area page: Mesa",
      "The other 8 service-area pages",
      "The first article: Article 1",
      "The other 21 articles",
    ]);
    expect(stages.map((s) => s.button).slice(0, 2)).toEqual(["Build Home first", "Build About"]);
    expect(stages[6]!.button).toBe("Build the first service page (Ant control)");
    expect(stages[7]!.button).toBe("Build the other 11 service pages");
    // Only Home makes the header and footer.
    expect(stages.filter((s) => s.makesParts).map((s) => s.key)).toEqual(["home"]);
    expect(stages.reduce((n, s) => n + s.slugs.length, 0)).toBe(49);
    expect(stages[0]!.slugs).toEqual(["home"]);
    expect(stages[11]!.slugs[0]).toBe("blog/article-2");
  });

  it("says which stage is built, next or waiting, and counts the pages", () => {
    const stages = planStages(harborPlan());
    const none = stageStates(stages, new Map());
    expect(none.map((s) => s.status).slice(0, 3)).toEqual(["next", "waiting", "waiting"]);
    const some = stageStates(stages, new Map([["home", 1], ["about", 2]]));
    expect(some.slice(0, 3).map((s) => [s.status, s.builtIn])).toEqual([["built", 1], ["built", 2], ["next", null]]);
    expect(builtCountLine(some).line).toBe("2 of 49 pages built");
    // A bundle half built (a page added to the plan later) is next, with only its missing pages to build.
    const all = new Map(stages.flatMap((s) => s.slugs).map((k) => [k, 3] as const));
    all.delete("crickets");
    const nearly = stageStates(stages, all);
    expect(nearly.find((s) => s.status === "next")).toMatchObject({ key: "service:rest", toBuild: ["crickets"] });
  });

  it("writes a clearly marked Coming soon page, and the estimate grows with the copy", () => {
    const main = comingSoonMain("Ant <control>");
    expect(main).toContain("Not built yet");
    expect(main).toContain("<h1>Ant &lt;control&gt;: coming soon</h1>");
    expect(main.match(/<h1/g)).toHaveLength(1);
    const short = stagePageTokens(400, []);
    const long = stagePageTokens(20_000, []);
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
    expect(long.outputTokens).toBeGreaterThan(short.outputTokens * 3);
    // Learned from past page calls: the output-to-input ratio and the cached system prompt.
    const learned = stagePageTokens(4_000, [{ inputTokens: 2_000, outputTokens: 6_000, cacheReadTokens: 18_000 }]);
    expect(learned).toEqual({ inputTokens: 2_500, outputTokens: 7_500, cacheReadTokens: 18_000 });
  });
});

/* ---------- the stages, built ---------- */

const MOCKUP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mockup</title>
<style>body{margin:0}.band{padding:48px}</style></head>
<body><header class="band"><nav><a href="#services">Services</a></nav><a href="tel:">Call</a></header>
<section class="band"><h1>Pests gone</h1><p>Mockup words.</p></section>
<footer class="band"><p>Harbor Pest</p></footer></body></html>`;

const PARTS = `<header class="band"><a class="skip" href="#main">Skip to content</a><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/ant-control/">Ant control</a> <a href="/contact/">Contact</a></nav></header>
<footer class="band"><p>Harbor Pest</p><p>Website by Velocity Media Lab</p></footer>`;

const mainFor = (name: string) => `<main><section class="band"><h1>${name}</h1><p>Built page.</p></section></main>`;

const PLAN = [
  { name: "Home", kind: "home", slug: "" },
  { name: "About", kind: "about", slug: "about" },
  { name: "Contact", kind: "contact", slug: "contact" },
  { name: "Ant control", kind: "service", slug: "ant-control" },
  { name: "Bed bugs", kind: "service", slug: "bed-bugs" },
  { name: "Termites", kind: "service", slug: "termites" },
  { name: "Mesa", kind: "city", slug: "mesa" },
  { name: "Gilbert", kind: "city", slug: "gilbert" },
];

async function stagedProject(lane: "lane_1" | "lane_2" = "lane_1", existing?: Awaited<ReturnType<typeof seedAdmin>>) {
  const admin = existing ?? (await seedAdmin(h));
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Harbor Pest Control",
    trade: "pest_control",
    tier: "pro",
    lane,
    laneOption: lane === "lane_2" ? "b" : null,
    conceptCount: 3,
    status: "build",
    memberUserIds: [],
  });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Harbor Pest Control", state: "AZ" });
  const pages = await h.db
    .insert(pagePlanPage)
    .values(PLAN.map((p, i) => ({ projectId: id, position: i, kind: p.kind, name: p.name, slug: p.slug, title: `${p.name} | Harbor Pest Control`, metaDescription: `${p.name} from Harbor Pest Control in Mesa, Arizona.` })))
    .returning();
  for (const page of pages) {
    // Home and About are kept from the current site; About's words are long.
    const kept = page.kind === "home" || page.kind === "about";
    const body = page.kind === "about" ? `# About\n\n${"We have served the East Valley since 1998. ".repeat(80)}\n` : kept ? "# Home\n\nWe keep pests out of Mesa homes.\n" : `# ${page.name}\n\nCopy.\n`;
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page.id, version: 1, source: kept ? "kept" : "draft", status: "done", body, approvedByUserId: admin.viewer.id, approvedAt: new Date() });
  }
  const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: admin.viewer.id }).returning();
  const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "succeeded" } as never).returning();
  const key = `projects/${id}/concepts/${c!.id}/v1/page.html`;
  r2.objects.set(key.replace(/page\.html$/, "source.html"), Buffer.from(MOCKUP));
  await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: key } as never);
  await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "A please", recordedByUserId: admin.viewer.id });
  return { admin, id, pages };
}

function builder(prompts: string[]) {
  return fakeClaude(() => [], {
    builder: (params) => {
      const text = String((params.messages as { content: string }[])[0]!.content);
      prompts.push(text);
      return turn(text.startsWith("# The shared parts") ? PARTS : mainFor(/# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page"), "end_turn");
    },
  });
}

async function runLast(prompts: string[]) {
  // The stand-in's answers are 30,000 tokens each (far more than a real page): room so the stop at twice the estimate doesn't trip here.
  const [row] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[queued.length - 1]!.data.buildId));
  await h.db.update(siteBuild).set({ options: { ...(row!.options as StageBuildOptions), estimate: 100 } }).where(eq(siteBuild.id, row!.id));
  await runSiteBuildJob(queued[queued.length - 1]!.data, config, builder(prompts).client as never, fakeBrowser());
  const builds = await h.db.select().from(siteBuild).orderBy(siteBuild.version);
  return builds[builds.length - 1]!;
}

describe("building in stages", () => {
  it("builds Home with the header and footer, then one page per stage from the saved pages, then the rest; versions accumulate; go-live waits", async () => {
    const { admin, id } = await stagedProject();

    // Rule 8: nothing in bulk before Home.
    await expect(startStageBuild(h.ctx, admin.viewer, id, "remaining")).rejects.toThrow("Build Home first");
    await expect(startStageBuild(h.ctx, admin.viewer, id, "whole")).rejects.toThrow("Build Home first");

    // Stage 1: Home, and the header and footer.
    let view = (await loadStages(h.db, id))!;
    expect(view.next!.stage.label).toBe("Home");
    expect(view.next!.estimate.label).toMatch(/for 1 page and the shared header and footer/);
    expect(view.remaining).toBeNull();
    await startStageBuild(h.ctx, admin.viewer, id, "next");
    let prompts: string[] = [];
    const v1 = await runLast(prompts);
    expect(v1).toMatchObject({ status: "done", version: 1 });
    expect((v1.options as StageBuildOptions).only).toEqual(["home"]);
    expect((v1.options as StageBuildOptions).estimate).toBeGreaterThan(0);
    expect(prompts.map((p) => p.split("\n")[0])).toEqual(["# The shared parts", "# The page: Home (/)"]);
    // The header's menu is the whole plan's.
    expect(prompts[0]).toContain("Termites (/termites/)");
    expect((v1.pages as BuiltPage[]).map((p) => [p.path, p.builtIn])).toEqual([["/", 1]]);
    const p1 = `projects/${id}/site/v1/`;
    const soon = r2.objects.get(`${p1}about/index.html`)!.toString("utf8");
    expect(soon).toContain("About: coming soon");
    expect(soon).toContain('content="noindex"');
    expect(soon).toContain("Website by Velocity Media Lab");
    expect(r2.objects.has(`${p1}privacy/index.html`)).toBe(true);
    expect(r2.objects.has(`${p1}thank-you/index.html`)).toBe(true);
    expect(JSON.parse(r2.objects.get(`${p1}_source/unbuilt.json`)!.toString("utf8"))).toHaveLength(7);
    expect(r2.objects.has(`${p1}_source/pages/about.html`)).toBe(false);
    // Every menu link works (the Coming soon pages answer).
    const checks1 = v1.checks as { key: string; ok: boolean; detail: string }[];
    expect(checks1.find((c) => c.key === "links")!.ok).toBe(true);
    // The words check: only the built kept page (Home), not About.
    expect(checks1.find((c) => c.key === "kept_words")!.detail).toContain("of 1 kept pages");

    // Go-live waits; the Build part stays open; the card says 1 of 8.
    let checklist = await goLiveChecklist(h.db, id);
    expect(checklist.items.find((i) => i.key === "all-pages-built")).toMatchObject({ ok: false, blocksGoLive: true, detail: expect.stringContaining("1 of 8 pages built") });
    view = (await loadStages(h.db, id))!;
    expect(currentBuildPart({ lane: "lane_1", hasBuild: true, building: false, signedOff: false, previewApproved: false, live: false, allBuilt: view.allBuilt })).toBe("build");
    const card = stagesCardProps(view);
    expect(card.rows.slice(0, 3).map((r) => r.status)).toEqual(["built", "next", "waiting"]);
    expect(card.next).toMatchObject({ label: "About", button: "Build About", makesParts: false, pages: 1 });
    expect(card.lastBuilt).toBe("Home (version 1)");
    expect(card.remaining!.pages).toBe(7);
    // About's long kept words cost more than Contact's short copy; no header and footer after Home.
    expect(view.next!.estimate.label).not.toContain("header and footer");
    const contactOnly = await estimateStage(h.db, [{ copyChars: 20 }], false);
    expect(view.next!.estimate.cost).toBeGreaterThan(contactOnly.cost);

    // Stage 2: About alone, one AI call, Home from its saved source.
    await startStageBuild(h.ctx, admin.viewer, id, "next");
    prompts = [];
    const v2 = await runLast(prompts);
    expect(prompts.map((p) => p.split("\n")[0])).toEqual(["# The page: About (/about/)"]);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.runId, v2.id))).map((c) => c.step)).toEqual(["site_page"]);
    expect((v2.pages as BuiltPage[]).map((p) => [p.path, p.builtIn])).toEqual([["/", 1], ["/about/", 2]]);
    expect(r2.objects.get(`projects/${id}/site/v2/_source/pages/home.html`)!.toString("utf8")).toBe(r2.objects.get(`${p1}_source/pages/home.html`)!.toString("utf8"));
    expect(r2.objects.get(`projects/${id}/site/v2/_source/parts.json`)!.toString("utf8")).toBe(r2.objects.get(`${p1}_source/parts.json`)!.toString("utf8"));
    expect((v2.checks as { key: string; detail: string }[]).find((c) => c.key === "kept_words")!.detail).toContain("of 2 kept pages");

    // The next stages' names: Contact, then the first service page alone, then the other two.
    view = (await loadStages(h.db, id))!;
    expect(view.states.map((s) => [s.label, s.status])).toEqual([
      ["Home", "built"],
      ["About", "built"],
      ["Contact", "next"],
      ["The first service page: Ant control", "waiting"],
      ["The other 2 service pages", "waiting"],
      ["The first service-area page: Mesa", "waiting"],
      ["The other service-area page", "waiting"],
    ]);

    // Build all remaining: six calls, no header and footer, everything in version 3.
    await startStageBuild(h.ctx, admin.viewer, id, "remaining");
    prompts = [];
    const v3 = await runLast(prompts);
    expect(prompts).toHaveLength(6);
    expect(prompts.some((p) => p.startsWith("# The shared parts"))).toBe(false);
    expect((v3.options as StageBuildOptions).stage).toBe("Every remaining page (6)");
    expect((v3.pages as BuiltPage[]).map((p) => p.builtIn)).toEqual([1, 2, 3, 3, 3, 3, 3, 3]);
    expect(JSON.parse(r2.objects.get(`projects/${id}/site/v3/_source/unbuilt.json`)!.toString("utf8"))).toEqual([]);
    checklist = await goLiveChecklist(h.db, id);
    expect(checklist.items.find((i) => i.key === "all-pages-built")).toMatchObject({ ok: true });
    view = (await loadStages(h.db, id))!;
    expect(view.allBuilt).toBe(true);
    expect(view.next).toBeNull();
    expect(view.whole!.label).toContain("for 8 pages and the shared header and footer");
    await expect(startStageBuild(h.ctx, admin.viewer, id, "next")).rejects.toThrow("Every planned page is built");
  }, 180_000);

  it("stops at twice the stage's estimate", async () => {
    const { admin, id } = await stagedProject();
    await startStageBuild(h.ctx, admin.viewer, id, "next");
    const [row] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    await h.db.update(siteBuild).set({ options: { ...(row!.options as StageBuildOptions), estimate: 0.0001 } }).where(eq(siteBuild.id, row!.id));
    await expect(runSiteBuildJob(queued[0]!.data, config, builder([]).client as never, fakeBrowser())).rejects.toThrow("Stopped at twice its estimate");
    expect(await h.db.select().from(aiCall).where(eq(aiCall.runId, row!.id))).toHaveLength(1);
  }, 60_000);

  it("only PMs and admins build; Lane 2 has no stages; the Build and Preview parts show the partial site", async () => {
    const { admin, id } = await stagedProject();
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(startStageBuild(h.ctx, content.viewer, id, "next")).rejects.toThrow();
    await startStageBuild(h.ctx, pm.viewer, id, "next");
    await expect(startStageBuild(h.ctx, pm.viewer, id, "next")).rejects.toThrow("already being built");
    await runLast([]);

    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    const build = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "build" }) }));
    expect(build).toContain("1 of 8 pages built");
    expect(build).toContain("Build About");
    expect(build).toContain("Build all remaining pages (7)");
    expect(build).toContain("Built v1");
    expect(build).toContain("Waiting");
    expect(build).toContain("own pages");
    const preview = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "preview" }) }));
    expect(preview).toContain("1 of 8 pages built in version 1: the others show a &quot;Coming soon&quot; page");
    const check = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "check" }) }));
    expect(check).toContain("Every planned page built");

    const lane2 = await stagedProject("lane_2", admin);
    expect(await loadStages(h.db, lane2.id)).toBeNull();
    await expect(startStageBuild(h.ctx, lane2.admin.viewer, lane2.id, "next")).rejects.toThrow();
  }, 120_000);
});

describe("a makeover's kept articles: the first by the AI, the rest by code (0.98.0)", () => {
  it("builds one article with the AI and fills the others into its layout by code; the estimate counts only the AI's pages", async () => {
    const { admin, id } = await stagedProject();
    // A blog and three articles kept from the current site.
    const extra = await h.db
      .insert(pagePlanPage)
      .values([
        { projectId: id, position: 20, kind: "blog", name: "Blog", slug: "blog", title: "Blog | Harbor Pest Control", metaDescription: "Pest tips from Harbor Pest Control." },
        ...[1, 2, 3].map((n) => ({ projectId: id, position: 20 + n, kind: "article", name: `Article ${n}`, slug: `blog/article-${n}`, parentSlug: "blog", title: `Article ${n} | Harbor Pest Control`, metaDescription: `Article ${n} from Harbor Pest Control.` })),
      ])
      .returning();
    for (const page of extra) {
      const body = page.kind === "blog" ? "# Blog\n\nTips.\n" : `# ${page.name} <&>\n\nWords of ${page.name.toLowerCase()} [call us](/contact/).\n\n- One tip\n- Two tips\n`;
      await h.db.insert(pageDraft).values({ projectId: id, pageId: page.id, version: 1, source: "kept", status: "done", body, approvedByUserId: admin.viewer.id, approvedAt: new Date() });
    }
    await startStageBuild(h.ctx, admin.viewer, id, "next");
    await runLast([]);

    const view = (await loadStages(h.db, id))!;
    expect(view.remaining!.pages).toBe(11);
    expect(view.remaining!.estimate.label).toContain("2 more blog articles are filled into the first article's layout by code: free.");

    // The stand-in marks the article's words as the prompt asks.
    const prompts: string[] = [];
    const client = fakeClaude(() => [], {
      builder: (params) => {
        const text = String((params.messages as { content: string }[])[0]!.content);
        prompts.push(text);
        const name = /# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page";
        if (text.includes("data-tawd-article")) return turn(`<main><div class="post-wrap"><article data-tawd-article><h1 class="post-title">${name}</h1><p class="post-p">Built page.</p></article><aside class="cta"><a href="/contact/">Call Harbor</a></aside></div></main>`, "end_turn");
        return turn(text.startsWith("# The shared parts") ? PARTS : mainFor(name), "end_turn");
      },
    });
    await startStageBuild(h.ctx, admin.viewer, id, "remaining");
    const [row] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, queued[queued.length - 1]!.data.buildId));
    await h.db.update(siteBuild).set({ options: { ...(row!.options as StageBuildOptions), estimate: 100 } }).where(eq(siteBuild.id, row!.id));
    await runSiteBuildJob(queued[queued.length - 1]!.data, config, client.client as never, fakeBrowser());
    const [v2] = await h.db.select().from(siteBuild).where(eq(siteBuild.id, row!.id));
    expect(v2!.status).toBe("done");
    const asked = prompts.map((p) => p.split("\n")[0]);
    expect(asked.filter((p) => p.includes("Article"))).toEqual(["# The page: Article 1 (/blog/article-1/)"]);
    expect((await h.db.select().from(aiCall).where(eq(aiCall.runId, v2!.id))).length).toBe(9);
    const two = r2.objects.get(`projects/${id}/site/v2/_source/pages/blog/article-2.html`)!.toString("utf8");
    expect(two).toContain('<h1 class="post-title">Article 2 &lt;&amp;&gt;</h1>');
    expect(two).toContain('<p class="post-p">Words of article 2 <a href="/contact/">call us</a>.</p>');
    expect(two).toContain("<ul><li>One tip</li><li>Two tips</li></ul>");
    expect(two).toContain('<aside class="cta"><a href="/contact/">Call Harbor</a></aside>');
    expect(two).not.toContain("Built page.");
    expect((v2!.pages as BuiltPage[]).map((p) => p.path)).toEqual(expect.arrayContaining(["/blog/article-2/", "/blog/article-3/"]));
  }, 120_000);
});

