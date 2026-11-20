"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { StopButton } from "@/components/ui/stop-button";

/*
  A small paid AI step (27 September 2026: the reference study, the photo
  text check, the critique and polish): the estimate on the button's line,
  a confirmation dialog with it before anything is spent, and the page
  refreshing itself while the step works.
*/
export function PaidStepButton(props: {
  id: string;
  label: string;
  confirmTitle: string;
  confirmText: string;
  estimateLine: string;
  working: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  run: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** While working, a Stop button for this kind of work (28 September 2026). */
  stop?: { projectId: string; kind: string; what: string };
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (!props.working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [props.working, router]);

  return (
    <>
      <Button small variant={props.variant ?? "secondary"} disabled={busy || props.working || props.disabled} onClick={() => setConfirming(true)}>
        {props.working ? "Working..." : props.label}
      </Button>
      {props.working && props.stop ? <StopButton projectId={props.stop.projectId} kind={props.stop.kind} what={props.stop.what} /> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${props.id}-title`}>
            <h2 className="section-title" id={`${props.id}-title`}>
              {props.confirmTitle}
            </h2>
            <p className="hint">{props.confirmText}</p>
            <p className="hint">{props.estimateLine}</p>
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
                    const result = await props.run();
                    if (!result.ok) setError(result.message);
                    setConfirming(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : props.label}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
