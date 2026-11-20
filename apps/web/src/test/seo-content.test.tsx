import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { parseIntake } from "@tawd/core/intake";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  SEO and content 7a (26 September 2026): DataForSEO keyword research, the
  SEO data cap, and the page plan. DataForSEO is a stand-in throughout:
  nothing here reaches it, sandbox or live, and no AI runs at all.
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
import { activityLog, keywordMetric, keywordResearch, pagePlanPage, seoDataCall, seoKeyword } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";
import {
  MAX_KEYWORDS,
  draftPagePlan,
  keywordPlan,
  planKeywordWarning,
  planTierWarning,
  radiusCenter,
  splitCity,
} from "@/lib/seo-plan";
import {
  estimateKeywordResearch,
  loadSeoView,
  makePagePlan,
  movePlanPage,
  removePlanPage,
  savePlanPage,
  setDataForSeoFetchForTesting, testDataForSeoConnection, loadDmaMarkets, getDmaMarkets,
  settleKeywordResearch,
  startKeywordResearch,
} from "@/lib/seo-data";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let calls: { url: string; auth: string | null; body: { keywords: string[]; location_name: string }[] }[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  calls = [];
  vi.stubEnv("DATAFORSEO_LOGIN", "sandbox-login");
  vi.stubEnv("DATAFORSEO_PASSWORD", "sandbox-password");
  vi.stubEnv("DATAFORSEO_LIVE", "");
  // A stand-in shaped like DataForSEO's answers: volume by keyword length, difficulty 30.
  setDataForSeoFetchForTesting((async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { keywords: string[]; location_name: string }[];
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization"), body });
    const keywords = body[0]!.keywords;
    const result = url.includes("search_volume")
      ? keywords.map((keyword) => ({ keyword, search_volume: keyword.includes("near me") ? 900 : 100 + keyword.length, cpc: 12.5, competition: "HIGH" }))
      : [{ items: keywords.map((keyword) => ({ keyword, keyword_difficulty: 30 })) }];
    return new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.0855, tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.0855, result }] }), { status: 200 });
  }) as typeof fetch);
});

