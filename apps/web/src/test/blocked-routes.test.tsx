import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Blocked sites (Part D, Jason 7 October 2026): Jina Reader first, Zyte
  second, then the honest fallback. Stand-ins for both services (their
  real answers' shapes), for the blocked live site and for the browser.
  No network, no paid calls.
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
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { SITE_READ_JOB, type SiteReadJobData } from "@tawd/core/queue";
import { activityLog, appSetting, pagePlanPage, siteImport, siteReadCall } from "@tawd/core/schema";
import { waysForwardFor, type ImportedPageSummary } from "@tawd/core/site";
import { ROUTE_CONSENT_OVER_USD, jinaCost, routeEstimate } from "@tawd/core/site-read";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import { setQueueForTesting } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { loadBlockedSiteSpend, setRouteCap, syncSiteRead } from "@/lib/site-read";
import { setRouteStandInsForTesting } from "../../../worker/src/blocked-routes";
import { runSiteReadJob, setSiteReadStandInsForTesting } from "../../../worker/src/site-read";
import { setLookupForTesting } from "../../../worker/src/liked-sites";
import { PAGES, SITE } from "./fixtures/keep-site";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: SiteReadJobData }[];
let calls: { service: "jina" | "zyte" | "shot"; url: string; headers: Record<string, string>; body?: Record<string, unknown> }[];

