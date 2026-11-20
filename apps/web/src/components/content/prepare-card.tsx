"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { prepareContentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Prepare the content (0.100.0, flow redesign Part C): one consent for the
  paid parts (keyword research, then the plan, then the Home page's draft),
  with each step's cost, the total, the cheaper way and what comes back.
*/
export function PrepareContentCard(props: {
  projectId: string;
  canRun: boolean;
  research: { included: boolean; line: string; why: string | null; ticked?: boolean };
  planLine: string;
  /** Null when the home page is the supplied design: it keeps its own words, so there is no draft to pay for. */
  homeLine: string | null;
  total: string;
  cheaper: string;
  usable: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [keywords, setKeywords] = useState(props.research.ticked ?? props.research.included);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card content-card prepare-card" id="prepare">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Prepare the content</h2>
          <p className="hint">
            {props.homeLine
              ? "TAWD runs these in order by itself, the Home page first. You check the Home page, then the other pages are drafted together."
              : "TAWD runs these in order by itself. The home page keeps the supplied design's own words, so it is not drafted here and nothing is paid for it; the other pages are drafted together from the next step."}
          </p>
        </div>
      </div>
      <ol className="prepare-steps">
        {props.research.included || !props.research.why ? (
          <li className={props.research.included && !keywords ? "is-skipped" : undefined}>{props.research.line}</li>
        ) : (
          <li className="is-skipped">
            {props.research.line} {props.research.why}
          </li>
        )}
        <li>{props.planLine}</li>
        {props.homeLine ? <li>{props.homeLine}</li> : null}
      </ol>
      {props.research.included ? (
        <label className="checkline">
          <input type="checkbox" checked={keywords} disabled={!props.canRun || busy} onChange={(e) => setKeywords(e.target.checked)} />
          Include keyword research (real search numbers for the plan)
        </label>
      ) : null}
      {props.research.included && props.research.why && !keywords ? <p className="hint">{props.research.why}</p> : null}
      <p className="hint">{props.cheaper}</p>
      {error ? <p className="hint-error">{error}</p> : null}
      {props.canRun ? (
        <div className="money-row-actions">
          <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
            {props.homeLine ? "Prepare the content: Home page first" : "Prepare the content"}
          </Button>
          <span className="hint">{keywords && props.research.included ? props.total : (props.homeLine?.replace(/^The Home page's draft: /, "") ?? "")}</span>
        </div>
      ) : (
        <p className="hint">The content team, SEO or a PM starts it.</p>
      )}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="prepare-title">
            <h2 className="section-title" id="prepare-title">
              Prepare the content?
            </h2>
            <ol className="prepare-steps">
              {keywords && props.research.included ? <li>{props.research.line}</li> : null}
              <li>{props.planLine}</li>
              {props.homeLine ? <li>{props.homeLine}</li> : null}
            </ol>
            <p className="hint">{keywords && props.research.included ? props.total : ""} {props.usable}</p>
            {error ? <p className="hint-error">{error}</p> : null}
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
                    const result = await prepareContentAction(props.projectId, keywords && props.research.included);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setConfirming(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Start"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
