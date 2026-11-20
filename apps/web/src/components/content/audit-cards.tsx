"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { addFullAuditAction, addSuggestedPageAction, countSitePagesAction, saveRedirectAction, startFullAuditAction, startQuickCheckAction } from "@/app/actions";
import { FileUploader, type UploadedFile } from "@/components/intake/uploader";
import { Button } from "@/components/ui/button";

/*
  SEO audits of the client's current website (26 September 2026): the free
  "Don't lose it" check (its pages, which rank, where each old address
  goes on the new site), and the full audit (a paid add-on priced by the
  site's size) with the Senior SEO agent's report.
*/

type Result = { ok: true } | { ok: false; message: string };

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (action: () => Promise<Result>, done?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      done?.();
      router.refresh();
    });
  return { error, busy, run, router };
}

export interface RedirectView {
  from: string;
  to: string;
  pageName: string;
  keywords: string;
  traffic: string;
  /** Nothing matched (no page chosen yet): no redirect is written until a person picks one. */
  unmatched: boolean;
  /** The address has characters the redirect file reads as a pattern: never written, so there is nothing to pick. */
  unsafe: boolean;
  reason: string;
  topKeyword: string | null;
  /** A target the team changed by hand (#6), shown with a marker. */
  edited: boolean;
}

export function CurrentSiteCard(props: {
  projectId: string;
  canRun: boolean;
  /** content.plan: may change a redirect target (#6). */
  canEdit: boolean;
  siteUrl: string | null;
  state: "none" | "working" | "done" | "failed";
  step: string | null;
  failure: string | null;
  /** "34 pages in the sitemap; 12 rank for 86 keywords, about 410 visits a month from search." */
  doneLine: string | null;
  redirects: RedirectView[];
  /** The plan's pages, the only valid redirect targets (#6). */
  targets: { path: string; name: string }[];
  sandbox: boolean;
}) {
  const { error, busy, run, router } = useRun();
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (props.state !== "working") return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [props.state, router]);

  // Addresses a person can give a page first, then the ones TAWD can't write, then the rest: the ones to deal with are never hidden behind "Show all".
  const rank = (r: RedirectView) => (r.unmatched && !r.unsafe ? 0 : r.unsafe ? 1 : 2);
  const ordered = [...props.redirects].sort((a, b) => rank(a) - rank(b));
  const shown = showAll ? ordered : ordered.slice(0, 12);
  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">
            Current website {props.sandbox ? <span className="badge badge-info">Sandbox: test data</span> : null}
          </h2>
          <p className="hint">
            &ldquo;Don&rsquo;t lose it&rdquo;: the pages of {props.siteUrl ?? "the client's current site"}, which of them rank, and where each
            old address goes on the new site. The new site redirects each one that has a page, so a page that ranks today keeps its visitors. An old address that matches no planned page is not sent to the home page: it is listed first with “No match”, and has no redirect (the new site shows its “not found” page there) until someone chooses a page for it. An address TAWD can’t write a redirect for is listed with the reason.
            Included with every site; it runs by itself when the website is saved in the intake.
          </p>
        </div>
        {props.canRun && props.siteUrl && props.state !== "working" ? (
          <Button small disabled={busy} onClick={() => run(() => startQuickCheckAction(props.projectId))}>
            {props.state === "none" ? "Check it now" : "Check again"}
          </Button>
        ) : null}
      </div>
      {!props.siteUrl ? <p className="hint">No current website in the intake (Website section), so there is nothing to keep.</p> : null}
      {props.state === "working" ? <p className="hint content-warn">{props.step ?? "Checking"}... this page refreshes itself.</p> : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}

      {props.redirects.length ? (
        <>
          <div className="table-scroll content-table">
            <table className="spend-table">
              <thead>
                <tr>
                  <th>Old address</th>
                  <th className="align-right">Ranks for</th>
                  <th className="align-right">Visits a month</th>
                  <th>Goes to</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.from}>
                    <td>
                      <code className="path">{r.from}</code>
                    </td>
                    <td className="align-right">{r.keywords}</td>
                    <td className="align-right">{r.traffic}</td>
                    <td>
                      {r.unmatched ? (
                        <span className="redirect-unmatched">
                          <span className="content-warn">{r.unsafe ? r.reason : props.canEdit && props.targets.length ? "No match: no redirect yet. Choose a page." : "No match: no redirect yet. A page can be chosen here once the page plan has pages and the audit has finished, by someone who can change the plan."}</span>
                          {!r.unsafe && props.canEdit && props.targets.length ? (
                            <select
                              className="redirect-target"
                              value=""
                              disabled={busy}
                              aria-label={`Where ${r.from} goes`}
                              onChange={(e) => {
                                const to = e.target.value;
                                if (to) run(() => saveRedirectAction(props.projectId, r.from, to));
                              }}
                            >
                              <option value="">Choose a page</option>
                              {props.targets.map((t) => (
                                <option key={t.path} value={t.path}>
                                  {t.path} ({t.name})
                                </option>
                              ))}
                            </select>
                          ) : null}
                          {!r.unsafe && props.canRun && r.topKeyword ? (
                            <Button variant="text" small disabled={busy} onClick={() => run(() => addSuggestedPageAction(props.projectId, capital(r.topKeyword!), r.topKeyword!))}>
                              Add a page for &ldquo;{r.topKeyword}&rdquo;
                            </Button>
                          ) : null}
                        </span>
                      ) : props.canEdit && props.targets.length ? (
                        <span className="redirect-edit">
                          <select
                            className="redirect-target"
                            value={r.to}
                            disabled={busy}
                            aria-label={`Where ${r.from} goes`}
                            onChange={(e) => {
                              const to = e.target.value;
                              if (to !== r.to) run(() => saveRedirectAction(props.projectId, r.from, to));
                            }}
                          >
                            {props.targets.some((t) => t.path === r.to) ? null : <option value={r.to}>{r.to}</option>}
                            {props.targets.map((t) => (
                              <option key={t.path} value={t.path}>
                                {t.path} ({t.name})
                              </option>
                            ))}
                          </select>
                          {r.edited ? <span className="badge badge-info">edited</span> : null}
                        </span>
                      ) : (
                        <>
                          <code className="path">{r.to}</code> <span className="hint">{r.pageName}</span>
                          {r.edited ? <span className="badge badge-info">edited</span> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {props.redirects.length > 12 ? (
            <Button variant="text" small onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show the first 12" : `Show all ${props.redirects.length}`}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function FullAuditCard(props: {
  projectId: string;
  canAdd: boolean;
  canRun: boolean;
  siteUrl: string | null;
  /** The band on the project: "Full SEO audit, 21 to 40 pages". */
  addonName: string | null;
  estimateLine: string;
  state: "none" | "crawling" | "working" | "done" | "failed";
  step: string | null;
  failure: string | null;
  exports: UploadedFile[];
  report: {
    summary: string;
    priorities: { title: string; problem: string; fix: string; pages: string[]; impact: "high" | "medium" | "low" }[];
    gaps: { title: string; detail: string }[];
    planSuggestions: { name: string; mainKeyword: string; reason: string }[];
  } | null;
  doneLine: string | null;
}) {
  const { error, busy, run, router } = useRun();
  const [counted, setCounted] = useState<{ pageCount: number; bandName: string; price: string | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const working = props.state === "crawling" || props.state === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 6000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">
            Full SEO audit <span className="badge badge-info">Add-on</span>
          </h2>
          <p className="hint">
            A crawl of the whole current site (DataForSEO), Google PageSpeed, rankings and traffic, and a report from the Senior
            SEO agent: problems, priorities, gaps and pages the plan may need. Priced by the site&rsquo;s size, in bands of 20
            pages.
          </p>
        </div>
        {props.addonName && props.canRun && !working ? (
          <Button variant={props.report ? "secondary" : "primary"} disabled={busy || !props.siteUrl} onClick={() => setConfirming(true)}>
            {props.report ? "Run it again" : "Run the full audit"}
          </Button>
        ) : null}
      </div>
      {!props.siteUrl ? <p className="hint">No current website in the intake to audit.</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {!props.addonName && props.siteUrl && props.canAdd ? (
        <div className="audit-add">
          {counted ? (
            <p className="hint">
              {counted.pageCount} page{counted.pageCount === 1 ? "" : "s"} in the sitemap: <strong>{counted.bandName}</strong>
              {counted.price ? ` (${counted.price})` : ""}.
            </p>
          ) : (
            <p className="hint">TAWD counts the site&rsquo;s pages from its sitemap (free) and suggests the band.</p>
          )}
          <div className="money-row-actions" style={{ justifyContent: "flex-start" }}>
            {counted ? (
              <Button variant="primary" small disabled={busy} onClick={() => run(() => addFullAuditAction(props.projectId))}>
                Add the full audit to this project
              </Button>
            ) : (
              <Button
                small
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await countSitePagesAction(props.projectId);
                    if (result.ok) setCounted({ pageCount: result.pageCount, bandName: result.bandName, price: result.price });
                    return result.ok ? { ok: true } : result;
                  })
                }
              >
                {busy ? "Counting..." : "Count the site's pages"}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {props.addonName ? (
        <>
          <p className="hint">
            On this project: {props.addonName}. {props.state === "none" || props.state === "failed" ? props.estimateLine : ""}
          </p>
          <FileUploader
            projectId={props.projectId}
            kind="seo_crawl_export"
            label="Screaming Frog export (optional)"
            canEdit={props.canRun}
            files={props.exports}
            dropLabel="Drop a CSV export or choose a file"
          />
          <p className="hint">Extra evidence if the SEO team runs one; the audit never waits for it.</p>
        </>
      ) : null}
      {working ? (
        <div className="stop-line">
          <p className="hint content-warn">{props.step ?? "Working"}... this page refreshes itself.</p>
          {props.canRun ? <StopButton projectId={props.projectId} kind="seo_audit" what="the SEO audit" /> : null}
        </div>
      ) : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}

      {props.report ? (
        <div className="audit-report">
          {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}
          <p>{props.report.summary}</p>
          <h3 className="audit-heading">Priorities</h3>
          <ol className="audit-list">
            {props.report.priorities.map((p, i) => (
              <li key={i}>
                <p className="seo-check-label">
                  <span className={p.impact === "high" ? "badge badge-missing" : p.impact === "medium" ? "badge badge-warning" : "badge badge-info"}>
                    {p.impact === "high" ? "High impact" : p.impact === "medium" ? "Medium" : "Low"}
                  </span>{" "}
                  {p.title}
                </p>
                <p className="hint">{p.problem}</p>
                <p className="hint">
                  <strong>Fix:</strong> {p.fix}
                </p>
                {p.pages.length ? <p className="hint">Pages: {p.pages.slice(0, 6).join(", ")}{p.pages.length > 6 ? ", ..." : ""}</p> : null}
              </li>
            ))}
          </ol>
          {props.report.gaps.length ? (
            <>
              <h3 className="audit-heading">Gaps</h3>
              <ul className="audit-list">
                {props.report.gaps.map((g, i) => (
                  <li key={i}>
                    <p className="seo-check-label">{g.title}</p>
                    <p className="hint">{g.detail}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {props.report.planSuggestions.length ? (
            <>
              <h3 className="audit-heading">Pages for the plan</h3>
              <ul className="audit-list">
                {props.report.planSuggestions.map((s, i) => (
                  <li key={i} className="audit-suggestion">
                    <div>
                      <p className="seo-check-label">
                        {s.name} <span className="hint">({s.mainKeyword})</span>
                      </p>
                      <p className="hint">{s.reason}</p>
                    </div>
                    {props.canRun ? (
                      <Button small disabled={busy} onClick={() => run(() => addSuggestedPageAction(props.projectId, s.name, s.mainKeyword))}>
                        Add to the plan
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="audit-title">
            <h2 className="section-title" id="audit-title">
              Run the full SEO audit?
            </h2>
            <p className="hint">DataForSEO crawls every page of {props.siteUrl}; PageSpeed measures the main pages; the Senior SEO agent writes the report. It takes a few minutes.</p>
            <p className="hint">{props.estimateLine}</p>
            <div className="modal-actions">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => startFullAuditAction(props.projectId), () => setConfirming(false))}>
                {busy ? "Starting..." : "Run it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
