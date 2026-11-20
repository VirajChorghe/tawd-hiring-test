"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import {
  addReviewCommentAction,
  approveReviewedPageAction,
  markReviewCommentAction,
  setReviewCommentResolvedAction,
  startPageFixAction,
  withdrawPageApprovalAction,
} from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import { Button } from "@/components/ui/button";
import type { FixView } from "@/lib/page-review";
import { BLUE, box, elementFor, pinPoint, pinSpot, sectionAt, type Area } from "@/lib/page-review-dom";

/*
  The page review (step 3a, 3 October 2026). DESIGN.md, "The page review".

  Left: the real page of the latest build, in TAWD's own viewer, at computer
  or phone width. Moving over it outlines the section under the mouse (the
  header, the footer, or a part of the page's own content); clicking pins a
  comment there. Links and forms don't act while reviewing. Right: approve
  this page, its comments, and the next page.

  Pins are kept relative to their section (percent of its width and
  height), so they stay on it at either width and as pictures load.
*/


export interface ReviewComment {
  id: string;
  number: number;
  version: number;
  author: string;
  body: string;
  area: Area | null;
  section: number | null;
  sectionLabel: string | null;
  pinX: number | null;
  pinY: number | null;
  resolved: boolean;
  /** Not sent, being fixed, or sent in version N (Fix these). */
  tag: { kind: "not_sent" | "sending" | "sent"; version: number | null };
  /** After its fix (3c): whether its part changed in that version, by code. */
  change?: "changed" | "unchanged" | null;
  /** The reviewer's Done or Not done, on which version. */
  outcome?: { kind: "done" | "not_done"; version: number } | null;
  /** Not done twice: "Ask the Web Designer". */
  askDesigner?: boolean;
  when: string;
  replies: { id: string; author: string; body: string; when: string }[];
}

type Pin = { area: Area; section: number | null; label: string; x: number; y: number };
type Draft = { body: string; pin: (Pin & { version: number }) | null };

const WIDTHS = { computer: 1280, phone: 390 } as const;
const draftKey = (projectId: string, pageId: string) => `tawd:page-review:${projectId}:${pageId}`;

function readDraft(projectId: string, pageId: string): Draft {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId, pageId));
    const value = raw ? (JSON.parse(raw) as Partial<Draft>) : null;
    return { body: typeof value?.body === "string" ? value.body : "", pin: value?.pin && typeof value.pin.version === "number" ? value.pin : null };
  } catch {
    return { body: "", pin: null };
  }
}

function writeDraft(projectId: string, pageId: string, draft: Draft) {
  try {
    if (!draft.body.trim() && !draft.pin) window.localStorage.removeItem(draftKey(projectId, pageId));
    else window.localStorage.setItem(draftKey(projectId, pageId), JSON.stringify(draft));
  } catch {
    // Kept on this page only.
  }
}

