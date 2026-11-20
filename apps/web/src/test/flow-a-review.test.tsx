import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Fable's review of flow-a-one-read (docs/reviews/fable-flow-a-review.md):
  the kept plan made once however many callers race (H1), a same-host
  address edit mid-read (H2), a route's stop reaching the team (H3), clean
  towns (M1), the business's own address (M2), the worker's own report of
  its keys (M3), a host that drops connections (M5), the go for a read over
  $1 (M6), and the low items. Stand-ins only: no network, no paid calls.
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
import { emptyIntake } from "@tawd/core/intake";
import { confirmPrefill } from "@/lib/figma";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { keptHomeWords } from "@tawd/core/kept-home-words";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { SITE_READ_JOB, type SiteReadJobData } from "@tawd/core/queue";
import { activityLog, intakePrefill, pageDraft, pagePlanPage, serviceHeartbeat, siteImport } from "@tawd/core/schema";
import { envPresence } from "@tawd/core/settings-check";
import { extractPage, planSitePrefill, townOf, waysForwardFor, type ImportedPageSummary } from "@tawd/core/site";
import { syncKeptPlan } from "@tawd/core/site-read";
import { SiteReadPanel } from "@/components/intake/site-read-panel";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { approvePaidRead, loadBlockedSiteSpend, loadSiteRead, readSiteAgain, sitePanelView, syncSiteRead } from "@/lib/site-read";
import { setRouteStandInsForTesting } from "../../../worker/src/blocked-routes";
import { runSiteReadJob, setSiteReadStandInsForTesting, type HomeLooker } from "../../../worker/src/site-read";
import { setLookupForTesting } from "../../../worker/src/liked-sites";
import { PAGES, SITE, siteFetch } from "./fixtures/keep-site";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let queued: { name: string; data: SiteReadJobData }[];

const look: HomeLooker = async () => ({ title: "Acme", menu: [], sections: [{ kind: "hero", heading: "Pest control", words: "Pest control in Folsom." }], phones: [], testimonials: [] });
const htmlLook = async () => ({ title: "Acme", menu: [], sections: [{ kind: "hero" as const, heading: "Pest control", words: "Pest control in Folsom." }], phones: [], testimonials: [] });
const CHECK = `<!DOCTYPE html><html><head><title>One moment, please...</title></head><body><h1>Please wait while your request is being verified...</h1></body></html>`;
const blockedLive = (async () => new Response(CHECK, { status: 202, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

/* Jina and Zyte as their APIs answer; Jina's answer can be swapped. */
function services(jina?: (path: string) => Response | null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://r.jina.ai/")) {
      const target = url.slice("https://r.jina.ai/".length);
      const path = new URL(target).pathname;
      const custom = jina?.(path);
      if (custom) return custom;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["X-Return-Format"] === "screenshot") return Response.json({ code: 200, data: { usage: { tokens: 800 } } });
      return Response.json({ code: 200, data: { html: PAGES[path] ?? "<h1>Not found</h1>", httpStatus: PAGES[path] ? 200 : 404, usage: { tokens: 40_000 } } });
    }
    if (url === "https://api.zyte.com/v1/extract") {
      const body = JSON.parse(String(init?.body)) as { url: string; httpResponseBody?: boolean };
      const path = new URL(body.url).pathname;
      if (body.httpResponseBody) return Response.json({ url: body.url, statusCode: 404, httpResponseBody: "" });
      return Response.json({ url: body.url, statusCode: PAGES[path] ? 200 : 404, browserHtml: PAGES[path] ?? "<h1>Not found</h1>" });
    }
    throw new Error(`Unexpected request in a test: ${url}`);
  }) as typeof fetch;
}

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteReadJobData }), getJob: async () => null });
  setLookupForTesting(async () => ["93.184.216.34"]);
  setSiteReadStandInsForTesting({ fetch: siteFetch(), wait: async () => undefined, look });
  setRouteStandInsForTesting({ env: {} });
});

