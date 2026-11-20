import { eq } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import type { SiteHome } from "@tawd/core/mockups";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { project } from "@tawd/core/schema";
import { botCheck, hostOf, type BlockedRoute, type FetchedText } from "@tawd/core/site";
import {
  ROUTE_CONSENT_OVER_USD,
  ROUTE_LABELS,
  ROUTE_SPEND_LABELS,
  ZYTE_USD_PER_BROWSER_PAGE,
  ZYTE_USD_PER_HTTP_FILE,
  getRouteCap,
  jinaCost,
  recordRouteCall,
  routeEstimate,
  routeSpentThisMonth,
  type BlockedRouteName,
} from "@tawd/core/site-read";
import { postProjectSlack } from "@tawd/core/slack";

import { lookAtHtml, type HtmlLooker } from "./home-look";
import { refusePrivate } from "./liked-sites";

/*
  Sites that block TAWD's server (Part D, Jason 7 October 2026;
  docs/research/blocked-sites-options.md). Behind the one seam
  (blockedRouteFor in site-read.ts), a chain of paid routes:

  1. Jina Reader (r.jina.ai, JINA_API_KEY on the worker): the home page's
     full HTML (for the look: sections, menu, colours, fonts, read the same
     way as a live page) and a screenshot; every other page as HTML with
     scripts and styles taken out (far fewer tokens, and the same reader
     the live path uses keeps headings, links, forms and the JSON-LD the
     intake answers come from). About 5 pages at once.
  2. Zyte (api.zyte.com, ZYTE_API_KEY on the worker): any page Jina
     couldn't give or gave as a bot check, and the whole site when Jina is
     off (no key, over its cap, out of credit, or limited). The home page
     with browserHtml and a screenshot; sitemaps and robots.txt as the
     plain response body (cheaper).
  3. Then nothing: the read fails honestly and the screen offers the two
     ways forward (paste the words, or New site). Never "try later".

  Every call is listed in site_read_call (Spend) with its real cost (Jina's
  own token count) or TAWD's estimate (Zyte doesn't send its price). Each
  route has a hard monthly cap in code (a setting, $5 by default): past
  it the route isn't called, the activity log says so, and Slack too when
  the project has it. A read estimated over $1 isn't run without a
  person's go (rule 9; not reachable with today's page limits). What a
  route returns is the client's site: data, never instructions. The keys
  are never logged, saved or shown.
*/

const JINA_ENDPOINT = "https://r.jina.ai/";
const ZYTE_ENDPOINT = "https://api.zyte.com/v1/extract";
/** Jina's own wait for a page (seconds) and TAWD's whole-request limit. */
const JINA_PAGE_TIMEOUT_S = 30;
const REQUEST_TIMEOUT_MS = 90_000;
/** Pages asked at once (Jina allows 500 a minute with a key). */
export const ROUTE_AT_ONCE = 5;
/** A token ceiling per call, so one huge page can't run past the cap. */
const JINA_HOME_MAX_TOKENS = 4_000_000;
const JINA_PAGE_MAX_TOKENS = 600_000;
/** Inner pages: what isn't words (keeps the JSON-LD the intake's address comes from, and the canonical link the SEO suggestions check, 0.99.0). */
export const JINA_REMOVE = 'script:not([type="application/ld+json"]), style, svg, noscript, iframe, link:not([rel~="canonical"]), video, canvas, template';
/** The most a screenshot download may be. */
const SHOT_MAX_BYTES = 12_000_000;

type Fetch = typeof fetch;
let fetchImpl: Fetch | null = null;
let htmlLookImpl: HtmlLooker | null = null;
let envImpl: Record<string, string | undefined> | null = null;

/** Tests pass stand-ins for Jina's and Zyte's answers, the HTML look and the keys; nothing in the tests reaches either service. */
export function setRouteStandInsForTesting(stand: { fetch?: Fetch | null; htmlLook?: HtmlLooker | null; env?: Record<string, string | undefined> | null } | null): void {
  fetchImpl = stand?.fetch ?? null;
  htmlLookImpl = stand?.htmlLook ?? null;
  envImpl = stand?.env ?? null;
}