export function PageReviewScreen(props: {
  projectId: string;
  version: number;
  page: { pageId: string; name: string; path: string };
  frameSrc: string;
  position: { index: number; of: number };
  approvedCount: number;
  approvedLine: string | null;
  partsChangedOnly: boolean;
  next: { pageId: string; name: string } | null;
  pages: { pageId: string; name: string; approved: boolean }[];
  canApprove: boolean;
  /** Fix these (3b): PMs, the Web Designer, founders and admins, on Lane 1 sites. */
  canFix: boolean;
  fix: FixView | null;
  fixEstimate: string;
  comments: ReviewComment[];
}) {
  const router = useRouter();
  const [width, setWidth] = useState<keyof typeof WIDTHS>("computer");
  const [scale, setScale] = useState(1);
  const [loaded, setLoaded] = useState(0);
  const [draft, setDraftState] = useState<Draft>({ body: "", pin: null });
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [showResolved, setShowResolved] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const href = (pageId: string) => `/projects/${props.projectId}/build/review/${encodeURIComponent(pageId)}`;

  const pin = draft.pin && draft.pin.version === props.version ? draft.pin : null;
  const open = props.comments.filter((c) => !c.resolved);
  const resolved = props.comments.filter((c) => c.resolved);
  const nextNumber = props.comments.length + 1;

  // The draft comes back after the first paint (the server has no browser storage).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Anything typed before the saved draft came back wins.
      setDraftState((current) => (current.body || current.pin ? current : readDraft(props.projectId, props.page.pageId)));
      setDraftLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [props.projectId, props.page.pageId]);
  const setDraft = (change: Partial<Draft>) =>
    setDraftState((current) => {
      const next = { ...current, ...change };
      writeDraft(props.projectId, props.page.pageId, next);
      return next;
    });

  // The page drawn at the chosen width, scaled down to fit the card.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const fit = () => setScale(Math.min(1, holder.clientWidth / WIDTHS[width]));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [width]);

  // What a click in the page does, kept current for the listeners inside it.
  const onPin = useRef<(pin: Pin) => void>(() => undefined);
  useEffect(() => {
    onPin.current = (p: Pin) => {
      setDraftState((current) => {
        const next = { ...current, pin: { ...p, version: props.version } };
        writeDraft(props.projectId, props.page.pageId, next);
        return next;
      });
      setTimeout(() => composerRef.current?.focus(), 0);
    };
  }, [props.version, props.projectId, props.page.pageId]);

  // Inside the page: the outline under the mouse, clicks become pins, links and forms stay put.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !loaded || !doc.body) return;
    const style = doc.createElement("style");
    style.textContent = `.tawd-review-outline{position:absolute;pointer-events:none;border:2px solid ${BLUE};background:rgb(32 90 242 / 6%);z-index:2147483646;display:none;box-sizing:border-box}
.tawd-review-outline span{position:absolute;top:6px;left:6px;padding:3px 10px;border-radius:999px;background:${BLUE};color:#fff;font:600 12px/1.4 system-ui,sans-serif;white-space:nowrap}
.tawd-review-pin{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:999px;border:2px solid #fff;background:${BLUE};color:#fff;font:700 13px/24px system-ui,sans-serif;text-align:center;z-index:2147483647;box-shadow:0 2px 6px rgb(24 33 43 / 30%);cursor:pointer;box-sizing:border-box}
.tawd-review-pin.is-draft{background:#B7791F}
html,body{cursor:crosshair}`;
    doc.head.appendChild(style);
    const outline = doc.createElement("div");
    outline.className = "tawd-review-outline";
    outline.appendChild(doc.createElement("span"));
    doc.body.appendChild(outline);

    const onMove = (event: MouseEvent) => {
      const hit = event.target instanceof doc.defaultView!.Element ? sectionAt(doc, event.target) : null;
      if (!hit) {
        outline.style.display = "none";
        return;
      }
      const b = box(hit.el);
      Object.assign(outline.style, { display: "block", left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
      outline.firstElementChild!.textContent = hit.label;
    };
    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const target = event.target as Element;
      const pinId = target.closest?.("[data-tawd-pin]")?.getAttribute("data-tawd-pin");
      if (pinId) {
        document.getElementById(`review-comment-${pinId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      const hit = sectionAt(doc, target);
      if (!hit) return;
      const { x, y } = pinSpot(box(hit.el), event.pageX, event.pageY);
      onPin.current({ area: hit.area, section: hit.section, label: hit.label, x, y });
    };
    const stop = (event: Event) => event.preventDefault();
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("submit", stop, true);
    return () => {
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("submit", stop, true);
      outline.remove();
      style.remove();
    };
  }, [loaded]);

  // The pins, drawn on their sections, and drawn again whenever the page's layout moves.
  const drawPins = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    doc.querySelectorAll(".tawd-review-pin").forEach((p) => p.remove());
    const marks: { id: string; number: number; area: Area; section: number | null; x: number; y: number; draft?: boolean }[] = [
      ...open
        .filter((c) => c.area && c.pinX !== null && c.pinY !== null)
        .map((c) => ({ id: c.id, number: c.number, area: c.area!, section: c.section, x: c.pinX!, y: c.pinY! })),
      ...(pin ? [{ id: "", number: nextNumber, area: pin.area, section: pin.section, x: pin.x, y: pin.y, draft: true }] : []),
    ];
    for (const mark of marks) {
      const el = elementFor(doc, mark.area, mark.section);
      if (!el) continue;
      const b = box(el);
      const dot = doc.createElement("div");
      dot.className = mark.draft ? "tawd-review-pin is-draft" : "tawd-review-pin";
      if (mark.id) dot.setAttribute("data-tawd-pin", mark.id);
      dot.textContent = String(mark.number);
      const at = pinPoint(b, mark.x, mark.y);
      dot.style.left = `${at.left}px`;
      dot.style.top = `${at.top}px`;
      doc.body.appendChild(dot);
    }
  }, [open, pin, nextNumber]);

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body || !loaded) return;
    drawPins();
    const observer = new ResizeObserver(() => drawPins());
    observer.observe(doc.documentElement);
    return () => observer.disconnect();
  }, [loaded, drawPins, width]);

  const act = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      after?.();
      router.refresh();
    });

  const post = () =>
    act(
      () =>
        addReviewCommentAction(props.projectId, {
          pageId: props.page.pageId,
          body: draft.body,
          area: pin?.area ?? null,
          section: pin?.section ?? null,
          sectionLabel: pin?.label ?? null,
          pinX: pin?.x ?? null,
          pinY: pin?.y ?? null,
        }),
      () => setDraft({ body: "", pin: null }),
    );

  const frameHeight = 760;
  return (
    <div className="page">
      <div className="review-layout">
        <div className="card review-canvas">
          <div className="review-canvas-head">
            <label className="review-page-pick">
              <span className="visually-hidden">Page</span>
              <select className="select" value={props.page.pageId} onChange={(event) => router.push(href(event.target.value))}>
                {props.pages.map((p, i) => (
                  <option key={p.pageId} value={p.pageId}>
                    {i + 1}. {p.name}
                    {p.approved ? " (approved)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">
              Page {props.position.index} of {props.position.of}, version {props.version}. Click a section to comment on it.
            </span>
            <div className="segmented" role="group" aria-label="Width">
              {(["computer", "phone"] as const).map((w) => (
                <button key={w} type="button" className="segment" aria-pressed={width === w} onClick={() => setWidth(w)}>
                  {w === "computer" ? "Computer" : "Phone"}
                </button>
              ))}
            </div>
          </div>
          <div className="review-frame-holder" ref={holderRef} style={{ height: frameHeight }}>
            <iframe
              ref={frameRef}
              key={width}
              title={`${props.page.name}, version ${props.version}`}
              src={props.frameSrc}
              className="review-frame"
              onLoad={() => setLoaded((n) => n + 1)}
              style={{
                width: WIDTHS[width],
                height: frameHeight / scale,
                transform: `scale(${scale})`,
                left: width === "phone" ? `calc(50% - ${(WIDTHS.phone * scale) / 2}px)` : 0,
              }}
            />
          </div>
        </div>

        <aside className="card review-panel" aria-label="Page review">
          <div className="review-approve">
            <h2 className="card-title">{props.page.name}</h2>
            {props.approvedLine ? (
              <>
                <p className="content-done-line">{props.approvedLine}</p>
                {props.canApprove ? (
                  <button type="button" className="link-button" disabled={busy} onClick={() => act(() => withdrawPageApprovalAction(props.projectId, props.page.pageId))}>
                    Take the approval back
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <p className="hint">
                  {props.partsChangedOnly
                    ? "Approved before; only the header or footer changed since. Check them, then approve again."
                    : "Not approved yet. Go-live waits until every page is."}
                  {open.length ? ` ${open.length} comment${open.length === 1 ? " is" : "s are"} still open.` : ""}
                </p>
                {props.canApprove ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => act(() => approveReviewedPageAction(props.projectId, props.page.pageId), () => (props.next ? router.push(href(props.next.pageId)) : undefined))}
                  >
                    {props.next ? "Approve and go to the next page" : "Approve this page"}
                  </Button>
                ) : (
                  <p className="hint">A PM, the Web Designer or a founder approves pages.</p>
                )}
              </>
            )}
            <p className="hint">
              {props.approvedCount} of {props.position.of} pages approved.{" "}
              {props.next ? <Link href={href(props.next.pageId)}>Next to review: {props.next.name}</Link> : null}{" "}
              <Link href={`/projects/${props.projectId}/build?part=check#review-pages`}>Back to Build</Link>
            </p>
          </div>

          <FixThese
            projectId={props.projectId}
            pageId={props.page.pageId}
            version={props.version}
            canFix={props.canFix}
            fix={props.fix}
            estimate={props.fixEstimate}
            unsent={open.filter((c) => c.tag.kind === "not_sent").length}
          />

          <FixCheck fix={props.fix} version={props.version} />

          <div className="comments">
            {open.length === 0 && resolved.length === 0 ? <p className="hint">No comments on this page yet.</p> : null}
            {open.map((c) => (
              <ReviewCommentCard key={c.id} comment={c} projectId={props.projectId} pageId={props.page.pageId} version={props.version} canMark={props.canApprove} />
            ))}
            {resolved.length ? (
              <div>
                <button type="button" className="link-button" onClick={() => setShowResolved((v) => !v)}>
                  {showResolved ? "Hide" : "Show"} resolved ({resolved.length})
                </button>
                {showResolved ? resolved.map((c) => <ReviewCommentCard key={c.id} comment={c} projectId={props.projectId} pageId={props.page.pageId} version={props.version} canMark={false} />) : null}
              </div>
            ) : null}

            <div className="field comment-composer">
              <label className="field-label" htmlFor="review-comment">
                <span>{pin ? `Comment ${nextNumber}, on "${pin.label}"` : "A comment on the whole page"}</span>
                {pin ? (
                  <button type="button" className="link-button" onClick={() => setDraft({ pin: null })}>
                    Remove pin
                  </button>
                ) : null}
              </label>
              <textarea
                id="review-comment"
                ref={composerRef}
                className="textarea"
                rows={3}
                value={draft.body}
                onChange={(event) => setDraft({ body: event.target.value })}
                placeholder={pin ? "What should change here?" : "Or click a section of the page to pin one there."}
              />
              {draftLoaded && draft.body.trim() ? <p className="hint">Draft kept in this browser until you post it.</p> : null}
              {error ? <p className="hint-error">{error}</p> : null}
              <div className="comment-composer-actions">
                <Button variant="primary" onClick={post} disabled={busy || draft.body.trim().length === 0}>
                  {busy ? "Posting..." : "Post comment"}
                </Button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/*
  Fix these (step 3b, 3 October 2026): the page's comments that haven't been
  sent go to the AI with only the parts they're on, then a new version is
  built from the saved sources (free). The estimate shows first.
*/
function FixThese(props: { projectId: string; pageId: string; version: number; canFix: boolean; fix: FixView | null; estimate: string; unsent: number }) {
  const working = props.fix ? ["queued", "fixing", "building"].includes(props.fix.status) : false;
  if (!props.canFix && !working && !props.fix) return null;
  const made = props.fix?.status === "done" && props.fix.resultVersion === props.version;
  return (
    <div className="review-fix">
      <h3 className="wireframe-heading">Fix these</h3>
      {working ? (
        <p className="hint hint-amber" role="status">
          {props.fix!.detail ?? "Working"}&hellip; about a minute or two; this page updates when the new version is ready.
        </p>
      ) : props.fix?.status === "failed" ? (
        <p className="hint-error">The last fix didn&rsquo;t finish: {props.fix.failureReason ?? "no reason was given."}</p>
      ) : made ? (
        <p className="content-done-line">
          This is version {props.version}, made from the comments{props.fix!.changed.length ? ` (changed: ${props.fix!.changed.join(", ")})` : ""}. Check it, then approve or comment again.
        </p>
      ) : null}
      {props.canFix ? (
        <>
          <p className="hint">
            {props.unsent
              ? `TAWD changes only the parts the ${props.unsent} unsent comment${props.unsent === 1 ? " is" : "s are"} on, then builds a new version of the site from the saved pages (no AI for the other pages).`
              : "Pin a comment on the page first: Fix these sends the ones not sent yet."}
          </p>
          <PaidStepButton
            id="page-fix"
            label={props.unsent ? `Fix these (${props.unsent})` : "Fix these"}
            confirmTitle={`Fix ${props.unsent} comment${props.unsent === 1 ? "" : "s"} on this page?`}
            confirmText={`TAWD sends only the commented parts of version ${props.version}, with a picture of each, makes the changes, then builds the next version of the site. The other pages stay exactly as they are. TAWD then checks the changed parts (free); if it finds a problem (a phone number or button on two lines, something sticking out, a picture missing), the AI tries once more, never twice. Approvals on this page (and on every page, if the header or footer changes) are asked again.`}
            estimateLine={`${props.estimate}.`}
            working={working}
            disabled={props.unsent === 0}
            run={() => startPageFixAction(props.projectId, props.pageId)}
          />
        </>
      ) : null}
    </div>
  );
}

/*
  TAWD's check after a fix (3c, 5 October 2026): free, by code. What it
  found on the version the comments ended in, as a warning above the
  comments; whether it tried once more and how that went.
*/
export function FixCheck({ fix, version }: { fix: FixView | null; version: number }) {
  if (!fix || fix.status !== "done" || fix.resultVersion !== version || !fix.check) return null;
  const { first, final, firstVersion, finalVersion, retryNote } = fix.check;
  if (final.length === 0 && first.length === 0) {
    return <p className="hint">TAWD&rsquo;s check found nothing wrong in the changed parts (wrapping, things sticking out, pictures).</p>;
  }
  if (final.length === 0) {
    return (
      <p className="notice" role="status">
        TAWD&rsquo;s check found a problem on version {firstVersion} and tried once more: version {finalVersion} passed the check.
      </p>
    );
  }
  return (
    <div className="amber-box" role="status">
      <p className="card-title">TAWD&rsquo;s check found:</p>
      <ul>
        {final.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="hint">
        {retryNote
          ? `It tried once more, but that didn't make a version (${retryNote.replace(/\.$/, "")}). This is version ${finalVersion}, from the first try.`
          : finalVersion !== firstVersion
            ? `It tried once more (version ${finalVersion}) and stopped there. Check these on the page, then comment again or ask the Web Designer.`
            : "Check these on the page, then comment again or ask the Web Designer."}
      </p>
    </div>
  );
}

function ReviewCommentCard({ comment: c, projectId, pageId, version, canMark }: { comment: ReviewComment; projectId: string; pageId: string; version: number; canMark: boolean }) {
  const router = useRouter();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const where = c.area === "header" ? "Header" : c.area === "footer" ? "Footer" : c.area === "main" ? (c.sectionLabel ?? "A section") : "The whole page";
  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      after?.();
      router.refresh();
    });

  return (
    <article className={c.resolved ? "comment is-resolved" : "comment"} id={`review-comment-${c.id}`}>
      <div className="comment-head">
        <span className="comment-number" aria-label={`Comment ${c.number}`}>
          {c.number}
        </span>
        <strong>{c.author}</strong>
        <span className="comment-meta">
          <span className={`tag ${c.tag.kind === "not_sent" ? "tag-amber" : c.tag.kind === "sending" ? "tag-muted" : ""}`}>
            {c.tag.kind === "not_sent" ? "Not sent" : c.tag.kind === "sending" ? "Being fixed" : `Sent in v${c.tag.version}`}
          </span>
          {c.tag.kind === "sent" && c.change ? (
            <span className={c.change === "changed" ? "tag" : "tag tag-amber"}>{c.change === "changed" ? `Changed in v${c.tag.version}` : "Nothing changed here"}</span>
          ) : null}
          {c.outcome && c.tag.kind !== "sending" ? (
            <span className={c.outcome.kind === "done" ? "tag" : "tag tag-amber"}>
              {c.outcome.kind === "done" ? `Done in v${c.outcome.version}` : `Not done in v${c.outcome.version}`}
            </span>
          ) : null}
          <span className="hint">{c.when}</span>
        </span>
      </div>
      <p className="comment-body">{c.body}</p>
      <p className="comment-where">
        {where}
        {c.version !== version ? `, on version ${c.version}` : ""}
      </p>
      {c.askDesigner ? <p className="hint hint-amber">Not done twice. Ask the Web Designer before sending it again.</p> : null}
      {canMark && c.tag.kind === "sent" && !c.resolved ? (
        <div className="comment-actions">
          <span className="hint">Done in v{c.tag.version}?</span>
          <Button variant="secondary" small disabled={busy} onClick={() => run(() => markReviewCommentAction(projectId, c.id, "done"))}>
            Done
          </Button>
          <Button variant="secondary" small disabled={busy} onClick={() => run(() => markReviewCommentAction(projectId, c.id, "not_done"))}>
            Not done
          </Button>
        </div>
      ) : null}
      {c.replies.map((r) => (
        <div key={r.id} className="comment-reply">
          <div className="comment-head">
            <strong>{r.author}</strong>
            <span className="comment-meta">
              <span className="hint">{r.when}</span>
            </span>
          </div>
          <p className="comment-body">{r.body}</p>
        </div>
      ))}
      {error ? <p className="hint-error">{error}</p> : null}
      {replying ? (
        <div className="comment-reply-form">
          <label className="visually-hidden" htmlFor={`review-reply-${c.id}`}>
            Reply to comment {c.number}
          </label>
          <textarea id={`review-reply-${c.id}`} className="textarea" rows={2} value={reply} onChange={(event) => setReply(event.target.value)} autoFocus />
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" small onClick={() => setReplying(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              small
              disabled={busy || reply.trim().length === 0}
              onClick={() =>
                run(
                  () => addReviewCommentAction(projectId, { pageId, body: reply, parentId: c.id }),
                  () => {
                    setReply("");
                    setReplying(false);
                  },
                )
              }
            >
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <div className="comment-actions">
          <Button variant="secondary" small disabled={busy} onClick={() => run(() => setReviewCommentResolvedAction(projectId, c.id, !c.resolved))}>
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
