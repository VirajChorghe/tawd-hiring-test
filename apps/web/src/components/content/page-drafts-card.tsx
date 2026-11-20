"use client";

import { StopButton } from "@/components/ui/stop-button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { approveKeptPagesAction, recordCopyDecisionAction, startDraftsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Page drafts (7b): each page's copy, drafted by AI from the intake, the
  plan and the approved mockup's voice (estimate first), then reviewed and
  approved page by page by Content. Once every page is approved, the PM
  sends the client the copy pack and records their decision.
*/

export interface DraftRow {
  pageId: string;
  name: string;
  href: string;
  version: string;
  state: "not_drafted" | "drafting" | "failed" | "ready" | "approved";
  stateLabel: string;
  aiWriting: string;
  aiFlagged: boolean;
  comments: number;
  placeholders: number;
}

const BADGE: Record<DraftRow["state"], string> = {
  not_drafted: "badge badge-info",
  drafting: "badge badge-warning",
  failed: "badge badge-missing",
  ready: "badge badge-warning",
  approved: "badge badge-done",
};

export function PageDraftsCard(props: {
  projectId: string;
  canDraft: boolean;
  rows: DraftRow[];
  undrafted: number;
  approved: number;
  drafting: boolean;
  allApproved: boolean;
  estimateLine: string;
  /** Opened with a dialog showing (for screenshots). */
  startDialog?: "draft" | "kept";
  /** One page's draft, for the dialog's running estimate (28 September 2026). */
  perPage?: { cost: number; model: string; measured: boolean };
  /** Keep the current site (6 October 2026): kept pages still as they came, unapproved, with no open comments. */
  keptWaiting?: number;
  /** Content and admins. */
  canApprove?: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"draft" | "kept" | null>(props.startDialog ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  // Choose, then review (28 September 2026): the pages to draft now and the team's direction for them.
  const choices = props.rows.filter((r) => r.state === "not_drafted" || r.state === "failed");
  const [chosen, setChosen] = useState<string[]>(choices.map((r) => r.pageId));
  const [direction, setDirection] = useState("");
  const picked = choices.filter((r) => chosen.includes(r.pageId)).length;
  const draftEstimate = !picked
    ? "Choose at least one page."
    : props.perPage
      ? `About ${dollars(props.perPage.cost * picked)} of AI on ${props.perPage.model} for ${picked} page${picked === 1 ? "" : "s"}${props.perPage.measured ? ", from the drafts so far" : " (a first guess until a real draft has run)"}.`
      : props.estimateLine;

  useEffect(() => {
    if (!props.drafting) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [props.drafting, router]);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
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
    <div className="card content-card" id="drafts">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Page drafts</h2>
          <p className="hint">
            {props.rows.length === 0
              ? "Make the page plan first: each page is drafted from it."
              : `${props.approved} of ${props.rows.length} pages approved by Content. Open a page to read, edit, comment on and approve it.`}
          </p>
        </div>
        <div className="money-row-actions">
          {props.canApprove && (props.keptWaiting ?? 0) > 0 ? (
            <Button disabled={busy} onClick={() => setDialog("kept")}>
              Approve all kept pages ({props.keptWaiting})
            </Button>
          ) : null}
          {props.canDraft && props.undrafted > 0 ? (
            <Button variant="primary" disabled={busy || props.drafting} onClick={() => setDialog("draft")}>
              Draft {props.undrafted} page{props.undrafted === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
      </div>
      {props.undrafted > 0 && !props.drafting ? <p className="hint">{props.estimateLine}</p> : null}
      {props.drafting ? (
        <div className="stop-line">
          <p className="hint content-warn">Drafting... each page takes about a minute. This page refreshes itself.</p>
          {props.canDraft ? <StopButton projectId={props.projectId} kind="drafts" what="the page drafts" /> : null}
        </div>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {props.rows.length > 0 ? (
        <div className="table-scroll content-table">
          <table className="spend-table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Version</th>
                <th>Status</th>
                <th>AI writing</th>
                <th className="align-right">Placeholders</th>
                <th className="align-right">Open comments</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row) => (
                <tr key={row.pageId} id={`page-${row.pageId}`} className="draft-row">
                  <td>
                    {row.state === "not_drafted" ? (
                      <strong>{row.name}</strong>
                    ) : (
                      <Link href={row.href}>
                        <strong>{row.name}</strong>
                      </Link>
                    )}
                  </td>
                  <td>{row.version}</td>
                  <td>
                    <span className={BADGE[row.state]}>{row.stateLabel}</span>
                  </td>
                  <td className={row.aiFlagged ? "content-warn" : undefined}>{row.aiWriting}</td>
                  <td className="align-right">{row.placeholders || "-"}</td>
                  <td className="align-right">{row.comments || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {props.allApproved ? <p className="hint content-done">Every page is approved: the copy pack and the client&rsquo;s answer are in the next step.</p> : null}

      {dialog === "draft" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="draft-title">
            <h2 className="section-title" id="draft-title">
              Draft the pages?
            </h2>
            <p className="hint">
              Each page is written from the intake, its keywords in the plan and the approved mockup&rsquo;s voice, with no
              invented facts: anything missing is a visible [PLACEHOLDER]. Content reviews every page before the client sees it;
              Slack says when they&rsquo;re ready.
            </p>
            <fieldset className="field design-read-pages">
              <legend className="field-label">
                <span>Pages to draft now</span>
              </legend>
              <div className="design-read-quick">
                {choices[0] ? (
                  <Button small variant="text" onClick={() => setChosen([choices[0]!.pageId])}>
                    {choices[0].name === "Home" ? "Only the home page" : `Only "${choices[0].name}"`}
                  </Button>
                ) : null}
                <Button small variant="text" onClick={() => setChosen(choices.map((r) => r.pageId))}>
                  Every page not drafted yet
                </Button>
              </div>
              {choices.map((r) => (
                <label className="checkline" key={r.pageId}>
                  <input type="checkbox" checked={chosen.includes(r.pageId)} onChange={(e) => setChosen(e.target.checked ? [...chosen, r.pageId] : chosen.filter((id) => id !== r.pageId))} />
                  <span>
                    {r.name} {r.state === "failed" ? <span className="hint">the last draft failed</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label className="field-label" htmlFor="draft-direction">
                <span>Direction for these drafts</span>
                <span className="field-optional">Optional</span>
              </label>
              <textarea
                id="draft-direction"
                className="textarea"
                rows={3}
                maxLength={1000}
                placeholder="For example: friendly and plain, short paragraphs, stress same-day visits and the 5-year warranty."
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              />
              <p className="hint">The writer follows it for the voice and emphasis; the house rules still apply. Kept with each draft and in the activity log.</p>
            </div>
            <p className={picked ? "hint" : "hint-amber"}>{draftEstimate}</p>
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || picked === 0} onClick={() => run(() => startDraftsAction(props.projectId, chosen, direction))}>
                {busy ? "Starting..." : `Draft ${picked} page${picked === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === "kept" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="kept-approve-title">
            <h2 className="section-title" id="kept-approve-title">
              Approve all {props.keptWaiting} kept pages?
            </h2>
            <p className="hint">
              Each page whose words are still exactly as they came from the current site, with no open comments, is approved by
              you: one approval per page in the activity log, as if you approved them one by one. Pages edited since, or with
              open comments, wait for their own review. Read them first: approving says the words are right for the new site
              (and that any quotes from customers on them are real).
            </p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => approveKeptPagesAction(props.projectId))}>
                {busy ? "Approving..." : `Approve ${props.keptWaiting} pages`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

/*
  The client's approval of the copy (step 6, 8 October 2026): the copy pack
  and the client's answer live in their own step, not at the end of the
  drafts' step (a dead end once that step was done and closed).
*/
export function CopyPackCard(props: {
  projectId: string;
  canDecide: boolean;
  allApproved: boolean;
  /** The only page is the supplied home page: there is no copy to send or approve. */
  nothingToApprove?: boolean;
  /** "3 of 11 pages approved" while some still wait. */
  waitingLine: string;
  /** "Approved by the client on Sep 26 (phone call): ..." */
  decisionLine: string | null;
  decisionChanges: boolean;
  /** The client approved the copy and this person may move on: "Move to Build & preview" is in the next-step bar. */
  canMoveToBuild: boolean;
  /** Opened with the dialog showing (for screenshots). */
  startDialog?: "decision";
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"decision" | null>(props.startDialog ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [decision, setDecision] = useState({ outcome: "approved" as "approved" | "changes_requested", channel: "phone call", clientSaid: "" });

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
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

  if (props.nothingToApprove) {
    return (
      <div id="copy-pack">
        <p className="hint">There is no copy pack: the only page is the homepage the client approved, and it keeps its own words. Nothing is left to approve here{props.canMoveToBuild ? "; move to Build from the bar below" : ""}.</p>
      </div>
    );
  }

  if (!props.allApproved) {
    return (
      <div id="copy-pack">
        <p className="hint">The copy pack opens here once every page is approved: {props.waitingLine}.</p>
      </div>
    );
  }

  return (
    <div id="copy-pack">
      <div className="copy-pack">
        <div>
          <p className="copy-pack-title">Copy pack for the client</p>
          <p className="hint">
            Every page is approved. Send the client the pack (the approved pages, with anything still needed from them
            highlighted), then record what they said.
          </p>
          {props.decisionLine ? <p className={props.decisionChanges ? "hint content-warn" : "hint content-done"}>{props.decisionLine}</p> : null}
        </div>
        <div className="money-row-actions">
          <a className="btn btn-secondary btn-small" href={`/projects/${props.projectId}/content/copy-pack`} download>
            Download the copy pack
          </a>
          {props.canDecide ? (
            <Button variant={props.canMoveToBuild ? "secondary" : "primary"} small onClick={() => setDialog("decision")}>
              Record the client&rsquo;s decision
            </Button>
          ) : null}
        </div>
      </div>
      {dialog === "decision" ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="decision-title">
            <h2 className="section-title" id="decision-title">
              Record the client&rsquo;s decision on the copy
            </h2>
            <fieldset className="field">
              <legend className="field-label">
                <span>What did the client decide?</span>
              </legend>
              <label className="radio-line">
                <input type="radio" name="outcome" checked={decision.outcome === "approved"} onChange={() => setDecision((d) => ({ ...d, outcome: "approved" }))} />
                Approved the copy
              </label>
              <label className="radio-line">
                <input type="radio" name="outcome" checked={decision.outcome === "changes_requested"} onChange={() => setDecision((d) => ({ ...d, outcome: "changes_requested" }))} />
                Asked for changes
              </label>
            </fieldset>
            <div className="field">
              <label className="field-label" htmlFor="decision-channel">
                <span>How it came in</span>
              </label>
              <select id="decision-channel" className="select" value={decision.channel} onChange={(e) => setDecision((d) => ({ ...d, channel: e.target.value }))}>
                <option value="phone call">Phone call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="decision-said">
                <span>What the client said</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="decision-said" className="textarea" rows={3} value={decision.clientSaid} onChange={(e) => setDecision((d) => ({ ...d, clientSaid: e.target.value }))} />
              <p className="hint">Recorded in the activity log with each page&rsquo;s version, your name and the time.</p>
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setDialog(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy || decision.clientSaid.trim().length < 3} onClick={() => run(() => recordCopyDecisionAction(props.projectId, decision))}>
                {busy ? "Saving..." : "Record the decision"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* The same wording as the server's formatCost, for the running estimate. */
function dollars(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "under $0.01";
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value)}`;
}
