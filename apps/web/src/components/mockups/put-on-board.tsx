"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { putDesignOnBoardAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  "Put on the board as Concept 1": the final version of the designer's
  design becomes a real concept (in the client pack, open to comments and
  Request changes, a possible pick for the client). No AI. Once there, the
  button updates Concept 1 when there is a newer final version.
*/

export function PutOnBoard(props: {
  projectId: string;
  canAct: boolean;
  /** Which version would go: "the version with the designer's decisions" or "the improved design". */
  source: string;
  onBoard: { conceptId: string; version: number } | null;
  /** A newer final version exists than the one on the board. */
  newer: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="put-on-board">
      {props.onBoard ? (
        <p className="hint">
          On the board as{" "}
          <Link href={`/projects/${props.projectId}/mockups/${props.onBoard.conceptId}`}>Concept 1 (v{props.onBoard.version})</Link>
          {props.newer ? "; a newer final version exists." : "."}
        </p>
      ) : null}
      {props.canAct && (!props.onBoard || props.newer) ? (
        <Button variant={props.onBoard ? "secondary" : "primary"} disabled={busy} onClick={() => setConfirming(true)}>
          {props.onBoard ? "Update Concept 1" : "Put on the board as Concept 1"}
        </Button>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="on-board-title">
            <h2 className="section-title" id="on-board-title">
              {props.onBoard ? "Update Concept 1?" : "Put it on the board as Concept 1?"}
            </h2>
            <p className="hint">
              {props.source.charAt(0).toUpperCase() + props.source.slice(1)} becomes{" "}
              {props.onBoard ? `Concept 1's version ${props.onBoard.version + 1}` : "Concept 1"} on the concept board: in the
              client pack, open to comments and Request changes, and a possible pick for the client. Free: no AI.
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
                    const result = await putDesignOnBoardAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Putting it on..." : props.onBoard ? "Update it" : "Put it on the board"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
