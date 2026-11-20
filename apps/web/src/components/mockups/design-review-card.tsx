"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startDesignReviewAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  Lane 2, Option B: the Creative Director's review of the designer's
  homepage, on the Mockups page under Concept 1. The review is paid, so the
  button opens a confirmation with the estimate before anything is spent.
*/

export interface DesignReviewCardProps {
  projectId: string;
  canRun: boolean;
  estimate: string;
  /** Why a review can't start this month, if the AI limit is reached. */
  limitBlocked: string | null;
  /* Step 1 for Lane 2: the facts from the design, pre-filled and confirmed by the PM. */
  facts: { prefilled: boolean; filled: number; unconfirmed: number };
  review: {
    status: "queued" | "working" | "done" | "failed";
    failureReason: string | null;
    average: number | null;
    lowest: number | null;
    summary: string | null;
    mustFix: number;
    shouldFix: number;
    recommendations: number;
    confirmFacts: number;
    ticked: number;
    line: string;
    outOfDate: boolean;
  } | null;
}

export function DesignReviewCard(props: DesignReviewCardProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const review = props.review;
  const working = review?.status === "queued" || review?.status === "working";

  // The review runs in the worker; look again every few seconds until it is done.
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const startButton = (label: string, variant: "primary" | "secondary") =>
    props.canRun ? (
      <Button variant={variant} disabled={busy || Boolean(props.limitBlocked)} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    ) : null;

  return (
    <section className="card design-review-card" aria-label="Creative Director review">
      <div className="designer-design-head">
        <div>
          <p className="concept-card-title">Creative Director review</p>
          <FactsStep projectId={props.projectId} facts={props.facts} />
          {!review ? (
            <p className="hint">
              The Creative Director reviews the designer&rsquo;s homepage with the same 8 questions as the concepts and
              lists what should change (Must-fix, Should-fix and Recommendations) and any facts to confirm with the client, each pinned to its spot on the design.
              You then choose which fixes go into the improved version.
            </p>
          ) : working ? (
            <div className="stop-line">
              <p className="concept-working" role="status">
                The Creative Director is reviewing the design. It takes a few minutes; this page updates when it&rsquo;s done.
              </p>
              <StopButton projectId={props.projectId} kind="design_review" what="the review" />
            </div>
          ) : review.status === "failed" ? (
            <p className="hint-error">The review didn&rsquo;t finish: {review.failureReason}</p>
          ) : (
            <>
              <p className="design-review-score">
                {review.average?.toFixed(1)} of 5 on average, lowest {review.lowest}
              </p>
              <div className="concept-badges">
                <Badge kind="missing">{review.mustFix} must-fix</Badge>
                <Badge kind="warning">{review.shouldFix} should-fix</Badge>
                <Badge kind="info">
                  {review.recommendations} recommendation{review.recommendations === 1 ? "" : "s"}
                </Badge>
                {review.confirmFacts > 0 ? (
                  <Badge kind="info">
                    {review.confirmFacts} fact{review.confirmFacts === 1 ? "" : "s"} to confirm
                  </Badge>
                ) : null}
              </div>
              {review.summary ? <p className="concept-signature">{review.summary}</p> : null}
              <p className="hint">
                {review.ticked} fix{review.ticked === 1 ? "" : "es"} ticked for the improved version. {review.line}
              </p>
              {review.outOfDate ? (
                <p className="hint-missing">The design was imported again since this review. Review it again to see the latest.</p>
              ) : null}
            </>
          )}
          {!review || review.status === "failed" ? (
            <p className="hint">
              {props.estimate}.{props.limitBlocked ? ` ${props.limitBlocked}` : ""}
            </p>
          ) : null}
          {error ? <p className="hint-error">{error}</p> : null}
        </div>
        <div className="designer-design-actions">
          {review?.status === "done" ? (
            <>
              <ButtonLink variant="primary" href={`/projects/${props.projectId}/mockups/design`}>
                Open the review
              </ButtonLink>
              {startButton("Review again", "secondary")}
            </>
          ) : working ? null : (
            startButton(review ? "Review again" : "Review the design", "primary")
          )}
        </div>
      </div>

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="design-review-title">
            <h2 className="section-title" id="design-review-title">
              {review ? "Review the design again?" : "Review the designer's design?"}
            </h2>
            <p className="hint">
              The Creative Director reviews the imported homepage and lists what should change, pinned to the design.
              Must-fix items start ticked for the improved version; you choose the rest.
              {review ? " The new review replaces this one on the page; its ticks start over." : ""}
            </p>
            {!props.facts.prefilled || props.facts.unconfirmed > 0 ? (
              <p className="hint-missing">
                {!props.facts.prefilled
                  ? "The intake hasn’t been pre-filled from the design yet, so the facts in the design aren’t confirmed."
                  : `${props.facts.unconfirmed} fact${props.facts.unconfirmed === 1 ? "" : "s"} from the design ${props.facts.unconfirmed === 1 ? "isn’t" : "aren’t"} confirmed yet.`}{" "}
                The review will list unconfirmed facts to check with the client; it never turns them into placeholders.
              </p>
            ) : null}
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
                    const result = await startDesignReviewAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Review the design"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* Step 1: pre-fill the intake from the design and confirm the facts, so the review knows what is settled. */
function FactsStep({ projectId, facts }: { projectId: string; facts: DesignReviewCardProps["facts"] }) {
  const done = facts.prefilled && facts.unconfirmed === 0;
  return (
    <div className={done ? "facts-step is-done" : "facts-step"}>
      <Badge kind={done ? "done" : "warning"}>{done ? "Facts confirmed" : "Step 1"}</Badge>
      <p className="facts-step-text">
        {!facts.prefilled
          ? "Before the review: pre-fill the intake from the design, then confirm or correct each fact, so the review treats the client’s facts as settled."
          : facts.unconfirmed > 0
            ? `${facts.unconfirmed} of ${facts.filled} facts from the design still to confirm. Confirm or correct them before the review.`
            : `All ${facts.filled} facts from the design are confirmed or corrected.`}
      </p>
      {!done ? (
        <ButtonLink small href={`/projects/${projectId}/intake?section=${facts.prefilled ? "business" : "figma"}`}>
          {facts.prefilled ? "Confirm the facts" : "Pre-fill the intake"}
        </ButtonLink>
      ) : null}
    </div>
  );
}