afterEach(async () => {
  setDataForSeoFetchForTesting(null);
  vi.unstubAllEnvs();
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const lane1 = {
  clientName: "Sacramento Drain Pros",
  trade: "plumbing" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "mockups" as const,
  memberUserIds: [] as string[],
};

async function projectWithIntake(tier: "starter" | "growth" = "starter") {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { ...lane1, tier });
  // A year and emergency service: something true for an About page and an FAQ (both only with facts since 8 October 2026).
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Sacramento Drain Pros", state: "CA", yearFounded: 2009, emergency247: true });
  await saveIntakeSection(h.ctx, admin.viewer, id, "services", {
    items: [
      { id: "s1", name: "Drain cleaning", description: "" },
      { id: "s2", name: "Water heaters", description: "" },
    ],
    mainServiceId: "s1",
  });
  await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Sacramento", "Reno, NV"], wantsIndividualCityPages: true });
  return { admin, id };
}

const noAreas = { cities: [], states: [], radius: { miles: null, address: "" } };

describe("which keywords, where", () => {
  it("puts cities into the words, measured across their state, for every service and the trade", () => {
    const groups = keywordPlan({ trade: "plumbing", services: ["Drain cleaning"], areas: { ...noAreas, scope: "cities", cities: ["Sacramento", "Reno, NV"] }, businessState: "CA" });
    expect(groups.map((g) => g.place)).toEqual(["California,United States", "Nevada,United States"]);
    expect(groups[0]!.keywords.map((k) => k.keyword)).toEqual(["drain cleaning sacramento", "drain cleaning near me", "plumber sacramento", "plumber near me"]);
    expect(groups[1]!.keywords[0]).toEqual({ keyword: "drain cleaning reno", service: "Drain cleaning", area: "Reno" });
  });

  it("covers whole states, nationwide and a radius too", () => {
    const states = keywordPlan({ trade: "legal", services: ["Estate planning"], areas: { ...noAreas, scope: "states", states: ["NV", "CA"] }, businessState: null });
    expect(states.map((g) => g.place)).toEqual(["Nevada,United States", "California,United States"]);
    expect(states[0]!.keywords.map((k) => k.keyword)).toEqual(["estate planning", "estate planning near me", "lawyer", "lawyer near me"]);

    const nationwide = keywordPlan({ trade: "other", services: ["Mobile notary"], areas: { ...noAreas, scope: "nationwide" }, businessState: null });
    expect(nationwide).toEqual([{ place: "United States", keywords: [expect.objectContaining({ keyword: "mobile notary" }), expect.objectContaining({ keyword: "mobile notary near me" })] }]);

    const radius = keywordPlan({ trade: "hvac", services: ["AC repair"], areas: { ...noAreas, scope: "radius", radius: { miles: 30, address: "4105 Kietzke Ln, Reno, NV 89502" } }, businessState: null });
    expect(radius[0]!.place).toBe("Nevada,United States");
    expect(radius[0]!.keywords[0]!.keyword).toBe("ac repair reno");
  });

  it("reads cities and radius addresses, and caps the list", () => {
    expect(splitCity("Carson City, NV", "CA")).toEqual({ city: "Carson City", state: "Nevada" });
    expect(splitCity("Folsom", "California")).toEqual({ city: "Folsom", state: "California" });
    expect(radiusCenter("12 Main St", null)).toBeNull();
    const many = keywordPlan({ trade: "plumbing", services: Array.from({ length: 50 }, (_, i) => `Service ${i}`), areas: { ...noAreas, scope: "cities", cities: Array.from({ length: 20 }, (_, i) => `Town ${i}`) }, businessState: "CA" });
    expect(many.reduce((sum, g) => sum + g.keywords.length, 0)).toBe(MAX_KEYWORDS);
  });
});

describe("the first page plan", () => {
  const input = {
    trade: "plumbing" as const,
    businessName: "Sacramento Drain Pros",
    services: ["Drain cleaning", "Water heaters", "Leak detection", "Sewer lines", "Repiping", "Gas lines", "Sump pumps"],
    areas: { ...noAreas, scope: "cities" as const, cities: ["Sacramento", "Folsom"], wantsIndividualCityPages: true },
    businessState: "CA",
    keywords: [
      { keyword: "drain cleaning sacramento", service: "Drain cleaning", area: "Sacramento", searchVolume: 880, difficulty: 22 },
      { keyword: "drain cleaning near me", service: "Drain cleaning", area: "California", searchVolume: 2400, difficulty: 40 },
      { keyword: "plumber sacramento", service: null, area: "Sacramento", searchVolume: 5400, difficulty: 35 },
    ],
  };

  it("has no Service areas page when the intake lists no service areas (Jason, 1 October 2026)", () => {
    const pages = draftPagePlan({ ...input, tier: "starter", areas: { ...input.areas, cities: [], counties: [], states: [], dmas: [] } as never });
    expect(pages.map((p) => p.kind)).not.toContain("service_areas");
  });

  it("keeps Starter to 10 pages with at most 5 services, one Service Areas page and an FAQ", () => {
    const pages = draftPagePlan({ ...input, tier: "starter" });
    expect(pages.map((p) => p.kind)).toEqual(["home", "service", "service", "service", "service", "service", "service_areas", "about", "faq", "contact"]);
    // Home targets the trade and the place, never one service (8 October 2026).
    expect(pages[0]).toMatchObject({ name: "Home", slug: "", mainKeyword: "plumber sacramento", h1: "Plumber in Sacramento" });
    expect(pages[1]).toMatchObject({ slug: "drain-cleaning", mainKeyword: "drain cleaning near me", supportingKeywords: ["drain cleaning sacramento"] });
    for (const page of pages) {
      expect(page.title.length).toBeLessThanOrEqual(60);
      expect(page.metaDescription.length).toBeLessThanOrEqual(155);
    }
  });

  it("gives Growth a page per city when the intake asks, and says what's missing instead of inventing it", () => {
    const pages = draftPagePlan({ ...input, tier: "growth" });
    expect(pages.filter((p) => p.kind === "service")).toHaveLength(7);
    expect(pages.filter((p) => p.kind === "city").map((p) => p.name)).toEqual(["Sacramento", "Folsom"]);
    const unnamed = draftPagePlan({ ...input, tier: "starter", businessName: "", keywords: [] });
    expect(unnamed.find((p) => p.kind === "about")!.h1).toBe("About [PLACEHOLDER: business name]");
  });

  /*
    Clear Sky Awning's SEO audit found this itself: "No page in the plan has
    a main keyword assigned", so the pages compete with each other and with
    the client's own ranking blog post. The plan screen said "None yet" on
    every row, which is easy to read past when it says it nine times.
  */
  it("says once, as a number, how many pages have no main keyword", () => {
    expect(planKeywordWarning([])).toBeNull();
    expect(planKeywordWarning([{ mainKeyword: "patio covers sacramento" }])).toBeNull();
    const none = planKeywordWarning([{ mainKeyword: "" }, { mainKeyword: "  " }, { mainKeyword: "" }])!;
    expect(none).toContain("No page");
    expect(none).toContain("competing");
    // It never invents one: which search a page should win is the SEO team's call.
    expect(none).toContain("Run keyword research");
    expect(planKeywordWarning([{ mainKeyword: "awnings folsom" }, { mainKeyword: "" }])!).toContain("1 of the 2 pages");
  });

  it("warns when the plan outgrows the tier, and never changes it", () => {
    expect(planTierWarning(10, "starter")).toBeNull();
    expect(planTierWarning(12, "starter")).toBe("12 pages: Starter covers up to 10. Remove 2, or talk to the client about Growth. TAWD won't change the tier.");
    expect(planTierWarning(23, "growth")).toContain("talk to the client about Pro");
    expect(planTierWarning(51, "pro")).toContain("Pro covers up to 50");
  });
});

/*
  A paid lookup that could only return the trade's own term (Jason's run,
  10 November 2026).

  Clear Sky Awning's keyword table came back as "remodeling contractor
  folsom", "remodeling contractor rocklin", "remodeling contractor near
  me" - twelve rows, every one of them the trade category, every Service
  column reading "The trade", for a business that builds patio covers. The
  services were not in the intake when the lookup ran, so the only topic
  left was the trade's own word; nothing stopped the spend, and the SEO
  plan was then built on keywords for somebody else's trade.

  Standing rule 9: before any paid step, say whether the result will be
  usable. This one can be answered by code before a cent is spent.
*/
describe("a keyword lookup with no services to look up", () => {
  it("says the result would not be usable, and how to fix it", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...lane1, tier: "starter" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Clear Sky Awning", state: "CA" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Folsom", "Rocklin"], wantsIndividualCityPages: true });

    const estimate = await estimateKeywordResearch(h.db, admin.viewer, id);
    expect(estimate.blocked, "a trade-only lookup was allowed to spend").toBeTruthy();
    expect(estimate.blocked).toContain("services");
    // It names the word every keyword would have used, so the team can see what it would have bought.
    expect(estimate.blocked).toContain("plumber");
    await expect(startKeywordResearch(h.ctx, admin.viewer, id)).rejects.toThrow(/services/);
  });

  it("a service with a blank name is not a service", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { ...lane1, tier: "starter" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Clear Sky Awning", state: "CA" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "serviceAreas", { scope: "cities", cities: ["Folsom"], wantsIndividualCityPages: true });
    await saveIntakeSection(h.ctx, admin.viewer, id, "services", { items: [{ id: "s1", name: "   ", description: "Patio covers" }], mainServiceId: "s1" });
    expect((await estimateKeywordResearch(h.db, admin.viewer, id)).blocked).toContain("services");
  });

  it("one real service is enough to let it run", async () => {
    const { admin, id } = await projectWithIntake();
    expect((await estimateKeywordResearch(h.db, admin.viewer, id)).blocked).toBeNull();
  });
});

