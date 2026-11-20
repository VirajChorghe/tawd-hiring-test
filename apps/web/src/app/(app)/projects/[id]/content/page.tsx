import { ContentSteps, type StepRow } from "@/components/content/content-steps";
import { ImproveCard } from "@/components/content/improve-card";
import { PrepareContentCard } from "@/components/content/prepare-card";
import { STATE_LABELS, contentSteps, openStep, type StepKey } from "@/lib/content-steps";
import { loadImproveView, type ImproveState } from "@/lib/content-improve";
import { loadPrepareView, prepareStopped } from "@/lib/content-prep";
import { NextStepBar } from "@/components/project/next-step-bar";
import { MoveToBuildButton } from "@/components/content/move-to-build";
import { loadNextStepFor } from "@/lib/next-step";
import type { Metadata } from "next";
import { StageLock } from "@/components/project/stage-lock";
import { notFound } from "next/navigation";

import { KeywordResearchCard } from "@/components/content/keyword-research-card";
import { CurrentSiteCard, FullAuditCard } from "@/components/content/audit-cards";
import { estimateFullAudit, loadAudits } from "@/lib/seo-audit";
import { pathOf } from "@tawd/core/site";
import { PagePlan } from "@/components/content/page-plan";
import { CopyPackCard, PageDraftsCard } from "@/components/content/page-drafts-card";
import { SiteImportCard, SiteSuggestionsCard } from "@/components/content/site-import-card";
import { KEPT_ARTICLE_LIMIT, planWork, workWords } from "@tawd/core/site-read";
import { KEPT_SOURCE, countKeptWaiting, decisionWords, fallbackView, listSourceWords, loadSiteRead, planLine } from "@/lib/site-read";
import { AI_FLAG_PERCENT, estimateLabel, loadDraftsOverview } from "@/lib/content-drafts";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { Banner } from "@/components/ui/banner";
import { getDb } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { can } from "@tawd/core/permissions";
import { formatWhen, projectChips, statusLabels } from "@/lib/labels";
import { getProject } from "@/lib/projects";
import { META_LIMIT, PAGE_KINDS, PAGE_KIND_LABELS, TIER_MAX_PAGES, TITLE_LIMIT, type PageKind } from "@/lib/seo-plan";
import { loadSeoView } from "@/lib/seo-data";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { listPeopleNames } from "@/lib/users";

export const metadata: Metadata = { title: "Content - TAWD" };
export const dynamic = "force-dynamic";

const TIER_NAMES = { starter: "Starter", growth: "Growth", pro: "Pro" } as const;

const IMPROVE_STATE_LABELS: Record<ImproveState, string> = {
  current: "The current words",
  improving: "Improving",
  improved: "Improved: to review",
  approved: "Approved",
  failed: "Didn't finish",
  kept_back: "Kept the current words",
};

