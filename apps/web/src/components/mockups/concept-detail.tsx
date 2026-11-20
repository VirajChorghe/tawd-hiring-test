"use client";

import { StopButton } from "@/components/ui/stop-button";
import { startPolishAction } from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import type { PolishView } from "@/lib/polish";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  addCommentAction,
  requestChangesAction,
  retryNotDoneAction,
  setCommentResolvedAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { REVIEW_QUESTIONS } from "@/lib/mockup-labels";
import { roleLabels } from "@/lib/labels";
import type { ConceptDetail, DetailComment, DetailVersion } from "@/lib/concept-detail";
import type { BandOnImage } from "@tawd/core/mockups";

/*
  Mockups 4: concept detail. DESIGN.md, Mockup engine screens.

  The full render with numbered pins on the left (click the design to pin
  a comment), and on the right the Team comments, Review, Checks and
  Versions tabs. Request changes takes over the right panel. Comments stay
  with the team until Request changes sends them.

  2 October 2026: the section under the mouse is outlined and a pin is tied
  to it; an unposted comment and unsent notes are kept in this browser, so
  switching tabs or reloading loses nothing; each sent comment shows Done or
  Not done from the Creative Director, and stays open until a person
  resolves it.
*/

/* A pin belongs to the version it was placed on; on another version it is set aside (the words stay). */
type DraftPin = { x: number; y: number; band: number | null; version: number };
type Draft = { body: string; pin: DraftPin | null; notes: string };
const EMPTY_DRAFT: Draft = { body: "", pin: null, notes: "" };
const draftKey = (conceptId: string) => `tawd:concept-draft:${conceptId}`;