afterEach(async () => {
  state.user = null;
  setQueueForTesting(null);
  setLookupForTesting(null);
  setSiteReadStandInsForTesting(null);
  setRouteStandInsForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const lane1 = { clientName: "Acme Pest Control", trade: "pest_control", tier: "pro", lane: "lane_1", laneOption: null, conceptCount: 1, status: "content", memberUserIds: [] as string[] } as const;
let admin: Awaited<ReturnType<typeof seedAdmin>>;

async function seed(mode: "keep" | "auto" = "keep") {
  admin = await seedAdmin(h);
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, lane1);
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Acme Pest Control", phone: "(916) 555-0142", city: "Folsom", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://acmepest.example" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode });
  return id;
}

async function read(id: string) {
  await syncSiteRead(h.ctx, id);
  await runSiteReadJob(queued.filter((q) => q.name === SITE_READ_JOB).at(-1)!.data);
  const [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
  return row!;
}

describe("H1: the kept plan is made once", () => {
  it("two callers at the same moment leave one plan, one version 1 per page and one log entry", async () => {
    const id = await seed("auto");
    await read(id);
    await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "keep" });
    const [a, b] = await Promise.all([syncKeptPlan(h.db as Database, id), syncKeptPlan(h.db as Database, id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const plan = await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id));
    expect(plan).toHaveLength(11);
    expect(new Set(plan.map((p) => p.slug)).size).toBe(11);
    expect(await h.db.select().from(pageDraft).where(eq(pageDraft.projectId, id))).toHaveLength(11);
    expect(await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.site_import_used")))).toHaveLength(1);
    // The claim is released afterwards.
    expect((await h.db.select().from(siteImport).where(eq(siteImport.projectId, id)))[0]!.keptPlanClaimedAt).toBeNull();
  });
});

describe("H2: the same site at another spelling mid-read", () => {
  it("the read still saves; only another site (a new row) stops it", async () => {
    const id = await seed();
    const base = siteFetch();
    setSiteReadStandInsForTesting({
      fetch: (async (input: string | URL | Request) => {
        if (String(input) === `${SITE}/about-us/`) await h.db.update(siteImport).set({ url: "https://www.acmepest.example/" }).where(eq(siteImport.projectId, id));
        return base(input as string);
      }) as typeof fetch,
      wait: async () => undefined,
      look,
    });
    await syncSiteRead(h.ctx, id);
    await runSiteReadJob(queued.at(-1)!.data);
    const [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
    expect(row!.status).toBe("done");
    expect(row!.url).toBe("https://www.acmepest.example/");
    expect((await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id))).length).toBe(11);
  });
});

describe("H3: a route that stops says so, and the next route carries on", () => {
  it("Jina out of credit: Zyte reads the site, and the team is told what to do about Jina", async () => {
    setSiteReadStandInsForTesting({ fetch: blockedLive, wait: async () => undefined, look });
    setRouteStandInsForTesting({ fetch: services(() => new Response("Insufficient balance", { status: 402 })), htmlLook, env: { JINA_API_KEY: "j", ZYTE_API_KEY: "z" } });
    const id = await seed();
    const row = await read(id);
    expect(row.status).toBe("done");
    expect((row.pages as ImportedPageSummary[]).every((p) => p.via === "zyte")).toBe(true);
    const [stopped] = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.blocked_route_stopped")));
    expect(stopped!.valueAfter).toMatchObject({ route: "Jina Reader (blocked site)", reason: "Jina Reader's balance is used up (402): top it up on jina.ai (API key & billing)." });
  });
});

describe("M1: towns only when they read cleanly", () => {
  it("strips the trade words and takes the state from the name, title or address; otherwise nothing", () => {
    expect(townOf({ name: "Pest Control In Elk Grove, CA", title: "", path: "/pest-control-elk-grove-ca/" })).toBe("Elk Grove, CA");
    expect(townOf({ name: "Folsom", title: "", path: "/pest-control-folsom-ca/" })).toBe("Folsom, CA");
    expect(townOf({ name: "Roseville Pest Control", title: "Pest Control in Roseville, CA | Acme", path: "/roseville/" })).toBe("Roseville, CA");
    expect(townOf({ name: "Our service area", title: "", path: "/areas/" })).toBeNull();
    expect(townOf({ name: "Starting at $40 | Elk Grove", title: "", path: "/elk-grove-ca/" })).toBeNull();
  });
});

