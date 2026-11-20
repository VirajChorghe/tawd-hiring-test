"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startDesignImprovementAction } from "@/app/actions";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  Lane 2, Option B, 4c: the improved design card on Mockups, after the
  faithful copy. The ticked fixes made on the copy one section at a time,
  each a tracked change, then the Creative Director's re-score. Paid, so
  the button opens a confirmation with the estimate first.
*/

export interface DesignImprovementCardProps {
  projectId: string;
  canRun: boolean;
  estimate: string;
  limitBlocked: string | null;
  /** What is still needed before it can run; null when it can. */
  blocker: string | null;
  tickedFixes: number;
  improvement: {
    status: "queued" | "working" | "done" | "failed";
    detail: string | null;
    failureReason: string | null;
    before: number | null;
    after: number | null;
    changes: number;
    notApplied: number;
    line: string;
    imageUrl: string | null;
    outOfDate: boolean;
    /** The designer's answers so far, and whether a version with them exists. */
    decisions: { decided: number; total: number; accepted: number; pushedBack: number; version: "none" | "working" | "done" | "failed" };
  } | null;
}

export function DesignImprovementCard(props: DesignImprovementCardProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const improvement = props.improvement;
  const working = improvement?.status === "queued" || improvement?.status === "working";
  const href = `/projects/${props.projectId}/mockups/design/improved`;

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const startButton = (label: string, variant: "primary" | "secondary") =>
    props.canRun ? (
      <Button
        variant={variant}
        disabled={busy || Boolean(props.limitBlocked) || Boolean(props.blocker)}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
    ) : null;

  const fixes = `${props.tickedFixes} ticked fix${props.tickedFixes === 1 ? "" : "es"}`;

  return (
    <section className="card design-copy-card" aria-label="Improved design">
      <div className="designer-design-head">
        <div className="design-copy-main">
          <p className="concept-card-title">Improved design</p>
          {!improvement ? (
            <p className="hint">
              TAWD makes the fixes ticked in the review on the faithful copy, one section at a time, and keeps every change
              with a before and after, so the designer can accept it or push back. The logo, brand colours and fonts stay
              the designer&rsquo;s. Then the Creative Director scores the improved page again.
            </p>
          ) : working ? (
            <div className="stop-line">
              <p className="concept-working" role="status">
                {improvement.detail ?? "Waiting for the worker"}. It takes a few minutes; this page updates when it&rsquo;s done.
              </p>
              <StopButton projectId={props.projectId} kind="design_improve" what="the improved design" />
            </div>
          ) : improvement.status === "failed" ? (
            <p className="hint-error">The improved design didn&rsquo;t finish: {improvement.failureReason}</p>
          ) : (
            <>
              <p className="design-review-score">
                {improvement.before !== null && improvement.after !== null
                  ? `Creative Director: ${improvement.before.toFixed(1)} → ${improvement.after.toFixed(1)} of 5`
                  : improvement.after !== null
                    ? `Creative Director: ${improvement.after.toFixed(1)} of 5`
                    : "Improved design built"}
              </p>
              <p className="hint">
                {improvement.changes} tracked change{improvement.changes === 1 ? "" : "s"}
                {improvement.notApplied > 0
                  ? `; ${improvement.notApplied} fix${improvement.notApplied === 1 ? "" : "es"} not made (the page says why)`
                  : ""}
                .
              </p>
              {improvement.decisions.total > 0 ? (
                <p className="hint">
                  Designer&rsquo;s decisions: {improvement.decisions.decided} of {improvement.decisions.total}
                  {improvement.decisions.decided > 0
                    ? ` (${improvement.decisions.accepted} accepted, ${improvement.decisions.pushedBack} pushed back)`
                    : ""}
                  {improvement.decisions.version === "done"
                    ? "; a version with them is ready."
                    : improvement.decisions.version === "working"
                      ? "; making the version with them."
                      : improvement.decisions.decided === improvement.decisions.total
                        ? "; ready to make the version with them."
                        : "."}
                </p>
              ) : null}
              <p className="hint">{improvement.line}</p>
              {improvement.outOfDate ? (
                <p className="hint-missing">
                  The review or the copy is newer than this improved design. Build it again to use the latest.
                </p>
              ) : null}
            </>
          )}
          {!improvement || improvement.status === "failed" ? (
            props.blocker ? (
              <p className="hint-missing">{props.blocker}</p>
            ) : (
              <p className="hint">
                {fixes}. {props.estimate}.{props.limitBlocked ? ` ${props.limitBlocked}` : ""}
              </p>
            )
          ) : null}
          {error ? <p className="hint-error">{error}</p> : null}
        </div>
        <div className="designer-design-actions">
          {improvement?.status === "done" ? (
            <>
              <ButtonLink variant="primary" href={href}>
                Open the changes
              </ButtonLink>
              {startButton("Build again", "secondary")}
            </>
          ) : working ? null : (
            startButton(improvement ? "Build again" : "Build the improved design", "primary")
          )}
        </div>
        {improvement?.status === "done" && improvement.imageUrl ? (
          <a className="design-copy-thumb" href={href} aria-label="Open the changes">
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link */}
            <img src={improvement.imageUrl} alt="The improved design's first screen" />
          </a>
        ) : null}
      </div>

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="design-improve-title">
            <h2 className="section-title" id="design-improve-title">
              {improvement ? "Build the improved design again?" : "Build the improved design?"}
            </h2>
            <p className="hint">
              The {fixes} are made on the faithful copy, one section at a time; contrast that still fails gets a darker
              shade of the same colour, by code. Then one Creative Director re-score.
              {improvement ? " The new version replaces this one on the page." : ""}
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
                    const result = await startDesignImprovementAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Build it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
