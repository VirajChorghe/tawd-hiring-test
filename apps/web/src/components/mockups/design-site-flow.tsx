"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  approveSeoAction,
  checkDesignBuildAction,
  decideOpenSuggestionsAction,
  decideSuggestionAction,
  deployPreviewAction,
  recordPreviewDecisionAction,
  refreshDesignSiteAction,
  renameDesignPagesAction,
  reworkDesignPageAction,
  saveSiteVideosAction,
  skipDesignReviewAction,
  startDesignBuildAction,
  startDesignReviewAction,
} from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import { Button } from "@/components/ui/button";
import { StopButton } from "@/components/ui/stop-button";
import type { DesignFlowView } from "@/lib/design-site";

/*
  Lane 2, simply (Jason, 29 September 2026): three steps on one card.
  1 Design: what was uploaded. 2 Build: the pages (names and addresses, the
  videos), the home page first by default, the estimate first. 3 Preview:
  each design page beside its built page, what the automatic check noted,
  its search listing, feedback that reworks only that page; deploy, share,
  approve; then launch.
*/

type Page = DesignFlowView["pages"][number];
type Built = NonNullable<DesignFlowView["preview"]>["pages"][number];

export function DesignSiteFlow({ projectId, view }: { projectId: string; view: DesignFlowView }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const working = view.building?.status === "queued" || view.building?.status === "working" || view.site.deploying;
  const reviewing = view.review?.status === "queued" || view.review?.status === "working" || view.check?.state === "running";

  useEffect(() => {
    if (!reviewing) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [reviewing, router]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      router.refresh();
    });

  const locked = Boolean(view.review && !view.review.done);

  return (
    <div className="card design-flow">
      {/* The header's step bar is the only one (29 September 2026): no second strip here. */}
      {error ? <p className="hint-error">{error}</p> : null}

      {view.review ? (
        <ReviewSection projectId={projectId} view={view} review={view.review} busy={busy} run={run} />
      ) : (
      <section className="flow-section" id="client-design">
        <h2 className="card-title">The client&rsquo;s design</h2>
        {view.design.ready ? (
          <p className="hint">
            {view.design.pages} page{view.design.pages === 1 ? "" : "s"} from {view.design.source}. The site is built close to them: their colours, fonts, photos, words and icons,
            as ordinary pages that work on phones too.{" "}
            <a className="plain-link" href={`/projects/${projectId}/intake?section=figma`}>
              Open the design
            </a>
          </p>
        ) : (
          <p className="hint">
            Upload the design (a PDF, images, or a Figma link) in the intake&rsquo;s Design section.{" "}
            <a className="plain-link" href={`/projects/${projectId}/intake?section=figma`}>
              Go to the Design section
            </a>
          </p>
        )}
      </section>
      )}

      {view.design.ready ? <BuildStep projectId={projectId} view={view} busy={busy} run={run} working={working} locked={locked} /> : null}
      {view.preview ? <PreviewStep projectId={projectId} view={view} busy={busy} run={run} /> : null}
      {view.optionB && view.design.ready ? (
        <p className="hint flow-alternatives">
          Want other designs to compare?{" "}
          <a className="plain-link" href={`/projects/${projectId}/mockups?classic=1`}>
            Build alternatives or open the concept board
          </a>{" "}
          (paid; the estimate shows before anything runs).
        </p>
      ) : null}
    </div>
  );
}

type Run = (a: () => Promise<{ ok: true } | { ok: false; message: string }>) => void;
type Review = NonNullable<DesignFlowView["review"]>;

