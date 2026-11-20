import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DesignReport, type ReportGrade } from "@/components/mockups/design-report";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { formatCost } from "@/lib/mockup-labels";
import { homeFrameImage, loadDesignReview } from "@/lib/design-review";
import { projectChips } from "@/lib/labels";
import { formatActivityWhen } from "@/lib/project-overview";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";

/*
  Lane 2, Option B: the Creative Director's review of the designer's
  homepage, with every finding pinned on the design, and the PM's ticks for
  what goes into the improved version.
*/

export const metadata: Metadata = { title: "Design review - TAWD" };
export const dynamic = "force-dynamic";

export default async function DesignReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const current = await requireUser();
  const db = getDb();

  const project = await getProject(db, current, id);

  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();

  const review = await loadDesignReview(db, id);
  // Nothing to show until a review has finished; the Mockups page says where it is.
  if (!review || review.status !== "done" || !review.review) redirect(`/projects/${id}/mockups`);
  const frame = await homeFrameImage(db, id);

  const when = formatActivityWhen(review.finishedAt ?? review.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase());

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb="Design review"
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey!}
        
        viewing="mockups"
        slackWarning={await slackWarningFor(db, id)}
      />
      <div className="page">
        <DesignReport
          projectId={id}
          canTick={can(current, "project.edit") && project.status === "mockups"}
          frame={{
            name: review.frameName,
            width: frame?.width ?? 1440,
            height: frame?.height ?? 900,
            imageUrl: frame?.imageUrl ?? null,
          }}
          headline={`${review.review.average.toFixed(1)} of 5 on average, lowest ${review.review.lowest}`}
          summary={review.review.summary}
          line={`Reviewed ${when}${review.startedBy ? `, started by ${review.startedBy}` : ""}; ${formatCost(review.cost)} of AI${review.costSplit ? ` (${review.costSplit})` : ""}.`}
          outOfDate={review.outOfDate}
          findings={review.findings.map((f) => ({
            id: f.id,
            number: f.number,
            grade: f.grade as ReportGrade,
            category: f.category,
            title: f.title,
            problem: f.problem,
            change: f.change,
            why: f.why,
            layerName: f.layerName,
            pinX: f.pinX,
            pinY: f.pinY,
            ticked: f.ticked,
          }))}
          questions={review.review.questions}
          safetyAdvice={review.review.safetyAdvice}
          initialTab={query.tab === "scores" ? "scores" : "fixes"}
        />
      </div>
    </>
  );
}
