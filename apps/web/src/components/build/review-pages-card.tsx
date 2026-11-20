"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { approveUnchangedPagesAction, overridePageReviewAction } from "@/app/actions";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  Review pages on Build › Check (step 3a, 3 October 2026): every page of the
  latest build, approved or to review. A PM, the Web Designer, a founder or
  an admin opens each page in TAWD, comments on its sections and approves
  it. Go-live waits for every page, unless a founder lets this version go.
*/

export interface ReviewPageRow {
  pageId: string;
  name: string;
  path: string;
  /** "Approved by Sam on v5", or null while to review. */
  approvedLine: string | null;
  partsChangedOnly: boolean;
  openComments: number;
}

export function ReviewPagesCard(props: {
  projectId: string;
  version: number;
  pages: ReviewPageRow[];
  canReview: boolean;
  canOverride: boolean;
  /** "Todd let version 5 go live with 6 of 8 pages approved", once a founder has. */
  overriddenLine: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const approved = props.pages.filter((p) => p.approvedLine).length;
  const all = approved === props.pages.length;
  const first = props.pages.find((p) => !p.approvedLine) ?? props.pages[0];
  const unchanged = props.pages.filter((p) => p.partsChangedOnly).length;
  const href = (pageId: string) => `/projects/${props.projectId}/build/review/${encodeURIComponent(pageId)}`;
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
    <div className="card content-card" id="review-pages">
      <div>
        <h2 className="card-title">Review pages</h2>
        <p className="hint">
          Each page is checked in TAWD before go-live: click a section to comment on it, then approve the page. PMs, the
          Web Designer and founders can approve. An approval carries over to a new version while the page, header and
          footer stay the same.
        </p>
      </div>
      <p className={all || props.overriddenLine ? "content-done-line" : "hint content-warn"}>
        {all
          ? `Version ${props.version}: all ${props.pages.length} pages approved.`
          : props.overriddenLine ?? `Version ${props.version}: ${approved} of ${props.pages.length} pages approved. Go-live waits for the rest.`}
      </p>
      <ul className="seo-checks seo-checks-wide">
        {props.pages.map((p) => (
          <li key={p.pageId}>
            <span className={p.approvedLine ? "badge badge-done" : "badge badge-missing"}>{p.approvedLine ? "Approved" : "To review"}</span>
            <div>
              <p className="seo-check-label">
                <Link href={href(p.pageId)}>{p.name}</Link> <span className="hint">{p.path}</span>
              </p>
              <p className="hint">
                {[
                  p.approvedLine,
                  !p.approvedLine && p.partsChangedOnly ? "Approved before; only the header or footer changed since" : null,
                  p.openComments ? `${p.openComments} open comment${p.openComments === 1 ? "" : "s"}` : null,
                ]
                  .filter(Boolean)
                  .join(". ") || "Not reviewed yet"}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {error ? <p className="hint-error">{error}</p> : null}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {first ? (
          <ButtonLink variant="primary" small href={href(first.pageId)}>
            {all ? "Open the review" : approved === 0 ? "Start reviewing" : "Review the next page"}
          </ButtonLink>
        ) : null}
        {props.canReview && unchanged > 0 ? (
          <Button small disabled={busy} onClick={() => run(() => approveUnchangedPagesAction(props.projectId))}>
            Approve all unchanged ({unchanged})
          </Button>
        ) : null}
        {props.canOverride && !all && !props.overriddenLine ? (
          <Button small variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
            Let it go live anyway
          </Button>
        ) : null}
      </div>

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pages-override-title">
            <h2 className="section-title" id="pages-override-title">
              Let version {props.version} go live without every page approved?
            </h2>
            <p className="hint">
              {props.pages.length - approved} page{props.pages.length - approved === 1 ? " isn't" : "s aren't"} approved:{" "}
              {props.pages
                .filter((p) => !p.approvedLine)
                .map((p) => p.name)
                .join(", ")}
              . Recorded with your name and the time, for this version only; a new version needs its pages approved again.
            </p>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => overridePageReviewAction(props.projectId), () => setConfirming(false))}>
                Let it go live
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