describe("keyword research", () => {
  // C7 (audit F-050): a charge whose answer couldn't be saved still reaches the ledger the monthly cap reads.
  it("records every call on the ledger even when its answer can't be saved", async () => {
    const { admin, id } = await projectWithIntake();
    r2.put = async () => {
      throw new Error("storage down");
    };
    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    const ledger = await h.db.select().from(seoDataCall);
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.responseKey === null)).toBe(true);
  });

  it("uses the sandbox, saves every answer first, records it on the ledger, and never pays twice", async () => {
    const { admin, id } = await projectWithIntake();
    const estimate = await estimateKeywordResearch(h.db, admin.viewer, id);
    expect(estimate).toMatchObject({ keywords: 12, places: ["California,United States", "Nevada,United States"], estimateUsd: 0, sandbox: true, blocked: null });

    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();

    expect(calls.every((c) => c.url.startsWith("https://sandbox.dataforseo.com/v3/"))).toBe(true);
    expect(calls.map((c) => c.url.split("/v3/")[1])).toEqual([
      "keywords_data/google_ads/search_volume/live",
      "keywords_data/google_ads/search_volume/live",
      "dataforseo_labs/google/bulk_keyword_difficulty/live",
    ]);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from("sandbox-login:sandbox-password").toString("base64")}`);
    expect(calls[2]!.body[0]!.location_name).toBe("United States");

    const [run] = await h.db.select().from(keywordResearch);
    expect(run).toMatchObject({ status: "done", sandbox: true, keywordCount: 12, costUsd: 0, cachedCount: 0 });
    const ledger = await h.db.select().from(seoDataCall);
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.sandbox && l.costUsd === 0 && l.ok && l.responseKey && r2.objects.has(l.responseKey))).toBe(true);
    const keywords = await h.db.select().from(seoKeyword).where(eq(seoKeyword.researchId, run!.id));
    expect(keywords.find((k) => k.keyword === "drain cleaning reno")).toMatchObject({ area: "Reno", place: "Nevada,United States", searchVolume: 119, difficulty: 30, cpc: 12.5 });

    // Again: everything is known, so nothing is looked up.
    calls = [];
    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    expect(calls).toEqual([]);
    const runs = await h.db.select().from(keywordResearch);
    expect(runs.find((r) => r.id !== run!.id)).toMatchObject({ status: "done", cachedCount: 12 });

    const actions = (await h.db.select().from(activityLog)).map((a) => a.action);
    expect(actions.filter((a) => a === "seo.research_started")).toHaveLength(2);
    expect(actions).toContain("seo.research_finished");
  });

  it("counts live lookups against the SEO data cap and refuses before spending", async () => {
    const { admin, id } = await projectWithIntake();
    vi.stubEnv("DATAFORSEO_LIVE", "on");
    const estimate = await estimateKeywordResearch(h.db, admin.viewer, id);
    expect(estimate.sandbox).toBe(false);
    // Two places (one volume lookup each), and 9 different keywords for difficulty ("near me" is shared).
    expect(estimate.estimateUsd).toBeCloseTo(0.075 * 2 + 0.01 + 0.0001 * 9, 4);

    await h.db.insert(seoDataCall).values({ projectId: id, endpoint: "search_volume", sandbox: false, keywordCount: 900, costUsd: 24.95, ok: true });
    const blocked = await estimateKeywordResearch(h.db, admin.viewer, id);
    expect(blocked.blocked).toContain("over the monthly SEO data cap ($24.95 of $25.00 used)");
    await expect(startKeywordResearch(h.ctx, admin.viewer, id)).rejects.toThrow("SEO data cap");
    expect(calls).toEqual([]);
  });

  it("says what's missing without the login, and records DataForSEO's refusal plainly", async () => {
    const { admin, id } = await projectWithIntake();
    vi.stubEnv("DATAFORSEO_PASSWORD", "");
    expect((await estimateKeywordResearch(h.db, admin.viewer, id)).blocked).toBe("DataForSEO isn't set up yet: an admin adds DATAFORSEO_PASSWORD in Coolify.");

    vi.stubEnv("DATAFORSEO_PASSWORD", "wrong");
    setDataForSeoFetchForTesting((async () => new Response(JSON.stringify({ status_code: 40100, status_message: "You are not authorized to access this resource." }), { status: 401 })) as typeof fetch);
    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    const [run] = await h.db.select().from(keywordResearch);
    // DataForSEO's own reason and where the call went, never a bare "refused".
    expect(run).toMatchObject({
      status: "failed",
      failureReason: "DataForSEO refused the request (HTTP 401: 40100 You are not authorized to access this resource.) at the sandbox (sandbox.dataforseo.com). Check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the web app in Coolify.",
    });
  });

  it("sends the login as curl would, even when Coolify kept quotes or spaces around it (the 26 September refusal)", async () => {
    const { admin, id } = await projectWithIntake();
    vi.stubEnv("DATAFORSEO_LOGIN", ' "jason@example.com"\n');
    vi.stubEnv("DATAFORSEO_PASSWORD", "'abc123def'");
    const seen: string[] = [];
    setDataForSeoFetchForTesting((async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, result: [] }] }), { status: 200 });
    }) as typeof fetch);
    const expected = `Basic ${Buffer.from("jason@example.com:abc123def").toString("base64")}`;

    const test = await testDataForSeoConnection(h.ctx, admin.viewer);
    expect(seen[0]).toBe(`https://sandbox.dataforseo.com/v3/appendix/user_data ${expected}`);
    expect(test).toMatchObject({ ok: true, service: "web app", httpStatus: 200, dataForSeo: "20000 Ok.", endpoint: "https://sandbox.dataforseo.com/v3/appendix/user_data", login: "ja*************om", passwordLength: 9 });
    expect(test.tidied).toEqual(["DATAFORSEO_LOGIN had spaces or a line break around it", "DATAFORSEO_LOGIN was wrapped in quotes", "DATAFORSEO_PASSWORD was wrapped in quotes"]);
    expect(JSON.stringify(test)).not.toContain("abc123def");

    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    expect(seen.slice(1).every((line) => line.endsWith(expected))).toBe(true);
  });

