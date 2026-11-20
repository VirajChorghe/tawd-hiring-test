import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { CopyCompare } from "@/components/mockups/copy-compare";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import Link from "next/link";

import { ChangeDecision } from "@/components/mockups/change-decision";
import { DecisionsPanel } from "@/components/mockups/decisions-panel";
import {
  designConceptOnBoard,
  estimateDecisionsVersion,
  loadDesignImprovement,
  scoresSideBySide,
  type DesignChangeView,
} from "@/lib/design-improvement";
import { PutOnBoard } from "@/components/mockups/put-on-board";
import { getLimitState } from "@/lib/spend";
import { blockedMessage } from "@/lib/spend-report";
import { projectChips } from "@/lib/labels";
import { formatCost } from "@/lib/mockup-labels";
import { formatActivityWhen } from "@/lib/project-overview";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";

/*
  Lane 2, Option B, 4c: the improved design. The Creative Director's
  scores before and after, the faithful copy and the improved page side by
  side, then every tracked change with its section's before and after, and
  the ticked fixes that were not made, with why.
*/

export const metadata: Metadata = { title: "Improved design - TAWD" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<DesignChangeView["kind"], string> = {
  fix: "Fix from the review",
  contrast: "Contrast",
  font: "Font",
};

type Show = "all" | "open" | "accepted" | "pushed_back";
const SHOW_LABELS: Record<Show, string> = { all: "All", open: "Needs a decision", accepted: "Accepted", pushed_back: "Pushed back" };

export default async function DesignImprovementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ show?: string }>;
}) {
  const { id } = await params;
  const query = searchParams ? await searchParams : {};
  const show: Show = (["open", "accepted", "pushed_back"] as const).find((s) => s === query.show) ?? "all";
  const current = await requireUser();
  const db = getDb();

  const project = await getProject(db, current, id);

  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();
  const improvement = await loadDesignImprovement(db, id);
  if (!improvement || improvement.status !== "done") redirect(`/projects/${id}/mockups`);

  const when = formatActivityWhen(improvement.finishedAt ?? improvement.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase());
  const scores = scoresSideBySide(improvement.before, improvement.after);
  const canDecide = can(current, "design.decide");
  const counts = {
    all: improvement.changes.length,
    open: improvement.changes.filter((c) => c.decision === null).length,
    accepted: improvement.changes.filter((c) => c.decision === "accepted").length,
    pushed_back: improvement.changes.filter((c) => c.decision === "pushed_back").length,
  };
  const shown = improvement.changes.filter((c) => show === "all" || (show === "open" ? c.decision === null : c.decision === show));
  const plan = improvement.plan;
  const planParts = [
    plan.revert.length > 0 ? `${plan.revert.length} section${plan.revert.length === 1 ? "" : "s"} put back as designed` : null,
    plan.edit.length > 0 ? `${plan.edit.length} section${plan.edit.length === 1 ? "" : "s"} edited to take out the pushed-back changes` : null,
    plan.fontsKept.length > 0 ? "the font stand-in stays (the designer's font has no web licence)" : null,
  ].filter(Boolean);
  const estimate = await estimateDecisionsVersion(db, plan);
  const limit = await getLimitState(db);
  const version = improvement.decisionsVersion;
  const onBoard = await designConceptOnBoard(db, id);
  const finalAt = version?.status === "done" ? version.finishedAt : improvement.finishedAt;
  const sectionName = (n: number) => improvement.changes.find((c) => c.sectionNumber === n)?.sectionName ?? `Section ${n}`;
  const { before, after } = improvement;

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb="Improved design"
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey!}
        
        viewing="mockups"
        slackWarning={await slackWarningFor(db, id)}
      />
      <div className="page">
        <div className="review-page">
          <section className="card review-head">
            <div className="review-head-main">
              <p className="design-review-score">
                {before && after
                  ? `Creative Director: ${before.average.toFixed(1)} → ${after.average.toFixed(1)} of 5`
                  : after
                    ? `Creative Director: ${after.average.toFixed(1)} of 5`
                    : "Improved design"}
              </p>
              {after?.summary ? <p className="concept-signature">{after.summary}</p> : null}
              <p className="hint">
                The fixes ticked in the review, made on the faithful copy one section at a time:{" "}
                {improvement.changes.length} tracked change{improvement.changes.length === 1 ? "" : "s"}
                {improvement.notApplied.length > 0
                  ? `, ${improvement.notApplied.length} fix${improvement.notApplied.length === 1 ? "" : "es"} not made`
                  : ""}
                . The logo, brand colours and fonts stay the designer&rsquo;s.
              </p>
              <p className="hint">
                Built {when}
                {improvement.startedBy ? `, started by ${improvement.startedBy}` : ""}; {formatCost(improvement.cost)} of AI.
              </p>
              {improvement.rescoreFailure ? (
                <p className="hint-missing">The re-score didn&rsquo;t finish: {improvement.rescoreFailure}</p>
              ) : null}
              {improvement.outOfDate ? (
                <p className="hint-missing">
                  The review or the copy is newer than this improved design. Build it again from Mockups to use the latest.
                </p>
              ) : null}
            </div>
            <div className="review-head-actions">
              <ButtonLink href={`/projects/${id}/mockups`}>Back to Design</ButtonLink>
              <a className="btn btn-primary" href={`/projects/${id}/mockups/design/improved/live`} target="_blank" rel="noreferrer">
                Open the page
              </a>
              <PutOnBoard
                projectId={id}
                canAct={can(current, "project.edit") || canDecide}
                source={version?.status === "done" ? "the version with the designer’s decisions" : "the improved design"}
                onBoard={onBoard ? { conceptId: onBoard.conceptId, version: onBoard.version } : null}
                newer={Boolean(onBoard && finalAt && finalAt > onBoard.at)}
              />
            </div>
          </section>

          <section className="card">
            <CopyCompare
              designUrl={improvement.copyImageUrl}
              copyUrl={improvement.improvedImageUrl}
              frameName=""
              captions={{ left: "The faithful copy: the design as it is", right: "The improved design" }}
            />
          </section>

          {scores.length > 0 ? (
            <section className="card">
              <p className="card-title">The Creative Director&rsquo;s scores, before and after</p>
              <ul className="score-compare">
                {scores.map((row) => (
                  <li key={row.question}>
                    <span className="score-compare-title">
                      {row.question}. {row.title}
                    </span>
                    <span className="score-compare-values">
                      <Badge kind={scoreKind(row.before)}>{row.before ?? "-"}</Badge>
                      <span aria-hidden="true">→</span>
                      <Badge kind={scoreKind(row.after)}>{row.after ?? "-"}</Badge>
                    </span>
                    {row.reason ? <span className="hint score-compare-reason">{row.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {improvement.changes.length > 0 ? (
            <DecisionsPanel
              projectId={id}
              canMake={canDecide || can(current, "project.edit")}
              total={counts.all}
              accepted={counts.accepted}
              pushedBack={counts.pushed_back}
              open={counts.open}
              planLine={planParts.length > 0 ? planParts.join("; ").replace(/^./, (c) => c.toUpperCase()) : "Nothing was pushed back, so it's the improved design as it is"}
              estimate={estimate.label}
              limitBlocked={!estimate.free && limit.blocked ? blockedMessage(limit) : null}
              version={
                version
                  ? {
                      status: version.status,
                      detail: version.detail,
                      failureReason: version.failureReason,
                      line: `Made ${formatActivityWhen(version.finishedAt ?? new Date()).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase())}${version.startedBy ? `, started by ${version.startedBy}` : ""}; ${formatCost(version.cost)} of AI.`,
                      summary: [
                        `${version.accepted} change${version.accepted === 1 ? "" : "s"} kept, ${version.pushedBack} taken out.`,
                        ...version.reverted.map((n) => `${sectionName(n)}: put back as the designer made it.`),
                        ...version.edited.map((n) => `${sectionName(n)}: edited to take out the pushed-back changes, keeping the accepted ones.`),
                        ...version.notEdited.map((e) => `${sectionName(e.section)}: ${e.reason}`),
                        ...(version.fontsKept.length > 0 ? ["The font stand-in stays: the designer's font has no web licence. Agree another font with the designer."] : []),
                      ],
                      imageUrl: version.imageUrl,
                      outOfDate: version.outOfDate,
                    }
                  : null
              }
            />
          ) : null}

          <section className="card" id="changes">
            <div className="changes-head">
              <p className="card-title">
                Changes <span className="hint">({improvement.changes.length})</span>
              </p>
              {improvement.changes.length > 0 ? (
                <nav className="segmented changes-filter" aria-label="Show changes">
                  {(Object.keys(SHOW_LABELS) as Show[]).map((key) => (
                    <Link
                      key={key}
                      className="segment"
                      aria-pressed={show === key}
                      href={key === "all" ? `/projects/${id}/mockups/design/improved#changes` : `/projects/${id}/mockups/design/improved?show=${key}#changes`}
                    >
                      {SHOW_LABELS[key]} ({counts[key]})
                    </Link>
                  ))}
                </nav>
              ) : null}
            </div>
            {improvement.changes.length === 0 ? (
              <p className="hint">Nothing was changed.</p>
            ) : shown.length === 0 ? (
              <p className="hint">No changes here.</p>
            ) : (
              <ol className="change-list">
                {shown.map((change) => (
                  <li key={change.number} className="change-item" id={`change-${change.number}`}>
                    <div className="change-head">
                      <span className="change-title">
                        {change.number}. {change.sectionName}
                      </span>
                      <Badge kind={change.kind === "fix" ? "info" : "done"}>{KIND_LABELS[change.kind]}</Badge>
                    </div>
                    <p className="change-what">{change.what}</p>
                    <p className="hint">{change.why}</p>
                    {change.findings.length > 0 ? (
                      <p className="hint">
                        From the review: {change.findings.map((f) => `${f.number}. ${f.title}`).join("; ")}
                      </p>
                    ) : null}
                    <ChangeDecision
                      projectId={id}
                      number={change.number}
                      decision={change.decision}
                      note={change.decisionNote}
                      decidedBy={change.decidedBy}
                      decidedWhen={change.decidedAt ? formatActivityWhen(change.decidedAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase()) : null}
                      canDecide={canDecide}
                    />
                    <div className="change-pictures">
                      <figure>
                        <figcaption>{change.kind === "font" ? "In the Figma design" : "Before"}</figcaption>
                        {change.beforeUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                          <img src={change.beforeUrl} alt={`Section ${change.sectionName} before`} />
                        ) : (
                          <p className="hint">No picture.</p>
                        )}
                      </figure>
                      <figure>
                        <figcaption>After</figcaption>
                        {change.afterUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                          <img src={change.afterUrl} alt={`Section ${change.sectionName} after`} />
                        ) : (
                          <p className="hint">No picture.</p>
                        )}
                      </figure>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <details className="card copy-box" open={improvement.notApplied.length > 0}>
            <summary>
              Fixes not made{" "}
              <span className="hint">({improvement.notApplied.length === 0 ? "none: every ticked fix was made" : improvement.notApplied.length})</span>
            </summary>
            {improvement.notApplied.length > 0 ? (
              <ul className="copy-notes">
                {improvement.notApplied.map((item) => (
                  <li key={item.fix}>
                    <strong>
                      {item.fix}. {item.title}
                    </strong>
                    : {item.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>

          <details className="card copy-box">
            <summary>
              The usual checks, for information{" "}
              <span className="hint">({improvement.issues.length === 0 ? "all passed" : `${improvement.issues.length} to look at`})</span>
            </summary>
            {improvement.issues.length > 0 ? (
              <ul className="copy-notes">
                {improvement.issues.map((issue) => (
                  <li key={issue.id + issue.message}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
          </details>
        </div>
      </div>
    </>
  );
}

function scoreKind(score: number | null): "done" | "info" | "warning" {
  if (score === null) return "info";
  return score >= 4 ? "done" : score >= 3 ? "info" : "warning";
}
