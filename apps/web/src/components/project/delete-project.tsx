"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteProjectAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  The danger area at the foot of the project page. Admins only; the page
  decides whether to render it and the server decides again.

  Two deliberate frictions in the dialog: the project name has to be typed
  exactly, and a reason is required. Both are checked on the server too;
  the disabled button here is a convenience, not the rule.
*/

const MIN_REASON = 10;

export function DeleteProjectArea({
  projectId,
  clientName,
  blocker,
}: {
  projectId: string;
  clientName: string;
  /** Why it cannot be deleted right now, such as being live. */
  blocker: string | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="danger-area" aria-labelledby="danger-title">
      <div>
        <h2 id="danger-title" className="card-title">
          Delete project
        </h2>
        <p className="hint">
          Permanently removes this project, its intake, concepts and versions,
          and every file in storage: logo, photos, documents, mockup images
          and HTML, the built site, and its preview site on Netlify. The
          activity log keeps its history. This cannot be undone.
        </p>
        {blocker ? (
          <p className="hint-missing" style={{ marginTop: 8 }}>
            {blocker}
          </p>
        ) : null}
      </div>
      <Button
        variant="danger"
        disabled={blocker !== null}
        onClick={() => setOpen(true)}
      >
        Delete project
      </Button>

      {open ? (
        <DeleteDialog
          projectId={projectId}
          clientName={clientName}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}

export function DeleteDialog({
  projectId,
  clientName,
  onCancel,
}: {
  projectId: string;
  clientName: string;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startDeleting] = useTransition();

  const nameMatches = typed.trim() === clientName;
  const reasonOk = reason.trim().length >= MIN_REASON;

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="delete-title" className="section-title">
          Delete {clientName}?
        </h2>
        <p className="hint">
          Everything for this project is removed from TAWD and from storage.
          The activity log keeps every entry and records this deletion with
          your name, the time and your reason. AI costs are kept for
          accounting.
        </p>

        <div className="field">
          <label className="field-label" htmlFor="delete-confirm-name">
            <span>
              Type <strong>{clientName}</strong> to confirm
            </span>
            <span className="field-required">Required</span>
          </label>
          <input
            id="delete-confirm-name"
            className="input"
            value={typed}
            autoComplete="off"
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="delete-reason">
            <span>Reason</span>
            <span className="field-required">Required</span>
          </label>
          <textarea
            id="delete-reason"
            className="textarea"
            value={reason}
            placeholder="For example: duplicate created by mistake; the real project is Pat Rivera Pump & Well."
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="hint">At least {MIN_REASON} characters. Recorded in the activity log.</p>
        </div>

        {error ? <p className="hint-error">{error}</p> : null}

        {/*
          Deleting a large project takes a while (Jason, 10 November 2026: he
          tried it on two projects and "the screen just froze", then found
          they had in fact been deleted). Every file the project stored in R2
          is removed one by one - mockup renders, screenshots, the built site
          - so a big project can take a minute with nothing to look at. The
          button said "Deleting..." and nothing else said anything at all.
        */}
        {busy ? (
          <p className="hint" role="status" aria-live="polite">
            Deleting the project and every file it stored: its mockups, renders and built pages. A large project can take a minute. This screen goes to
            Projects by itself when it is done &mdash; please don&rsquo;t close the tab.
          </p>
        ) : null}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!nameMatches || !reasonOk || busy}
            onClick={() => {
              setError(null);
              startDeleting(async () => {
                const result = await deleteProjectAction(projectId, typed, reason);
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                // Say it worked on the screen it lands on (Jason, 10 November 2026).
                router.push("/projects?deleted=1");
                router.refresh();
              });
            }}
          >
            {busy ? "Deleting..." : "Delete project permanently"}
          </Button>
        </div>
      </div>
    </div>
  );
}