it("fails the connection test when the login works but a real lookup is refused (DataForSEO's allowed-IP list, 4 November 2026)", async () => {
    const { admin } = await projectWithIntake();
    vi.stubEnv("DATAFORSEO_LIVE", "on");
    const urls: string[] = [];
    const answer = (lookup: object) =>
      (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(url.includes("user_data") ? { status_code: 20000, status_message: "Ok." } : lookup), { status: 200 });
      }) as typeof fetch;
    setDataForSeoFetchForTesting(answer({ status_code: 40104, status_message: "Please visit https://app.dataforseo.com/api-access to whitelist your IP address." }));

    const refused = await testDataForSeoConnection(h.ctx, admin.viewer);
    expect(urls).toEqual(["https://api.dataforseo.com/v3/appendix/user_data", "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live"]);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("accepted the login, but real SEO work would fail");
    expect(refused.message).toContain("203.0.113.10");
    expect(refused.dataCall).toMatchObject({ ok: false, costUsd: 0 });

    // A lookup that works passes, with what it cost.
    setDataForSeoFetchForTesting(answer({ status_code: 20000, cost: 0.0101, tasks: [{ status_code: 20000, cost: 0.0101, result: [] }] }));
    const passed = await testDataForSeoConnection(h.ctx, admin.viewer);
    expect(passed.ok).toBe(true);
    expect(passed.dataCall).toMatchObject({ ok: true, costUsd: 0.0101 });
    expect(passed.dataCall?.message).toContain("$0.0101");
  });

