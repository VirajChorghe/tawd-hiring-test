"use client";

import { startPhotoTextCheckAction, startReferenceStudyAction } from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import type { PhotoTextView, ReferenceStudyView } from "@/lib/mockup-inputs";

/*
  Website section: what TAWD read from each reference site (free, from the
  page itself) and, once studied (AI, estimate first), its brief. Structure
  and craft only; the builder never takes another company's identity.
*/
export function ReferenceStudyPanel({ projectId, view, canEdit }: { projectId: string; view: ReferenceStudyView; canEdit: boolean }) {
  if (view.sites.length === 0) return null;
  const studied = view.sites.filter((s) => s.briefStatus === "done").length;
  return (
    <div className="reference-study">
      <div className="reference-study-head">
        <div>
          <p className="reference-study-title">Reference study</p>
          <p className="hint">
            {studied === 0
              ? "Read from each page for free: its bands, hero and trust signals. Studying adds a short brief of its structure and craft for the builder, and helps TAWD propose the directions."
              : `${studied} of ${view.sites.length} studied. The builder follows their structure and craft, never their identity.`}
          </p>
        </div>
        {canEdit ? (
          <PaidStepButton
            id="reference-study"
            label={studied > 0 ? "Study again" : "Study the reference sites"}
            confirmTitle="Study the reference sites?"
            confirmText={`One short AI call per site with a screenshot (${view.ready} ready). Each gives the order of its sections, how its hero works, its trust elements, how it lays out services and what makes it look finished. Never its name, words, logo or photos.`}
            estimateLine={view.estimateLine}
            working={view.working}
            disabled={view.ready === 0}
            run={() => startReferenceStudyAction(projectId)}
            stop={{ projectId, kind: "reference_study", what: "the reference study" }}
          />
        ) : null}
      </div>
      <ul className="reference-study-list">
        {view.sites.map((site) => (
          <li key={site.url}>
            <span className="reference-study-url">{site.url.replace(/^https?:\/\//, "")}</span>
            {site.briefStatus === "done" && site.brief ? (
              <span className="hint">
                <span className="badge badge-done">Studied</span> {site.brief.sectionOrder.join(" > ")}
              </span>
            ) : site.briefStatus === "failed" ? (
              <span className="hint-error">{site.failure ?? "The study didn't finish."}</span>
            ) : site.briefStatus === "queued" || site.briefStatus === "working" ? (
              <span className="hint hint-amber">Studying...</span>
            ) : site.outline ? (
              <span className="hint">
                <span className="badge badge-info">Read</span> {site.outline.bands.map((b) => b.kind).join(" > ")}
                {site.outline.trustSignals.length ? `. Trust: ${site.outline.trustSignals.join(", ")}` : ""}
              </span>
            ) : (
              <span className="hint">{site.status === "done" ? "Screenshot only (taken before the outline was read)." : "Waiting for the screenshot."}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/*
  Photos section: the visible text in the client's photos, read by AI
  (estimate first) and compared with the intake by code.
*/
export function PhotoTextPanel({ projectId, view, photoCount, canEdit }: { projectId: string; view: PhotoTextView; photoCount: number; canEdit: boolean }) {
  if (photoCount === 0) return null;
  const working = view.status === "queued" || view.status === "working";
  return (
    <div className="reference-study">
      <div className="reference-study-head">
        <div>
          <p className="reference-study-title">Text in the photos</p>
          <p className="hint">
            Signs, door and suite numbers, van lettering and shirts, checked against the intake. A photo showing another address or phone number
            would contradict the site.
          </p>
        </div>
        {canEdit ? (
          <PaidStepButton
            id="photo-text"
            label={view.status === "done" ? "Read again" : "Read the text in the photos"}
            confirmTitle="Read the text in the photos?"
            confirmText={`One AI call reads the visible text in up to 12 photos (${Math.min(12, photoCount)} here). TAWD then compares phone numbers, address and suite numbers, web addresses and business names with the intake, at no cost.`}
            estimateLine={view.estimateLine}
            working={working}
            run={() => startPhotoTextCheckAction(projectId)}
            stop={{ projectId, kind: "photo_text", what: "the photo text check" }}
          />
        ) : null}
      </div>
      {view.status === "failed" ? <p className="hint-error">{view.failureReason ?? "The check didn't finish."}</p> : null}
      {view.status === "done" ? (
        view.findings.length === 0 ? (
          <p className="hint">
            <span className="badge badge-done">Matches</span> Nothing in the {view.photosRead} photos contradicts the intake.
          </p>
        ) : (
          <ul className="reference-study-list">
            {view.findings.map((finding, index) => (
              <li key={`${finding.fileId}-${index}`}>
                <span className="reference-study-url">{finding.fileName}</span>
                <span className="hint hint-amber">
                  <span className="badge badge-warning">Check</span> {finding.problem}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
