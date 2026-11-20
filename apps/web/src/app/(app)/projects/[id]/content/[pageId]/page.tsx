import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AiWritingCard, ApprovalCard, CommentsCard, DraftPanel, SeoPanel } from "@/components/content/page-review";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { parseDraft } from "@tawd/core/content";
import { AI_FLAG_PERCENT, draftHtml, estimateLabel, loadDraftsOverview, loadPageReview, originalityCredits } from "@/lib/content-drafts";
import { formatWhen, projectChips } from "@/lib/labels";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { estimateImprove, loadImproveView } from "@/lib/content-improve";
import { isKeptLineage } from "@tawd/core/site-read";
import { listPeopleNames } from "@/lib/users";

export const metadata: Metadata = { title: "Page review - TAWD" };
export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = { draft: "drafted by AI", redraft: "redrafted by AI", edit: "edited", kept: "from the current site (kept as is)", improved: "improved by AI from the current site" };

/* One page's copy: read, edit, comment on and approve it (7b). */
export default async function PageReviewPage({ params }: { params: Promise<{ id: string; pageId: string }> }) {
  const { id, pageId } = await params;
  const current = await requireUser();
  const db = getDb();
  const project = await getProject(db, current, id);
  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();
  const review = await loadPageReview(db, id, pageId);
  if (!review) notFound();
  const people = await listPeopleNames(db);
  // Design + content (0.100.0): improving, comparing and putting back.
  const improveView = await loadImproveView(db, id);
  const who = (userId: string | null) => (userId ? (people.get(userId) ?? "a team member") : "TAWD");

  const { page, current: latest, shown, analysis } = review;
  const working = latest?.status === "queued" || latest?.status === "working";
  const versionLine = shown
    ? `Version ${shown.version} of ${review.versions.length}: ${SOURCE[shown.source] ?? shown.source}${shown.source === "edit" ? ` by ${who(shown.createdByUserId)}` : ""}, ${formatWhen(shown.finishedAt ?? shown.createdAt)}.${shown.note && shown.source !== "kept" ? ` Note: "${shown.note}"` : shown.source === "kept" && shown.note ? ` ${shown.note.replace(/^From the current site \(kept as is\): /, "Read from ")}` : ""}`
    : "Not drafted yet.";
  const ready = Boolean(latest?.status === "done" && latest.body);
  // Moving between pages (8 October 2026): back to this page's row on Content, the plan's previous and next pages, and the next one still to approve.
  const rows = (await loadDraftsOverview(db, id)).rows;
  const at = rows.findIndex((r) => r.page.id === pageId);
  const pageHref = (r: (typeof rows)[number]) => `/projects/${id}/content/${r.page.id}`;
  const previous = at > 0 ? rows[at - 1]! : null;
  const following = at >= 0 && at < rows.length - 1 ? rows[at + 1]! : null;
  const toApprove = [...rows.slice(at + 1), ...rows.slice(0, Math.max(0, at))].find((r) => r.state === "ready") ?? null;
  const backHref = `/projects/${id}/content#page-${pageId}`;
  const scored = latest?.aiScore ?? null;

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb="Content"
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey!}
        viewing="content"
        slackWarning={await slackWarningFor(db, id)}
      />
      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="section-title">{page.name}</h1>
            <p className="hint">
              /{page.slug} &middot; Main keyword: {page.mainKeyword || "none"} &middot; Title: {page.title}
            </p>
          </div>
          <div className="money-row-actions">
            {previous ? (
              <Link className="btn btn-text btn-small" href={pageHref(previous)} title={previous.page.name}>
                Previous page
              </Link>
            ) : null}
            {following ? (
              <Link className="btn btn-text btn-small" href={pageHref(following)} title={following.page.name}>
                Next page
              </Link>
            ) : null}
            <Link className="btn btn-secondary btn-small" href={backHref}>
              Back to Content
            </Link>
          </div>
        </div>
        <div className="review-layout">
          <DraftPanel
            projectId={id}
            pageId={pageId}
            canEdit={can(current, "content.plan")}
            html={shown?.body ? draftHtml(parseDraft(shown.body)) : null}
            body={shown?.body ?? ""}
            versionLine={versionLine}
            working={working}
            failure={latest?.status === "failed" ? latest.failureReason : null}
            estimateLine={estimateLabel(review.estimate, 1)}
            improve={
              improveView && improveView.rows.some((r) => r.pageId === pageId)
                ? {
                    compare: review.compare,
                    canPutBack: !working && review.versions.some((v) => v.source === "improved") && !isKeptLineage(review.versions),
                    estimateLine: (await estimateImprove(db, [improveView.rows.find((r) => r.pageId === pageId)!.words])).label,
                  }
                : null
            }
          />
          <div className="stack">
            <ApprovalCard
              projectId={id}
              pageId={pageId}
              canApprove={can(current, "content.approve")}
              approvedLine={latest?.approvedAt ? `Version ${latest.version}, by ${who(latest.approvedByUserId)}, ${formatWhen(latest.approvedAt)}.` : null}
              ready={ready}
              placeholders={analysis?.placeholders.length ?? 0}
              next={toApprove ? { name: toApprove.page.name, href: pageHref(toApprove) } : null}
              backHref={backHref}
            />
            {analysis ? <SeoPanel checks={analysis.checks} wordCount={analysis.wordCount} /> : null}
            <AiWritingCard
              projectId={id}
              pageId={pageId}
              canCheck={can(current, "content.plan")}
              configured={review.originality.configured}
              ready={ready}
              scoreLine={scored === null ? null : `${scored}% likely AI-written`}
              scoreNote={scored === null ? null : `${scored > AI_FLAG_PERCENT ? "Over 30%: worth rewriting in a more human voice. " : ""}Checked ${formatWhen(latest!.aiScoreCheckedAt!)}, version ${latest!.version}.`}
              flagged={scored !== null && scored > AI_FLAG_PERCENT}
              lastError={latest?.aiScoreError ?? null}
              creditsLine={`About ${originalityCredits(analysis?.wordCount ?? 0)} Originality.ai credit${originalityCredits(analysis?.wordCount ?? 0) === 1 ? "" : "s"} (one per 100 words).`}
            />
            <CommentsCard
              projectId={id}
              pageId={pageId}
              canComment={can(current, "content.plan")}
              comments={review.comments.map((c) => ({
                id: c.id,
                author: who(c.authorUserId),
                when: formatWhen(c.createdAt),
                version: c.version,
                body: c.body,
                resolved: c.resolvedAt ? `${who(c.resolvedByUserId)}, ${formatWhen(c.resolvedAt)}` : null,
              }))}
            />
          </div>
        </div>
      </div>
    </>
  );
}
