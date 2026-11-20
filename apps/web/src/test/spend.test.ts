import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { saveIntakeSection } from "@tawd/core/intake/service";
import { homeWords } from "@tawd/core/schema";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, aiCall, concept, mockupRun } from "@tawd/core/schema";
import { setStorageForTesting, type FileStorage } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import { MockupError, startRun } from "@/lib/mockups";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import {
  SpendError,
  getLimitState,
  getMonthlyLimit,
  loadSpendReport,
  setMonthlyLimit,
} from "@/lib/spend";
import {
  buildSpendReport,
  callsCsv,
  daysBetween,
  limitState,
  monthOptions,
  parsePeriod,
  resolvePeriod,
  spendCsv,
  type CallRow,
  type RunRow,
} from "@/lib/spend-report";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

/*
  The Spend page. These are the numbers somebody will check against the
  Anthropic invoice, so each one is pinned: the cards, each tab, the day
  boundaries in Pacific time, the CSV, and the monthly limit.
*/

const config = { model: "claude-opus-5-5", inputPricePerMTok: 4, outputPricePerMTok: 20 };

/* ---------- periods ---------- */

describe("periods", () => {
  const today = "2026-09-24";

  it("defaults to this month", () => {
    const p = resolvePeriod(parsePeriod({}, today), today);
    expect(p).toMatchObject({ kind: "month", from: "2026-09-01", to: "2026-09-30", label: "September 2026" });
    expect(p.days).toHaveLength(30);
  });

  it("reads a month, the last three months, and a custom range", () => {
    expect(resolvePeriod(parsePeriod({ period: "2026-02" }, today), today)).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(resolvePeriod(parsePeriod({ period: "last3" }, today), today)).toMatchObject({
      from: "2026-07-01",
      to: "2026-09-24",
    });
    expect(
      resolvePeriod(parsePeriod({ period: "custom", from: "2026-09-20", to: "2026-09-10" }, today), today),
    ).toMatchObject({ from: "2026-09-10", to: "2026-09-20" });
  });

  it("falls back to this month on anything unreadable", () => {
    expect(parsePeriod({ period: "'; drop table" }, today)).toEqual({ kind: "month", month: "2026-09" });
    expect(parsePeriod({ period: "custom", from: "yesterday", to: "now" }, today)).toEqual({
      kind: "month",
      month: "2026-09",
    });
  });

  it("offers this month and the eleven before it, across a year boundary", () => {
    const options = monthOptions("2026-02-10");
    expect(options[0]).toEqual({ value: "2026-02", label: "February 2026" });
    expect(options[2]).toEqual({ value: "2025-12", label: "December 2025" });
    expect(options).toHaveLength(12);
  });

  it("caps a silly custom range", () => {
    expect(daysBetween("2000-01-01", "2026-01-01").length).toBeLessThanOrEqual(400);
  });
});

/* ---------- the report, from rows ---------- */

