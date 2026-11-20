import path from "node:path";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Build A, 8a (26 September 2026): the static site from the approved
  mockup and the approved copy. Claude is a stand-in (no AI money); Astro
  really builds the files.
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
// The link check connects through pinnedStatusFetch (0.114.0); here it goes through the test's stand-in web (fetch) instead.
// Its own refusal of private addresses is tested in review-lows.test.ts.
vi.mock("../../../worker/src/liked-sites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../worker/src/liked-sites")>()),
  pinnedStatusFetch: ((input: string | URL | Request, init?: RequestInit) => fetch(input, init)) as typeof fetch,
}));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { aiCall, clientDecision, concept, conceptVersion, mockupRun, pageDraft, pagePlanPage, siteBuild, projectTracking } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { SITE_BUILD_JOB, type SiteBuildJobData } from "@tawd/core/queue";
import { KEPT_COPY_RULE, astroProject, extractDesignSystem, placeholdersIn, readPageReply, readPartsReply } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { makePagePlan } from "@/lib/seo-data";
import { setQueueForTesting } from "@/lib/mockups";
import { rebaseSiteFile, siteFileKey, siteReadiness, startSiteBuild, type BuiltPage } from "@/lib/site-builds";

import { runSiteBuildJob } from "../../../worker/src/site-build";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
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

const MOCKUP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mockup</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://evil.example/x.css">
<style>body{font-family:Inter,sans-serif;margin:0}.band{padding:48px}.hero{background:#1F4E79;color:#fff}.hero h1{font-size:44px}</style></head>
<body><header class="band"><img src="tawd-asset:logo" alt="Sacramento Drain Pros"><nav><a href="#services">Services</a></nav><a href="tel:">Call</a></header>
<section class="band hero"><h1>Drains cleared the same day</h1><p>Mockup words.</p></section>
<section class="band"><h2>Services</h2><div class="cards"><div class="card">Drain cleaning</div></div></section>
<footer class="band"><p>Sacramento Drain Pros</p></footer></body></html>`;

const PARTS = `<header class="band"><a class="skip" href="#main">Skip to content</a><a href="/"><img src="tawd-asset:logo" alt="Sacramento Drain Pros"></a><nav><a href="/">Home</a> <a href="/drain-cleaning/">Drain cleaning</a> <a href="java&#9;script:steal()" onclick="steal()">Offers</a></nav></header>
<footer class="band"><p>Sacramento Drain Pros</p><p>Website by Velocity Media Lab</p><script>steal()</script></footer>`;

const mainFor = (name: string) => `<main><section class="band hero"><h1>${name} in Sacramento</h1><p>Call <mark class="tawd-placeholder">[PLACEHOLDER: phone number]</mark>. Prices like {this} stay literal.</p></section>
<section class="band"><h2>What we do</h2><p>Kitchen drains.</p><img src="tawd-asset:logo" alt="Logo"></section></main>`;

async function readyProject() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Sacramento Drain Pros",
    trade: "plumbing",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "build",
    memberUserIds: [],
  });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sacramento Drain Pros", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  await makePagePlan(h.ctx, admin.viewer, id);
  const pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
  return { admin, id, pages };
}

async function approveMockup(id: string, userId: string) {
  const [run] = await h.db.insert(mockupRun).values({ projectId: id, conceptCount: 1, status: "succeeded", model: "m", startedByUserId: userId }).returning();
  const [c] = await h.db.insert(concept).values({ runId: run!.id, projectId: id, label: "A", direction: "trust-first-local", skillId: "impeccable", status: "succeeded" } as never).returning();
  const key = `projects/${id}/concepts/${c!.id}/v1/page.html`;
  r2.objects.set(key.replace(/page\.html$/, "source.html"), Buffer.from(MOCKUP));
  await h.db.insert(conceptVersion).values({ conceptId: c!.id, version: 1, htmlKey: key } as never);
  await h.db.insert(clientDecision).values({ projectId: id, conceptId: c!.id, version: 1, channel: "email", changesRequested: false, clientSaid: "A please", recordedByUserId: userId });
}

async function approveCopy(id: string, pages: (typeof pagePlanPage.$inferSelect)[], userId: string) {
  for (const page of pages) {
    await h.db.insert(pageDraft).values({ projectId: id, pageId: page.id, version: 1, source: "draft", status: "done", body: `# ${page.name}\n\nCopy.\n`, approvedByUserId: userId, approvedAt: new Date() });
  }
}