/* The browser may refuse storage (private windows, blocked site data): the draft then lives only on the page. */
function readDraft(conceptId: string): Draft {
  try {
    const raw = window.localStorage.getItem(draftKey(conceptId));
    if (!raw) return EMPTY_DRAFT;
    const value = JSON.parse(raw) as Partial<Draft>;
    return {
      body: typeof value.body === "string" ? value.body : "",
      notes: typeof value.notes === "string" ? value.notes : "",
      pin:
        value.pin && typeof value.pin.x === "number" && typeof value.pin.y === "number" && typeof value.pin.version === "number"
          ? {
              x: value.pin.x,
              y: value.pin.y,
              band: typeof value.pin.band === "number" ? value.pin.band : null,
              version: value.pin.version,
            }
          : null,
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(conceptId: string, draft: Draft) {
  try {
    if (!draft.body.trim() && !draft.notes.trim() && !draft.pin) window.localStorage.removeItem(draftKey(conceptId));
    else window.localStorage.setItem(draftKey(conceptId), JSON.stringify(draft));
  } catch {
    // Not kept between visits; nothing else changes.
  }
}

/* The section number (as the worker counts them) at a point down the picture, in percent. */
function bandAt(y: number, bands: BandOnImage[]): number | null {
  return bands.find((b) => y >= b.top && y < b.bottom)?.index ?? null;
}

export type Tab = "comments" | "review" | "checks" | "versions";

export function ConceptDetailView({
  detail,
  initialTab = "comments",
  startRequesting = false,
  slackWarning = null,
  polish = null,
}: {
  detail: ConceptDetail;
  /** The latest critique and polish on this concept (27 September 2026). */
  polish?: PolishView | null;
  /** From ?tab=, so a link can open a tab directly. */
  initialTab?: Tab;
  startRequesting?: boolean;
  slackWarning?: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [requesting, setRequesting] = useState(startRequesting && detail.canAct);
  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [hoverBand, setHoverBand] = useState<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const { selected, compare } = detail;
  const draftPin = draft.pin && draft.pin.version === selected.version ? draft.pin : null;

  // Read after the first paint: the server has no browser storage, and the page must match it first.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Anything typed before the saved draft came back wins (Fable's A9, 3 October 2026).
      setDraftState((current) => (current.body || current.notes || current.pin ? current : readDraft(detail.concept.id)));
      setDraftLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [detail.concept.id]);
  const setDraft = (change: Partial<Draft>) =>
    setDraftState((current) => {
      const next = { ...current, ...change };
      writeDraft(detail.concept.id, next);
      return next;
    });
  const setDraftPin = (pin: DraftPin | null) => setDraft({ pin });

  const base = `/projects/${detail.projectId}/mockups/${detail.concept.id}`;
  const open = detail.comments.filter((c) => !c.resolved);
  const pins = detail.comments.filter(
    (c) => c.version === selected.version && c.pinX !== null && c.pinY !== null && !c.resolved,
  );
  const bands = selected.bands;
  const outlined = bands.find((b) => b.index === (hoverBand ?? draftPin?.band ?? null)) ?? null;
  const nextNumber = detail.comments.length + 1;

  // Keep the page current while a new version is being made.
  useEffect(() => {
    if (!detail.pending) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [detail.pending, router]);

  const goTo = (params: { v?: number; compare?: number | null }) => {
    const search = new URLSearchParams();
    const v = params.v ?? selected.version;
    if (v !== detail.latestVersion) search.set("v", String(v));
    const c = params.compare === undefined ? compare?.version : params.compare;
    if (c !== undefined && c !== null) search.set("compare", String(c));
    const query = search.toString();
    router.push(query ? `${base}?${query}` : base);
  };

  return (
    <>
      <section className="detail-header">
        {slackWarning ? (
          <p className="slack-warning" role="status">
            {slackWarning}{" "}
            <Link href={`/projects/${detail.projectId}#slack`}>Check the Slack setting</Link>
          </p>
        ) : null}
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link href="/projects">Projects</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/projects/${detail.projectId}/mockups`}>{detail.clientName}</Link>
          <span aria-hidden="true">/</span>
          <span>Concept {detail.concept.label}</span>
        </nav>
        <div className="detail-header-row">
          <div className="detail-title-row">
            <h1 className="detail-title">
              Concept {detail.concept.label}: {detail.concept.directionLabel}
            </h1>
            <label className="detail-version">
              <span>Version</span>
              <select
                className="select"
                value={selected.version}
                onChange={(event) => goTo({ v: Number(event.target.value), compare: null })}
              >
                {detail.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.label}
                    {v.version === detail.latestVersion ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Link href={`/projects/${detail.projectId}/mockups`} className="btn btn-secondary">
              All concepts
            </Link>
            {detail.canAct && detail.concept.ready ? (
              // The next step after reviewing a concept (8 October 2026): the board's dialog, with this concept chosen.
              <Link href={`/projects/${detail.projectId}/mockups?decide=${detail.concept.id}`} className="btn btn-secondary">
                Record the client&rsquo;s decision
              </Link>
            ) : null}
            {detail.canAct ? (
              <Button
                variant="primary"
                onClick={() => setRequesting(true)}
                disabled={requesting}
              >
                Request changes
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <div className="page">
        {detail.pending ? (
          <div className="stop-line">
            <p className="detail-working" role="status">
              <span className="step-dot" aria-hidden="true" />
              Making v{detail.pending.nextVersion}: {detail.pending.detail ?? "waiting its turn"}. This
              page updates when it is ready.
            </p>
            <StopButton projectId={detail.projectId} kind="changes" what="the requested changes" />
          </div>
        ) : detail.lastFailure ? (
          <p className="hint-error detail-working-error">
            The last requested changes didn&rsquo;t finish: {detail.lastFailure} The comments that
            went with it are open again.
          </p>
        ) : detail.lastResult ? (
          <p className="hint detail-last-result" role="status">
            Last requested changes: {detail.lastResult.detail}.
          </p>
        ) : null}

        <div className="detail-layout">
          <div className="card detail-canvas">
            {compare ? (
              <>
                <div className="detail-canvas-head">
                  <span>
                    Comparing {selected.label} with {compare.label}.
                  </span>
                  <button type="button" className="link-button" onClick={() => goTo({ compare: null })}>
                    Stop comparing
                  </button>
                </div>
                <div className="compare-grid">
                  {[selected, compare].map((v) => (
                    <figure key={v.version} className="compare-item">
                      <figcaption>{v.label}</figcaption>
                      <div className="render-frame">
                        {v.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                          <img src={v.imageUrl} alt={`Concept ${detail.concept.label}, ${v.label}`} />
                        ) : (
                          <p className="hint">No render for this version.</p>
                        )}
                      </div>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="detail-canvas-head">
                  <span>
                    Desktop, 1440 px wide. Click anywhere on the design to pin a comment
                    {bands.length > 0 ? "; the section it goes to is outlined" : ""}.
                  </span>
                  <strong>
                    {pins.length} pin{pins.length === 1 ? "" : "s"}
                  </strong>
                </div>
                {/* The frame scrolls; the pins sit on the image inside it. */}
                <div className="render-frame render-scroll">
                <div
                  className="render-pinnable"
                  onMouseMove={(event) => {
                    if (bands.length === 0) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    setHoverBand(bandAt(((event.clientY - box.top) / box.height) * 100, bands));
                  }}
                  onMouseLeave={() => setHoverBand(null)}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest(".pin")) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    const x = ((event.clientX - box.left) / box.width) * 100;
                    const y = ((event.clientY - box.top) / box.height) * 100;
                    setDraftPin({ x: clamp(x), y: clamp(y), band: bandAt(y, bands), version: selected.version });
                    setRequesting(false);
                    setTab("comments");
                    setTimeout(() => composerRef.current?.focus(), 0);
                  }}
                >
                  {selected.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                    <img src={selected.imageUrl} alt={`Concept ${detail.concept.label}, ${selected.label}`} />
                  ) : (
                    <p className="hint" style={{ padding: 40 }}>
                      No render for this version.
                    </p>
                  )}
                  {outlined ? (
                    <span
                      className="band-outline"
                      style={{ top: `${outlined.top}%`, height: `${outlined.bottom - outlined.top}%` }}
                      aria-hidden="true"
                    >
                      <span className="band-outline-label">{outlined.label}</span>
                    </span>
                  ) : null}
                  {pins.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="pin"
                      style={{ left: `${c.pinX}%`, top: `${c.pinY}%` }}
                      aria-label={`Comment ${c.number}: ${c.body}`}
                      onClick={() => {
                        setRequesting(false);
                        setTab("comments");
                        document.getElementById(`comment-${c.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
                      }}
                    >
                      {c.number}
                    </button>
                  ))}
                  {draftPin ? (
                    <span className="pin is-draft" style={{ left: `${draftPin.x}%`, top: `${draftPin.y}%` }} aria-hidden="true">
                      {nextNumber}
                    </span>
                  ) : null}
                </div>
                </div>
              </>
            )}
          </div>

          <aside className="card detail-panel" aria-label="Concept review">
            <div className="tabs" role="tablist" aria-label="Concept review">
              {(
                [
                  ["comments", `Team comments (${open.length})`],
                  ["review", "Review"],
                  ["checks", "Checks"],
                  ["versions", "Versions"],
                ] as [Tab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={!requesting && tab === key}
                  onClick={() => {
                    setRequesting(false);
                    setTab(key);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="detail-panel-body">
              {requesting ? (
                <RequestChanges
                  detail={detail}
                  notes={draft.notes}
                  onNotes={(notes) => setDraft({ notes })}
                  onDone={() => setRequesting(false)}
                />
              ) : tab === "comments" ? (
                <CommentsTab
                  detail={detail}
                  draftPin={draftPin}
                  draftLabel={bands.find((b) => draftPin !== null && b.index === draftPin.band)?.label ?? null}
                  body={draft.body}
                  saved={draftLoaded && draft.body.trim().length > 0}
                  onBody={(body) => setDraft({ body })}
                  onPosted={() => setDraft({ body: "", pin: null })}
                  nextNumber={nextNumber}
                  composerRef={composerRef}
                  onClearPin={() => setDraftPin(null)}
                />
              ) : tab === "review" ? (
                <ReviewTab detail={detail} polish={polish} />
              ) : tab === "checks" ? (
                <ChecksTab detail={detail} />
              ) : (
                <VersionsTab detail={detail} onView={(v) => goTo({ v, compare: null })} onCompare={(v) => goTo({ compare: v })} />
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function clamp(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/* ---------- Team comments ---------- */

function CommentsTab({
  detail,
  draftPin,
  draftLabel,
  body,
  saved,
  onBody,
  onPosted,
  nextNumber,
  composerRef,
  onClearPin,
}: {
  detail: ConceptDetail;
  draftPin: DraftPin | null;
  /** The name of the section the draft pin sits on. */
  draftLabel: string | null;
  body: string;
  /** The draft is kept in this browser. */
  saved: boolean;
  onBody: (body: string) => void;
  onPosted: () => void;
  nextNumber: number;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onClearPin: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [posting, startPosting] = useTransition();
  const [showResolved, setShowResolved] = useState(false);

  const open = detail.comments.filter((c) => !c.resolved);
  const resolved = detail.comments.filter((c) => c.resolved);

  const post = () => {
    setError(null);
    startPosting(async () => {
      const result = await addCommentAction(detail.projectId, {
        conceptId: detail.concept.id,
        version: detail.selected.version,
        body,
        pinX: draftPin?.x ?? null,
        pinY: draftPin?.y ?? null,
        band: draftPin?.band ?? null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onPosted();
      router.refresh();
    });
  };

  return (
    <div className="comments">
      <p className="info-note info-note-small">
        <InfoIcon />
        <span>
          Comments stay with the team. To send them to TAWD, use <strong>Request changes</strong>.
        </span>
      </p>

      <SecondTry detail={detail} />

      {open.length === 0 && resolved.length === 0 ? (
        <p className="hint">No comments yet. Click the design to pin one, or add a general comment below.</p>
      ) : null}

      {open.map((c) => (
        <CommentCard key={c.id} comment={c} detail={detail} />
      ))}

      {resolved.length > 0 ? (
        <div>
          <button type="button" className="link-button" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
          </button>
          {showResolved ? resolved.map((c) => <CommentCard key={c.id} comment={c} detail={detail} />) : null}
        </div>
      ) : null}

      <div className="field comment-composer">
        <label className="field-label" htmlFor="new-comment">
          <span>
            {draftPin
              ? `Comment for pin ${nextNumber}${draftLabel ? `, on "${draftLabel}"` : ""}`
              : "Add a general comment"}
          </span>
          {draftPin ? (
            <button type="button" className="link-button" onClick={onClearPin}>
              Remove pin
            </button>
          ) : null}
        </label>
        <textarea
          id="new-comment"
          ref={composerRef}
          className="textarea"
          rows={3}
          value={body}
          onChange={(event) => onBody(event.target.value)}
          placeholder={draftPin ? "What should change here?" : "Or click the design to pin one to a spot."}
        />
        {saved ? <p className="hint">Draft kept in this browser until you post it.</p> : null}
        {error ? <p className="hint-error">{error}</p> : null}
        <div className="comment-composer-actions">
          <Button variant="primary" onClick={post} disabled={posting || body.trim().length === 0}>
            {posting ? "Posting..." : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentCard({ comment: c, detail }: { comment: DetailComment; detail: ConceptDetail }) {
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  return (
    <article className={c.resolved ? "comment is-resolved" : "comment"} id={`comment-${c.id}`}>
      <div className="comment-head">
        <span className="comment-number" aria-label={`Comment ${c.number}`}>
          {c.number}
        </span>
        <strong>{c.author}</strong>
        {c.roles.slice(0, 1).map((role) => (
          <span key={role} className="role-chip role-chip-small">
            {roleLabels[role]}
          </span>
        ))}
        <span className="comment-meta">
          <span className={`tag ${c.tag.kind === "not_sent" ? "tag-amber" : c.tag.kind === "sending" ? "tag-muted" : ""}`}>
            {c.tag.kind === "not_sent"
              ? "Not sent"
              : c.tag.kind === "sending"
                ? `Sending in v${c.tag.version}`
                : `Sent in v${c.tag.version}`}
          </span>
          {c.outcome && c.tag.kind !== "sending" ? (
            <span className={c.outcome.kind === "done" ? "tag" : "tag tag-amber"}>
              {c.outcome.kind === "done" ? `Done in v${c.outcome.version}` : `Not done in v${c.outcome.version}`}
            </span>
          ) : null}
          <span className="hint">{c.when}</span>
        </span>
      </div>
      <p className="comment-body">{c.body}</p>
      {c.outcome?.reason ? <p className={c.outcome.kind === "done" ? "hint" : "hint content-warn"}>Creative Director: {c.outcome.reason}</p> : null}
      {c.outcome?.kind === "done" && !c.resolved ? (
        <p className="hint">The Creative Director found this done. Check it on v{c.outcome.version}, then resolve it.</p>
      ) : c.outcome?.kind === "not_done" && !c.resolved && !c.canRetry && c.tag.kind === "sent" ? (
        <p className="hint-missing">
          Not done after {c.tries} tries. Reword it as a new comment, or ask the Web Designer.
        </p>
      ) : null}
      {c.version !== detail.selected.version || c.pinX === null ? (
        <p className="comment-where">
          {c.pinX === null ? "General comment" : "Pinned"} on v{c.version}
        </p>
      ) : null}

      {c.replies.map((r) => (
        <div key={r.id} className="comment-reply">
          <div className="comment-head">
            <strong>{r.author}</strong>
            {r.roles.slice(0, 1).map((role) => (
              <span key={role} className="role-chip role-chip-small">
                {roleLabels[role]}
              </span>
            ))}
            <span className="comment-meta">
              <span className="hint">{r.when}</span>
            </span>
          </div>
          <p className="comment-body">{r.body}</p>
        </div>
      ))}

      {replying ? (
        <div className="comment-reply-form">
          <label className="visually-hidden" htmlFor={`reply-${c.id}`}>
            Reply to comment {c.number}
          </label>
          <textarea
            id={`reply-${c.id}`}
            className="textarea"
            rows={2}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            autoFocus
          />
          {error ? <p className="hint-error">{error}</p> : null}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" small onClick={() => setReplying(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              small
              disabled={busy || reply.trim().length === 0}
              onClick={() =>
                startBusy(async () => {
                  setError(null);
                  const result = await addCommentAction(detail.projectId, {
                    conceptId: detail.concept.id,
                    version: c.version,
                    body: reply,
                    parentId: c.id,
                  });
                  if (!result.ok) {
                    setError(result.message);
                    return;
                  }
                  setReply("");
                  setReplying(false);
                  router.refresh();
                })
              }
            >
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <div className="comment-actions">
          <Button
            variant="secondary"
            small
            disabled={busy}
            onClick={() =>
              startBusy(async () => {
                await setCommentResolvedAction(detail.projectId, detail.concept.id, c.id, !c.resolved);
                router.refresh();
              })
            }
          >
            {c.resolved ? "Reopen" : "Resolve"}
          </Button>
          <Button variant="secondary" small onClick={() => setReplying(true)}>
            Reply
          </Button>
        </div>
      )}
    </article>
  );
}

/* ---------- Review ---------- */

function ReviewTab({ detail, polish }: { detail: ConceptDetail; polish?: PolishView | null }) {
  const { before, after } = detail.review;
  if (!after) {
    return <p className="hint">The Creative Director has not scored this version.</p>;
  }
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(1));
  const same = !before || before === after;
  /*
    The score shown is the newest on or before this version; when this
    version was never scored (a polish whose scoring failed), it belongs to
    an older one, and the tab says which (12 November 2026, CodeRabbit on
    PR #75) rather than calling its notes "this version".
  */
  const scoredVersion = detail.review.afterVersion;
  const olderScore = scoredVersion !== null && scoredVersion !== detail.selected.version;

  return (
    <div className="review-tab">
      <div className="review-head">
        <h2 className="card-title">Creative Director review</h2>
        <strong>{same ? fmt(after.average) : `${fmt(before!.average)} to ${fmt(after.average)}`}</strong>
      </div>
      <p className="hint">
        {same
          ? "Scored once so far. A concept is shown only at 4.5 or above; under that after one rewrite, TAWD holds it back."
          : "Scored before and after the improvements. A concept is shown only at 4.5 or above; under that after one rewrite, TAWD holds it back."}
      </p>
      {olderScore ? (
        <p className="hint">
          This score and its notes are for v{scoredVersion}; v{detail.selected.version} has not been scored.
        </p>
      ) : null}

      <ol className="review-list">
        {REVIEW_QUESTIONS.map((q) => {
          const now = after.questions.find((x) => x.question === q.id);
          const was = before?.questions.find((x) => x.question === q.id);
          const score = (x: typeof now) => (x?.notApplicable ? "N/A" : x?.score ?? "-");
          return (
            <li key={q.id}>
              <div className="review-row">
                <strong>{q.title}</strong>
                <span className={now && !now.notApplicable && (now.score ?? 5) < 3 ? "review-score is-low" : "review-score"}>
                  {same || !was ? score(now) : `${score(was)} to ${score(now)}`}
                </span>
              </div>
              {now?.reason ? <p className="hint">{now.reason}</p> : null}
              {now && now.notes.length > 0 ? (
                <ul className="review-notes">
                  {now.notes.map((n, i) => (
                    <li key={i}>
                      <strong>{n.section}:</strong> {n.problem} {n.change}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/*
        Which ones were NOT done, and why (F33; Jason's run, 10 November
        2026). The line said "4 of 8 earlier notes and requests were
        addressed" and stopped there, so the team had to read all eight
        notes against the page to find the four that had not been made -
        while the Creative Director's own reason for each was already
        stored right here, unread.
      */}
      {after.earlierNotes.length > 0 ? (
        <>
          <p className="hint">
            {after.earlierNotes.filter((n) => n.addressed).length} of {after.earlierNotes.length} earlier
            notes and requests were addressed.
          </p>
          {after.earlierNotes.some((n) => !n.addressed) ? (
            <div className="amber-box">
              <p className="card-title">{olderScore ? `Not done in v${scoredVersion}` : "Not done in this version"}</p>
              <ul>
                {after.earlierNotes
                  .filter((n) => !n.addressed)
                  .map((note, index) => (
                    <li key={`${note.ref ?? ""}-${index}`}>
                      {note.ref ? <strong>{note.ref}: </strong> : null}
                      {note.note}
                      {note.reason ? <span className="hint"> &mdash; {note.reason}</span> : null}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {after.safetyAdvice.length > 0 ? (
        <div className="amber-box">
          <p className="card-title">For the content team to verify</p>
          <ul>
            {after.safetyAdvice.map((a, i) => (
              <li key={i}>
                {a.text} <span className="hint">({a.section})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(after.mustFix ?? []).length > 0 ? (
        <div className="amber-box">
          <p className="card-title">Must-fix, measured by TAWD</p>
          <ul>
            {after.mustFix!.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {polish ? <PolishSection detail={detail} polish={polish} /> : null}
    </div>
  );
}

/*
  Critique then polish (27 September 2026): part of every run unless the
  PM skipped it; here to see what it did, or to run it (again) on the
  newest version, the estimate first.
*/
function PolishSection({ detail, polish }: { detail: ConceptDetail; polish: PolishView }) {
  const working = polish.status === "queued" || polish.status === "working";
  const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "-" : n.toFixed(1));
  return (
    <div className="polish-section">
      <div className="review-head">
        <h2 className="card-title">Critique and polish</h2>
        {polish.status === "done" && polish.before && polish.after ? (
          <strong>
            {fmt(polish.before.average)} to {fmt(polish.after.average)}
          </strong>
        ) : null}
      </div>
      {polish.status === "none" ? (
        <p className="hint">Not run on this concept yet. One Impeccable pass: spacing rhythm, type scale, repeated decoration, identical card grids, eyebrow labels and alignment.</p>
      ) : null}
      {working ? <p className="hint hint-amber">Critiquing and polishing v{polish.fromVersion}...</p> : null}
      {polish.status === "failed" ? <p className="hint-error">{polish.failureReason ?? "The critique and polish didn't finish."}</p> : null}
      {polish.status === "done" && polish.before && polish.after ? (
        <dl className="polish-compare">
          <div>
            <dt>Before (v{polish.before.version})</dt>
            <dd>{polish.before.richness}</dd>
          </div>
          <div>
            <dt>After (v{polish.after.version})</dt>
            <dd>
              {polish.after.richness}
              {polish.after.checksPassed === false ? "; some checks failed" : ""}
            </dd>
          </div>
        </dl>
      ) : null}
      {polish.critique.length > 0 ? (
        <ol className="review-notes">
          {polish.critique.map((fix, index) => (
            <li key={index}>
              <strong>
                Band {fix.band}, {fix.area}:
              </strong>{" "}
              {fix.problem} {fix.fix}
            </li>
          ))}
        </ol>
      ) : polish.status === "done" ? (
        <p className="hint">The critique found nothing worth changing.</p>
      ) : null}
      {detail.canAct ? (
        <div className="polish-actions">
          <PaidStepButton
            id="polish"
            label={polish.status === "none" ? "Critique and polish" : "Critique and polish again"}
            confirmTitle={`Critique and polish Concept ${detail.concept.label}?`}
            confirmText={`Impeccable's critique names at most 8 fixes on v${detail.latestVersion}; the polish makes only those, one band at a time, then the checks run and the Creative Director scores it again. Words, facts, photos and brand colours never change. It makes a new version.`}
            estimateLine={polish.estimateLine}
            working={working}
            disabled={Boolean(detail.pending)}
            run={() => startPolishAction(detail.projectId, detail.concept.id)}
            stop={{ projectId: detail.projectId, kind: "polish", what: "critique and polish" }}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Checks ---------- */

const CHECK_GROUPS: { label: string; match: (id: string) => boolean }[] = [
  { label: "Text contrast", match: (id) => id === "a11y.contrast" || id === "a11y.labels" || id === "a11y.alt" },
  { label: "Tap-to-call and a contact form", match: (id) => id.startsWith("conversion.") },
  /*
    The claims guard belongs here too (10 November 2026). It was matching
    only the five oldest house rules, so house.claim.* - gap 12's guard,
    which BLOCKS GO-LIVE - and house.section.unsupported never appeared on
    this screen at all.
  */
  { label: "No invented facts", match: (id) => /^house\.(phone|license|year|reviews|placeholder|claim|section)/.test(id) },
  { label: "No filler words", match: (id) => id.startsWith("house.filler") },
  { label: "Placeholders shown clearly", match: (id) => id.startsWith("placeholders.") },
  { label: "The client's logo and photos used", match: (id) => id.startsWith("images.") },
  // icons.unfilled is fixed by code before this screen ever sees it; icons.noIcon is the warning it cannot fix.
  { label: "An icon for every word", match: (id) => id.startsWith("icons.") },
  { label: "Nothing runs off the screen", match: (id) => id.startsWith("layout.") },
  // The render check (27 September 2026).
  { label: "The footer and every planned section", match: (id) => id === "render.footer" || id === "render.sections" },
  { label: "Nothing clipped, no text over faces", match: (id) => id === "render.clipped" || id === "render.faceText" },
  { label: "Stock pictures fit the brand", match: (id) => id.startsWith("stock.") },
  { label: "Page title and description", match: (id) => id.startsWith("seo.") },
  /* Added 10 November 2026: these families were being checked and never shown. */
  { label: "The page is whole", match: (id) => id.startsWith("structure.") },
  { label: "Colour, rhythm and lines", match: (id) => id.startsWith("design.") },
  { label: "Button labels and wording", match: (id) => id.startsWith("copy.") },
  { label: "What the current site already says", match: (id) => id.startsWith("content.") },
  // A mobile rule; on a 1440-wide desktop mockup it is information only.
  { label: "Tap targets (checked on mobile at the build)", match: (id) => id === "a11y.tapTargets" },
];

/*
  The rows of the Checks tab, with EVERYTHING in one of them.

  Until today a check whose id matched no group was simply dropped from this
  screen: the card said "Some checks failed" and the list showed nothing
  wrong. Twenty ids were in that position, among them the claims guard that
  can stop a go-live. The same fault as icons.* in #62, which is why this is
  no longer a list somebody has to remember to extend - anything unmatched
  lands in a last row, so a new check can be unlabelled but never unseen.

  Issues only the intake can answer are left out: they have their own box.
*/
export type ConceptCheckIssue = { id: string; severity: string; message: string; needsIntake?: boolean };

export function checkRows(issues: ConceptCheckIssue[]): { label: string; issues: ConceptCheckIssue[] }[] {
  const mine = issues.filter((issue) => !issue.needsIntake);
  const rows = CHECK_GROUPS.map((group) => ({ label: group.label, issues: mine.filter((issue) => group.match(issue.id)) }));
  const ungrouped = mine.filter((issue) => !CHECK_GROUPS.some((group) => group.match(issue.id)));
  return ungrouped.length > 0 ? [...rows, { label: "Other checks", issues: ungrouped }] : rows;
}

/*
  The supplied homepage (HTML): what TAWD's checks did NOT do, and every note
  the reading made, in full (they used to be counted on the board and shown
  nowhere).
*/
function SuppliedNotes({ supplied }: { supplied: NonNullable<DetailVersion["supplied"]> }) {
  return (
    <div className="quiet-box">
      <p className="hint">
        This is the homepage file {supplied.fileName}, made by people. The checks TAWD runs on a page it generated (fake reviews, invented
        phone numbers, placeholders, the house rules) did not run on it, so nothing here says it passed them. The file was cleaned, not
        read as it came: scripts, inline handlers and javascript: links are taken out, and a picture or font that fails a check is left
        out. Anything that ran on a script (a menu button, an open-and-close FAQ) will not work on the kept home page.
      </p>
      {supplied.removed.length + supplied.warnings.length > 0 ? (
        <ul>
          {supplied.removed.map((note) => (
            <li key={`removed-${note}`} className="hint">
              Taken out: {note}
            </li>
          ))}
          {supplied.warnings.map((note) => (
            <li key={`warning-${note}`} className="hint">
              {note}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Nothing had to be taken out or left out.</p>
      )}
    </div>
  );
}

function ChecksTab({ detail }: { detail: ConceptDetail }) {
  const { selected } = detail;
  return (
    <div className="checks-tab">
      <h2 className="card-title">
        {selected.supplied
          ? "Not judged by TAWD's page checks"
          : selected.checksPassed === false
            ? "Some checks failed"
            : "All checks passed"}
      </h2>
      {selected.supplied ? <SuppliedNotes supplied={selected.supplied} /> : null}
      <ul className="check-list">
        {checkRows(selected.issues).map((group) => {
          const issues = group.issues;
          const failing = issues.some((i) => i.severity === "fail");
          const warning = !failing && issues.some((i) => i.severity === "warn");
          return (
            <li key={group.label} className={failing ? "is-fail" : warning ? "is-warn" : "is-pass"}>
              <span className="check-mark" aria-hidden="true">
                {failing ? "!" : warning ? "!" : <CheckIcon />}
              </span>
              <div>
                <span>{group.label}</span>
                {issues.map((i) => (
                  <p key={i.id + i.message} className={i.severity === "fail" ? "hint-error" : i.severity === "warn" ? "hint-missing" : "hint"}>
                    {i.message}
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        What TAWD's own code changed after the builder wrote the page (stage 1
        of docs/plans/self-check.md). Before this, code substituted things
        silently - every unresolved icon word became a house - and the
        Creative Director then wrote fixes the builder could not make.
      */}
      {selected.runNotes.length > 0 ? (
        <div className="quiet-box">
          <p className="card-title">What TAWD did to this page</p>
          <p className="hint">
            Changes TAWD&rsquo;s own code made after the page was written, free and automatic. The Creative Director is told about
            these, so it doesn&rsquo;t ask the builder to undo them.
          </p>
          <ul>
            {selected.runNotes.map((note) => (
              <li key={note} className="hint">
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {selected.issues.some((i) => i.needsIntake) || selected.needsIntake.length > 0 ? (
        <div className="amber-box">
          <p className="card-title">Needs intake info</p>
          <p className="hint">
            Only the client can answer these, so no automatic fix round is spent on them.
          </p>
          <ul>
            {selected.issues
              .filter((i) => i.needsIntake)
              .map((i) => (
                <li key={i.id}>{i.message}</li>
              ))}
            {selected.needsIntake.map((f) => (
              <li key={f.key}>{f.label} is not in the intake yet.</li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.placeholders.length > 0 ? (
        <div className="amber-box">
          <p className="card-title">
            {detail.placeholders.length} placeholder{detail.placeholders.length === 1 ? "" : "s"} still
            needed
          </p>
          <p className="hint">
            Facts the intake does not have yet, shown on the page as highlighted placeholders. The site
            cannot go live while any remain.
          </p>
          <ul>
            {detail.placeholders.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="hint">No placeholders on this version.</p>
      )}
    </div>
  );
}

/* ---------- Versions ---------- */

function VersionsTab({
  detail,
  onView,
  onCompare,
}: {
  detail: ConceptDetail;
  onView: (version: number) => void;
  onCompare: (version: number) => void;
}) {
  return (
    <ol className="versions-list">
      {detail.versions.map((v: DetailVersion) => {
        const isSelected = v.version === detail.selected.version;
        return (
          <li key={v.version} className={isSelected ? "is-selected" : undefined}>
            <div className="review-row">
              <strong>
                {v.label}
                {v.version === detail.latestVersion ? " (current)" : ""}
              </strong>
              <span className="hint">{v.when}</span>
            </div>
            <p className="hint">{v.note}</p>
            <div className="concept-badges">
              {v.reviewAverage !== null ? <span className="pill">Review {v.reviewAverage.toFixed(1)}</span> : null}
              {v.supplied ? (
                <span className="pill pill-muted">Supplied page, not checked by TAWD</span>
              ) : v.checksPassed === false ? (
                <span className="pill pill-amber">Checks failing</span>
              ) : (
                <span className="pill">Checks passed</span>
              )}
              {v.placeholderCount ? (
                <span className="pill pill-amber">{v.placeholderCount} placeholders</span>
              ) : null}
            </div>
            {!isSelected ? (
              <div className="row" style={{ gap: 12, marginTop: 8 }}>
                <button type="button" className="link-button" onClick={() => onView(v.version)}>
                  View
                </button>
                <button type="button" className="link-button" onClick={() => onCompare(v.version)}>
                  Compare with v{detail.selected.version}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- Request changes ---------- */

function RequestChanges({
  detail,
  notes,
  onNotes,
  onDone,
}: {
  detail: ConceptDetail;
  /** Kept in this browser until sent. */
  notes: string;
  onNotes: (notes: string) => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const openUnsent = detail.comments.filter((c) => !c.resolved && c.tag.kind === "not_sent");
  const [include, setInclude] = useState(openUnsent.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  // A paid step asks first, with the model and the estimate (standing rules 2 and 9).
  const [confirming, setConfirming] = useState(false);
  const next = detail.latestVersion + 1;
  const count = openUnsent.length;
  const ready = notes.trim().length > 0 || (include && count > 0);

  return (
    <div className="request-changes">
      <h2 className="card-title">Request changes</h2>
      <p className="hint">
        TAWD makes v{next} from your notes
        {count > 0 ? ` plus the ${count} open comment${count === 1 ? "" : "s"}` : ""}, then runs the
        checks again and the Creative Director scores it. The same direction and skill are kept.
        {count > 0 ? ` Included comments are marked "Sent in v${next}".` : ""}
      </p>

      {detail.changesBlocked ? <p className="hint-missing">{detail.changesBlocked}</p> : null}

      <div className="field">
        <label className="field-label" htmlFor="change-notes">
          <span>What should change?</span>
        </label>
        <textarea
          id="change-notes"
          className="textarea"
          rows={4}
          value={notes}
          onChange={(event) => onNotes(event.target.value)}
          placeholder="For example: use the client's brand blue #1F4E79 instead of teal, and make the phone number bigger in the header."
        />
      </div>

      {count > 0 ? (
        <label className="check-label check-label-wrap">
          <input type="checkbox" checked={include} onChange={(event) => setInclude(event.target.checked)} />
          Include the {count} open comment{count === 1 ? "" : "s"}
        </label>
      ) : null}

      <p className="hint">{detail.changesEstimate}.</p>
      {error ? <p className="hint-error">{error}</p> : null}

      {confirming ? (
        <div className="amber-box" role="alertdialog" aria-labelledby="changes-confirm-title">
          <p className="card-title" id="changes-confirm-title">
            Spend AI on v{next}?
          </p>
          <p className="hint">{detail.changesEstimate}.</p>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={confirming ? () => setConfirming(false) : onDone} disabled={sending}>
          {confirming ? "Back" : "Cancel"}
        </Button>
        {!confirming ? (
          <Button variant="primary" disabled={!ready || detail.changesBlocked !== null} onClick={() => setConfirming(true)}>
            Create v{next}
          </Button>
        ) : (
        <Button
          variant="primary"
          disabled={!ready || sending || detail.changesBlocked !== null}
          onClick={() =>
            startSending(async () => {
              setError(null);
              const result = await requestChangesAction(detail.projectId, {
                conceptId: detail.concept.id,
                notes,
                includeComments: include,
              });
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setConfirming(false);
              onNotes("");
              onDone();
              router.refresh();
            })
          }
        >
          {sending ? "Sending..." : `Yes, create v${next}`}
        </Button>
        )}
      </div>
    </div>
  );
}

/*
  The second try (Jason, 2 October 2026): never automatic. The comments
  found not done go again only when a person asks, with the estimate first.
*/
function SecondTry({ detail }: { detail: ConceptDetail }) {
  const retry = detail.comments.filter((c) => c.canRetry);
  if (retry.length === 0) return null;
  const numbers = retry.map((c) => c.number).join(", ");
  const count = retry.length;
  const one = count === 1;
  return (
    <div className="amber-box second-try">
      <p className="card-title">
        {count} comment{one ? "" : "s"} not done ({numbers})
      </p>
      <p className="hint">
        The Creative Director found {one ? "this one" : "these"} not done in the last version. Send {one ? "it" : "them"} once
        more, marked as a second try, or reword {one ? "it" : "them"} as a new comment.
      </p>
      {detail.canAct ? (
        <PaidStepButton
          id="second-try"
          label={one ? "Try it again" : `Try these ${count} again`}
          confirmTitle={`Try ${one ? "comment" : "comments"} ${numbers} again?`}
          confirmText={`TAWD makes v${detail.latestVersion + 1} from ${one ? "this comment" : "these comments"} only, marked as asked before and not done, then runs the checks and the Creative Director scores it again. This is the last automatic try for ${one ? "it" : "them"}.`}
          estimateLine={`${detail.changesEstimate}.`}
          working={Boolean(detail.pending)}
          disabled={detail.changesBlocked !== null}
          run={() => retryNotDoneAction(detail.projectId, detail.concept.id)}
        />
      ) : null}
    </div>
  );
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-5M12 8h.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