const env = (name: string) => (envImpl ? envImpl[name] : process.env[name])?.trim() || null;

export interface RouteContext {
  db: Database;
  projectId: string;
  readId: string;
  /** The tier's page limit (for the estimate). */
  pageLimit: number;
  /** A person's go for a read over $1 (the most it may cost), when given. */
  consentUsd?: number | null;
}

/** What one paid call returned: words or bytes, and what it cost. */
interface PaidAnswer {
  ok: boolean;
  status: number;
  text: string;
  url: string;
  title?: string;
  image?: Buffer;
  tokens: number;
  costUsd: number;
  estimated: boolean;
  message: string | null;
  /** The route can't go on for this read (out of credit, the key refused, limited). */
  stop: boolean;
}

const failed = (status: number, message: string, stop = false): PaidAnswer => ({ ok: false, status, text: "", url: "", tokens: 0, costUsd: 0, estimated: false, message, stop });

/* Why a route's answer code stops it for this read, in words (never "try later"). */
function stopWords(route: BlockedRouteName, status: number): string | null {
  const key = route === "jina" ? "JINA_API_KEY" : "ZYTE_API_KEY";
  if (status === 401 || status === 403) return `${ROUTE_LABELS[route]} refused TAWD's key (${status}): check ${key} on tawd-worker-new in Coolify.`;
  if (status === 402) return route === "jina" ? "Jina Reader's balance is used up (402): top it up on jina.ai (API key & billing)." : "Zyte's credit is used up (402): add credit in the Zyte dashboard (billing).";
  if (status === 429) return `${ROUTE_LABELS[route]} is limiting TAWD's requests (429): TAWD stopped asking it for this read.`;
  return null;
}

