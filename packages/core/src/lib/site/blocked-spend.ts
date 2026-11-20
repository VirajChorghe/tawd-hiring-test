import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../../db";
import { appSetting, siteReadCall } from "../../db/schema";

/*
  What reading a blocked site costs (Part D, Jason 7 October 2026;
  docs/research/blocked-sites-options.md). Two paid routes, in order:
  Jina Reader (tokens, $0.05 per million: the $50 top-up is 1 billion) and
  Zyte (per page; its answer doesn't carry its price, so TAWD estimates
  $0.004 a browser page, $0.001 a plain file). Each has a hard monthly cap
  in code (a setting, $5 by default): past it the route isn't called. A
  read estimated over $1 needs a person's go (rule 9); under $1 it runs by
  itself and is listed on Spend. Every call goes in site_read_call.
*/

type Db = Database;

export type BlockedRouteName = "jina" | "zyte";

export const ROUTE_LABELS: Record<BlockedRouteName, string> = { jina: "Jina Reader", zyte: "Zyte" };
/** Spend's and the activity log's name for each route's line. */
export const ROUTE_SPEND_LABELS: Record<BlockedRouteName, string> = { jina: "Jina Reader (blocked site)", zyte: "Zyte (blocked site)" };

export const JINA_USD_PER_MILLION_TOKENS = 0.05;
export const ZYTE_USD_PER_BROWSER_PAGE = 0.004;
export const ZYTE_USD_PER_HTTP_FILE = 0.001;
export const DEFAULT_ROUTE_CAP_USD = 5;
/** A read estimated above this needs a person's go (Jason's rule, 7 October 2026). */
export const ROUTE_CONSENT_OVER_USD = 1;

/* Rough token counts for the estimate (Finley, 7 October 2026: the home page's full HTML 1.6M, a trimmed inner page under 80k). */
export const JINA_HOME_TOKENS_EST = 2_000_000;
export const JINA_PAGE_TOKENS_EST = 80_000;

export const jinaCost = (tokens: number) => (tokens / 1_000_000) * JINA_USD_PER_MILLION_TOKENS;

/* The estimate for reading a whole site through a route: the home page with its look, then the other pages. */
export function routeEstimate(route: BlockedRouteName, pages: number): number {
  const others = Math.max(0, pages - 1);
  return route === "jina" ? jinaCost(JINA_HOME_TOKENS_EST + others * JINA_PAGE_TOKENS_EST) : ZYTE_USD_PER_BROWSER_PAGE * (pages + 1) + ZYTE_USD_PER_HTTP_FILE * 4;
}

const capKey = (route: BlockedRouteName) => `blocked_route_cap_${route}`;

export async function getRouteCap(db: Db, route: BlockedRouteName): Promise<{ dollars: number; isDefault: boolean }> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, capKey(route))).limit(1);
  const value = row ? Number((row.value as { dollars?: number }).dollars) : NaN;
  return Number.isFinite(value) && value > 0 ? { dollars: value, isDefault: false } : { dollars: DEFAULT_ROUTE_CAP_USD, isDefault: true };
}

export async function setRouteCapValue(db: Db, route: BlockedRouteName, dollars: number, userId: string | null): Promise<void> {
  const values = { value: { dollars }, updatedByUserId: userId, updatedAt: new Date() };
  await db.insert(appSetting).values({ key: capKey(route), ...values }).onConflictDoUpdate({ target: appSetting.key, set: values });
}

/* The first day of this month, Pacific, as a timestamp (07:00 UTC on the 1st is never in the month before). */
export function pacificMonthStart(now = new Date()): Date {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(now).split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1, 7));
}

export async function routeSpentThisMonth(db: Db, route: BlockedRouteName, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${siteReadCall.costUsd}), 0)` })
    .from(siteReadCall)
    .where(and(eq(siteReadCall.route, route), gte(siteReadCall.createdAt, pacificMonthStart(now))));
  return Number(row?.total ?? 0);
}

export interface RouteCall {
  projectId: string;
  readId: string | null;
  route: BlockedRouteName;
  kind: "home" | "screenshot" | "page";
  url: string;
  tokens: number;
  costUsd: number;
  estimated: boolean;
  ok: boolean;
  message: string | null;
}

export async function recordRouteCall(db: Db, call: RouteCall): Promise<void> {
  await db.insert(siteReadCall).values({ ...call, url: call.url.slice(0, 2000), message: call.message?.slice(0, 500) ?? null });
}