function call(over: Partial<CallRow>): CallRow {
  return {
    runId: "r1",
    projectId: "p1",
    conceptId: "c1",
    step: "build",
    scope: null,
    startedByUserId: "u1",
    day: "2026-09-24",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

function run(over: Partial<RunRow>): RunRow {
  return {
    id: "r1",
    projectId: "p1",
    status: "succeeded",
    startedByUserId: "u1",
    createdAt: new Date("2026-09-24T19:10:00Z"),
    day: "2026-09-24",
    concepts: [{ label: "A", direction: "rugged_craftsman", status: "ready" }],
    ...over,
  };
}

describe("the report", () => {
  const period = resolvePeriod({ kind: "month", month: "2026-09" }, "2026-09-24");

  // $1 of output each: 50,000 output tokens at $20 per million.
  const dollar = { outputTokens: 50_000 };

  const calls = [
    call({ ...dollar, step: "build" }),
    call({ ...dollar, step: "fix", round: 1 } as Partial<CallRow>),
    call({ ...dollar, step: "review", conceptId: null }),
    call({ ...dollar, step: "improve" }),
    call({ ...dollar, runId: "r2", projectId: "p2", conceptId: "c9", step: "build", startedByUserId: "u2", day: "2026-09-10" }),
  ];
  const runs = [
    run({}),
    run({ id: "r2", projectId: "p2", startedByUserId: "u2", day: "2026-09-10", createdAt: new Date("2026-09-10T17:00:00Z") }),
    run({ id: "r3", status: "failed", concepts: [{ label: "A", direction: "brand_led", status: "failed" }] }),
  ];

  const report = buildSpendReport({
    period,
    calls,
    runs,
    runCalls: calls,
    projects: new Map([
      ["p1", { name: "Dale Rowan", deleted: false }],
      ["p2", { name: "Test Plumbing", deleted: true }],
    ]),
    people: new Map([
      ["u1", "Jason Braganza"],
      ["u2", "Priya"],
    ]),
    config,
    monthlyLimit: 20,
    monthToDate: 5,
  });

  it("totals the period and counts what was built", () => {
    expect(report.summary.spent).toBeCloseTo(5);
    expect(report.summary.conceptsBuilt).toBe(2);
    expect(report.summary.runs).toBe(3);
    expect(report.summary.failedToStart).toBe(1);
    expect(report.summary.averagePerConcept).toBeCloseTo(2.5);
    expect(report.summary.projectsWithRuns).toBe(2);
    expect(report.summary.averagePerProject).toBeCloseTo(2.5);
  });

  it("puts every day of the period on the chart, with its total and run count", () => {
    expect(report.byDay).toHaveLength(30);
    expect(report.byDay.find((d) => d.day === "2026-09-24")).toMatchObject({ runs: 1 });
    expect(report.byDay.find((d) => d.day === "2026-09-24")!.total).toBeCloseTo(4);
    expect(report.byDay.find((d) => d.day === "2026-09-10")!.total).toBeCloseTo(1);
    expect(report.byDay.find((d) => d.day === "2026-09-01")).toMatchObject({ total: 0, runs: 0 });
  });

  it("lists projects, deleted ones included and labeled", () => {
    expect(report.byProject.map((p) => [p.name, p.runs, p.concepts])).toEqual([
      ["Dale Rowan", 2, 1],
      ["Test Plumbing (deleted project)", 1, 1],
    ]);
    expect(report.byProject[0]!.total).toBeCloseTo(4);
  });

  it("counts against whoever started the run", () => {
    expect(report.byPerson.map((p) => [p.name, p.runs])).toEqual([
      ["Jason Braganza", 2],
      ["Priya", 1],
    ]);
  });

  it("splits by step, with the review, its improvement and any rebuild together", () => {
    expect(report.byStep.map((s) => [s.label, s.timesRun])).toEqual([
      ["Reading and inputs", 0],
      ["Build", 2],
      ["Automatic fix rounds", 1],
      ["Creative Director review", 2],
      ["Critique and polish", 0],
      ["Requested changes", 0],
      ["Page drafts", 0],
      ["Site build", 0],
    ]);
    expect(report.byStep.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
    expect(report.byStep.find((s) => s.key === "creative_director")!.total).toBeCloseTo(2);
  });

  it("shows what one call and one concept cost per step, so a saving shows", () => {
    const fix = report.byStep.find((s) => s.key === "fix")!;
    // One fix round in the period: the round is its own average.
    expect(fix.perCall).toBeCloseTo(fix.total);
    expect(fix.perConcept).toBeCloseTo(fix.total / report.summary.conceptsBuilt);
    // A step that never ran has no average to show.
    expect(report.byStep.find((s) => s.key === "changes")!.perCall).toBeNull();
  });

  it("compares whole-page edits with sections-only edits, counting the call that found the sections", () => {
    const scoped = buildSpendReport({
      period,
      calls: [
        // Before: two whole-page improvements at $1 and $2.
        call({ ...dollar, step: "improve", scope: "page" }),
        call({ outputTokens: 100_000, step: "improve", scope: "page" }),
        // After: two section edits at 10 cents, one of which needed a 2-cent locate call.
        call({ outputTokens: 5_000, step: "improve", scope: "sections" }),
        call({ outputTokens: 5_000, step: "improve", scope: "sections" }),
        call({ outputTokens: 1_000, step: "improve", scope: "locate" }),
        // Fix rounds only ever section-only in this period; a build has no scope.
        call({ outputTokens: 2_000, step: "fix", scope: "sections" }),
        call({ ...dollar, step: "build" }),
      ],
      runs: [run({})],
      runCalls: [],
      projects: new Map([["p1", { name: "Dale Rowan", deleted: false }]]),
      people: new Map(),
      config,
      monthlyLimit: 20,
      monthToDate: 0,
    });
    const [fix, improve, changes] = scoped.wholeVsSections;
    expect(improve!.label).toBe("Creative Director improvement");
    expect(improve!.wholePage.edits).toBe(2);
    expect(improve!.wholePage.perEdit).toBeCloseTo(1.5);
    expect(improve!.sectionsOnly.edits).toBe(2);
    expect(improve!.sectionsOnly.perEdit).toBeCloseTo(0.11);
    expect(improve!.saving).toBeCloseTo(1 - 0.11 / 1.5);
    expect(fix!.wholePage.perEdit).toBeNull();
    expect(fix!.sectionsOnly.perEdit).toBeCloseTo(0.04);
    expect(fix!.saving).toBeNull();
    expect(changes).toMatchObject({ wholePage: { edits: 0, perEdit: null }, sectionsOnly: { edits: 0, perEdit: null } });
  });

  it("lists every run, newest first, and says when one failed to start", () => {
    expect(report.runs.map((r) => r.status)).toEqual(["Succeeded", "Failed to start", "Succeeded"]);
    expect(report.runs[0]!.concepts).toBe("A: Rugged Craftsman");
    expect(report.runs.find((r) => r.id === "r1")!.byGroup.creative_director).toBeCloseTo(2);
  });

  it("exports one CSV row per run, with the split and the tokens", () => {
    const csv = spendCsv(report, (d) => d.toISOString());
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "run_id,started_pacific,project,project_deleted,started_by,concepts,status,build_usd,fix_rounds_usd,creative_director_usd,requested_changes_usd,total_usd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens",
    );
    expect(lines).toHaveLength(4);
    const r1 = lines.find((l) => l.startsWith("r1,"))!;
    expect(r1).toContain(",Dale Rowan,no,Jason Braganza,A: Rugged Craftsman,Succeeded,1.0000,1.0000,2.0000,0.0000,4.0000,0,200000,0,0");
  });

  it("exports one row per AI call with its step, model, tokens, dollars and time, oldest first", () => {
    const perCall = buildSpendReport({
      period,
      calls: [
        call({ id: "k2", at: new Date("2026-09-24T18:00:00Z"), step: "review", conceptLabel: "B", round: 2, model: "claude-sonnet-5", outputTokens: 10_000, cacheReadTokens: 1_000_000, durationMs: 41_250 }),
        call({ id: "k1", at: new Date("2026-09-24T17:00:00Z"), ...dollar, conceptLabel: "A", cacheWrite1hTokens: 1_000_000, durationMs: null }),
      ],
      runs: [run({})],
      runCalls: [],
      projects: new Map([["p1", { name: "Harbor Pest Control", deleted: false }]]),
      people: new Map(),
      config,
      monthlyLimit: 20,
      monthToDate: 0,
    });
    const lines = callsCsv(perCall, (d) => d.toISOString()).trim().split("\r\n");
    expect(lines[0]).toBe(
      "finished_pacific,project,run_id,concept,step,step_label,group,round,model,scope,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,usd,seconds,call_id",
    );
    // The build: $1 of output and a one-hour cache write of a million at twice $4: $9; no time kept.
    expect(lines[1]).toBe("2026-09-24T17:00:00.000Z,Harbor Pest Control,r1,A,build,Concept build,Build,,Opus 5.5,,0,50000,0,0,1000000,9.0000,,k1");
    // The review on Sonnet 5: $0.10 of output and a million cache reads at a tenth of $2.
    expect(lines[2]).toBe("2026-09-24T18:00:00.000Z,Harbor Pest Control,r1,B,review,Creative Director review,Creative Director review,2,Sonnet 5,,0,10000,1000000,0,0,0.3000,41.3,k2");
  });

  it("works out the cache saving at each model's own discount", () => {
    const saving = (model: string) =>
      buildSpendReport({
        period,
        calls: [call({ model, cacheReadTokens: 1_000_000 })],
        runs: [],
        runCalls: [],
        projects: new Map(),
        people: new Map(),
        config,
        monthlyLimit: 20,
        monthToDate: 0,
      }).cache.saved;
    // Opus 5.5: $4 a million in, read at $0.20, so $3.80 saved; Sonnet 5: $2 in, read at $0.20, $1.80 saved.
    expect(saving("claude-opus-5-5")).toBeCloseTo(3.8);
    expect(saving("claude-sonnet-5")).toBeCloseTo(1.8);
  });

  it("keeps the CSV safe to open in a spreadsheet", () => {
    const risky = buildSpendReport({
      period,
      calls: [],
      runs: [run({})],
      runCalls: [],
      projects: new Map([["p1", { name: '=HYPERLINK("x"), "quoted"', deleted: false }]]),
      people: new Map(),
      config,
      monthlyLimit: 20,
      monthToDate: 0,
    });
    const row = spendCsv(risky, () => "t").split("\r\n")[1]!;
    expect(row).toContain(`"'=HYPERLINK(""x""), ""quoted"""`);
  });
});

describe("the monthly limit", () => {
  it("warns at 80% and blocks at 100%", () => {
    expect(limitState(15.99, 20)).toMatchObject({ warn: false, blocked: false });
    expect(limitState(16, 20)).toMatchObject({ warn: true, blocked: false });
    expect(limitState(20, 20)).toMatchObject({ warn: true, blocked: true });
  });
});

/* ---------- with the database ---------- */

let h: Harness;

class NoR2 implements FileStorage {
  async signUpload() { return ""; }
  async signDownload() { return ""; }
  async head() { return null; }
  async remove() {}
  async copy() {}
  async put() {}
  async get() { return null; }
  async list() { return []; }
}

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new NoR2());
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

const lane1 = {
  trade: "well_and_pump" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 1,
  status: "mockups" as const,
  memberUserIds: [] as string[],
};

async function seedSpend(admin: Awaited<ReturnType<typeof seedAdmin>>, at: Date, output = 50_000, name = "Dale Rowan") {
  const projectId = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: name });
  // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
  // The Home page words, used, so Generate isn't blocked (1 October 2026).
  await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });
  const [r] = await h.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 1, status: "succeeded", model: "claude-opus-5-5", startedByUserId: admin.viewer.id, createdAt: at })
    .returning();
  const [c] = await h.db
    .insert(concept)
    .values({ runId: r!.id, projectId, label: "A", direction: "rugged_craftsman", skillId: "impeccable", status: "ready" })
    .returning();
  await h.db.insert(aiCall).values({
    projectId,
    runId: r!.id,
    conceptId: c!.id,
    step: "build",
    model: "claude-opus-5-5",
    startedByUserId: admin.viewer.id,
    outputTokens: output,
    createdAt: at,
  });
  return { projectId, runId: r!.id };
}

