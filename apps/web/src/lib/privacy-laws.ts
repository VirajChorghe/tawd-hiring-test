import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { appSetting, privacyLaw } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Viewer } from "@tawd/core/permissions";
import { REVIEW_EVERY_DAYS, STATE_LAWS, lastChecked, projectStates, staleRules, type StateLawRule } from "@tawd/core/site";
import type { IntakeData } from "@tawd/core/intake";
import type { ServiceContext } from "@/lib/users";

/*
  The state privacy rules (28 September 2026): the admin page's table, each
  rule's last check, the quarterly "Review privacy laws", and the flag on a
  project in a state whose rules haven't been checked for three months.
  The wording and sources come from docs/policies (the source); the table
  keeps them in step and records the checks.
*/

type Db = Database;

export class PrivacyLawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyLawError";
  }
}

const REVIEW_KEY = "privacy_law_review";

/* The table follows docs/policies: new rules added, wording and sources updated; an admin's checks kept. */
export async function syncPrivacyLaws(db: Db): Promise<void> {
  for (const rule of STATE_LAWS) {
    const values = {
      state: rule.state,
      stateName: rule.stateName,
      lawName: rule.lawName,
      citation: rule.citation,
      appliesTo: rule.appliesTo,
      coverage: rule.coverage,
      wording: rule.addOn,
      sourceUrls: rule.sourceUrls,
      checkedOn: rule.checkedOn,
      notes: rule.notes ?? null,
      updatedAt: new Date(),
    };
    await db.insert(privacyLaw).values({ key: rule.key, ...values }).onConflictDoUpdate({ target: privacyLaw.key, set: values });
  }
}

export interface PrivacyLawRow {
  rule: StateLawRule;
  lastChecked: Date;
  checkedBy: string | null;
  stale: boolean;
}

async function adminChecks(db: Db): Promise<Record<string, Date | null>> {
  const rows = await db.select({ key: privacyLaw.key, at: privacyLaw.lastCheckedAt }).from(privacyLaw);
  return Object.fromEntries(rows.map((r) => [r.key, r.at]));
}

export async function loadPrivacyLaws(db: Db, people: Map<string, string>, now: Date = new Date()): Promise<{ rows: PrivacyLawRow[]; review: { at: Date; by: string | null } | null; reviewDue: boolean }> {
  await syncPrivacyLaws(db);
  const stored = await db.select().from(privacyLaw);
  const limit = now.getTime() - REVIEW_EVERY_DAYS * 86_400_000;
  const rows = STATE_LAWS.map((rule) => {
    const row = stored.find((s) => s.key === rule.key);
    const when = lastChecked(rule, row?.lastCheckedAt ?? null);
    return { rule, lastChecked: when, checkedBy: row?.lastCheckedByUserId ? (people.get(row.lastCheckedByUserId) ?? "a team member") : null, stale: when.getTime() < limit };
  });
  const review = await lastReview(db);
  return { rows, review, reviewDue: await isReviewDue(db, now) };
}

async function lastReview(db: Db): Promise<{ at: Date; by: string | null } | null> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, REVIEW_KEY)).limit(1);
  const value = row?.value as { at?: string } | undefined;
  return value?.at ? { at: new Date(value.at), by: row!.updatedByUserId } : null;
}

/*
  The quarterly reminder: three months after the last review, or, before
  the first one, after the oldest date the rules were checked in the repo.
*/
export async function isReviewDue(db: Db, now: Date = new Date()): Promise<boolean> {
  const review = await lastReview(db);
  const oldest = STATE_LAWS.length ? Math.min(...STATE_LAWS.map((r) => new Date(`${r.checkedOn}T12:00:00Z`).getTime())) : now.getTime();
  const since = review?.at.getTime() ?? oldest;
  return now.getTime() - since > REVIEW_EVERY_DAYS * 86_400_000;
}

/* An admin checked one rule against its official source today. */
export async function markLawChecked(ctx: ServiceContext, actor: Viewer, key: string): Promise<void> {
  if (!actor.isAdmin) throw new PrivacyLawError("Only an admin records a privacy law check.");
  const rule = STATE_LAWS.find((r) => r.key === key);
  if (!rule) throw new PrivacyLawError("That rule isn't in the list.");
  await syncPrivacyLaws(ctx.db);
  await ctx.db.update(privacyLaw).set({ lastCheckedAt: new Date(), lastCheckedByUserId: actor.id }).where(eq(privacyLaw.key, key));
  await recordActivity(ctx.db, { action: "privacy_law.checked", entityType: "setting", entityId: REVIEW_KEY, ...actorFields(actor), valueAfter: { law: `${rule.stateName}: ${rule.lawName}` }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* The quarterly review, done: every rule checked against its official source; changes go into docs/policies first. */
export async function recordPrivacyReview(ctx: ServiceContext, actor: Viewer, note: string): Promise<void> {
  if (!actor.isAdmin) throw new PrivacyLawError("Only an admin records the privacy law review.");
  const text = note.trim();
  if (text.length < 3) throw new PrivacyLawError("Say what was checked (for example: every rule's source opened; no changes).");
  await syncPrivacyLaws(ctx.db);
  const now = new Date();
  await ctx.db.update(privacyLaw).set({ lastCheckedAt: now, lastCheckedByUserId: actor.id });
  const value = { at: now.toISOString(), note: text.slice(0, 1000) };
  await ctx.db.insert(appSetting).values({ key: REVIEW_KEY, value, updatedByUserId: actor.id }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByUserId: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, { action: "privacy_law.reviewed", entityType: "setting", entityId: REVIEW_KEY, ...actorFields(actor), valueAfter: { rules: STATE_LAWS.length, note: text }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* For a project's go-live flags: its states whose rules haven't been checked for three months. */
export async function privacyLawFlags(db: Db, intake: IntakeData, now: Date = new Date()): Promise<string[]> {
  const states = projectStates(intake);
  const stale = staleRules(states, await adminChecks(db), now);
  const byState = new Map<string, StateLawRule[]>();
  for (const rule of stale) byState.set(rule.stateName, [...(byState.get(rule.stateName) ?? []), rule]);
  return [...byState.entries()].map(
    ([state, rules]) => `${state}'s privacy rules (${rules.map((r) => r.lawName).join(", ")}) haven't been checked for over three months: an admin checks them on the Privacy laws page.`,
  );
}
