import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import type { Tier } from "@tawd/core/enums";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { addonPrice, appSetting, devTime, editRequest, project, siteBuild, updateInvoice, updateQuote } from "@tawd/core/schema";
import { INCLUDED_HOURS, categoryLabel, hoursFrom, isUpdateCategory, quoteLines, quoteNeed, quoteTotal, type QuoteLine, type UpdateCategory } from "@tawd/core/site";
import { formatMoney, loadProjectMoney } from "@/lib/pricing";
import type { BuiltPage } from "@/lib/site-builds";
import { pacificToday } from "@/lib/spend-report";
import type { ServiceContext } from "@/lib/users";

/*
  Updates, the step after Go live (Jason, 30 September 2026; built
  1 October, docs/plans/updates.md and DESIGN.md "Updates").

  Each request has a category, the PM's hours estimate and the built site's
  pages (every lane). A new page or a redesign is always quoted, and any
  other request is quoted for the hours it takes the month over the tier's
  included hours. Quotes are priced from the Pricing page only, and the
  client's answer is recorded before any work starts. At the end of the
  month an admin makes the invoice: every line theirs to enter or change.
*/

type Db = Database;

export class UpdatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdatesError";
  }
}

const HOURS_KEY = "included_hours";
const TIERS: Tier[] = ["starter", "growth", "pro"];

/* ---------- the included hours, per tier (admins, on Pricing) ---------- */

export async function includedHoursByTier(db: Db): Promise<Record<Tier, number>> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, HOURS_KEY)).limit(1);
  const value = (row?.value ?? {}) as Partial<Record<Tier, number | null>>;
  return Object.fromEntries(TIERS.map((t) => [t, typeof value[t] === "number" ? value[t]! : INCLUDED_HOURS])) as Record<Tier, number>;
}

export async function includedHoursFor(db: Db, projectId: string): Promise<number> {
  const [row] = await db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  return (await includedHoursByTier(db))[(row?.tier ?? "starter") as Tier];
}

