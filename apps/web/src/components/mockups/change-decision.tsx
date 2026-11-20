"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { setChangeDecisionAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Lane 2, Option B, 4c-2: the designer's answer to one tracked change.
  The Web Designer or an admin clicks Accept or Push back, with an
  optional note; it saves at once and is logged. Anyone else sees the
  answer. The same button again clears it.
*/

export interface ChangeDecisionProps {
  projectId: string;
  number: number;
  decision: "accepted" | "pushed_back" | null;
  note: string | null;
  decidedBy: string | null;
  decidedWhen: string | null;
  canDecide: boolean;
}

export function ChangeDecision(props: ChangeDecisionProps) {
  const router = useRouter();
  const [note, setNote] = useState(props.note ?? "");
  // The note shows in the answer above; the box opens only to write or change it.
  const [showNote, setShowNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const save = (decision: "accepted" | "pushed_back" | null) =>
    start(async () => {
      setError(null);
      const result = await setChangeDecisionAction(props.projectId, props.number, decision, note);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });

  const said =
    props.decision === "accepted"
      ? `Accepted${props.decidedBy ? ` by ${props.decidedBy}` : ""}`
      : props.decision === "pushed_back"
        ? `Pushed back${props.decidedBy ? ` by ${props.decidedBy}` : ""}`
        : "Waiting for the designer's decision";

  return (
    <div className={`change-decision is-${props.decision ?? "open"}`}>
      <div className="change-decision-row">
        <p className="change-decision-status">
          {said}
          {props.decision && props.decidedWhen ? <span className="hint">, {props.decidedWhen}</span> : null}
          {props.decision && props.note ? <span className="change-decision-note">&ldquo;{props.note}&rdquo;</span> : null}
        </p>
        {props.canDecide ? (
          <div className="segmented change-decision-buttons" role="group" aria-label={`Change ${props.number}`}>
            <button
              type="button"
              className="segment"
              aria-pressed={props.decision === "accepted"}
              disabled={busy}
              onClick={() => save(props.decision === "accepted" ? null : "accepted")}
            >
              Accept
            </button>
            <button
              type="button"
              className="segment"
              aria-pressed={props.decision === "pushed_back"}
              disabled={busy}
              onClick={() => {
                setShowNote(true);
                save(props.decision === "pushed_back" ? null : "pushed_back");
              }}
            >
              Push back
            </button>
          </div>
        ) : null}
      </div>
      {props.canDecide ? (
        showNote ? (
          <div className="change-decision-note-edit">
            <textarea
              className="input"
              rows={2}
              value={note}
              placeholder="A note for the team (optional): why, or what the designer would do instead"
              aria-label={`Note on change ${props.number}`}
              onChange={(event) => setNote(event.target.value)}
            />
            {props.decision && note.trim() !== (props.note ?? "") ? (
              <Button small variant="secondary" disabled={busy} onClick={() => save(props.decision)}>
                Save the note
              </Button>
            ) : null}
          </div>
        ) : (
          <button type="button" className="btn btn-text btn-inline change-decision-add-note" onClick={() => setShowNote(true)}>
            {props.note ? "Change the note" : "Add a note"}
          </button>
        )
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}
