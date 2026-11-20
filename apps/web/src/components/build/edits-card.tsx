"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { closeEditRequestAction, logDevTimeAction, logUpdateRequestAction, previewUpdateRequestAction, rebuildWithEditAction, startEditAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Build A, 8c: the monthly edits, on Updates since 1 October 2026 (DESIGN.md
  "Updates"). Every request the client makes is logged with a category and
  an hours estimate; one that needs a quote says so before it's saved. An
  edit is made by AI page by page (estimate first), shown as tracked
  changes, then put into the site. The team's time goes against the
  included hours of the project's tier.
*/

export interface EditRow {
  id: string;
  kind: "edit" | "quote";
  status: string;
  statusLabel: string;
  requestedOn: string;
  clientWords: string;
  teamNote: string;
  pageNames: string[];
  categoryLabel: string;
  estimate: string;
  time: string;
  aiCost: string;
  estimateLine: string;
  failure: string | null;
  changes: { name: string; removed: string[]; added: string[]; changed: boolean }[];
}

type Result = { ok: true } | { ok: false; message: string };

export function EditsCard(props: {
  projectId: string;
  canEdit: boolean;
  hoursLine: string;
  over: boolean;
  hasBuild: boolean;
  /** The built site's pages (every lane). */
  pages: { id: string; name: string }[];
  requests: EditRow[];
  today: string;
  /** The month against the tier's included hours. */
  month: { line: string; usedMinutes: number; plannedMinutes: number; included: number };
  categories: { key: string; label: string }[];
  /** The AI edit (Lane 1). Lane 2's design-built sites are edited by hand for now. */
  canMakeAi: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ kind: "request" } | { kind: "time"; requestId: string | null } | { kind: "edit"; row: EditRow } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [request, setRequest] = useState({ clientWords: "", teamNote: "", requestedOn: props.today, pageIds: [] as string[], category: "", redesign: false, estimateHours: "" });
  const [quote, setQuote] = useState<{ reason: string | null; lines: { label: string; quantity: number; amountCents: number | null }[]; total: number | null } | null>(null);
  const [time, setTime] = useState({ minutes: "30", note: "", workedOn: props.today });
  const working = props.requests.some((r) => r.status === "queued" || r.status === "editing");

  // Whether this request would become a quote, and why: asked of the server as the category and estimate change.
  useEffect(() => {
    if (dialog?.kind !== "request" || !request.category || !request.estimateHours) return;
    let live = true;
    const timer = window.setTimeout(async () => {
      const result = await previewUpdateRequestAction(props.projectId, { category: request.category, redesign: request.redesign, estimateHours: request.estimateHours });
      if (live) setQuote(result && result.need.quote ? { reason: result.need.reason, lines: result.lines, total: result.total } : null);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [dialog?.kind, request.category, request.redesign, request.estimateHours, props.projectId]);

  // Shown only while the dialog has what the check needs.
  const shownQuote = dialog?.kind === "request" && request.category && request.estimateHours ? quote : null;

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const run = (action: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDialog(null);
      router.refresh();
    });

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">{props.month.line}</h2>
          <p className={props.over ? "hint content-warn" : "hint"}>
            {props.hoursLine}. Planned on open requests: {hours(props.month.plannedMinutes)} hours. Anything over the included hours, and every new page or redesign, becomes a quote the client approves first.
          </p>
          <div className="hours-meter" role="img" aria-label={`${hours(props.month.usedMinutes)} hours done and ${hours(props.month.plannedMinutes)} planned, of ${props.month.included} included`}>
            <i style={{ width: `${share(props.month.usedMinutes, props.month.included)}%` }} />
            <em style={{ width: `${Math.max(0, Math.min(100 - share(props.month.usedMinutes, props.month.included), share(props.month.plannedMinutes, props.month.included)))}%` }} />
          </div>
          <p className="hint hours-legend">
            <span className="is-done">Done</span> <span className="is-planned">Planned</span> <span className="is-left">Left</span>
          </p>
          {working && props.canEdit ? (
            <div className="stop-line">
              <p className="hint content-warn">An edit is being made. This page refreshes itself.</p>
              <StopButton projectId={props.projectId} kind="site_edit" what="the edits" />
            </div>
          ) : null}
        </div>
        {props.canEdit ? (
          <div className="money-row-actions">
            <Button small onClick={() => setDialog({ kind: "time", requestId: null })}>
              Log time
            </Button>
            <Button variant="primary" small onClick={() => setDialog({ kind: "request" })}>
              Log a request
            </Button>
          </div>
        ) : null}
      </div>
      {error && !dialog ? <p className="hint-error">{error}</p> : null}

      {props.requests.length === 0 ? <p className="hint">No requests yet.</p> : null}
      {!props.canMakeAi ? <p className="hint">Sites built from the client&rsquo;s design are updated by hand for now: make the change, log the time, then mark it done.</p> : null}
      <ul className="edit-list" id="requests">
        {props.requests.map((r) => (
          <li key={r.id}>
            <div className="edit-head">
              <span className={r.kind === "quote" ? "badge badge-info" : r.status === "done" ? "badge badge-done" : r.status === "failed" || r.status === "declined" ? "badge badge-missing" : "badge badge-warning"}>{r.statusLabel}</span>
              <span className="badge badge-info">{r.categoryLabel}</span>
              <p className="edit-words">&ldquo;{r.clientWords}&rdquo;</p>
            </div>
            <p className="hint">
              Asked {r.requestedOn}
              {r.pageNames.length ? ` · ${r.pageNames.join(", ")}` : ""} · Estimate {r.estimate} · Time {r.time} · AI {r.aiCost}
              {r.teamNote ? ` · Note: ${r.teamNote}` : ""}
            </p>
            {r.failure ? <p className="hint-error">{r.failure}</p> : null}
            {r.changes.length ? (
              <>
                <Button variant="text" small onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide the changes" : "See the changes"}
                </Button>
                {open === r.id ? (
                  <div className="tracked-changes">
                    {r.changes.map((c) => (
                      <div key={c.name}>
                        <p className="seo-check-label">{c.name}{c.changed ? "" : ": no change needed"}</p>
                        {c.removed.map((line, i) => (
                          <p key={`r${i}`} className="change-removed">
                            <span className="visually-hidden">Removed: </span>
                            {line}
                          </p>
                        ))}
                        {c.added.map((line, i) => (
                          <p key={`a${i}`} className="change-added">
                            <span className="visually-hidden">Added: </span>
                            {line}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
            {props.canEdit && r.status !== "done" && r.status !== "declined" && r.status !== "quoted" ? (
              <div className="money-row-actions edit-actions">
                {props.canMakeAi && r.kind === "edit" && ["open", "failed", "edited"].includes(r.status) ? (
                  <Button small variant={r.status === "edited" ? "secondary" : "primary"} disabled={busy || !props.hasBuild} onClick={() => setDialog({ kind: "edit", row: r })}>
                    {r.status === "edited" ? "Make it again" : "Make the edit"}
                  </Button>
                ) : null}
                {r.status === "edited" ? (
                  <Button small variant="primary" disabled={busy} onClick={() => run(() => rebuildWithEditAction(props.projectId, r.id))}>
                    Put it into the site
                  </Button>
                ) : null}
                <Button small variant="text" onClick={() => setDialog({ kind: "time", requestId: r.id })}>
                  Log time
                </Button>
                <Button small variant="text" disabled={busy} onClick={() => run(() => closeEditRequestAction(props.projectId, r.id))}>
                  Mark done
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {dialog?.kind === "request" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="request-title">
            <h2 className="section-title" id="request-title">
              Log a request from the client
            </h2>
            <div className="field">
              <label className="field-label" htmlFor="request-words">
                <span>What the client asked, in their words</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="request-words" className="textarea" rows={3} value={request.clientWords} onChange={(e) => setRequest((r) => ({ ...r, clientWords: e.target.value }))} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="request-date">
                <span>Asked on</span>
              </label>
              <input id="request-date" type="date" className="input" style={{ maxWidth: 200 }} value={request.requestedOn} onChange={(e) => setRequest((r) => ({ ...r, requestedOn: e.target.value }))} />
            </div>
            <fieldset className="field">
              <legend className="field-label">
                <span>Category</span>
                <span className="field-required">Required</span>
              </legend>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {props.categories.map((c) => (
                  <label key={c.key} className={request.category === c.key ? "chip chip-pick is-picked" : "chip chip-pick"}>
                    <input type="radio" name="request-category" className="visually-hidden" checked={request.category === c.key} onChange={() => setRequest((r) => ({ ...r, category: c.key, redesign: c.key === "design" ? r.redesign : false }))} />
                    {c.label}
                  </label>
                ))}
              </div>
              {request.category === "design" ? (
                <label className="radio-line">
                  <input type="checkbox" checked={request.redesign} onChange={(e) => setRequest((r) => ({ ...r, redesign: e.target.checked }))} />
                  This is a redesign (always quoted)
                </label>
              ) : null}
            </fieldset>
            <div className="field">
              <label className="field-label" htmlFor="request-estimate">
                <span>Hours estimate</span>
                <span className="field-required">Required</span>
              </label>
              <input id="request-estimate" className="input" inputMode="decimal" style={{ maxWidth: 160 }} placeholder="1.5" value={request.estimateHours} onChange={(e) => setRequest((r) => ({ ...r, estimateHours: e.target.value }))} />
              <p className="hint">Quarter hours allowed (0.25, 0.5, 1.75).</p>
            </div>
            {request.category === "new_page" ? (
              <p className="hint">A new page: there is no existing page to choose.</p>
            ) : (
              <fieldset className="field">
                <legend className="field-label">
                  <span>Which pages?</span>
                </legend>
                {props.pages.length === 0 ? <p className="hint">No built pages yet.</p> : null}
                <div className="page-picks">
                  {props.pages.map((p) => (
                    <label key={p.id} className="radio-line">
                      <input
                        type="checkbox"
                        checked={request.pageIds.includes(p.id)}
                        onChange={(e) => setRequest((r) => ({ ...r, pageIds: e.target.checked ? [...r.pageIds, p.id] : r.pageIds.filter((id) => id !== p.id) }))}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="field">
              <label className="field-label" htmlFor="request-note">
                <span>Team note (where and how)</span>
              </label>
              <input id="request-note" className="input" value={request.teamNote} onChange={(e) => setRequest((r) => ({ ...r, teamNote: e.target.value }))} />
            </div>
            {shownQuote ? (
              <div className="amber-box" role="status">
                <p className="card-title">This becomes a quote.</p>
                <p className="hint">
                  {shownQuote.reason} From the Pricing page: {shownQuote.lines.map((l) => `${l.label}${l.quantity !== 1 ? ` × ${l.quantity}` : ""}: ${l.amountCents === null ? "price not set" : `$${(l.amountCents / 100).toFixed(2)}`}`).join("; ")}. The client approves it before any work starts.
                </p>
              </div>
            ) : null}
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || request.clientWords.trim().length < 5 || !request.category || !request.estimateHours}
                onClick={() =>
                  run(async () => {
                    const result = await logUpdateRequestAction(props.projectId, { ...request, pageIds: request.category === "new_page" ? [] : request.pageIds });
                    // A fresh form for the next request.
                    if (result.ok) setRequest({ clientWords: "", teamNote: "", requestedOn: props.today, pageIds: [], category: "", redesign: false, estimateHours: "" });
                    return result;
                  })
                }
              >
                {busy ? "Saving..." : shownQuote ? "Log it and draft the quote" : "Log the request"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "time" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="time-title">
            <h2 className="section-title" id="time-title">
              Log dev time
            </h2>
            <p className="hint">Counts against this client&rsquo;s {props.month.included} included hours for the month it was worked.</p>
            <div className="money-dialog-fees">
              <div className="field">
                <label className="field-label" htmlFor="time-minutes">
                  <span>Minutes</span>
                </label>
                <input id="time-minutes" className="input" inputMode="numeric" style={{ maxWidth: 120 }} value={time.minutes} onChange={(e) => setTime((t) => ({ ...t, minutes: e.target.value }))} />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="time-date">
                  <span>Worked on</span>
                </label>
                <input id="time-date" type="date" className="input" value={time.workedOn} onChange={(e) => setTime((t) => ({ ...t, workedOn: e.target.value }))} />
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="time-note">
                <span>What was done</span>
              </label>
              <input id="time-note" className="input" value={time.note} onChange={(e) => setTime((t) => ({ ...t, note: e.target.value }))} />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => run(() => logDevTimeAction(props.projectId, { requestId: dialog.requestId, minutes: Number(time.minutes), note: time.note, workedOn: time.workedOn }))}
              >
                {busy ? "Saving..." : "Log the time"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "edit" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <h2 className="section-title" id="edit-title">
              Make the edit?
            </h2>
            <p className="hint">
              Each chosen page is changed only where the request asks, on the latest build, with nothing invented. You see the
              changes before they go into the site.
            </p>
            <p className="hint">{dialog.row.estimateLine}</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => startEditAction(props.projectId, dialog.row.id))}>
                {busy ? "Starting..." : "Make the edit"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
const share = (minutes: number, included: number) => Math.min(100, (minutes / Math.max(1, included * 60)) * 100);
