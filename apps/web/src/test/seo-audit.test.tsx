import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { and, eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataForSeoAnswer, dataForSeoResult } from "./service-answers";

/*
  SEO audits of the client's current website (26 September 2026): the free
  "Don't lose it" check and the full audit (a paid add-on). The client's
  site, DataForSEO, PageSpeed and Claude are all stand-ins.
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
import { projectAddon, seoAudit, seoDataCall, siteImport } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { SEO_AUDIT_JOB } from "@tawd/core/queue";
import { stemOf } from "@tawd/core/site";
import { auditBand, leftOutUrls, mergeRedirects, netlifyRedirectsFile, parseSitemap, pathOf, redirectMap, type RedirectRow } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { makePagePlan, setDataForSeoFetchForTesting } from "@/lib/seo-data";
import { setQueueForTesting } from "@/lib/mockups";
import { addFullAudit, countSitePages, loadAudits, saveRedirect, setAuditStandInsForTesting, settleAudits, startFullAudit, startQuickCheck, unpacked } from "@/lib/seo-audit";

import { runSeoAuditJob } from "../../../worker/src/seo-audit-report";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeClaude } from "./worker-fakes";

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

const SITE: Record<string, string> = {
  "https://oldsite.example/robots.txt": "User-agent: *\nSitemap: https://oldsite.example/sitemap_index.xml",
  "https://oldsite.example/sitemap_index.xml": `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://oldsite.example/page-sitemap.xml</loc></sitemap></sitemapindex>`,
  "https://oldsite.example/page-sitemap.xml": `<?xml version="1.0"?><urlset>${["/", "/drain-cleaning-sacramento/", "/about-us/", "/emergency-plumber/", "/blog/winter-pipes/"].map((p) => `<url><loc>https://oldsite.example${p}</loc></url>`).join("")}</urlset>`,
};

let dataCalls: string[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  dataCalls = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as never }), getJob: async () => null });
  vi.stubEnv("DATAFORSEO_LOGIN", "sandbox-login");
  vi.stubEnv("DATAFORSEO_PASSWORD", "sandbox-password");
  vi.stubEnv("DATAFORSEO_LIVE", "");
  setAuditStandInsForTesting({
    lookup: async () => ["93.184.216.34"],
    site: (async (url: string) => (SITE[url] ? new Response(SITE[url]) : new Response("", { status: 404 }))) as typeof fetch,
    pageSpeed: (async () => Response.json({ lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { "largest-contentful-paint": { displayValue: "4.8 s" } } } })) as typeof fetch,
    wait: async () => undefined,
  });
  let summaries = 0;
  setDataForSeoFetchForTesting((async (url: string) => {
    const endpoint = url.split("/v3/")[1]!;
    dataCalls.push(endpoint.replace(/summary\/.+$/, "summary/:id"));
    // Every answer goes through service-answers.ts, which refuses a status DataForSEO has never been recorded as sending.
    const ok = (result: unknown[], extra: Record<string, unknown> = {}) => dataForSeoResult(endpoint, result, extra);
    if (endpoint.includes("ranked_keywords")) {
      return ok([
        {
          items: [
            { keyword_data: { keyword: "drain cleaning sacramento", keyword_info: { search_volume: 880 } }, ranked_serp_element: { serp_item: { url: "https://oldsite.example/drain-cleaning-sacramento/", rank_absolute: 4, etv: 120 } } },
            { keyword_data: { keyword: "emergency plumber sacramento", keyword_info: { search_volume: 1300 } }, ranked_serp_element: { serp_item: { url: "https://oldsite.example/emergency-plumber/", rank_absolute: 9, etv: 60 } } },
          ],
        },
      ]);
    }
    /*
      The live service answers a queued crawl with task status 20100,
      "Task Created." — never 20000 (9 November 2026: the stand-in used to
      answer 20000 here, so the suite passed while every real audit failed).
    */
    if (endpoint.includes("on_page/task_post")) {
      return dataForSeoAnswer(endpoint, { status_code: 20100, status_message: "Task Created.", id: "task-123" });
    }
    if (endpoint.includes("on_page/summary")) {
      summaries += 1;
      return ok([{ crawl_progress: summaries > 1 ? "finished" : "in_progress", crawl_status: { pages_crawled: 3 }, page_metrics: { onpage_score: 71, checks: { no_description: 2 } } }]);
    }
    if (endpoint.includes("on_page/pages")) return ok([{ items: [{ url: "https://oldsite.example/about-us/", status_code: 200, onpage_score: 60, meta: { title: "About" }, checks: { no_description: true, is_https: true } }] }]);
    return ok([]);
  }) as typeof fetch);
});

