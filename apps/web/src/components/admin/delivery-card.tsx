"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { checkAllSitesAction, saveInboxesAction, sendLabTestAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export interface DeliveryCardProps {
  configured: boolean;
  inboxesText: string;
  inboxes: { address: string; provider: string; status: string | null; line: string | null }[];
  lastRunLine: string | null;
  sites: { projectId: string; clientName: string; domain: string; status: string | null; line: string | null }[];
}

const INBOX_BADGE: Record<string, { cls: string; text: string }> = {
  inbox: { cls: "badge badge-done", text: "Inbox" },
  spam: { cls: "badge badge-warning", text: "Spam" },
  bounced: { cls: "badge badge-missing", text: "Bounced" },
  failed: { cls: "badge badge-missing", text: "Not sent" },
  sent: { cls: "badge badge-info", text: "No answer yet" },
};

const SITE_BADGE: Record<string, { cls: string; text: string }> = {
  received: { cls: "badge badge-done", text: "Working" },
  sent: { cls: "badge badge-info", text: "Checking" },
  missing: { cls: "badge badge-missing", text: "Not arriving" },
  failed: { cls: "badge badge-missing", text: "Not arriving" },
};

/*
  F4 (1 October 2026): the test inboxes at the common providers and where
  TAWD's monthly test landed, and the weekly check of each live site's form.
*/
export function DeliveryCard(props: DeliveryCardProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [text, setText] = useState(props.inboxesText);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: boolean; message?: string }>, done: string) =>
    start(async () => {
      setError(null);
      setNote(null);
      const r = await work();
      if (!r.ok) setError(r.message ?? "It didn't work.");
      else setNote(done);
      router.refresh();
    });

  return (
    <div className="card content-card">
      <h3 className="card-title">Test inboxes</h3>
      <p className="hint">One inbox at each provider our clients use. TAWD emails them all once a month (and when you press the button); whoever checks the inbox clicks where it landed.</p>
      {error ? <p className="hint-error">{error}</p> : null}
      {note ? <p className="hint">{note}</p> : null}
      <textarea className="textarea" rows={6} aria-label="Test inboxes, one per line: address, provider" placeholder={"vml.test@gmail.com, Gmail\nvml.test@outlook.com, Outlook.com"} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <Button small variant="secondary" disabled={busy || text === props.inboxesText} onClick={() => run(() => saveInboxesAction(text), "Saved.")}>
          Save the inboxes
        </Button>
      </div>
      <p className="hint">Postmark sends to any address once VML&rsquo;s account is approved.</p>

      {props.inboxes.length ? (
        <table className="connect-records">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Address</th>
              <th>Last result</th>
            </tr>
          </thead>
          <tbody>
            {props.inboxes.map((i) => (
              <tr key={i.address}>
                <td>{i.provider}</td>
                <td>{i.address}</td>
                <td>
                  {i.status ? <span className={(INBOX_BADGE[i.status] ?? INBOX_BADGE.sent!).cls}>{(INBOX_BADGE[i.status] ?? INBOX_BADGE.sent!).text}</span> : <span className="badge badge-info">Not tested</span>}
                  {i.line ? <span className="hint"> {i.line}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="row">
        <Button small variant="primary" disabled={busy || !props.configured || props.inboxes.length === 0} onClick={() => run(sendLabTestAction, `Sent to ${props.inboxes.length} inbox${props.inboxes.length === 1 ? "" : "es"}.`)}>
          Send the delivery test now
        </Button>
      </div>
      <p className="hint">{props.lastRunLine ?? "Not sent yet."} Next automatically on the 1st of the month.</p>

      <h3 className="card-title">Each live site&rsquo;s form</h3>
      <p className="hint">Every week TAWD fills in each live site&rsquo;s form, marked as a test, and checks the message reaches TAWD. The client isn&rsquo;t emailed.</p>
      {props.sites.length ? (
        <ul className="seo-checks seo-checks-states">
          {props.sites.map((s) => {
            const badge = s.status ? (SITE_BADGE[s.status] ?? SITE_BADGE.sent!) : { cls: "badge badge-info", text: "Not checked yet" };
            return (
              <li key={s.projectId}>
                <span className={badge.cls}>{badge.text}</span>
                <div>
                  <p className="seo-check-label">
                    {s.clientName} <span className="hint">{s.domain}</span>
                  </p>
                  {s.line ? <p className="hint">{s.line}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="hint">No live sites yet.</p>
      )}
      <div className="row">
        <Button small variant="secondary" disabled={busy || !props.configured || props.sites.length === 0} onClick={() => run(checkAllSitesAction, "Checking every live site's form: results within a few minutes.")}>
          Check all now
        </Button>
      </div>
    </div>
  );
}