describe("the design system and the replies", () => {
  it("takes the mockup's styles, Google Fonts only, and its header, footer and sections", () => {
    const design = extractDesignSystem(MOCKUP);
    expect(design.css).toContain(".hero h1{font-size:44px}");
    expect(design.fontLinks.join("")).toContain("fonts.googleapis.com/css2");
    expect(design.fontLinks.join("")).not.toContain("evil.example");
    expect(design.header).toMatch(/^<header/);
    expect(design.footer).toMatch(/^<footer/);
    expect(design.sections).toHaveLength(2);
  });

  it("insists on one H1, no scripts, the parts, and the footer line", () => {
    expect(readPageReply(mainFor("Home"))).toMatch(/^<main id="main"/);
    expect(() => readPageReply("<main><h1>A</h1><h1>B</h1></main>")).toThrow("exactly one <h1>");
    expect(() => readPageReply("<main><h1>A</h1><script>x()</script></main>")).toThrow("can't have scripts");
    expect(readPartsReply("```html\n" + PARTS + "\n```").footer).toContain("Website by Velocity Media Lab");
    expect(() => readPartsReply("<header></header><footer>x</footer>")).toThrow("Website by Velocity Media Lab");
    expect(placeholdersIn(mainFor("Home"))).toEqual(["[PLACEHOLDER: phone number]"]);
  });

  it("writes an Astro project where the HTML is never read as Astro syntax", () => {
    const files = astroProject({
      clientName: "Sacramento Drain Pros",
      design: extractDesignSystem(MOCKUP),
      parts: readPartsReply(PARTS),
      pages: [{ page: { name: "Home", kind: "home", slug: "" }, title: "Home | Sacramento Drain Pros", metaDescription: "Drains.", main: readPageReply(mainFor("Home")) }],
      images: [{ token: "tawd-asset:logo", path: "/images/logo.png" }],
    });
    expect([...files.keys()].sort()).toEqual(["public/site.css", "src/layouts/Site.astro", "src/pages/index.astro"]);
    expect(files.get("src/pages/index.astro")).toContain("set:html={main}");
    expect(files.get("src/pages/index.astro")).toContain("/images/logo.png");
    expect(files.get("src/pages/index.astro")).not.toContain("tawd-asset:");
  });
});