afterEach(async () => {
  setAuditStandInsForTesting(null);
  setDataForSeoFetchForTesting(null);
  setQueueForTesting(null);
  vi.unstubAllEnvs();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function projectWithSite() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Sacramento Drain Pros", trade: "plumbing", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "content", memberUserIds: [] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sacramento Drain Pros", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "Drain cleaning", description: "" }], mainServiceId: "s1" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento"] });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://oldsite.example" });
  await makePagePlan(h.ctx, admin.viewer, id);
  return { admin, id };
}

describe("the rules", () => {
  it("reads sitemaps and sitemap indexes, and prices by size in bands of 20", () => {
    expect(parseSitemap(SITE["https://oldsite.example/sitemap_index.xml"]!)).toEqual({ urls: [], sitemaps: ["https://oldsite.example/page-sitemap.xml"] });
    expect(parseSitemap(SITE["https://oldsite.example/page-sitemap.xml"]!).urls).toHaveLength(5);
    expect([1, 20, 21, 40, 41, 100, 101].map(auditBand)).toEqual(["seo_audit_20", "seo_audit_20", "seo_audit_40", "seo_audit_40", "seo_audit_60", "seo_audit_100", "seo_audit_quote"]);
    expect(pathOf("https://x.com/a/b?x=1")).toBe("/a/b/");
    expect(pathOf("https://x.com/file.html")).toBe("/file.html");
  });

  it("sends each old address to the planned page it shares words with, or to nobody (never home), and flags pages that bring traffic with no home", () => {
    const rows = redirectMap(
      [{ url: "https://o.example/drain-cleaning-sacramento/" }, { url: "https://o.example/emergency-plumber/" }, { url: "https://o.example/drain-cleaning/" }, { url: "https://o.example/" }],
      [{ url: "https://o.example/emergency-plumber/", keywords: 3, bestPosition: 9, traffic: 60, topKeyword: "emergency plumber sacramento" }],
      [
        { name: "Home", slug: "", mainKeyword: "plumber sacramento" },
        { name: "Drain cleaning", slug: "drain-cleaning", mainKeyword: "drain cleaning sacramento" },
      ],
    );
    expect(rows).toEqual([
      { from: "/drain-cleaning-sacramento/", to: "/drain-cleaning/", pageName: "Drain cleaning", reason: 'Shares "drain, cleaning"', unmatchedTraffic: false },
      { from: "/emergency-plumber/", to: "", pageName: "", reason: "No planned page covers it", unmatchedTraffic: true },
    ]);
    expect(netlifyRedirectsFile(rows)).toContain("/drain-cleaning-sacramento/  /drain-cleaning/  301");
  });

  /* Audit F-026 (H2, 14 November 2026). */
  describe("H2: stems, parents, query strings, patterns, and nothing sent home blindly", () => {
    const plan = [
      { name: "Home", slug: "", mainKeyword: "plumber sacramento" },
      { name: "Drain cleaning", slug: "drain-cleaning", mainKeyword: "drain cleaning sacramento" },
      { name: "Water heater repair", slug: "water-heater-repair", mainKeyword: "water heater repair sacramento" },
      { name: "Privacy Policy", slug: "privacy", mainKeyword: "" },
    ];
    const map = (...paths: string[]) => redirectMap(paths.map((p) => ({ url: `https://o.example${p}` })), [], plan);
    const to = (rows: RedirectRow[], from: string) => rows.find((r) => r.from === from)?.to;

    it("finds the page through plurals and endings: /drains/ goes to Drain cleaning", () => {
      const rows = map("/drains/", "/cleaning-drain/", "/water-heaters-repairs/", "/repaired-heater/", "/Drain-Cleaning.html");
      expect(to(rows, "/drains/")).toBe("/drain-cleaning/");
      expect(to(rows, "/cleaning-drain/")).toBe("/drain-cleaning/");
      expect(to(rows, "/water-heaters-repairs/")).toBe("/water-heater-repair/");
      expect(to(rows, "/repaired-heater/")).toBe("/water-heater-repair/");
      expect(rows.find((r) => r.from === "/Drain-Cleaning.html")!.reason).toContain("same address");
    });

    it("stems the way the rules say", () => {
      expect(["drains", "drain", "cleaning", "cleaned", "repairs", "emergencies", "boxes", "glass", "gas", "plumbing"].map(stemOf)).toEqual(["drain", "drain", "clean", "clean", "repair", "emergency", "boxes", "glass", "gas", "plumb"]);
    });

    it("takes a nearly-identical last part (a typo) and the parent of an address nothing matches", () => {
      const rows = map("/drain-cleanning/", "/services/drains/old-promo/", "/xyz/water-heater-repair/summer-2019-offer/");
      expect(to(rows, "/drain-cleanning/")).toBe("/drain-cleaning/");
      expect(to(rows, "/services/drains/old-promo/")).toBe("/drain-cleaning/");
      expect(to(rows, "/xyz/water-heater-repair/summer-2019-offer/")).toBe("/water-heater-repair/");
      // Only the parent decides when the child says nothing: /locations/ has no page, so nothing is chosen.
      expect(to(map("/locations/old-promo/"), "/locations/old-promo/")).toBe("");
    });

    it("uses the parent step by itself when the whole address has no word of its own to match", () => {
      const rows = redirectMap([{ url: "https://o.example/water-heater-repair/2019-summer-offer/" }], [], plan);
      expect(rows[0]!.to).toBe("/water-heater-repair/");
    });

    // The parent step matters when only the parent can be placed: here its last part is a misspelling (run together, one letter short) of a planned page's address.
    it("looks at the parent address when the old address itself finds nothing", () => {
      const rows = map("/draincleanin/2019/");
      expect(to(rows, "/draincleanin/2019/")).toBe("/drain-cleaning/");
      expect(rows[0]!.reason).toMatch(/^Its parent address: Nearly the same address as drain-cleaning/);
    });

    // Netlify's documentation shows query rules only with placeholders, so a rule for "page_id=12" alone is unproven (14 November 2026):
    // such an address is kept and listed with the reason, never dropped, never written.
    it("keeps an address told apart by its query string, lists it with the reason, and never writes it", () => {
      const rows = map("/?page_id=12", "/?utm_source=mail");
      expect(rows.map((r) => r.from)).toEqual(["/?page_id=12"]); // tracking-only is the home page itself
      expect(rows[0]).toMatchObject({ to: "", unsafe: true });
      expect(rows[0]!.reason).toMatch(/home address told apart by its query string/);
      const file = netlifyRedirectsFile([{ from: "/?page_id=12", to: "/drain-cleaning/", pageName: "D", reason: "", unmatchedTraffic: false }, { from: "/blog/", to: "/water-heater-repair/", pageName: "W", reason: "", unmatchedTraffic: false }, { from: "/blog/?p=3&a=1", to: "/drain-cleaning/", pageName: "D", reason: "", unmatchedTraffic: false }]);
      expect(file).toContain("/blog/  /water-heater-repair/  301");
      expect(file).not.toContain("page_id");
      expect(file).not.toContain("p=3");
      expect(file).toContain("# 2 old addresses have no redirect");
    });

    // Fable's review: a query string only tells pages apart on the home address; elsewhere the path is the page, as before.
    it("sets a query string aside on any address but the home page, and matches and writes the path", () => {
      const rows = map("/drains/?v=2", "/drains/?lang=en");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ from: "/drains/", to: "/drain-cleaning/" });
      expect(rows[0]!.unsafe).toBeUndefined();
    });

    // Fable's review: an ending comes off only when four letters are left, so short stems don't meet unrelated words.
    it("never folds a word down to a short stem that meets an unrelated page", () => {
      const pest = [
        { name: "Home", slug: "", mainKeyword: "pest control sacramento" },
        { name: "New installations", slug: "new-installations", mainKeyword: "new installations" },
        { name: "Rat removal", slug: "rat-removal", mainKeyword: "rat removal" },
        { name: "Car care", slug: "car-care", mainKeyword: "car care" },
      ];
      const rows = redirectMap(["/news/", "/ratings/", "/caring/"].map((p) => ({ url: `https://o.example${p}` })), [], pest);
      for (const from of ["/news/", "/ratings/", "/caring/"]) expect(rows.find((r) => r.from === from)!.to).toBe("");
      expect(stemOf("news")).toBe("news");
      expect(stemOf("ratings")).toBe("rating");
      expect(stemOf("running")).toBe("running");
      expect(stemOf("cleaning")).toBe("clean");
      expect(stemOf("drains")).toBe("drain");
    });

    it("never writes a typed address as a wildcard: it is listed, with a reason, and left out of the file", () => {
      const rows = redirectMap([{ url: "https://o.example/old/:splat/" }, { url: "https://o.example/a*b/" }, { url: "https://o.example/a%20b/!/" }, { url: "https://o.example/?x=:id" }, { url: "https://o.example/drains/" }], [], plan);
      for (const from of ["/old/:splat/", "/a*b/", "/?x=%3Aid"]) {
        const row = rows.find((r) => r.from === from);
        expect(row, from).toBeTruthy();
        expect(row!.unsafe).toBe(true);
        expect(row!.to).toBe("");
      }
      const file = netlifyRedirectsFile([...rows, { from: "/old/:splat/", to: "/drain-cleaning/", pageName: "D", reason: "", unmatchedTraffic: false, edited: true }]);
      expect(file).not.toMatch(/[*:]\w|splat|\*/);
      expect(file).toContain("/drains/  /drain-cleaning/  301");
      expect(file).toContain("no redirect");
    });

    it("reports an unmatched address for a person instead of sending it home, and writes nothing for it", () => {
      const rows = redirectMap([{ url: "https://o.example/about-our-team/" }], [{ url: "https://o.example/about-our-team/", keywords: 2, bestPosition: 8, traffic: 40, topKeyword: "plumbing company" }], plan);
      expect(rows).toEqual([{ from: "/about-our-team/", to: "", pageName: "", reason: "No planned page covers it", unmatchedTraffic: true }]);
      expect(netlifyRedirectsFile(rows)).toBe("");
      // A person chooses a page: the correction ships.
      const merged = mergeRedirects(rows, [{ from: "/about-our-team/", to: "/drain-cleaning/", pageName: "D", reason: "Changed by the team", unmatchedTraffic: false, edited: true }], new Set(["/", "/drain-cleaning/"]));
      expect(netlifyRedirectsFile(merged)).toContain("/about-our-team/  /drain-cleaning/  301");
    });

    it("keeps legal pages by kind, the same address needs no redirect, and nothing chains", () => {
      const rows = map("/privacy-policy/", "/drain-cleaning/", "/drains/", "/");
      expect(to(rows, "/privacy-policy/")).toBe("/privacy/");
      expect(rows.some((r) => r.from === "/drain-cleaning/")).toBe(false);
      const served = new Set(plan.map((p) => (p.slug ? `/${p.slug}/` : "/")));
      for (const row of rows) {
        expect(served.has(row.from)).toBe(false); // never a redirect FROM a page the new site serves
        if (row.to) expect(served.has(row.to)).toBe(true); // always TO one: no chains
      }
    });
  });

  /*
    A legal page never redirects to an article (Clear Sky Awning's SEO
    audit, 10 November 2026). TAWD's own audit found this one and said why:
    "/privacy-policy/ redirects to /blog/patio-cover-privacy-ideas/ only
    because both URLs contain the word 'privacy'". One shared word was
    enough to win, so a visitor looking for the privacy policy - or a
    regulator - landed on a blog post about shade.
  */
  describe("where an old legal page goes", () => {
    const legal = (plan: { name: string; slug: string; mainKeyword: string }[]) =>
      redirectMap(
        [
          { url: "https://o.example/privacy-policy/" },
          { url: "https://o.example/cookie-policy/" },
          { url: "https://o.example/terms-and-conditions/" },
        ],
        [],
        [{ name: "Home", slug: "", mainKeyword: "patio covers sacramento" }, { name: "Patio cover privacy ideas", slug: "blog/patio-cover-privacy-ideas", mainKeyword: "patio cover privacy" }, ...plan],
      );

    it("goes to the new site's own policy page when the build has one", () => {
      const rows = legal([
        { name: "Privacy Policy", slug: "privacy", mainKeyword: "" },
        { name: "Cookie Policy", slug: "cookies", mainKeyword: "" },
      ]);
      expect(rows.find((r) => r.from === "/privacy-policy/")!.to).toBe("/privacy/");
      expect(rows.find((r) => r.from === "/cookie-policy/")!.to).toBe("/cookies/");
    });

    it("goes home when the new site has no such page, never to an article", () => {
      const rows = legal([]);
      for (const from of ["/privacy-policy/", "/cookie-policy/", "/terms-and-conditions/"]) {
        const row = rows.find((r) => r.from === from)!;
        expect(row.to, `${from} was sent to an article`).toBe("/");
        expect(row.reason).toContain("legal page");
      }
    });

    it("sees a legal page through a trailing index file", () => {
      const rows = redirectMap(
        [{ url: "https://o.example/privacy/index.html" }, { url: "https://o.example/legal/cookies/index.php" }],
        [],
        [{ name: "Home", slug: "", mainKeyword: "patio covers sacramento" }, { name: "Patio cover privacy ideas", slug: "blog/patio-cover-privacy-ideas", mainKeyword: "patio cover privacy" }],
      );
      for (const row of rows) {
        expect(row.to, `${row.from} was sent to an article`).toBe("/");
        expect(row.reason).toContain("legal page");
      }
    });

    it("leaves an ordinary page's matching alone", () => {
      // The article itself still matches by words, as it always did.
      const rows = redirectMap(
        [{ url: "https://o.example/patio-cover-privacy-ideas/" }],
        [],
        [{ name: "Home", slug: "", mainKeyword: "patio covers sacramento" }, { name: "Patio cover privacy ideas", slug: "blog/patio-cover-privacy-ideas", mainKeyword: "patio cover privacy" }],
      );
      expect(rows[0]!.to).toBe("/blog/patio-cover-privacy-ideas/");
    });

    /*
      CodeRabbit on PR #75 (12 November 2026): a word count is not a legal
      page. Three words let "/blog/privacy-tips/" in as a privacy policy and
      kept "/legal/california/privacy-policy/" out; and "terms-" followed by
      anything let an article become where the terms went.
    */
    it("knows a legal page by its name, wherever it sits, and an article by not being one", () => {
      const plan = [
        { name: "Home", slug: "", mainKeyword: "patio covers sacramento" },
        { name: "Privacy guide", slug: "blog/privacy-guide", mainKeyword: "privacy guide" },
        { name: "Privacy Policy", slug: "privacy", mainKeyword: "" },
      ];
      const rows = redirectMap([{ url: "https://o.example/blog/privacy-tips/" }, { url: "https://o.example/legal/california/privacy-policy/" }], [], plan);
      expect(rows.find((r) => r.from === "/blog/privacy-tips/")!.to).toBe("/blog/privacy-guide/");
      expect(rows.find((r) => r.from === "/legal/california/privacy-policy/")!.to).toBe("/privacy/");
    });

    it("sends the terms and the accessibility statement only to a page of that name, never an article that starts with the word", () => {
      const rows = redirectMap(
        [{ url: "https://o.example/terms-and-conditions/" }, { url: "https://o.example/accessibility/" }],
        [],
        [
          { name: "Home", slug: "", mainKeyword: "patio covers sacramento" },
          { name: "Terms of payment guide", slug: "terms-of-payment-guide", mainKeyword: "payment terms" },
          { name: "Accessibility ramps for patios", slug: "accessibility-ramps-for-patios", mainKeyword: "patio ramps" },
        ],
      );
      expect(rows.map((r) => r.to)).toEqual(["/", "/"]);
      const named = redirectMap(
        [{ url: "https://o.example/terms-and-conditions/" }, { url: "https://o.example/accessibility/" }],
        [],
        [
          { name: "Home", slug: "", mainKeyword: "" },
          { name: "Terms of service", slug: "terms-of-service", mainKeyword: "" },
          { name: "Accessibility statement", slug: "accessibility-statement", mainKeyword: "" },
        ],
      );
      expect(named.map((r) => r.to)).toEqual(["/terms-of-service/", "/accessibility-statement/"]);
    });
  });

  // #5: the dropped/skipped/over-limit old URLs the build must still 301, pulled from the site read.
  it("gathers left-out old URLs (over-limit, skipped, failed), de-duped and blank-free", () => {
    expect(
      leftOutUrls({
        notImported: ["https://o.example/over-1/", "https://o.example/over-2/"],
        skipped: [{ url: "https://o.example/feed/", reason: "feed" }, { url: "https://o.example/over-1/", reason: "dup" }],
        failed: [{ url: "https://o.example/timed-out/", reason: "timeout" }],
      }),
    ).toEqual(["https://o.example/over-1/", "https://o.example/over-2/", "https://o.example/feed/", "https://o.example/timed-out/"]);
    // Robust to missing/blank/malformed jsonb.
    expect(leftOutUrls(null)).toEqual([]);
    expect(leftOutUrls({ notImported: ["", "  "], skipped: [{ url: "" }, { reason: "x" } as never], failed: "nope" as never })).toEqual([]);
  });

  // #6: only a person's correction (an `edited` row) overrides the recompute; unedited audit rows don't.
  it("overlays only edited saved corrections, dropping any to a missing or served page", () => {
    const row = (from: string, to: string, extra: Partial<RedirectRow> = {}): RedirectRow => ({ from, to, pageName: "P", reason: "", unmatchedTraffic: false, ...extra });
    const recomputed = [row("/old-a/", "/a/"), row("/old-b/", "/b/")];
    const edited = (from: string, to: string) => row(from, to, { edited: true });
    const saved = [edited("/old-a/", "/a-new/"), edited("/old-c/", "/c/"), edited("/old-d/", "/gone/"), edited("/a/", "/b/")];
    const valid = new Set(["/", "/a/", "/a-new/", "/b/", "/c/"]);
    const by = Object.fromEntries(mergeRedirects(recomputed, saved, valid).map((r) => [r.from, r.to]));
    expect(by["/old-a/"]).toBe("/a-new/"); // edited correction overrides the recompute
    expect(by["/old-b/"]).toBe("/b/"); // untouched
    expect(by["/old-c/"]).toBe("/c/"); // edited addition kept
    expect(by["/old-d/"]).toBeUndefined(); // target not in this build → dropped (no stale redirect)
    expect(by["/a/"]).toBeUndefined(); // `from` is a served page → dropped (never 301 a live page)
    // An UNEDITED saved row (the audit's own) never overrides — the plan-consistent recompute wins,
    // so a plan change after the audit can't make the build use a stale target.
    const by2 = Object.fromEntries(mergeRedirects(recomputed, [row("/old-a/", "/stale/")], valid).map((r) => [r.from, r.to]));
    expect(by2["/old-a/"]).toBe("/a/");
    expect(mergeRedirects(recomputed, [], valid)).toEqual(recomputed); // no saved map → unchanged
  });
});