const CHECK = `<!DOCTYPE html><html><head><title>One moment, please...</title></head><body><h1>Please wait while your request is being verified...</h1></body></html>`;
const blockedLive = (async () => new Response(CHECK, { status: 202, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
const KEYS = { JINA_API_KEY: "jina_test_key_123", ZYTE_API_KEY: "zyte_test_key_456" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* The services, as their APIs answer: Jina's JSON with its token count; Zyte's browserHtml, plain body and screenshot (base64). */
function services(opts: { jina?: (path: string, headers: Record<string, string>) => Response | null; zyte?: (path: string, body: Record<string, unknown>) => Response | null } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    if (url.startsWith("https://r.jina.ai/")) {
      const target = url.slice("https://r.jina.ai/".length);
      calls.push({ service: "jina", url: target, headers });
      const path = new URL(target).pathname;
      const custom = opts.jina?.(path, headers);
      if (custom) return custom;
      if (headers["X-Return-Format"] === "screenshot") return Response.json({ code: 200, data: { screenshotUrl: "https://shots.example/home.png", usage: { tokens: 794 } } });
      const page = PAGES[path];
      if (!page) return Response.json({ code: 200, status: 20000, data: { html: "<h1>Not found</h1>", title: "Not found", httpStatus: 404, usage: { tokens: 100 } } });
      return Response.json({ code: 200, status: 20000, data: { html: page, title: "Acme", url: target, httpStatus: 200, usage: { tokens: path === "/" ? 1_600_000 : 40_000 } }, meta: { usage: { tokens: path === "/" ? 1_600_000 : 40_000 } } });
    }
    if (url === "https://api.zyte.com/v1/extract") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ service: "zyte", url: String(body.url), headers, body });
      const path = new URL(String(body.url)).pathname;
      const custom = opts.zyte?.(path, body);
      if (custom) return custom;
      if (body.httpResponseBody) return Response.json({ url: body.url, statusCode: 404, httpResponseBody: Buffer.from("Not found").toString("base64") });
      const page = PAGES[path];
      return Response.json({ url: body.url, statusCode: page ? 200 : 404, browserHtml: page ?? "<h1>Not found</h1>", ...(body.screenshot ? { screenshot: PNG.toString("base64") } : {}) });
    }
    if (url === "https://shots.example/home.png") {
      calls.push({ service: "shot", url, headers });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected request in a test: ${url}`);
  }) as typeof fetch;
}

const htmlLook = async () => ({
  title: "Acme Pest Control",
  menu: [{ label: "Home", href: `${SITE}/` }],
  sections: [{ kind: "hero" as const, heading: "Family-Owned Pest Control in Folsom", words: "Family-Owned Pest Control in Folsom." }],
  phones: ["(916) 555-0142"],
  testimonials: [],
  look: { colours: ["#1f4e2c"], fonts: ["Poppins"], screenshotKey: null },
});

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  calls = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as SiteReadJobData }), getJob: async () => null });
  setLookupForTesting(async () => ["93.184.216.34"]);
  setSiteReadStandInsForTesting({ fetch: blockedLive, wait: async () => undefined, look: async () => Promise.reject(new Error("the live look must not run on a blocked site")) });
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

async function seed() {
  const admin = await seedAdmin(h);
  state.user = admin.viewer;
  const id = await createProject(h.ctx, admin.viewer, lane1);
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Acme Pest Control", phone: "(916) 555-0142", city: "Folsom", state: "CA" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "website", { currentWebsiteUrl: "https://acmepest.example" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "content", { mode: "keep" });
  return { admin, id };
}

async function read(id: string) {
  await syncSiteRead(h.ctx, id);
  await runSiteReadJob(queued.filter((q) => q.name === SITE_READ_JOB).at(-1)!.data);
  const [row] = await h.db.select().from(siteImport).where(eq(siteImport.projectId, id));
  return row!;
}

const ledger = async (id: string) => h.db.select().from(siteReadCall).where(eq(siteReadCall.projectId, id));

describe("the costs and the rule of $1", () => {
  it("Jina's price is per token; a whole Pro site is well under $1, so it runs by itself", () => {
    expect(jinaCost(1_000_000)).toBeCloseTo(0.05);
    expect(routeEstimate("jina", 50)).toBeLessThan(ROUTE_CONSENT_OVER_USD);
    expect(routeEstimate("zyte", 50)).toBeLessThan(ROUTE_CONSENT_OVER_USD);
  });
});

describe("Jina Reader first", () => {
  it("reads a blocked site: the home page's HTML for the look and a screenshot, the other pages trimmed, a few at once; each call priced from Jina's own token count; the key never saved", async () => {
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { JINA_API_KEY: KEYS.JINA_API_KEY } });
    const { id } = await seed();
    const row = await read(id);
    expect(row.status).toBe("done");
    const pages = row.pages as ImportedPageSummary[];
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.every((p) => p.readFrom === "fallback" && p.via === "jina")).toBe(true);
    // The look: from Jina's HTML, with Jina's screenshot in R2.
    expect(row.home).toMatchObject({ sections: [{ kind: "hero" }], look: { colours: ["#1f4e2c"], screenshotKey: `projects/${id}/site-import/${row.id}/home.png` } });
    expect(r2.objects.has(`projects/${id}/site-import/${row.id}/home.png`)).toBe(true);
    // The home page's HTML is asked once (the look's answer is reused); inner pages without scripts and styles.
    const jina = calls.filter((c) => c.service === "jina");
    expect(jina.filter((c) => new URL(c.url).pathname === "/" && c.headers["X-Return-Format"] === "html")).toHaveLength(1);
    expect(jina.filter((c) => new URL(c.url).pathname !== "/").every((c) => c.headers["X-Remove-Selector"]?.includes("style"))).toBe(true);
    // The canonical link stays, so the SEO suggestions can see it (0.99.0).
    expect(jina.filter((c) => new URL(c.url).pathname !== "/").every((c) => c.headers["X-Remove-Selector"]?.includes('link:not([rel~="canonical"])'))).toBe(true);
    expect(jina.every((c) => c.headers.Authorization === `Bearer ${KEYS.JINA_API_KEY}` && Number(c.headers["X-Token-Budget"]) > 0)).toBe(true);
    // Every call in the ledger, priced from Jina's count.
    const rows = await ledger(id);
    const home = rows.find((r) => r.kind === "home")!;
    expect(home).toMatchObject({ route: "jina", tokens: 1_600_000, estimated: false, ok: true });
    expect(home.costUsd).toBeCloseTo(0.08);
    expect(rows.some((r) => r.kind === "screenshot" && r.tokens === 794)).toBe(true);
    // The read is logged with its cost; the key is nowhere.
    const [logged] = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.blocked_site_read")));
    expect((logged!.valueAfter as { routes: { route: string }[] }).routes[0]!.route).toBe("Jina Reader (blocked site)");
    expect(JSON.stringify(await h.db.select().from(activityLog))).not.toContain(KEYS.JINA_API_KEY);
    expect(JSON.stringify(rows)).not.toContain(KEYS.JINA_API_KEY);
    // The keep project's plan made itself from the pages Jina gave.
    expect((await h.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, id))).length).toBe(pages.length);
    const content = renderToStaticMarkup((await ContentPage({ params: Promise.resolve({ id }) } as never)) as React.ReactElement);
    expect(content).toContain("read through Jina Reader for acmepest.example");
  });

  it("stops a read at the amount agreed for it, not only at the route's monthly cap (13 October 2026)", async () => {
    // Jina charges far more than its estimate for the home page (25 million tokens, $1.25): nothing more is asked after it.
    setRouteStandInsForTesting({
      fetch: services({ jina: (path, headers) => (path === "/" && headers["X-Return-Format"] !== "screenshot" ? Response.json({ code: 200, status: 20000, data: { html: PAGES["/"], title: "Acme", httpStatus: 200, usage: { tokens: 25_000_000 } } }) : null) }),
      htmlLook,
      env: { JINA_API_KEY: KEYS.JINA_API_KEY },
    });
    const { id } = await seed();
    await read(id);
    const spent = (await ledger(id)).reduce((sum, c) => sum + Number(c.costUsd), 0);
    expect(spent).toBeGreaterThan(ROUTE_CONSENT_OVER_USD);
    // Only calls already under way when the home page's cost came in; none started after.
    expect((await ledger(id)).length).toBeLessThanOrEqual(2);
  });

  it("Jina out of credit (402): never \"try later\"; with no second route the read fails with the reason and the ways forward", async () => {
    setRouteStandInsForTesting({ fetch: services({ jina: () => new Response("Insufficient balance", { status: 402 }) }), htmlLook, env: { JINA_API_KEY: KEYS.JINA_API_KEY } });
    const { id } = await seed();
    const row = await read(id);
    expect(row.status).toBe("failed");
    // The reason names what to do (Fable H3): the balance, where to top it up.
    expect(row.failureReason).toMatch(/^acmepest\.example blocks TAWD's server .* Reading again won't change that\. Jina Reader couldn't read it either\. Jina Reader's balance is used up \(402\): top it up on jina\.ai \(API key & billing\)\. Zyte isn't set up \(no key on the worker\)\.$/);
    const stopped = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.blocked_route_stopped")));
    expect(stopped).toHaveLength(1);
    expect(row.failureReason).not.toMatch(/later/i);
    expect(waysForwardFor(row.failureReason)).toHaveLength(2);
    // 402 stops the route for the rest of the read: one call, not one per page.
    expect(calls.filter((c) => c.service === "jina")).toHaveLength(1);
  });

  it("past its monthly cap Jina isn't called: the activity log says so once, and the read goes on through Zyte", async () => {
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: KEYS });
    const { id } = await seed();
    await h.db.insert(siteReadCall).values({ projectId: id, route: "jina", kind: "page", url: "x", tokens: 100_000_000, costUsd: 5, ok: true });
    const row = await read(id);
    expect(row.status).toBe("done");
    expect(calls.filter((c) => c.service === "jina")).toHaveLength(0);
    expect((row.pages as ImportedPageSummary[]).every((p) => p.via === "zyte")).toBe(true);
    const capped = await h.db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "content.blocked_route_capped")));
    expect(capped).toHaveLength(1);
    expect(capped[0]!.valueAfter).toMatchObject({ route: "Jina Reader (blocked site)", capUsd: 5 });
  });
});

describe("Zyte second", () => {
  it("gives the pages Jina couldn't (a bot check inside Jina's answer), priced by TAWD's estimate", async () => {
    setRouteStandInsForTesting({
      fetch: services({ jina: (path) => (path === "/about-us/" ? Response.json({ code: 200, data: { html: CHECK, title: "One moment, please...", httpStatus: 202, usage: { tokens: 300 } } }) : null) }),
      htmlLook,
      env: KEYS,
    });
    const { id } = await seed();
    const row = await read(id);
    const pages = row.pages as ImportedPageSummary[];
    expect(pages.find((p) => p.path === "/about-us/")!.via).toBe("zyte");
    expect(pages.find((p) => p.path === "/ant-control/")!.via).toBe("jina");
    const zyte = (await ledger(id)).filter((r) => r.route === "zyte" && r.kind === "page" && r.url.endsWith("/about-us/"));
    expect(zyte[0]).toMatchObject({ costUsd: 0.004, estimated: true, ok: true });
    const call = calls.find((c) => c.service === "zyte" && c.url.endsWith("/about-us/"))!;
    expect(call.headers.Authorization).toBe(`Basic ${Buffer.from(`${KEYS.ZYTE_API_KEY}:`).toString("base64")}`);
    expect(call.body).toMatchObject({ browserHtml: true });
  });

  it("reads the whole site when Jina isn't set up: the home page with browserHtml and a screenshot, sitemaps as the plain body", async () => {
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { ZYTE_API_KEY: KEYS.ZYTE_API_KEY } });
    const { id } = await seed();
    const row = await read(id);
    expect(row.status).toBe("done");
    expect(calls.some((c) => c.service === "zyte" && c.body?.screenshot === true && new URL(c.url).pathname === "/")).toBe(true);
    expect(calls.some((c) => c.service === "zyte" && c.body?.httpResponseBody === true && /robots\.txt|sitemap/.test(c.url))).toBe(true);
    expect((row.home as { look: { screenshotKey: string } }).look.screenshotKey).toBe(`projects/${id}/site-import/${row.id}/home.png`);
  });

  it("both over their caps: the read fails saying so, with the ways forward", async () => {
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: KEYS });
    const { id } = await seed();
    await h.db.insert(siteReadCall).values([
      { projectId: id, route: "jina", kind: "page", url: "x", costUsd: 5, ok: true },
      { projectId: id, route: "zyte", kind: "page", url: "x", costUsd: 5, ok: true },
    ]);
    const row = await read(id);
    expect(row.status).toBe("failed");
    expect(row.failureReason).toContain("Jina Reader has reached this month's cap of $5.00: an admin can raise it on Spend.");
    expect(row.failureReason).toContain("Zyte has reached this month's cap of $5.00: an admin can raise it on Spend.");
    expect(calls).toHaveLength(0);
  });
});

describe("Spend", () => {
  it("lists each route against its cap and the calls by project; only admins change a cap, logged", async () => {
    setRouteStandInsForTesting({ fetch: services(), htmlLook, env: { JINA_API_KEY: KEYS.JINA_API_KEY } });
    const { admin, id } = await seed();
    await read(id);
    const today = new Date().toISOString().slice(0, 10);
    const spend = await loadBlockedSiteSpend(h.db as Database, admin.viewer, { from: "2000-01-01", to: today > "2099" ? today : "2099-12-31" });
    expect(spend.routes.map((r) => [r.label, r.cap.dollars])).toEqual([["Jina Reader (blocked site)", 5], ["Zyte (blocked site)", 5]]);
    expect(spend.byProject[0]).toMatchObject({ name: "Acme Pest Control", route: "Jina Reader (blocked site)" });
    expect(spend.total).toBeGreaterThan(0.08);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(setRouteCap(h.ctx, pm.viewer, "jina", 10)).rejects.toThrow(/Not allowed/);
    await setRouteCap(h.ctx, admin.viewer, "jina", 10);
    const [setting] = await h.db.select().from(appSetting).where(eq(appSetting.key, "blocked_route_cap_jina"));
    expect(setting!.value).toEqual({ dollars: 10 });
    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "settings.blocked_route_cap_changed"));
    expect(logged).toHaveLength(1);
  });
});
