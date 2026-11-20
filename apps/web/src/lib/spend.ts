import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { callCost } from "@tawd/core/mockups";
import {
  aiCall,
  appSetting,
  concept,
  deletedProject,
  seoDataCall,
  mockupRun,
  project,
  user as userTable,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { getModelConfig } from "@tawd/core/mockups";
import { sweepStuckWork } from "@tawd/core/stuck-work";
import {
  DEFAULT_MONTHLY_LIMIT_USD,
  blockedMessage,
  buildSpendReport,
  limitState,
  pacificToday,
  type CallRow,
  type LimitState,
  type Period,
  type RunRow,
} from "@/lib/spend-report";
import { personLabel, type ServiceContext } from "@/lib/users";
import { getSeoLimit, seoSetup, seoSpendThisMonth } from "@/lib/seo-data";

/*
  Loading what the Spend page needs, and the monthly limit.

  Everything is filtered by Pacific day in SQL, so "September" means the
  same thing here as on every other screen. The figures themselves are
  worked out in spend-report.ts.
*/

const PACIFIC_DAY = (column: unknown) =>
  sql<string>`to_char((${column} at time zone 'America/Los_Angeles')::date, 'YYYY-MM-DD')`;

const LIMIT_KEY = "monthly_ai_limit_usd";

export class SpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendError";
  }
}

/* ---------- the monthly limit ---------- */

export async function getMonthlyLimit(
  db: Database,
): Promise<{ dollars: number; isDefault: boolean }> {
  const [row] = await db
    .select()
    .from(appSetting)
    .where(eq(appSetting.key, LIMIT_KEY))
    .limit(1);
  const value = row ? Number((row.value as { dollars?: number }).dollars) : NaN;
  return Number.isFinite(value) && value > 0
    ? { dollars: value, isDefault: false }
    : { dollars: DEFAULT_MONTHLY_LIMIT_USD, isDefault: true };
}