describe("the \"Don't lose it\" check", () => {
  it("reads the sitemap, finds what ranks, and maps old addresses to new pages", async () => {
    const { admin, id } = await projectWithSite();
    await startQuickCheck(h.ctx, admin.viewer, id);
    await settleAudits();
    const [audit] = await h.db.select().from(seoAudit).where(eq(seoAudit.projectId, id));
    expect(audit).toMatchObject({ kind: "quick", status: "done", pageCount: 5, sandbox: true });
    expect(dataCalls).toEqual(["dataforseo_labs/google/ranked_keywords/live"]);
    const view = await loadAudits(h.db, admin.viewer, id);
    expect(view.rankings.map((r) => r.traffic)).toEqual([120, 60]);
    expect(view.redirects.find((r) => r.from === "/drain-cleaning-sacramento/")).toMatchObject({ to: "/drain-cleaning/" });
    expect(view.redirects.find((r) => r.from === "/emergency-plumber/")).toMatchObject({ unmatchedTraffic: true });
    expect((await h.db.select().from(seoDataCall)).every((c) => c.responseKey && r2.objects.has(c.responseKey))).toBe(true);

    // Saved again with the same website: the automatic check doesn't repeat.
    expect(await startQuickCheck(h.ctx, admin.viewer, id, { auto: true })).toBeNull();
  });

  // #5 + #6: left-out old URLs still get a 301, and a team correction reaches the screen and the build.
  it("redirects dropped/skipped old URLs and lets the team change a target", async () => {
    const { admin, id } = await projectWithSite();
    await startQuickCheck(h.ctx, admin.viewer, id);
    await settleAudits();
    // The site read dropped a page over the tier limit and skipped a feed: both still need a 301.
    await h.db.insert(siteImport).values({
      projectId: id,
      url: "https://oldsite.example",
      status: "done",
      pageLimit: 20,
      notImported: ["https://oldsite.example/over-the-limit-service/"],
      skipped: [{ url: "https://oldsite.example/feed/", reason: "feed" }],
    });

    const view = await loadAudits(h.db, admin.viewer, id);
    const froms = view.redirects.map((r) => r.from);
    expect(froms).toContain("/over-the-limit-service/"); // #5: the over-limit page gets a redirect
    expect(froms).toContain("/feed/");

    // #6: the team points the over-limit page at a real plan page; it sticks and shows as edited.
    const target = view.targets.find((t) => t.path !== "/")!;
    await saveRedirect(h.ctx, admin.viewer, id, "/over-the-limit-service/", target.path);
    const after = await loadAudits(h.db, admin.viewer, id);
    const edited = after.redirects.find((r) => r.from === "/over-the-limit-service/")!;
    expect(edited.to).toBe(target.path);
    expect(edited.edited).toBe(true);

    // A target the new site doesn't have is refused.
    await expect(saveRedirect(h.ctx, admin.viewer, id, "/over-the-limit-service/", "/not-a-real-page/")).rejects.toThrow();
  });

  // #6 fixes (CodeRabbit #46): the edit lands on the audit the build reads, and without a done
  // audit the targets aren't editable (so the dropdown never errors on save).
  it("edits the latest done audit (what the build reads) and is read-only with no audit", async () => {
    const { admin, id } = await projectWithSite();
    // No audit yet, but the site read dropped a page: it still shows a redirect, read-only.
    await h.db.insert(siteImport).values({ projectId: id, url: "https://oldsite.example", status: "done", pageLimit: 20, notImported: ["https://oldsite.example/legacy-service/"] });
    const noAudit = await loadAudits(h.db, admin.viewer, id);
    expect(noAudit.redirects.map((r) => r.from)).toContain("/legacy-service/"); // #5 works with no audit
    expect(noAudit.canEditRedirects).toBe(false); // nothing to store an edit on → dropdown stays read-only
    await expect(saveRedirect(h.ctx, admin.viewer, id, "/legacy-service/", "/")).rejects.toThrow(/site check first/);

    // Now an older full audit and a newer quick audit both exist; the build reads the latest (quick).
    const pages = [{ url: "https://oldsite.example/legacy-service/", path: "/legacy-service/" }];
    await h.db.insert(seoAudit).values({ projectId: id, kind: "full", status: "done", siteUrl: "https://oldsite.example", sandbox: true, pageCount: 3, pages, rankings: [], redirects: [], createdAt: new Date("2026-11-01T00:00:00Z") });
    await h.db.insert(seoAudit).values({ projectId: id, kind: "quick", status: "done", siteUrl: "https://oldsite.example", sandbox: true, pageCount: 2, pages, rankings: [], redirects: [], createdAt: new Date("2026-11-05T00:00:00Z") });

    const view = await loadAudits(h.db, admin.viewer, id);
    expect(view.canEditRedirects).toBe(true);
    const target = view.targets.find((t) => t.path !== "/")!;
    await saveRedirect(h.ctx, admin.viewer, id, "/legacy-service/", target.path);

    const [quickRow] = await h.db.select().from(seoAudit).where(and(eq(seoAudit.projectId, id), eq(seoAudit.kind, "quick")));
    const [fullRow] = await h.db.select().from(seoAudit).where(and(eq(seoAudit.projectId, id), eq(seoAudit.kind, "full")));
    expect((quickRow!.redirects as RedirectRow[]).find((r) => r.from === "/legacy-service/")?.edited).toBe(true); // stored on the latest (quick)
    expect(fullRow!.redirects as RedirectRow[]).toHaveLength(0); // the older full is untouched
    const after = await loadAudits(h.db, admin.viewer, id);
    expect(after.redirects.find((r) => r.from === "/legacy-service/")?.to).toBe(target.path);
  });

  it("never reads a private network address", async () => {
    const { admin, id } = await projectWithSite();
    setAuditStandInsForTesting({ lookup: async () => ["10.0.0.5"], site: (async () => new Response(SITE["https://oldsite.example/page-sitemap.xml"]!)) as typeof fetch });
    await startQuickCheck(h.ctx, admin.viewer, id);
    await settleAudits();
    const [audit] = await h.db.select().from(seoAudit).where(eq(seoAudit.projectId, id));
    expect(audit).toMatchObject({ status: "failed", failureReason: "Couldn't read any pages from https://oldsite.example. Check the address, or that the site is up." });
  });

  it("checks every redirect: a public page that redirects to a private address is never opened there", async () => {
    const { admin, id } = await projectWithSite();
    const opened: string[] = [];
    setAuditStandInsForTesting({
      lookup: async (host) => (host === "internal.example" ? ["::ffff:7f00:1"] : ["93.184.216.34"]),
      site: (async (url: string) => {
        opened.push(url);
        if (url.startsWith("https://oldsite.example")) return new Response("", { status: 302, headers: { location: "http://internal.example/secret" } });
        return new Response(SITE["https://oldsite.example/page-sitemap.xml"]!);
      }) as typeof fetch,
    });
    await startQuickCheck(h.ctx, admin.viewer, id);
    await settleAudits();
    expect(opened.some((url) => url.includes("internal.example") || url.includes("169.254"))).toBe(false);
    const [audit] = await h.db.select().from(seoAudit).where(eq(seoAudit.projectId, id));
    expect(audit?.status).toBe("failed");
  });
});