it("loads the TV markets (DMAs) with one free call to DataForSEO's live list, for admins only", async () => {
    const { admin } = await projectWithIntake();
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(loadDmaMarkets(h.ctx, pm.viewer)).rejects.toThrow(PermissionError);
    const urls: string[] = [];
    const list = (rows: object[]) =>
      (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, result: rows }] }), { status: 200 });
      }) as typeof fetch;
    setDataForSeoFetchForTesting(
      list([
        { location_code: 2840, location_name: "United States", location_type: "Country", country_iso_code: "US" },
        { location_code: 200811, location_name: "Reno NV,Nevada,United States", location_type: "DMA Region", country_iso_code: "US" },
        { location_code: 1022653, location_name: "Reno,Nevada,United States", location_type: "City", country_iso_code: "US" },
      ]),
    );
    expect(await loadDmaMarkets(h.ctx, admin.viewer)).toEqual({ count: 1 });
    expect(urls).toEqual(["https://api.dataforseo.com/v3/keywords_data/google_ads/locations/us"]);
    expect((await getDmaMarkets(h.db)).dmas).toEqual([{ id: "200811", name: "Reno NV", canonical: "Reno NV,Nevada,United States" }]);

    // A list without DMAs leaves the choice hidden.
    setDataForSeoFetchForTesting(list([{ location_code: 2840, location_name: "United States", location_type: "Country", country_iso_code: "US" }]));
    expect(await loadDmaMarkets(h.ctx, admin.viewer)).toEqual({ count: 0 });
    expect((await getDmaMarkets(h.db)).dmas).toEqual([]);
  });

  it("shows the DMA choice in the intake only once markets are loaded", async () => {
    const { SectionBody } = await import("@/components/intake/section-body");
    const base = { section: "serviceAreas", projectId: "p", values: parseIntake({}).serviceAreas, onChange: () => {}, files: [], captions: {}, onCaptionChange: () => {}, completeness: { requirements: [], missing: [], isComplete: true, percent: 100, satisfiedCount: 1, totalCount: 1 }, tierWarning: null, canEdit: true, canChangeTier: true };
    expect(renderToStaticMarkup(<SectionBody {...(base as unknown as Parameters<typeof SectionBody>[0])} />)).not.toContain("DMA (TV and ad market)");
    expect(renderToStaticMarkup(<SectionBody {...({ ...base, dmaOptions: [{ id: "200811", name: "Reno NV", canonical: "Reno NV,Nevada,United States" }] } as unknown as Parameters<typeof SectionBody>[0])} />)).toContain("DMA (TV and ad market)");
    expect(renderToStaticMarkup(<SectionBody {...(base as unknown as Parameters<typeof SectionBody>[0])} />)).toContain("Counties");
  });


  it("tests the connection for admins only, showing the status and DataForSEO's reason, never the password", async () => {
    const { admin } = await projectWithIntake();
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(testDataForSeoConnection(h.ctx, pm.viewer)).rejects.toThrow(PermissionError);
    vi.stubEnv("DATAFORSEO_LIVE", "on");
    setDataForSeoFetchForTesting((async () => new Response(JSON.stringify({ status_code: 40104, status_message: "Please visit https://app.dataforseo.com/api-access to add your IP to the whitelist." }), { status: 403 })) as typeof fetch);
    const test = await testDataForSeoConnection(h.ctx, admin.viewer);
    expect(test).toMatchObject({ ok: false, httpStatus: 403, endpoint: "https://api.dataforseo.com/v3/appendix/user_data", sandbox: false });
    expect(test.message).toMatch(/HTTP 403: 40104 .*at live DataForSEO .*IP address may need adding to the allowed list/);
    expect(JSON.stringify(test)).not.toContain("sandbox-password");
  });

  it("lets PMs and SEO look up keywords, and Content only plan pages", async () => {
    const { admin, id } = await projectWithIntake();
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await expect(startKeywordResearch(h.ctx, content.viewer, id)).rejects.toThrow(PermissionError);
    await expect(makePagePlan(h.ctx, content.viewer, id)).resolves.toBeGreaterThan(0);
    const designer = await seedUser(h, admin.viewer, { email: "design@velocitymedialab.com", roles: ["web_designer"] });
    await expect(makePagePlan(h.ctx, designer.viewer, id)).rejects.toThrow(PermissionError);
  });
});

