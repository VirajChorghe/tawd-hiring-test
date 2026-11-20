"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { chooseLogoAction, startLogoDesignAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { LogoDesignView } from "@/lib/logo-design";

/*
  "Client has no logo: TAWD designs one" (26 September 2026): an original
  wordmark in the brand colours, one option on Starter, two on Growth,
  three on Pro. Paid AI with the estimate first. The option chosen becomes
  the logo the mockups use; the client approves it with them.
*/
export function LogoDesignPanel(props: { projectId: string; canEdit: boolean; view: LogoDesignView; saved: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const { view } = props;
  const working = view.status === "queued" || view.status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
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

  return (
    <div className="logo-design">
      <div className="logo-design-head">
        <div>
          <p className="logo-design-title">Logo by TAWD</p>
          <p className="hint">
            An original wordmark (the business name and a simple icon) in the brand colours, as SVG and PNG:{" "}
            {view.optionCount === 1 ? "one option" : `${view.optionCount} options`} for this tier. The chosen one is used in the
            mockups, so the client approves it with them.
          </p>
        </div>
        {props.canEdit && !working ? (
          <Button small variant={view.status === "done" ? "secondary" : "primary"} disabled={busy || !props.saved} onClick={() => setConfirming(true)}>
            {view.status === "done" ? "Design again" : "Design the logo"}
          </Button>
        ) : null}
      </div>
      {!props.saved ? <p className="hint content-warn">Save the Brand section first, so the logo uses the latest colours.</p> : null}
      {view.status !== "done" && !working ? <p className="hint">{view.estimateLine}</p> : null}
      {working ? (
        <div className="stop-line">
          <p className="hint content-warn">Designing... about a minute. This page refreshes itself.</p>
          {props.canEdit ? <StopButton projectId={props.projectId} kind="logo" what="the logo design" /> : null}
        </div>
      ) : null}
      {view.status === "failed" && view.failureReason ? <p className="hint-error">{view.failureReason}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {view.options.length ? (
        <ul className="logo-options">
          {view.options.map((option, index) => (
            <li key={option.name} className={view.chosenIndex === index ? "is-chosen" : undefined}>
              <div className="logo-option-picture">
                {option.png ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={option.png} alt={`Logo ${option.name.toLowerCase()}`} />
                ) : (
                  <span className="hint">Picture missing</span>
                )}
              </div>
              <div className="logo-option-foot">
                <span>{option.name}</span>
                {view.chosenIndex === index ? (
                  <span className="badge badge-done">In use</span>
                ) : props.canEdit ? (
                  <Button small disabled={busy} onClick={() => run(() => chooseLogoAction(props.projectId, view.designId!, index))}>
                    Use this logo
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="logo-title">
            <h2 className="section-title" id="logo-title">
              Design the logo?
            </h2>
            <p className="hint">
              {view.optionCount === 1 ? "One original logo" : `${view.optionCount} different original logos`} in the brand colours,
              with no slogans or claims. You choose the one the mockups use.
            </p>
            <p className="hint">{view.estimateLine}</p>
            <div className="modal-actions">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => startLogoDesignAction(props.projectId))}>
                {busy ? "Starting..." : "Design it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
