"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  addPageCommentAction,
  approvePageAction,
  checkAiWritingAction,
  requestRedraftAction,
  revertToKeptAction,
  startImproveAction,
  resolvePageCommentAction,
  saveDraftEditAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  One page's review (7b): the draft as it will read, editable in place (a
  new version each save), and beside it the approval, the SEO checks, the
  AI-writing score and the comments. Request a redraft is paid AI, with
  the estimate first.
*/

type Result = { ok: true } | { ok: false; message: string };

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (action: () => Promise<Result>, done?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      done?.();
      router.refresh();
    });
  return { error, busy, run };
}

export function DraftPanel(props: {
  projectId: string;
  pageId: string;
  canEdit: boolean;
  /** The draft as HTML, placeholders highlighted. */
  html: string | null;
  body: string;
  /** "Version 3 of 3: edited by Dana, Sep 26, 4:02 PM." */
  versionLine: string;
  working: boolean;
  failure: string | null;
  estimateLine: string;
  /** Design + content (0.100.0): the page's words improved from the current site's. */
  improve?: {
    compare: { parts: { kind: "same" | "added" | "removed"; text: string }[]; changed: number; factsLine: string | null } | null;
    /** The newest version isn't the current site's words: Put back is offered. */
    canPutBack: boolean;
    estimateLine: string;
  } | null;
}) {
  const router = useRouter();
  const { error, busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.body);
  const [redraft, setRedraft] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const improve = props.improve ?? null;

  useEffect(() => {
    if (!props.working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [props.working, router]);

  return (
    <div className="card content-card draft-panel">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">The draft</h2>
          <p className="hint">{props.versionLine}</p>
        </div>
        {props.canEdit && !editing && props.html && !props.working ? (
          <div className="money-row-actions">
            <Button small onClick={() => setRedraft("")}>
              {improve ? "Improve it again" : "Request a redraft"}
            </Button>
            {improve?.canPutBack ? (
              <Button small disabled={busy} onClick={() => run(() => revertToKeptAction(props.projectId, props.pageId))}>
                Put back the current site&rsquo;s words
              </Button>
            ) : null}
            <Button small onClick={() => { setText(props.body); setEditing(true); }}>
              Edit
            </Button>
          </div>
        ) : null}
      </div>
      {props.working ? <p className="hint content-warn">Writing this page... about a minute. This page refreshes itself.</p> : null}
      {props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {props.failure && improve && props.canEdit ? (
        <div className="money-row-actions">
          <Button small variant="primary" disabled={busy} onClick={() => run(() => startImproveAction(props.projectId, [props.pageId]))}>
            Try again
          </Button>
          <Button small disabled={busy} onClick={() => run(() => revertToKeptAction(props.projectId, props.pageId))}>
            Keep the current site&rsquo;s words
          </Button>
          <span className="hint">{improve.estimateLine} Keeping the current words is free.</span>
        </div>
      ) : null}
      {improve?.compare && !editing ? (
        <div className="improve-compare-bar">
          <Button small variant="text" onClick={() => setComparing((c) => !c)}>
            {comparing ? "Show the improved words" : "Compare with the current site"}
          </Button>
          <span className="hint">About {improve.compare.changed}% of the words are new.</span>
          {improve.compare.factsLine ? <p className="hint hint-amber">{improve.compare.factsLine}</p> : null}
        </div>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}

      {editing ? (
        <div className="draft-edit">
          <label className="field-label" htmlFor="draft-body">
            <span>Page copy</span>
          </label>
          <textarea id="draft-body" className="textarea draft-textarea" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="hint">
            &ldquo;# &rdquo; is the H1, &ldquo;## &rdquo; a section heading, &ldquo;### &rdquo; a question or sub-heading,
            &ldquo;- &rdquo; a list item. Saving makes a new version, which Content approves again.
          </p>
          <div className="modal-actions">
            <Button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => run(() => saveDraftEditAction(props.projectId, props.pageId, text), () => setEditing(false))}>
              {busy ? "Saving..." : "Save as a new version"}
            </Button>
          </div>
        </div>
      ) : comparing && improve?.compare ? (
        <div className="draft-copy improve-diff" aria-label="The improved words compared with the current site's: added words underlined, removed words struck through">
          {improve.compare.parts.map((part, i) =>
            part.kind === "same" ? <span key={i}>{part.text}</span> : part.kind === "added" ? <ins key={i}>{part.text}</ins> : <del key={i}>{part.text}</del>,
          )}
        </div>
      ) : props.html ? (
        <div
          className="draft-copy"
          // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- built by draftHtml, which escapes every character of the draft
          dangerouslySetInnerHTML={{ __html: props.html }}
        />
      ) : !props.working ? (
        <p className="hint">Not drafted yet.</p>
      ) : null}

      {redraft !== null ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="redraft-title">
            <h2 className="section-title" id="redraft-title">
              {improve ? "Improve it again?" : "Request a redraft?"}
            </h2>
            <p className="hint">
              {improve
                ? `A new version is improved from the current site's words, with your note in mind. ${improve.estimateLine}`
                : `A new version is written with your note and the current draft in mind. ${props.estimateLine}`}
            </p>
            <div className="field">
              <label className="field-label" htmlFor="redraft-note">
                <span>What should change?</span>
                <span className="field-required">Required</span>
              </label>
              <textarea id="redraft-note" className="textarea" rows={3} value={redraft} onChange={(e) => setRedraft(e.target.value)} />
            </div>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setRedraft(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || redraft.trim().length < 5}
                onClick={() => run(() => requestRedraftAction(props.projectId, props.pageId, redraft), () => setRedraft(null))}
              >
                {busy ? "Starting..." : improve ? "Improve the page" : "Redraft the page"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalCard(props: {
  projectId: string;
  pageId: string;
  canApprove: boolean;
  approvedLine: string | null;
  ready: boolean;
  placeholders: number;
  /** Once approved (8 October 2026): the next page still to approve, in the plan's order, or back to Content when none is left. */
  next?: { name: string; href: string } | null;
  backHref?: string;
}) {
  const { error, busy, run } = useAction();
  return (
    <div className="card content-card">
      <h2 className="card-title">Approval</h2>
      {props.approvedLine ? (
        <>
          <p className="hint content-done">
            <span className="badge badge-done">Approved</span> {props.approvedLine}
          </p>
          {props.next ? (
            <div className="money-row-actions">
              <Link className="btn btn-primary btn-small" href={props.next.href}>
                Next to approve: {props.next.name}
              </Link>
            </div>
          ) : props.backHref ? (
            <div className="money-row-actions">
              <Link className="btn btn-secondary btn-small" href={props.backHref}>
                No page left to approve: back to Content
              </Link>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="hint">
            {props.ready
              ? "Content approves this version. A later edit or redraft needs approving again."
              : "Nothing to approve until the page is drafted."}
            {props.placeholders ? ` ${props.placeholders} placeholder${props.placeholders === 1 ? " is" : "s are"} still open: the client fills ${props.placeholders === 1 ? "it" : "them"} in from the copy pack, and the site can't go live until they are.` : ""}
          </p>
          {props.canApprove ? (
            <Button variant="primary" disabled={busy || !props.ready} onClick={() => run(() => approvePageAction(props.projectId, props.pageId))}>
              {busy ? "Approving..." : "Approve this version"}
            </Button>
          ) : (
            <p className="hint">Only Content (or an admin) approves page copy.</p>
          )}
        </>
      )}
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

export function SeoPanel(props: { checks: { key: string; label: string; ok: boolean; detail: string }[]; wordCount: number }) {
  return (
    <div className="card content-card">
      <h2 className="card-title">SEO checks</h2>
      <p className="hint">{props.wordCount} words. Warnings are for the editor to judge; none of them blocks approval.</p>
      <ul className="seo-checks">
        {props.checks.map((check) => (
          <li key={check.key}>
            <span className={check.ok ? "badge badge-done" : "badge badge-warning"}>{check.ok ? "Good" : "Check"}</span>
            <div>
              <p className="seo-check-label">{check.label}</p>
              <p className="hint">{check.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiWritingCard(props: {
  projectId: string;
  pageId: string;
  canCheck: boolean;
  configured: boolean;
  ready: boolean;
  /** "18% likely AI-written"; null before a check. */
  scoreLine: string | null;
  /** When it was checked, and what a flag means. */
  scoreNote: string | null;
  flagged: boolean;
  lastError: string | null;
  creditsLine: string;
}) {
  const { error, busy, run } = useAction();
  return (
    <div className="card content-card">
      <h2 className="card-title">AI writing</h2>
      <p className="hint">How machine-written the copy reads, from Originality.ai. Information only: over 30% is flagged for rewriting, never blocked.</p>
      {props.scoreLine ? <p className={props.flagged ? "content-score content-warn" : "content-score"}>{props.scoreLine}</p> : null}
      {props.scoreNote ? <p className={props.flagged ? "hint content-warn" : "hint"}>{props.scoreNote}</p> : null}
      {props.lastError ? <p className="hint-error">{props.lastError}</p> : null}
      {!props.configured ? (
        <p className="hint content-warn">Not set up yet: an admin adds ORIGINALITY_API_KEY in Coolify.</p>
      ) : props.canCheck ? (
        <>
          <Button small disabled={busy || !props.ready} onClick={() => run(() => checkAiWritingAction(props.projectId, props.pageId))}>
            {busy ? "Checking..." : props.scoreLine ? "Check again" : "Check AI writing"}
          </Button>
          <p className="hint">{props.creditsLine}</p>
        </>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

export function CommentsCard(props: {
  projectId: string;
  pageId: string;
  canComment: boolean;
  comments: { id: string; author: string; when: string; version: number; body: string; resolved: string | null }[];
}) {
  const { error, busy, run } = useAction();
  const [text, setText] = useState("");
  const open = props.comments.filter((c) => !c.resolved);
  const resolved = props.comments.filter((c) => c.resolved);
  return (
    <div className="card content-card">
      <h2 className="card-title">Comments</h2>
      {props.comments.length === 0 ? <p className="hint">No comments yet.</p> : null}
      <ul className="page-comments">
        {[...open, ...resolved].map((c) => (
          <li key={c.id} className={c.resolved ? "is-resolved" : undefined}>
            <p className="hint">
              <strong>{c.author}</strong> on v{c.version}, {c.when}
              {c.resolved ? ` (resolved: ${c.resolved})` : ""}
            </p>
            <p className="page-comment-body">{c.body}</p>
            {!c.resolved && props.canComment ? (
              <Button variant="text" small disabled={busy} onClick={() => run(() => resolvePageCommentAction(props.projectId, c.id))}>
                Resolve
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.canComment ? (
        <div className="field">
          <label className="field-label" htmlFor="page-comment">
            <span>Add a comment</span>
          </label>
          <textarea id="page-comment" className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div>
            <Button small disabled={busy || !text.trim()} onClick={() => run(() => addPageCommentAction(props.projectId, props.pageId, text), () => setText(""))}>
              Add comment
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}
