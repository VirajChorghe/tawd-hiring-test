"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { resumeProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Resume project (29 September 2026, DESIGN.md "Resume project"): on a
  paused project's Next step card, for PMs and admins. Back to the stage
  it was paused at; logged with the note.
*/

export function ResumeProjectButton({ projectId, clientName, stageLabel, known }: { projectId: string; clientName: string; stageLabel: string; known: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Resume project
      </Button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onClick={() => !busy && setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="resume-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="resume-title" className="section-title">
              Resume {clientName}?
            </h2>
            <p className="hint">
              {known
                ? `It goes back to ${stageLabel}, where it was when it was paused.`
                : `TAWD can't tell where it was when it was paused, so it goes back to ${stageLabel}. The team can move it on from there.`}
            </p>
            <div className="field">
              <label className="field-label" htmlFor="resume-note">
                <span>Note</span>
                <span className="field-optional">Optional</span>
              </label>
              <textarea id="resume-note" className="textarea" value={note} placeholder="For example: the client paid the invoice." onChange={(e) => setNote(e.target.value)} />
              <p className="hint">Recorded in the activity log with your name and the time.</p>
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await resumeProjectAction(projectId, note || null);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Resuming..." : "Resume project"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
