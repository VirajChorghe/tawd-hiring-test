import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Keep the current site (Jason, 6 October 2026; docs/plans/keep-current-site.md):
  the current site's pages read by code (free), their words kept exactly,
  the page plan made from them, Content's review and "Approve all kept
  pages", the build's keep rule and its words check, and the SEO
  suggestions. A saved WordPress site stands in for the internet.
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

import { and, eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { parseDraft } from "@tawd/core/content";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { SITE_READ_JOB, type SiteReadJobData } from "@tawd/core/queue";
import { activityLog, pageComment, pageDraft, pagePlanPage, siteImport } from "@tawd/core/schema";
import {
  KEPT_COPY_RULE,
  botCheck,
  botCheckMessage,
  astroProject,
  buildPagePrompt,
  buildPartsPrompt,
  currentSiteSuggestions,
  extractPage,
  importKind,
  importName,
  importPath,
  keptMarkdown,
  keptWordsCheck,
  menuPlan,
  needsGroupedMenu,
  pagePlace,
  readSitemap,
  sitemapKind,
  skipReason,
  slugFromPath,
  textSimilarity,
  type ImportedPageSummary,
} from "@tawd/core/site";
import { MAX_HOME_SECTIONS, homeWordsFromKeptPage } from "@tawd/core/mockups";
import { keptHomeWords } from "@tawd/core/kept-home-words";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import { KeptHomeWordsCard, type KeptHomeWordsCardProps } from "@/components/mockups/home-words-card";
import { approvedHomeWords, homeWordsBlocked, loadHomeWords, startHomeWords, writeHomeWords } from "@/lib/home-words";
import { saveDraftEdit } from "@/lib/content-drafts";
import { setQueueForTesting } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import { approveKeptPages, countKeptWaiting, loadSiteRead, readSiteAgain, replacePlanWithSite, syncKeepChoice, syncSiteRead } from "@/lib/site-read";
import { savePlanPage } from "@/lib/seo-data";
import { followPolitely, politeFetch, runSiteReadJob, setSiteReadStandInsForTesting, IMPORT_MAX_BYTES, type HomeLooker, type Requester } from "../../../worker/src/site-read";
import { setLookupForTesting } from "../../../worker/src/liked-sites";
import { PAGES, SITE, siteFetch } from "./fixtures/keep-site";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: SiteReadJobData }[];
let asked: string[];

beforeEach(async () => {
  h = await createHarness();
  seededAdmin = null;
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  asked = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteReadJobData }), getJob: async () => null });
  // Every host is public, the site is the saved one, and the pause between requests takes no time.
  setLookupForTesting(async () => ["93.184.216.34"]);
  setSiteReadStandInsForTesting({ fetch: siteFetch(asked), wait: async () => undefined, look: testLook });
});

