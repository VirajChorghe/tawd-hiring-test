import type { Metadata } from "next";
import Link from "next/link";
import { listPeopleNames } from "@/lib/users";
import { LogoAfterApprovalCard } from "@/components/mockups/logo-after-approval";
import { loadLogoAfterApproval } from "@/lib/logo-after-approval";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { ContinueToMockups } from "@/components/project/continue-button";
import { ProjectHeading } from "@/components/project/heading";
import { NextStepBar } from "@/components/project/next-step-bar";
import { HomeWordsCard, KeptHomeWordsCard } from "@/components/mockups/home-words-card";
import { waysForwardFor } from "@tawd/core/site";
import { workWords } from "@tawd/core/site-read";
import { loadHomeWords } from "@/lib/home-words";
import { WireframeCard } from "@/components/mockups/wireframe-card";
import { loadWireframe } from "@/lib/wireframe";
import { loadNextStepFor } from "@/lib/next-step";
import { loadJourneyFacts } from "@/lib/journey";
import {
  ConceptBoardActions,
  ConceptBoardBarActions,
  ConceptBoardProvider,
  ConceptCards,
  NextStepsStrip,
  type ConceptCard,
} from "@/components/mockups/concepts";
import { GeneratingRun } from "@/components/mockups/generating";
import { PastRuns } from "@/components/mockups/past-runs";
import { MockupSetup } from "@/components/mockups/setup";
import { DesignerDesign } from "@/components/mockups/designer-design";
import { ExactDesignCard } from "@/components/mockups/exact-design-card";
import { StyleKitCard } from "@/components/mockups/style-kit-card";
import { loadStyleKit } from "@/lib/style-kit";
import { hasFinishedCopies, loadRepairSummary } from "@/lib/copy-repair";
import { loadTidy } from "@/lib/site-tidy";
import { WordsLinksCard } from "@/components/mockups/words-links-card";
import { SiteVideosCard } from "@/components/mockups/site-videos-card";
import { loadSiteVideos, videosText } from "@/lib/site-videos";
import { SeoPassCard } from "@/components/mockups/seo-pass-card";
import { DesignSiteFlow } from "@/components/mockups/design-site-flow";
import { UndoKitRepairButton } from "@/components/mockups/undo-kit-repair";
import { loadDesignFlow } from "@/lib/design-site";
import { loadSeoPass } from "@/lib/seo-pass";
import { loadExactDesign } from "@/lib/exact-design";
import { designerDesignProps, loadFigmaDesign } from "@/lib/figma";
import { DesignReviewCard } from "@/components/mockups/design-review-card";
import { DesignCopyCard } from "@/components/mockups/design-copy-card";
import { DesignImprovementCard } from "@/components/mockups/design-improvement-card";
import { AlternativesCard } from "@/components/mockups/alternatives-card";
import { estimateDesignImprovement, improvementInputs, loadDesignImprovement } from "@/lib/design-improvement";
import { FIDELITY_WARNING, estimateDesignCopy, importedDrawings, loadDesignCopy } from "@/lib/design-copy";
import { estimateDesignReview, factsStatus, loadDesignReview } from "@/lib/design-review";
import { getLimitState } from "@/lib/spend";
import { blockedMessage } from "@/lib/spend-report";
import { Banner } from "@/components/ui/banner";
import { getDb } from "@tawd/core/db";
import { mockupRun, user as userTable } from "@tawd/core/schema";
import { isRunActive } from "@tawd/core/queue";
import { isEmergencyTrade, modelLabel } from "@tawd/core/mockups";
import type { Trade } from "@tawd/core/enums";
import {
  channelLabels,
  conceptsMissingReview,
  estimateChanges,
  latestClientDecision,
  loadConceptCards,
  rerunReviewEstimate,
  type Channel,
} from "@/lib/concept-review";
import { RerunReviewButton } from "@/components/mockups/rerun-review";
import {
  getIntakeGaps,
  getLatestRun,
  listPastRuns,
  planRun,
  type RunProgress,
} from "@/lib/mockups";
import { isGeneratedConcept, HTML_HOMEPAGE_CONCEPT, directionInfo, formatCost, skillLabels } from "@/lib/mockup-labels";
import { formatWhen, projectChips, tradeLabels } from "@/lib/labels";
import { formatActivityWhen } from "@/lib/project-overview";
import { loadIntake } from "@tawd/core/intake/service";
import { can } from "@tawd/core/permissions";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { personLabel } from "@/lib/users";
import { describeAiFailure } from "@/lib/ai-failure";