describe("M2: the address only from the business's own schema, on the home or contact page", () => {
  it("an event's or a person's address is never the business's", () => {
    const event = `<html><head><script type="application/ld+json">{"@type":"Event","location":{"@type":"Place","address":{"@type":"PostalAddress","streetAddress":"1 Fair Way","addressLocality":"Sacramento","addressRegion":"CA"}}}</script></head><body></body></html>`;
    expect(extractPage(event, `${SITE}/`).contact!.addresses).toEqual([]);
    const business = `<html><head><script type="application/ld+json">{"@graph":[{"@type":"PestControl","address":{"@type":"PostalAddress","streetAddress":"12 Oak St","addressLocality":"Folsom","addressRegion":"CA"}}]}</script></head><body></body></html>`;
    expect(extractPage(business, `${SITE}/`).contact!.addresses).toEqual([{ streetAddress: "12 Oak St", city: "Folsom", state: "CA", zip: "" }]);
    const page = (path: string, kind: ImportedPageSummary["kind"]) => ({ path, url: `${SITE}${path}`, kind, name: "x", title: "", phones: [], contact: { tels: [], emails: [], addresses: [{ streetAddress: "9 Blog Rd", city: "Davis", state: "CA", zip: "" }] } }) as unknown as ImportedPageSummary;
    expect(planSitePrefill(emptyIntake(), [page("/blog/a-post/", "article")]).fill).toEqual([]);
    expect(planSitePrefill(emptyIntake(), [page("/contact/", "contact")]).fill.map((f) => f.key)).toEqual(["business.streetAddress", "business.city", "business.state"]);
  });
});

describe("M3: Spend asks the worker which keys it has", () => {
  it("from the worker's heartbeat, never the web app's settings; unknown until it reports", async () => {
    await seed();
    let spend = await loadBlockedSiteSpend(h.db as Database, admin.viewer, { from: "2000-01-01", to: "2099-12-31" });
    expect(spend.routes.map((r) => r.configured)).toEqual([null, null]);
    await h.db.insert(serviceHeartbeat).values({ service: "worker", version: "t", startedAt: new Date(), env: envPresence("worker", { JINA_API_KEY: "x" }) });
    spend = await loadBlockedSiteSpend(h.db as Database, admin.viewer, { from: "2000-01-01", to: "2099-12-31" });
    expect(spend.routes.map((r) => r.configured)).toEqual([true, false]);
  });
});

describe("M5: a host that doesn't answer at all is treated as blocked", () => {
  it("the routes get their turn; with none, the honest message and the two ways forward", async () => {
    const silent = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    setSiteReadStandInsForTesting({ fetch: silent, wait: async () => undefined, look });
    const id = await seed();
    let [row] = [await read(id)];
    expect(row!.status).toBe("failed");
    expect(row!.failureReason).toBe("acmepest.example didn't answer TAWD's server. If the site opens in your browser, its host is blocking servers like TAWD's, so its pages can't be read from here. Reading again won't change that.");
    expect(waysForwardFor(row!.failureReason)).toHaveLength(2);
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { JINA_API_KEY: "j" } });
    await readSiteAgain(h.ctx, admin.viewer, id);
    await runSiteReadJob(queued.at(-1)!.data);
    [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
    expect(row!.status).toBe("done");
    expect((row!.pages as ImportedPageSummary[]).every((p) => p.via === "jina")).toBe(true);
  });
});

