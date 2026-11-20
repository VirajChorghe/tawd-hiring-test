"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { rerunReviewAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  "Run the review again": only the concepts whose review is missing, from
  where each stopped, and never a rebuild. It says which and what it costs
  before anything is spent.
*/
export function RerunReviewButton({
  projectId,
  runId,
  concepts,
  estimate,
  defaultOpen = false,
}: {
  projectId: string;
  runId: string;
  concepts: string[];
  estimate: string;
  /** Open on arrival; used for screenshots of the confirmation. */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const which = `Concept ${concepts.join(" and ")}`;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Run the review again
      </Button>
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rerun-title">
            <h2 className="section-title" id="rerun-title">
              Run the review again for {which}?
            </h2>
            <p className="hint">
              The Creative Director reviews only {concepts.length === 1 ? "this concept" : "these concepts"}, picking up
              where {concepts.length === 1 ? "it" : "each"} stopped. Reviews that already finished are kept, and nothing is
              built again: a concept still under 3 afterwards is flagged for the PM instead of rebuilt.
            </p>
            <p className="hint">
              First, at no cost, it reads again any review answer already paid for and runs the checks again. It only pays
              for a new review if that is not enough.
            </p>
            <p className="hint">{estimate}.</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  startBusy(async () => {
                    setError(null);
                    const result = await rerunReviewAction(projectId, runId);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Run the review again"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
