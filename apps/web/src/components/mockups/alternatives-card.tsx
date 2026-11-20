"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startAlternativesAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Lane 2, Option B (4c-2b): alternatives to the designer's design. None by
  default; the PM can ask for one or two, built by the usual engine in
  TAWD's own directions with the designer's brand and words. Paid, so the
  estimate shows with the choice and again before anything starts.
*/

export interface AlternativesCardProps {
  projectId: string;
  canRun: boolean;
  estimates: Record<1 | 2, { costLabel: string; minutes: number }>;
  limitBlocked: string | null;
  lastProblem: string | null;
}

const CHOICES = [
  { count: 0, label: "None" },
  { count: 1, label: "1 alternative" },
  { count: 2, label: "2 alternatives" },
] as const;

export function AlternativesCard(props: AlternativesCardProps) {
  const router = useRouter();
  const [count, setCount] = useState<0 | 1 | 2>(0);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const estimate = count === 0 ? null : props.estimates[count];
  const what = count === 1 ? "1 alternative" : `${count} alternatives`;

  return (
    <section className="card alternatives-card" aria-label="Alternatives">
      <div className="designer-design-head">
        <div className="design-copy-main">
          <p className="concept-card-title">Alternatives</p>
          <p className="hint">
            Optional: one or two other homepages for the client to compare with the designer&rsquo;s, built by the usual
            engine in TAWD&rsquo;s own directions, with the designer&rsquo;s logo, colours, fonts and words. They go on the
            concept board with the usual checks and Creative Director review.
          </p>
          {props.canRun ? (
            <div className="segmented alternatives-choice" role="group" aria-label="How many alternatives">
              {CHOICES.map((choice) => (
                <button
                  key={choice.count}
                  type="button"
                  className="segment"
                  aria-pressed={count === choice.count}
                  onClick={() => setCount(choice.count)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : null}
          <p className="hint">
            {estimate
              ? `${estimate.costLabel} of AI for ${what}, about ${estimate.minutes} minutes.${props.limitBlocked ? ` ${props.limitBlocked}` : ""}`
              : "None chosen: the client sees the designer's design, improved."}
          </p>
          {props.lastProblem ? <p className="hint-error">{props.lastProblem}</p> : null}
          {error ? <p className="hint-error">{error}</p> : null}
        </div>
        <div className="designer-design-actions">
          {props.canRun ? (
            <Button variant="primary" disabled={count === 0 || busy || Boolean(props.limitBlocked)} onClick={() => setConfirming(true)}>
              {count === 0 ? "Build alternatives" : `Build ${what}`}
            </Button>
          ) : null}
        </div>
      </div>

      {confirming && estimate ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="alternatives-title">
            <h2 className="section-title" id="alternatives-title">
              Build {what}?
            </h2>
            <p className="hint">
              Each is built, checked and reviewed like any concept, in its own direction, with the designer&rsquo;s brand
              and words and nothing invented.
            </p>
            <p className="hint">
              {estimate.costLabel} of AI, about {estimate.minutes} minutes.
            </p>
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
                    const result = await startAlternativesAction(props.projectId, count);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Build them"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
