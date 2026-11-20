"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { replayCopyAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Replay (Jason, 28 September 2026), admins only: build this page's copy
  again from its saved AI answers with today's code. Nothing is sent to
  Anthropic and nothing is spent, so a fix can be tried on a client's real
  data first; the new copy says it is a replay.
*/
export function ReplayCopyButton({ projectId, copyId, pageName, startOpen = false }: { projectId: string; copyId: string; pageName: string; startOpen?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const id = `replay-${copyId}`;

  return (
    <>
      <Button small onClick={() => setOpen(true)}>
        Replay on saved answers ($0)
      </Button>
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
            <h2 className="section-title" id={`${id}-title`}>
              Replay the {pageName} copy for $0?
            </h2>
            <p className="hint">
              TAWD builds this page again with today&rsquo;s code, using the AI answers saved from this copy instead of asking the AI again. Nothing is sent to
              Anthropic and nothing is spent. The replay becomes the page&rsquo;s newest copy, marked as a replay; this one stays in the history.
            </p>
            <p className="hint">If the code now asks for something the saved answers don&rsquo;t have, the replay stops and says so, still at $0.</p>
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
                    const result = await replayCopyAction(projectId, copyId);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.push(`/projects/${projectId}/mockups/design/copy?copy=${result.copyId}`);
                  })
                }
              >
                {busy ? "Starting..." : "Replay for $0"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
