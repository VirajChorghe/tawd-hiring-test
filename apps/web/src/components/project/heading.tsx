import Link from "next/link";

import type { TeamRole } from "@tawd/core/enums";
import type { JourneyFacts } from "@/lib/journey";
import { PROJECT_TYPE_LABELS } from "@tawd/core/intake";
import type { Stage } from "@/lib/stages";
import { StageNav } from "./stage-nav";
import { TeamLine } from "./team-line";

/*
  The project header, shared by every project screen: breadcrumb, name,
  the chips and team line, the screen's primary action on the right, and
  the stage navigation along the bottom.

  No hooks, so a server page can render it directly and the intake's client
  header can wrap it with its gate.
*/

export function ProjectHeading({
  projectId,
  clientName,
  chips,
  members,
  canEditTeam,
  journey,
  viewing,
  crumb,
  actions,
  slackWarning,
}: {
  projectId: string;
  clientName: string;
  chips: string[];
  members: { id: string; name: string; roles: TeamRole[] }[];
  canEditTeam: boolean;
  /** The lane, the stage and the facts the step bar needs (lib/journey.ts). */
  journey: JourneyFacts;
  viewing?: Stage | "updates";
  /** The last breadcrumb, when this is a screen inside the project. */
  crumb?: string;
  actions?: React.ReactNode;
  /** A Slack update that didn't go through, shown until the next one does. */
  slackWarning?: string | null;
}) {
  return (
    <section className="project-header">
      {slackWarning ? (
        <p className="slack-warning" role="status">
          {slackWarning}{" "}
          <Link href={`/projects/${projectId}?tab=settings#slack`}>Check the Slack setting</Link>
        </p>
      ) : null}
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/projects">Projects</Link>
        <span aria-hidden="true">/</span>
        {crumb ? (
          <>
            <Link href={`/projects/${projectId}`}>{clientName}</Link>
            <span aria-hidden="true">/</span>
            <span>{crumb}</span>
          </>
        ) : (
          <span>{clientName}</span>
        )}
      </nav>

      <div className="project-header-main">
        <div>
          <h1 className="page-title">{clientName}</h1>
          <div className="project-meta">
            {/* The project type (0.100.0), after the lane. */}
            {(journey.projectType ? [...chips.slice(0, 3), PROJECT_TYPE_LABELS[journey.projectType], ...chips.slice(3)] : chips).map((chip) => (
              <span key={chip} className="meta-chip">
                {chip}
              </span>
            ))}
            <span className="project-meta-divider" aria-hidden="true" />
            <TeamLine
              members={members}
              editHref={canEditTeam ? `/projects/${projectId}/edit` : undefined}
            />
          </div>
        </div>

        {actions ? <div className="project-header-actions">{actions}</div> : null}
      </div>

      <StageNav
        projectId={projectId}
        facts={journey}
        viewing={viewing}
      />
    </section>
  );
}
