"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { markLawCheckedAction, recordPrivacyReviewAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/* One rule, checked against its official source today. */
export function PrivacyLawActions({ lawKey }: { lawKey: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="privacy-law-action">
      <Button
        small
        variant="text"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const result = await markLawCheckedAction(lawKey);
            setError(result.ok ? null : result.message);
            router.refresh();
          })
        }
      >
        Checked today
      </Button>
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

/* The quarterly "Review privacy laws": every rule checked, with a note of what was checked. */
export function PrivacyReview() {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        Review privacy laws
      </Button>
    );
  }
  return (
    <div className="privacy-review-form">
      <label className="field-label" htmlFor="privacy-review-note">
        What was checked
      </label>
      <textarea id="privacy-review-note" className="input" rows={2} value={note} placeholder="For example: every rule's source opened; Oregon's thresholds changed, docs/policies updated." onChange={(e) => setNote(e.target.value)} />
      {error ? <p className="hint-error">{error}</p> : null}
      <div className="modal-actions">
        <Button onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || note.trim().length < 3}
          onClick={() =>
            start(async () => {
              const result = await recordPrivacyReviewAction(note);
              if (!result.ok) setError(result.message);
              else setOpen(false);
              router.refresh();
            })
          }
        >
          Record the review
        </Button>
      </div>
    </div>
  );
}
