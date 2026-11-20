"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveInvoiceAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { formatWhen } from "@/lib/labels";

/*
  Updates (1 October 2026, DESIGN.md "Updates"): the month's invoice, for
  admins. It starts from the month's work, and every line is the admin's to
  enter or change: the team's hours and the amounts charged, never the AI's
  time or cost. Downloaded as a page to print or save as PDF, or as CSV.
*/

interface Line {
  date: string;
  task: string;
  category: string;
  hours: number;
  amountCents: number;
}

interface EditLine {
  date: string;
  task: string;
  category: string;
  hours: string;
  amount: string;
}

const toEdit = (l: Line): EditLine => ({ date: l.date, task: l.task, category: l.category, hours: String(l.hours), amount: (l.amountCents / 100).toFixed(2) });

function monthName(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function InvoiceCard({ projectId, month, months, saved, draft }: { projectId: string; clientName: string; month: string; months: string[]; saved: { lines: Line[]; updatedAt: string } | null; draft: Line[] }) {
  const router = useRouter();
  const [lines, setLines] = useState<EditLine[] | null>(saved ? saved.lines.map(toEdit) : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const total = (lines ?? []).reduce((n, l) => n + (Number(l.amount) || 0), 0);
  const set = (i: number, next: Partial<EditLine>) => setLines((all) => (all ?? []).map((l, n) => (n === i ? { ...l, ...next } : l)));

  return (
    <section className="card content-card" aria-labelledby="invoice-title">
      <div className="content-card-head">
        <div>
          <h2 className="card-title" id="invoice-title">
            Invoice: {monthName(month)}
          </h2>
          <p className="hint">Admins only. Each line is yours to enter or change: the hours and the amounts charged, never the AI&rsquo;s time or cost. No client logins: you send the file.</p>
        </div>
        <div className="money-row-actions">
          <label className="visually-hidden" htmlFor="invoice-month">
            Month
          </label>
          <select id="invoice-month" className="select" value={month} onChange={(e) => router.push(`/projects/${projectId}/updates?month=${e.target.value}#invoice-title`)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!lines ? (
        <>
          <p className="hint">{draft.length ? `Starts from the month's work: ${draft.length} line${draft.length === 1 ? "" : "s"} (logged time at $0 as included hours, approved quotes, the monthly plan).` : "No work logged this month yet. You can still start an invoice and add the lines."}</p>
          <Button variant="primary" onClick={() => setLines(draft.length ? draft.map(toEdit) : [{ date: `${month}-01`, task: "", category: "Plan", hours: "0", amount: "0.00" }])}>
            Prepare {monthName(month)}&rsquo;s invoice
          </Button>
        </>
      ) : (
        <>
          <table className="table invoice-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Task</th>
                <th>Category</th>
                <th>Hours</th>
                <th>Amount ($)</th>
                <th>
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input className="input" type="date" aria-label={`Line ${i + 1} date`} value={l.date} onChange={(e) => set(i, { date: e.target.value })} />
                  </td>
                  <td>
                    <input className="input" aria-label={`Line ${i + 1} task`} value={l.task} onChange={(e) => set(i, { task: e.target.value })} />
                  </td>
                  <td>
                    <input className="input" aria-label={`Line ${i + 1} category`} value={l.category} onChange={(e) => set(i, { category: e.target.value })} />
                  </td>
                  <td>
                    <input className="input" inputMode="decimal" aria-label={`Line ${i + 1} hours`} value={l.hours} onChange={(e) => set(i, { hours: e.target.value })} />
                  </td>
                  <td>
                    <input className="input" inputMode="decimal" aria-label={`Line ${i + 1} amount`} value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} />
                  </td>
                  <td>
                    <Button small variant="text" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((all) => (all ?? []).filter((_, n) => n !== i))}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="card-title">Total ${total.toFixed(2)}</p>
          {error ? <p className="hint-error">{error}</p> : null}
          <div className="money-row-actions edit-actions">
            <Button small onClick={() => setLines((all) => [...(all ?? []), { date: `${month}-01`, task: "", category: "", hours: "0", amount: "0.00" }])}>
              Add a line
            </Button>
            <Button
              small
              variant="primary"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await saveInvoiceAction(
                    projectId,
                    month,
                    lines.map((l) => ({ date: l.date, task: l.task, category: l.category, hours: Number(l.hours), amountCents: Math.round(Number(l.amount) * 100) })),
                  );
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  router.refresh();
                })
              }
            >
              {busy ? "Saving..." : "Save the invoice"}
            </Button>
            {saved ? (
              <>
                <a className="btn btn-secondary btn-small" href={`/projects/${projectId}/updates/invoice/${month}`} target="_blank" rel="noreferrer">
                  Open to print or save as PDF
                </a>
                <a className="btn btn-secondary btn-small" href={`/projects/${projectId}/updates/invoice/${month}/csv`} download>
                  Download CSV
                </a>
              </>
            ) : null}
          </div>
          {saved ? <p className="hint">Saved {formatWhen(new Date(saved.updatedAt))}. Save again after any change; the downloads show the saved invoice.</p> : <p className="hint">Save it to download it.</p>}
        </>
      )}
    </section>
  );
}
