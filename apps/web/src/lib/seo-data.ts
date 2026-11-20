import type { Dma } from "@tawd/core/intake";
import { after } from "next/server";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@tawd/core/db";
import {
  appSetting,
  keywordMetric,
  keywordResearch,
  pagePlanPage,
  project,
  seoDataCall,
  seoKeyword,
  siteImport,
} from "@tawd/core/schema";
import type { Tier, Trade } from "@tawd/core/enums";
import type { ImportedPageSummary } from "@tawd/core/site";
import { KEPT_ARTICLE_LIMIT, keepSiteUrl, planWork, workWords } from "@tawd/core/site-read";
import { actorFields, recordActivity, type ActivityAction } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { suppliedHomeNav } from "@tawd/core/site-read";
import { designMenuWarning, missingMenuItems } from "@/lib/design-menu";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import {
  COUNTRY,
  META_LIMIT,
  PAGE_KINDS,
  TITLE_LIMIT,
  draftPagePlan,
  estimateLookups,
  keywordPlan,
  normalizeKeyword,
  planFromNav,
  planKeywordWarning,
  planTierWarning,
  slugPath,
  tradeTerm,
  type KeywordGroup,
  type PageKind,
} from "@/lib/seo-plan";
import { pacificToday } from "@/lib/spend-report";
import type { ServiceContext } from "@/lib/users";

/*
  SEO data (Phase 7a, 26 September 2026): DataForSEO keyword research and
  the page plan.

  The login lives only in Coolify (DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD).
  It is sent to DataForSEO and nowhere else: never logged, never shown on
  a screen, never given to an AI (no AI runs in 7a at all).

  Every call goes to DataForSEO's free sandbox, whose numbers are test
  data, unless DATAFORSEO_LIVE is "on". Live lookups are paid: the
  estimate shows first, the monthly SEO data cap is checked before
  starting, and every answer is saved in R2 before it is read and
  recorded on Spend under "SEO data". keyword_metric keeps every answer,
  so the same keyword in the same place is never paid for twice.
*/

type Db = Database;

const SANDBOX_URL = "https://sandbox.dataforseo.com";
const LIVE_URL = "https://api.dataforseo.com";
const LIMIT_KEY = "monthly_seo_data_limit_usd";
export const DEFAULT_SEO_LIMIT_USD = 25;
/** A run still "working" after this long was cut off (a restart); it can be started again. */
const STALE_AFTER_MS = 15 * 60_000;

export class SeoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoDataError";
  }
}

/* ---------- the connection ---------- */

export interface SeoSetup {
  configured: boolean;
  sandbox: boolean;
  /** The Coolify variables still to add. */
  missing: string[];
}

/*
  The login as DataForSEO needs it (26 September 2026): spaces and line
  breaks around it removed, and one pair of quotes around it removed too
  (Coolify keeps quotes typed around a value, and a quoted login is refused).
  What was tidied is reported by the connection test, never the values.
*/
export function readDataForSeoLogin(): { login: string; password: string; tidied: string[] } {
  const tidied: string[] = [];
  const clean = (name: string) => {
    const raw = process.env[name] ?? "";
    let value = raw.trim();
    if (value !== raw) tidied.push(`${name} had spaces or a line break around it`);
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2]!.trim();
      tidied.push(`${name} was wrapped in quotes`);
    }
    return value;
  };
  return { login: clean("DATAFORSEO_LOGIN"), password: clean("DATAFORSEO_PASSWORD"), tidied };
}