describe("the Spend page's data", () => {
  it("is admins only", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const period = resolvePeriod({ kind: "month", month: "2026-09" }, "2026-09-24");
    await expect(loadSpendReport(h.db, pm.viewer, period)).rejects.toBeInstanceOf(PermissionError);
    await expect(loadSpendReport(h.db, admin.viewer, period)).resolves.toBeDefined();
  });

  it("counts days in Pacific time: 11pm on Sep 30 in California is September", async () => {
    const admin = await seedAdmin(h);
    // 2026-10-01 06:00 UTC is 2026-09-30 23:00 in Los Angeles.
    await seedSpend(admin, new Date("2026-10-01T06:00:00Z"));

    const sep = await loadSpendReport(h.db, admin.viewer, resolvePeriod({ kind: "month", month: "2026-09" }, "2026-10-02"));
    const oct = await loadSpendReport(h.db, admin.viewer, resolvePeriod({ kind: "month", month: "2026-10" }, "2026-10-02"));
    expect(sep.report.summary.spent).toBeGreaterThan(0);
    expect(sep.report.byDay.at(-1)!.day).toBe("2026-09-30");
    expect(sep.report.byDay.at(-1)!.total).toBeGreaterThan(0);
    expect(oct.report.summary.spent).toBe(0);
  });

  it("keeps a deleted project's spend and runs, labeled", async () => {
    const admin = await seedAdmin(h);
    const at = new Date();
    const { projectId } = await seedSpend(admin, at, 50_000, "Test Plumbing");
    await deleteProject(h.ctx, admin.viewer, projectId, {
      confirmName: "Test Plumbing",
      reason: "Test project, not a client",
    });

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);
    const { report } = await loadSpendReport(h.db, admin.viewer, resolvePeriod({ kind: "month", month: today.slice(0, 7) }, today));
    expect(report.byProject.map((p) => p.name)).toEqual(["Test Plumbing (deleted project)"]);
    expect(report.summary.spent).toBeGreaterThan(0);
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]!.status).toBe("Project deleted");
  });

  it("names work that isn't a mockup run after what it was, not 'Project deleted' (27 September 2026)", async () => {
    const admin = await seedAdmin(h);
    const at = new Date();
    const projectId = await createProject(h.ctx, admin.viewer, { ...lane1, clientName: "Nora Happy Beagle Lady" });
    // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    // The Home page words, used, so Generate isn't blocked (1 October 2026).
    await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });
    // A design read files its calls under the project's own id, with no run row.
    for (const round of [1, 2]) {
      await h.db.insert(aiCall).values({ projectId, runId: projectId, conceptId: null, step: "design_read", round, model: "claude-opus-5-5", startedByUserId: admin.viewer.id, outputTokens: 7_000, createdAt: at });
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);
    const { report } = await loadSpendReport(h.db, admin.viewer, resolvePeriod({ kind: "month", month: today.slice(0, 7) }, today));
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ projectName: "Nora Happy Beagle Lady", status: "Design read", rawStatus: "work", deleted: false });
    expect(report.runs[0]!.cost).toBeCloseTo(0.28);
  });
});