afterEach(async () => {
  state.user = null;
  setQueueForTesting(null);
  setLookupForTesting(null);
  setSiteReadStandInsForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* The browser's look at the home page, without a browser (the worker's stand-in). */
const testLook: HomeLooker = async () => ({
  title: "Acme Pest Control",
  menu: [{ label: "Home", href: `${SITE}/` }],
  sections: [{ kind: "hero", heading: "Family-Owned Pest Control in Folsom", words: "Family-Owned Pest Control in Folsom. We have protected Folsom homes since 2012." }],
  phones: ["(916) 555-0142"],
  testimonials: [],
});

const lane1 = { clientName: "Acme Pest Control", trade: "pest_control", tier: "pro", lane: "lane_1", laneOption: null, conceptCount: 1, status: "content", memberUserIds: [] as string[] } as const;

let seededAdmin: Awaited<ReturnType<typeof seedAdmin>> | null = null;
async function seed(options: { tier?: "starter" | "growth" | "pro"; mode?: "keep" | "auto" } = {}) {
  const admin = seededAdmin ?? (seededAdmin = await seedAdmin(h));
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, { ...lane1, tier: options.tier ?? "pro" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Acme Pest Control", phone: "(916) 555-0142", city: "Folsom", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Folsom, CA", "Roseville, CA"] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://acmepest.example" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: options.mode ?? "keep" });
  return { admin, id };
}

/* Starts the read as the intake save does, and runs the worker's job on the saved site. */
async function readSite(id: string) {
  await syncSiteRead(h.ctx, id);
  const job = queued.filter((q) => q.name === SITE_READ_JOB && q.data.projectId === id).at(-1)!;
  await runSiteReadJob(job.data);
  const [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
  return row!;
}

describe("reading a page: its own words, exactly", () => {
  it("keeps the main content's words, headings, lists, links and form, and drops the header, menu, footer, cookie bar, popup, widgets and scripts", () => {
    const page = extractPage(PAGES["/"]!, `${SITE}/`);
    const md = keptMarkdown(page, page.title).markdown;
    expect(md).toContain("# Family-Owned Pest Control in Folsom");
    expect(md).toContain("We have protected Folsom homes since 2012. Our bi-monthly plan starts at $40 per month.");
    // Elementor's copy for phones isn't read twice.
    expect(md.match(/We have protected Folsom homes/g)).toHaveLength(1);
    expect(md).toContain("See our [ant control](/ant-control/) service, or read our [privacy policy](/privacy/).");
    expect(md).toContain("## Why choose us\n\n- Licensed (#OPR12345)\n- Pet-safe treatments\n- Free re-treatments");
    for (const chrome of ["Skip to content", "About Us", "Call (916) 555-0142", "We use cookies", "Get 20% off", "Sign up for our newsletter", "Best pest service ever", "12 Oak St", "dataLayer", "Send"]) {
      expect(md).not.toContain(chrome);
    }
    expect(page.hasForm).toBe(true);
    expect(page.reviewWidgets).toBe(1);
    expect(page.title).toBe("Acme Pest Control | Pest Control in Folsom, CA");
    expect(page.metaDescription).toMatch(/^Acme Pest Control protects homes/);
    expect(page.canonical).toBe(`${SITE}/`);
    expect(page.schemaTypes).toEqual(expect.arrayContaining(["LocalBusiness", "Product", "AggregateRating"]));
    expect(page.images).toEqual([{ src: `${SITE}/wp-content/uploads/truck.jpg`, alt: "Our service truck" }]);
    expect(page.menu.map((m) => m.label)).toEqual(["Home", "About Us", "Ants", "Rodents", "Folsom", "Specials", "Blog", "Contact Us"]);
  });

  it("keeps tables, numbered lists, H4s and quotes; a second H1 becomes an H2 and a page without an H1 gets its title, both noted", () => {
    const ants = extractPage(PAGES["/ant-control/"]!, `${SITE}/ant-control/`);
    const kept = keptMarkdown(ants, "Ant Control in Folsom");
    expect(kept.markdown).toContain("# Ant Control in Folsom\n\n## Say goodbye to ants");
    expect(kept.markdown).toContain("| Plan | Price |\n| One visit | $150 |\n| Bi-monthly | $40 per month |");
    expect(kept.markdown).toContain("#### Common ants\n\n1. Argentine ants\n2. Carpenter ants");
    // http:// to its own page becomes the new path; a phone link keeps its words; the related-posts widget is gone.
    expect(kept.markdown).toContain("Also see [rodent control](/rodent-control/) and [termites](/termite-control/).");
    expect(kept.markdown).toContain("Call (916) 555-0199 for a free quote.");
    expect(kept.markdown).not.toContain("Read more");
    expect(kept.notes).toEqual(['A second H1 ("Say goodbye to ants") is kept as an H2.']);
    expect(ants.images.map((i) => i.alt)).toEqual([null, "IMG_2041.jpg"]);

    const about = keptMarkdown(extractPage(PAGES["/about-us/"]!, `${SITE}/about-us/`), "");
    expect(about.markdown).toContain('> "We treat every home like our own."');
    expect(about.markdown).not.toContain("Recent posts");

    const specials = keptMarkdown(extractPage(PAGES["/specials/"]!, `${SITE}/specials/`), "Specials | Acme Pest Control");
    expect(specials.markdown.startsWith("# Specials | Acme Pest Control\n\n## This month's specials")).toBe(true);
    expect(specials.notes[0]).toMatch(/no H1/);
  });

  it("reads a blog post's own words, not its date line, share buttons or comments", () => {
    const md = keptMarkdown(extractPage(PAGES["/blog/spring-ants/"]!, `${SITE}/blog/spring-ants/`), "").markdown;
    expect(md).toBe("# Why Ants Come Inside in Spring\n\nWarm, wet spring weather drives ant colonies indoors.\n\n## What you can do\n\n- Wipe counters\n- Fix leaks\n");
  });

  it("the drafts' format reads the kept page back: headings to H6, numbered lists, quotes and tables", () => {
    const blocks = parseDraft("# A\n\n#### B\n\n1. one\n2. two\n\n> a quote\n\n| x | y |\n| 1 | 2 |\n\n\\- not a list");
    expect(blocks.map((b) => b.type)).toEqual(["h1", "h4", "ol", "quote", "table", "p"]);
    expect(blocks[4]!.rows).toEqual([["x", "y"], ["1", "2"]]);
    expect(blocks[5]!.text).toBe("- not a list");
  });
});

describe("which addresses are pages, and what kind", () => {
  it("leaves out feeds, files, archives, WordPress's own addresses and search; the policies are replaced", () => {
    const host = "acmepest.example";
    expect(skipReason(`${SITE}/feed/`, host)).toBe("A feed");
    expect(skipReason(`${SITE}/wp-content/uploads/menu.pdf`, host)).toBe("A file, not a page");
    expect(skipReason(`${SITE}/tag/ants/`, host)).toMatch(/archive/);
    expect(skipReason(`${SITE}/author/zack/`, host)).toMatch(/archive/);
    expect(skipReason(`${SITE}/wp-json/wp/v2/pages`, host)).toMatch(/WordPress/);
    expect(skipReason(`${SITE}/?s=ants`, host)).toMatch(/Search/);
    expect(skipReason(`${SITE}/blog/page/2/`, host)).toMatch(/second page/);
    expect(skipReason(`${SITE}/privacy-policy/`, host)).toBe("Replaced: TAWD writes its own privacy policy (/privacy/)");
    expect(skipReason(`${SITE}/cookie-policy/`, host)).toBe("Replaced: TAWD writes its own cookie policy (/cookies/)");
    expect(skipReason("https://facebook.com/acme", host)).toBe("Another website");
    expect(skipReason("https://acmepest.example/ant-control/", host)).toBeNull();
    expect(sitemapKind(`${SITE}/page-sitemap.xml`)).toBe("pages");
    expect(sitemapKind(`${SITE}/post-sitemap.xml`)).toBe("posts");
    expect(sitemapKind(`${SITE}/category-sitemap.xml`)).toBe("skip");
    expect(readSitemap(`<urlset><url><loc>${SITE}/a/</loc><lastmod>2026-01-01</lastmod></url></urlset>`).entries).toEqual([{ url: `${SITE}/a/`, lastmod: "2026-01-01" }]);
  });

  it("tells the kinds apart by address, title and the intake's cities, and names pages after the old menu", () => {
    const kind = (path: string, title = "", extra: Partial<Parameters<typeof importKind>[0]> = {}) => importKind({ path, title, h1: "", ...extra });
    expect(kind("/")).toBe("home");
    expect(kind("/about-us/")).toBe("about");
    expect(kind("/contact-us/")).toBe("contact");
    expect(kind("/pricing-coupons/")).toBe("pricing");
    expect(kind("/specials/")).toBe("pricing");
    expect(kind("/blog/")).toBe("blog");
    expect(kind("/blog/spring-ants/")).toBe("article");
    expect(kind("/pest-control-folsom-ca/")).toBe("city");
    expect(kind("/roseville-pest-control/", "Pest Control In Roseville, CA")).toBe("city");
    // A service page whose title names the main city isn't a city page.
    expect(kind("/spider-control/", "Spider Control in Sacramento, CA")).toBe("service");
    expect(kind("/natomas-exterminator/", "", { cities: ["Natomas, CA"] })).toBe("city");
    expect(kind("/ant-control/")).toBe("service");
    expect(kind("/trusted-local-partners/")).toBe("other");
    expect(importName({ path: "/ant-control/", title: "Ant Control In Sacramento, CA", h1: "Ant Control Services", menuLabel: "Ants", kind: "service" })).toBe("Ants");
    expect(importName({ path: "/rodent-control/", title: "Rodent Control | Acme Pest Control", h1: "Rodent Control", kind: "service", siteName: "Acme Pest Control" })).toBe("Rodent Control");
    expect(importName({ path: "/blog/spring-ants/", title: "Why Ants | Acme", h1: "Why Ants Come Inside in Spring", kind: "article" })).toBe("Why Ants Come Inside in Spring");
    expect(importName({ path: "/about/", title: "About | Harbor", h1: "ABOUT US", menuLabel: "ABOUT US", kind: "about" })).toBe("About Us");
    expect(slugFromPath("/blog/spring-ants/")).toBe("blog/spring-ants");
    expect(importPath("http://WWW.acmepest.example/Ant-Control?x=1#top")).toBe("/ant-control/");
  });
});

describe("the worker's read of the whole site (no AI, no network)", () => {
  it("reads the sitemap's pages (pages first, newest posts next), keeps each page in storage, and lists what it left out", async () => {
    const { id } = await seed();
    const row = await readSite(id);
    expect(row.status).toBe("done");
    expect(row.source).toBe("sitemap");
    const pages = row.pages as ImportedPageSummary[];
    expect(pages.map((p) => p.path)).toEqual(["/", "/about-us/", "/contact/", "/ant-control/", "/rodent-control/", "/pest-control-folsom-ca/", "/pest-control-roseville-ca/", "/specials/", "/blog/", "/blog/spring-ants/", "/blog/winter-mice/"]);
    expect(pages.map((p) => p.kind)).toEqual(["home", "about", "contact", "service", "service", "city", "city", "pricing", "blog", "article", "article"]);
    expect(pages.find((p) => p.path === "/ant-control/")!.name).toBe("Ants");
    expect((row.skipped as { reason: string }[]).map((s) => s.reason)).toEqual(
      expect.arrayContaining(["Replaced: TAWD writes its own privacy policy (/privacy/)", "Replaced: TAWD writes its own cookie policy (/cookies/)", "A feed", "An archive (tag, category or author)", "A file, not a page"]),
    );
    expect(row.failed).toEqual([{ url: `${SITE}/old-page/`, reason: "It answered 404." }]);
    expect(row.brokenLinks).toEqual([{ from: "/ant-control/", to: "/termite-control/", status: 404 }]);
    // The bare address redirected to www; the category and author sitemaps were never asked for.
    expect(asked[0]).toBe("https://acmepest.example/");
    expect(asked).toContain(`${SITE}/`);
    expect(asked.some((u) => /category-sitemap|author-sitemap|privacy-policy|feed/.test(u))).toBe(false);
    // Each kept page is in the project's folder in storage.
    const keys = [...r2.objects.keys()];
    expect(keys.length).toBe(11);
    expect(keys.every((k) => k.startsWith(`projects/${id}/site-import/${row.id}/`))).toBe(true);
    const blog = JSON.parse(r2.objects.get(pages.find((p) => p.kind === "blog")!.key)!.toString("utf8"));
    expect(blog.markdown).toBe("# Our Blog\n\nTips from our technicians.\n\n- [Why Ants Come Inside in Spring](/blog/spring-ants/)\n- [Mice in Winter](/blog/winter-mice/)\n");
  });

  it("stops at the tier's page limit and lists the rest; a makeover keeps its blog articles on top; a site with no sitemap is read from its menu", async () => {
    const { id } = await seed({ tier: "starter", mode: "auto" });
    const row = await readSite(id);
    expect(row.pageLimit).toBe(10);
    expect((row.pages as ImportedPageSummary[]).length).toBe(9);
    expect(row.notImported).toEqual([`${SITE}/blog/spring-ants/`, `${SITE}/blog/winter-mice/`]);

    // A makeover (keep): the articles don't count toward Starter's 10 (0.98.0).
    const keep = await seed({ tier: "starter" });
    const kept = await readSite(keep.id);
    expect(kept.pageLimit).toBe(10);
    expect((kept.pages as ImportedPageSummary[]).filter((p) => p.kind === "article").map((p) => p.path).sort()).toEqual(["/blog/spring-ants/", "/blog/winter-mice/"]);
    expect(kept.notImported).toEqual([]);
    // Content says so; the plan's count and tier warning leave the kept articles out.
    const content = renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id: keep.id }) } as never)) as React.ReactElement);
    expect(content).toContain("1 blog article kept on top of Starter&#x27;s 10 pages: a makeover&#x27;s articles don&#x27;t count toward the limit (up to 100).");
    expect(content).toContain("9 pages and 2 kept blog articles; Starter covers up to 10 pages (a makeover&#x27;s articles don&#x27;t count, up to 100).");
    expect(content).not.toMatch(/Remove \d+ or|Remove \d+, or/);

    // Changed to keep after a read that left articles out: it reads again by itself.
    const before = queued.length;
    await saveIntakeSection(h.ctx, seededAdmin!.viewer, id, "content", { mode: "keep" });
    await syncKeepChoice(h.ctx, id);
    expect(queued.length).toBe(before + 1);
    await runSiteReadJob(queued.at(-1)!.data);
    const [again] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
    expect(again!.notImported).toEqual([]);

    const other = await seed();
    setSiteReadStandInsForTesting({ fetch: siteFetch([], { [`${SITE}/robots.txt`]: { status: 404, type: "text/plain", body: "" }, [`${SITE}/sitemap_index.xml`]: { status: 404, type: "text/html", body: "" } }), wait: async () => undefined, look: testLook });
    const fromMenu = await readSite(other.id);
    expect(fromMenu.source).toBe("menu");
    expect((fromMenu.pages as ImportedPageSummary[]).map((p) => p.path)).toEqual(["/", "/about-us/", "/ant-control/", "/rodent-control/", "/pest-control-folsom-ca/", "/specials/", "/blog/", "/contact/"]);
  });

  it("never opens a private address, follows redirects only to public ones, and refuses a page over the size limit", async () => {
    setLookupForTesting(async () => ["10.0.0.5"]);
    expect(await politeFetch(`${SITE}/`)).toBeNull();
    const { id } = await seed();
    const row = await readSite(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toMatch(/couldn't be opened/);
    expect(asked).toEqual([]);

    // A redirect to a private address isn't followed.
    setLookupForTesting(async (host: string) => (host === "internal.example" ? ["192.168.1.2"] : ["93.184.216.34"]));
    setSiteReadStandInsForTesting({ fetch: siteFetch(asked, { [`${SITE}/go/`]: { status: 302, type: "text/html", body: "", location: "http://internal.example/admin" } }), wait: async () => undefined, look: testLook });
    expect(await politeFetch(`${SITE}/go/`)).toBeNull();
    expect(asked).not.toContain("http://internal.example/admin");

    setSiteReadStandInsForTesting({ fetch: siteFetch([], { [`${SITE}/huge/`]: { status: 200, type: "text/html", body: "x".repeat(IMPORT_MAX_BYTES + 10) } }), wait: async () => undefined, look: testLook });
    expect(await politeFetch(`${SITE}/huge/`)).toBeNull();
  });
});