async function jinaCall(url: string, format: "html" | "screenshot", budget: number, remove: string | null): Promise<PaidAnswer> {
  const key = env("JINA_API_KEY");
  if (!key) return failed(0, "No Jina key.", true);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "X-Return-Format": format,
    "X-Timeout": String(JINA_PAGE_TIMEOUT_S),
    "X-Token-Budget": String(Math.max(1_000, Math.floor(budget))),
  };
  if (remove) headers["X-Remove-Selector"] = remove;
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(`${JINA_ENDPOINT}${url}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return failed(0, /timeout|abort/i.test(error instanceof Error ? error.name + error.message : "") ? "Jina Reader didn't answer in time." : "Jina Reader couldn't be reached.");
  }
  const stop = stopWords("jina", response.status);
  if (!response.ok) return failed(response.status, stop ?? `Jina Reader answered ${response.status}.`, Boolean(stop));
  // Jina's JSON (seen 7 October 2026): data.html for the html format (data.content for text formats), data.httpStatus the site's own answer, data.usage.tokens what it charges.
  let body: { data?: { html?: string; content?: string; title?: string; url?: string; screenshotUrl?: string; httpStatus?: number; usage?: { tokens?: number } }; meta?: { usage?: { tokens?: number } }; usage?: { tokens?: number } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return failed(response.status, "Jina Reader's answer wasn't readable.");
  }
  const data = body.data ?? {};
  const counted = data.usage?.tokens ?? body.meta?.usage?.tokens ?? body.usage?.tokens;
  const text = typeof data.html === "string" ? data.html : typeof data.content === "string" ? data.content : "";
  const tokens = typeof counted === "number" && counted >= 0 ? counted : Math.ceil(text.length / 4);
  const answer: PaidAnswer = { ok: true, status: typeof data.httpStatus === "number" ? data.httpStatus : 200, text, url: data.url || url, title: data.title, tokens, costUsd: jinaCost(tokens), estimated: typeof counted !== "number", message: null, stop: false };
  if (format === "screenshot") {
    const image = data.screenshotUrl ? await downloadImage(data.screenshotUrl) : null;
    return image ? { ...answer, image } : { ...answer, ok: false, message: "Jina Reader gave no screenshot." };
  }
  return answer;
}

/* A route's screenshot, from the address it gave: public addresses only, a size limit. */
async function downloadImage(address: string): Promise<Buffer | null> {
  if (!/^https:\/\//i.test(address) || (await refusePrivate(address))) return null;
  try {
    const response = await (fetchImpl ?? fetch)(address, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !/^image\//i.test(response.headers.get("content-type") ?? "image/png")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= SHOT_MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

async function zyteCall(url: string, mode: "browser" | "browser+shot" | "http"): Promise<PaidAnswer> {
  const key = env("ZYTE_API_KEY");
  if (!key) return failed(0, "No Zyte key.", true);
  const body = mode === "http" ? { url, httpResponseBody: true } : { url, browserHtml: true, ...(mode === "browser+shot" ? { screenshot: true } : {}) };
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(ZYTE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return failed(0, /timeout|abort/i.test(error instanceof Error ? error.name + error.message : "") ? "Zyte didn't answer in time." : "Zyte couldn't be reached.");
  }
  const stop = stopWords("zyte", response.status);
  // Zyte charges only for answers it gives: a refused request costs nothing.
  if (!response.ok) return failed(response.status, stop ?? `Zyte answered ${response.status}.`, Boolean(stop));
  let data: { url?: string; statusCode?: number; browserHtml?: string; httpResponseBody?: string; screenshot?: string };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    return failed(response.status, "Zyte's answer wasn't readable.");
  }
  const text = mode === "http" ? (data.httpResponseBody ? Buffer.from(data.httpResponseBody, "base64").toString("utf8") : "") : (data.browserHtml ?? "");
  const image = data.screenshot ? Buffer.from(data.screenshot, "base64") : undefined;
  const cost = mode === "http" ? ZYTE_USD_PER_HTTP_FILE : ZYTE_USD_PER_BROWSER_PAGE;
  return { ok: true, status: data.statusCode ?? 200, text, url: data.url || url, image, tokens: 0, costUsd: cost, estimated: true, message: null, stop: false };
}

const pathOfUrl = (url: string) => {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
};
const isFile = (url: string) => /\.(xml|txt|xml\.gz)$/.test(pathOfUrl(url));

export interface PaidRoutes {
  /** The chain behind the seam, or null when no route can run (no keys, both over their caps, out of credit, or the estimate waits for a person's go). */
  route: BlockedRoute | null;
  /** Why each route is off right now, in words with what to do (for the failure line; Fable's review H3). */
  off(): string[];
  /** The read waits for a person's go: the cheapest route's estimate is over the $1 rule (and over any go already given). */
  needsConsent: { route: BlockedRouteName; estimateUsd: number } | null;
  /** What this read spent, by route (for the activity log). */
  spent(): Record<BlockedRouteName, { calls: number; costUsd: number }>;
}

interface RouteState {
  cap: number;
  spentBefore: number;
  spentNow: number;
  /** Held for calls in flight (Fable's review M7): a call's most it can cost is set aside before it starts. */
  reserved: number;
  calls: number;
  off: string | null;
  /** Off for consent only (the estimate), not a cap, a key or credit. */
  consentOnly: boolean;
  estimate: number;
}

/*
  The routes this read may use, in order, each checked against its key,
  its monthly cap and the estimate (over $1 waits for a person's go unless
  one at least that size was given: ctx.consentUsd). Before every call its
  most possible cost is reserved, so the calls at once can't run past the
  cap together.
*/
export async function paidRoutesFor(ctx: RouteContext): Promise<PaidRoutes> {
  const order: BlockedRouteName[] = ["jina", "zyte"];
  const keys: Record<BlockedRouteName, string> = { jina: "JINA_API_KEY", zyte: "ZYTE_API_KEY" };
  const state = new Map<BlockedRouteName, RouteState>();
  const allowance = Math.max(ROUTE_CONSENT_OVER_USD, ctx.consentUsd ?? 0);
  for (const name of order) {
    const estimate = routeEstimate(name, ctx.pageLimit);
    if (!env(keys[name])) {
      state.set(name, { cap: 0, spentBefore: 0, spentNow: 0, reserved: 0, calls: 0, off: `${ROUTE_LABELS[name]} isn't set up (no key on the worker).`, consentOnly: false, estimate });
      continue;
    }
    const [cap, spent] = await Promise.all([getRouteCap(ctx.db, name), routeSpentThisMonth(ctx.db, name)]);
    const overCap = spent + Math.min(estimate, 0.01) > cap.dollars;
    const overGo = !overCap && estimate > allowance;
    const reason = overCap
      ? capWords(name, cap.dollars)
      : overGo
        ? `Reading this site through ${ROUTE_LABELS[name]} would cost about $${estimate.toFixed(2)}: over $${ROUTE_CONSENT_OVER_USD}, it waits for a person's go on the intake's Website section.`
        : null;
    state.set(name, { cap: cap.dollars, spentBefore: spent, spentNow: 0, reserved: 0, calls: 0, off: reason, consentOnly: overGo, estimate });
    if (overCap) await capped(ctx, name, cap.dollars);
  }
  const off = () => order.flatMap((n) => (state.get(n)!.off ? [state.get(n)!.off!] : []));
  const usable = () => order.filter((n) => !state.get(n)!.off);
  const spent = () => Object.fromEntries(order.map((n) => [n, { calls: state.get(n)!.calls, costUsd: state.get(n)!.spentNow }])) as Record<BlockedRouteName, { calls: number; costUsd: number }>;
  if (usable().length === 0) {
    const waiting = order.filter((n) => state.get(n)!.consentOnly).sort((a, b) => state.get(a)!.estimate - state.get(b)!.estimate)[0];
    return { route: null, off, spent, needsConsent: waiting ? { route: waiting, estimateUsd: Math.round(state.get(waiting)!.estimate * 100) / 100 } : null };
  }

  /* Holds room under a route's cap for one call costing at most this much; false (and the route off) when there isn't. */
  const hold = async (name: BlockedRouteName, upTo: number): Promise<boolean> => {
    const s = state.get(name)!;
    if (s.off) return false;
    const capOk = s.spentBefore + s.spentNow + s.reserved + upTo <= s.cap;
    // The read as a whole also stays within what was agreed for it ($1, or the go a person gave), both routes together, not
    // only under each route's monthly cap (13 October 2026, the whole-code review).
    const readOk = readSoFar() + upTo <= allowance;
    if (capOk && readOk) {
      s.reserved += upTo;
      return true;
    }
    if (s.reserved > 0) return false; // Calls in flight may free room; this page goes to the next route.
    if (!capOk) {
      s.off = capWords(name, s.cap);
      await capped(ctx, name, s.cap);
      return false;
    }
    s.off = `This read reached the $${allowance.toFixed(2)} agreed for it, so ${ROUTE_LABELS[name]} stopped.`;
    return false;
  };
  /* What this read has spent and set aside so far, both routes together. */
  const readSoFar = () => order.reduce((sum, n) => sum + state.get(n)!.spentNow + state.get(n)!.reserved, 0);
  const record = async (name: BlockedRouteName, kind: "home" | "screenshot" | "page", url: string, answer: PaidAnswer, held: number) => {
    const s = state.get(name)!;
    s.reserved = Math.max(0, s.reserved - held);
    s.calls += 1;
    s.spentNow += answer.costUsd;
    if (answer.stop && !s.off) {
      s.off = answer.message;
      await stopped(ctx, name, answer.message ?? `${ROUTE_LABELS[name]} stopped.`);
    }
    await recordRouteCall(ctx.db, { projectId: ctx.projectId, readId: ctx.readId, route: name, kind, url, tokens: answer.tokens, costUsd: answer.costUsd, estimated: answer.estimated, ok: answer.ok, message: answer.message }).catch((error: unknown) =>
      // A cost that can't be saved is said in the log (0.97.0), never dropped silently; the read carries on.
      console.error(`Blocked-site read: the ${name} call's cost ($${answer.costUsd.toFixed(4)}) couldn't be saved:`, error instanceof Error ? error.message : error),
    );
  };
  /* The most tokens one Jina call may use: its ceiling, or what's left under the cap and under what was agreed for this read. */
  const jinaBudget = (most: number) => {
    const s = state.get("jina")!;
    const left = Math.min(s.cap - s.spentBefore - s.spentNow - s.reserved, allowance - readSoFar());
    return Math.floor(Math.min(most, (left / jinaCost(1_000_000)) * 1_000_000));
  };
  const usableAnswer = (answer: PaidAnswer) => answer.ok && answer.text.trim().length > 0 && answer.status >= 200 && answer.status < 300 && !botCheck({ status: answer.status, text: answer.text });

  /* One Jina call within its budget, held and settled. null when Jina can't be asked. */
  const askJina = async (url: string, kind: "home" | "page" | "screenshot", format: "html" | "screenshot", most: number, remove: string | null): Promise<PaidAnswer | null> => {
    const budget = jinaBudget(most);
    if (budget < 1_000) {
      // Too little left: asking for the smallest call turns Jina off with the limit that is really reached (the cap or the read's).
      const least = jinaCost(1_000);
      if (await hold("jina", least)) state.get("jina")!.reserved -= least;
      return null;
    }
    const held = jinaCost(budget);
    if (!(await hold("jina", held))) return null;
    const answer = await jinaCall(url, format, budget, remove);
    await record("jina", kind, url, answer, held);
    return answer;
  };
  const askZyte = async (url: string, kind: "home" | "page", mode: "browser" | "browser+shot" | "http"): Promise<PaidAnswer | null> => {
    const held = mode === "http" ? ZYTE_USD_PER_HTTP_FILE : ZYTE_USD_PER_BROWSER_PAGE;
    if (!(await hold("zyte", held))) return null;
    const answer = await zyteCall(url, mode);
    await record("zyte", kind, url, answer, held);
    return answer;
  };

  /* One page through the chain: Jina, then Zyte; null when neither could give it. */
  const viaChain = async (url: string, home: boolean): Promise<(FetchedText & { title?: string }) | null> => {
    if (isFile(url)) {
      // Sitemaps and robots.txt: Zyte's plain body (Jina renders pages, not files).
      const answer = await askZyte(url, "page", "http");
      return answer?.ok && answer.status >= 200 && answer.status < 300 && answer.text ? { url, status: answer.status, contentType: /\.xml$/.test(pathOfUrl(url)) ? "application/xml" : "text/plain", text: answer.text, via: "zyte" } : null;
    }
    const jina = await askJina(url, home ? "home" : "page", "html", home ? JINA_HOME_MAX_TOKENS : JINA_PAGE_MAX_TOKENS, home ? null : JINA_REMOVE);
    if (jina && usableAnswer(jina)) return { url, status: 200, contentType: "text/html", text: jina.text, via: "jina", title: jina.title };
    const zyte = await askZyte(url, home ? "home" : "page", "browser");
    if (zyte && usableAnswer(zyte)) return { url, status: 200, contentType: "text/html", text: zyte.text, via: "zyte" };
    return null;
  };

  const asked = new Map<string, Promise<FetchedText | null>>();
  const queue: string[] = [];
  let running = 0;
  const pump = () => {
    while (running < ROUTE_AT_ONCE && queue.length) {
      const url = queue.shift()!;
      if (asked.has(url)) continue;
      running++;
      asked.set(
        url,
        viaChain(url, false).finally(() => {
          running--;
          pump();
        }),
      );
    }
  };
  let homeLook: { url: string; html: string; via: string } | null = null;
  const withLook = (home: SiteHome | null, shotKey: string | null): SiteHome | null => (home ? { ...home, look: { colours: home.look?.colours ?? [], fonts: home.look?.fonts ?? [], screenshotKey: shotKey } } : null);

  const route: BlockedRoute = {
    name: usable()[0]!,
    label: usable().map((n) => ROUTE_LABELS[n]).join(" and "),
    fetch: async (url) => {
      // The home page the look already read isn't paid for twice.
      if (homeLook && pathOfUrl(url) === "/" && hostOf(url) === hostOf(homeLook.url)) return { url, status: 200, contentType: "text/html", text: homeLook.html, via: homeLook.via };
      const started = asked.get(url);
      if (started) return started;
      const answer = viaChain(url, pathOfUrl(url) === "/");
      asked.set(url, answer);
      return answer;
    },
    prefetch: (urls) => {
      for (const url of urls) if (!asked.has(url) && !isFile(url)) queue.push(url);
      pump();
    },
    look: async (url, saveShot): Promise<SiteHome | null> => {
      // The home page's full HTML (for its look and its words), then its screenshot.
      const jina = await askJina(url, "home", "html", JINA_HOME_MAX_TOKENS, null);
      if (jina && usableAnswer(jina)) {
        homeLook = { url, html: jina.text, via: "jina" };
        const home = await (htmlLookImpl ?? lookAtHtml)(jina.text, url).catch(() => null);
        const shot = await askJina(url, "screenshot", "screenshot", 20_000, null);
        const shotKey = shot?.ok && shot.image ? await saveShot(shot.image, "image/png").catch(() => null) : null;
        return withLook(home, shotKey);
      }
      const zyte = await askZyte(url, "home", "browser+shot");
      if (zyte && usableAnswer(zyte)) {
        homeLook = { url, html: zyte.text, via: "zyte" };
        const home = await (htmlLookImpl ?? lookAtHtml)(zyte.text, url).catch(() => null);
        const shotKey = zyte.image ? await saveShot(zyte.image, "image/png").catch(() => null) : null;
        return withLook(home, shotKey);
      }
      return null;
    },
    requests: () => [...state.values()].reduce((n, s) => n + s.calls, 0),
  };
  return { route, off, spent, needsConsent: null };
}

