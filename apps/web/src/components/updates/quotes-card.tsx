"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { recordQuoteAnswerAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Updates (1 October 2026, DESIGN.md "Updates"): the quotes. Priced from the
  Pricing page only; downloaded for the client; their answer recorded before
  any work starts.
*/

export interface QuoteRow {
  id: string;
  request: string;
  requestedOn: string;
  status: string;
  lines: { label: string; quantity: number; unitCents: number | null; amountCents: number | null }[];
  totalCents: number | null;
  decisionLine: string | null;
  createdAt: string;
}

const money = (cents: number | null) => (cents === null ? "Price not set" : `$${(cents / 100).toFixed(2)}`);
const STATE: Record<string, { label: string; tone: string }> = {
  waiting: { label: "Waiting on the client", tone: "badge badge-warning" },
  approved: { label: "Approved", tone: "badge badge-done" },
  declined: { label: "Declined", tone: "badge badge-missing" },
};

export function QuotesCard({ projectId, canAnswer, channels, quotes }: { projectId: string; canAnswer: boolean; channels: string[]; quotes: QuoteRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<QuoteRow | null>(null);
  const [answer, setAnswer] = useState({ outcome: "approved" as "approved" | "declined", channel: channels[0] ?? "phone call", clientSaid: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <section className="card content-card" aria-labelledby="quotes-title">
      <h2 className="card-title" id="quotes-title">
        Quotes
      </h2>
      <p className="hint">Priced from the Pricing page. Work starts only after the client approves.</p>
      {quotes.length === 0 ? <p className="hint">No quotes yet. A new page, a redesign, or hours over the plan become one when the request is logged.</p> : null}
      <ul className="edit-list">
        {quotes.map((q) => (
          <li key={q.id}>
            <div className="edit-head">
              <span className={STATE[q.status]?.tone ?? "badge badge-info"}>{STATE[q.status]?.label ?? q.status}</span>
              <p className="edit-words">&ldquo;{q.request}&rdquo;</p>
            </div>
            <ul className="hint" style={{ margin: "6px 0", paddingLeft: 18 }}>
              {q.lines.map((l) => (
                <li key={l.label}>
                  {l.label}
                  {l.quantity !== 1 ? ` × ${l.quantity}` : ""}: {l.amountCents === null ? <span className="content-warn">price not set (an admin sets it on Pricing)</span> : money(l.amountCents)}
                </li>
              ))}
            </ul>
            <p className="card-title">Total {money(q.totalCents)}</p>
            {q.decisionLine ? <p className="hint">{q.decisionLine}</p> : null}
            <div className="money-row-actions edit-actions">
              <a className="btn btn-secondary btn-small" href={`/projects/${projectId}/updates/quote/${q.id}`} target="_blank" rel="noreferrer">
                Download the quote
              </a>
              {canAnswer && q.status === "waiting" ? (
                <Button
                  small
                  variant="primary"
                  onClick={() => {
                    setError(null);
                    setOpen(q);
                  }}
                >
                  Record the client&rsquo;s answer
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="quote-answer-title">
            <h2 className="section-title" id="quote-answer-title">
              The client&rsquo;s answer
            </h2>
            <p className="hint">
              &ldquo;{open.request}&rdquo;: {money(open.totalCents)}. Approved, the work can start and it goes on the month&rsquo;s invoice. Declined, the request is closed.
            </p>
            <fieldset className="field">
              <legend className="field-label">
                <span>Their answer</span>
              </legend>
              <label className="radio-line">
                <input type="radio" name="quote-outcome" checked={answer.outcome === "approved"} onChange={() => setAnswer((a) => ({ ...a, outcome: "approved" }))} />
                Approved
              </label>
              <label className="radio-line">
                <input type="radio" name="quote-outcome" checked={answer.outcome === "declined"} onChange={() => setAnswer((a) => ({ ...a, outcome: "declined" }))} />
                Declined
              </label>
            </fieldset>
            <div className="field">
              <label className="field-label" htmlFor="quote-channel">
                <span>How it came in</span>
              </label>
              <select id="quote-channel" className="select" value={answer.channel} onChange={(e) => setAnswer((a) => ({ ...a, channel: e.target.value }))}>
                {channels.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="quote-said">
                <span>What they said</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="quote-said" className="textarea" rows={3} value={answer.clientSaid} onChange={(e) => setAnswer((a) => ({ ...a, clientSaid: e.target.value }))} />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || answer.clientSaid.trim().length < 3}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await recordQuoteAnswerAction(projectId, open.id, answer);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(null);
                    router.refresh();
                  })
                }
              >
                {busy ? "Saving..." : "Record the answer"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