describe("the page plan and the kept copy", () => {
  it("starts by itself for every content choice with a website; reading again is for PMs, SEO and Content", async () => {
    const { admin, id } = await seed({ mode: "auto" });
    await syncSiteRead(h.ctx, id);
    expect(queued.map((q) => q.name)).toEqual([SITE_READ_JOB]);
    // The same address isn't read twice by itself.
    await syncSiteRead(h.ctx, id);
    expect(queued).toHaveLength(1);
    const designer = await seedUser(h, admin.viewer, { email: "designer@velocitymedialab.com", roles: ["web_designer"] });
    await expect(readSiteAgain(h.ctx, designer.viewer, id)).rejects.toThrow(/Not allowed/);
    await expect(readSiteAgain(h.ctx, admin.viewer, id)).rejects.toThrow(/being read now/);
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(readSiteAgain(h.ctx, seo.viewer, id)).rejects.toThrow(/being read now/);
    const started = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.site_import_started")));
    expect(started).toHaveLength(1);
  });

  it("Keep all content as is: the plan makes itself when the read finishes, at the same addresses, each page's words as version 1, logged as TAWD", async () => {
    const { admin, id } = await seed();
    await readSite(id);
    const plan = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    expect(plan.map((p) => p.slug)).toEqual(["", "about-us", "contact", "ant-control", "rodent-control", "pest-control-folsom-ca", "pest-control-roseville-ca", "specials", "blog", "blog/spring-ants", "blog/winter-mice"]);
    expect(plan.find((p) => p.slug === "blog/spring-ants")).toMatchObject({ kind: "article", parentSlug: "blog", name: "Why Ants Come Inside in Spring" });
    expect(plan.find((p) => p.slug === "ant-control")).toMatchObject({ kind: "service", h1: "Ant Control in Folsom", mainKeyword: "", title: "Ant Control In Folsom, CA - Fast, Pet-Safe Ant Treatments by Acme Pest Control" });
    const drafts = await h.db.select().from(pageDraft).where(eq(pageDraft.projectId, id));
    expect(drafts).toHaveLength(11);
    expect(drafts.every((d) => d.source === "kept" && d.version === 1 && d.status === "done" && !d.approvedAt && d.createdByUserId === null)).toBe(true);
    expect(drafts.find((d) => d.pageId === plan[3]!.id)!.note).toMatch(/^From the current site \(kept as is\): https:\/\/www\.acmepest\.example\/ant-control\//);
    const [logged] = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.site_import_used")));
    expect((logged!.valueAfter as { pages: string[]; auto: boolean }).pages).toHaveLength(11);
    expect((logged!.valueAfter as { auto: boolean }).auto).toBe(true);
    expect(logged!.actorUserId).toBeNull();
    const view = await loadSiteRead(h.db as Database, id);
    expect(view.read!.inPlan).toBe(true);
    expect(view.read!.usedByUserId).toBeNull();

    // The team can still edit a kept article's address; its folder stays.
    await savePlanPage(h.ctx, admin.viewer, id, plan[9]!.id, { kind: "article", name: "Spring ants", slug: "blog/Spring Ants!", mainKeyword: "", supportingKeywords: "", title: "t", metaDescription: "m", h1: "h" });
    const [edited] = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.id, plan[9]!.id));
    expect(edited!.slug).toBe("blog/spring-ants");
  });

  it("Approve all kept pages: Content only, one recorded approval per page, never an edited page or one with open comments", async () => {
    const { admin, id } = await seed();
    await readSite(id);
    const plan = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    await saveDraftEdit(h.ctx, admin.viewer, id, plan[1]!.id, "# About Acme Pest Control\n\nZack started Acme in 2012.");
    await h.db.insert(pageComment).values({ projectId: id, pageId: plan[2]!.id, version: 1, body: "Check the email address" });
    expect(await countKeptWaiting(h.db as Database, id)).toBe(9);

    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(approveKeptPages(h.ctx, pm.viewer, id)).rejects.toThrow(/Not allowed/);
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    expect(await approveKeptPages(h.ctx, content.viewer, id)).toBe(9);
    const approvals = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.page_approved")));
    expect(approvals).toHaveLength(9);
    expect(approvals.every((a) => a.actorUserId === content.viewer.id && (a.valueAfter as { kept: boolean }).kept)).toBe(true);
    const drafts = await h.db.select().from(pageDraft).where(eq(pageDraft.projectId, id));
    expect(drafts.filter((d) => d.approvedAt)).toHaveLength(9);
    await expect(approveKeptPages(h.ctx, content.viewer, id)).rejects.toThrow(/No kept page/);
  });

  it("the Content screen shows the pages and the suggestions; on Design only the kept pages need no approval (0.100.0)", async () => {
    const { id } = await seed();
    await readSite(id);
    const render = async () => renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);
    const html = await render();
    expect(html).toContain("Current site’s pages");
    expect(html).toContain("11 pages read from https://acmepest.example (its sitemap)");
    // No button between screens: the plan made itself.
    expect(html).not.toContain("Use these pages");
    expect(html).not.toContain("Use the current site&#x27;s pages");
    expect(html).not.toContain("Make the page plan");
    expect(html).toContain("Current site: SEO suggestions");
    expect(html).toContain("Pages that are mostly the same words");
    expect(html).toContain("What TAWD does better automatically");
    expect(html).toMatch(/In the page plan since [A-Z][a-z]{2} \d+, \d{4}, \d+:\d{2} [AP]M PT \(TAWD, automatically\)/);
    expect(html).toContain("Kept as is");
    expect(html).not.toContain("Approve all kept pages");
  });

  it("deleting the project removes the kept pages from storage, and the read with it", async () => {
    const { admin, id } = await seed();
    const row = await readSite(id);
    expect([...r2.objects.keys()].some((k) => k.includes("/site-import/"))).toBe(true);
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Acme Pest Control", reason: "Test project, removing it" });
    expect([...r2.objects.keys()].some((k) => k.includes(`projects/${id}/`))).toBe(false);
    expect(await h.db.select().from(siteImport).where(eq(siteImport.id, row.id))).toEqual([]);
  });
});

