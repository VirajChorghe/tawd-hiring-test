"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { startSiteBuildAction, startSpeedUpAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { PaidStepButton } from "@/components/mockups/paid-step";

/*
  The site (Build A, 8a): built from the approved mockup and the approved
  copy, one page at a time, then put together as plain files. Paid AI,
  estimate first. Viewable here before any deploy.
*/

export interface BuiltPageCard {
  name: string;
  path: string;
  href: string;
  shot: string | null;
  placeholders: number;
}

type SiteCardProps = Parameters<typeof PlainSiteCard>[0];

/* Lane 1 builds in stages (6 October 2026); an exact Lane 2 build (admins) keeps the one-button card. */
export function SiteCard(props: SiteCardProps) {
  return props.stages ? <StagedSiteCard {...props} stages={props.stages} /> : <PlainSiteCard {...props} />;
}

function PlainSiteCard(props: {
  projectId: string;
  canBuild: boolean;
  /** Still missing before a build can start; empty when ready. */
  missing: string[];
  /** Amber, not blocking: "The client hasn't approved the copy pack yet." */
  warnings: string[];
  estimateLine: string;
  state: "none" | "working" | "done" | "failed";
  step: string | null;
  failure: string | null;
  /** "Version 2, built Sep 26, 4:10 PM: 9 pages, 31 files." */
  doneLine: string | null;
  siteHref: string | null;
  pages: BuiltPageCard[];
  /** The latest build was made before the speed pass (1 October 2026): it can be sped up, free. */
  canSpeedUp?: boolean;
  /** Staged builds (Lane 1, 6 October 2026); absent for an exact Lane 2 build. */
  stages?: SiteStagesProps | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (props.state !== "working") return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [props.state, router]);

  const again = props.state === "done" || props.state === "failed";

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">The site</h2>
          <p className="hint">
            Every page built from the approved mockup&rsquo;s design and its approved copy, with a shared header and footer, as
            plain HTML and CSS files (Astro). Nothing goes live from here.
          </p>
        </div>
        {props.canBuild && props.state !== "working" ? (
          <Button variant={again ? "secondary" : "primary"} disabled={busy || props.missing.length > 0} onClick={() => setConfirming(true)}>
            {again ? "Build again" : "Build the site"}
          </Button>
        ) : null}
      </div>

      {props.missing.map((line) => (
        <p key={line} className="hint content-warn">
          {line}
        </p>
      ))}
      {props.missing.length === 0 && props.state !== "working" ? (
        <>
          {props.warnings.map((line) => (
            <p key={line} className="hint content-warn">
              {line}
            </p>
          ))}
          {props.state !== "done" ? <p className="hint">{props.estimateLine}</p> : null}
        </>
      ) : null}
      {props.state === "working" ? (
        <div className="stop-line">
          <p className="hint content-warn">{props.step ?? "Starting..."} This page refreshes itself.</p>
          {props.canBuild ? <StopButton projectId={props.projectId} kind="site_build" what="the site build" /> : null}
        </div>
      ) : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.canSpeedUp && props.canBuild && props.state !== "working" ? (
        <div className="fm-test">
          <Button
            small
            variant="secondary"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await startSpeedUpAction(props.projectId);
                if (!result.ok) setError(result.message);
                router.refresh();
              })
            }
          >
            Speed up this build
          </Button>
          <p className="hint">This build was made before the speed pass. Free, no AI, a few minutes: a new version with smaller pictures, the fonts on the site and faster loading. Then deploy the preview again.</p>
        </div>
      ) : null}

      {props.doneLine ? (
        <div className="site-done">
          <p className="content-done-line">{props.doneLine}</p>
          {props.siteHref ? (
            <a className="btn btn-primary btn-small" href={props.siteHref} target="_blank" rel="noopener">
              Open the site
            </a>
          ) : null}
        </div>
      ) : null}

      {props.pages.length > 0 ? (
        <ul className="site-pages">
          {props.pages.map((page) => (
            <li key={page.path}>
              <a href={page.href} target="_blank" rel="noopener" className="site-page-shot" aria-label={`Open ${page.name}`}>
                {page.shot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={page.shot} alt="" />
                ) : (
                  <span className="hint">No picture</span>
                )}
              </a>
              <p className="site-page-name">
                <strong>{page.name}</strong> <span className="plan-slug">{page.path}</span>
              </p>
              {page.placeholders ? (
                <p className="hint content-warn">
                  {page.placeholders} placeholder{page.placeholders === 1 ? "" : "s"} to fill before go-live
                </p>
              ) : (
                <p className="hint">No placeholders</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="site-title">
            <h2 className="section-title" id="site-title">
              {again ? "Build the site again?" : "Build the site?"}
            </h2>
            <p className="hint">
              The shared header and footer are made once, then each page from its approved copy in the approved design. A new
              version; earlier ones are kept.
            </p>
            <p className="hint">{props.estimateLine}</p>
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
                    const result = await startSiteBuildAction(props.projectId);
                    setConfirming(false);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : "Build it"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- staged builds (Jason, 6 October 2026) ---------- */

export interface SiteStageRow {
  key: string;
  label: string;
  /** "Ant control, Bed bugs, Cockroaches and 8 more" for a bundle; empty for a single page. */
  pagesLine: string;
  status: "built" | "next" | "waiting";
  builtIn: number | null;
  makesParts: boolean;
}

export interface SiteStagesProps {
  /** "12 of 49 pages built" */
  countLine: string;
  allBuilt: boolean;
  homeBuilt: boolean;
  rows: SiteStageRow[];
  /** `pages` is the stage's pages; `aiPages` is how many of them the AI actually writes (a kept home page is not one); `keptHome` says the page left out is the supplied home page. */
  next: { label: string; button: string; estimateLine: string; makesParts: boolean; pages: number; aiPages: number; keptHome: boolean } | null;
  /** The stage built last, to check before the next: "About (version 3)". */
  lastBuilt: string | null;
  remaining: { pages: number; estimateLine: string } | null;
  /** For Build the whole site again, once every page is built. */
  wholeEstimateLine: string | null;
}

/*
  What the AI is actually asked to do in this stage, said before any money
  is spent (rule 2). A stage with no AI page is not always a supplied home
  page: a stage of blog articles kept from the current site is filled into
  the first article's layout by code too (CodeRabbit on #108), and saying
  "the home page is the design the team supplied" there would be a fact
  TAWD invented. The kept-home flag comes from the estimate, which is the
  one place that knows.
*/
export function stageConfirmText(next: { aiPages: number; makesParts: boolean; keptHome: boolean }): string {
  const pass =
    next.aiPages === 0
      ? next.keptHome
        ? "No AI pass for a page: the home page is the design the team supplied, and its words are kept as they were uploaded"
        : "No AI pass for a page: every page in this stage is filled into a layout already built, by code"
      : next.aiPages === 1
        ? "One AI pass for the page from its approved copy in the approved design"
        : `One AI pass for each of the ${next.aiPages} pages from its approved copy in the approved design`;
  const parts = next.makesParts
    ? `${next.aiPages === 0 ? ". The shared header and footer are made once" : ", plus the shared header and footer once"} (every later page reuses them)`
    : "; the pages built before are reused as they are (no AI) with the same header and footer";
  return `${pass}${parts}. TAWD's own pages (privacy, cookies, thank-you, 404, sitemap, robots) are written free. A new version; earlier ones are kept. It stops itself at twice the estimate.`;
}

function StagedSiteCard(props: SiteCardProps & { stages: SiteStagesProps }) {
  const router = useRouter();
  const s = props.stages;
  const working = props.state === "working";
  const canRun = props.canBuild && !working && props.missing.length === 0;

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">The site</h2>
          <p className="hint">
            Built in stages, one page first: the home page (it also makes the shared header and footer), then each main page, then each group&rsquo;s first
            page alone and the rest together. Each stage is a new version with every page built so far. Nothing goes live from here.
          </p>
        </div>
        {props.doneLine ? <span className={s.allBuilt ? "badge badge-done" : "badge badge-info"}>{s.countLine}</span> : null}
      </div>

      {props.missing.map((line) => (
        <p key={line} className="hint content-warn">
          {line}
        </p>
      ))}
      {props.missing.length === 0 && !working
        ? props.warnings.map((line) => (
            <p key={line} className="hint content-warn">
              {line}
            </p>
          ))
        : null}
      {working ? (
        <div className="stop-line">
          <p className="hint content-warn">{props.step ?? "Starting..."} This page refreshes itself.</p>
          {props.canBuild ? <StopButton projectId={props.projectId} kind="site_build" what="the site build" /> : null}
        </div>
      ) : null}
      {props.state === "failed" && props.failure ? <p className="hint-error">{props.failure}</p> : null}

      {!s.allBuilt && props.doneLine ? (
        <p className="hint content-warn">
          {s.countLine}. The pages not built yet show a &ldquo;Coming soon&rdquo; page on the site and the preview. Go-live waits until every planned page is
          built.
        </p>
      ) : null}

      {s.next && !working && props.missing.length === 0 ? (
        <p className="hint">
          {s.lastBuilt ? `Check ${s.lastBuilt} first (Open the site, or Review pages on Check), then build the next. ` : ""}
          Next: {s.next.label}. {s.next.estimateLine}
        </p>
      ) : null}

      {canRun ? (
        <div className="stage-actions">
          {s.next ? (
            <PaidStepButton
              id="site-stage-next"
              variant="primary"
              label={s.next.button}
              confirmTitle={`${s.next.button}?`}
              confirmText={stageConfirmText(s.next)}
              estimateLine={s.next.estimateLine}
              working={false}
              run={() => startSiteBuildAction(props.projectId, "next")}
            />
          ) : null}
          {s.remaining && s.next && s.remaining.pages > s.next.pages ? (
            <PaidStepButton
              id="site-stage-remaining"
              label={`Build all remaining pages (${s.remaining.pages})`}
              confirmTitle={`Build all ${s.remaining.pages} remaining pages at once?`}
              confirmText="For a confident team: every page not built yet, in one run, without checking each stage first. One AI pass per page; the pages built before and the header and footer are reused as they are. It stops itself at twice the estimate."
              estimateLine={s.remaining.estimateLine}
              working={false}
              run={() => startSiteBuildAction(props.projectId, "remaining")}
            />
          ) : null}
          {s.allBuilt && s.wholeEstimateLine ? (
            <PaidStepButton
              id="site-stage-whole"
              label="Build the whole site again"
              confirmTitle="Build the whole site again?"
              confirmText="Every page again from its approved copy, with a new shared header and footer. For when the copy or the plan changed a lot; for one page, use Fix these on its review. A new version; earlier ones are kept."
              estimateLine={s.wholeEstimateLine}
              working={false}
              run={() => startSiteBuildAction(props.projectId, "whole")}
            />
          ) : null}
        </div>
      ) : null}

      <ul className="stage-list" aria-label="Build stages">
        {s.rows.map((row) => (
          <li key={row.key} className={row.status === "next" ? "stage-row is-next" : "stage-row"}>
            <div>
              <p className="stage-name">
                {row.label}
                {row.makesParts ? <span className="hint"> (and the header and footer)</span> : null}
              </p>
              {row.pagesLine ? <p className="hint">{row.pagesLine}</p> : null}
            </div>
            <span className={row.status === "built" ? "badge badge-done" : row.status === "next" ? "badge badge-info" : "badge"}>
              {row.status === "built" ? `Built v${row.builtIn}` : row.status === "next" ? "Next" : "Waiting"}
            </span>
          </li>
        ))}
        <li className="stage-row">
          <div>
            <p className="stage-name">TAWD&rsquo;s own pages</p>
            <p className="hint">Privacy Policy, Cookie Policy, Thank you, the 404 page, sitemap.xml and robots.txt: written by code with every stage, $0.</p>
          </div>
          <span className="badge badge-done">Free</span>
        </li>
      </ul>

      {props.canSpeedUp && props.canBuild && !working ? <SpeedUp projectId={props.projectId} /> : null}

      {props.doneLine ? (
        <div className="site-done">
          <p className="content-done-line">{props.doneLine}</p>
          {props.siteHref ? (
            <a className="btn btn-primary btn-small" href={props.siteHref} target="_blank" rel="noopener">
              Open the site
            </a>
          ) : null}
        </div>
      ) : null}
      <PageShots pages={props.pages} />
    </div>
  );
}

function SpeedUp({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <div className="fm-test">
      <Button
        small
        variant="secondary"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await startSpeedUpAction(projectId);
            if (!result.ok) setError(result.message);
            router.refresh();
          })
        }
      >
        Speed up this build
      </Button>
      <p className="hint">This build was made before the speed pass. Free, no AI, a few minutes: a new version with smaller pictures, the fonts on the site and faster loading. Then deploy the preview again.</p>
      {error ? <p className="hint-error">{error}</p> : null}
    </div>
  );
}

function PageShots({ pages }: { pages: BuiltPageCard[] }) {
  if (pages.length === 0) return null;
  return (
    <ul className="site-pages">
      {pages.map((page) => (
        <li key={page.path}>
          <a href={page.href} target="_blank" rel="noopener" className="site-page-shot" aria-label={`Open ${page.name}`}>
            {page.shot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={page.shot} alt="" />
            ) : (
              <span className="hint">No picture</span>
            )}
          </a>
          <p className="site-page-name">
            <strong>{page.name}</strong> <span className="plan-slug">{page.path}</span>
          </p>
          {page.placeholders ? (
            <p className="hint content-warn">
              {page.placeholders} placeholder{page.placeholders === 1 ? "" : "s"} to fill before go-live
            </p>
          ) : (
            <p className="hint">No placeholders</p>
          )}
        </li>
      ))}
    </ul>
  );
}
