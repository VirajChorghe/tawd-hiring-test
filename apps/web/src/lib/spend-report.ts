import { cacheReadMultiplierFor, callCost, directions, formatCost, modelLabel, priceConfigFor, STEPS, type DirectionId, type ModelConfig } from "@tawd/core/mockups";

/*
  The Spend page's figures, worked out from ledger rows.

  Pure: the database parts load rows (spend.ts) and this turns them into the
  cards, the chart, the four tabs and the CSV. That keeps every number on
  the page testable without a database, which matters because these are
  the numbers somebody will reconcile against the Anthropic invoice.

  Days are Pacific, like the rest of TAWD. A call counts on the day it was
  made; a run is listed in the period it was started, with everything it
  has cost so far.
*/

export const DEFAULT_MONTHLY_LIMIT_USD = 20;
export const WARN_AT = 0.8;

/* ---------- periods ---------- */

export type PeriodInput =
  | { kind: "month"; month: string }
  | { kind: "last3" }
  | { kind: "custom"; from: string; to: string };

export interface Period {
  kind: PeriodInput["kind"];
  /** Inclusive, YYYY-MM-DD, Pacific. */
  from: string;
  to: string;
  label: string;
  /** The value the period picker submits for this period. */
  value: string;
  days: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

const monthName = (month: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T12:00:00Z`),
  );

function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T12:00:00Z`).getTime();
  // Capped so a silly custom range cannot build a list of years.
  for (
    let t = new Date(`${from}T12:00:00Z`).getTime();
    t <= end && out.length < 400;
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Today's date in Pacific time, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

/*
  Reads the picker's value: "2026-09", "last3", or "custom" with from/to.
  Anything unreadable falls back to this month rather than failing.
*/
export function parsePeriod(
  params: { period?: string; from?: string; to?: string },
  today: string,
): PeriodInput {
  const value = params.period ?? "";
  if (value === "last3") return { kind: "last3" };
  if (
    value === "custom" &&
    params.from &&
    params.to &&
    DATE.test(params.from) &&
    DATE.test(params.to)
  ) {
    return params.from <= params.to
      ? { kind: "custom", from: params.from, to: params.to }
      : { kind: "custom", from: params.to, to: params.from };
  }
  if (MONTH.test(value)) return { kind: "month", month: value };
  return { kind: "month", month: today.slice(0, 7) };
}

export function resolvePeriod(input: PeriodInput, today: string): Period {
  if (input.kind === "month") {
    const from = `${input.month}-01`;
    const to = lastDayOf(input.month);
    return { kind: "month", from, to, label: monthName(input.month), value: input.month, days: daysBetween(from, to) };
  }
  if (input.kind === "last3") {
    const thisMonth = today.slice(0, 7);
    const from = `${shiftMonth(thisMonth, -2)}-01`;
    return { kind: "last3", from, to: today, label: "the last 3 months", value: "last3", days: daysBetween(from, today) };
  }
  return {
    kind: "custom",
    from: input.from,
    to: input.to,
    label: `${shortDate(input.from)} to ${shortDate(input.to)}`,
    value: "custom",
    days: daysBetween(input.from, input.to),
  };
}

/** The months offered in the picker: this one and the eleven before it. */
export function monthOptions(today: string): { value: string; label: string }[] {
  const thisMonth = today.slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => {
    const month = shiftMonth(thisMonth, -i);
    return { value: month, label: monthName(month) };
  });
}

export function shortDate(day: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

/* ---------- the rows the report is built from ---------- */

export interface CallRow {
  /** The model the call ran on; it is priced at that model's rates. */
  model?: string;
  runId: string;
  projectId: string;
  conceptId: string | null;
  step: string;
  /** "page", "sections" or "locate"; null where it does not apply. */
  scope: string | null;
  startedByUserId: string | null;
  /** The Pacific day the call was made. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  /* For the cost-per-call export (8 October 2026). */
  id?: string;
  /** When the call finished. */
  at?: Date;
  round?: number | null;
  /** How long the call took; null for calls made before it was kept. */
  durationMs?: number | null;
  /** The concept's letter, when the call belongs to one. */
  conceptLabel?: string | null;
}

export interface RunRow {
  id: string;
  projectId: string;
  status: string;
  startedByUserId: string | null;
  createdAt: Date;
  day: string;
  concepts: { label: string; direction: string; status: string }[];
}

export interface SpendInput {
  period: Period;
  /** Calls made within the period. */
  calls: CallRow[];
  /** Runs started within the period. */
  runs: RunRow[];
  /** Every call belonging to those runs, whenever made, for their cost. */
  runCalls: CallRow[];
  projects: Map<string, { name: string; deleted: boolean }>;
  people: Map<string, string>;
  config: ModelConfig;
  monthlyLimit: number;
  /** Spend so far this calendar month, for the limit bar. */
  monthToDate: number;
}

/* ---------- the report ---------- */

export type StepGroup = "inputs" | "build" | "fix" | "creative_director" | "polish" | "changes" | "content" | "site";

export const STEP_GROUPS: { key: StepGroup; label: string; steps: string[] }[] = [
  // Mockup inputs (27 September 2026): reference briefs and the photo text check.
  // With the uploaded design's reading (27 September 2026), which runs on a cheaper model too.
  { key: "inputs", label: "Reading and inputs", steps: ["reference_study", "photo_text", "design_read"] },
  { key: "build", label: "Build", steps: ["build", "faithful_copy", "faithful_check"] },
  { key: "fix", label: "Automatic fix rounds", steps: ["fix"] },
  { key: "creative_director", label: "Creative Director review", steps: ["review", "improve", "rebuild", "design_review", "design_improve", "design_rescore", "design_decisions"] },
  { key: "polish", label: "Critique and polish", steps: ["polish_critique", "polish"] },
  // Request changes, from the team or the client. Its scoring pass is a
  // review, so it counts as Creative Director review above.
  { key: "changes", label: "Requested changes", steps: ["changes"] },
  // Phase 7b: each page's copy, drafted and redrafted.
  { key: "content", label: "Page drafts", steps: ["content_draft", "content_improve"] },
  // Build A (8a): the shared header and footer, and each page of the site.
  { key: "site", label: "Site build", steps: ["site_parts", "site_page"] },
];

/* The steps that now edit only the sections involved, for the before and after. */
export const SCOPE_STEPS: { step: string; label: string }[] = [
  { step: "fix", label: "Automatic fix rounds" },
  { step: "improve", label: "Creative Director improvement" },
  { step: "changes", label: "Requested changes" },
];

const groupOf = (step: string): StepGroup =>
  STEP_GROUPS.find((g) => g.steps.includes(step))?.key ?? "build";

const RUN_STATUS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  needs_intake: "Needs intake info",
  checks_failed: "Checks failed",
  needs_pm_review: "Needs PM review",
  review_incomplete: "Review didn't finish",
  failed: "Failed",
  stopped: "Stopped",
  deleted: "Project deleted",
};

/*
  Work that isn't a mockup run (a design read, the site build, page drafts
  and so on) has no run row of its own. Its calls are shown as a run named
  after the work; "Project deleted" is only for a project that really was
  deleted (27 September 2026: a design read said "Project deleted").
*/
const WORK_LABEL: Record<string, string> = {
  design_read: "Design read",
  design_review: "Design review",
  design_improve: "Design improvement",
  design_rescore: "Design review",
  design_decisions: "Design decisions",
  design_mobile: "Phone version",
  faithful_copy: "Faithful copy",
  faithful_check: "Faithful copy",
  content_draft: "Page drafts",
  content_improve: "Improved pages",
  site_parts: "Site build",
  site_page: "Site build",
  site_edit: "Site edits",
  logo_design: "Logo design",
  seo_audit_report: "SEO audit",
  seo_golive_check: "SEO check",
  reference_study: "Mockup inputs",
  photo_text: "Mockup inputs",
  polish_critique: "Critique and polish",
  polish: "Critique and polish",
};

export function workLabel(steps: string[]): string {
  const labels = [...new Set(steps.map((step) => WORK_LABEL[step] ?? step.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())))];
  return labels.length ? labels.join(", ") : "Other work";
}

