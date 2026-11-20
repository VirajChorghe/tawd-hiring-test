"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { overrideSpeedAction, startSpeedCheckAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

type Scores = { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
type Device = { scores: Scores; metrics: { lcp: string | null; cls: string | null }; issues: { title: string; saves: string | null }[]; hiddenFromSearch: boolean };

export interface SpeedCheckCardProps {
  projectId: string;
  canCheck: boolean;
  targets: {
    target: "netlify" | "wordpress";
    url: string | null;
    last: {
      status: "queued" | "done" | "failed";
      when: string;
      mobile: Device | null;
      desktop: Device | null;
      error: string | null;
      url: string;
      /** The build version the preview was serving. */
      version: number | null;
    } | null;
  }[];
  /** The speed gate for the build going live (Jason, 1 October 2026): what it says, and whether this viewer may let it go live below the minimum. */
  gate?: { state: "none" | "good" | "buffer" | "low" | "overridden"; line: string; canOverride: boolean };
}

const NAME = { netlify: "Netlify preview", wordpress: "WordPress preview" } as const;
const COLUMNS: { key: keyof Scores; label: string }[] = [
  { key: "performance", label: "Speed" },
  { key: "accessibility", label: "Accessibility" },
  { key: "bestPractices", label: "Best practices" },
  { key: "seo", label: "SEO" },
];
const band = (n: number | null) => (n === null ? "none" : n >= 90 ? "good" : n >= 50 ? "fair" : "poor");

/*
  The Speed check (1 October 2026): Google PageSpeed on each preview, on a
  phone and a computer, before anything goes live. Scores in Google's
  bands (90 and up good, 50 to 89 needs work, under 50 poor), and the main
  things to fix in Google's own words.
*/
export function SpeedCheckCard(props: SpeedCheckCardProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const checking = props.targets.some((t) => t.last?.status === "queued");
  useEffect(() => {
    if (!checking) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [checking, router]);

  return (
    <div className="card content-card" id="speed-check">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Speed check</h2>
          <p className="hint">Google PageSpeed on each preview, on a phone and a computer: the scores Google gives the site. Free, about a minute. 90 and up is good.</p>
        </div>
      </div>
      {props.gate ? (
        <div className="fm-test">
          <p className={props.gate.state === "low" || props.gate.state === "none" ? "hint-amber" : "hint"}>{props.gate.line}</p>
          {props.gate.state === "low" && props.gate.canOverride ? (
            <Button
              small
              variant="secondary"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await overrideSpeedAction(props.projectId);
                  if (!r.ok) setError(r.message);
                  router.refresh();
                })
              }
            >
              Let it go live anyway
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.targets.length === 0 ? <p className="hint">Deploy a preview first (Netlify or WordPress): the check runs on it.</p> : null}
      {props.targets.map((t) => {
        const last = t.last;
        const device = last?.status === "done" ? [last.mobile, last.desktop] : null;
        const fixes = last?.status === "done" ? (last.mobile?.issues ?? []).slice(0, 4) : [];
        return (
          <section className="fm-section" key={t.target}>
            <h3 className="fm-heading">{NAME[t.target]}</h3>
            {device ? (
              <>
                <div className="table-scroll">
                  <table className="speed-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className="visually-hidden">Device</span>
                        </th>
                        {COLUMNS.map((c) => (
                          <th scope="col" key={c.key}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(["Phone", "Computer"] as const).map((label, i) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          {COLUMNS.map((c) => {
                            const n = device[i]?.scores[c.key] ?? null;
                            return (
                              <td key={c.key}>
                                <span className={`speed-score speed-${band(n)}`}>{n ?? "–"}</span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {fixes.length ? (
                  <div>
                    <p className="seo-check-label">Main things to fix (phone)</p>
                    <ul className="speed-fixes">
                      {fixes.map((f) => (
                        <li key={f.title}>
                          {f.title}
                          {f.saves ? <span className="hint"> ({f.saves})</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {last?.mobile?.hiddenFromSearch ? <p className="hint">SEO reads lower on a preview: search engines are kept out of it until go-live.</p> : null}
              </>
            ) : null}
            {last?.status === "queued" ? <p className="hint">Checking {last.url}&hellip; about a minute; this page refreshes itself.</p> : null}
            {last?.status === "failed" ? <p className="hint-error">The check didn&rsquo;t finish: {last.error ?? "PageSpeed didn't answer."}</p> : null}
            <div className="fm-test">
              {props.canCheck && t.url ? (
                <Button
                  small
                  variant={last ? "secondary" : "primary"}
                  disabled={busy || last?.status === "queued"}
                  onClick={() =>
                    start(async () => {
                      setError(null);
                      const r = await startSpeedCheckAction(props.projectId, t.target);
                      if (!r.ok) setError(r.message);
                      router.refresh();
                    })
                  }
                >
                  {last ? "Check again" : "Check speed"}
                </Button>
              ) : null}
              <p className="hint">{last?.status === "done" ? `Checked ${last.when}, ${last.url}${last.version !== null ? ` (v${last.version})` : ""}` : t.url ? t.url : "Not deployed now."}</p>
            </div>
          </section>
        );
      })}
    </div>
  );
}