describe("building the site", () => {
  it("waits for the approved mockup and Content's approval of every page", async () => {
    const { admin, id, pages } = await readyProject();
    await expect(startSiteBuild(h.ctx, admin.viewer, id)).rejects.toThrow("hasn't approved a mockup");
    await approveMockup(id, admin.viewer.id);
    await expect(startSiteBuild(h.ctx, admin.viewer, id)).rejects.toThrow("aren't approved by Content yet");
    await approveCopy(id, pages, admin.viewer.id);
    expect((await siteReadiness(h.db, id)).ready).toBe(true);
  });

  // The whole-code review (13 October 2026): two clicks together start one paid build, never two with the same version.
  it("starts one build when Build is pressed twice at once", async () => {
    const { admin, id, pages } = await readyProject();
    await approveMockup(id, admin.viewer.id);
    await approveCopy(id, pages, admin.viewer.id);
    const results = await Promise.allSettled([startSiteBuild(h.ctx, admin.viewer, id), startSiteBuild(h.ctx, admin.viewer, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("The site is already being built.");
    const builds = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect(builds.map((b) => b.version)).toEqual([1]);
    expect(queued).toHaveLength(1);
  });

  it("builds every page with Astro, stores the files and a picture of each page, and records every paid call", async () => {
    const { admin, id, pages } = await readyProject();
    await approveMockup(id, admin.viewer.id);
    await approveCopy(id, pages, admin.viewer.id);
    await startSiteBuild(h.ctx, admin.viewer, id);
    expect(queued[0]!.name).toBe(SITE_BUILD_JOB);

    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const text = String((params.messages as { content: string }[])[0]!.content);
        prompts.push(text);
        return turn(text.startsWith("# The shared parts") ? PARTS : mainFor(/# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page"), "end_turn");
      },
    });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect(build).toMatchObject({ status: "done", version: 1, step: null });
    const built = build!.pages as BuiltPage[];
    expect(built.map((p) => p.path)).toEqual(pages.map((p) => (p.slug ? `/${p.slug}/` : "/")));
    expect(built.every((p) => p.placeholders.includes("[PLACEHOLDER: phone number]"))).toBe(true);

    const prefix = `projects/${id}/site/v1/`;
    const home = r2.objects.get(`${prefix}index.html`)!.toString("utf8");
    expect(home).toContain(`<title>${pages[0]!.title}</title>`);
    expect(home).toContain("Website by Velocity Media Lab");
    expect(home).toContain('<main id="main">');
    // No code from the AI on the site (13 October 2026): its script, handler and javascript: link are gone.
    expect(home).not.toContain("steal()");
    expect(home).toContain('<a href="#">Offers</a>');
    expect(home).toContain("Prices like {this} stay literal.");
    // No logo was uploaded: the mockup's logo becomes a visible placeholder, never a broken image.
    expect(home).toContain("[PLACEHOLDER: image logo]");
    expect(home).not.toContain("tawd-asset:");
    expect(r2.objects.has(`${prefix}drain-cleaning/index.html`)).toBe(true);
    expect(r2.objects.get(`${prefix}site.css`)!.toString("utf8")).toContain(".hero h1");

    // 8b: a preview is kept out of search engines; 404 and thank-you pages; schema on Home; sources kept for edits.
    expect(r2.objects.get(`${prefix}robots.txt`)!.toString("utf8")).toContain("Disallow: /");
    expect(r2.objects.get(`${prefix}_headers`)!.toString("utf8")).toContain("X-Robots-Tag: noindex");
    expect(r2.objects.get(`${prefix}404.html`)!.toString("utf8")).toContain("find that page");
    expect(r2.objects.has(`${prefix}thank-you/index.html`)).toBe(true);
    expect(home).toContain('"@type":"Plumber"');
    expect(home).not.toMatch(/aggregateRating/i);
    expect(r2.objects.has(`${prefix}_source/parts.json`)).toBe(true);
    expect(r2.objects.has(`${prefix}_source/pages/home.html`)).toBe(true);
    const checks = build!.checks as { key: string; ok: boolean }[];
    expect(checks.find((c) => c.key === "404")!.ok).toBe(true);
    expect(checks.find((c) => c.key === "skip")!.ok).toBe(true);
    // The stylesheet and images count as files for the link check.
    expect(checks.find((c) => c.key === "links")!.ok).toBe(true);
    expect(checks.find((c) => c.key === "placeholders")!.ok).toBe(false);
    expect(build!.mode).toBe("preview");

    // The approved copy went to the builder, with the design system once in the cached system prompt.
    expect(prompts[0]).toMatch(/^# The shared parts/);
    expect(prompts.some((p) => p.includes("<approved_copy>\n# Drain cleaning"))).toBe(true);
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.runId, build!.id));
    expect(calls.map((c) => c.step).sort()).toEqual(["site_parts", ...pages.map(() => "site_page")].sort());
  }, 60_000);

  it("keep the current site: a kept page's prompt carries the keep rule, and its words are checked after the build (free)", async () => {
    const { admin, id, pages } = await readyProject();
    await approveMockup(id, admin.viewer.id);
    const [home, ...rest] = pages;
    await h.db.insert(pageDraft).values({ projectId: id, pageId: home!.id, version: 1, source: "kept", status: "done", body: "# Home in Sacramento\n\n## What we do\n\nKitchen drains.\n\nWe clear drains the same day.\n", approvedByUserId: admin.viewer.id, approvedAt: new Date() });
    await approveCopy(id, rest, admin.viewer.id);
    await startSiteBuild(h.ctx, admin.viewer, id);
    const prompts: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const text = String((params.messages as { content: string }[])[0]!.content);
        prompts.push(text);
        return turn(text.startsWith("# The shared parts") ? PARTS : mainFor(/# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page"), "end_turn");
      },
    });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, fakeBrowser());
    const homePrompt = prompts.find((p) => p.startsWith("# The page: Home"))!;
    expect(homePrompt).toContain(KEPT_COPY_RULE);
    expect(prompts.filter((p) => p.includes(KEPT_COPY_RULE))).toHaveLength(1);
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    const check = (build!.checks as { key: string; ok: boolean; detail: string; blocksGoLive: boolean }[]).find((c) => c.key === "kept_words")!;
    expect(check).toMatchObject({ ok: false, blocksGoLive: false });
    expect(check.detail).toContain('Home (/): 1 of 4 sentences, e.g. "We clear drains the same day."');
  }, 60_000);

  it("places the client's booking and review links, fills the booking calendar in, and checks each link answers (stand-in web)", async () => {
    const { admin, id, pages } = await readyProject();
    await saveIntakeSection(h.ctx, admin.viewer, id, "extras", {
      integrations: [
        { id: "i1", kind: "booking", provider: "Calendly", url: "https://calendly.com/sac-drain/visit", embed: true },
        { id: "i2", kind: "reviews", provider: "Yelp", url: "https://www.yelp.com/biz/sac-drain" },
      ],
    });
    await approveMockup(id, admin.viewer.id);
    await approveCopy(id, pages, admin.viewer.id);
    await startSiteBuild(h.ctx, admin.viewer, id);

    const systems: string[] = [];
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        systems.push(JSON.stringify(params.system));
        const text = String((params.messages as { content: string }[])[0]!.content);
        const name = /# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page";
        if (text.startsWith("# The shared parts")) return turn(PARTS, "end_turn");
        const extra = name === "Home" ? '<p><a href="https://calendly.com/sac-drain/visit">Book online</a></p>' : /contact/i.test(name) ? '<div data-tawd-integration="i1"></div>' : "";
        return turn(mainFor(name).replace("</main>", `${extra}</main>`), "end_turn");
      },
    });
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(null, { status: url.includes("yelp") ? 404 : 200 });
    });
    try {
      await runSiteBuildJob(queued[0]!.data, config, claude.client as never, fakeBrowser());
    } finally {
      vi.unstubAllGlobals();
    }

    expect(systems[0]).toContain("# The client's online tools");
    expect(systems[0]).toContain("https://calendly.com/sac-drain/visit");
    // The client's links, each checked once (the speed pass's Google Fonts requests aside).
    expect(asked.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)).sort()).toEqual(["https://calendly.com/sac-drain/visit", "https://www.yelp.com/biz/sac-drain"]);
    const contact = pages.find((p) => p.kind === "contact")!;
    const html = r2.objects.get(`projects/${id}/site/v1/${contact.slug}/index.html`)!.toString("utf8");
    expect(html).toContain('<iframe src="https://calendly.com/sac-drain/visit?embed_type=Inline&amp;hide_gdpr_banner=1"');
    expect(html).not.toContain("data-tawd-integration");
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    const item = (build!.checks as { key: string; ok: boolean; detail: string; blocksGoLive: boolean }[]).find((c) => c.key === "integrations")!;
    expect(item).toMatchObject({ ok: false, blocksGoLive: true });
    expect(item.detail).toBe("Reviews isn't on the site; Reviews (Answers 404)");
  }, 60_000);

  it("writes the tracking code into every page behind consent, with the banner, the footer's links and VML's policies", async () => {
    const { admin, id, pages } = await readyProject();
    await h.db.insert(projectTracking).values({ projectId: id, ga4: "G-AB12CD34EF", gtm: "", metaPixel: "123456789012345", googleAds: "", consentMode: "opt_out" });
    await approveMockup(id, admin.viewer.id);
    await approveCopy(id, pages, admin.viewer.id);
    await startSiteBuild(h.ctx, admin.viewer, id);
    const claude = fakeClaude(() => [], {
      builder: (params) => {
        const text = String((params.messages as { content: string }[])[0]!.content);
        return turn(text.startsWith("# The shared parts") ? PARTS : mainFor(/# The page: ([^(]+) \(/.exec(text)?.[1]?.trim() ?? "Page"), "end_turn");
      },
    });
    await runSiteBuildJob(queued[0]!.data, config, claude.client as never, fakeBrowser());

    const prefix = `projects/${id}/site/v1/`;
    for (const file of ["index.html", "drain-cleaning/index.html", "thank-you/index.html", "404.html", "privacy/index.html", "cookies/index.html"]) {
      const html = r2.objects.get(`${prefix}${file}`)!.toString("utf8");
      expect(html, file).toContain('"pixel":"123456789012345"');
      expect(html, file).toContain('id="tawd-consent"');
      expect(html, file).toContain("Do Not Sell or Share My Personal Information");
      expect(html, file).toContain("Cookie settings");
    }
    const home = r2.objects.get(`${prefix}index.html`)!.toString("utf8");
    // Nothing is loaded by the page itself: only the consent script adds the tools.
    expect(home).not.toMatch(/<script[^>]+src="https:\/\/(www\.googletagmanager|connect\.facebook)/);
    // VML's templates (28 September 2026), with the parts for the tracking that's on.
    const privacy = r2.objects.get(`${prefix}privacy/index.html`)!.toString("utf8");
    expect(privacy).toContain("<h1>Privacy Policy</h1>");
    // The business is in California: California's sections, and no other state's.
    expect(privacy).toContain("California residents");
    expect(privacy).not.toContain("Nevada residents");
    expect(r2.objects.get(`${prefix}cookies/index.html`)!.toString("utf8")).toContain("Meta Pixel (Meta Platforms)");
    const [build] = await h.db.select().from(siteBuild).where(eq(siteBuild.projectId, id));
    expect((build!.checks as { key: string; ok: boolean }[]).find((c) => c.key === "policies")).toBeDefined();
    expect((build!.checks as { key: string; ok: boolean; detail: string }[]).find((c) => c.key === "tracking")).toMatchObject({ ok: true, detail: expect.stringMatching(/on unless the visitor opts out/) });
  }, 60_000);

  it("keeps the viewer's paths inside the build and points links at it", () => {
    expect(siteFileKey("projects/p/", 2, [])).toBe("projects/p/site/v2/index.html");
    expect(siteFileKey("projects/p/", 2, ["drain-cleaning"])).toBe("projects/p/site/v2/drain-cleaning/index.html");
    expect(siteFileKey("projects/p/", 2, ["site.css"])).toBe("projects/p/site/v2/site.css");
    expect(siteFileKey("projects/p/", 2, ["..", "secrets"])).toBeNull();
    expect(rebaseSiteFile('<a href="/about/"><img src="/images/a.jpg"><a href="https://x.com/">', "/b")).toBe('<a href="/b/about/"><img src="/b/images/a.jpg"><a href="https://x.com/">');
    // The speed pass's picture sizes: every address in the list, never another site's.
    expect(rebaseSiteFile('<img src="/images/a.jpg" srcset="/assets/images/a-512-1.webp 512w, /assets/images/a-1024-2.webp 1024w, https://cdn.x/a.webp 2x" sizes="50vw">', "/b")).toBe(
      '<img src="/b/images/a.jpg" srcset="/b/assets/images/a-512-1.webp 512w, /b/assets/images/a-1024-2.webp 1024w, https://cdn.x/a.webp 2x" sizes="50vw">',
    );
    expect(rebaseSiteFile('<link rel="preload" as="image" href="/assets/h.webp" imagesrcset="/assets/h-1.webp 1x,/assets/h-2.webp 2x">', "/b")).toBe(
      '<link rel="preload" as="image" href="/b/assets/h.webp" imagesrcset="/b/assets/h-1.webp 1x,/b/assets/h-2.webp 2x">',
    );
  });

  it("renders the Build screen", async () => {
    const { admin, id } = await readyProject();
    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    const html = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "build" }) }));
    expect(html).toContain("The site");
    expect(html).toContain("hasn&#x27;t approved a mockup yet");
  });
});
