"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { startDesignCopyAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  Lane 2, Option B: the faithful copy card on Mockups. The designer's
  homepage rebuilt as a working web page, nothing changed, with how
  closely it matches the Figma frame. Building it is paid, so the button
  opens a confirmation with the estimate first.
*/

export interface DesignCopyCardProps {
  projectId: string;
  canRun: boolean;
  estimate: string;
  limitBlocked: string | null;
  /** The logo and icons kept at import; null when the import is from before they were kept. */
  drawings: { logos: number; icons: number } | null;
  copy: {
    status: "queued" | "working" | "done" | "failed" | "needs_cleanup";
    failureReason: string | null;
    match: number | null;
    weakest: { name: string; score: number }[];
    line: string;
    imageUrl: string | null;
    outOfDate: boolean;
    lowMatch: boolean;
  } | null;
}

export function DesignCopyCard(props: DesignCopyCardProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const copy = props.copy;
  const working = copy?.status === "queued" || copy?.status === "working";

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const startButton = (label: string, variant: "primary" | "secondary") =>
    props.canRun ? (
      <Button variant={variant} disabled={busy || Boolean(props.limitBlocked)} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    ) : null;

  return (
    <section className="card design-copy-card" aria-label="Faithful copy">
      <div className="designer-design-head">
        <div className="design-copy-main">
          <p className="concept-card-title">Faithful copy</p>
          {!copy ? (
            <p className="hint">
              TAWD rebuilds the designer&rsquo;s homepage as a working web page, exactly as designed: live text, real
              headings, a tappable phone and the design&rsquo;s own images. Nothing is fixed in this step. Then it
              compares the page with the Figma frame, for free.
            </p>
          ) : working ? (
            <div className="stop-line">
              <p className="concept-working" role="status">
                Building the copy from the Figma design. It takes a few minutes; this page updates when it&rsquo;s done.
              </p>
              <StopButton projectId={props.projectId} kind="copies" what="the copy" />
            </div>
          ) : copy.status === "failed" ? (
            <p className="hint-error">The copy didn&rsquo;t finish: {copy.failureReason}</p>
          ) : (
            <>
              <p className="design-review-score">Matches the design: {copy.match}%</p>
              {copy.status === "needs_cleanup" ? <p className="hint-missing">Not done: {copy.failureReason}</p> : null}
              {copy.weakest.length > 0 ? (
                <p className="hint">
                  Least alike: {copy.weakest.map((s) => `${s.name} (${s.score}%)`).join(", ")}.
                </p>
              ) : null}
              {copy.lowMatch ? (
                <p className="hint-missing">
                  Under 80%: compare it with the design, and build it again if it is too far off.
                </p>
              ) : null}
              <p className="hint">{copy.line}</p>
              {copy.outOfDate ? (
                <p className="hint-missing">The design was imported again since this copy. Build it again to copy the latest.</p>
              ) : null}
            </>
          )}
          {!copy || copy.status === "failed" ? (
            <p className="hint">
              {props.estimate}.{props.limitBlocked ? ` ${props.limitBlocked}` : ""}
            </p>
          ) : null}
          {props.drawings === null ? (
            <p className="hint-missing">
              This import is from before TAWD kept the design&rsquo;s logo and icons. Import the design again first (up to
              2 Figma reads) so the copy can use them.
            </p>
          ) : !copy ? (
            <p className="hint">
              <Badge kind="done">From the import</Badge>{" "}
              {props.drawings.logos + props.drawings.icons === 0
                ? "No drawn logo or icons in the design; its photos are used."
                : `${props.drawings.logos > 0 ? "The logo" : "No logo"} and ${props.drawings.icons} icon${props.drawings.icons === 1 ? "" : "s"}, with the design’s photos.`}
            </p>
          ) : null}
          {error ? <p className="hint-error">{error}</p> : null}
        </div>
        <div className="designer-design-actions">
          {copy?.status === "done" || copy?.status === "needs_cleanup" ? (
            <>
              <ButtonLink variant="primary" href={`/projects/${props.projectId}/mockups/design/copy`}>
                Open the copy
              </ButtonLink>
              {startButton("Build again", "secondary")}
            </>
          ) : working ? null : (
            startButton(copy ? "Build again" : "Build the faithful copy", "primary")
          )}
        </div>
        {(copy?.status === "done" || copy?.status === "needs_cleanup") && copy.imageUrl ? (
          <a className="design-copy-thumb" href={`/projects/${props.projectId}/mockups/design/copy`} aria-label="Open the copy">
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link */}
            <img src={copy.imageUrl} alt="The faithful copy's first screen" />
          </a>
        ) : null}
      </div>

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="design-copy-title">
            <h2 className="section-title" id="design-copy-title">
              {copy ? "Build the copy again?" : "Build the faithful copy?"}
            </h2>
            <p className="hint">
              TAWD rebuilds the designer&rsquo;s homepage as a web page a few sections at a time, nothing changed (one AI
              call per group of sections). A visual check then compares every section with the design, and any that differ
              are built once more. The comparison with the Figma frame is free.{copy ? " The new copy replaces this one on the page." : ""}
            </p>
            <p className="hint">{props.estimate}.</p>
            <div className="modal-actions">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await startDesignCopyAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Build the copy"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
