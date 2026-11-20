"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { startKeywordResearchAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Keyword research (7a): how many people search for each service in each
  service area, and how hard each term is to rank for, from DataForSEO.
  The estimate shows before anything is spent; the sandbox is free test
  data. While it runs, the page refreshes itself.
*/

export interface KeywordRow {
  keyword: string;
  service: string;
  area: string;
  volume: string;
  difficulty: string;
  cpc: string;
}

export function KeywordResearchCard(props: {
  projectId: string;
  canRun: boolean;
  sandbox: boolean;
  /** Coolify variables still missing; empty when set up. */
  missing: string[];
  estimate: { keywords: number; places: string[]; cached: number; line: string; blocked: string | null };
  state: "none" | "working" | "done" | "failed";
  failureReason: string | null;
  /** "142 keywords in 3 places, Sep 26, 3:10 PM, started by Jason. Free (sandbox)." */
  doneLine: string | null;
  keywords: KeywordRow[];
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (props.state !== "working") return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [props.state, router]);

  const shown = showAll ? props.keywords : props.keywords.slice(0, 12);
  const again = props.state === "done" || props.state === "failed";

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">
            Keyword research{" "}
            {props.sandbox ? <span className="badge badge-info">Sandbox: test data</span> : null}
          </h2>
          <p className="hint">
            How many people search for each service in each service area, and how hard each term is to rank for. From
            DataForSEO; each keyword is looked up once and kept, so nothing is paid for twice.
          </p>
        </div>
        {props.canRun && props.state !== "working" ? (
          <Button
            variant={again ? "secondary" : "primary"}
            disabled={busy || Boolean(props.estimate.blocked)}
            onClick={() => setConfirming(true)}
          >
            {again ? "Look up again" : "Look up keywords"}
          </Button>
        ) : null}
      </div>

      {props.missing.length > 0 ? (
        <p className="hint content-warn">
          DataForSEO isn&rsquo;t set up yet: an admin adds {props.missing.join(" and ")} in Coolify.
        </p>
      ) : props.state === "working" ? (
        <p className="hint content-warn">Looking up {props.estimate.keywords} keywords... this takes under a minute.</p>
      ) : (
        <>
          {props.estimate.blocked ? <p className="hint content-warn">{props.estimate.blocked}</p> : null}
          {!props.estimate.blocked && props.state !== "done" ? <p className="hint">{props.estimate.line}</p> : null}
        </>
      )}
      {props.state === "failed" && props.failureReason ? <p className="hint-error">{props.failureReason}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {props.state === "done" || props.keywords.length > 0 ? (
        <>
          {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : null}
          <div className="table-scroll content-table">
            <table className="spend-table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Service</th>
                  <th>Area</th>
                  <th className="align-right">Searches a month</th>
                  <th className="align-right">Difficulty</th>
                  <th className="align-right">Cost per click</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((k) => (
                  <tr key={`${k.keyword}|${k.area}`}>
                    <td>
                      <strong>{k.keyword}</strong>
                    </td>
                    <td>{k.service}</td>
                    <td>{k.area}</td>
                    <td className="align-right">{k.volume}</td>
                    <td className="align-right">{k.difficulty}</td>
                    <td className="align-right">{k.cpc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {props.keywords.length > 12 ? (
            <Button variant="text" small onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show the top 12" : `Show all ${props.keywords.length}`}
            </Button>
          ) : null}
        </>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="research-title">
            <h2 className="section-title" id="research-title">
              Look up {props.estimate.keywords} keywords?
            </h2>
            <p className="hint">
              Every service in every service area, in {props.estimate.places.length} place
              {props.estimate.places.length === 1 ? "" : "s"}: {props.estimate.places.join("; ")}.
            </p>
            <p className="hint">{props.estimate.line}</p>
            <div className="modal-actions">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await startKeywordResearchAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Look them up"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
