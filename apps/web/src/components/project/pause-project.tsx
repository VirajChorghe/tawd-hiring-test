"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { pauseProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Pause project (30 September 2026, DESIGN.md "Pause project"): on the
  project page's Settings tab. A required reason, logged; Resume is on the
  Overview's Next step card.
*/

export function PauseProjectCard({ projectId, clientName, canPause, minReason }: { projectId: string; clientName: string; canPause: boolean; minReason: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const ready = reason.trim().length >= minReason;

  return (
    <section className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Pause the project</h2>
          <p className="hint">Nothing moves while it is paused: the stages lock, and anything already running finishes. Resume it from the Overview.</p>
          {canPause ? null : <p className="hint">A PM or an admin can pause it.</p>}
        </div>
        {canPause ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Pause project
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !busy && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pause-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="pause-title" className="section-title">
              Pause {clientName}?
            </h2>
            <p className="hint">The stages lock until a PM or an admin resumes it. Work already running finishes; nothing new starts. It goes back to where it is now when resumed.</p>
            <div className="field">
              <label className="field-label" htmlFor="pause-reason">
                <span>Reason</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="pause-reason" className="textarea" value={reason} placeholder="For example: waiting for the client's deposit." onChange={(e) => setReason(e.target.value)} />
              <p className="hint">Recorded in the activity log with your name and the time.</p>
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !ready}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await pauseProjectAction(projectId, reason);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.push(`/projects/${projectId}`);
                    router.refresh();
                  })
                }
              >
                {busy ? "Pausing..." : "Pause project"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