export function buildSpendReport(input: SpendInput) {
  const cost = (c: CallRow) => callCost(c, input.config);
  const sum = (rows: CallRow[]) => rows.reduce((n, c) => n + cost(c), 0);

  const spent = sum(input.calls);

  /*
    The prompt cache (26 September 2026): the share of input tokens read
    from cache rather than sent at full price, and what that saved (a cache
    read costs a tenth of the input price).
  */
  const cacheOf = (rows: CallRow[]) => {
    const read = rows.reduce((n, c) => n + c.cacheReadTokens, 0);
    const all = rows.reduce((n, c) => n + c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens + (c.cacheWrite1hTokens ?? 0), 0);
    // Each read at its own model's price and discount (Opus 5.5 reads at a twentieth).
    const saved = rows.reduce((n, c) => {
      const price = priceConfigFor(c.model ?? input.config.model, input.config);
      return n + (c.cacheReadTokens / 1_000_000) * price.inputPricePerMTok * (1 - cacheReadMultiplierFor(price.model));
    }, 0);
    return { hitRate: all > 0 ? read / all : null, saved };
  };

  /* Runs */
  const runsWithCalls = new Set(input.runCalls.map((c) => c.runId));
  const failedToStart = input.runs.filter(
    (r) => r.status === "failed" && !runsWithCalls.has(r.id),
  );
  const conceptsBuilt = input.runs.reduce(
    (n, r) => n + r.concepts.filter((c) => c.status === "ready").length,
    0,
  );
  const projectsWithCalls = new Set(input.calls.map((c) => c.projectId));

  const projectName = (id: string) => {
    const p = input.projects.get(id);
    return p ? (p.deleted ? `${p.name} (deleted project)` : p.name) : "(deleted project)";
  };
  const personName = (id: string | null) =>
    id ? (input.people.get(id) ?? "Former team member") : "Not recorded";

  /* By day */
  const byDay = input.period.days.map((day) => {
    const calls = input.calls.filter((c) => c.day === day);
    const runs = new Set(calls.map((c) => c.runId));
    return { day, total: sum(calls), runs: runs.size };
  });

  /* By project: anything with a run or a call in the period */
  const projectIds = [
    ...new Set([...input.runs.map((r) => r.projectId), ...input.calls.map((c) => c.projectId)]),
  ];
  const byProject = projectIds
    .map((id) => {
      const runs = input.runs.filter((r) => r.projectId === id);
      const concepts = runs.reduce(
        (n, r) => n + r.concepts.filter((c) => c.status === "ready").length,
        0,
      );
      const total = sum(input.calls.filter((c) => c.projectId === id));
      return {
        projectId: id,
        name: projectName(id),
        deleted: input.projects.get(id)?.deleted ?? true,
        runs: runs.length,
        concepts,
        averagePerConcept: concepts > 0 ? total / concepts : null,
        total,
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  /* By person */
  const personIds = [
    ...new Set([
      ...input.runs.map((r) => r.startedByUserId ?? ""),
      ...input.calls.map((c) => c.startedByUserId ?? ""),
    ]),
  ];
  const byPerson = personIds
    .map((key) => {
      const id = key || null;
      const runs = input.runs.filter((r) => (r.startedByUserId ?? null) === id);
      return {
        name: personName(id),
        runs: runs.length,
        concepts: runs.reduce(
          (n, r) => n + r.concepts.filter((c) => c.status === "ready").length,
          0,
        ),
        total: sum(input.calls.filter((c) => (c.startedByUserId ?? null) === id)),
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  /* By step */
  const byStep = STEP_GROUPS.map((group) => {
    const calls = input.calls.filter((c) => groupOf(c.step) === group.key);
    const total = sum(calls);
    return {
      key: group.key,
      label: group.label,
      timesRun: calls.length,
      // What one call of this step costs on average: for fix rounds, one round.
      perCall: calls.length > 0 ? total / calls.length : null,
      // Spread over every concept built in the period, so steps compare.
      perConcept: conceptsBuilt > 0 ? total / conceptsBuilt : null,
      share: spent > 0 ? total / spent : 0,
      total,
      cacheHitRate: cacheOf(calls).hitRate,
      // The models it ran on in the period (27 September 2026).
      models: [...new Set(calls.map((c) => modelLabel(c.model ?? input.config.model)))].join(", ") || "-",
    };
  });

  /*
    Whole page against sections only, per edit, for the steps that changed
    how they work (fix rounds in 0.14.0; the improvement round and Request
    changes in 0.16.0). A sections-only edit's cost includes the small call
    that found its sections, when there was one.
  */
  const wholeVsSections = SCOPE_STEPS.map((row) => {
    const calls = input.calls.filter((c) => c.step === row.step);
    const page = calls.filter((c) => c.scope === "page");
    const sections = calls.filter((c) => c.scope === "sections");
    const locate = calls.filter((c) => c.scope === "locate");
    const before = page.length > 0 ? sum(page) / page.length : null;
    const after = sections.length > 0 ? (sum(sections) + sum(locate)) / sections.length : null;
    return {
      label: row.label,
      wholePage: { edits: page.length, perEdit: before },
      sectionsOnly: { edits: sections.length, perEdit: after },
      saving: before !== null && after !== null && before > 0 ? 1 - after / before : null,
    };
  });

  /* All runs */
  const runs = [...input.runs]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((run) => {
      const calls = input.runCalls.filter((c) => c.runId === run.id);
      const byGroup = Object.fromEntries(
        STEP_GROUPS.map((g) => [g.key, sum(calls.filter((c) => groupOf(c.step) === g.key))]),
      ) as Record<StepGroup, number>;
      return {
        id: run.id,
        projectId: run.projectId,
        projectName: projectName(run.projectId),
        deleted: input.projects.get(run.projectId)?.deleted ?? true,
        createdAt: run.createdAt,
        startedBy: personName(run.startedByUserId),
        concepts: run.concepts
          .map((c) => `${c.label}: ${directions[c.direction as DirectionId]?.label ?? c.direction}`)
          .join(", "),
        status:
          run.status === "failed" && !runsWithCalls.has(run.id)
            ? "Failed to start"
            : run.status === "deleted" && input.projects.get(run.projectId)?.deleted === false
              ? workLabel(calls.map((c) => c.step))
              : (RUN_STATUS[run.status] ?? run.status),
        rawStatus: run.status === "deleted" && input.projects.get(run.projectId)?.deleted === false ? "work" : run.status,
        cost: sum(calls),
        byGroup,
        tokens: {
          input: calls.reduce((n, c) => n + c.inputTokens, 0),
          output: calls.reduce((n, c) => n + c.outputTokens, 0),
          cacheRead: calls.reduce((n, c) => n + c.cacheReadTokens, 0),
          cacheWrite: calls.reduce((n, c) => n + c.cacheWriteTokens, 0),
        },
      };
    });

  const limit = limitState(input.monthToDate, input.monthlyLimit);

  return {
    period: input.period,
    summary: {
      spent,
      conceptsBuilt,
      runs: input.runs.length,
      failedToStart: failedToStart.length,
      averagePerConcept: conceptsBuilt > 0 ? spent / conceptsBuilt : null,
      projectsWithRuns: projectsWithCalls.size,
      averagePerProject: projectsWithCalls.size > 0 ? spent / projectsWithCalls.size : null,
    },
    limit,
    cache: cacheOf(input.calls),
    byDay,
    byProject,
    byPerson,
    byStep,
    wholeVsSections,
    runs,
    // Every call in the period, oldest first, for the cost-per-call export.
    callLines: [...input.calls]
      .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
      .map((c) => ({
        id: c.id ?? "",
        at: c.at ?? null,
        projectName: projectName(c.projectId),
        runId: c.runId,
        concept: c.conceptLabel ?? "",
        step: c.step,
        stepLabel: STEPS.find((s) => s.step === c.step)?.label ?? c.step,
        group: STEP_GROUPS.find((g) => g.steps.includes(c.step))?.label ?? "Other",
        round: c.round ?? null,
        model: c.model ?? input.config.model,
        scope: c.scope ?? "",
        tokens: {
          input: c.inputTokens,
          output: c.outputTokens,
          cacheRead: c.cacheReadTokens,
          cacheWrite: c.cacheWriteTokens,
          cacheWrite1h: c.cacheWrite1hTokens ?? 0,
        },
        cost: cost(c),
        seconds: c.durationMs == null ? null : c.durationMs / 1000,
      })),
  };
}

export type SpendReport = ReturnType<typeof buildSpendReport>;

/* ---------- the monthly limit ---------- */

export interface LimitState {
  spent: number;
  limit: number;
  ratio: number;
  /** 80% or more: admins see a warning on every page. */
  warn: boolean;
  /** 100% or more: Generate and Request changes are disabled. */
  blocked: boolean;
}

export function limitState(spent: number, limit: number): LimitState {
  const ratio = limit > 0 ? spent / limit : 1;
  return { spent, limit, ratio, warn: ratio >= WARN_AT, blocked: ratio >= 1 };
}

export function blockedMessage(state: LimitState): string {
  return `This month's AI spend (${formatCost(state.spent)}) has reached the ${formatCost(
    state.limit,
  )} monthly limit, so new runs are paused. An admin can raise the limit on the Spend page, and must raise the cap in the Anthropic console to match.`;
}

/* ---------- CSV ---------- */

export function csvCell(value: string | number): string {
  const text = String(value);
  // Quote anything with a comma, quote or newline; and neutralise a leading
  // =, +, - or @ so a spreadsheet never runs a project name as a formula.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function spendCsv(report: SpendReport, when: (d: Date) => string): string {
  const money = (n: number) => n.toFixed(4);
  const header = [
    "run_id",
    "started_pacific",
    "project",
    "project_deleted",
    "started_by",
    "concepts",
    "status",
    "build_usd",
    "fix_rounds_usd",
    "creative_director_usd",
    "requested_changes_usd",
    "total_usd",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ];
  const rows = report.runs.map((r) => [
    r.id,
    when(r.createdAt),
    r.projectName,
    r.deleted ? "yes" : "no",
    r.startedBy,
    r.concepts,
    r.status,
    money(r.byGroup.build),
    money(r.byGroup.fix),
    money(r.byGroup.creative_director),
    money(r.byGroup.changes),
    money(r.cost),
    r.tokens.input,
    r.tokens.output,
    r.tokens.cacheRead,
    r.tokens.cacheWrite,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/*
  The cost-per-call CSV (8 October 2026): one row per AI call in the period,
  with its step, model, tokens, dollars and time, so a run's cost can be
  read step by step, not only by group.
*/
export function callsCsv(report: SpendReport, when: (d: Date) => string): string {
  const header = [
    "finished_pacific",
    "project",
    "run_id",
    "concept",
    "step",
    "step_label",
    "group",
    "round",
    "model",
    "scope",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
    "usd",
    "seconds",
    "call_id",
  ];
  const rows = report.callLines.map((c) => [
    c.at ? when(c.at) : "",
    c.projectName,
    c.runId,
    c.concept,
    c.step,
    c.stepLabel,
    c.group,
    c.round ?? "",
    modelLabel(c.model),
    c.scope,
    c.tokens.input,
    c.tokens.output,
    c.tokens.cacheRead,
    c.tokens.cacheWrite,
    c.tokens.cacheWrite1h,
    c.cost.toFixed(4),
    c.seconds == null ? "" : c.seconds.toFixed(1),
    c.id,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
