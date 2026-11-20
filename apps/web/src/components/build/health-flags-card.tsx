"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { confirmHealthFlagAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Health and beauty rules on the Build page (26 September 2026): each flag
  on the newest build, to fix (build again) or confirm with the client. A
  confirmation is logged with the PM's name, the time and a note.
*/

export interface HealthFlagRow {
  id: string;
  rule: string;
  found: string;
  /** "Confirmed with the client by Sam, when: note", or null while open. */
  confirmedLine: string | null;
}

export function HealthFlagsCard(props: { projectId: string; version: number; flags: HealthFlagRow[]; canConfirm: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<HealthFlagRow | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const open = props.flags.filter((f) => !f.confirmedLine).length;

  return (
    <div className="card content-card">
      <div>
        <h2 className="card-title">Health and beauty rules</h2>
        <p className="hint">
          No promised results, titles only as the client gives them, before-and-after photos only with their permission,
          testimonials only when they supplied them. Before go-live each flag is fixed (it&rsquo;s gone from a new build) or
          confirmed with the client.
        </p>
      </div>
      <p className={open ? "hint content-warn" : "content-done-line"}>
        {props.flags.length === 0
          ? `Version ${props.version}: nothing flagged.`
          : open
            ? `Version ${props.version}: ${open} of ${props.flags.length} still to fix or confirm.`
            : `Version ${props.version}: all ${props.flags.length} confirmed with the client.`}
      </p>
      {props.flags.length ? (
        <ul className="seo-checks seo-checks-wide">
          {props.flags.map((f) => (
            <li key={f.id}>
              <span className={f.confirmedLine ? "badge badge-done" : "badge badge-missing"}>{f.confirmedLine ? "Confirmed" : "To resolve"}</span>
              <div>
                <p className="seo-check-label">
                  {f.rule}: &ldquo;{f.found}&rdquo;
                </p>
                <p className="hint">{f.confirmedLine ?? "Fix it in a monthly edit or the copy and build again, or confirm it with the client."}</p>
                {!f.confirmedLine && props.canConfirm ? (
                  <div style={{ marginTop: 8 }}>
                    <Button small disabled={busy} onClick={() => setConfirming(f)}>
                      Confirmed with the client
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="health-confirm-title">
            <h2 className="section-title" id="health-confirm-title">
              Confirmed with the client?
            </h2>
            <p className="hint">
              {confirming.rule}: &ldquo;{confirming.found}&rdquo;. Recorded with your name and the time; the site can go live with it.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="health-note">
                <span>How the client confirmed it</span>
              </label>
              <textarea id="health-note" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: Dr. Lee's title checked with the owner by phone, 26 September." />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || note.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await confirmHealthFlagAction(props.projectId, confirming.id, note);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setConfirming(null);
                    setNote("");
                    router.refresh();
                  })
                }
              >
                {busy ? "Saving..." : "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
