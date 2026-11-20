"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { acceptCopyAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Accept a copy as it is (Jason, 28 September 2026): for the PM, the
  designer or an admin, when some sections still differ after the rebuild
  and the copy is good enough (or the difference is in the design file
  itself). A note of why is optional; it is logged and shown on the copy.
*/
export function AcceptCopyButton({ projectId, copyId, pageName, startOpen = false }: { projectId: string; copyId: string; pageName: string; startOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const id = `accept-${copyId}`;

  return (
    <>
      <Button small onClick={() => setOpen(true)}>
        Accept this copy as it is
      </Button>
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
            <h2 className="section-title" id={`${id}-title`}>
              Accept the {pageName} copy as it is?
            </h2>
            <p className="hint">
              Some sections still differ from the design after the rebuild. Accepting it counts the page as copied, so the approval and the build can go ahead. Nothing is
              rebuilt and nothing is spent.
            </p>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-note`}>
                <span>Why it&rsquo;s fine as it is</span>
                <span className="field-optional">Optional</span>
              </label>
              <textarea id={`${id}-note`} className="textarea" rows={3} maxLength={1000} placeholder="For example: the gap is in the PDF itself; the client has seen it." value={note} onChange={(e) => setNote(e.target.value)} />
              <p className="hint">Recorded in the activity log with your name and shown on the copy.</p>
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await acceptCopyAction(projectId, copyId, note);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Saving..." : "Accept as it is"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