describe("the page plan", () => {
  it("is made from the research, then renamed, added to, reordered and trimmed, all logged", async () => {
    const { admin, id } = await projectWithIntake();
    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    expect(await makePagePlan(h.ctx, admin.viewer, id)).toBe(7);

    let pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    expect(pages.map((p) => p.name)).toEqual(["Home", "Drain cleaning", "Water heaters", "Service areas", "About", "FAQ", "Contact"]);
    expect(pages[1]!.mainKeyword).toBe("drain cleaning near me");

    const drain = pages[1]!;
    await savePlanPage(h.ctx, admin.viewer, id, drain.id, {
      kind: "service",
      name: "Drain Cleaning & Jetting",
      slug: "",
      mainKeyword: "Drain Cleaning Sacramento",
      supportingKeywords: "drain cleaning near me, hydro jetting",
      title: drain.title,
      metaDescription: drain.metaDescription,
      h1: drain.h1,
    });
    await expect(
      savePlanPage(h.ctx, admin.viewer, id, null, { kind: "service", name: "Drain Cleaning and Jetting", slug: "", mainKeyword: "", supportingKeywords: "", title: "", metaDescription: "", h1: "" }),
    ).rejects.toThrow("already uses the address /drain-cleaning-and-jetting");
    await savePlanPage(h.ctx, admin.viewer, id, null, { kind: "reviews", name: "Reviews", slug: "", mainKeyword: "", supportingKeywords: "", title: "", metaDescription: "", h1: "" });
    await movePlanPage(h.ctx, admin.viewer, id, drain.id, "down");
    await movePlanPage(h.ctx, admin.viewer, id, pages[0]!.id, "down");
    await expect(removePlanPage(h.ctx, admin.viewer, id, pages[0]!.id)).rejects.toThrow("Every site has a Home page");
    await removePlanPage(h.ctx, admin.viewer, id, pages.find((p) => p.name === "About")!.id);

    pages = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id)).orderBy(pagePlanPage.position);
    expect(pages.map((p) => p.name)).toEqual(["Home", "Water heaters", "Drain Cleaning & Jetting", "Service areas", "FAQ", "Contact", "Reviews"]);
    expect(pages[2]).toMatchObject({ slug: "drain-cleaning-and-jetting", mainKeyword: "drain cleaning sacramento", supportingKeywords: ["drain cleaning near me", "hydro jetting"] });

    const log = (await h.db.select().from(activityLog)).filter((a) => a.action.startsWith("content."));
    expect(log.map((a) => a.action)).toEqual(["content.plan_made", "content.plan_page_changed", "content.plan_page_added", "content.plan_reordered", "content.plan_page_removed"]);
    expect(log[1]!.valueBefore).toMatchObject({ name: "Drain cleaning" });

    // Deleting the project removes the plan, the research and the saved answers.
    await deleteProject(h.ctx, admin.viewer, id, { confirmName: lane1.clientName, reason: "Test project, not a client" });
    expect(await h.db.select().from(pagePlanPage)).toEqual([]);
    expect(await h.db.select().from(seoKeyword)).toEqual([]);
    expect((await h.db.select().from(seoDataCall)).every((c) => c.responseKey === null)).toBe(true);
    expect([...r2.objects.keys()].some((k) => k.includes("/seo/"))).toBe(false);
    // The shared cache stays: it holds no client details, and saves paying again.
    expect((await h.db.select().from(keywordMetric)).length).toBeGreaterThan(0);
  });

  it("renders the Content screen with the research and the plan, and warns past the tier", async () => {
    const { admin, id } = await projectWithIntake();
    await startKeywordResearch(h.ctx, admin.viewer, id);
    await settleKeywordResearch();
    await makePagePlan(h.ctx, admin.viewer, id);
    for (const name of ["Gallery", "Careers", "Financing", "Coupons"]) {
      await savePlanPage(h.ctx, admin.viewer, id, null, { kind: "other", name, slug: "", mainKeyword: "", supportingKeywords: "", title: "", metaDescription: "", h1: "" });
    }
    const view = await loadSeoView(h.db, admin.viewer, id);
    expect(view.tierWarning).toBe("11 pages: Starter covers up to 10. Remove 1, or talk to the client about Growth. TAWD won't change the tier.");

    state.user = admin.viewer;
    const { default: ContentPage } = await import("@/app/(app)/projects/[id]/content/page");
    const html = renderToStaticMarkup(await ContentPage({ params: Promise.resolve({ id }) }));
    expect(html).toContain("Keyword research");
    expect(html).toContain("Sandbox: test data");
    expect(html).toContain("drain cleaning near me");
    expect(html).toContain("Page plan");
    expect(html).toContain("11 pages: Starter covers up to 10");
    expect(html).not.toContain("sandbox-password");
  });
});

describe("titles", () => {
  it("never repeat the business name", () => {
    const pages = draftPagePlan({ tier: "starter", trade: "plumbing", businessName: "Sacramento Drain Pros", services: ["Drain cleaning"], areas: { ...noAreas, scope: "cities", cities: ["Sacramento"], wantsIndividualCityPages: null }, businessState: "CA", keywords: [] });
    for (const page of pages) expect(page.title.split("Sacramento Drain Pros").length).toBeLessThanOrEqual(2);
    expect(pages.find((p) => p.kind === "about")!.title).toBe("About us | Sacramento Drain Pros");
  });
});