/*
  The Mockups stage. One page, three screens (DESIGN.md, Mockup engine
  screens), chosen by where the latest run is:

  - generating while a run is working;
  - the concepts once a run has produced any, until someone chooses to
    set up a new run (?setup=1);
  - otherwise, setting up the concepts.

  Once the client has approved a concept the project moves to Content and
  this page shows the concepts read-only, with the decision on top.
*/

export const metadata: Metadata = { title: "Design - TAWD" };
export const dynamic = "force-dynamic";

export default async function MockupsPage({
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
  if (!project) notFound();

  const heading = {
    projectId: id,
    clientName: project.clientName,
    crumb: "Design",
    chips: projectChips(project),
    members: project.members,
    canEditTeam: can(current, "project.assign_members"),
    journey: (await loadJourneyFacts(db, id))!,
    viewing: "mockups" as const,
    slackWarning: await slackWarningFor(db, id),
  };
  // The next-step bar (30 September 2026), at the bottom of every state of this page.
  const next = await loadNextStepFor(db, current, id);
  const bar = (actions?: React.ReactNode) => <NextStepBar next={next} here={`/projects/${id}/mockups`} actions={actions} />;

  /*
    Still in Intake: the stage tab and the Continue button both lead here
    once the intake is complete, so explain the one step left rather than
    bouncing back. An incomplete intake still goes back to the intake.
  */
  if (project.status === "intake") {
    const intake = await loadIntake(db, current, id);
    if (!intake?.completeness.isComplete) redirect(`/projects/${id}/intake`);
    return (
      <>
        <ProjectHeading {...heading} journey={{ ...heading.journey, intakeComplete: true }} />
        <div className="page">
          <div className="card" style={{ maxWidth: 640 }}>
            <h2 className="card-title" style={{ marginBottom: 8 }}>
              The intake is complete
            </h2>
            <p className="hint">
              This project is still in Intake. Continue to Design (at the bottom of the page) to move
              it on and set up the concepts. You can still edit the intake later.
            </p>
          </div>
        </div>
        {bar(<ContinueToMockups projectId={id} stillInIntake canMove={can(current, "project.change_status")} />)}
      </>
    );
  }

  const run = await getLatestRun(current, id);
  const canRun = can(current, "project.edit");
  const inMockups = project.status === "mockups";
  // A Lane 2 Option A project never sets up Lane 1 concepts: its one concept is the supplied homepage, and a new run would spend money on concepts it does not use.
  const wantsSetup = query.setup === "1" && inMockups && canRun && !(project.lane === "lane_2" && project.laneOption === "a");
  // Setting up a new run: the current one counts as an earlier run now.
  const pastRuns = await listPastRuns(current, id, wantsSetup ? undefined : run?.id);
  const pastRunRows = pastRuns.map((pastRun) => ({
    id: pastRun.id,
    status: pastRun.status,
    conceptCount: pastRun.conceptCount,
    model: pastRun.model,
    createdAt: formatWhen(pastRun.createdAt),
    cost: pastRun.cost,
    conceptLabels: pastRun.conceptLabels,
  }));

  // Lane 2, Option B: the designer's own design comes first, as Concept 1.
  const designer =
    project.lane === "lane_2" && project.laneOption === "b"
      ? designerDesignProps(id, await loadFigmaDesign(db, id))
      : null;
  const designerCard = designer ? <DesignerDesign {...designer} /> : null;

  /*
    Lane 2, Option A (28 September 2026): the client approved the design, so
    there are no concepts: the design, and every page of it built exactly.
  */
  /*
    Lane 2, simply (Jason, 29 September 2026): the design is a reference and
    the site is built close to it in three steps (DesignSiteFlow). The exact
    copies, the kit, the repair and the other tools of 28 September stay for
    admins only, folded away under Advanced.
  */
  // Option B's alternatives and concept board, only on request (Jason, 29 September 2026): the earlier screen, at ?classic=1.
  const classicB = project.laneOption === "b" && query.classic === "1";
  /*
    A homepage the team supplied as an HTML file is a concept (label S), and
    the client's decision on it is recorded on the concept board. The Lane 2
    design view below has no board, so a Lane 2 project that holds one shows
    the board (the decision, ?decide=<id>, the checks tab, the notes) and the
    design view moves to ?design=1, with a link each way: neither hides the
    other, so a project with a real design AND a supplied homepage keeps both.
    A Lane 2 project without a supplied homepage never takes this turn.
  */
  const suppliedConcept = run?.concepts.some((c) => (c.skillId as string) === HTML_HOMEPAGE_CONCEPT && (c.status === "ready" || c.status === "held")) ?? false;
  const wantsDesignView = query.design === "1" && typeof query.decide !== "string";
  if (project.lane === "lane_2" && !classicB && !(suppliedConcept && !wantsDesignView)) {
    const flow = await loadDesignFlow(db, id, current);
    const isAdmin = can(current, "money.manage");
    const exactDesigner = designerDesignProps(id, await loadFigmaDesign(db, id));
    const optionA = project.laneOption === "a";
    const styleKitView = isAdmin ? await loadStyleKit(db, id, current) : null;
    const tidyView = isAdmin && optionA && (await hasFinishedCopies(db, id)) ? await loadTidy(db, id) : null;
    const siteVideos = await loadSiteVideos(db, id);
    const seoView = isAdmin ? await loadSeoPass(db, id) : null;
    return (
      <>
        <ProjectHeading {...heading} />
        <div className="page">
          <div className="stack">
            {suppliedConcept ? (
              <div className="card">
                <p className="card-title">A homepage file was supplied</p>
                <p className="hint">
                  It is a concept on the board, where the client&rsquo;s decision on it is recorded.{" "}
                  <Link className="plain-link" href={`/projects/${id}/mockups`}>Open the concept board</Link>.
                </p>
              </div>
            ) : null}
            {flow ? <DesignSiteFlow projectId={id} view={flow} /> : null}
            {isAdmin ? (
              <details className="card advanced-tools">
                <summary className="card-title">Advanced (admins): the design&rsquo;s exact copies and tools</summary>
                <p className="hint">Not part of the usual flow: exact copies, section scores, the style kit, repair and fill, phone versions made separately. Kept for checking and for tests.</p>
                <UndoKitRepairButton projectId={id} />
                {optionA ? null : (
                  <p className="hint">
                    <Link className="plain-link" href={`/projects/${id}/mockups?classic=1`}>Open the earlier Option B screen</Link>: the faithful copy, the improved design, the designer&rsquo;s decisions and the alternatives.
                  </p>
                )}
                <div className="stack">
            {exactDesigner ? <DesignerDesign {...exactDesigner} /> : null}
            {styleKitView ? <StyleKitCard projectId={id} view={styleKitView} repair={await loadRepairSummary(db, id)} hasCopies={await hasFinishedCopies(db, id)} /> : null}
            {optionA ? <ExactDesignCard projectId={id} view={await loadExactDesign(db, id)} canEdit={canRun} canDecide={can(current, "design.decide")} /> : null}
            {tidyView ? <WordsLinksCard projectId={id} view={tidyView} canEdit={can(current, "project.edit") || can(current, "design.decide")} /> : null}
            {tidyView ? (
              <SiteVideosCard
                projectId={id}
                text={videosText(siteVideos)}
                count={siteVideos.length}
                hasVideosPage={tidyView.options.some((o) => o.value === "/videos/")}
                canEdit={can(current, "project.edit") || can(current, "design.decide")}
              />
            ) : null}
            {tidyView && seoView ? <SeoPassCard projectId={id} view={seoView} canEdit={can(current, "project.edit") || can(current, "seo.signoff") || can(current, "design.decide")} /> : null}
                </div>
              </details>
            ) : null}
          </div>
        </div>
        {bar()}
      </>
    );
  }

  /* ---------- generating ---------- */

  if (run && isRunActive(run.status)) {
    return (
      <>
        <ProjectHeading {...heading} />
        <div className="page">
          {designer ? (
            <div className="stack option-b-stack">
              {designerCard}
              {await optionBCards()}
              <p className="section-title option-b-alternatives-title">Alternatives</p>
            </div>
          ) : null}
          <GeneratingRun
            projectId={id}
            canStop={canRun}
            run={{
              id: run.id,
              status: run.status,
              conceptCount: run.conceptCount,
              stepsDone: run.stepsDone,
              stepsTotal: run.stepsTotal,
              startedLine: await startedLine(run),
              // Every concept already built: this is the review running again.
              reviewOnly: run.concepts.every((c) => c.status === "ready"),
              // The designer's Concept 1 and a supplied homepage aren't built in the run: only the generated concepts show here.
              concepts: run.concepts.filter((c) => isGeneratedConcept(c.skillId as string)).map((c) => ({
                id: c.id,
                label: c.label,
                direction: c.direction,
                skillId: c.skillId,
                status: c.status,
                failureReason: describeAiFailure(c.failureReason)?.headline ?? null,
                steps: c.steps,
              })),
            }}
          />
        </div>
        {bar()}
      </>
    );
  }

  /* ---------- the concepts ---------- */

  // A held concept (under 4.5) still opens the board, so its card says why and an admin can show it anyway.
  const hasConcepts = run?.concepts.some((c) => c.status === "ready" || c.status === "held") ?? false;

  if (run && hasConcepts && !wantsSetup) {
    const extras = await loadConceptCards(db, current, run.concepts.map((c) => c.id));
    const cards: ConceptCard[] = run.concepts.map((c) => {
      const extra = extras.get(c.id);
      const latest = c.versions[0];
      const firstScore = c.reviews[0]?.average ?? null;
      const lastScore = c.reviews.at(-1)?.average ?? null;
      return {
        id: c.id,
        label: c.label,
        href: `/projects/${id}/mockups/${c.id}`,
        directionLabel: directionInfo(c.direction).label,
        // The designer's Concept 1 and a supplied homepage were built by no skill.
        skillLabel: isGeneratedConcept(c.skillId as string) ? (skillLabels[c.skillId] ?? c.skillId) : "",
        supplied: (c.skillId as string) === HTML_HOMEPAGE_CONCEPT,
        status: c.status,
        failureReason: describeAiFailure(c.failureReason)?.headline ?? null,
        imageUrl: extra?.imageUrl ?? null,
        version: c.latestVersion,
        reviewBefore: firstScore,
        reviewAfter: lastScore,
        checksPassed: c.checksPassed,
        failingChecks: latest?.issues.filter((i) => i.severity === "fail" && !i.needsIntake).length ?? 0,
        placeholderCount: c.placeholderCount,
        summary: extra?.summary ?? null,
        openComments: extra?.openComments ?? 0,
        sendToClient: extra?.sendToClient ?? true,
        needsPmReview: c.needsPmReview,
        pending: extra?.pending ?? null,
        lastFailure: extra?.lastFailure ?? null,
        references: extra?.references ?? null,
      };
    });

    const decision = inMockups ? null : await latestClientDecision(db, id);
    // The logo after approval (27 September 2026).
    const logoView = decision && !decision.changesRequested ? await loadLogoAfterApproval(db, id, await listPeopleNames(db)) : null;
    // Only after the review stopped: the concepts still missing theirs.
    const rerunConcepts =
      run.status === "review_incomplete" ? (await conceptsMissingReview(db, run.id)).map((c) => c.label) : [];
    const board = {
      projectId: id,
      canAct: canRun && inMockups,
      concepts: cards,
      chosenId: decision && !decision.changesRequested ? decision.conceptId : null,
      alternatives: Boolean(designer),
      designOnly: heading.journey.projectType === "design_only",
      changesEstimate: canRun && inMockups ? (await estimateChanges(db)).label : undefined,
      isAdmin: can(current, "money.manage"),
      decideFor: typeof query.decide === "string" ? query.decide : null,
      // Lane 2 Option A has no Lane 1 concepts to regenerate: its only concept is the supplied homepage.
      canRegenerate: !(project.lane === "lane_2" && project.laneOption === "a"),
    };

    return (
      <ConceptBoardProvider board={board}>
        <ProjectHeading
          {...heading}
          actions={inMockups ? <ConceptBoardActions /> : undefined}
        />
        <div className="page">
          <div className="stack">
            {decision && !decision.changesRequested ? (
              <Banner tone="done" title={`The client approved Concept ${decision.conceptLabel} v${decision.version}`}>
                Recorded {formatActivityWhen(decision.createdAt)} ({channelLabels[decision.channel as Channel]?.toLowerCase() ?? decision.channel}): &ldquo;{decision.clientSaid}&rdquo; {decision.logoApproved ? "Logo approved by the client. " : decision.logoApproved === false ? "Logo not approved yet. " : ""}The project has moved to Content.
              </Banner>
            ) : (
              <ReadyBanner
                run={run}
                cards={cards}
                rerun={
                  rerunConcepts.length > 0 && board.canAct ? (
                    <RerunReviewButton
                      projectId={id}
                      runId={run.id}
                      concepts={rerunConcepts}
                      estimate={rerunReviewEstimate(rerunConcepts.length)}
                    />
                  ) : null
                }
              />
            )}
            {logoView ? (
              <LogoAfterApprovalCard
                projectId={id}
                conceptLabel={logoView.conceptLabel}
                version={logoView.version}
                logoChanged={logoView.logoChanged}
                swap={logoView.swap}
                markLine={logoView.mark.line}
                marked={logoView.mark.approved === true}
                canAct={canRun}
              />
            ) : null}
            {project.lane === "lane_2" && !classicB ? (
              <div className="card">
                <p className="card-title">The client&rsquo;s design</p>
                <p className="hint">
                  The design&rsquo;s own pages, Build site and the preview are on their own view.{" "}
                  <Link className="plain-link" href={`/projects/${id}/mockups?design=1`}>Open the client&rsquo;s design</Link>.
                </p>
              </div>
            ) : null}
            {designerCard}
            {designer ? await optionBCards() : null}
            {designer ? <p className="section-title option-b-alternatives-title">The concept board</p> : null}
            <ConceptCards />
            {inMockups ? <NextStepsStrip /> : null}
            <PastRuns runs={pastRunRows} />
          </div>
        </div>
        {bar(inMockups ? <ConceptBoardBarActions /> : undefined)}
      </ConceptBoardProvider>
    );
  }

  /* ---------- Lane 2, Option B: the designer's design and its review ---------- */

  /*
    No Lane 1 set up here: the usual Generate would spend money on concepts
    this project does not use. Option B's own flow instead: the design, its
    review, the faithful copy, the improved design, then 0, 1 or 2
    alternatives (4c-2b), which end on the usual concept board.
  */
  if (designer) {
    return (
      <>
        <ProjectHeading {...heading} />
        <div className="page">
          <div className="stack">
            {designerCard}
            {await optionBCards()}
            {designer.status === "imported" ? await alternativesCard() : null}
            <PastRuns runs={pastRunRows} />
          </div>
        </div>
        {bar()}
      </>
    );
  }

  /* ---------- set up ---------- */

  if (!inMockups) {
    return (
      <>
        <ProjectHeading {...heading} />
        <div className="page">
          <div className="card empty-state">
            <p className="card-title">No concepts</p>
            <p className="hint">This project has moved on from Design without a concept run.</p>
          </div>
        </div>
        {bar()}
      </>
    );
  }

  const plan = await planRun(current, id, 3);
  const gaps = await getIntakeGaps(current, id);
  const missing = gaps?.required ?? [];
  const footnote =
    missing.length === 0
      ? "Intake complete. Missing facts would appear as highlighted placeholders."
      : `Not in the intake: ${missing.join(", ")}. Each concept shows these as highlighted placeholders.`;

  const lastRunProblem =
    run && !hasConcepts
      ? run.status === "stopped"
        ? "It was stopped before any concept finished."
        : (describeAiFailure(run.concepts.find((c) => c.failureReason)?.failureReason ?? run.failureReason)?.headline ??
          "Every concept failed.")
      : null;
  // The Home page words before the concepts (Lane 1, 1 October 2026).
  const words = await loadHomeWords(db, id);
  // The wireframe before the words (Growth and Pro, 3 October 2026).
  const frame = words.applies ? await loadWireframe(db, id) : null;
  const people = words.words?.approved || frame?.approved ? await listPeopleNames(db) : null;

  return (
    <>
      <ProjectHeading {...heading} />
      <div className="page">
        <div className="stack">
          {designerCard}
          {frame ? (
            <WireframeCard
              key={`${frame.approved?.at.getTime() ?? 0}-${frame.drafted ? "d" : "s"}-${frame.enabled}-${frame.sections.map((s) => s.id).join(".")}`}
              projectId={id}
              canEdit={can(current, "intake.design")}
              canSwitch={can(current, "project.edit")}
              applies={frame.applies}
              designOnly={frame.designOnly}
              tier={frame.tier}
              enabled={frame.enabled}
              sections={frame.sections}
              drafted={frame.drafted}
              sitemap={frame.sitemap}
              approvedLine={frame.approved ? `Approved by ${people?.get(frame.approved.byUserId ?? "") ?? "a team member"}, ${formatWhen(frame.approved.at)}.` : null}
            />
          ) : null}
          {words.applies && words.kept ? (
            <KeptHomeWordsCard
              state={words.kept.state}
              failure={words.kept.failure}
              readAtLine={words.kept.readAt ? `Read ${formatWhen(words.kept.readAt)}.` : null}
              waysForward={words.kept.state === "failed" ? waysForwardFor(words.kept.failure) : []}
              decisionLine={words.kept.work ? workWords(words.kept.work) : null}
              intakeHref={`/projects/${id}/intake?section=website`}
              contentHref={`/projects/${id}/content`}
              versionLine={words.kept.state === "ready" ? `From the Home page on Content, version ${words.kept.version}.` : null}
              sections={(words.kept.words?.sections ?? []).map((s, i) => ({ ...s, flag: words.kept?.flags[i] ?? null }))}
              quotes={(words.kept.words?.testimonials ?? []).map((t) => t.text)}
            />
          ) : words.applies ? (
            <HomeWordsCard
              key={`${words.words?.source ?? "none"}-${words.words?.sections.length ?? 0}-${words.words?.writing ? "w" : ""}-${words.words?.approved?.at.getTime() ?? 0}-${words.words?.sections.map((s) => s.words.length).join(".")}`}
              projectId={id}
              canEdit={canRun}
              suggested={words.suggested}
              estimateLine={words.estimate.label}
              words={
                words.words
                  ? {
                      source: words.words.source,
                      sections: words.words.sections,
                      testimonials: words.words.testimonials,
                      writing: words.words.writing,
                      writeFailure: words.words.writeFailure,
                      approvedLine: words.words.approved
                        ? `Used by ${people?.get(words.words.approved.byUserId ?? "") ?? "a team member"}, ${formatWhen(words.words.approved.at)}. Change anything, then Use these words again.`
                        : null,
                    }
                  : null
              }
            />
          ) : null}
          <MockupSetup
            projectId={id}
            canRun={canRun}
            lastRunProblem={lastRunProblem}
            plan={{
              inputs: plan.inputs,
              trade: plan.project.trade,
              tradeLabel: tradeLabels[plan.project.trade as Trade],
              emergency: isEmergencyTrade(plan.project.trade as Trade),
              moodWords: plan.moodWords,
              notes: plan.plan.notes,
              hasFoundingYear: plan.hasFoundingYear,
              limitBlocked: plan.limitBlocked,
              websiteBlocked: plan.websiteBlocked,
              websiteBlockedSection: plan.websiteBlockedSection,
              wordsBlocked: plan.wordsBlocked,
              wireframeBlocked: plan.wireframeBlocked,
              footnote,
              estimates: plan.estimates,
              estimateBasis: plan.estimateBasis,
              modelLabel: plan.buildModel !== plan.model ? `${modelLabel(plan.model)}, concept build on ${modelLabel(plan.buildModel)}` : modelLabel(plan.model),
              referenceSitesToStudy: plan.referenceSitesToStudy,
              referenceLeans: plan.referenceLeans,
              designLogInput: plan.designLogInput,
              concepts: plan.plan.concepts,
            }}
          />
          <PastRuns runs={pastRunRows} />
        </div>
      </div>
      {bar()}
    </>
  );

  /* Lane 2, Option B: the review, the faithful copy and the improved design, once the design is imported. */
  async function optionBCards() {
    if (designer?.status !== "imported") return null;
    return (
      <>
        {await designReviewCard()}
        {await designCopyCard()}
        {await designImprovementCard()}
      </>
    );
  }

  /* Lane 2, Option B: 0, 1 or 2 alternatives, built by the usual engine (4c-2b). */
  async function alternativesCard() {
    const plan = await planRun(current, id, 1);
    const limit = await getLimitState(db);
    const lastProblem =
      run && !hasConcepts
        ? run.status === "stopped"
          ? "The last alternatives were stopped before any finished."
          : (describeAiFailure(run.concepts.find((c) => c.failureReason)?.failureReason ?? run.failureReason)?.headline ??
            "The last alternatives didn't finish.")
        : null;
    return (
      <AlternativesCard
        projectId={id}
        canRun={canRun && inMockups}
        estimates={{ 1: plan.estimates[1], 2: plan.estimates[2] }}
        limitBlocked={limit.blocked ? blockedMessage(limit) : null}
        lastProblem={lastProblem}
      />
    );
  }

  /* Lane 2, Option B: the improved design card, after the copy. */
  async function designImprovementCard() {
    const improvement = await loadDesignImprovement(db, id);
    const inputs = await improvementInputs(db, id);
    const estimate = await estimateDesignImprovement(db, inputs.tickedFixes);
    const limit = await getLimitState(db);
    const blocker = !inputs.review
      ? "Needs the Creative Director’s review first."
      : !inputs.copy
        ? "Needs the faithful copy first: the fixes are made on it."
        : inputs.copy.figmaVersion !== inputs.review.figmaVersion
          ? "The review and the copy are of different imports of the design: review it or build the copy again first."
          : inputs.tickedFixes === 0
            ? "Tick at least one fix in the review first."
            : null;
    return (
      <DesignImprovementCard
        projectId={id}
        canRun={canRun && inMockups}
        estimate={estimate.label}
        limitBlocked={limit.blocked ? blockedMessage(limit) : null}
        blocker={blocker}
        tickedFixes={inputs.tickedFixes}
        improvement={
          improvement
            ? {
                status: improvement.status,
                detail: improvement.detail,
                failureReason: improvement.failureReason,
                before: improvement.before?.average ?? null,
                after: improvement.after?.average ?? null,
                changes: improvement.changes.length,
                notApplied: improvement.notApplied.length,
                line: `Built ${formatActivityWhen(improvement.finishedAt ?? improvement.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase())}${
                  improvement.startedBy ? `, started by ${improvement.startedBy}` : ""
                }; ${formatCost(improvement.cost)} of AI.`,
                imageUrl: improvement.improvedImageUrl,
                outOfDate: improvement.outOfDate,
                decisions: {
                  decided: improvement.changes.filter((c) => c.decision !== null).length,
                  total: improvement.changes.length,
                  accepted: improvement.changes.filter((c) => c.decision === "accepted").length,
                  pushedBack: improvement.changes.filter((c) => c.decision === "pushed_back").length,
                  version: !improvement.decisionsVersion
                    ? "none"
                    : improvement.decisionsVersion.status === "queued" || improvement.decisionsVersion.status === "working"
                      ? "working"
                      : improvement.decisionsVersion.status,
                },
              }
            : null
        }
      />
    );
  }

  /* Lane 2, Option B: the faithful copy card, after the review. */
  async function designCopyCard() {
    const copy = await loadDesignCopy(db, id);
    const estimate = await estimateDesignCopy(db);
    const limit = await getLimitState(db);
    const weakest = [...(copy?.fidelity?.sections ?? [])].sort((a, b) => a.score - b.score).slice(0, 2);
    return (
      <DesignCopyCard
        projectId={id}
        canRun={canRun && inMockups}
        estimate={estimate.label}
        limitBlocked={limit.blocked ? blockedMessage(limit) : null}
        drawings={await importedDrawings(db, id)}
        copy={
          copy
            ? {
                status: copy.status,
                failureReason: copy.failureReason,
                match: copy.fidelity?.overall ?? null,
                weakest: weakest.filter((s) => s.score < 90),
                line: `Built ${formatActivityWhen(copy.finishedAt ?? copy.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase())}${
                  copy.startedBy ? `, started by ${copy.startedBy}` : ""
                }; ${formatCost(copy.cost)} of AI.`,
                imageUrl: copy.copyImageUrl,
                outOfDate: copy.outOfDate,
                lowMatch: (copy.fidelity?.overall ?? 100) < FIDELITY_WARNING,
              }
            : null
        }
      />
    );
  }

  /* Lane 2, Option B: the Creative Director review card, under Concept 1. */
  async function designReviewCard() {
    const review = await loadDesignReview(db, id);
    const estimate = await estimateDesignReview(db);
    const limit = await getLimitState(db);
    const count = (grade: string) => review?.findings.filter((f) => f.grade === grade).length ?? 0;
    return (
      <DesignReviewCard
        projectId={id}
        canRun={canRun && inMockups}
        estimate={estimate.label}
        limitBlocked={limit.blocked ? blockedMessage(limit) : null}
        facts={await factsStatus(db, id)}
        review={
          review
            ? {
                status: review.status,
                failureReason: review.failureReason,
                average: review.review?.average ?? null,
                lowest: review.review?.lowest ?? null,
                summary: review.review?.summary ?? null,
                mustFix: count("must_fix"),
                shouldFix: count("should_fix"),
                recommendations: count("recommendation"),
                confirmFacts: count("confirm_fact"),
                ticked: review.findings.filter((f) => f.ticked && (f.grade === "must_fix" || f.grade === "should_fix")).length,
                line: `Reviewed ${formatActivityWhen(review.finishedAt ?? review.createdAt).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase())}${
                  review.startedBy ? `, started by ${review.startedBy}` : ""
                }; ${formatCost(review.cost)} of AI.`,
                outOfDate: review.outOfDate,
              }
            : null
        }
      />
    );
  }

  async function startedLine(r: RunProgress): Promise<string> {
    const minutes = Math.max(0, Math.round((Date.now() - r.createdAt.getTime()) / 60_000));
    const when = minutes < 1 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
    const startedBy = await startedByName(r.id);
    return `Started ${when}${startedBy ? ` by ${startedBy}` : ""}.`;
  }

  async function startedByName(runId: string): Promise<string | null> {
    const [row] = await db
      .select({ name: userTable.name, deletedAt: userTable.deletedAt })
      .from(mockupRun)
      .innerJoin(userTable, eq(userTable.id, mockupRun.startedByUserId))
      .where(eq(mockupRun.id, runId))
      .limit(1);
    if (!row) return null;
    const label = personLabel(row.name, row.deletedAt);
    if (!label) return null;
    return row.deletedAt ? label : label.split(" ")[0]!;
  }
}

function ReadyBanner({
  run,
  cards,
  rerun,
}: {
  run: RunProgress;
  cards: ConceptCard[];
  rerun?: React.ReactNode;
}) {
  const ready = cards.filter((c) => c.status === "ready");
  const open = cards.reduce((n, c) => n + c.openComments, 0);
  const flagged = cards.filter((c) => c.needsPmReview).map((c) => c.label);
  const held = cards.filter((c) => c.status === "held").map((c) => c.label);
  const failed = cards.filter((c) => c.status === "failed").map((c) => c.label);
  // A homepage the team supplied is judged by no TAWD check and no Creative Director, so the sentences about checking and scoring speak of the generated concepts only (a board of the supplied page alone says neither).
  const generated = ready.filter((c) => !c.supplied);
  const suppliedReady = ready.some((c) => c.supplied);
  const reviewed = generated.some((c) => c.reviewAfter !== null);

  const title =
    ready.length === 0 && held.length > 0
      ? "No concept reached 4.5"
      : `${ready.length} concept${ready.length === 1 ? "" : "s"} ready for team review`;
  const reviewFailure = run.status === "review_incomplete" ? describeAiFailure(run.failureReason) : null;
  const parts = [
    // A review that stopped part-way may have left some scores behind;
    // say it stopped rather than claim it finished.
    generated.length === 0
      ? null
      : run.status === "review_incomplete"
      ? reviewed
        ? "Each was checked, but the Creative Director review stopped part-way, so some scores or improvements may be missing."
        : "The Creative Director review didn't finish, so these are the checked versions without scores."
      : reviewed
        ? `${generated.length === 1 ? "It was" : "Each was"} checked and scored at 4.5 or above by the Creative Director.`
        : "Each was checked.",
    suppliedReady ? (generated.length === 0 ? "This is the homepage file the team supplied: at this stage TAWD's own checks and the Creative Director do not judge it (the go-live checks still read it)." : "The supplied homepage file (S) is not judged by TAWD's checks or the Creative Director at this stage (the go-live checks still read it).") : null,
    flagged.length > 0
      ? `Concept ${flagged.join(" and ")} still scored under 3 and needs a PM's look.`
      : null,
    held.length > 0
      ? `Concept ${held.join(" and ")} scored under 4.5 after one rewrite, so TAWD held ${held.length === 1 ? "it" : "them"} back: only concepts at 4.5 or above are shown. ${ready.length === 0 ? "An admin can Show it anyway, or start a new concept." : ""}`
      : null,
    failed.length > 0 ? `Concept ${failed.join(" and ")} didn't finish.` : null,
    `${open === 0 ? "No" : open} team comment${open === 1 ? " is" : "s are"} open.`,
  ].filter(Boolean);

  const tone = flagged.length > 0 || held.length > 0 || failed.length > 0 || run.status === "review_incomplete" ? "warning" : "done";

  return (
    <div className={tone === "done" ? "ready-banner" : "ready-banner is-warning"} role="status">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {tone === "done" ? <path d="M5 12l5 5L20 7" /> : <><circle cx="12" cy="12" r="10" /><path d="M12 7v6M12 17h.01" /></>}
      </svg>
      <div className="ready-banner-text">
        <p className="banner-title">{title}</p>
        <p>{parts.join(" ")}</p>
        {reviewFailure ? (
          <p className="ready-banner-reason">
            <strong>Why the review stopped:</strong> {reviewFailure.headline}
            {reviewFailure.kind !== "other" ? (
              <span className="ready-banner-detail"> Anthropic said: &ldquo;{reviewFailure.detail}&rdquo;</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="ready-banner-side">
        {run.finishedAt ? <span className="ready-banner-when">Finished {formatActivityWhen(run.finishedAt)}</span> : null}
        {rerun}
      </div>
    </div>
  );
}
