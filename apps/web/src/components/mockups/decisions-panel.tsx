"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startDecisionsVersionAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Lane 2, Option B, 4c-2: "Make a version with the designer's decisions".
  How far the decisions have got, what making the version will do and cost
  (free when every pushed-back change can simply be put back), and the
  version once made.
*/

export interface DecisionsPanelProps {
  projectId: string;
  canMake: boolean;
  total: number;
  accepted: number;
  pushedBack: number;
  open: number;
  /** What making it does, in words: "2 sections put back as designed, 1 small edit". */
  planLine: string;
  estimate: string;
  limitBlocked: string | null;
  version: {
    status: "queued" | "working" | "done" | "failed";
    detail: string | null;
    failureReason: string | null;
    line: string;
    summary: string[];
    imageUrl: string | null;
    outOfDate: boolean;
  } | null;
}

export function DecisionsPanel(props: DecisionsPanelProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const working = props.version?.status === "queued" || props.version?.status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const ready = props.open === 0;
  const again = props.version?.status === "done" || props.version?.status === "failed";

  return (
    <section className="card decisions-panel" aria-label="The designer's decisions">
      <div className="decisions-head">
        <div>
          <p className="card-title">The designer&rsquo;s decisions</p>
          <p className="decisions-count">
            {props.total - props.open} of {props.total} decided: {props.accepted} accepted, {props.pushedBack} pushed back
          </p>
          {ready ? (
            <p className="hint">
              {props.planLine}. {props.estimate}.{props.limitBlocked ? ` ${props.limitBlocked}` : ""}
            </p>
          ) : (
            <p className="hint-missing">
              {props.open} change{props.open === 1 ? " needs" : "s need"} the Web Designer&rsquo;s (or an admin&rsquo;s) Accept or Push back
              before the version can be made.
            </p>
          )}
        </div>
        {props.canMake && !working ? (
          <Button
            variant={again ? "secondary" : "primary"}
            disabled={!ready || busy || Boolean(props.limitBlocked)}
            onClick={() => setConfirming(true)}
          >
            {again ? "Make it again" : "Make a version with the designer’s decisions"}
          </Button>
        ) : null}
      </div>

      {props.version ? (
        working ? (
          <div className="stop-line">
            <p className="concept-working" role="status">
              {props.version.detail ?? "Waiting for the worker"}. This page updates when it&rsquo;s done.
            </p>
            <StopButton projectId={props.projectId} kind="design_improve" what="the new version" />
          </div>
        ) : props.version.status === "failed" ? (
          <p className="hint-error">The version didn&rsquo;t finish: {props.version.failureReason}</p>
        ) : (
          <div className="decisions-version">
            {props.version.imageUrl ? (
              <a className="design-copy-thumb" href={`/projects/${props.projectId}/mockups/design/improved/live?v=decisions`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link */}
                <img src={props.version.imageUrl} alt="The version with the designer's decisions, first screen" />
              </a>
            ) : null}
            <div>
              <p className="decisions-version-title">Version with the designer&rsquo;s decisions</p>
              <ul className="copy-notes">
                {props.version.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="hint">{props.version.line}</p>
              {props.version.outOfDate ? (
                <p className="hint-missing">A decision changed since this version was made. Make it again to match.</p>
              ) : null}
              <a className="btn btn-secondary" href={`/projects/${props.projectId}/mockups/design/improved/live?v=decisions`} target="_blank" rel="noreferrer">
                Open this version
              </a>
            </div>
          </div>
        )
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="decisions-title">
            <h2 className="section-title" id="decisions-title">
              Make a version with the designer&rsquo;s decisions?
            </h2>
            <p className="hint">
              {props.planLine}. The improved design stays as it is; this is a new version beside it.
            </p>
            <p className="hint">{props.estimate}.</p>
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
                    const result = await startDecisionsVersionAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Make it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
