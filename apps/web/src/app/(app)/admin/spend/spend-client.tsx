"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setMonthlyLimitAction, setRouteCapAction, setSeoLimitAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/* ---------- period ---------- */

/*
  Choosing a month or "Last 3 months" applies at once; a custom range shows
  two date fields and applies with its own button. The period lives in the
  URL, so a view can be bookmarked and the CSV export matches it.
*/
export function PeriodPicker({
  value,
  from,
  to,
  months,
}: {
  value: string;
  from: string;
  to: string;
  months: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(value);
  const [range, setRange] = useState({ from, to });

  const go = (params: Record<string, string>) =>
    router.push(`/admin/spend?${new URLSearchParams(params).toString()}`);

  return (
    <div className="period-picker">
      <label className="field-label" htmlFor="spend-period" style={{ margin: 0 }}>
        <span>Period</span>
      </label>
      <select
        id="spend-period"
        className="select"
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          setChoice(next);
          if (next !== "custom") go({ period: next });
        }}
      >
        {months.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
        <option value="last3">Last 3 months</option>
        <option value="custom">Custom range</option>
      </select>

      {choice === "custom" ? (
        <div className="period-custom">
          <label className="visually-hidden" htmlFor="spend-from">
            From
          </label>
          <input
            id="spend-from"
            type="date"
            className="input"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
          <span aria-hidden="true">to</span>
          <label className="visually-hidden" htmlFor="spend-to">
            To
          </label>
          <input
            id="spend-to"
            type="date"
            className="input"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
          <Button
            small
            disabled={!range.from || !range.to}
            onClick={() => go({ period: "custom", from: range.from, to: range.to })}
          >
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- the monthly limit ---------- */

export function LimitEditor({
  dollars,
  isDefault,
  kind = "ai",
}: {
  dollars: number;
  isDefault: boolean;
  /** The AI limit, the SEO data cap (DataForSEO, 7a), or a blocked-site route's cap (Jina Reader, Zyte). */
  kind?: "ai" | "seo" | "jina" | "zyte";
}) {
  const seo = kind === "seo";
  const route = kind === "jina" || kind === "zyte" ? kind : null;
  const routeName = route === "jina" ? "Jina Reader" : "Zyte";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(dollars));
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  if (!open) {
    return (
      <p className="hint" style={{ marginTop: 8 }}>
        {isDefault ? (seo || route ? "Using the default cap. " : "Using the default limit. ") : ""}
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          {route ? `Change the ${routeName} cap` : seo ? "Change the SEO data cap" : "Change the monthly limit"}
        </button>
      </p>
    );
  }

  return (
    <div className="limit-editor">
      <label className="field-label" htmlFor={route ? `${route}-cap` : seo ? "seo-limit" : "monthly-limit"}>
        <span>{route ? `Monthly ${routeName} cap, in dollars` : seo ? "Monthly SEO data cap, in dollars" : "Monthly AI limit, in dollars"}</span>
      </label>
      <div className="row" style={{ gap: 8 }}>
        <input
          id={route ? `${route}-cap` : seo ? "seo-limit" : "monthly-limit"}
          className="input"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ maxWidth: 140 }}
        />
        <Button
          variant="primary"
          small
          disabled={busy}
          onClick={() => {
            setError(null);
            start(async () => {
              const amount = Number(value.replace(/[$,\s]/g, ""));
              const result = route ? await setRouteCapAction(route, amount) : seo ? await setSeoLimitAction(amount) : await setMonthlyLimitAction(amount);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          {busy ? "Saving..." : "Save"}
        </Button>
        <Button small onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        {route
          ? `Past it, ${routeName} isn't called: a blocked site falls back to the next route, then to pasting the words. The change is recorded in the activity log.`
          : seo
          ? "New keyword research that would go over it is refused. The change is recorded in the activity log."
          : "Set it to match the cap in the Anthropic console. The change is recorded in the activity log."}
      </p>
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

/* ---------- tabs ---------- */

type Tab = "project" | "person" | "step" | "runs";

const TABS: [Tab, string][] = [
  ["project", "By project"],
  ["person", "By person"],
  ["step", "By step"],
  ["runs", "All runs"],
];

export function SpendTabs(props: {
  byProject: { name: string; deleted: boolean; runs: number; concepts: number; averagePerConcept: string; total: string }[];
  byPerson: { name: string; runs: number; concepts: number; total: string }[];
  byStep: { label: string; timesRun: number; perCall: string; perConcept: string; share: string; total: string; cacheHits: string; models?: string }[];
  wholeVsSections: { label: string; wholePage: string; sectionsOnly: string; saving: string }[];
  runs: {
    id: string;
    href: string | null;
    when: string;
    projectName: string;
    startedBy: string;
    concepts: string;
    status: string;
    rawStatus: string;
    cost: string;
  }[];
  rateNote: string;
  /** From the URL (?tab=runs), so a tab can be linked to. */
  initialTab?: string;
}) {
  const [tab, setTab] = useState<Tab>(
    TABS.some(([key]) => key === props.initialTab) ? (props.initialTab as Tab) : "project",
  );

  return (
    <div className="card spend-tabs-card">
      <div className="spend-tabs" role="tablist" aria-label="Breakdown">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`spend-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`spend-panel-${key}`}
            className="spend-tab"
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`spend-panel-${tab}`} aria-labelledby={`spend-tab-${tab}`}>
        {tab === "project" ? (
          <Table
            head={["Project", "Runs", "Concepts", "Avg per concept", "Total"]}
            empty="No AI spend in this period."
            rows={props.byProject.map((p) => [
              p.deleted ? <span className="muted-strong">{p.name}</span> : <strong>{p.name}</strong>,
              p.runs,
              p.concepts,
              <strong key="a">{p.averagePerConcept}</strong>,
              <strong key="t">{p.total}</strong>,
            ])}
            note="Deleted projects keep their costs so monthly totals always add up."
          />
        ) : tab === "person" ? (
          <Table
            head={["Person", "Runs started", "Concepts", "Total"]}
            empty="No runs in this period."
            rows={props.byPerson.map((p) => [
              <strong key="n">{p.name}</strong>,
              p.runs,
              p.concepts,
              <strong key="t">{p.total}</strong>,
            ])}
            note="Counted against whoever clicked Generate or Request changes."
          />
        ) : tab === "step" ? (
          <>
          <Table
            head={["Step", "Model", "Times run", "Per call", "Per concept", "Cache hits", "Share", "Total"]}
            empty="No AI spend in this period."
            rows={props.byStep.map((s) => [
              <strong key="l">{s.label}</strong>,
              s.models ?? "-",
              s.timesRun,
              s.perCall,
              s.perConcept,
              s.cacheHits,
              <strong key="s">{s.share}</strong>,
              <strong key="t">{s.total}</strong>,
            ])}
            note="Per call: one fix round, one review and so on. Per concept: across every concept built in the period. Cache hits: the share of input read from the prompt cache, at a fraction of the price (a twentieth on Opus 5.5, a tenth on the other models). Fixes made by code cost nothing and are not counted here. Each call is priced at its own model's rates."
          />
          <h3 className="spend-subhead">Whole page vs sections only</h3>
          <Table
            head={["Step", "Whole page, per edit", "Sections only, per edit", "Saving"]}
            empty="No edits in this period."
            rows={props.wholeVsSections.map((s) => [
              <strong key="l">{s.label}</strong>,
              s.wholePage,
              s.sectionsOnly,
              <strong key="s">{s.saving}</strong>,
            ])}
            note="Before and after TAWD stopped sending the whole page: fix rounds from 0.14.0, the improvement round and Requested changes from 0.16.0. Sections only includes the small call that finds the sections for a written request."
          />
          </>
        ) : (
          <Table
            head={["When", "Project", "Started by", "Concepts", "Status", "Cost"]}
            empty="No runs in this period."
            numericFrom={5}
            rows={props.runs.map((r) => [
              r.href ? (
                <Link key="w" href={r.href} className="plain-link">
                  <strong>{r.when}</strong>
                </Link>
              ) : (
                <strong key="w">{r.when}</strong>
              ),
              r.projectName,
              r.startedBy,
              r.concepts,
              <span key="s" className={`run-status is-${r.rawStatus}`}>
                {r.status}
              </span>,
              <strong key="c">{r.cost}</strong>,
            ])}
            note={`Each run links to its Design page. ${props.rateNote}`}
          />
        )}
      </div>
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
  note,
  numericFrom = 1,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
  note: string;
  /** Columns from this index on are right-aligned numbers. */
  numericFrom?: number;
}) {
  return (
    <>
      <div className="table-scroll">
        <table className="spend-table">
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} className={i >= numericFrom ? "align-right" : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={head.length} className="empty">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={i >= numericFrom ? "align-right" : undefined}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="spend-note">{note}</p>
    </>
  );
}