/*
  Content (26 September 2026): keyword research from DataForSEO and the
  page plan (7a); each page's draft, its review and approval, and the
  client's copy pack (7b).
*/
export default async function ContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await requireUser();
  const db = getDb();
  const project = await getProject(db, current, id);
  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();

  const view = await loadSeoView(db, current, id);
  const drafts = await loadDraftsOverview(db, id);
  const audits = await loadAudits(db, current, id);
  const auditEstimate = await estimateFullAudit(db, audits.quick?.pageCount ?? audits.full?.pageCount ?? 20);
  const people = await listPeopleNames(db);
  // Keep the current site (6 October 2026).
  const kept = await loadSiteRead(db, id);
  const keptWaiting = await countKeptWaiting(db, id);
  const read = kept.read;
  // Blocked sites: where each page came from, and the pages nothing could read.
  const archive = read?.status === "done" ? fallbackView(read) : null;
  const decision = kept.keep && read?.status === "done" && !read.usedAt ? decisionWords(read, read.keptPlan?.decision ?? null) : null;
  const readPages = (read?.pages ?? []).filter((p) => !p.gap);
  // Pages over the tier's limit can only be a makeover's blog articles (0.98.0).
  const keptArticleCount = read ? Math.max(0, readPages.length - read.pageLimit) : 0;
  // Lane 1 at Design: keywords and the page plan can start early. Lane 2 has no Content step.
  const early = project.lane !== "lane_2" && project.status === "mockups";

  const number = new Intl.NumberFormat("en-US");
  const state = !view.latest ? "none" : (view.latest.status as "working" | "done" | "failed");
  const estimateLine = view.estimate.sandbox
    ? `Free: DataForSEO's sandbox answers with test data, not real search numbers.${view.estimate.cached ? ` ${view.estimate.cached} of the ${view.estimate.keywords} are already known.` : ""}`
    : view.estimate.estimateUsd === 0
      ? `Free: all ${view.estimate.keywords} keywords were looked up before.`
      : `About $${view.estimate.estimateUsd.toFixed(2)} of DataForSEO lookups${view.estimate.cached ? ` (${view.estimate.cached} of the ${view.estimate.keywords} keywords are already known and free)` : ""}.`;
  const done = view.lastDone;
  const doneLine = done
    ? `${done.keywordCount} keywords in ${(done.places as string[]).length} place${(done.places as string[]).length === 1 ? "" : "s"}, ${formatWhen(done.finishedAt ?? done.createdAt)}${done.startedByUserId ? `, started by ${people.get(done.startedByUserId) ?? "a team member"}` : ""}. ${done.sandbox ? "Free (sandbox test data)." : `Cost $${done.costUsd.toFixed(2)}${done.cachedCount ? `; ${done.cachedCount} came from earlier lookups` : ""}.`}`
    : null;
  const max = TIER_MAX_PAGES[view.tier];
  const canMoveToBuild = (drafts.decision?.outcome === "approved" || drafts.nothingToApprove) && project.status === "content" && can(current, "project.change_status");

  const draftsCard = (
    <PageDraftsCard
            projectId={id}
            canDraft={can(current, "content.plan")}
            rows={drafts.rows.map((r) => ({
              pageId: r.page.id,
              name: r.page.name,
              href: `/projects/${id}/content/${r.page.id}`,
              version: r.last ? `v${r.last.version}` : "-",
              state: r.state,
              stateLabel: r.state === "ready" && r.last?.source === KEPT_SOURCE ? (journey?.projectType === "design_only" ? "Kept as is" : "Kept: to review") : { not_drafted: "Not drafted", drafting: "Drafting", failed: "Failed", ready: "To review", approved: "Approved" }[r.state],
              aiWriting: r.last?.aiScore == null ? "-" : `${r.last.aiScore}%${r.last.aiScore > AI_FLAG_PERCENT ? " (flagged)" : ""}`,
              aiFlagged: (r.last?.aiScore ?? 0) > AI_FLAG_PERCENT,
              comments: r.openComments,
              placeholders: r.placeholders,
            }))}
            undrafted={drafts.undrafted}
            approved={drafts.approved}
            drafting={drafts.drafting}
            allApproved={drafts.allApproved}
            estimateLine={estimateLabel(drafts.estimate, drafts.undrafted || 1)}
            perPage={{ cost: drafts.estimate.perPage, model: modelLabel(drafts.estimate.model), measured: drafts.estimate.measured }}
            keptWaiting={journey?.projectType === "design_content" || journey?.projectType === "design_only" ? 0 : keptWaiting}
            canApprove={can(current, "content.approve")}
          />
  );

  // Content as one step (0.100.0, flow redesign Part C): the steps, which are needed for this project's type, and where each stands.
  const improveView = await loadImproveView(db, id);
  const prepare = await loadPrepareView(db, current, id);
  const draftCounts = {
    total: drafts.rows.length,
    approved: drafts.approved,
    ready: drafts.rows.filter((r) => r.state === "ready").length,
    working: drafts.rows.filter((r) => r.state === "drafting").length,
    failed: drafts.rows.filter((r) => r.state === "failed").length,
    notStarted: drafts.undrafted,
  };
  const steps = contentSteps({
    type: journey?.projectType ?? null,
    hasSite: Boolean(audits.siteUrl) || Boolean(read),
    read: !read ? "none" : read.status === "queued" || read.status === "working" ? "working" : read.status === "done" ? "done" : "failed",
    quick: !audits.quick ? "none" : audits.quick.status === "working" ? "working" : audits.quick.status === "done" ? "done" : "failed",
    research: state,
    researchBlocked: view.estimate.blocked,
    planPages: view.pages.length,
    // The plan is made but does not follow the approved design's menu: said on the step's own line, so it shows with the step closed.
    planMismatch: view.designMenuWarning,
    words: draftCounts,
    clientDecision: drafts.decision ? (drafts.decision.outcome === "approved" ? "approved" : "changes") : null,
    nothingToApprove: drafts.nothingToApprove,
    suggestions: read?.suggestions.length ?? 0,
    audit: !audits.full ? "none" : audits.full.status === "done" ? "done" : audits.full.status === "failed" ? "failed" : "working",
  });
  const stepLines: Record<StepKey, string | null> = {
    read: read?.status === "done" ? `${readPages.length} page${readPages.length === 1 ? "" : "s"} read from ${read.url}.` : read?.status === "working" || read?.status === "queued" ? (read.step ?? "Reading the current site...") : (read?.failure ?? null),
    quick: audits.quick?.status === "done" ? `${audits.rankings.length} page${audits.rankings.length === 1 ? "" : "s"} rank for ${audits.rankings.reduce((n, r) => n + r.keywords, 0)} keywords.` : null,
    keywords: doneLine ?? (state === "working" ? "Looking up the keywords..." : estimateLine),
    plan: view.pages.length ? `${view.pages.length} page${view.pages.length === 1 ? "" : "s"} planned.` : kept.keep ? "Makes itself from the current site's pages once they're read." : "Made by code from the tier, the intake and the keywords (free).",
    words: drafts.nothingToApprove ? "Nothing to write: the home page is the supplied page, kept as it is, and it is the only page planned." : draftCounts.total ? `${draftCounts.approved} of ${draftCounts.total} page${draftCounts.total === 1 ? "" : "s"} approved${draftCounts.working ? `; ${draftCounts.working} being written` : ""}${draftCounts.notStarted ? `; ${draftCounts.notStarted} not written yet` : ""}.` : "Waits for the page plan.",
    client: drafts.nothingToApprove ? "No copy to approve: the client approved the supplied homepage itself. Move to Build from the bar below." : drafts.decision ? (drafts.decision.outcome === "approved" ? "The client approved the copy." : "The client asked for changes.") : "Send the copy pack once every page is approved, then record the client's answer.",
    suggestions: null,
    audit: audits.full?.status === "done" ? `Audited ${audits.full.pageCount} pages.` : null,
  };
  const anchors: Record<StepKey, string[]> = { read: ["kept-pages"], quick: [], keywords: ["research"], plan: ["plan"], words: ["drafts", "improve"], client: ["copy-pack"], suggestions: ["site-suggestions"], audit: [] };
  // Prepare the content stopped after the research (Fable's review M3): the words step says why.
  const stopped = await prepareStopped(db, id);
  const stepRows: StepRow[] = steps.map((st) => {
    const row = { ...st, stateLabel: STATE_LABELS[st.state], line: stepLines[st.key], anchors: anchors[st.key] };
    return st.key === "words" && stopped ? { ...row, state: "problem" as const, stateLabel: STATE_LABELS.problem, line: stopped } : row;
  });

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
        {/* Early (Lane 1, at Design): one friendly line, not a lock card as well (29 September 2026). */}
        {early ? null : <StageLock projectId={id} status={project.status} lane={project.lane} stage="content" />}
        <div className="stack">
          {early ? (
            <Banner tone="done" title={`You're early: this project is still at ${statusLabels[project.status]}`}>
              Keyword research and the page plan can start now. Drafting the pages opens when the client approves a
              concept.
            </Banner>
          ) : null}

          {drafts.suppliedHome ? (
            <Banner tone="done" title="The home page keeps the supplied design's own words">
              The client approved the homepage file the team supplied, and the build keeps that page as the home page, words included. So
              the home page is not drafted here, not improved and not part of the copy pack, and nobody needs to approve copy for it. Its title
              and description in the page plan, and its place in the menu, are still used. Every other page is written and approved as usual.
            </Banner>
          ) : null}

          {prepare && !early ? (
            <PrepareContentCard
              projectId={id}
              canRun={can(current, "content.plan")}
              research={prepare.research}
              planLine={prepare.planLine}
              homeLine={prepare.homeLine}
              total={prepare.total}
              cheaper={prepare.cheaper}
              usable={prepare.usable}
            />
          ) : null}

          <ContentSteps
            steps={stepRows}
            open={openStep(steps)}
            bodies={{
              read:
                kept.keep || (read && read.source !== "home-only") ? (
                  <SiteImportCard
              projectId={id}
              keep={kept.keep}
              decision={decision}
              canDecide={can(current, "content.plan")}
              changed={read?.keptPlan?.changed ?? []}
              gone={read?.keptPlan?.gone ?? []}
              siteUrl={read?.url ?? audits.siteUrl ?? "the current site"}
              state={!read ? "none" : read.status === "queued" || read.status === "working" ? "working" : read.status === "needs_consent" ? "failed" : read.status}
              step={read?.step ?? null}
              paid={Boolean(read?.paid)}
              fallbackLine={archive?.summary ?? null}
              gaps={archive?.gaps ?? []}
              failure={read?.consent ? `${read.failure ?? ""} Reading it through ${read.consent.route} costs about $${read.consent.estimateUsd.toFixed(2)}: give the go on the intake's Website section.`.trim() : (read?.failure ?? null)}
              waysForward={read?.waysForward ?? []}
              intakeHref={`/projects/${id}/intake?section=website`}
              doneLine={
                read?.status === "done"
                  ? `${readPages.length} page${readPages.length === 1 ? "" : "s"} read from ${read.url} (${listSourceWords(read.source)})${read.pages.some((p) => p.readFrom === "archive") ? " (not all from the live site)" : ""}${read.finishedAt ? `, ${formatWhen(read.finishedAt)}` : ""}: ${read.pages.reduce((n, p) => n + p.wordCount, 0).toLocaleString("en-US")} words. ${read.requests} requests, ${read.paid ? `${read.paid.estimated ? "about " : ""}$${read.paid.costUsd.toFixed(2)} through ${read.paid.routes.join(" and ")}` : "free"}.`
                  : null
              }
              rows={(read?.status === "done" ? readPages : []).map((p) => ({
                path: p.path,
                name: p.name,
                kindLabel: PAGE_KIND_LABELS[p.kind as PageKind] ?? p.kind,
                words: p.wordCount,
                notes: [p.hasForm ? "Had a form (the new page gets TAWD's)" : "", p.reviewWidgets ? "A review widget, left out" : "", ...p.notes].filter(Boolean).join("; "),
                from: archive?.from.get(p.path)?.label ?? null,
                old: archive?.from.get(p.path)?.old ?? false,
              }))}
              skipped={read?.skipped ?? []}
              notImported={read?.notImported ?? []}
              articlesLine={kept.keep && keptArticleCount > 0 ? `${keptArticleCount} blog article${keptArticleCount === 1 ? "" : "s"} kept on top of ${TIER_NAMES[view.tier]}'s ${read!.pageLimit} pages: a makeover's articles don't count toward the limit (up to ${KEPT_ARTICLE_LIMIT}).` : null}
              limitLine={read?.notImported.length ? `${read.notImported.length} more page${read.notImported.length === 1 ? " is" : "s are"} over ${TIER_NAMES[view.tier]}'s limit of ${read.pageLimit} and weren't read (listed below). The redirects send their addresses to the closest kept page; or the client moves up a tier to keep them.` : null}
              failed={read?.failed ?? []}
              usedLine={read && kept.keep ? planLine(read, people) : null}
              inPlan={read?.inPlan ?? false}
            />
                ) : (
                  <p className="hint">TAWD reads the current site by itself when the intake&rsquo;s Website section is saved with its address.</p>
                ),
              quick: (
                <CurrentSiteCard
            projectId={id}
            canRun={can(current, "intake.edit")}
            canEdit={can(current, "content.plan") && audits.canEditRedirects}
            targets={audits.targets}
            siteUrl={audits.siteUrl}
            sandbox={audits.setup.sandbox}
            state={!audits.quick ? "none" : audits.quick.status === "working" ? "working" : (audits.quick.status as "done" | "failed")}
            step={audits.quick?.step ?? null}
            failure={audits.quick?.failureReason ?? null}
            doneLine={
              audits.quick?.status === "done" || audits.full?.pageCount
                ? `${(audits.full?.pageCount || audits.quick?.pageCount) ?? 0} pages in the sitemap; ${audits.rankings.length} rank for ${audits.rankings.reduce((n, r) => n + r.keywords, 0)} keywords, about ${number.format(audits.rankings.reduce((n, r) => n + r.traffic, 0))} visits a month from search.`
                : null
            }
            redirects={audits.redirects.map((r) => {
              const ranked = audits.rankings.find((x) => pathOf(x.url) === r.from);
              return {
                from: r.from,
                to: r.to,
                pageName: r.pageName,
                keywords: ranked ? String(ranked.keywords) : "-",
                traffic: ranked ? number.format(ranked.traffic) : "-",
                unmatched: !r.to,
                unsafe: r.unsafe ?? false,
                reason: r.reason,
                topKeyword: ranked?.topKeyword ?? null,
                edited: r.edited ?? false,
              };
            })}
          />
              ),
              keywords: (
                <div id="research">
                  <KeywordResearchCard
            projectId={id}
            canRun={can(current, "seo.research")}
            sandbox={view.setup.sandbox}
            missing={view.setup.missing}
            estimate={{ ...view.estimate, line: estimateLine }}
            state={state}
            failureReason={view.latest?.failureReason ?? null}
            doneLine={doneLine}
            keywords={view.keywords.map((k) => ({
              keyword: k.keyword,
              service: k.service ?? "The trade",
              area: k.area,
              volume: k.searchVolume === null ? "-" : number.format(k.searchVolume),
              difficulty: k.difficulty === null ? "-" : `${k.difficulty}/100`,
              cpc: k.cpc === null ? "-" : `$${k.cpc.toFixed(2)}`,
            }))}
          />
                </div>
              ),
              plan: (
                <div id="plan">
                  <PagePlan
            projectId={id}
            keep={kept.keep}
            prepareFirst={Boolean(prepare && !early)}
            suppliedHome={drafts.suppliedHome}
            remakeDeletes={await planWork(db, id).then((w) => (w.approved + w.drafted + w.commented + w.edited > 0 ? workWords(w).replace(/^It replaces the current page plan \([^)]*\)\. /, "") : ""))}
            canEdit={can(current, "content.plan")}
            pages={view.pages.map((p) => ({
              id: p.id,
              kind: p.kind,
              kindLabel: PAGE_KIND_LABELS[p.kind as PageKind] ?? p.kind,
              hubLine: (() => {
                const hub = p.parentSlug ? view.pages.find((h) => h.slug === p.parentSlug && h.kind === "hub") : null;
                return hub ? `In the ${hub.name} hub` : p.kind === "hub" ? `Links to ${view.pages.filter((c) => c.parentSlug === p.slug).length} detailed pages` : null;
              })(),
              name: p.name,
              slug: p.slug,
              mainKeyword: p.mainKeyword,
              supportingKeywords: p.supportingKeywords,
              title: p.title,
              metaDescription: p.metaDescription,
              h1: p.h1,
            }))}
            kinds={PAGE_KINDS.map((k) => ({ value: k, label: PAGE_KIND_LABELS[k] }))}
            countLine={
              view.keptArticles
                ? `${view.pages.length - view.keptArticles} page${view.pages.length - view.keptArticles === 1 ? "" : "s"} and ${view.keptArticles} kept blog article${view.keptArticles === 1 ? "" : "s"}; ${TIER_NAMES[view.tier]} covers up to ${max} pages (a makeover's articles don't count, up to ${KEPT_ARTICLE_LIMIT}).`
                : `${view.pages.length} page${view.pages.length === 1 ? "" : "s"}; ${TIER_NAMES[view.tier]} covers up to ${max}.`
            }
            tierWarning={view.tierWarning}
            keywordWarning={view.keywordWarning}
            hasResearch={Boolean(done)}
            titleLimit={TITLE_LIMIT}
            metaLimit={META_LIMIT}
          />
                </div>
              ),
              words: (
                <>
                  {improveView ? (
                    <ImproveCard
                      projectId={id}
                      canRun={can(current, "content.plan")}
                      rows={improveView.rows.map((r) => ({
                        pageId: r.pageId,
                        name: r.name,
                        href: `/projects/${id}/content/${r.pageId}`,
                        words: r.words,
                        isHome: r.kind === "home",
                        stateLabel: IMPROVE_STATE_LABELS[r.state],
                        improvable: r.state === "current" || r.state === "failed",
                        suggested: r.suggested,
                        why: r.why,
                        cost: r.cost,
                      }))}
                      restUnlocked={improveView.restUnlocked}
                      model={modelLabel(improveView.model)}
                      measured={improveView.measured}
                      working={improveView.rows.some((r) => r.state === "improving")}
                    />
                  ) : null}
                  {draftsCard}
                </>
              ),
              client: (
                <CopyPackCard
                  projectId={id}
                  canDecide={can(current, "project.edit")}
                  allApproved={drafts.allApproved}
                  nothingToApprove={drafts.nothingToApprove}
                  waitingLine={`${drafts.approved} of ${drafts.rows.length} page${drafts.rows.length === 1 ? "" : "s"} approved so far`}
            decisionLine={
                    drafts.decision
                      ? `${drafts.decision.outcome === "approved" ? "The client approved the copy" : "The client asked for changes"} (${drafts.decision.channel}, ${formatWhen(drafts.decision.createdAt)}, recorded by ${people.get(drafts.decision.recordedByUserId ?? "") ?? "a team member"}): "${drafts.decision.clientSaid}"`
                      : null
                  }
                  decisionChanges={drafts.decision?.outcome === "changes_requested"}
                  canMoveToBuild={canMoveToBuild}
                />
              ),
              suggestions: read?.status === "done" ? <SiteSuggestionsCard groups={read.suggestions} better={read.better} pageCount={readPages.length} /> : null,
              audit: (
                <FullAuditCard
            projectId={id}
            canAdd={can(current, "intake.edit")}
            canRun={can(current, "seo.research")}
            siteUrl={audits.siteUrl}
            addonName={audits.addon?.name ?? null}
            estimateLine={auditEstimate.label}
            state={!audits.full ? "none" : (audits.full.status as "crawling" | "working" | "done" | "failed")}
            step={audits.full?.step ?? null}
            failure={audits.full?.failureReason ?? null}
            exports={audits.exports.map((f) => ({ id: f.id, kind: "seo_crawl_export" as const, fileName: f.fileName, sizeBytes: f.sizeBytes, caption: f.caption }))}
            report={(audits.full?.report as never) ?? null}
            doneLine={audits.full?.status === "done" && audits.full.finishedAt ? `Audited ${formatWhen(audits.full.finishedAt)}: ${audits.full.pageCount} pages.${audits.full.sandbox ? " Sandbox test data." : ""}` : null}
          />
              ),
            }}
          />
        </div>
      </div>
      <NextStepBar
        next={await loadNextStepFor(db, current, id)}
        here={`/projects/${id}/content`}
        actions={canMoveToBuild ? <MoveToBuildButton projectId={id} /> : undefined}
      />
    </>
  );
}