describe("the build keeps the words", () => {
  const plan = [
    { name: "Home", kind: "home", slug: "" },
    { name: "Ants", kind: "service", slug: "ant-control" },
  ];

  it("a kept page's prompt carries the keep rule; any other page's prompt is unchanged", () => {
    const kept = buildPagePrompt({ page: plan[1]!, copy: "# Ants\n\nWords.", pages: plan, isHome: false, kept: { hadForm: true } });
    expect(kept).toContain(KEPT_COPY_RULE);
    expect(KEPT_COPY_RULE).toMatch(/Use every word exactly as written and in the same order/);
    expect(KEPT_COPY_RULE).toMatch(/phone number, price/);
    expect(KEPT_COPY_RULE).toMatch(/Add nothing/);
    expect(kept).toContain("The current page had a contact form");
    const plain = buildPagePrompt({ page: plan[1]!, copy: "# Ants\n\nWords.", pages: plan, isHome: false });
    expect(plain).not.toContain("Kept words");
    expect(plain).toContain("Pages on the site, for links: Home /, Ants /ant-control/.\n\nThe approved copy");
  });

  it("a big site's menu is grouped by code; a small site's stays the plain list", () => {
    expect(buildPartsPrompt(plan, "Acme")).toContain("The header's menu links to these pages, in this order, with these paths: Home (/), Ants (/ant-control/).");
    const big = [
      { name: "Home", kind: "home", slug: "" },
      { name: "About Us", kind: "about", slug: "about-us" },
      ...["ants", "rodents", "spiders"].map((s) => ({ name: s, kind: "service", slug: `${s}-control` })),
      ...["folsom", "roseville"].map((c) => ({ name: c, kind: "city", slug: `pest-control-${c}-ca` })),
      { name: "Specials", kind: "pricing", slug: "specials" },
      { name: "Partners", kind: "other", slug: "partners" },
      { name: "Blog", kind: "blog", slug: "blog" },
      { name: "Spring ants", kind: "article", slug: "blog/spring-ants" },
      { name: "Contact Us", kind: "contact", slug: "contact" },
    ];
    expect(needsGroupedMenu(big)).toBe(true);
    const menu = menuPlan(big);
    expect(menu.header.map((m) => m.name)).toEqual(["Home", "About Us", "Services", "Service areas", "Specials", "Blog", "Contact Us"]);
    expect(menu.header[2]!.children.map((c) => c.path)).toEqual(["/ants-control/", "/rodents-control/", "/spiders-control/"]);
    expect(menu.footerOnly).toEqual([{ name: "Partners", path: "/partners/" }]);
    const prompt = buildPartsPrompt(big, "Acme");
    expect(prompt).toContain("Services: a dropdown with ants (/ants-control/)");
    expect(prompt).toContain("<details>");
    expect(prompt).not.toContain("/blog/spring-ants/");
    // An article's prompt lists the site's pages without the other articles.
    expect(buildPagePrompt({ page: big[10]!, copy: "# A", pages: big, isHome: false })).toContain("Spring ants /blog/spring-ants/");
  });

  it("Astro builds a page in a folder with the right layout path", () => {
    const files = astroProject({ clientName: "Acme", design: { css: "", fontLinks: [], header: "", footer: "", sections: [] }, parts: { header: "<header></header>", footer: "<footer></footer>" }, pages: [{ page: { name: "Spring", kind: "article", slug: "blog/spring-ants" }, title: "t", metaDescription: "m", main: "<main><h1>A</h1></main>" }, { page: { name: "Ants", kind: "service", slug: "ant-control" }, title: "t", metaDescription: "m", main: "<main><h1>B</h1></main>" }], images: [] });
    expect(files.get("src/pages/blog/spring-ants.astro")).toContain('import Site from "../../layouts/Site.astro";');
    expect(files.get("src/pages/ant-control.astro")).toContain('import Site from "../layouts/Site.astro";');
  });

  it("the words check finds a missing or reworded sentence, and passes the same words in another layout", () => {
    const copy = "# Ant Control in Folsom\n\nAnts come inside looking for water and food. We find the nest and treat it.\n\n| Plan | Price |\n| One visit | $150 |\n\n- Pet-safe treatments\n\nSee [rodent control](/rodent-control/).";
    const same = `<main><section class="hero"><h1>Ant Control in Folsom</h1></section><div class="cols"><p>Ants come inside looking for water and food.</p><p>We find the nest and treat it.</p></div><table><tr><td>Plan</td><td>Price</td></tr><tr><td>One visit</td><td>$150</td></tr></table><ul><li>Pet&#8209;safe treatments</li></ul><p>See <a href="/rodent-control/">rodent control</a>.</p><a class="btn" href="tel:1">Call now</a></main>`;
    expect(keptWordsCheck(same.replace("&#8209;", "-"), copy)).toEqual({ total: 9, missing: [] });
    const changed = same.replace("We find the nest and treat it.", "We locate the nest and treat it fast.").replace("$150", "$140");
    expect(keptWordsCheck(changed, copy).missing).toEqual(["We find the nest and treat it.", "$150"]);
    // An invisible zero-width space in the old heading (seen on Harbor's blog) doesn't count as a change.
    expect(keptWordsCheck("<main><h1>How Often Should You Do Pest Control?</h1></main>", "# How Often Should You Do Pest Control​?").missing).toEqual([]);
  });
});