describe("the full audit", () => {
  it("counts the pages for the band, needs the add-on, crawls, measures speed, and the Senior SEO agent reports", async () => {
    const { admin, id } = await projectWithSite();
    expect(await countSitePages(h.ctx, admin.viewer, id)).toMatchObject({ pageCount: 5, band: "seo_audit_20" });
    await expect(startFullAudit(h.ctx, admin.viewer, id)).rejects.toThrow("Add the full SEO audit to the project first");
    await addFullAudit(h.ctx, admin.viewer, id);
    expect((await h.db.select().from(projectAddon).where(eq(projectAddon.projectId, id))).map((a) => a.addonKey)).toEqual(["seo_audit_20"]);

    await startFullAudit(h.ctx, admin.viewer, id);
    await settleAudits();
    expect(dataCalls).toEqual(["dataforseo_labs/google/ranked_keywords/live", "on_page/task_post", "on_page/summary/:id", "on_page/summary/:id", "on_page/pages"]);
    const [gathered] = await h.db.select().from(seoAudit).where(eq(seoAudit.kind, "full"));
    expect(gathered).toMatchObject({ onPageTaskId: "task-123", step: "Writing the report" });
    expect((gathered!.pageSpeed as { performance: number }[])[0]!.performance).toBe(0.42);
    expect(queued.map((q) => q.name)).toEqual([SEO_AUDIT_JOB]);

    const report = {
      summary: "The site ranks for drain cleaning but misses descriptions.",
      priorities: [{ title: "Keep the drain cleaning page's ranking", problem: "It brings 120 visits.", fix: "Redirect it to /drain-cleaning/.", pages: ["/drain-cleaning-sacramento/"], impact: "high" }],
      gaps: [{ title: "No emergency page", detail: "The old emergency page ranks and has no page in the plan." }],
      planSuggestions: [{ name: "Emergency plumber", mainKeyword: "emergency plumber sacramento", reason: "Brings 60 visits a month today." }],
    };
    const claude = fakeClaude(() => [report]);
    await runSeoAuditJob(queued[0]!.data, config, claude.client as never);
    const [done] = await h.db.select().from(seoAudit).where(eq(seoAudit.kind, "full"));
    expect(done).toMatchObject({ status: "done" });
    expect((done!.report as typeof report).planSuggestions[0]!.name).toBe("Emergency plumber");
    const sent = String((claude.calls[0]!.params.messages as { content: string }[])[0]!.content);
    expect(sent).toContain("no_description");
    expect(sent).toContain("emergency plumber sacramento");

    state.user = admin.viewer;
    const { default: ContentPage } = await import("@/app/(app)/projects/[id]/content/page");
    const html = renderToStaticMarkup(await ContentPage({ params: Promise.resolve({ id }) }));
    expect(html).toContain("Current website");
    expect(html).toContain("/drain-cleaning-sacramento/");
    expect(html).toContain("Full SEO audit, up to 20 pages");
    expect(html).toContain("Keep the drain cleaning page");
    expect(html).toContain("Add to the plan");
  });
});