/* Option B's first step: the review (paid, estimate first), then a yes or no for each suggestion; or skip it for $0. */
function ReviewSection({ projectId, view, review, busy, run }: { projectId: string; view: DesignFlowView; review: Review; busy: boolean; run: Run }) {
  const running = review.status === "queued" || review.status === "working";
  const open = review.suggestions.filter((s) => s.decision === "open").length;
  const accepted = review.suggestions.filter((s) => s.decision === "accepted").length;
  const reviewButton = (label: string, variant: "primary" | "secondary") => (
    <PaidStepButton
      id="design-review"
      variant={variant}
      label={label}
      confirmTitle="Review the design?"
      confirmText="The Creative Director looks at the home page's design and suggests changes, each with where it is and why. You accept or reject each one; the accepted ones go into the build."
      estimateLine={review.estimate.label}
      working={false}
      run={() => startDesignReviewAction(projectId)}
    />
  );
  return (
    <section className="flow-section" id="review">
      <h2 className="card-title">Review &amp; suggestions</h2>
      <p className="hint">
        {view.design.pages} page{view.design.pages === 1 ? "" : "s"} from {view.design.source}.{" "}
        <a className="plain-link" href={`/projects/${projectId}/intake?section=figma`}>
          Open the design
        </a>
      </p>

      {review.status === "none" && !review.skipped ? (
        <>
          <p className="hint">The Creative Director reviews the home page&rsquo;s design and suggests changes. Accept or reject each; the site is built with the accepted ones. {review.estimate.label}.</p>
          {view.canRun ? (
            <div className="flow-actions">
              {reviewButton("Review the design", "primary")}
              <Button small variant="secondary" disabled={busy} onClick={() => run(() => skipDesignReviewAction(projectId))}>
                Skip the review ($0)
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {review.skipped && review.status === "none" ? <p className="hint">Review skipped: the site is built from the design as drawn.</p> : null}
      {running ? <p className="hint content-warn">The Creative Director is reviewing the design... This page refreshes itself.</p> : null}
      {review.status === "failed" ? (
        <>
          <p className="hint-error">The review didn&rsquo;t finish: {review.failure ?? "unknown reason"}</p>
          {view.canRun ? (
            <div className="flow-actions">
              {reviewButton("Review again", "primary")}
              {!review.skipped ? (
                <Button small variant="secondary" disabled={busy} onClick={() => run(() => skipDesignReviewAction(projectId))}>
                  Skip the review ($0)
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {review.status === "done" ? (
        <>
          {review.outOfDate ? <p className="hint content-warn">The design was imported again after this review, so it reviewed the earlier version.</p> : null}
          {review.summary ? <p>{review.summary}</p> : null}
          <p className="hint">
            {review.suggestions.length} suggestion{review.suggestions.length === 1 ? "" : "s"}: {accepted} accepted, {open} still to decide. Must-fix ones start accepted.{" "}
            <a className="plain-link" href={`/projects/${projectId}/mockups/design`}>
              See them pinned on the design
            </a>
          </p>
          {view.canRun && open ? (
            <div className="flow-actions">
              <Button small variant="secondary" disabled={busy} onClick={() => run(() => decideOpenSuggestionsAction(projectId, "accepted"))}>
                Accept the {open} still open
              </Button>
              <Button small variant="secondary" disabled={busy} onClick={() => run(() => decideOpenSuggestionsAction(projectId, "rejected"))}>
                Reject the {open} still open
              </Button>
            </div>
          ) : null}
          <ol className="flow-suggestions">
            {review.suggestions.map((s) => (
              <li key={s.id} className={`flow-suggestion is-${s.decision}`}>
                <p>
                  <span className={`badge ${s.grade === "must_fix" ? "badge-warning" : "badge-info"}`}>{s.gradeLabel}</span> <strong>{s.title}</strong>
                  {s.where ? <span className="hint"> ({s.where})</span> : null}
                </p>
                <p className="hint">{s.problem}</p>
                <p>
                  <span className="field-label">Change:</span> {s.change}
                </p>
                <div className="flow-actions">
                  <span className={`badge ${s.decision === "accepted" ? "badge-done" : s.decision === "rejected" ? "badge-info" : "badge-warning"}`}>
                    {s.decision === "accepted" ? (s.byDefault ? "Accepted (must-fix)" : "Accepted") : s.decision === "rejected" ? "Rejected" : "To decide"}
                  </span>
                  {view.canRun ? (
                    <>
                      <Button small variant="secondary" aria-pressed={s.decision === "accepted"} disabled={busy || (s.decision === "accepted" && !s.byDefault)} onClick={() => run(() => decideSuggestionAction(projectId, s.id, "accepted"))}>
                        Accept
                      </Button>
                      <Button small variant="secondary" aria-pressed={s.decision === "rejected"} disabled={busy || s.decision === "rejected"} onClick={() => run(() => decideSuggestionAction(projectId, s.id, "rejected"))}>
                        Reject
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {review.facts.length || review.unconfirmedFacts ? (
            <p className="hint content-warn">
              {review.facts.length ? `${review.facts.length} fact${review.facts.length === 1 ? "" : "s"} in the design to check` : `${review.unconfirmedFacts} fact${review.unconfirmedFacts === 1 ? "" : "s"} from the design still to confirm`} before the site goes live (the site never invents a fact).{" "}
              <a className="plain-link" href={`/projects/${projectId}/intake`}>
                Confirm the facts
              </a>
            </p>
          ) : null}
          {view.canRun ? reviewButton("Review again", "secondary") : null}
        </>
      ) : null}
    </section>
  );
}

function BuildStep({ projectId, view, busy, run, working, locked }: { projectId: string; view: DesignFlowView; busy: boolean; run: Run; working: boolean; locked: boolean }) {
  const [names, setNames] = useState(view.pages.map((p) => ({ id: p.id, name: p.name, slug: p.slug })));
  const [videos, setVideos] = useState(view.videos);
  const [videoNote, setVideoNote] = useState<string | null>(null);
  const changed = names.some((n, i) => n.name !== view.pages[i]?.name || n.slug !== view.pages[i]?.slug);
  const home = view.pages.find((p) => p.isHome) ?? view.pages[0];
  const unbuilt = view.pages.filter((p) => !p.built);
  return (
    <section className="flow-section">
      <h2 className="card-title" id="build">Build site</h2>
      <table className="flow-pages">
        <thead>
          <tr>
            <th>Page</th>
            <th>Address</th>
            <th>Built</th>
          </tr>
        </thead>
        <tbody>
          {view.pages.map((p: Page, i) => (
            <tr key={p.id}>
              <td>
                <input className="input" aria-label={`Name of ${p.name}`} value={names[i]!.name} disabled={!view.canRun} onChange={(e) => setNames(names.map((n, k) => (k === i ? { ...n, name: e.target.value } : n)))} />
                {p.filledFrom ? <span className="hint"> Same layout as {p.filledFrom}: filled by code, $0</span> : null}
              </td>
              <td>
                {p.isHome ? (
                  <span className="hint">/ (home)</span>
                ) : (
                  <input className="input" aria-label={`Address of ${p.name}`} value={names[i]!.slug} disabled={!view.canRun} onChange={(e) => setNames(names.map((n, k) => (k === i ? { ...n, slug: e.target.value } : n)))} />
                )}
              </td>
              <td>{p.built ? <span className="badge badge-done">Built</span> : <span className="hint">Not yet</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.canRun && changed ? (
        <Button small disabled={busy} onClick={() => run(() => renameDesignPagesAction(projectId, names))}>
          Save names and addresses
        </Button>
      ) : null}

      <div className="field flow-videos">
        <label className="field-label" htmlFor={`flow-videos-${projectId}`}>
          <span>Videos from social links</span>
          <span className="field-optional">Optional</span>
        </label>
        <textarea
          id={`flow-videos-${projectId}`}
          className="textarea"
          rows={3}
          disabled={!view.canRun}
          placeholder={"One TikTok or Instagram video link per line; a title after \" | \" if you like"}
          value={videos}
          onChange={(e) => setVideos(e.target.value)}
        />
        <p className="hint">They become a Videos page and fill the home page&rsquo;s featured videos. Each plays only when a visitor clicks it.</p>
        {view.canRun && videos !== view.videos ? (
          <Button
            small
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await saveSiteVideosAction(projectId, videos);
                if (r.ok) setVideoNote(`Saved ${r.saved} video${r.saved === 1 ? "" : "s"}.${r.rejected.length ? ` These couldn't be read as TikTok or Instagram video links, so they were left out: ${r.rejected.join("; ")}.` : ""}`);
                return r.ok ? { ok: true } : r;
              })
            }
          >
            Save the videos
          </Button>
        ) : null}
        {videoNote ? <p className={videoNote.includes("couldn't be read") ? "hint content-warn" : "hint"}>{videoNote}</p> : null}
      </div>

      {view.building ? (
        view.building.status === "failed" ? (
          <p className="hint-error">
            The build didn&rsquo;t finish: {view.building.failure ?? "unknown reason"}
            {view.building.cost ? ` ${view.building.cost}` : ""}
            {view.estimates.home.reused || view.estimates.all.reused ? " Build again below: the answers it already paid for are reused, for $0." : ""}
          </p>
        ) : (
          <div className="stop-line">
            <p className="hint content-warn">{view.building.step ?? "Starting"}... This page refreshes itself.</p>
            {view.canRun ? <StopButton projectId={projectId} kind="site_build" what="the site build" /> : null}
          </div>
        )
      ) : null}
      {locked ? <p className="hint">Building opens once the review is done (or skipped).</p> : null}
      {view.check ? <p className={view.check.state === "failed" ? "hint-error" : view.check.state === "running" ? "hint content-warn" : "hint"}>{view.check.line}</p> : null}
      {!working && home && !locked ? (
        <p className="hint">
          {home.built ? "" : `${home.name} first: ${view.estimates.home.label} `}
          {unbuilt.length && (view.preview || !home.built) ? `${view.preview ? "The other pages" : "Every page"}: ${view.estimates.all.label}` : ""}
        </p>
      ) : null}
      {view.canRun && !working && home && !locked ? (
        <div className="flow-actions">
          <Button
            small
            variant="secondary"
            disabled={busy || view.check?.state === "running"}
            onClick={() => run(() => checkDesignBuildAction(projectId, !home.built ? [home.key] : unbuilt.length ? unbuilt.map((p) => p.key) : [home.key]))}
          >
            Check first ($0)
          </Button>
          <PaidStepButton
            id="design-build-home"
            variant={view.preview ? "secondary" : "primary"}
            label={`${home.built ? `Build ${home.name} again` : `Build ${home.name} first`}${view.estimates.home.reused && view.estimates.home.cost === 0 ? " ($0, reusing saved answers)" : ""}`}
            confirmTitle={`Build ${home.name} from its design?`}
            confirmText={`One AI pass for the page from its design picture, with the design's words, colours, fonts, photos and icons, and its phone version built in${view.preview ? "" : ", plus the site's header and footer once"}. The automatic check runs before you see it.`}
            estimateLine={view.estimates.home.label}
            working={false}
            run={() => startDesignBuildAction(projectId, [home.key])}
          />
          {unbuilt.length ? (
            <PaidStepButton
              id="design-build-all"
              variant={view.preview ? "primary" : "secondary"}
              label={`${view.preview ? `Build the other ${unbuilt.length} page${unbuilt.length === 1 ? "" : "s"}` : "Build every page"}${view.estimates.all.reused && view.estimates.all.cost === 0 ? " ($0, reusing saved answers)" : ""}`}
              confirmTitle="Build the pages from their designs?"
              confirmText="One AI pass per page from its design picture; pages with the same layout as another are filled from it by code. Pages already built stay as they are."
              estimateLine={(view.preview ? view.estimates.all : view.estimates.all).label}
              working={false}
              run={() => startDesignBuildAction(projectId, view.preview ? unbuilt.map((p) => p.key) : view.pages.map((p) => p.key))}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PreviewStep({ projectId, view, busy, run }: { projectId: string; view: DesignFlowView; busy: boolean; run: (a: () => Promise<{ ok: true } | { ok: false; message: string }>) => void }) {
  const [copied, setCopied] = useState(false);
  const [approving, setApproving] = useState(false);
  const [decision, setDecision] = useState({ channel: "meeting", clientSaid: "" });
  const preview = view.preview!;
  return (
    <section className="flow-section">
      <h2 className="card-title" id="preview">Preview</h2>
      <p className="hint">
        Version {preview.version}. Each page of the design beside the page built from it. Look them over; say what should change on a page (only that page is reworked), or
        approve.
      </p>
      {view.costLine ? <p className="hint">{view.costLine}</p> : null}
      <ul className="flow-preview">
        {preview.pages.map((p) => (
          <PreviewPage key={p.key} projectId={projectId} page={p} view={view} busy={busy} run={run} />
        ))}
      </ul>
      <div className="flow-actions">
        {view.canRun ? (
          <Button small disabled={busy} onClick={() => run(() => refreshDesignSiteAction(projectId))}>
            Put in the approved listings and videos ($0)
          </Button>
        ) : null}
        {view.canRun ? (
          <Button small disabled={busy || view.site.deploying} onClick={() => run(() => deployPreviewAction(projectId))}>
            {view.site.deploying ? "Deploying..." : "Deploy the preview"}
          </Button>
        ) : null}
      </div>
      {view.site.deployFailed ? <p className="hint-error">The preview didn&rsquo;t deploy: {view.site.deployFailed}</p> : null}
      {view.site.privateWarning ? <p className="hint content-warn">{view.site.privateWarning}</p> : null}
      {view.site.url ? (
        <p className="share-review-row">
          <span className="hint">Share for review (private, kept out of search engines):</span> <code>{view.site.url}</code>
          <Button small onClick={() => void navigator.clipboard?.writeText(view.site.url!).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy the link"}
          </Button>
        </p>
      ) : null}
      {view.approved ? (
        <p className="hint content-done">
          Approved.{" "}
          <a className="plain-link" href={`/projects/${projectId}/build?part=golive#go-live`}>
            Open the go-live steps
          </a>
        </p>
      ) : view.canRun && view.site.url ? (
        approving ? (
          <div className="flow-approve">
            <label className="field-label" htmlFor="flow-channel">
              How the client said yes
            </label>
            <select id="flow-channel" className="select" value={decision.channel} onChange={(e) => setDecision({ ...decision, channel: e.target.value })}>
              <option value="meeting">Meeting</option>
              <option value="phone call">Phone call</option>
              <option value="email">Email</option>
            </select>
            <textarea className="textarea" rows={2} aria-label="What the client said" placeholder="What the client said" value={decision.clientSaid} onChange={(e) => setDecision({ ...decision, clientSaid: e.target.value })} />
            <Button small variant="primary" disabled={busy || decision.clientSaid.trim().length < 3} onClick={() => run(() => recordPreviewDecisionAction(projectId, { outcome: "approved", ...decision }))}>
              Record the approval
            </Button>
          </div>
        ) : (
          <Button small variant="primary" onClick={() => setApproving(true)}>
            Approve
          </Button>
        )
      ) : null}
    </section>
  );
}

function PreviewPage({ projectId, page, view, busy, run }: { projectId: string; page: Built; view: DesignFlowView; busy: boolean; run: (a: () => Promise<{ ok: true } | { ok: false; message: string }>) => void }) {
  const [feedback, setFeedback] = useState("");
  const [listing, setListing] = useState(page.listing ?? { title: "", description: "", approved: false, h1: "", alts: [] });
  return (
    <li className="flow-page">
      <h3 className="flow-page-title">
        {page.name} <code>{page.path}</code>
      </h3>
      <div className="flow-pair">
        <figure>
          <figcaption>The design</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link */}
          {page.designUrl ? <img src={page.designUrl} alt={`The design of ${page.name}`} /> : <p className="hint">No picture of the design.</p>}
        </figure>
        <figure>
          <figcaption>Built</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link */}
          {page.shotUrl ? <img src={page.shotUrl} alt={`${page.name} as built`} /> : <p className="hint">No picture yet.</p>}
        </figure>
      </div>
      {page.notes.length ? (
        <ul className="kit-misses">
          {page.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : (
        <p className="hint">The automatic check found nothing to fix.</p>
      )}
      {page.listing ? (
        <div className="flow-listing">
          <p className="field-label">Search listing {listing.approved ? <span className="badge badge-done">Approved</span> : null}</p>
          <input className="input" aria-label={`Title of ${page.name} in search results`} value={listing.title} disabled={!view.canRun} onChange={(e) => setListing({ ...listing, title: e.target.value, approved: false })} />
          <textarea className="textarea" rows={2} aria-label={`Description of ${page.name} in search results`} value={listing.description} disabled={!view.canRun} onChange={(e) => setListing({ ...listing, description: e.target.value, approved: false })} />
          {view.canRun && !listing.approved ? (
            <Button small disabled={busy} onClick={() => run(() => approveSeoAction(projectId, page.pageId, { title: listing.title, description: listing.description, h1: listing.h1 || page.name, alts: listing.alts }))}>
              Approve the listing
            </Button>
          ) : null}
        </div>
      ) : null}
      {view.canRun ? (
        <div className="flow-feedback">
          <textarea className="textarea" rows={2} aria-label={`What should change on ${page.name}`} placeholder="What should change on this page?" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <PaidStepButton
            id={`rework-${page.key}`}
            label="Rework this page"
            confirmTitle={`Rework ${page.name}?`}
            confirmText="Only this page goes back to the AI, with its design and your words; everything else stays as it is."
            estimateLine={view.reworkLabel}
            working={false}
            disabled={busy || feedback.trim().length < 5}
            run={() => reworkDesignPageAction(projectId, page.key, feedback)}
          />
        </div>
      ) : null}
    </li>
  );
}