describe("SEO suggestions on the kept pages (code, free, suggestions only)", () => {
  it("finds what TAWD's own rules would flag on the saved site", async () => {
    const { id } = await seed();
    await readSite(id);
    const view = await loadSiteRead(h.db as Database, id);
    const groups = new Map(view.read!.suggestions.map((g) => [g.key, g]));
    const pages = (key: string) => groups.get(key)?.items.map((i) => i.page) ?? [];
    expect(pages("title-long")).toEqual(["/ant-control/"]);
    expect(pages("meta-missing")).toEqual(["/contact/"]);
    expect(pages("meta-duplicate")).toEqual(["/", "/ant-control/"]);
    expect(pages("h1-missing")).toEqual(["/specials/"]);
    expect(pages("h1-multiple")).toEqual(["/ant-control/"]);
    expect(pages("heading-order")).toEqual(expect.arrayContaining(["/ant-control/"]));
    expect(groups.get("alt")!.items).toEqual([{ page: "/ant-control/", found: "1 with no alt text, 1 with a file name as alt text (of 2)" }]);
    expect(pages("similar")).toEqual(["/pest-control-folsom-ca/", "/pest-control-roseville-ca/"]);
    // No "pages nothing links to" since 0.99.0: the new site links every kept page.
    expect(groups.has("orphan")).toBe(false);
    expect(groups.get("broken")!.items).toEqual([{ page: "/ant-control/", found: "Links to /termite-control/, which answers 404" }]);
    expect(groups.get("canonical")!.items).toEqual([
      { page: "/rodent-control/", found: "No canonical tag." },
      { page: "/specials/", found: `Points at ${SITE}/` },
    ]);
    expect(pages("noindex")).toEqual(["/pest-control-roseville-ca/"]);
    expect(pages("mixed")).toEqual(["/ant-control/"]);
    expect(groups.get("nap-phone")!.items).toEqual([{ page: "/ant-control/", found: "(916) 555-0199 (the intake has (916) 555-0142)" }]);
    expect(groups.get("schema-rating")!.items[0]!.found).toMatch(/AggregateRating on 10 of 10 pages/);
    expect(pages("thin")).toEqual(expect.arrayContaining(["/rodent-control/"]));
    expect(groups.has("schema-home")).toBe(false);
    // Most important first; every group says why and what TAWD would do.
    const order = view.read!.suggestions.map((g) => g.importance);
    expect(order).toEqual([...order].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    expect(view.read!.suggestions.every((g) => g.why && g.would)).toBe(true);
    expect(view.read!.better.length).toBeGreaterThan(3);
  });

  it("each rule on its own", () => {
    const base: ImportedPageSummary = { path: "/", url: `${SITE}/`, kind: "home", name: "Home", title: "Acme Pest Control | Folsom", metaDescription: "x".repeat(100), canonical: `${SITE}/`, robots: "", h1s: ["Pest control in Folsom"], headings: [{ level: 1, text: "Pest control in Folsom" }], wordCount: 500, images: 0, imagesNoAlt: 0, imagesFileAlt: 0, internalLinks: [], httpLinks: 0, hasForm: false, reviewWidgets: 0, schemaTypes: ["LocalBusiness"], phones: [], mixedContent: 0, similar: null, notes: [], key: "k" };
    const run = (pages: ImportedPageSummary[], extra: Partial<Parameters<typeof currentSiteSuggestions>[0]> = {}) =>
      new Map(currentSiteSuggestions({ pages, brokenLinks: [], notImported: [], facts: { name: "Acme Pest Control", phone: "916-555-0142", city: "Folsom", cities: ["Roseville, CA"], services: [] }, ...extra }).map((g) => [g.key, g.items]));
    expect(run([base]).size).toBe(0);
    expect(run([{ ...base, title: "" }]).get("title-missing")).toHaveLength(1);
    expect(run([base, { ...base, path: "/a/", url: `${SITE}/a/`, kind: "service", name: "Ant control" }]).get("title-duplicate")).toHaveLength(2);
    expect(run([{ ...base, path: "/ants/", url: `${SITE}/ants/`, kind: "service", name: "Ants", title: "Ants | Acme Pest Control" }]).get("title-city")).toHaveLength(1);
    expect(run([{ ...base, path: "/ants/", url: `${SITE}/ants/`, kind: "service", name: "Ants", title: "Best in Folsom" }]).get("title-service")).toHaveLength(1);
    expect(run([{ ...base, metaDescription: "short" }]).get("meta-length")).toHaveLength(1);
    expect(run([{ ...base, path: "/about/", url: `${SITE}/about/`, kind: "about", name: "About", title: "About Acme Pest Control", h1s: ["Our trucks"] }]).get("h1-topic")).toHaveLength(1);
    expect(run([{ ...base, path: "/homepage/", url: `${SITE}/homepage/`, kind: "other" }]).get("second-home")).toHaveLength(1);
    expect(run([base], { notImported: [`${SITE}/old/`] }).get("not-carried")).toBeUndefined();
    expect(run([{ ...base, internalLinks: ["/old/"] }], { notImported: [`${SITE}/old/`] }).get("not-carried")).toEqual([{ page: "/", found: "Links to /old/" }]);
    expect(run([{ ...base, schemaTypes: [] }]).get("schema-home")).toHaveLength(1);
    expect(run([{ ...base, path: "/ants/", url: `${SITE}/ants/`, kind: "service", name: "Ants", title: "Ants in Folsom", schemaTypes: [] }]).get("schema-service")).toHaveLength(1);
    expect(run([{ ...base, reviewWidgets: 2 }]).get("reviews")).toHaveLength(1);
    expect(run([{ ...base, title: "Pest Control | Folsom", h1s: ["Pest control"] }]).get("nap-name")).toHaveLength(1);
    expect(run([{ ...base, canonical: "http://www.acmepest.example/" }]).get("canonical")).toEqual([{ page: "/", found: "Uses http:// (http://www.acmepest.example/)" }]);
    // 0.99.0, from Harbor's read. Jina's reads before then removed link tags: no canonical there is unknown, not missing; a new read sees it.
    expect(run([{ ...base, canonical: null, readFrom: "fallback", via: "jina" }]).get("canonical")).toBeUndefined();
    expect(run([{ ...base, canonical: null, readFrom: "fallback", via: "jina", canonicalSeen: true }]).get("canonical")).toHaveLength(1);
    expect(run([{ ...base, canonical: null }]).get("canonical")).toHaveLength(1);
    // A city page whose title names its own place, though the intake doesn't list it.
    const elDorado = { ...base, path: "/pest-control-el-dorado-hills-ca/", url: `${SITE}/pest-control-el-dorado-hills-ca/`, kind: "city" as const, name: "El Dorado Hills" };
    expect(run([{ ...elDorado, title: "Pest Control El Dorado Hills | Expert Pest Control Solutions" }]).get("title-city")).toBeUndefined();
    expect(run([{ ...elDorado, title: "Expert Pest Control Solutions" }]).get("title-city")).toHaveLength(1);
    // A page about media mentions isn't a service page, whatever its address says.
    expect(run([{ ...base, path: "/public-highlights-pest-control/", url: `${SITE}/public-highlights-pest-control/`, kind: "service", name: "Highlights", title: "Trusted & Featured in the Media" }]).get("title-city")).toBeUndefined();
    expect(pagePlace("/pest-control-el-dorado-hills-ca/")).toBe("el dorado hills");
    expect(pagePlace("/roseville-pest-control/")).toBe("roseville");
    expect(pagePlace("/pest-control/")).toBeNull();
    expect(importKind({ path: "/public-highlights-pest-control/", title: "", h1: "" })).toBe("other");
    expect(importKind({ path: "/trusted-local-business-partners-we-recommend/", title: "", h1: "" })).toBe("other");
    expect(importKind({ path: "/rodent-control/", title: "", h1: "" })).toBe("service");
    expect(textSimilarity("one two three four five six seven", "one two three four five six seven")).toBe(1);
  });
});

/* ---------- 6 October 2026: blocked sites, and makeovers without the Home words step ---------- */

const SITEGROUND_CHECK = `<!DOCTYPE html><html><head><title>One moment, please...</title><meta name="robots" content="noindex"><script>var sgchallenge="x";window.location.href="/.well-known/sgcaptcha/?r=%2F";</script></head><body><h1>Please wait while your request is being verified...</h1></body></html>`;

describe("a site that shows TAWD a bot check (Harbor Pest Control's host)", () => {
  it("spots the known checks and bare refusals, and never a real page that mentions them", () => {
    expect(botCheck({ status: 202, text: SITEGROUND_CHECK })).toMatchObject({ kind: "check", said: "One moment, please..." });
    expect(botCheck({ status: 403, text: "<title>Just a moment...</title><div id=cf-chl-widget></div>" })).toMatchObject({ kind: "check" });
    expect(botCheck({ status: 403, text: "<title>Sucuri WebSite Firewall - Access Denied</title><h1>Access Denied</h1>" })).toMatchObject({ kind: "check" });
    expect(botCheck({ status: 503, text: "<title>Maintenance</title><p>Back soon.</p>" })).toMatchObject({ kind: "refused", status: 503 });
    // A real page saying "please wait" or "verified" is long: never a check.
    const real = `<title>Acme</title><h1>Verified pest experts</h1><p>${"We are licensed and verified. One moment, please, while we tell you about our ant service. ".repeat(40)}</p>`;
    expect(botCheck({ status: 200, text: real })).toBeNull();
    expect(botCheck({ status: 200, text: PAGES["/"]! })).toBeNull();
    // Cloudflare's script on every page of a site isn't a check: a short real page with it passes.
    const contact = `<title>Contact</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><h1>Contact us</h1><p>${"Call us any time for a free quote on ant and rodent control in Folsom. ".repeat(5)}</p>`;
    expect(botCheck({ status: 200, text: contact })).toBeNull();
    expect(botCheckMessage("https://harborpest.com/", botCheck({ status: 202, text: SITEGROUND_CHECK })!)).toBe('harborpest.com showed TAWD a bot check ("One moment, please...") instead of its pages, so nothing was read.');
    expect(botCheckMessage("https://harborpest.com/", botCheck({ status: 503, text: "" })!)).toBe("harborpest.com refused or blocked TAWD's server (503), so nothing was read.");
  });

  it("blocked, and no route yet: the read fails with the plain reason, nothing is kept, and Content shows the ways forward that work, never \"later\"", async () => {
    setSiteReadStandInsForTesting({ fetch: siteFetch(asked, { [`${SITE}/`]: { status: 200, type: "text/html", body: SITEGROUND_CHECK } }), wait: async () => undefined, look: testLook });
    const { admin, id } = await seed();
    const row = await readSite(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toBe('acmepest.example blocks TAWD\'s server (it showed a bot check, "One moment, please..."), so its pages can\'t be read from here. Reading again won\'t change that.');
    expect(row.pages).toEqual([]);
    // Only the home page was asked: the browser never opened a blocked site.
    expect(asked).toEqual(["https://acmepest.example/", `${SITE}/`]);
    await expect(replacePlanWithSite(h.ctx, admin.viewer, id)).rejects.toThrow(/haven't been read yet/);
    const html = renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);
    expect(html).toContain("blocks TAWD&#x27;s server");
    expect(html).not.toMatch(/later/i);
    expect(html).not.toContain("203.0.113.10");
    expect(html).not.toContain("Read again: the site didn");
    expect(html).toContain("Paste the words: choose the project type “The client is sending their own words” in the intake&#x27;s Content section.");
    expect(html).toContain("Let TAWD write new words: choose the project type “Everything new” in the intake&#x27;s Content section.");
    expect(html).toContain(`/projects/${id}/intake?section=website`);
  });

  it("a redirect to a private address is never followed", async () => {
    setLookupForTesting(async (host: string) => (host === "internal.example" ? ["10.1.2.3"] : ["93.184.216.34"]));
    const seen: string[] = [];
    const request: Requester = async (url) => {
      seen.push(url);
      return { status: 302, header: (n) => (n === "location" ? "http://internal.example/admin" : null), body: async () => "" };
    };
    expect(await followPolitely(`${SITE}/go/`, request)).toBeNull();
    expect(seen).toEqual([`${SITE}/go/`]);
  });

  it("a read saved before this (the check kept as a one-page site) shows as failed and can't be used", async () => {
    const { admin, id } = await seed();
    await h.db.insert(siteImport).values({
      projectId: id,
      url: "https://acmepest.example",
      pageLimit: 50,
      status: "done",
      source: "menu",
      pages: [{ path: "/", url: `${SITE}/`, kind: "home", name: "Home", title: "One moment, please...", metaDescription: "", canonical: null, robots: "", h1s: [], headings: [{ level: 1, text: "One moment, please..." }], wordCount: 8 } as unknown as ImportedPageSummary],
      requests: 5,
    });
    const panel = await loadSiteRead(h.db as Database, id);
    expect(panel.read).toMatchObject({ status: "failed", pages: [], blocked: true });
    expect(panel.read!.failure).toMatch(/showed TAWD a bot check/);
    await expect(replacePlanWithSite(h.ctx, admin.viewer, id)).rejects.toThrow(/bot check.*Read again/);
    // No plan is made from it.
    expect(await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id))).toEqual([]);
  });
});