export function seoSetup(): SeoSetup {
  const creds = readDataForSeoLogin();
  const missing = (["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] as const).filter((name) => !(name === "DATAFORSEO_LOGIN" ? creds.login : creds.password));
  return { configured: missing.length === 0, sandbox: process.env.DATAFORSEO_LIVE?.trim().toLowerCase() !== "on", missing };
}

type Fetch = typeof fetch;
let fetchOverride: Fetch | null = null;

/** Tests pass a stand-in for DataForSEO; nothing in the tests reaches it. */
export function setDataForSeoFetchForTesting(stand: Fetch | null): void {
  fetchOverride = stand;
}

interface DataForSeoAnswer {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: { status_code?: number; status_message?: string; cost?: number; result?: unknown[] | null }[];
}

async function callDataForSeo(path: string, body: unknown, method: "POST" | "GET" = "POST", forceLive = false): Promise<{ answer: DataForSeoAnswer; raw: string }> {
  const setup = seoSetup();
  // The free lists (locations) are only real on the live service.
  if (forceLive) setup.sandbox = false;
  if (!setup.configured) throw new SeoDataError(`DataForSEO isn't set up yet: add ${setup.missing.join(" and ")} in Coolify.`);
  const { login, password } = readDataForSeoLogin();
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const base = setup.sandbox ? SANDBOX_URL : LIVE_URL;
  const response = await (fetchOverride ?? fetch)(`${base}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  if (response.status === 401 || response.status === 403) throw new SeoDataError(refusalMessage(response.status, raw, base));
  if (!response.ok) throw new SeoDataError(`DataForSEO answered ${response.status}.`);
  let answer: DataForSeoAnswer;
  try {
    answer = JSON.parse(raw) as DataForSeoAnswer;
  } catch {
    throw new SeoDataError("DataForSEO's answer couldn't be read.");
  }
  return { answer, raw };
}

/*
  DataForSEO's own reason for a refusal, with the status and where the call
  went, so "refused" can be told apart: a wrong login, an IP address not on
  the account's allowed list, or an account that isn't active.
*/
function refusalMessage(status: number, raw: string, base: string): string {
  let reason = "";
  try {
    const body = JSON.parse(raw) as DataForSeoAnswer;
    reason = [body.status_code, body.status_message].filter(Boolean).join(" ");
  } catch {
    reason = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  const where = base === SANDBOX_URL ? "the sandbox (sandbox.dataforseo.com)" : "live DataForSEO (api.dataforseo.com)";
  const ip = /\bip\b|whitelist|allow/i.test(reason) ? " The server's IP address may need adding to the allowed list under API Access on DataForSEO." : "";
  return `DataForSEO refused the request (HTTP ${status}${reason ? `: ${reason}` : ""}) at ${where}.${ip || " Check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the web app in Coolify."}`;
}

/* ---------- TV markets (DMAs) for service areas ---------- */

const DMA_KEY = "dma_list";

export interface DmaMarkets {
  loadedAt: Date | null;
  dmas: Dma[];
}

/* The markets an admin loaded, for the intake's DMA choice; none hides the choice. */
export async function getDmaMarkets(db: Db): Promise<DmaMarkets> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, DMA_KEY)).limit(1);
  const value = (row?.value ?? null) as { loadedAt?: string; dmas?: Dma[] } | null;
  return { loadedAt: value?.loadedAt ? new Date(value.loadedAt) : null, dmas: value?.dmas ?? [] };
}

/*
  One free call (Jason, 27 September 2026): DataForSEO's Google Ads location
  list for the US, keeping the DMA regions. If it has none, the DMA choice
  stays hidden and counties carry on as they are.
*/
export async function loadDmaMarkets(ctx: ServiceContext, actor: Viewer): Promise<{ count: number }> {
  assertCan(actor, "settings.manage");
  const { answer } = await callDataForSeo("/v3/keywords_data/google_ads/locations/us", undefined, "GET", true);
  const problem = problemIn(answer);
  if (problem) throw new SeoDataError(`DataForSEO: ${problem}`);
  const rows = (answer.tasks?.[0]?.result ?? []) as { location_code?: number; location_name?: string; location_type?: string; country_iso_code?: string }[];
  const dmas: Dma[] = rows
    .filter((r) => /\bdma\b/i.test(r.location_type ?? "") && (r.country_iso_code ?? "US") === "US" && r.location_code && r.location_name)
    .map((r) => ({ id: String(r.location_code), name: r.location_name!.split(",")[0]!.trim(), canonical: r.location_name! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const values = { value: { loadedAt: new Date().toISOString(), dmas }, updatedByUserId: actorFields(actor).actorUserId, updatedAt: new Date() };
  await ctx.db.insert(appSetting).values({ key: DMA_KEY, ...values }).onConflictDoUpdate({ target: appSetting.key, set: values });
  await recordActivity(ctx.db, {
    action: "seo.dma_list_loaded",
    entityType: "setting",
    entityId: DMA_KEY,
    ...actorFields(actor),
    valueAfter: { count: dmas.length, locations: rows.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { count: dmas.length };
}

/* ---------- the connection test (admins) ---------- */

export interface ConnectionTest {
  /** Only the web app calls DataForSEO. */
  service: "web app";
  endpoint: string;
  sandbox: boolean;
  /** The HTTP status, or null when there was no answer at all. */
  httpStatus: number | null;
  /** DataForSEO's own status code and message. */
  dataForSeo: string | null;
  ok: boolean;
  /** The login with most of it hidden; the password is never shown, only its length. */
  login: string;
  passwordLength: number;
  tidied: string[];
  message: string;
  /**
   * The second step (5 November 2026): one real keyword lookup of the kind
   * SEO work makes, because DataForSEO's allowed-IP list refused TAWD's
   * server on real work while the free account check passed. null when the
   * account check already failed.
   */
  dataCall: { endpoint: string; ok: boolean; message: string; costUsd: number } | null;
}

/* The test's real lookup: one keyword's difficulty, about $0.01 on the live service, free in the sandbox. */
export const TEST_LOOKUP_PATH = "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live";
export const TEST_LOOKUP_ESTIMATE_USD = 0.0101;

const mask = (login: string) => (login.length <= 4 ? "*".repeat(login.length) : `${login.slice(0, 2)}${"*".repeat(Math.max(3, login.length - 4))}${login.slice(-2)}`);

/*
  The same free request as "curl -u login:password .../v3/appendix/user_data",
  made from the server with the server's settings: the exact endpoint, the
  HTTP status and DataForSEO's reason. Never the password. Then one real
  lookup of the kind keyword research makes (one keyword's difficulty,
  about a cent live): the free check passed on 4 November 2026 while
  DataForSEO's allowed-IP list refused every real call from the server.
*/
export async function testDataForSeoConnection(ctx: ServiceContext, actor: Viewer): Promise<ConnectionTest> {
  assertCan(actor, "settings.manage");
  const setup = seoSetup();
  const creds = readDataForSeoLogin();
  const endpoint = `${setup.sandbox ? SANDBOX_URL : LIVE_URL}/v3/appendix/user_data`;
  const base = { service: "web app" as const, endpoint, sandbox: setup.sandbox, login: mask(creds.login), passwordLength: creds.password.length, tidied: creds.tidied };
  if (!setup.configured) {
    return { ...base, httpStatus: null, dataForSeo: null, ok: false, dataCall: null, message: `Not set up: add ${setup.missing.join(" and ")} to the web app in Coolify.` };
  }
  let result: ConnectionTest;
  try {
    const response = await (fetchOverride ?? fetch)(endpoint, {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let body: DataForSeoAnswer | null = null;
    try {
      body = JSON.parse(raw) as DataForSeoAnswer;
    } catch {
      body = null;
    }
    const dataForSeo = body ? [body.status_code, body.status_message].filter(Boolean).join(" ") || null : null;
    const ok = response.ok && body?.status_code === 20000;
    result = {
      ...base,
      httpStatus: response.status,
      dataForSeo,
      ok,
      dataCall: null,
      message: ok ? "Connected: DataForSEO accepted the login." : response.status === 401 || response.status === 403 ? refusalMessage(response.status, raw, setup.sandbox ? SANDBOX_URL : LIVE_URL) : `DataForSEO answered HTTP ${response.status}${dataForSeo ? `: ${dataForSeo}` : ""}.`,
    };
  } catch (error) {
    result = { ...base, httpStatus: null, dataForSeo: null, ok: false, dataCall: null, message: `No answer from DataForSEO: ${error instanceof Error ? error.message : "unknown error"}.` };
  }
  if (result.ok) {
    const lookupEndpoint = `${setup.sandbox ? SANDBOX_URL : LIVE_URL}${TEST_LOOKUP_PATH}`;
    try {
      const { answer } = await callDataForSeo(TEST_LOOKUP_PATH, [{ keywords: ["plumber"], location_name: COUNTRY, language_name: "English" }]);
      const problem = problemIn(answer);
      const costUsd = setup.sandbox ? 0 : Number(answer.cost ?? 0);
      result.dataCall = { endpoint: lookupEndpoint, ok: !problem, costUsd, message: problem ? `A real keyword lookup failed: ${problem}${/\bip\b|whitelist|allow/i.test(problem) ? " The server's IP address (203.0.113.10) needs adding to the allowed list under API Access on DataForSEO." : ""}` : `A real keyword lookup worked${costUsd ? ` (cost $${costUsd.toFixed(4)})` : setup.sandbox ? " (sandbox, free)" : ""}.` };
    } catch (error) {
      result.dataCall = { endpoint: lookupEndpoint, ok: false, costUsd: 0, message: `A real keyword lookup failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    if (!result.dataCall.ok) {
      result.ok = false;
      result.message = `DataForSEO accepted the login, but real SEO work would fail. ${result.dataCall.message}`;
    }
  }
  await recordActivity(ctx.db, {
    action: "seo.connection_tested",
    entityType: "setting",
    entityId: "dataforseo",
    ...actorFields(actor),
    valueAfter: { endpoint, httpStatus: result.httpStatus, ok: result.ok, dataForSeo: result.dataForSeo, ...(result.dataCall ? { lookup: { ok: result.dataCall.ok, costUsd: result.dataCall.costUsd } } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return result;
}

/*
  DataForSEO's "20000" means OK.

  A queued job answers 20100, "Task Created." — its success code for "your
  crawl is on its way", not a fault (9 November 2026: the full SEO audit
  treated it as one, so every audit failed at the crawl step showing
  "DataForSEO: Task Created." as its reason, while the crawl itself was
  created and billed and then abandoned. The test stand-in had answered
  20000 to task_post, which the live service never does).
*/
const TASK_CREATED = 20100;

function problemIn(answer: DataForSeoAnswer): string | null {
  if (answer.status_code !== 20000) return answer.status_message ?? `DataForSEO status ${answer.status_code ?? "unknown"}.`;
  const task = answer.tasks?.[0];
  if (!task) return "DataForSEO returned no result.";
  if (task.status_code !== 20000 && task.status_code !== TASK_CREATED) {
    return task.status_message ?? `DataForSEO task status ${task.status_code ?? "unknown"}.`;
  }
  return null;
}

/* ---------- the SEO data cap ---------- */

export async function getSeoLimit(db: Db): Promise<{ dollars: number; isDefault: boolean }> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, LIMIT_KEY)).limit(1);
  const value = row ? Number((row.value as { dollars?: number }).dollars) : NaN;
  return Number.isFinite(value) && value > 0 ? { dollars: value, isDefault: false } : { dollars: DEFAULT_SEO_LIMIT_USD, isDefault: true };
}

export async function setSeoLimit(ctx: ServiceContext, actor: Viewer, dollars: number): Promise<void> {
  assertCan(actor, "settings.manage");
  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 10_000) throw new SeoDataError("Enter a monthly SEO data cap in dollars, above $0.");
  const rounded = Math.round(dollars * 100) / 100;
  const before = await getSeoLimit(ctx.db);
  if (!before.isDefault && before.dollars === rounded) return;
  const values = { value: { dollars: rounded }, updatedByUserId: actorFields(actor).actorUserId, updatedAt: new Date() };
  await ctx.db.insert(appSetting).values({ key: LIMIT_KEY, ...values }).onConflictDoUpdate({ target: appSetting.key, set: values });
  await recordActivity(ctx.db, {
    action: "settings.seo_limit_changed",
    entityType: "setting",
    entityId: LIMIT_KEY,
    ...actorFields(actor),
    valueBefore: { dollars: before.dollars, default: before.isDefault },
    valueAfter: { dollars: rounded },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The first day of this month, Pacific, as a timestamp. */
function monthStart(now = new Date()): Date {
  const [y, m] = pacificToday(now).split("-").map(Number) as [number, number];
  // Midnight Pacific is 07:00 or 08:00 UTC; 07:00 on the 1st is never in the month before.
  return new Date(Date.UTC(y, m - 1, 1, 7));
}

/** Paid DataForSEO spend this month (sandbox calls are free and don't count). */
export async function seoSpendThisMonth(db: Db, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${seoDataCall.costUsd}), 0)` })
    .from(seoDataCall)
    .where(and(eq(seoDataCall.sandbox, false), gte(seoDataCall.createdAt, monthStart(now))));
  return Number(row?.total ?? 0);
}

/* ---------- keyword research ---------- */

interface ResearchInputs {
  trade: Trade;
  tier: Tier;
  businessName: string;
  businessState: string | null;
  services: string[];
  areas: NonNullable<Awaited<ReturnType<typeof loadIntake>>>["data"]["serviceAreas"];
  businessCity: string | null;
  pageFacts: { about: boolean; faq: boolean };
}

/*
  Whether the intake has anything true for an About page and a FAQ page
  (8 October 2026): About with the year, licences, certifications or the
  team's own photos; FAQ with at least two answers to give (how booking,
  quotes, hours, guarantees, emergencies or the areas work).
*/
export function pageFactsOf(data: NonNullable<Awaited<ReturnType<typeof loadIntake>>>["data"]): { about: boolean; faq: boolean } {
  const b = data.business;
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined && v !== false);
  const about = [b.yearFounded, b.licenseNumbers, b.certifications].some(has);
  const answers = [data.process.scheduling, data.process.quotingAndPricing, data.process.guarantees, b.hours, b.emergency247, data.serviceAreas.cities].filter(has).length;
  return { about, faq: answers >= 2 };
}

async function researchInputs(db: Db, viewer: Viewer, projectId: string): Promise<ResearchInputs> {
  const [row] = await db.select({ trade: project.trade, tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new SeoDataError("That project no longer exists.");
  const intake = await loadIntake(db, viewer, projectId);
  if (!intake) throw new SeoDataError("That project has no intake yet.");
  const items = intake.data.services.items;
  const main = items.find((s) => s.id === intake.data.services.mainServiceId);
  const ordered = main ? [main, ...items.filter((s) => s !== main)] : items;
  return {
    trade: row.trade as Trade,
    tier: row.tier as Tier,
    businessName: intake.data.business.name,
    businessState: intake.data.business.state || null,
    services: ordered.map((s) => s.name),
    areas: intake.data.serviceAreas,
    businessCity: intake.data.business.city || null,
    pageFacts: pageFactsOf(intake.data),
  };
}

function plan(inputs: ResearchInputs): KeywordGroup[] {
  return keywordPlan({ trade: inputs.trade, services: inputs.services, areas: inputs.areas, businessState: inputs.businessState });
}

async function cachedMetrics(db: Db, groups: KeywordGroup[], sandbox: boolean) {
  const places = groups.map((g) => g.place);
  const keywords = [...new Set(groups.flatMap((g) => g.keywords.map((k) => k.keyword)))];
  if (keywords.length === 0) return new Map<string, typeof keywordMetric.$inferSelect>();
  const rows = await db
    .select()
    .from(keywordMetric)
    .where(and(eq(keywordMetric.sandbox, sandbox), inArray(keywordMetric.place, [...places, COUNTRY]), inArray(keywordMetric.keyword, keywords)));
  return new Map(rows.map((r) => [`${r.place}|${r.keyword}`, r]));
}

/* What a run would look up, and what it would cost; cached keywords are free. */
async function measurePlan(db: Db, groups: KeywordGroup[], sandbox: boolean) {
  const cache = await cachedMetrics(db, groups, sandbox);
  const uncached = groups.map((g) => ({ place: g.place, uncached: g.keywords.filter((k) => !cache.get(`${g.place}|${k.keyword}`)?.volumeFetchedAt).length }));
  const allKeywords = [...new Set(groups.flatMap((g) => g.keywords.map((k) => k.keyword)))];
  const difficultyMissing = allKeywords.filter((k) => cache.get(`${COUNTRY}|${k}`)?.difficultyFetchedAt == null).length;
  const total = groups.reduce((sum, g) => sum + g.keywords.length, 0);
  const toLookUp = uncached.reduce((sum, g) => sum + g.uncached, 0);
  return { total, cached: total - toLookUp, estimateUsd: estimateLookups(uncached, difficultyMissing) };
}

export interface ResearchEstimate {
  keywords: number;
  places: string[];
  cached: number;
  estimateUsd: number;
  sandbox: boolean;
  /** Why it can't start, if it can't. */
  blocked: string | null;
}

export async function estimateKeywordResearch(db: Db, viewer: Viewer, projectId: string): Promise<ResearchEstimate> {
  const setup = seoSetup();
  const inputs = await researchInputs(db, viewer, projectId);
  const groups = plan(inputs);
  const measured = await measurePlan(db, groups, setup.sandbox);
  let blocked: string | null = null;
  if (!setup.configured) blocked = `DataForSEO isn't set up yet: an admin adds ${setup.missing.join(" and ")} in Coolify.`;
  else if (groups.length === 0) blocked = "Add at least one service and a service area to the intake first.";
  /*
    A lookup with no services can only ask about the trade's own word
    (Jason's run, 10 November 2026). New Dawn Awning's table came back as
    twelve rows of "remodeling contractor <city>", every Service column
    reading "The trade", for a business that builds patio covers: the
    services were not in the intake when it ran, the money went anyway, and
    the page plan was then built on another trade's keywords.

    Standing rule 9 - say before a paid step whether the result will be
    usable - and code can answer this one for nothing. The way forward is
    named, so it is a stop and not a dead end.
  */
  else if (inputs.services.every((name) => !name.trim())) {
    const term = tradeTerm(inputs.trade);
    blocked = `No services are filled in, so every keyword would be the trade's own word${term ? ` ("${term}")` : ""} rather than what this business sells. Add the services to the intake first, then look up again.`;
  } else if (!setup.sandbox) {
    const [spent, limit] = await Promise.all([seoSpendThisMonth(db), getSeoLimit(db)]);
    if (spent + measured.estimateUsd > limit.dollars) {
      blocked = `This would go over the monthly SEO data cap ($${spent.toFixed(2)} of $${limit.dollars.toFixed(2)} used). An admin can raise it on Spend.`;
    }
  }
  return { keywords: measured.total, places: groups.map((g) => g.place), cached: measured.cached, estimateUsd: setup.sandbox ? 0 : measured.estimateUsd, sandbox: setup.sandbox, blocked };
}

const pending = new Set<Promise<unknown>>();

/** For tests: wait for research started outside a request. */
export async function settleKeywordResearch(): Promise<void> {
  await Promise.all([...pending]);
}

/* options.then (0.100.0, Prepare the content): what runs once the research has finished well (the page plan, the Home page's draft). */
export async function startKeywordResearch(ctx: ServiceContext, actor: Viewer, projectId: string, options: { then?: () => Promise<void> } = {}): Promise<string> {
  assertCan(actor, "seo.research");
  const [running] = await ctx.db
    .select()
    .from(keywordResearch)
    .where(and(eq(keywordResearch.projectId, projectId), eq(keywordResearch.status, "working")))
    .limit(1);
  if (running && Date.now() - running.createdAt.getTime() < STALE_AFTER_MS) throw new SeoDataError("Keyword research is already running for this project.");

  const estimate = await estimateKeywordResearch(ctx.db, actor, projectId);
  if (estimate.blocked) throw new SeoDataError(estimate.blocked);

  const [row] = await ctx.db
    .insert(keywordResearch)
    .values({
      projectId,
      sandbox: estimate.sandbox,
      keywordCount: estimate.keywords,
      places: estimate.places,
      estimateUsd: estimate.estimateUsd,
      startedByUserId: actorFields(actor).actorUserId,
    })
    .returning({ id: keywordResearch.id });
  await recordActivity(ctx.db, {
    action: "seo.research_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: null,
    valueAfter: { keywords: estimate.keywords, places: estimate.places, estimateUsd: estimate.estimateUsd, sandbox: estimate.sandbox },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  const task = () =>
    runKeywordResearch(ctx.db, actor, row!.id)
      .then(async () => {
        if (!options.then) return;
        const [finished] = await ctx.db.select({ status: keywordResearch.status }).from(keywordResearch).where(eq(keywordResearch.id, row!.id)).limit(1);
        if (finished?.status === "done") await options.then();
      })
      .catch((error: unknown) => console.error(`Keyword research failed: ${error instanceof Error ? error.message : "unknown"}`));
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
  return row!.id;
}

interface VolumeItem {
  keyword?: string;
  search_volume?: number | null;
  cpc?: number | null;
  competition?: string | null;
}

interface DifficultyItem {
  keyword?: string;
  keyword_difficulty?: number | null;
}

/*
  One paid (or sandbox) call: always on the ledger, then read. The answer is
  saved too, but a failed save no longer keeps a charge off the ledger the
  monthly cap is checked against (C7, audit F-050): it is recorded with no
  saved copy.
*/
async function ledgeredCall(
  db: Db,
  run: { id: string; projectId: string; sandbox: boolean; startedByUserId: string | null },
  endpoint: "search_volume" | "keyword_difficulty",
  path: string,
  body: unknown,
  keywordCount: number,
): Promise<DataForSeoAnswer> {
  const { answer, raw } = await callDataForSeo(path, body);
  let key: string | null = `${projectStoragePrefix(run.projectId)}seo/${run.id}/${endpoint}-${Date.now()}.json`;
  try {
    await getStorage().put(key, Buffer.from(raw, "utf8"), "application/json");
  } catch (error) {
    console.warn(`DataForSEO answer not saved (${endpoint}); recorded without it:`, error instanceof Error ? error.message : error);
    key = null;
  }
  const problem = problemIn(answer);
  await db.insert(seoDataCall).values({
    projectId: run.projectId,
    researchId: run.id,
    endpoint,
    sandbox: run.sandbox,
    keywordCount,
    costUsd: run.sandbox ? 0 : Number(answer.cost ?? 0),
    ok: !problem,
    message: problem,
    startedByUserId: run.startedByUserId,
    responseKey: key,
  });
  if (problem) throw new SeoDataError(`DataForSEO: ${problem}`);
  return answer;
}

export async function runKeywordResearch(db: Db, viewer: Viewer, researchId: string): Promise<void> {
  const [run] = await db.select().from(keywordResearch).where(eq(keywordResearch.id, researchId)).limit(1);
  if (!run || run.status !== "working") return;
  try {
    const inputs = await researchInputs(db, viewer, run.projectId);
    const groups = plan(inputs);
    let cache = await cachedMetrics(db, groups, run.sandbox);
    let cachedCount = 0;

    for (const group of groups) {
      const missing = group.keywords.filter((k) => !cache.get(`${group.place}|${k.keyword}`)?.volumeFetchedAt).map((k) => k.keyword);
      cachedCount += group.keywords.length - missing.length;
      for (let i = 0; i < missing.length; i += 1000) {
        const batch = missing.slice(i, i + 1000);
        const answer = await ledgeredCall(db, run, "search_volume", "/v3/keywords_data/google_ads/search_volume/live", [{ keywords: batch, location_name: group.place, language_name: "English" }], batch.length);
        const items = (answer.tasks?.[0]?.result ?? []) as VolumeItem[];
        const byKeyword = new Map(items.filter((it) => it.keyword).map((it) => [normalizeKeyword(it.keyword!), it]));
        for (const keyword of batch) {
          const item = byKeyword.get(keyword);
          const values = {
            searchVolume: item?.search_volume ?? null,
            cpc: item?.cpc ?? null,
            competition: item?.competition ?? null,
            volumeFetchedAt: new Date(),
          };
          await db
            .insert(keywordMetric)
            .values({ keyword, place: group.place, sandbox: run.sandbox, ...values })
            .onConflictDoUpdate({ target: [keywordMetric.keyword, keywordMetric.place, keywordMetric.sandbox], set: values });
        }
      }
    }

    // Difficulty is measured across the country (DataForSEO Labs), once per keyword.
    cache = await cachedMetrics(db, groups, run.sandbox);
    const allKeywords = [...new Set(groups.flatMap((g) => g.keywords.map((k) => k.keyword)))];
    const needDifficulty = allKeywords.filter((k) => cache.get(`${COUNTRY}|${k}`)?.difficultyFetchedAt == null);
    for (let i = 0; i < needDifficulty.length; i += 1000) {
      const batch = needDifficulty.slice(i, i + 1000);
      const answer = await ledgeredCall(db, run, "keyword_difficulty", "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live", [{ keywords: batch, location_name: COUNTRY, language_name: "English" }], batch.length);
      const result = (answer.tasks?.[0]?.result ?? []) as { items?: DifficultyItem[] | null }[];
      const byKeyword = new Map((result[0]?.items ?? []).filter((it) => it.keyword).map((it) => [normalizeKeyword(it.keyword!), it]));
      for (const keyword of batch) {
        const values = { difficulty: byKeyword.get(keyword)?.keyword_difficulty ?? null, difficultyFetchedAt: new Date() };
        await db
          .insert(keywordMetric)
          .values({ keyword, place: COUNTRY, sandbox: run.sandbox, ...values })
          .onConflictDoUpdate({ target: [keywordMetric.keyword, keywordMetric.place, keywordMetric.sandbox], set: values });
      }
    }

    cache = await cachedMetrics(db, groups, run.sandbox);
    const rows = groups.flatMap((g) =>
      g.keywords.map((k) => {
        const volume = cache.get(`${g.place}|${k.keyword}`);
        return {
          researchId: run.id,
          projectId: run.projectId,
          keyword: k.keyword,
          service: k.service,
          area: k.area,
          place: g.place,
          searchVolume: volume?.searchVolume ?? null,
          cpc: volume?.cpc ?? null,
          competition: volume?.competition ?? null,
          difficulty: cache.get(`${COUNTRY}|${k.keyword}`)?.difficulty ?? null,
        };
      }),
    );
    if (rows.length > 0) await db.insert(seoKeyword).values(rows);
    const [spent] = await db
      .select({ total: sql<number>`coalesce(sum(${seoDataCall.costUsd}), 0)` })
      .from(seoDataCall)
      .where(eq(seoDataCall.researchId, run.id));
    await db
      .update(keywordResearch)
      .set({ status: "done", keywordCount: rows.length, cachedCount, costUsd: Number(spent?.total ?? 0), finishedAt: new Date() })
      .where(eq(keywordResearch.id, run.id));
    await recordActivity(db, {
      action: "seo.research_finished",
      entityType: "project",
      entityId: run.projectId,
      ...actorFields(viewer),
      valueBefore: null,
      valueAfter: { keywords: rows.length, cached: cachedCount, costUsd: Number(spent?.total ?? 0), sandbox: run.sandbox },
    });
  } catch (error) {
    const reason = error instanceof SeoDataError ? error.message : "The keyword research stopped unexpectedly. Try again.";
    if (!(error instanceof SeoDataError)) console.error("Keyword research:", error instanceof Error ? error.message : error);
    await db.update(keywordResearch).set({ status: "failed", failureReason: reason, finishedAt: new Date() }).where(eq(keywordResearch.id, run.id));
  }
}

/* ---------- what the Content screen shows ---------- */

export async function loadSeoView(db: Db, viewer: Viewer, projectId: string) {
  const [latest] = await db
    .select()
    .from(keywordResearch)
    .where(eq(keywordResearch.projectId, projectId))
    .orderBy(desc(keywordResearch.createdAt))
    .limit(1);
  const stale = latest?.status === "working" && Date.now() - latest.createdAt.getTime() > STALE_AFTER_MS;
  const [lastDone] = await db
    .select()
    .from(keywordResearch)
    .where(and(eq(keywordResearch.projectId, projectId), eq(keywordResearch.status, "done")))
    .orderBy(desc(keywordResearch.createdAt))
    .limit(1);
  const keywords = lastDone
    ? await db.select().from(seoKeyword).where(eq(seoKeyword.researchId, lastDone.id)).orderBy(desc(seoKeyword.searchVolume), asc(seoKeyword.keyword))
    : [];
  const pages = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  const [row] = await db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  const tier = (row?.tier ?? "starter") as Tier;
  const keptArticles = (await keepSiteUrl(db, projectId)) ? Math.min(KEPT_ARTICLE_LIMIT, pages.filter((p) => p.kind === "article").length) : 0;
  return {
    setup: seoSetup(),
    estimate: await estimateKeywordResearch(db, viewer, projectId).catch((error: unknown) => ({
      keywords: 0,
      places: [],
      cached: 0,
      estimateUsd: 0,
      sandbox: seoSetup().sandbox,
      blocked: error instanceof Error ? error.message : "Can't estimate the research.",
    })),
    latest: latest ? { ...latest, status: stale ? "failed" : latest.status, failureReason: stale ? "It was cut off before finishing. Start it again." : latest.failureReason } : null,
    lastDone: lastDone ?? null,
    keywords,
    pages,
    tier,
    // A makeover's kept blog articles don't count toward the tier (0.98.0).
    keptArticles,
    tierWarning: pages.length > 0 ? planTierWarning(pages.length - keptArticles, tier) : null,
    // The audit's own finding, said on the screen that can act on it (11 November 2026).
    keywordWarning: planKeywordWarning(pages.map((page) => ({ mainKeyword: page.mainKeyword ?? "" }))),
    /*
      A plan made before the client approved a supplied design does not
      follow its menu, and the plan is never remade by itself, because
      remaking it replaces every page and takes their drafts with them
      (CodeRabbit on #107). So the screen says it, and the team decides.
    */
    designMenuWarning: designMenuWarning(await missingMenuItems(db, projectId, pages)),
  };
}

/* ---------- the page plan ---------- */

async function logPlan(ctx: ServiceContext, actor: Viewer, projectId: string, action: ActivityAction, before: unknown, afterValue: unknown) {
  await recordActivity(ctx.db, {
    action,
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: before ?? null,
    valueAfter: afterValue ?? null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Makes the plan from the tier, the intake and the latest research (free: no AI, no lookup). Replaces any plan there is. */
export async function makePagePlan(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "content.plan");
  // Keep all content as is (0.96.0): the plan comes from the current site by itself; a plan with work is never wiped here.
  if (await keepSiteUrl(ctx.db, projectId)) {
    const work = await planWork(ctx.db, projectId);
    if (work.approved + work.drafted + work.commented + work.edited > 0) throw new SeoDataError(`This project keeps the current site's content: its page plan comes from the current site, and remaking it would delete work. ${workWords(work)}`);
  }
  const inputs = await researchInputs(ctx.db, actor, projectId);
  const [lastDone] = await ctx.db
    .select()
    .from(keywordResearch)
    .where(and(eq(keywordResearch.projectId, projectId), eq(keywordResearch.status, "done")))
    .orderBy(desc(keywordResearch.createdAt))
    .limit(1);
  const keywords = lastDone ? await ctx.db.select().from(seoKeyword).where(eq(seoKeyword.researchId, lastDone.id)) : [];
  // #4: a makeover's primary city follows the current site's SEO focus (its home H1/title/meta), not
  // the intake address. The crawled home page summary is in site_import; absent for a no-site project.
  const [imported] = await ctx.db.select({ pages: siteImport.pages }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const homePage = ((imported?.pages as ImportedPageSummary[] | null) ?? []).find((p) => p.kind === "home" || p.path === "/");
  const siteHome = homePage ? { h1s: homePage.h1s ?? [], title: homePage.title ?? "", metaDescription: homePage.metaDescription ?? "" } : null;
  const drafted = draftPagePlan({ ...inputs, keywords, siteHome });
  /*
    A supplied homepage (Jason, option A, 17 November 2026): the design the
    client approved carries the menu, so its items are the site's pages. Null
    when this project has no approved supplied homepage, and an empty menu
    leaves the plan exactly as the intake and the keywords made it.
  */
  const nav = await suppliedHomeNav(ctx.db, projectId);
  const drafted2 = nav?.length ? planFromNav(nav, drafted, inputs.businessName) : drafted;
  const before = await ctx.db.select({ name: pagePlanPage.name }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  await ctx.db.delete(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  await ctx.db.insert(pagePlanPage).values(drafted2.map((p, position) => ({ ...p, projectId, position })));
  // The plan isn't the current site's any more: a later keep choice treats it as a plan not from the read.
  await ctx.db.update(siteImport).set({ usedAt: null, usedByUserId: null, keptPlan: null }).where(eq(siteImport.projectId, projectId));
  await logPlan(ctx, actor, projectId, "content.plan_made", before.length ? { pages: before.map((p) => p.name) } : null, {
    pages: drafted2.map((p) => p.name),
    fromResearch: Boolean(lastDone),
    ...(nav?.length ? { fromDesignMenu: nav.map((n) => n.label) } : {}),
  });
  return drafted2.length;
}

export interface PlanPageInput {
  kind: string;
  name: string;
  slug: string;
  mainKeyword: string;
  supportingKeywords: string;
  title: string;
  metaDescription: string;
  h1: string;
}

function cleanPage(input: PlanPageInput) {
  const name = input.name.trim();
  if (!name) throw new SeoDataError("Give the page a name.");
  if (!(PAGE_KINDS as readonly string[]).includes(input.kind)) throw new SeoDataError("Choose what kind of page it is.");
  const kind = input.kind as PageKind;
  return {
    kind,
    name: name.slice(0, 80),
    // A kept article keeps its folder ("blog/a-post", 6 October 2026): each part is cleaned on its own.
    slug: kind === "home" ? "" : slugPath(input.slug.trim() || name),
    mainKeyword: normalizeKeyword(input.mainKeyword),
    supportingKeywords: input.supportingKeywords
      .split(/[\n,]+/)
      .map(normalizeKeyword)
      .filter(Boolean)
      .slice(0, 10),
    title: input.title.trim().slice(0, 120),
    metaDescription: input.metaDescription.trim().slice(0, 320),
    h1: input.h1.trim().slice(0, 120),
  };
}

/* Adds a page at the end, or changes one. Logged with what changed. */
export async function savePlanPage(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string | null, input: PlanPageInput): Promise<string> {
  assertCan(actor, "content.plan");
  const values = cleanPage(input);
  const pages = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (pages.some((p) => p.id !== pageId && p.kind !== "home" && values.kind !== "home" && p.slug === values.slug)) {
    throw new SeoDataError(`Another page already uses the address /${values.slug}. Change one of them.`);
  }
  if (pageId) {
    const before = pages.find((p) => p.id === pageId);
    if (!before) throw new SeoDataError("That page is no longer in the plan.");
    await ctx.db.update(pagePlanPage).set({ ...values, updatedAt: new Date() }).where(eq(pagePlanPage.id, pageId));
    const changed = Object.fromEntries(
      Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify((before as Record<string, unknown>)[key])),
    );
    if (Object.keys(changed).length > 0) {
      await logPlan(
        ctx,
        actor,
        projectId,
        "content.plan_page_changed",
        { name: before.name, ...Object.fromEntries(Object.keys(changed).map((k) => [k, (before as Record<string, unknown>)[k]])) },
        { name: values.name, ...changed },
      );
    }
    return pageId;
  }
  const [created] = await ctx.db
    .insert(pagePlanPage)
    .values({ ...values, projectId, position: (pages.at(-1)?.position ?? -1) + 1 })
    .returning({ id: pagePlanPage.id });
  await logPlan(ctx, actor, projectId, "content.plan_page_added", null, { name: values.name, kind: values.kind });
  return created!.id;
}

export async function removePlanPage(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string): Promise<void> {
  assertCan(actor, "content.plan");
  const [page] = await ctx.db.select().from(pagePlanPage).where(and(eq(pagePlanPage.id, pageId), eq(pagePlanPage.projectId, projectId))).limit(1);
  if (!page) return;
  if (page.kind === "home") throw new SeoDataError("Every site has a Home page, so it can't be removed.");
  await ctx.db.delete(pagePlanPage).where(eq(pagePlanPage.id, pageId));
  await logPlan(ctx, actor, projectId, "content.plan_page_removed", { name: page.name, kind: page.kind }, null);
}

/* Moves a page one place up or down the menu order; Home stays first. */
export async function movePlanPage(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, direction: "up" | "down"): Promise<void> {
  assertCan(actor, "content.plan");
  const pages = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  const at = pages.findIndex((p) => p.id === pageId);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= pages.length || pages[at]!.kind === "home" || pages[to]!.kind === "home") return;
  const [a, b] = [pages[at]!, pages[to]!];
  await ctx.db.update(pagePlanPage).set({ position: b.position }).where(eq(pagePlanPage.id, a.id));
  await ctx.db.update(pagePlanPage).set({ position: a.position }).where(eq(pagePlanPage.id, b.id));
  await logPlan(ctx, actor, projectId, "content.plan_reordered", { order: pages.map((p) => p.name) }, {
    order: pages.map((p, i) => (i === at ? b.name : i === to ? a.name : p.name)),
  });
}

export { TITLE_LIMIT, META_LIMIT };

/*
  A DataForSEO call for anything other than keyword research (the SEO
  audits): saved to R2 before it is read, recorded on the ledger (Spend,
  "SEO data"), and its problem, if any, thrown in plain words.
*/
export async function dataForSeoCall(
  run: { projectId: string; runId: string; sandbox: boolean; startedByUserId: string | null },
  endpoint: string,
  path: string,
  body: unknown,
  keywordCount = 0,
  method: "POST" | "GET" = "POST",
): Promise<DataForSeoAnswer> {
  const { answer, raw } = await callDataForSeo(path, body, method);
  const key = `${projectStoragePrefix(run.projectId)}seo/${run.runId}/${endpoint}-${Date.now()}.json`;
  await getStorage().put(key, Buffer.from(raw, "utf8"), "application/json");
  const problem = problemIn(answer);
  await getDb().insert(seoDataCall).values({
    projectId: run.projectId,
    researchId: null,
    endpoint,
    sandbox: run.sandbox,
    keywordCount,
    costUsd: run.sandbox ? 0 : Number(answer.cost ?? 0),
    ok: !problem,
    message: problem,
    startedByUserId: run.startedByUserId,
    responseKey: key,
  });
  if (problem) throw new SeoDataError(`DataForSEO: ${problem}`);
  return answer;
}

export type { DataForSeoAnswer };

/*
  The site map for the wireframe (3 October 2026): the page plan when there
  is one, else the plan Content would draft from the intake now (free, no
  keyword lookup). Read-only there; Content changes the pages later.
*/
export async function siteMapPreview(db: Db, projectId: string): Promise<{ source: "plan" | "draft"; pages: { name: string; slug: string; parentSlug: string | null }[] }> {
  const saved = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (saved.length) return { source: "plan", pages: saved.map((p) => ({ name: p.name, slug: p.slug, parentSlug: p.parentSlug ?? null })) };
  const inputs = await researchInputs(db, SYSTEM_ACTOR, projectId);
  return { source: "draft", pages: draftPagePlan({ ...inputs, keywords: [] }).map((p) => ({ name: p.name, slug: p.slug, parentSlug: p.parentSlug ?? null })) };
}
