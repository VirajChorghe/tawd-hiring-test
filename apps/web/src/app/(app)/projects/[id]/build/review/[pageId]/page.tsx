import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { PageReviewScreen } from "@/components/build/page-review-screen";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { formatWhen, projectChips } from "@/lib/labels";
import { loadPageForReview } from "@/lib/page-review";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { listPeopleNames } from "@/lib/users";

export const metadata: Metadata = { title: "Review pages - TAWD" };
export const dynamic = "force-dynamic";

/* One page of the latest build, reviewed in TAWD (step 3a, 3 October 2026). DESIGN.md, "The page review". */
export default async function PageReviewPage({ params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params;
  const current = await requireUser();
  const db = getDb();
  const project = await getProject(db, current, id);
  if (!project) notFound();
  const people = await listPeopleNames(db);
  const review = await loadPageForReview(db, id, decodeURIComponent(pageId), people);
  if (!review) notFound();
  const journey = await loadJourneyFacts(db, id);
  if (!journey) notFound();
  const path = review.page.path.startsWith("/") ? review.page.path : `/${review.page.path}`;

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb="Review pages"
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey}
        viewing="build"
        slackWarning={await slackWarningFor(db, id)}
      />
      <PageReviewScreen
        projectId={id}
        version={review.version}
        page={{ pageId: review.page.pageId, name: review.page.name, path: review.page.path }}
        frameSrc={`/projects/${id}/build/site/${review.version}${path}`}
        position={review.position}
        approvedCount={review.approvedCount}
        approvedLine={
          review.page.approved
            ? `Approved by ${review.page.approved.by.split(" ")[0]} on version ${review.page.approved.version}, ${formatWhen(review.page.approved.at)}.`
            : null
        }
        partsChangedOnly={review.page.partsChangedOnly}
        next={review.next}
        pages={review.pages}
        canApprove={can(current, "site.review_pages")}
        canFix={can(current, "site.review_pages") && project.lane === "lane_1"}
        fix={review.fix}
        fixEstimate={review.fixEstimate.label}
        comments={review.comments.map((c) => ({
          id: c.id,
          number: c.number,
          version: c.version,
          author: c.author,
          body: c.body,
          area: c.area,
          section: c.section,
          sectionLabel: c.sectionLabel,
          pinX: c.pinX,
          pinY: c.pinY,
          resolved: c.resolved,
          tag: c.tag,
          change: c.change,
          outcome: c.outcome,
          askDesigner: c.askDesigner,
          when: formatWhen(c.createdAt),
          replies: c.replies.map((r) => ({ id: r.id, author: r.author, body: r.body, when: formatWhen(r.createdAt) })),
        }))}
      />
    </>
  );
}
