"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { approvePaidReadAction, readSiteAgainAction } from "@/app/actions";
import { Button, ButtonLink } from "@/components/ui/button";
import type { SiteReadPanelView } from "@/lib/site-read";

/*
  Under the current website (one read of the current site, 0.96.0;
  DESIGN.md "One read of the current site"): what TAWD read, free (no AI):
  how many pages, the home page's sections, menu, phone and testimonials,
  its first screen and colours, the intake answers it filled, and what it
  found but didn't fill. A blocked site says so plainly, never "later".
*/

export type { SiteReadPanelView };

export function SiteReadPanel({ projectId, view, canEdit }: { projectId: string; view: SiteReadPanelView; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const reading = view.status === "queued" || view.status === "working";

  // The read takes seconds to a minute on the worker: look again until it's done, and until the intake and the plan are made after it (0.97.0).
  const refreshing = reading || view.settling;
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refreshing, router]);

  const readAgain = (label: string) => (
    <Button
      small
      variant="text"
      disabled={busy}
      onClick={() =>
        start(async () => {
          setError(null);
          const result = await readSiteAgainAction(projectId);
          if (!result.ok) setError(result.message);
          router.refresh();
        })
      }
    >
      {label}
    </Button>
  );

  return (
    <div className="card current-site-panel" role="status">
      <p className="card-title">{view.title}</p>
      {reading || view.settling ? <p className="hint content-warn">{view.step ?? "Starting"}... this page refreshes itself.</p> : null}
      {view.homeLine ? <p className="hint">{view.homeLine}</p> : null}
      {view.homeOnly ? <p className="hint content-warn">This is the home page only, read before TAWD read every page. Read every page (free) to see them on Content.</p> : null}
      {view.screenshotUrl || view.colours.length ? (
        <div className="site-read-look">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {view.screenshotUrl ? <img className="site-read-shot" src={view.screenshotUrl} alt={`The first screen of ${view.host}`} /> : null}
          {view.colours.length ? (
            <div>
              <div className="site-read-swatches" aria-label="Its main colours">
                {view.colours.map((c) => (
                  <span key={c} className="site-read-swatch" style={{ background: c }} title={c} />
                ))}
              </div>
              {view.fonts.length ? <p className="hint">Fonts: {view.fonts.join(", ")}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {view.filled.length ? <p className="hint content-done">Filled in from the site: {view.filled.join(", ")}. Each is marked; check it, then confirm or correct it.</p> : null}
      {view.notes.map((n) => (
        <p key={n} className="hint content-warn">
          {n}
        </p>
      ))}
      {view.status === "needs_consent" && view.consent ? (
        <>
          <p className="hint content-warn">{view.failure}</p>
          <p className="hint">
            TAWD can read it through <strong>{view.consent.route}</strong> for about <strong>${view.consent.estimateUsd.toFixed(2)}</strong> (no AI). Reads
            under $1 run by themselves; this one waits for a go. The service&rsquo;s monthly cap still applies.
          </p>
          {view.canConsent ? (
            <div className="money-row-actions">
              <Button
                variant="primary"
                small
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await approvePaidReadAction(projectId);
                    if (!result.ok) setError(result.message);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : `Read it for about $${view.consent.estimateUsd.toFixed(2)}`}
              </Button>
            </div>
          ) : (
            <p className="hint">A PM or the SEO team gives the go.</p>
          )}
          {view.waysForward.length ? (
            <>
              <p className="hint">Or, without paying:</p>
              <ol className="hint content-ways">
                {view.waysForward.map((way) => (
                  <li key={way}>{way}</li>
                ))}
              </ol>
            </>
          ) : null}
        </>
      ) : null}
      {view.status === "failed" ? (
        <>
          {view.jsOnly && view.homeLine ? (
            <p className="hint content-warn">Read the home page only: the other pages came back without words (the site draws them with JavaScript).</p>
          ) : (
            <p className="hint-error">{view.failure ?? "The site couldn't be read."}</p>
          )}
          {view.waysForward.length ? (
            <ol className="hint content-ways">
              {view.waysForward.map((way) => (
                <li key={way}>{way}</li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
      {view.status === "done" && view.homeFailure && !view.homeLine ? <p className="hint">The home page couldn&rsquo;t be opened in the browser ({view.homeFailure}); its words come from the pages read.</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      <div className="money-row-actions edit-actions">
        {view.words ? (
          <Button small variant="text" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide the words" : "See the words"}
          </Button>
        ) : null}
        {view.pagesRead > 0 && view.status === "done" ? (
          <ButtonLink small variant="text" href={`/projects/${projectId}/content#kept-pages`}>
            See the pages
          </ButtonLink>
        ) : null}
        {(canEdit || view.canReadAgain) && !reading ? readAgain(view.homeOnly ? "Read every page" : "Read again") : null}
      </div>
      {open && view.words ? (
        <div className="current-site-words">
          {view.words.menu.length ? (
            <p className="hint">
              <strong>Menu:</strong> {view.words.menu.map((m) => m.label).join(" · ")}
            </p>
          ) : null}
          {view.words.sections.map((s, i) => (
            <div key={i} className="current-site-section">
              <p className="seo-check-label">{s.heading || `Section ${i + 1}`}</p>
              <p className="hint">{s.words}</p>
            </div>
          ))}
          {view.words.testimonials.length ? (
            <p className="hint content-warn">
              {view.words.testimonials.length} testimonial{view.words.testimonials.length === 1 ? "" : "s"} found: shown as a [PLACEHOLDER] until someone confirms with the client that {view.words.testimonials.length === 1 ? "it is" : "they are"} real.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