export async function setIncludedHours(ctx: ServiceContext, actor: Viewer, tier: Tier, hours: string): Promise<void> {
  assertCan(actor, "money.manage");
  if (!TIERS.includes(tier)) throw new UpdatesError("That tier doesn't exist.");
  const value = Number(hours.trim());
  if (!Number.isFinite(value) || value < 0 || value > 200 || Math.round(value * 4) !== value * 4) throw new UpdatesError("Give the hours as a number from 0 to 200 (quarter hours allowed).");
  const before = await includedHoursByTier(ctx.db);
  if (before[tier] === value) return;
  const next = { ...before, [tier]: value };
  await ctx.db.insert(appSetting).values({ key: HOURS_KEY, value: next, updatedByUserId: actor.id }).onConflictDoUpdate({ target: appSetting.key, set: { value: next, updatedByUserId: actor.id, updatedAt: new Date() } });
  await recordActivity(ctx.db, {
    action: "pricing.included_hours_changed",
    entityType: "setting",
    entityId: HOURS_KEY,
    ...actorFields(actor),
    valueBefore: { tier, hours: before[tier] },
    valueAfter: { tier, hours: value },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- the built site's pages (every lane) ---------- */

export async function builtPages(db: Db, projectId: string): Promise<{ pageId: string; name: string; path: string }[]> {
  const [done] = await db.select({ pages: siteBuild.pages }).from(siteBuild).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done"))).orderBy(desc(siteBuild.version)).limit(1);
  return ((done?.pages as BuiltPage[] | null) ?? []).map((p) => ({ pageId: p.pageId, name: p.name, path: p.path }));
}

/* ---------- the month ---------- */

export function monthOf(day: string): string {
  return day.slice(0, 7);
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

const CLOSED = ["done", "declined", "rebuilt"];

export interface MonthPlan {
  month: string;
  included: number;
  usedMinutes: number;
  /** The estimates of open requests, less the time already logged on them. */
  plannedMinutes: number;
  leftMinutes: number;
  line: string;
}

export async function monthPlan(db: Db, projectId: string, now = new Date()): Promise<MonthPlan> {
  const month = monthOf(pacificToday(now));
  const { from, to } = monthBounds(month);
  const included = await includedHoursFor(db, projectId);
  const times = await db.select().from(devTime).where(and(eq(devTime.projectId, projectId), gte(devTime.workedOn, from), lte(devTime.workedOn, to)));
  const usedMinutes = times.reduce((n, t) => n + t.minutes, 0);
  const requests = await db.select().from(editRequest).where(eq(editRequest.projectId, projectId));
  const quotes = await db.select().from(updateQuote).where(eq(updateQuote.projectId, projectId));
  const allTime = requests.length ? await db.select().from(devTime).where(inArray(devTime.requestId, requests.map((r) => r.id))) : [];
  // Open requests the included hours are planned for (quoted ones are paid for separately).
  const plannedMinutes = requests
    .filter((r) => !CLOSED.includes(r.status) && r.kind === "edit" && !quotes.some((q) => q.requestId === r.id))
    .reduce((n, r) => n + Math.max(0, (r.estimateMinutes ?? 0) - allTime.filter((t) => t.requestId === r.id).reduce((m, t) => m + t.minutes, 0)), 0);
  const leftMinutes = Math.max(0, included * 60 - usedMinutes - plannedMinutes);
  const monthName = new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return { month, included, usedMinutes, plannedMinutes, leftMinutes, line: `${monthName}: ${hoursFrom(usedMinutes)} of ${included} included hours` };
}

/* ---------- a request ---------- */

async function prices(db: Db): Promise<Map<string, { name: string; priceCents: number | null }>> {
  const rows = await db.select().from(addonPrice);
  return new Map(rows.map((r) => [r.key, { name: r.name, priceCents: r.priceCents }]));
}

export interface RequestInput {
  clientWords: string;
  teamNote: string;
  requestedOn: string;
  category: string;
  redesign: boolean;
  /** Hours, quarter hours allowed. */
  estimateHours: string;
  /** The built site's page ids. */
  pageIds: string[];
}

function parseEstimate(value: string): number {
  const hours = Number(value.trim());
  if (!Number.isFinite(hours) || hours <= 0 || hours > 100 || Math.round(hours * 4) !== hours * 4) throw new UpdatesError("Give the hours estimate as a number, for example 0.5, 1 or 2.25.");
  return Math.round(hours * 60);
}

/* What logging this request would do: fits the included hours, or becomes a quote (and why). Nothing is saved. */
export async function previewRequest(db: Db, projectId: string, input: Pick<RequestInput, "category" | "redesign" | "estimateHours">) {
  if (!isUpdateCategory(input.category)) return null;
  let estimateMinutes: number;
  try {
    estimateMinutes = parseEstimate(input.estimateHours);
  } catch {
    return null;
  }
  const plan = await monthPlan(db, projectId);
  const need = quoteNeed({ category: input.category, redesign: input.redesign, estimateMinutes, usedMinutes: plan.usedMinutes, plannedMinutes: plan.plannedMinutes, includedHours: plan.included });
  const lines = quoteLines(need, await prices(db));
  return { need, lines, total: quoteTotal(lines) };
}

export async function logUpdateRequest(ctx: ServiceContext, actor: Viewer, projectId: string, input: RequestInput): Promise<{ requestId: string; quoteId: string | null }> {
  assertCan(actor, "project.edit");
  const words = input.clientWords.trim();
  if (words.length < 5) throw new UpdatesError("Write down what the client asked for, in their words.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedOn)) throw new UpdatesError("Give the day the client asked.");
  if (!isUpdateCategory(input.category)) throw new UpdatesError("Choose the category.");
  const category: UpdateCategory = input.category;
  const estimateMinutes = parseEstimate(input.estimateHours);
  const pages = await builtPages(ctx.db, projectId);
  // A new page has no existing page, whatever the form still had ticked.
  const chosen = category === "new_page" ? [] : pages.filter((p) => input.pageIds.includes(p.pageId));
  if (category !== "new_page" && chosen.length === 0 && pages.length > 0) throw new UpdatesError("Choose the page or pages it's on.");
  const plan = await monthPlan(ctx.db, projectId);
  const need = quoteNeed({ category, redesign: category === "design" && input.redesign, estimateMinutes, usedMinutes: plan.usedMinutes, plannedMinutes: plan.plannedMinutes, includedHours: plan.included });
  const [row] = await ctx.db
    .insert(editRequest)
    .values({
      projectId,
      kind: need.quote ? "quote" : "edit",
      clientWords: words.slice(0, 4000),
      teamNote: input.teamNote.trim().slice(0, 2000),
      requestedOn: input.requestedOn,
      pageIds: chosen.map((p) => p.pageId),
      pagePaths: chosen.map((p) => p.path),
      category,
      redesign: category === "design" && input.redesign,
      estimateMinutes,
      status: need.quote ? "quoted" : "open",
      createdByUserId: actor.id,
    })
    .returning({ id: editRequest.id });
  let quoteId: string | null = null;
  if (need.quote) {
    const lines = quoteLines(need, await prices(ctx.db));
    const [quote] = await ctx.db.insert(updateQuote).values({ projectId, requestId: row!.id, lines, totalCents: quoteTotal(lines), createdByUserId: actor.id }).returning({ id: updateQuote.id });
    quoteId = quote!.id;
  }
  await recordActivity(ctx.db, {
    action: "site.edit_requested",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { kind: need.quote ? "quote" : "edit", category: categoryLabel(category), request: words.slice(0, 500), requestedOn: input.requestedOn, pages: chosen.length, estimateHours: hoursFrom(estimateMinutes), quoted: need.reason },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { requestId: row!.id, quoteId };
}

/* ---------- quotes ---------- */

export interface QuoteView {
  id: string;
  requestId: string;
  request: string;
  requestedOn: string;
  status: string;
  lines: QuoteLine[];
  totalCents: number | null;
  decisionLine: string | null;
  createdAt: Date;
}

/* A waiting quote follows the Pricing page (a price set later fills its line); an answered one keeps its prices. */
export async function loadQuotes(db: Db, projectId: string): Promise<QuoteView[]> {
  const rows = await db.select().from(updateQuote).where(eq(updateQuote.projectId, projectId)).orderBy(desc(updateQuote.createdAt));
  if (!rows.length) return [];
  const requests = await db.select().from(editRequest).where(inArray(editRequest.id, rows.map((r) => r.requestId)));
  const priceList = await prices(db);
  return rows.map((q) => {
    const lines = q.status === "waiting"
      ? q.lines.map((l) => {
          const unitCents = priceList.get(l.key)?.priceCents ?? null;
          return { ...l, unitCents, amountCents: unitCents === null ? null : Math.round(unitCents * l.quantity) };
        })
      : q.lines;
    const request = requests.find((r) => r.id === q.requestId);
    return {
      id: q.id,
      requestId: q.requestId,
      request: request?.clientWords ?? "",
      requestedOn: request?.requestedOn ?? "",
      status: q.status,
      lines,
      totalCents: q.status === "waiting" ? quoteTotal(lines) : q.totalCents,
      decisionLine: q.decidedAt ? `${q.status === "approved" ? "Approved" : "Declined"} (${q.decisionChannel}): "${q.clientSaid}"` : null,
      createdAt: q.createdAt,
    };
  });
}

export const ANSWER_CHANNELS = ["phone call", "email", "text message", "in person", "video call"] as const;

export async function recordQuoteAnswer(ctx: ServiceContext, actor: Viewer, projectId: string, quoteId: string, input: { outcome: "approved" | "declined"; channel: string; clientSaid: string }): Promise<void> {
  assertCan(actor, "project.edit");
  const [quote] = (await loadQuotes(ctx.db, projectId)).filter((q) => q.id === quoteId);
  if (!quote) throw new UpdatesError("That quote is no longer here.");
  if (quote.status !== "waiting") throw new UpdatesError("The client's answer is already recorded.");
  if (!(ANSWER_CHANNELS as readonly string[]).includes(input.channel)) throw new UpdatesError("Choose how the client's answer came in.");
  const said = input.clientSaid.trim();
  if (said.length < 3) throw new UpdatesError("Write down what the client said.");
  if (input.outcome === "approved" && quote.totalCents === null) throw new UpdatesError("A price on this quote isn't set yet: an admin sets it on Pricing first.");
  await ctx.db
    .update(updateQuote)
    .set({ status: input.outcome, lines: quote.lines, totalCents: quote.totalCents, decisionChannel: input.channel, clientSaid: said.slice(0, 2000), decidedAt: new Date(), decidedByUserId: actor.id })
    .where(eq(updateQuote.id, quoteId));
  // Approved: the work can start (as an edit). Declined: the request is closed.
  await ctx.db
    .update(editRequest)
    .set(input.outcome === "approved" ? { kind: "edit", status: "open" } : { status: "declined", closedAt: new Date() })
    .where(eq(editRequest.id, quote.requestId));
  await recordActivity(ctx.db, {
    action: "site.quote_answered",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { outcome: input.outcome, channel: input.channel, clientSaid: said.slice(0, 500), total: formatMoney(quote.totalCents), request: quote.request.slice(0, 200) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- the monthly invoice (admins) ---------- */

export interface InvoiceLine {
  date: string;
  task: string;
  category: string;
  hours: number;
  amountCents: number;
}

/* A first draft from the month's work, for the admin to change: time logged, approved quotes, the monthly plan. */
export async function draftInvoiceLines(db: Db, projectId: string, month: string): Promise<InvoiceLine[]> {
  const { from, to } = monthBounds(month);
  const times = await db.select().from(devTime).where(and(eq(devTime.projectId, projectId), gte(devTime.workedOn, from), lte(devTime.workedOn, to)));
  const requests = await db.select().from(editRequest).where(eq(editRequest.projectId, projectId));
  const lines: InvoiceLine[] = [];
  const money = await loadProjectMoney(db, projectId);
  if (money && money.monthlyFeeCents !== null) lines.push({ date: to, task: `Monthly plan (includes ${await includedHoursFor(db, projectId)} hours of updates)`, category: "Plan", hours: 0, amountCents: money.monthlyFeeCents });
  for (const r of requests) {
    const minutes = times.filter((t) => t.requestId === r.id).reduce((n, t) => n + t.minutes, 0);
    if (!minutes) continue;
    lines.push({ date: r.requestedOn, task: r.clientWords.replace(/\s+/g, " ").slice(0, 200), category: categoryLabel(r.category), hours: hoursFrom(minutes), amountCents: 0 });
  }
  const general = times.filter((t) => !t.requestId).reduce((n, t) => n + t.minutes, 0);
  if (general) lines.push({ date: to, task: "Other updates this month", category: "Not set", hours: hoursFrom(general), amountCents: 0 });
  for (const q of await loadQuotes(db, projectId)) {
    const decided = (await db.select({ at: updateQuote.decidedAt }).from(updateQuote).where(eq(updateQuote.id, q.id)))[0]?.at;
    if (q.status !== "approved" || !decided) continue;
    const day = pacificToday(decided);
    if (day < from || day > to) continue;
    lines.push({ date: day, task: `Quote: ${q.request.replace(/\s+/g, " ").slice(0, 160)}`, category: "Quote", hours: 0, amountCents: q.totalCents ?? 0 });
  }
  return lines.sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadInvoice(db: Db, projectId: string, month: string) {
  const [row] = await db.select().from(updateInvoice).where(and(eq(updateInvoice.projectId, projectId), eq(updateInvoice.month, month))).limit(1);
  return row ?? null;
}

function cleanLines(lines: InvoiceLine[]): InvoiceLine[] {
  if (!Array.isArray(lines) || lines.length > 200) throw new UpdatesError("An invoice has between 1 and 200 lines.");
  return lines.map((l, i) => {
    const task = String(l.task ?? "").trim();
    if (!task) throw new UpdatesError(`Line ${i + 1} needs a task.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) throw new UpdatesError(`Line ${i + 1} needs a date.`);
    const hours = Number(l.hours);
    const amountCents = Number(l.amountCents);
    if (!Number.isFinite(hours) || hours < 0 || hours > 500) throw new UpdatesError(`Line ${i + 1}: the hours must be a number from 0 to 500.`);
    if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > 100_000_000) throw new UpdatesError(`Line ${i + 1}: the amount must be dollars and cents.`);
    return { date: String(l.date), task: task.slice(0, 300), category: String(l.category ?? "").trim().slice(0, 60) || "Not set", hours: Math.round(hours * 100) / 100, amountCents };
  });
}

export async function saveInvoice(ctx: ServiceContext, actor: Viewer, projectId: string, month: string, lines: InvoiceLine[]): Promise<void> {
  assertCan(actor, "money.manage");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new UpdatesError("That month isn't valid.");
  const clean = cleanLines(lines);
  if (!clean.length) throw new UpdatesError("An invoice has between 1 and 200 lines.");
  const totalCents = clean.reduce((n, l) => n + l.amountCents, 0);
  const existing = await loadInvoice(ctx.db, projectId, month);
  if (existing) await ctx.db.update(updateInvoice).set({ lines: clean, totalCents, updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(updateInvoice.id, existing.id));
  else await ctx.db.insert(updateInvoice).values({ projectId, month, lines: clean, totalCents, updatedByUserId: actor.id });
  await recordActivity(ctx.db, {
    action: "site.invoice_saved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: existing ? { month, total: formatMoney(existing.totalCents), lines: existing.lines.length } : undefined,
    valueAfter: { month, total: formatMoney(totalCents), lines: clean.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The invoice as CSV, for the books. */
export function invoiceCsv(clientName: string, month: string, lines: InvoiceLine[]): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = [["Client", "Month", "Date", "Task", "Category", "Hours", "Amount"], ...lines.map((l) => [clientName, month, l.date, l.task, l.category, String(l.hours), (l.amountCents / 100).toFixed(2)])];
  rows.push([clientName, month, "", "Total", "", String(Math.round(lines.reduce((n, l) => n + l.hours, 0) * 100) / 100), (lines.reduce((n, l) => n + l.amountCents, 0) / 100).toFixed(2)]);
  return rows.map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

/* The months that can have an invoice: from go-live (or the first logged work) to this month. */
export async function invoiceMonths(db: Db, projectId: string, now = new Date()): Promise<string[]> {
  const [row] = await db.select({ liveAt: project.liveAt }).from(project).where(eq(project.id, projectId)).limit(1);
  const [first] = await db.select({ day: devTime.workedOn }).from(devTime).where(eq(devTime.projectId, projectId)).orderBy(devTime.workedOn).limit(1);
  const current = monthOf(pacificToday(now));
  const starts = [row?.liveAt ? monthOf(pacificToday(row.liveAt)) : null, first?.day ? monthOf(first.day) : null].filter(Boolean) as string[];
  let start = starts.sort()[0] ?? current;
  if (start > current) start = current;
  const months: string[] = [];
  let [y, m] = current.split("-").map(Number) as [number, number];
  while (months.length < 24) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    months.push(key);
    if (key <= start) break;
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}
