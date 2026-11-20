"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { replacePlanWithSiteAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The current site's pages on Content (one read of the current site,
  0.96.0; DESIGN.md "One read of the current site"): read by code with the
  intake's Website section (free, no AI). For "Keep all content as is" the
  page plan makes itself from them; the only click left is the one
  decision when a plan with work isn't from the read. Reading again is on
  Intake.
*/

type Result = { ok: true } | { ok: false; message: string };

export interface ImportedRow {
  path: string;
  name: string;
  kindLabel: string;
  words: number;
  /** "Had a form; a second H1 kept as an H2" and the like. */
  notes: string;
  /** Read through a blocked route: "Live" or where the copy came from; null when the live site was read as usual. */
  from?: string | null;
  /** A copy over 6 months old: the row is amber. */
  old?: boolean;
}

export function SiteImportCard(props: {
  projectId: string;
  siteUrl: string;
  state: "none" | "working" | "done" | "failed";
  step: string | null;
  /** Read through a paid route (a blocked site, 0.97.0): the badge doesn't say free. */
  paid?: boolean;
  /** Keep all content as is: the plan comes from these pages. */
  keep: boolean;
  /** Read through a blocked route: "28 pages read through Jina Reader for finleypest.com." */
  fallbackLine?: string | null;
  /** Pages nothing could read (paths): planned with a placeholder. */
  gaps?: string[];
  failure: string | null;
  /** What to do when the read failed, in order. */
  waysForward: string[];
  /** The intake's Website section (Read again is there). */
  intakeHref: string;
  /** "27 pages read from finleypest.com (its sitemap), 31,204 words." */
  doneLine: string | null;
  rows: ImportedRow[];
  skipped: { url: string; reason: string }[];
  notImported: string[];
  /** "18 blog articles kept on top of Pro's 50 pages: ..." (a makeover, 0.98.0). */
  articlesLine?: string | null;
  /** "23 more pages are over Pro's limit of 50 and weren't read." */
  limitLine: string | null;
  failed: { url: string; reason: string }[];
  /** "In the page plan since Oct 7, 2026, 3:20 PM PT (TAWD, automatically)." */
  usedLine: string | null;
  inPlan: boolean;
  /** Kept pages worked on that changed on the site, and kept pages gone from it (left as they are). */
  changed?: string[];
  gone?: string[];
  /** The one decision: a plan with work that isn't from the read. */
  decision?: { button: string; deletes: string } | null;
  canDecide?: boolean;
  /** Opened with the dialog showing (for screenshots). */
  startDialog?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [confirming, setConfirming] = useState(Boolean(props.startDialog));
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (props.state !== "working") return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [props.state, router]);

  const run = (action: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(false);
      router.refresh();
    });

  const shown = showAll ? props.rows : props.rows.slice(0, 12);
  const withFrom = props.rows.some((r) => r.from);
  const gaps = props.gaps ?? [];
  const total = props.rows.length + gaps.length;
  return (
    <div className="card content-card" id="kept-pages">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">
            Current site&rsquo;s pages <span className="badge badge-info">{props.paid ? "No AI" : "Free, no AI"}</span>
          </h2>
          <p className="hint">
            TAWD reads each page of {props.siteUrl} by code when the intake&rsquo;s Website section is saved, and keeps its own words
            exactly (the header, menu, footer, cookie bar, forms and review widgets are left out).
            {props.keep ? " Design only and Design + content: the page plan makes itself from them, at the same addresses so rankings carry over; each page's words wait for review and approval below." : ""}
          </p>
        </div>
        {props.decision && props.canDecide ? (
          <div className="money-row-actions">
            <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
              {props.decision.button}
            </Button>
          </div>
        ) : null}
      </div>
      {props.state === "none" ? (
        <p className="hint">
          Not read yet: it starts by itself when the intake&rsquo;s Website section is saved with an address.{" "}
          <a className="plain-link" href={props.intakeHref}>
            Open the intake&rsquo;s Website section
          </a>
        </p>
      ) : null}
      {props.state === "working" ? <p className="hint content-warn">{props.step ?? "Reading"}... one page at a time; this page refreshes itself.</p> : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {props.state === "failed" && props.waysForward.length ? (
        <ol className="hint content-ways">
          {props.waysForward.map((way) => (
            <li key={way}>{way}</li>
          ))}
        </ol>
      ) : null}
      {props.state === "failed" || props.state === "done" ? (
        <p className="hint">
          <a className="plain-link" href={props.intakeHref}>
            Read again on the intake&rsquo;s Website section
          </a>
        </p>
      ) : null}
      {props.decision ? (
        <p className="hint content-warn">
          The page plan has work that isn&rsquo;t from the current site, so TAWD didn&rsquo;t replace it. {props.decision.deletes} Generate on Design waits for
          this decision.
        </p>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}
      {props.fallbackLine ? <p className="hint">{props.fallbackLine}</p> : null}
      {gaps.length ? (
        <div className="kept-gaps" role="note">
          <p>
            <strong>{gaps.length === 1 ? "This page couldn't be read" : `These ${gaps.length} pages couldn't be read`}</strong> (blocked on the live site,
            and no other source had {gaps.length === 1 ? "it" : "them"}):
          </p>
          <ul>
            {gaps.map((g) => (
              <li key={g}>
                <code className="path">{g}</code>
              </li>
            ))}
          </ul>
          <p>
            The page plan has {gaps.length === 1 ? "it" : "them"} with a placeholder to paste {gaps.length === 1 ? "its" : "their"} words into; the site can&rsquo;t go live
            while one is left.
          </p>
        </div>
      ) : null}
      {props.articlesLine ? <p className="hint">{props.articlesLine}</p> : null}
      {props.limitLine ? <p className="hint content-warn">{props.limitLine}</p> : null}
      {props.usedLine ? <p className={props.inPlan ? "hint content-done" : "hint content-warn"}>{props.usedLine}</p> : null}
      {props.changed?.length ? <p className="hint content-warn">Changed on the current site since it was kept (left as the team has it): {props.changed.join(", ")}.</p> : null}
      {props.gone?.length ? <p className="hint content-warn">No longer on the current site (left in the plan): {props.gone.join(", ")}.</p> : null}

      {props.rows.length ? (
        <>
          <div className="table-scroll content-table">
            <table className="spend-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Kind</th>
                  <th className="align-right">Words</th>
                  {withFrom ? <th>From</th> : null}
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.path} className={r.old ? "kept-old" : undefined}>
                    <td>
                      <strong>{r.name}</strong> <code className="path">{r.path}</code>
                    </td>
                    <td>
                      <span className="badge badge-info">{r.kindLabel}</span>
                    </td>
                    <td className="align-right">{r.words.toLocaleString("en-US")}</td>
                    {withFrom ? <td className={r.old ? "content-warn" : "hint"}>{r.from ? `${r.from}${r.old ? " (over 6 months old)" : ""}` : "-"}</td> : null}
                    <td className="hint">{r.notes || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {props.rows.length > 12 ? (
            <Button variant="text" small onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${props.rows.length}`}
            </Button>
          ) : null}
        </>
      ) : null}

      {props.skipped.length || props.notImported.length || props.failed.length ? (
        <div className="kept-lists">
          {props.skipped.length ? (
            <details>
              <summary>Left out ({props.skipped.length}): not pages, or replaced by TAWD&rsquo;s own</summary>
              <ul>
                {props.skipped.map((s) => (
                  <li key={s.url}>
                    <code className="path">{s.url}</code> {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {props.notImported.length ? (
            <details>
              <summary>Over the page limit, not read ({props.notImported.length})</summary>
              <ul>
                {props.notImported.map((u) => (
                  <li key={u}>
                    <code className="path">{u}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {props.failed.length ? (
            <details open>
              <summary className="content-warn">Couldn&rsquo;t be read ({props.failed.length})</summary>
              <ul>
                {props.failed.map((f) => (
                  <li key={f.url}>
                    <code className="path">{f.url}</code> {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {confirming && props.decision ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kept-title">
            <h2 className="section-title" id="kept-title">
              Replace the page plan with the current site&rsquo;s {total} pages?
            </h2>
            <p className="hint">
              The page plan becomes these {total} pages, at the same addresses, and each page&rsquo;s words become its version 1,
              &ldquo;From the current site (kept as is)&rdquo;. <strong>{props.decision.deletes}</strong> Free, no AI. Content then reviews and
              approves each page; the SEO team sets the keywords.
            </p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => replacePlanWithSiteAction(props.projectId))}>
                {busy ? "Replacing the plan..." : `Replace with ${total} pages`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface SuggestionGroupView {
  key: string;
  title: string;
  why: string;
  would: string;
  importance: "high" | "medium" | "low";
  items: { page: string; found: string }[];
}

const IMPORTANCE = {
  high: { label: "High", className: "badge badge-missing" },
  medium: { label: "Medium", className: "badge badge-warning" },
  low: { label: "Low", className: "badge badge-info" },
} as const;

/* "Current site: SEO suggestions": TAWD's own rules on the kept pages, by code. Suggestions only. */
export function SiteSuggestionsCard(props: { groups: SuggestionGroupView[]; better: string[]; pageCount: number }) {
  const count = props.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="card content-card" id="site-suggestions">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">
            Current site: SEO suggestions <span className="badge badge-info">Suggestions only</span>
          </h2>
          <p className="hint">
            The {props.pageCount} kept pages checked against TAWD&rsquo;s own SEO rules, by code (free). Nothing changes by itself:
            the SEO team decides. Titles and descriptions change in the page plan; words on a page change on its review.
          </p>
        </div>
      </div>
      {props.groups.length === 0 ? <p className="hint content-done">Nothing found: the kept pages meet TAWD&rsquo;s rules.</p> : <p className="content-done-line">{count} suggestion{count === 1 ? "" : "s"} in {props.groups.length} groups, most important first.</p>}
      <ol className="suggestion-list">
        {props.groups.map((g) => (
          <li key={g.key} className="suggestion">
            <p className="suggestion-title">
              <span className={IMPORTANCE[g.importance].className}>{IMPORTANCE[g.importance].label}</span> {g.title}
            </p>
            <p className="hint">{g.why}</p>
            <p className="hint">
              <strong>What TAWD would do:</strong> {g.would}
            </p>
            <ul className="suggestion-items">
              {g.items.slice(0, 6).map((item, i) => (
                <li key={`${item.page}-${i}`}>
                  <code className="path">{item.page}</code> {item.found}
                </li>
              ))}
            </ul>
            {g.items.length > 6 ? (
              <details>
                <summary>{g.items.length - 6} more</summary>
                <ul className="suggestion-items">
                  {g.items.slice(6).map((item, i) => (
                    <li key={`${item.page}-more-${i}`}>
                      <code className="path">{item.page}</code> {item.found}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
      {props.better.length ? (
        <div className="copy-pack">
          <div>
            <p className="copy-pack-title">What TAWD does better automatically</p>
            <ul className="suggestion-items">
              {props.better.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
