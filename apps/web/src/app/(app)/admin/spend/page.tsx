import type { Metadata } from "next";
import { getDmaMarkets } from "@/lib/seo-data";
import { DataForSeoTest } from "@/components/spend/dataforseo-test";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { formatWhen } from "@/lib/labels";
import { requireUser } from "@/lib/session";
import { loadSeoSpend, loadSpendReport } from "@/lib/spend";
import { loadBlockedSiteSpend } from "@/lib/site-read";
import {
  WARN_AT,
  monthOptions,
  pacificToday,
  parsePeriod,
  resolvePeriod,
  shortDate,
} from "@/lib/spend-report";
import { LimitEditor, PeriodPicker, SpendTabs } from "./spend-client";
import { StepModelsCard } from "@/components/admin/step-models-card";
import { loadStepModelRows } from "@/lib/step-models";
import { MODELS, priceConfigFor } from "@tawd/core/mockups";

export const metadata: Metadata = { title: "Spend - TAWD" };
export const dynamic = "force-dynamic";

/*
  AI costs across TAWD: where it went and who started it. Admins only.

  Every figure is worked out from the ledger's token counts at the
  configured rates; see lib/spend-report.ts.
*/

function pick(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

export default async function SpendPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await requireUser();
  const dmaMarkets = await getDmaMarkets(getDb());
  if (!can(current, "spend.view")) redirect("/projects");

  const params = await searchParams;
  const stepModels = await loadStepModelRows(getDb());
  const today = pacificToday();
  const period = resolvePeriod(
    parsePeriod(
      { period: pick(params.period), from: pick(params.from), to: pick(params.to) },
      today,
    ),
    today,
  );

  const { report, limitIsDefault, config } = await loadSpendReport(
    getDb(),
    current,
    period,
  );
  const { summary, limit } = report;
  const seo = await loadSeoSpend(getDb(), current, period);
  const blocked = await loadBlockedSiteSpend(getDb(), current, period);
  const seoRatio = seo.limit.dollars > 0 ? seo.monthSpent / seo.limit.dollars : 0;
  const isThisMonth = period.kind === "month" && period.value === today.slice(0, 7);
  const max = Math.max(...report.byDay.map((d) => d.total), 0);

  const exportHref = `/admin/spend/export?${new URLSearchParams({
    period: period.value,
    ...(period.kind === "custom" ? { from: period.from, to: period.to } : {}),
  }).toString()}`;

  return (
    <div className="page">
      <div className="page-head spend-head">
        <div>
          <h1 className="page-title">Spend</h1>
          <p className="page-lede">
            AI costs across TAWD: where it went and who started it. Admins only.
          </p>
        </div>
        <div className="spend-controls">
          <PeriodPicker
            value={period.value}
            from={period.from}
            to={period.to}
            months={monthOptions(today)}
          />
          <a className="btn btn-secondary" href={exportHref} download>
            <DownloadIcon />
            Export CSV
          </a>
          <a className="btn btn-secondary" href={`${exportHref}&by=call`} download>
            <DownloadIcon />
            Cost per call
          </a>
          {/* Every team comment on a concept, done or not (8 October 2026): not tied to the period. */}
          <a className="btn btn-secondary" href="/admin/spend/comments" download>
            <DownloadIcon />
            Comments and fixes
          </a>
        </div>
      </div>

      <div className="spend-cards">
        <div className="card spend-card spend-card-wide">
          <p className="spend-card-label">
            {isThisMonth ? "Spent this month" : `Spent in ${period.label}`}
          </p>
          <p className="spend-card-value">
            {formatMoney(summary.spent)}
            {isThisMonth ? (
              <span className="spend-card-of">
                of {formatMoney(limit.limit)} monthly limit
              </span>
            ) : null}
          </p>
          {isThisMonth ? (
            <>
              <div
                className={limit.warn ? "progress spend-progress is-warn" : "progress spend-progress"}
                role="progressbar"
                aria-valuenow={Math.round(Math.min(limit.ratio, 1) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Spend against the monthly limit"
              >
                <span style={{ width: `${Math.min(limit.ratio, 1) * 100}%` }} />
              </div>
              <p className="hint">
                The limit mirrors the one set in the Anthropic console. TAWD
                warns admins at {Math.round(WARN_AT * 100)}%
                {limit.blocked ? " and has paused new runs." : "."}
              </p>
            </>
          ) : (
            <p className="hint">
              This month so far: {formatMoney(limit.spent)} of{" "}
              {formatMoney(limit.limit)}.
            </p>
          )}
          <p className="hint">
            {report.cache.hitRate === null
              ? "Prompt cache: no AI calls in this period."
              : `Prompt cache: ${Math.round(report.cache.hitRate * 100)}% of input read from cache, saving about ${formatMoney(report.cache.saved)}.`}
          </p>
          <LimitEditor dollars={limit.limit} isDefault={limitIsDefault} />
        </div>

        <div className="card spend-card">
          <p className="spend-card-label">Concepts built</p>
          <p className="spend-card-value">{summary.conceptsBuilt}</p>
          <p className="hint">
            In {summary.runs} run{summary.runs === 1 ? "" : "s"}
            {summary.failedToStart > 0
              ? ` (${summary.failedToStart} failed before starting)`
              : ""}
          </p>
        </div>

        <div className="card spend-card">
          <p className="spend-card-label">Average per concept</p>
          <p className="spend-card-value">
            {summary.averagePerConcept === null ? "None yet" : formatMoney(summary.averagePerConcept)}
          </p>
          <p className="hint">Including fix rounds and review</p>
        </div>

        <div className="card spend-card">
          <p className="spend-card-label">Average per project</p>
          <p className="spend-card-value">
            {summary.averagePerProject === null ? "None yet" : formatMoney(summary.averagePerProject)}
          </p>
          <p className="hint">
            Across {summary.projectsWithRuns} project
            {summary.projectsWithRuns === 1 ? "" : "s"} with runs
          </p>
        </div>
      </div>

      <div className="card spend-chart-card">
        <div className="page-head" style={{ marginBottom: 20 }}>
          <h2 className="card-title">
            By day, {period.kind === "month" ? period.label : shortRange(period.from, period.to)}
          </h2>
          <span className="hint">Hover a bar for the day&apos;s runs</span>
        </div>

        <div className="spend-chart" role="list" aria-label="Spend by day">
          {report.byDay.map((d) => {
            const tip =
              d.runs === 0
                ? `${shortDate(d.day)}: no runs`
                : `${shortDate(d.day)}: ${formatMoney(d.total)} in ${d.runs} run${d.runs === 1 ? "" : "s"}`;
            return (
              <div
                key={d.day}
                role="listitem"
                className="spend-bar"
                tabIndex={0}
                aria-label={tip}
                data-tip={tip}
              >
                <span
                  className={d.total > 0 ? "spend-bar-fill" : "spend-bar-fill is-empty"}
                  style={{ height: max > 0 && d.total > 0 ? `${Math.max(3, (d.total / max) * 100)}%` : undefined }}
                />
              </div>
            );
          })}
        </div>
        <div className="spend-axis" aria-hidden="true">
          {axisLabels(report.byDay.map((d) => d.day)).map((label, i) => (
            <span key={i}>{label}</span>
          ))}
        </div>
      </div>

      <SpendTabs
        byProject={report.byProject.map((p) => ({
          name: p.name,
          deleted: p.deleted,
          runs: p.runs,
          concepts: p.concepts,
          averagePerConcept: p.averagePerConcept === null ? "None" : formatMoney(p.averagePerConcept),
          total: formatMoney(p.total),
        }))}
        byPerson={report.byPerson.map((p) => ({
          name: p.name,
          runs: p.runs,
          concepts: p.concepts,
          total: formatMoney(p.total),
        }))}
        byStep={report.byStep.map((s) => ({
          label: s.label,
          timesRun: s.timesRun,
          perCall: s.perCall === null ? "-" : formatMoney(s.perCall),
          perConcept: s.perConcept === null ? "-" : formatMoney(s.perConcept),
          share: `${Math.round(s.share * 100)}%`,
          total: formatMoney(s.total),
          cacheHits: s.cacheHitRate === null ? "-" : `${Math.round(s.cacheHitRate * 100)}%`,
          models: s.models,
        }))}
        wholeVsSections={report.wholeVsSections.map((s) => ({
          label: s.label,
          wholePage: s.wholePage.perEdit === null ? "-" : `${formatMoney(s.wholePage.perEdit)} (${s.wholePage.edits})`,
          sectionsOnly:
            s.sectionsOnly.perEdit === null ? "-" : `${formatMoney(s.sectionsOnly.perEdit)} (${s.sectionsOnly.edits})`,
          saving: s.saving === null ? "-" : `${Math.round(s.saving * 100)}%`,
        }))}
        runs={report.runs.map((r) => ({
          id: r.id,
          href: r.deleted ? null : `/projects/${r.projectId}/mockups`,
          when: formatWhen(r.createdAt),
          projectName: r.projectName,
          startedBy: r.startedBy,
          concepts: r.concepts || "None",
          status: r.status,
          rawStatus: r.rawStatus,
          cost: formatMoney(r.cost),
        }))}
        initialTab={pick(params.tab)}
        rateNote={`Prices per million tokens, input and output: ${MODELS.map((m) => { const p = priceConfigFor(m.id, config); return `${m.label} $${p.inputPricePerMTok} and $${p.outputPricePerMTok}`; }).join("; ")}. Each call is priced at its own model's rates.`}
      />

      <StepModelsCard
        models={MODELS.map((m) => { const p = priceConfigFor(m.id, config); return { id: m.id, label: m.label, prices: `$${p.inputPricePerMTok} in, $${p.outputPricePerMTok} out per million tokens${m.note ? ` (${m.note})` : ""}` }; })}
        rows={stepModels}
      />

      <div className="card spend-seo-card">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 className="card-title">
            SEO data{" "}
            {seo.setup.sandbox ? <span className="badge badge-info">Sandbox: free test data</span> : null}
          </h2>
          <span className="hint">DataForSEO keyword lookups, with their own cap</span>
        </div>
        <p className="spend-card-value">
          {formatMoney(seo.monthSpent)}
          <span className="spend-card-of">of {formatMoney(seo.limit.dollars)} this month</span>
        </p>
        <div
          className={seoRatio >= WARN_AT ? "progress spend-progress is-warn" : "progress spend-progress"}
          role="progressbar"
          aria-valuenow={Math.round(Math.min(seoRatio, 1) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="SEO data spend against its monthly cap"
        >
          <span style={{ width: `${Math.min(seoRatio, 1) * 100}%` }} />
        </div>
        <p className="hint">
          {isThisMonth ? "This month" : `In ${period.label}`}: {formatMoney(seo.total)} in {seo.lookups} lookup
          {seo.lookups === 1 ? "" : "s"}
          {seo.sandboxLookups ? ` (${seo.sandboxLookups} in the sandbox, free)` : ""}
          {seo.failed ? `; ${seo.failed} failed` : ""}. Keyword research that would go over the cap is refused.
          {seo.setup.configured ? "" : ` Not set up yet: add ${seo.setup.missing.join(" and ")} in Coolify.`}
        </p>
        <LimitEditor dollars={seo.limit.dollars} isDefault={seo.limit.isDefault} kind="seo" />
        {can(current, "settings.manage") ? (
          <DataForSeoTest
            dmaLine={
              dmaMarkets.loadedAt
                ? dmaMarkets.dmas.length
                  ? `${dmaMarkets.dmas.length} TV markets loaded ${formatWhen(dmaMarkets.loadedAt)} (one free DataForSEO call).`
                  : `Checked ${formatWhen(dmaMarkets.loadedAt)}: DataForSEO's list has no DMAs, so the DMA choice stays hidden.`
                : "TV markets (DMAs) aren't loaded: the DMA choice is hidden in the intake until they are. Loading is one free DataForSEO call."
            }
          />
        ) : null}
        {seo.byProject.length > 0 ? (
          <div className="table-scroll spend-seo-table">
            <table className="spend-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="align-right">Lookups</th>
                  <th className="align-right">Keywords</th>
                  <th className="align-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {seo.byProject.map((p) => (
                  <tr key={p.name}>
                    <td>{p.deleted ? <span className="muted-strong">{p.name} (deleted project)</span> : p.name}</td>
                    <td className="align-right">{p.lookups}</td>
                    <td className="align-right">{p.keywords}</td>
                    <td className="align-right">{formatMoney(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="card spend-seo-card" id="blocked-sites">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 className="card-title">Blocked-site reads</h2>
          <span className="hint">Paid routes for current sites that block TAWD&apos;s server, each with its own cap</span>
        </div>
        {blocked.routes.map((r) => {
          const ratio = r.cap.dollars > 0 ? r.monthSpent / r.cap.dollars : 0;
          return (
            <div key={r.route} className="spend-route">
              <p className="spend-card-label">{r.label}</p>
              <p className="spend-card-value">
                {formatMoney(r.monthSpent)}
                <span className="spend-card-of">of {formatMoney(r.cap.dollars)} this month</span>
              </p>
              <div
                className={ratio >= WARN_AT ? "progress spend-progress is-warn" : "progress spend-progress"}
                role="progressbar"
                aria-valuenow={Math.round(Math.min(ratio, 1) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${r.label} spend against its monthly cap`}
              >
                <span style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
              </div>
              {r.configured === false ? <p className="hint">The worker has no key for it: TAWD skips it.</p> : r.configured === null ? <p className="hint">The worker hasn&apos;t reported its settings yet.</p> : null}
              <LimitEditor dollars={r.cap.dollars} isDefault={r.cap.isDefault} kind={r.route} />
            </div>
          );
        })}
        <p className="hint">
          {isThisMonth ? "This month" : `In ${period.label}`}: {formatMoney(blocked.total)} in {blocked.calls} call{blocked.calls === 1 ? "" : "s"}
          {blocked.failed ? `; ${blocked.failed} gave nothing` : ""}. A read under $1 runs by itself; past a cap the route isn&apos;t called.
        </p>
        {blocked.byProject.length > 0 ? (
          <div className="table-scroll spend-seo-table">
            <table className="spend-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Route</th>
                  <th className="align-right">Calls</th>
                  <th className="align-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {blocked.byProject.map((p) => (
                  <tr key={`${p.name}-${p.route}`}>
                    <td>{p.deleted ? <span className="muted-strong">{p.name} (deleted project)</span> : p.name}</td>
                    <td>{p.route}</td>
                    <td className="align-right">{p.calls}</td>
                    <td className="align-right">
                      {formatMoney(p.total)}
                      {p.estimated ? " (estimate)" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/* Always cents on this page: these figures get checked against an invoice. */
function formatMoney(dollars: number): string {
  return MONEY.format(dollars);
}

function shortRange(from: string, to: string): string {
  return `${shortDate(from)} to ${shortDate(to)}`;
}

/*
  Four labels along the axis: a whole month reads 1, 10, 20 and its last
  day; any other range, its first, two evenly between, and its last.
*/
function axisLabels(days: string[]): string[] {
  if (days.length === 0) return [];
  if (days.length <= 4) return days.map(shortDate);
  const wholeMonth = days[0]!.endsWith("-01") && days.length >= 28 && days.length <= 31;
  const at = wholeMonth
    ? [0, 9, 19, days.length - 1]
    : [0, Math.round((days.length - 1) / 3), Math.round(((days.length - 1) * 2) / 3), days.length - 1];
  return at.map((i) => shortDate(days[i]!));
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