export async function setMonthlyLimit(
  ctx: ServiceContext,
  actor: Viewer,
  dollars: number,
): Promise<void> {
  assertCan(actor, "settings.manage");

  if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 100_000) {
    throw new SpendError("Enter a monthly limit in dollars, above $0.");
  }
  const rounded = Math.round(dollars * 100) / 100;
  const before = await getMonthlyLimit(ctx.db);
  if (!before.isDefault && before.dollars === rounded) return;

  await ctx.db
    .insert(appSetting)
    .values({
      key: LIMIT_KEY,
      value: { dollars: rounded },
      updatedByUserId: actorFields(actor).actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: {
        value: { dollars: rounded },
        updatedByUserId: actorFields(actor).actorUserId,
        updatedAt: new Date(),
      },
    });

  await recordActivity(ctx.db, {
    action: "settings.monthly_limit_changed",
    entityType: "setting",
    entityId: LIMIT_KEY,
    ...actorFields(actor),
    valueBefore: { dollars: before.dollars, default: before.isDefault },
    valueAfter: { dollars: rounded },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/** What has been spent so far this calendar month, Pacific. */
export async function monthToDateSpend(
  db: Database,
  today: string = pacificToday(),
): Promise<number> {
  const from = `${today.slice(0, 7)}-01`;
  const rows = await db
    .select()
    .from(aiCall)
    .where(
      and(
        gte(PACIFIC_DAY(aiCall.createdAt), from),
        lte(PACIFIC_DAY(aiCall.createdAt), today),
      ),
    );
  const config = getModelConfig();
  return rows.reduce((n, c) => n + callCost(c, config), 0);
}

/** Where this month stands against the limit. Anyone signed in may ask. */
export async function getLimitState(db: Database): Promise<LimitState> {
  const [limit, spent] = await Promise.all([getMonthlyLimit(db), monthToDateSpend(db)]);
  return limitState(spent, limit.dollars);
}

/*
  The gate on spending: at 100% of the monthly limit nothing new starts.
  Generate uses it today; Request changes (3c) must call it too.
*/
export async function assertWithinMonthlyLimit(db: Database, cap?: { projectId: string; estimate: number }): Promise<void> {
  const state = await getLimitState(db);
  if (state.blocked) throw new SpendError(blockedMessage(state));
  if (cap) await assertWithinProjectCap(db, cap.projectId, cap.estimate);
}

/* ---------- a project's own cap (28 September 2026) ---------- */

export const TEST_PROJECT_CAP_CENTS = 500;

/* The project's cap in dollars and what it has spent, each call at its own model's rates; null cap is none. */
export async function projectCapState(db: Database, projectId: string): Promise<{ capDollars: number | null; spentDollars: number; isTest: boolean; savedCapCents: number | null }> {
  const [row] = await db.select({ isTest: project.isTest, aiCapCents: project.aiCapCents }).from(project).where(eq(project.id, projectId)).limit(1);
  const cents = row?.aiCapCents ?? (row?.isTest ? TEST_PROJECT_CAP_CENTS : null);
  const config = getModelConfig();
  const calls = await db.select().from(aiCall).where(eq(aiCall.projectId, projectId));
  return { capDollars: cents === null ? null : cents / 100, spentDollars: calls.reduce((n, c) => n + callCost(c, config), 0), isTest: Boolean(row?.isTest), savedCapCents: row?.aiCapCents ?? null };
}

/* A run that would take the project past its cap doesn't start (Jason, 28 September 2026). */
export async function assertWithinProjectCap(db: Database, projectId: string, estimate: number): Promise<void> {
  const state = await projectCapState(db, projectId);
  if (state.capDollars === null) return;
  if (state.spentDollars + estimate > state.capDollars) {
    const money = (n: number) => `$${n.toFixed(2)}`;
    throw new SpendError(
      `This ${state.isTest ? "test " : ""}project has used ${money(state.spentDollars)} of its ${money(state.capDollars)} AI cap, and this run (about ${money(estimate)}) would pass it. An admin can raise the cap on the project's page${state.spentDollars < state.capDollars ? ", or try fewer pages" : ""}.`,
    );
  }
}

/* ---------- the report ---------- */

export async function loadSpendReport(
  db: Database,
  viewer: Viewer,
  period: Period,
) {
  assertCan(viewer, "spend.view");

  // Runs the worker will never finish are settled first, so none sits at "Running".
  await sweepStuckWork(db);

  const inPeriod = (column: unknown) =>
    and(gte(PACIFIC_DAY(column), period.from), lte(PACIFIC_DAY(column), period.to));

  const callRows = await db
    .select({ call: aiCall, day: PACIFIC_DAY(aiCall.createdAt) })
    .from(aiCall)
    .where(inPeriod(aiCall.createdAt));

  const runRows = await db
    .select({ run: mockupRun, day: PACIFIC_DAY(mockupRun.createdAt) })
    .from(mockupRun)
    .where(inPeriod(mockupRun.createdAt));

  const runIds = runRows.map((r) => r.run.id);

  const conceptRows =
    runIds.length === 0
      ? []
      : await db
          .select({
            runId: concept.runId,
            label: concept.label,
            direction: concept.direction,
            status: concept.status,
          })
          .from(concept)
          .where(inArray(concept.runId, runIds));

  /*
    Runs of a deleted project lost their rows, but not their ledger entries.
    Those come back as runs rebuilt from the ledger, so "All runs" and the
    run counts still include them.
  */
  const liveRunIds = new Set(runIds);
  const ledgerOnlyRuns = new Map<string, { projectId: string; startedBy: string | null; first: Date }>();
  for (const { call } of callRows) {
    if (liveRunIds.has(call.runId)) continue;
    const seen = ledgerOnlyRuns.get(call.runId);
    if (!seen || call.createdAt < seen.first) {
      ledgerOnlyRuns.set(call.runId, {
        projectId: call.projectId,
        startedBy: call.startedByUserId,
        first: call.createdAt,
      });
    }
  }

  const allRunIds = [...runIds, ...ledgerOnlyRuns.keys()];
  const runCallRows =
    allRunIds.length === 0
      ? []
      : await db
          .select({ call: aiCall, day: PACIFIC_DAY(aiCall.createdAt) })
          .from(aiCall)
          .where(inArray(aiCall.runId, allRunIds));

  // The concept letters for the calls, for the cost-per-call export.
  const conceptIds = [...new Set([...callRows, ...runCallRows].map((r) => r.call.conceptId).filter((id): id is string => Boolean(id)))];
  const conceptLabels = new Map(
    conceptIds.length === 0
      ? []
      : (await db.select({ id: concept.id, label: concept.label }).from(concept).where(inArray(concept.id, conceptIds))).map((c) => [c.id, c.label]),
  );

  const toCall = ({ call, day }: { call: typeof aiCall.$inferSelect; day: string }): CallRow => ({
    runId: call.runId,
    projectId: call.projectId,
    conceptId: call.conceptId,
    step: call.step,
    scope: call.scope,
    startedByUserId: call.startedByUserId,
    day,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheWriteTokens: call.cacheWriteTokens,
    cacheWrite1hTokens: call.cacheWrite1hTokens,
    model: call.model,
    id: call.id,
    at: call.createdAt,
    round: call.round,
    durationMs: call.durationMs,
    conceptLabel: call.conceptId ? (conceptLabels.get(call.conceptId) ?? null) : null,
  });

  const runs: RunRow[] = [
    ...runRows.map(({ run, day }) => ({
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      startedByUserId: run.startedByUserId,
      createdAt: run.createdAt,
      day,
      concepts: conceptRows
        .filter((c) => c.runId === run.id)
        .sort((a, b) => a.label.localeCompare(b.label)),
    })),
    ...[...ledgerOnlyRuns.entries()].map(([id, r]) => ({
      id,
      projectId: r.projectId,
      status: "deleted",
      startedByUserId: r.startedBy,
      createdAt: r.first,
      day: "",
      concepts: [],
    })),
  ];

  const projectIds = [
    ...new Set([...runs.map((r) => r.projectId), ...callRows.map((c) => c.call.projectId)]),
  ];
  const projects = new Map<string, { name: string; deleted: boolean }>();
  if (projectIds.length > 0) {
    for (const p of await db
      .select({ id: project.id, name: project.clientName })
      .from(project)
      .where(inArray(project.id, projectIds))) {
      projects.set(p.id, { name: p.name, deleted: false });
    }
    for (const p of await db
      .select({ id: deletedProject.id, name: deletedProject.clientName })
      .from(deletedProject)
      .where(inArray(deletedProject.id, projectIds))) {
      if (!projects.has(p.id)) projects.set(p.id, { name: p.name, deleted: true });
    }
  }

  const people = new Map(
    (
      await db
        .select({ id: userTable.id, name: userTable.name, deletedAt: userTable.deletedAt })
        .from(userTable)
    ).map((u) => [u.id, personLabel(u.name, u.deletedAt) ?? u.name]),
  );

  const limit = await getMonthlyLimit(db);

  return {
    report: buildSpendReport({
      period,
      calls: callRows.map(toCall),
      runs,
      runCalls: runCallRows.map(toCall),
      projects,
      people,
      config: getModelConfig(),
      monthlyLimit: limit.dollars,
      monthToDate: await monthToDateSpend(db),
    }),
    limitIsDefault: limit.isDefault,
    config: getModelConfig(),
  };
}

/* ---------- SEO data (DataForSEO, Phase 7a) ---------- */

/*
  The "SEO data" group on Spend: what DataForSEO charged in the period,
  by project, against its own monthly cap ($25 unless an admin changes
  it). Sandbox lookups are free test data: counted, never charged.
*/
export async function loadSeoSpend(db: Database, viewer: Viewer, period: Period) {
  assertCan(viewer, "spend.view");
  const rows = await db
    .select({ call: seoDataCall })
    .from(seoDataCall)
    .where(and(gte(PACIFIC_DAY(seoDataCall.createdAt), period.from), lte(PACIFIC_DAY(seoDataCall.createdAt), period.to)));

  const projectIds = [...new Set(rows.map((r) => r.call.projectId))];
  const names = new Map<string, { name: string; deleted: boolean }>();
  if (projectIds.length > 0) {
    for (const p of await db.select({ id: project.id, name: project.clientName }).from(project).where(inArray(project.id, projectIds))) {
      names.set(p.id, { name: p.name, deleted: false });
    }
    for (const p of await db
      .select({ id: deletedProject.id, name: deletedProject.clientName })
      .from(deletedProject)
      .where(inArray(deletedProject.id, projectIds))) {
      if (!names.has(p.id)) names.set(p.id, { name: p.name, deleted: true });
    }
  }

  const byProject = new Map<string, { name: string; deleted: boolean; lookups: number; keywords: number; total: number }>();
  for (const { call } of rows) {
    const entry = byProject.get(call.projectId) ?? { ...(names.get(call.projectId) ?? { name: "Unknown project", deleted: true }), lookups: 0, keywords: 0, total: 0 };
    entry.lookups += 1;
    entry.keywords += call.keywordCount;
    entry.total += call.costUsd;
    byProject.set(call.projectId, entry);
  }

  const [limit, monthSpent] = await Promise.all([getSeoLimit(db), seoSpendThisMonth(db)]);
  return {
    setup: seoSetup(),
    total: rows.reduce((sum, r) => sum + r.call.costUsd, 0),
    lookups: rows.length,
    sandboxLookups: rows.filter((r) => r.call.sandbox).length,
    failed: rows.filter((r) => !r.call.ok).length,
    byProject: [...byProject.values()].sort((a, b) => b.total - a.total || b.lookups - a.lookups),
    limit,
    monthSpent,
  };
}

/* An admin marks a test project and sets its cap (Jason, 28 September 2026); logged with before and after. */
export async function setProjectCap(ctx: ServiceContext, actor: Viewer, projectId: string, input: { isTest: boolean; capDollars: string }): Promise<void> {
  assertCan(actor, "money.manage");
  const [before] = await ctx.db.select({ isTest: project.isTest, aiCapCents: project.aiCapCents }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!before) throw new SpendError("That project no longer exists.");
  const raw = input.capDollars.trim().replace(/^\$/, "");
  const cents = raw === "" ? null : Math.round(Number(raw) * 100);
  if (cents !== null && (!Number.isFinite(cents) || cents < 0)) throw new SpendError("The cap is a dollar amount, like 5 or 12.50, or blank for none.");
  await ctx.db.update(project).set({ isTest: input.isTest, aiCapCents: cents, updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.ai_cap_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: before,
    valueAfter: { isTest: input.isTest, aiCapCents: cents },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
