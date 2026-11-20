"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { stopWorkAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Stop (Jason, 28 September 2026): on every running job. What's finished is
  kept; the job running ends before its next AI call; anything of the same
  kind still waiting doesn't start. Logged.
*/
export function StopButton({ projectId, kind, copyId, label = "Stop", what }: { projectId: string; kind: string; copyId?: string; label?: string; what: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const id = `stop-${kind}-${copyId ?? "all"}`;

  return (
    <>
      <Button small variant="danger" onClick={() => setOpen(true)} disabled={busy}>
        {label}
      </Button>
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
            <h2 className="section-title" id={`${id}-title`}>
              Stop {what}?
            </h2>
            <p className="hint">
              Whatever is finished is kept. The part running now ends before its next AI call, so nothing more is spent, and anything still waiting doesn&rsquo;t start. It&rsquo;s
              recorded in the activity log. You can start again later.
            </p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                Keep going
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await stopWorkAction(projectId, kind, copyId ?? null);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Stopping..." : "Stop"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