describe("a compressed answer from the client's site", () => {
  it("is unpacked before it's read (gzip, deflate, brotli; plain stays plain)", async () => {
    const SITEMAP = "<urlset><url><loc>https://example.com/drains/</loc></url></urlset>";
    const packers: Record<string, (b: Buffer) => Buffer> = {
      gzip: zlib.gzipSync,
      deflate: zlib.deflateSync,
      br: zlib.brotliCompressSync,
      "": (b) => b,
    };
    const server = http.createServer((req, res) => {
      const encoding = String(req.headers["x-encoding"] ?? "");
      res.writeHead(200, encoding ? { "Content-Encoding": encoding } : {});
      res.end(packers[encoding]!(Buffer.from(SITEMAP)));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      for (const encoding of Object.keys(packers)) {
        const text = await new Promise<string>((done, fail) => {
          http.get({ host: "127.0.0.1", port, headers: { "x-encoding": encoding } }, (response) => {
            const chunks: Buffer[] = [];
            const body = unpacked(response);
            body.on("data", (chunk: Buffer) => chunks.push(chunk));
            body.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
            body.on("error", fail);
          }).on("error", fail);
        });
        expect(text, encoding || "plain").toBe(SITEMAP);
      }
    } finally {
      server.close();
    }
  });
});
