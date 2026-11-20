import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { addonPrice, packagePrice, project, projectAddon } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { ServiceContext } from "@/lib/users";

/*
  Pricing and revenue (Phase 5, 26 September 2026), admins only.

  The price list holds each package's build fee and monthly fee. A project
  copies its package's prices when it is created and keeps them; an admin
  can change one project's price with a reason. Going Live counts as paid:
  the build fee counts in the month the project went live, and the monthly
  fee counts every month from that month on, up to and including the month
  it was cancelled in. Money is whole cents. No card or payment data.
*/

type Db = ServiceContext["db"];

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

export interface PackageView {
  key: string;
  name: string;
  buildFeeCents: number | null;
  monthlyFeeCents: number | null;
}

export async function listPackages(db: Db): Promise<PackageView[]> {
  const rows = await db.select().from(packagePrice).orderBy(asc(packagePrice.sortOrder), asc(packagePrice.name));
  return rows.map((r) => ({ key: r.key, name: r.name, buildFeeCents: r.buildFeeCents, monthlyFeeCents: r.monthlyFeeCents }));
}

/* "$199", "$1,250.50", or null for blank. */
export function formatMoney(cents: number | null): string {
  if (cents === null) return "Not set";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/* "199", "199.5", "$1,250" or "" (blank) to cents; null for blank; throws for anything else. */
export function parseMoney(value: string): number | null {
  const text = value.replace(/[$,\s]/g, "");
  if (!text) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new PricingError(`"${value}" isn't an amount in dollars, such as 199 or 1250.50.`);
  return Math.round(Number(text) * 100);
}

/* Adds a package or changes one; every change is logged with before and after. */
export async function savePackage(
  ctx: ServiceContext,
  actor: Viewer,
  input: { key?: string | null; name: string; buildFee: string; monthlyFee: string },
): Promise<string> {
  assertCan(actor, "money.manage");
  const name = input.name.trim();
  if (!name) throw new PricingError("Give the package a name.");
  const buildFeeCents = parseMoney(input.buildFee);
  const monthlyFeeCents = parseMoney(input.monthlyFee);
  const rows = await ctx.db.select().from(packagePrice);

  if (input.key) {
    const before = rows.find((r) => r.key === input.key);
    if (!before) throw new PricingError("That package no longer exists.");
    if (before.name === name && before.buildFeeCents === buildFeeCents && before.monthlyFeeCents === monthlyFeeCents) return before.key;
    await ctx.db.update(packagePrice).set({ name, buildFeeCents, monthlyFeeCents, updatedAt: new Date() }).where(eq(packagePrice.key, before.key));
    await recordActivity(ctx.db, {
      action: "pricing.package_saved",
      entityType: "setting",
      entityId: `package:${before.key}`,
      ...actorFields(actor),
      valueBefore: { name: before.name, buildFeeCents: before.buildFeeCents, monthlyFeeCents: before.monthlyFeeCents },
      valueAfter: { name, buildFeeCents, monthlyFeeCents },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return before.key;
  }

  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "package";
  let key = base;
  for (let n = 2; rows.some((r) => r.key === key); n += 1) key = `${base}-${n}`;
  if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new PricingError(`There is already a package called ${name}.`);
  await ctx.db.insert(packagePrice).values({ key, name, buildFeeCents, monthlyFeeCents, sortOrder: rows.length + 1 });
  await recordActivity(ctx.db, {
    action: "pricing.package_saved",
    entityType: "setting",
    entityId: `package:${key}`,
    ...actorFields(actor),
    valueBefore: null,
    valueAfter: { name, buildFeeCents, monthlyFeeCents },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return key;
}

/* What a new project of this tier is sold at today: copied onto the project, never linked. */
export async function priceSnapshot(db: Db, tier: string): Promise<{ packageKey: string; buildFeeCents: number | null; monthlyFeeCents: number | null }> {
  const [row] = await db.select().from(packagePrice).where(eq(packagePrice.key, tier)).limit(1);
  return { packageKey: tier, buildFeeCents: row?.buildFeeCents ?? null, monthlyFeeCents: row?.monthlyFeeCents ?? null };
}

/* One project's price, changed by an admin, with a reason (logged). */
export async function setProjectPrice(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { packageKey: string; buildFee: string; monthlyFee: string; reason: string },
): Promise<void> {
  assertCan(actor, "money.manage");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new PricingError("Say why the price is changing (a few words): it goes in the log.");
  const [row] = await ctx.db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new PricingError("That project no longer exists.");
  const packages = await listPackages(ctx.db);
  const chosen = packages.find((p) => p.key === input.packageKey);
  if (!chosen) throw new PricingError("Choose a package from the price list.");
  const buildFeeCents = parseMoney(input.buildFee);
  const monthlyFeeCents = parseMoney(input.monthlyFee);
  await ctx.db.update(project).set({ packageKey: input.packageKey, buildFeeCents, monthlyFeeCents, updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.price_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { packageKey: row.packageKey, buildFeeCents: row.buildFeeCents, monthlyFeeCents: row.monthlyFeeCents },
    valueAfter: { packageKey: input.packageKey, packageName: chosen.name, buildFeeCents, monthlyFeeCents, reason },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Cancelled on a date (the monthly fee stops after that month), or the cancellation undone. Logged. */
export async function setProjectCancelled(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { on: string; reason: string } | null,
): Promise<void> {
  assertCan(actor, "money.manage");
  const [row] = await ctx.db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new PricingError("That project no longer exists.");
  if (input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.on)) throw new PricingError("Give the date it was cancelled.");
    const reason = input.reason.trim();
    if (reason.length < 3) throw new PricingError("Say why it was cancelled: it goes in the log.");
    await ctx.db.update(project).set({ cancelledOn: input.on, cancelReason: reason, updatedAt: new Date() }).where(eq(project.id, projectId));
  } else {
    if (!row.cancelledOn) return;
    await ctx.db.update(project).set({ cancelledOn: null, cancelReason: null, updatedAt: new Date() }).where(eq(project.id, projectId));
  }
  await recordActivity(ctx.db, {
    action: input ? "project.cancelled" : "project.cancellation_undone",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { cancelledOn: row.cancelledOn, reason: row.cancelReason },
    valueAfter: input ? { cancelledOn: input.on, reason: input.reason.trim() } : { cancelledOn: null },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- revenue ---------- */

export interface RevenueProject {
  id: string;
  clientName: string;
  packageKey: string | null;
  buildFeeCents: number | null;
  monthlyFeeCents: number | null;
  liveAt: Date | null;
  cancelledOn: string | null;
  /** One-off add-ons on the project, counted with the build fee. */
  addonCents?: number;
  /** Monthly add-ons (WordPress hosting), counted with the monthly fee. */
  monthlyAddonCents?: number;
}

/* "2026-09" for a date, in the team's time zone (Pacific). */
export function monthOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

/*
  Each month's money: build fees of the projects that went live that month,
  and the monthly fee of every project live by that month and not cancelled
  before it began (a project cancelled on 15 October still counts in
  October, not in November).
*/
export function revenueByMonth(projects: RevenueProject[], months: string[]): { month: string; buildFees: number; monthlyFees: number; total: number; liveClients: number }[] {
  return months.map((month) => {
    let buildFees = 0;
    let monthlyFees = 0;
    let liveClients = 0;
    for (const p of projects) {
      if (!p.liveAt) continue;
      const live = monthOf(p.liveAt);
      if (live === month) buildFees += (p.buildFeeCents ?? 0) + (p.addonCents ?? 0);
      const cancelled = p.cancelledOn ? p.cancelledOn.slice(0, 7) : null;
      if (live <= month && (!cancelled || cancelled >= month)) {
        monthlyFees += (p.monthlyFeeCents ?? 0) + (p.monthlyAddonCents ?? 0);
        liveClients += 1;
      }
    }
    return { month, buildFees, monthlyFees, total: buildFees + monthlyFees, liveClients };
  });
}

/* The last twelve months, oldest first, ending with this one. */
export function lastMonths(now: Date, count = 12): string[] {
  const [year, month] = monthOf(now).split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 15));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export interface RevenueReport {
  months: ReturnType<typeof revenueByMonth>;
  thisMonth: ReturnType<typeof revenueByMonth>[number];
  clients: (RevenueProject & { packageName: string; state: "active" | "cancelled"; monthsLive: number; underMinimum: boolean })[];
  /** Live projects with no price recorded: they count as $0 until an admin sets one. */
  unpriced: string[];
}

export async function loadRevenue(db: Db, now = new Date()): Promise<RevenueReport> {
  const rows = await db
    .select({
      id: project.id,
      clientName: project.clientName,
      packageKey: project.packageKey,
      buildFeeCents: project.buildFeeCents,
      monthlyFeeCents: project.monthlyFeeCents,
      liveAt: project.liveAt,
      cancelledOn: project.cancelledOn,
    })
    .from(project)
    .where(isNotNull(project.liveAt));
  const packages = await listPackages(db);
  const addons = rows.length ? await db.select().from(projectAddon).where(isNull(projectAddon.removedAt)) : [];
  for (const row of rows as RevenueProject[]) {
    const own = addons.filter((a) => a.projectId === row.id);
    // A per-page add-on charges its price for each page (27 September 2026).
    row.addonCents = own.filter((a) => !a.monthly).reduce((n, a) => n + (a.priceCents ?? 0) * a.quantity, 0);
    row.monthlyAddonCents = own.filter((a) => a.monthly).reduce((n, a) => n + (a.priceCents ?? 0) * a.quantity, 0);
  }
  const months = revenueByMonth(rows, lastMonths(now));
  const current = monthOf(now);
  const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  return {
    months,
    thisMonth: months.at(-1)!,
    clients: rows
      .map((r) => {
        const end = r.cancelledOn ? r.cancelledOn.slice(0, 7) : current;
        const monthsLive = Math.max(1, monthIndex(end) - monthIndex(monthOf(r.liveAt!)) + 1);
        return {
          ...r,
          packageName: packages.find((p) => p.key === r.packageKey)?.name ?? r.packageKey ?? "No package",
          state: (r.cancelledOn ? "cancelled" : "active") as "active" | "cancelled",
          monthsLive,
          underMinimum: Boolean(r.cancelledOn) && monthsLive < 12,
        };
      })
      .sort((a, b) => a.liveAt!.getTime() - b.liveAt!.getTime()),
    unpriced: rows.filter((r) => r.buildFeeCents === null && r.monthlyFeeCents === null).map((r) => r.clientName),
  };
}

/* One project's money, for the admin panel on its overview. */
export async function loadProjectMoney(db: Db, projectId: string) {
  const [row] = await db
    .select({
      packageKey: project.packageKey,
      buildFeeCents: project.buildFeeCents,
      monthlyFeeCents: project.monthlyFeeCents,
      liveAt: project.liveAt,
      cancelledOn: project.cancelledOn,
      cancelReason: project.cancelReason,
    })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) return null;
  const packages = await listPackages(db);
  const addons = await projectAddons(db, projectId);
  return { ...row, packageName: packages.find((p) => p.key === row.packageKey)?.name ?? null, packages, addons: addons.map((a) => ({ name: a.name, priceCents: a.priceCents, monthly: a.monthly, quantity: a.quantity })) };
}

/* "September 2026" for "2026-09". */
export function monthLabel(month: string): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/* "Sep 26, 2026" for a date or "2026-09-26", in Pacific time. */
export function dayLabel(value: Date | string): string {
  const date = typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: typeof value === "string" ? "UTC" : "America/Los_Angeles" });
}

/* Cents as the text for a dollars input box: "199", "12.50", or "" for blank. */
export function moneyInputValue(cents: number | null): string {
  if (cents === null) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/* ---------- add-ons (Jason, 26 September 2026) ---------- */

export interface AddonView {
  key: string;
  name: string;
  priceCents: number | null;
  quoted: boolean;
  monthly: boolean;
  perPage: boolean;
}

export async function listAddons(db: Db): Promise<AddonView[]> {
  const rows = await db.select().from(addonPrice).orderBy(asc(addonPrice.sortOrder), asc(addonPrice.name));
  return rows.map((r) => ({ key: r.key, name: r.name, priceCents: r.priceCents, quoted: r.quoted, monthly: r.monthly, perPage: r.perPage }));
}

/*
  An admin sets an add-on's price. Logged with before and after. Projects
  that took the add-on while it had no price get this first price (each
  logged); a project that already has a price keeps it.
*/
export async function saveAddonPrice(ctx: ServiceContext, actor: Viewer, key: string, price: string): Promise<void> {
  assertCan(actor, "money.manage");
  const [before] = await ctx.db.select().from(addonPrice).where(eq(addonPrice.key, key)).limit(1);
  if (!before) throw new PricingError("That add-on no longer exists.");
  if (before.quoted) throw new PricingError(`${before.name} is quoted case by case, so it has no list price.`);
  const priceCents = parseMoney(price);
  if (priceCents === before.priceCents) return;
  await ctx.db.update(addonPrice).set({ priceCents, updatedAt: new Date() }).where(eq(addonPrice.key, key));
  await recordActivity(ctx.db, {
    action: "pricing.addon_saved",
    entityType: "setting",
    entityId: `addon:${key}`,
    ...actorFields(actor),
    valueBefore: { name: before.name, priceCents: before.priceCents },
    valueAfter: { name: before.name, priceCents },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  if (priceCents === null) return;
  const waiting = await ctx.db
    .update(projectAddon)
    .set({ priceCents })
    .where(and(eq(projectAddon.addonKey, key), isNull(projectAddon.priceCents), isNull(projectAddon.removedAt)))
    .returning({ projectId: projectAddon.projectId });
  for (const row of waiting) {
    await recordActivity(ctx.db, {
      action: "project.addon_priced",
      entityType: "project",
      entityId: row.projectId,
      ...actorFields(actor),
      valueBefore: { addon: before.name, priceCents: null },
      valueAfter: { addon: before.name, priceCents },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
}

/* The project's add-ons still on it. */
export async function projectAddons(db: Db, projectId: string) {
  return db
    .select()
    .from(projectAddon)
    .where(and(eq(projectAddon.projectId, projectId), isNull(projectAddon.removedAt)))
    .orderBy(asc(projectAddon.createdAt));
}

/*
  Adds an add-on to a project at today's price (kept even if the list
  price changes later), or does nothing if it's already on. Logged.
  Recording what was sold is a PM's job, so it needs intake.edit, not
  money.manage; only admins see the prices.
*/
export async function addProjectAddon(ctx: ServiceContext, actor: Viewer, projectId: string, key: string, overridePriceCents?: number | null): Promise<void> {
  assertCan(actor, "intake.edit");
  const [addon] = await ctx.db.select().from(addonPrice).where(eq(addonPrice.key, key)).limit(1);
  if (!addon) throw new PricingError("That add-on isn't on the price list.");
  const existing = (await projectAddons(ctx.db, projectId)).find((a) => a.addonKey === key);
  if (existing) return;
  const priceCents = overridePriceCents === undefined ? addon.priceCents : overridePriceCents;
  await ctx.db.insert(projectAddon).values({ projectId, addonKey: key, name: addon.name, priceCents, monthly: addon.monthly, addedByUserId: actor.id });
  await recordActivity(ctx.db, {
    action: "project.addon_added",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { addon: addon.name, priceCents, ...(addon.monthly ? { monthly: true } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function removeProjectAddon(ctx: ServiceContext, actor: Viewer, projectId: string, key: string): Promise<void> {
  assertCan(actor, "intake.edit");
  const existing = (await projectAddons(ctx.db, projectId)).find((a) => a.addonKey === key);
  if (!existing) return;
  await ctx.db.update(projectAddon).set({ removedAt: new Date() }).where(eq(projectAddon.id, existing.id));
  await recordActivity(ctx.db, {
    action: "project.addon_removed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { addon: existing.name, priceCents: existing.priceCents },
    valueAfter: null,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