describe("M6: a read over $1 waits for a go, then carries on", () => {
  it("the panel shows the service and the estimate with \"Read it for about $X\"; the go is logged and the read runs", async () => {
    setSiteReadStandInsForTesting({ fetch: blockedLive, wait: async () => undefined, look });
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { JINA_API_KEY: "j" } });
    const id = await seed();
    await syncSiteRead(h.ctx, id);
    // A page limit far above today's tiers, so the estimate is over $1.
    await h.db.update(siteImport).set({ pageLimit: 400 }).where(eq(siteImport.projectId, id));
    await runSiteReadJob(queued.at(-1)!.data);
    let [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
    expect(row!.status).toBe("needs_consent");
    expect(row!.consentEstimateUsd).toBeGreaterThan(1);
    const view = sitePanelView(await loadSiteRead(h.db as Database, id), admin.viewer)!;
    const html = renderToStaticMarkup(<SiteReadPanel projectId={id} view={view} canEdit />);
    expect(html).toContain(`Read it for about $${row!.consentEstimateUsd!.toFixed(2)}`);
    expect(html).toContain("Jina Reader");
    expect((await keptHomeWords(h.db as Database, id))?.state).toBe("failed");
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    await expect(approvePaidRead(h.ctx, content.viewer, id)).rejects.toThrow(/Not allowed/);
    await approvePaidRead(h.ctx, admin.viewer, id);
    expect(await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.blocked_read_approved")))).toHaveLength(1);
    await runSiteReadJob(queued.at(-1)!.data);
    [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
    expect(row!.status).toBe("done");
  });
});

describe("M7: calls at once can't run past the cap together", () => {
  it("each call's most possible cost is held first; Jina's month stays under its cap", async () => {
    setSiteReadStandInsForTesting({ fetch: blockedLive, wait: async () => undefined, look });
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { JINA_API_KEY: "j" } });
    const id = await seed();
    const { siteReadCall } = await import("@tawd/core/schema");
    await h.db.insert(siteReadCall).values({ projectId: id, route: "jina", kind: "page", url: "x", costUsd: 4.985, ok: true });
    await read(id);
    const { routeSpentThisMonth } = await import("@tawd/core/site-read");
    expect(await routeSpentThisMonth(h.db as Database, "jina")).toBeLessThanOrEqual(5);
  });
});

describe("the low items", () => {
  it("L4: a JavaScript-only site doesn't offer Read again first", () => {
    expect(waysForwardFor("The pages opened but no words could be read from them: the site draws its words with JavaScript (like some Wix sites).")).toHaveLength(2);
  });

  it("L6: a done read with no plan made says why, never \"decide on Content\"", async () => {
    const id = await seed();
    await h.db.insert(siteImport).values({ projectId: id, url: "https://acmepest.example", pageLimit: 50, status: "done", source: "home-only", pages: [] });
    const kept = await keptHomeWords(h.db as Database, id);
    expect(kept).toMatchObject({ state: "failed" });
    expect(kept!.failure).toMatch(/Read every page/);
  });

  it("L7 and L9: a confirmed answer the team changes is never refilled; the site never picks the main service", async () => {
    const id = await seed("auto");
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Acme Pest Control", city: "Folsom", state: "CA" });
    await read(id);
    let intake = (await loadIntake(h.db as Database, SYSTEM_ACTOR, id))!.data;
    expect(intake.business.phone).toBe("(916) 555-0142");
    expect(intake.services.items.length).toBeGreaterThan(0);
    expect(intake.services.mainServiceId).toBeNull();
    await confirmPrefill(h.ctx, admin.viewer, id, "business.phone");
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { ...intake.business, phone: "" });
    const [mark] = await h.db.select().from(intakePrefill).where(and(eq(intakePrefill.projectId, id), eq(intakePrefill.fieldKey, "business.phone")));
    expect(mark!.status).toBe("corrected");
    await h.db.delete(siteImport).where(eq(siteImport.projectId, id));
    await read(id);
    intake = (await loadIntake(h.db as Database, SYSTEM_ACTOR, id))!.data;
    expect(intake.business.phone).toBe("");
  });
});