describe("a makeover's Home page words come from Content (no Home words step)", () => {
  it("splits the kept Home page at its headings; quotes wait to be confirmed; a long page's tail joins the last section", () => {
    const words = homeWordsFromKeptPage(
      "# Family-Owned Pest Control in Folsom\n\nWe have protected Folsom homes since 2012. See our [ant control](/ant-control/).\n\n## Why choose us\n\n- Licensed\n- Pet-safe\n\n#### Small print\n\nTerms apply.\n\n> They came the same day and the ants were gone.\n\n## What our customers say\n\nBest service in town, friendly and on time.\n",
    );
    expect(words.source).toBe("current_site");
    expect(words.sections).toEqual([
      { name: "Hero", words: "Family-Owned Pest Control in Folsom\nWe have protected Folsom homes since 2012. See our ant control." },
      { name: "Why choose us", words: "- Licensed\n- Pet-safe\nSmall print\nTerms apply." },
    ]);
    expect(words.testimonials).toEqual([
      { text: "They came the same day and the ants were gone.", confirmed: false },
      { text: "Best service in town, friendly and on time.", confirmed: false },
    ]);
    const long = homeWordsFromKeptPage(Array.from({ length: 25 }, (_, i) => `## Part ${i + 1}\n\nWords ${i + 1}.`).join("\n\n"));
    expect(long.sections).toHaveLength(MAX_HOME_SECTIONS);
    expect(long.sections.at(-1)!.words).toContain("Part 25\nWords 25.");
  });

  it("Generate waits only while the site is read; then the concepts use the Home page on Content, edits included; the old step is refused", async () => {
    const { admin, id } = await seed();
    expect(await homeWordsBlocked(h.db as Database, id)).toMatch(/couldn't be read/);
    expect((await keptHomeWords(h.db as Database, id))?.state).toBe("failed");
    await syncSiteRead(h.ctx, id);
    expect((await keptHomeWords(h.db as Database, id))?.state).toBe("reading");
    expect(await homeWordsBlocked(h.db as Database, id)).toMatch(/still reading/);
    await runSiteReadJob(queued.at(-1)!.data);
    expect(await homeWordsBlocked(h.db as Database, id)).toBeNull();
    let words = await approvedHomeWords(h.db as Database, id);
    expect(words!.sections[0]).toMatchObject({ name: "Hero" });
    expect(words!.sections[0]!.words).toContain("Family-Owned Pest Control in Folsom");

    const [home] = await h.db.select().from(pagePlanPage).where(and(eq(pagePlanPage.projectId, id), eq(pagePlanPage.kind, "home")));
    await saveDraftEdit(h.ctx, admin.viewer, id, home!.id, "# Pest Control in Folsom, Done Right\n\nSame-day visits.");
    words = await approvedHomeWords(h.db as Database, id);
    expect(words!.sections).toEqual([{ name: "Hero", words: "Pest Control in Folsom, Done Right\nSame-day visits." }]);
    expect((await keptHomeWords(h.db as Database, id))?.version).toBe(2);

    await expect(startHomeWords(h.ctx, admin.viewer, id, "current_site")).rejects.toThrow(/Home page on Content/);
    await expect(writeHomeWords(h.ctx, admin.viewer, id)).rejects.toThrow(/Home page on Content/);
  });

  it("the Design card: read only, says where to edit; a failed read shows its date in PT, the reason, the ways forward and the intake link; no Go to Content", async () => {
    const { id } = await seed();
    const card = (props: Partial<KeptHomeWordsCardProps>) =>
      renderToStaticMarkup(<KeptHomeWordsCard state="reading" failure={null} intakeHref={`/projects/${id}/intake?section=website`} contentHref={`/projects/${id}/content`} versionLine={null} sections={[]} quotes={[]} {...props} />);
    expect(card({})).toContain("TAWD is reading the current site");
    const failed = card({ state: "failed", failure: "harborpest.com blocks TAWD's server", readAtLine: "Read Oct 7, 2026, 3:20 PM PT.", waysForward: ["Paste the words: x"] });
    expect(failed).toContain("harborpest.com blocks TAWD&#x27;s server Read Oct 7, 2026, 3:20 PM PT.");
    expect(failed).toContain("Paste the words: x");
    expect(failed).toContain("Open the intake’s Website section");
    expect(failed).not.toContain("Go to Content");
    expect(card({ state: "needs_decision", decisionLine: "This deletes 4 approved pages." })).toContain("This deletes 4 approved pages.");
    await readSite(id);
    const panel = await loadHomeWords(h.db as Database, id);
    expect(panel.kept?.state).toBe("ready");
    const html = card({ state: "ready", versionLine: "From the Home page on Content, version 1.", sections: panel.kept!.words!.sections.map((s) => ({ ...s, flag: null })), quotes: ["They came the same day."] });
    expect(html).toContain("Kept from the current site");
    expect(html).toContain("To change them, edit the Home page on");
    expect(html).toContain("See the words");
    expect(html).toContain("Quotes to confirm with the client");
    expect(html).not.toContain("Use these words");
    expect(html).not.toContain("<textarea");
  });

  it("a new site or the client's copy keeps the Home words step as it was", async () => {
    const { admin, id } = await seed({ mode: "auto" });
    expect(await keptHomeWords(h.db as Database, id)).toBeNull();
    expect((await loadHomeWords(h.db as Database, id)).kept).toBeNull();
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "manual", suppliedCopy: "Welcome\nWe kill ants." });
    expect(await keptHomeWords(h.db as Database, id)).toBeNull();
  });
});