describe("setting the monthly limit", () => {
  it("defaults to $20, and an admin can change it, logged with before and after", async () => {
    const admin = await seedAdmin(h);
    expect(await getMonthlyLimit(h.db)).toEqual({ dollars: 20, isDefault: true });

    await setMonthlyLimit(h.ctx, admin.viewer, 50);
    expect(await getMonthlyLimit(h.db)).toEqual({ dollars: 50, isDefault: false });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "settings.monthly_limit_changed"));
    expect(entry?.valueBefore).toEqual({ dollars: 20, default: true });
    expect(entry?.valueAfter).toEqual({ dollars: 50 });
  });

  it("is admins only, and refuses nonsense", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(setMonthlyLimit(h.ctx, pm.viewer, 50)).rejects.toBeInstanceOf(PermissionError);
    for (const bad of [0, -5, Number.NaN, 1e9]) {
      await expect(setMonthlyLimit(h.ctx, admin.viewer, bad)).rejects.toBeInstanceOf(SpendError);
    }
  });

  it("stops Generate at 100%, with a message saying where to raise it", async () => {
    const admin = await seedAdmin(h);
    await setMonthlyLimit(h.ctx, admin.viewer, 1);
    // $1.00 of output this month.
    const { projectId } = await seedSpend(admin, new Date(), 50_000);

    expect((await getLimitState(h.db)).blocked).toBe(true);

    const attempt = startRun(h.ctx, admin.viewer, {
      projectId,
      concepts: [{ label: "A", direction: "rugged_craftsman", skillId: "impeccable", reason: "" }],
    });
    await expect(attempt).rejects.toBeInstanceOf(MockupError);
    await expect(attempt).rejects.toThrow(/Spend page.*Anthropic console/);

    // Nothing was created.
    const runs = await h.db.select().from(mockupRun).where(eq(mockupRun.projectId, projectId));
    expect(runs).toHaveLength(1);
  });

  it("warns at 80% without blocking", async () => {
    const admin = await seedAdmin(h);
    await setMonthlyLimit(h.ctx, admin.viewer, 1.2);
    await seedSpend(admin, new Date(), 50_000);
    expect(await getLimitState(h.db)).toMatchObject({ warn: true, blocked: false });
  });
});