const capWords = (name: BlockedRouteName, cap: number) => `${ROUTE_LABELS[name]} has reached this month's cap of $${cap.toFixed(2)}: an admin can raise it on Spend.`;

/* A route that stopped mid-read (out of credit, its key refused, limited): the activity log and Slack, since a person has to act (Fable's review H3). */
async function stopped(ctx: RouteContext, name: BlockedRouteName, reason: string): Promise<void> {
  await recordActivity(ctx.db, {
    action: "content.blocked_route_stopped",
    entityType: "project",
    entityId: ctx.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { route: ROUTE_SPEND_LABELS[name], reason },
    ipAddress: null,
    userAgent: null,
  }).catch(() => undefined);
  await postProjectSlack(ctx.db, ctx.projectId, { kind: "blocked_route_stopped", route: ROUTE_LABELS[name], reason }).catch(() => undefined);
}

/* A route past its monthly cap: said once per read in the activity log, and on Slack when the project has it. */
async function capped(ctx: RouteContext, name: BlockedRouteName, cap: number): Promise<void> {
  await recordActivity(ctx.db, {
    action: "content.blocked_route_capped",
    entityType: "project",
    entityId: ctx.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { route: ROUTE_SPEND_LABELS[name], capUsd: cap },
    ipAddress: null,
    userAgent: null,
  }).catch(() => undefined);
  const [proj] = await ctx.db.select({ id: project.id }).from(project).where(eq(project.id, ctx.projectId)).limit(1);
  if (proj) await postProjectSlack(ctx.db, ctx.projectId, { kind: "blocked_route_capped", route: ROUTE_LABELS[name], capUsd: cap }).catch(() => undefined);
}
