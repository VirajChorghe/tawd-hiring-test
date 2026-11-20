import { AcceptCopyButton } from "@/components/mockups/accept-copy";
import { ReplayCopyButton } from "@/components/mockups/replay-copy";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { CopyCompare } from "@/components/mockups/copy-compare";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { FIDELITY_WARNING, loadDesignCopy } from "@/lib/design-copy";
import { projectChips } from "@/lib/labels";
import { formatCost } from "@/lib/mockup-labels";
import { formatActivityWhen } from "@/lib/project-overview";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { listPeopleNames } from "@/lib/users";

/*
  Lane 2, Option B: the faithful copy of the designer's homepage, how
  closely it matches the Figma frame (overall and per section), and the
  two side by side. "Open the page" shows the copy as a working web page.
*/

export const metadata: Metadata = { title: "Faithful copy - TAWD" };
export const dynamic = "force-dynamic";

export default async function DesignCopyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ copy?: string }> }) {
  const { id } = await params;
  // A page of an Option A design, by its copy's id (28 September 2026); the homepage when not given.
  const copyId = (await searchParams)?.copy ?? null;
  const current = await requireUser();
  const db = getDb();

  const project = await getProject(db, current, id);

  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();
  const copy = await loadDesignCopy(db, id, copyId);
  if (!copy || (copy.status !== "done" && copy.status !== "needs_cleanup") || !copy.fidelity) redirect(`/projects/${id}/mockups`);

  const people = await listPeopleNames(db);
  const when = formatActivityWhen(copy.finishedAt ?? copy.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase());
  const fidelity = copy.fidelity;

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb={copyId ? `Copy: ${copy.frameName}` : "Faithful copy"}
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
              <p className="design-review-score">Matches the design: {fidelity.overall}%</p>
              {copy.status === "needs_cleanup" && copy.failureReason ? <p className="hint-missing">Not done: {copy.failureReason}</p> : null}
              {copy.accepted ? (
                <p className="hint">
                  Accepted as it is by {copy.accepted.byUserId ? (people.get(copy.accepted.byUserId) ?? "a team member") : "a team member"}, {formatActivityWhen(copy.accepted.at)}{copy.accepted.note ? <>: &ldquo;{copy.accepted.note}&rdquo;</> : "."}
                </p>
              ) : null}
              {copy.filledFrom ? (
                <p className="hint">
                  Filled by code from the {copy.filledFrom.page} copy, which shares this page&rsquo;s layout ($0): its layout with this page&rsquo;s words and photos ({copy.filledFrom.words} words put in).
                </p>
              ) : null}
              {copy.repairOf ? (
                <p className="hint">
                  Repaired with the style kit by code ($0): {copy.repairOf.placed} kit items put into the copy made {formatActivityWhen(copy.repairOf.at)}; it matched {copy.repairOf.before}%, now {copy.repairOf.after}%.
                </p>
              ) : null}
              {copy.replayOf ? (
                <p className="hint">
                  A replay: built with today&rsquo;s code from the saved AI answers of the copy made {formatActivityWhen(copy.replayOf.at)}. No AI was asked, $0.
                </p>
              ) : null}
              {copy.kitCheck ? (
                copy.kitCheck.misses.length ? (
                  <div className="kit-check">
                    <p className="hint-missing">
                      Style kit check: {copy.kitCheck.misses.length} of {copy.kitCheck.checked} {copy.kitCheck.checked === 1 ? "item" : "items"} not right
                    </p>
                    <ul className="kit-misses">
                      {copy.kitCheck.misses.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="hint">Style kit check: all {copy.kitCheck.checked} items present, in the kit&rsquo;s fonts, nothing cut off or overlapping.</p>
                )
              ) : null}
              <p className="concept-signature">{copy.summary}</p>
              <p className="hint">
                The designer&rsquo;s &ldquo;{copy.frameName}&rdquo; frame rebuilt as a web page, with nothing changed. The
                score compares the colours and layout with the Figma frame; judge the details by eye below.
              </p>
              <p className="hint">
                Built {when} on {copy.firstModel}
                {copy.startedBy ? `, started by ${copy.startedBy}` : ""}; {formatCost(copy.cost)} of AI.
                {copy.rebuiltCount > 0
                  ? ` ${copy.rebuiltCount === 1 ? "1 section was" : `${copy.rebuiltCount} sections were`} rebuilt after the first look${copy.rebuiltModel ? ` on ${copy.rebuiltModel}` : ""}${
                      copy.firstMatch !== null ? ` (the first build matched ${copy.firstMatch}%)` : ""
                    }.`
                  : ""}
              </p>
              {fidelity.overall < FIDELITY_WARNING ? (
                <p className="hint-missing">Under {FIDELITY_WARNING}%: if it is too far off, build it again from Design.</p>
              ) : null}
              {copy.outOfDate ? (
                <p className="hint-missing">The design was imported again since this copy. Build it again to copy the latest.</p>
              ) : null}
            </div>
            <div className="review-head-actions">
              <ButtonLink href={`/projects/${id}/mockups`}>Back to Design</ButtonLink>
              {copy.status === "needs_cleanup" && (can(current, "project.edit") || can(current, "design.decide")) ? <AcceptCopyButton projectId={id} copyId={copy.id} pageName={copy.frameName} /> : null}
              {can(current, "money.manage") ? <ReplayCopyButton projectId={id} copyId={copy.id} pageName={copy.frameName} /> : null}
              <a className="btn btn-primary" href={`/projects/${id}/mockups/design/copy/live${copyId ? `?copy=${copy.id}` : ""}`} target="_blank" rel="noreferrer">
                Open the page
              </a>
            </div>
          </section>

          <section className="card">
            <CopyCompare designUrl={copy.designImageUrl} copyUrl={copy.copyImageUrl} frameName={copy.frameName} />
          </section>

          {copy.sections.length > 0 ? (
            <section className="card">
              <p className="card-title">Section by section</p>
              <ul className="copy-sections">
                {copy.sections.map((section) => (
                  <li key={section.number}>
                    <div className="copy-section-row">
                      <span className="copy-section-name">
                        {section.number}. {section.name}
                      </span>
                      <span className="copy-section-tags">
                        {section.rebuilt ? <Badge kind="info">{copy.rebuiltModel ? `Rebuilt on ${copy.rebuiltModel}` : "Rebuilt after the first look"}</Badge> : null}
                        {section.verdict && !section.rebuilt ? (
                          <Badge kind={section.verdict === "close" ? "done" : "warning"}>
                            {section.verdict === "close" ? "Looks close" : "Looks off"}
                          </Badge>
                        ) : null}
                        <Badge kind={section.score >= 90 ? "done" : section.score >= FIDELITY_WARNING ? "info" : "warning"}>
                          {section.score}%
                        </Badge>
                      </span>
                    </div>
                    {section.differences.length > 0 && section.rebuilt ? (
                      <p className="hint copy-first-look">What the first look found, before the rebuild:</p>
                    ) : null}
                    {section.differences.length > 0 ? (
                      <ul className="copy-notes copy-differences">
                        {section.differences.map((difference) => (
                          <li key={difference}>{difference}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="card copy-box">
            <summary>
              Notes from the build <span className="hint">({copy.notes.length === 0 ? "none" : copy.notes.length})</span>
            </summary>
            {copy.notes.length > 0 ? (
              <ul className="copy-notes">
                {copy.notes.map((note) => (
                  <li key={note.text + (note.details ?? "")}>
                    {note.text}
                    {note.details ? (
                      <details className="copy-note-details">
                        <summary>Details</summary>
                        <p>{note.details}</p>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Nothing had to be substituted.</p>
            )}
          </details>

          <details className="card copy-box">
            <summary>
              Text check{" "}
              <span className="hint">
                ({copy.textProblems.length === 0 ? "every text matches the design" : `${copy.textProblems.length} ${copy.textProblems.length === 1 ? "section" : "sections"} to look at`})
              </span>
            </summary>
            <p className="hint">Every text on the page should come from a visible text layer of the design, once and in the design&rsquo;s order.</p>
            {copy.textProblems.length > 0 ? (
              <ul className="copy-notes">
                {copy.textProblems.map((problem) => (
                  <li key={problem.name}>
                    <strong>{problem.name}</strong>
                    {problem.missing.length > 0 ? <>: missing {problem.missing.map((t) => `“${t}”`).join(", ")}</> : null}
                    {problem.extra.length > 0 ? <>; not in the design {problem.extra.map((t) => `“${t}”`).join(", ")}</> : null}
                    {problem.repeated.length > 0 ? <>; shown more than once {problem.repeated.map((t) => `“${t}”`).join(", ")}</> : null}
                    {problem.outOfOrder ? <>; not in the design&rsquo;s order</> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>

          <details className="card copy-box">
            <summary>
              The usual checks, for information{" "}
              <span className="hint">({copy.issues.length === 0 ? "all passed" : `${copy.issues.length} to look at`})</span>
            </summary>
            {copy.issues.length > 0 ? (
              <ul className="copy-notes">
                {copy.issues.map((issue) => (
                  <li key={issue.id + issue.message}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
            <p className="hint">Nothing in the copy is changed for these; the review&rsquo;s fixes come next.</p>
          </details>
        </div>
      </div>
    </>
  );
}
