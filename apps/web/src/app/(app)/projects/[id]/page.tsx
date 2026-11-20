import type { Metadata } from "next";
import { ProjectCapCard } from "@/components/money/project-cap";
import { projectCapState } from "@/lib/spend";
import { notFound } from "next/navigation";

import { CompletenessSummary, FitWarningPanel, TierWarningPanel } from "@/components/intake/status";
import { NextStepCard, ProjectTabs, StandingCard } from "@/components/project/next-step-card";
import { ResumeProjectButton } from "@/components/project/resume-project";
import { MIN_PAUSE_REASON, lastPause, planResume } from "@/lib/resume";
import { PauseProjectCard } from "@/components/project/pause-project";
import { loadJourneyFacts } from "@/lib/journey";
import { loadProjectNext } from "@/lib/next-step";
import { DeleteProjectArea } from "@/components/project/delete-project";
import { ProjectHeading } from "@/components/project/heading";
import { Timeline } from "@/components/timeline";
import { ButtonLink } from "@/components/ui/button";
import { getDb } from "@tawd/core/db";
import { projectChips, statusLabels } from "@/lib/labels";
import { loadIntake } from "@tawd/core/intake/service";
import { goLiveFlags } from "@tawd/core/intake";
import { can } from "@tawd/core/permissions";
import { deleteBlocker } from "@/lib/project-deletion";
import { getProject, getProjectTimeline } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { listPeopleNames } from "@/lib/users";
import { SlackCard } from "@/components/project/slack-card";
import { getSlackStatus } from "@/lib/slack-settings";
import { formatActivityWhen } from "@/lib/project-overview";
import { ProjectMoney } from "@/components/money/project-money";
import { projectHours } from "@/lib/edits";
import { dayLabel, formatMoney, loadProjectMoney, moneyInputValue as dollars } from "@/lib/pricing";
import { pacificToday } from "@/lib/spend-report";
import { ClientDesignCard } from "@/components/client-design-card";
import { TrackingCard } from "@/components/project/tracking-card";
import { loadTracking } from "@/lib/tracking";
import { hasApprovedMockup, loadClientDesignDoc } from "@/lib/client-design";

export const metadata: Metadata = { title: "Project - TAWD" };
export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const rawTab = ((await searchParams) ?? {}).tab;
  const tab = rawTab === "settings" || rawTab === "history" ? rawTab : "overview";
  const current = await requireUser();
  const db = getDb();

  const project = await getProject(db, current, id);
  const designDoc = project ? await loadClientDesignDoc(db, id) : null;
  const approvedMockup = project ? await hasApprovedMockup(db, id) : false;
  const tracking = await loadTracking(db, id);
  if (!project) notFound();

  const timeline = await getProjectTimeline(db, current, id);
  const people = await listPeopleNames(db);
  const intake = await loadIntake(db, current, id);
  const slack = await getSlackStatus(db, id);
  // Admins only: what this client pays. No card or payment data.
  const money = can(current, "money.manage") ? await loadProjectMoney(db, id) : null;
  const cap = can(current, "money.manage") ? await projectCapState(db, id) : null;
  // 8c: the month's dev hours against the 8 the plan includes, once there is a site to edit.
  const hours = ["build", "qa", "live"].includes(project.status) ? await projectHours(db, id) : null;
  const flags = intake
    ? goLiveFlags({ projectTrade: project.trade, intake: intake.data, files: intake.files })
    : [];

  const intakeComplete = intake?.completeness.isComplete ?? false;

  const journey = (await loadJourneyFacts(db, id, intakeComplete))!;
  const nextView = await loadProjectNext(db, {
    projectId: id,
    facts: journey,
    laneOption: project.laneOption,
    members: project.members,
    missing: intake?.completeness.missing.map((m) => m.label) ?? [],
  });

  // A paused project: where Resume takes it (29 September 2026).
  const resume = project.status === "paused" ? await planResume(db, id) : null;
  const paused = project.status === "paused" ? await lastPause(db, id) : null;
  const pausedLine = paused ? `Paused${paused.by ? ` by ${paused.by}` : ""}, ${dayLabel(paused.at)}${paused.reason ? `: ${paused.reason}` : "."}` : null;

  return (
    <>
      <ProjectHeading
        slackWarning={
          slack.lastError && slack.lastErrorAt
            ? `A Slack update didn't go through (${formatActivityWhen(slack.lastErrorAt)}): ${slack.lastError}`
            : null
        }
        projectId={id}
        clientName={project.clientName}
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey}
        actions={
          can(current, "project.edit") ? (
            <ButtonLink href={`/projects/${id}/edit`} variant="text" small>
              Edit project details
            </ButtonLink>
          ) : undefined
        }
      />

      <div className="page">
        <div className="stack">
          {intake?.tierWarning ? (
            <TierWarningPanel warning={intake.tierWarning} />
          ) : null}
          {intake?.fitWarning ? <FitWarningPanel warning={intake.fitWarning} /> : null}

          <ProjectTabs projectId={id} tab={tab} />

          {tab === "overview" ? (
            <>
              <NextStepCard
                view={nextView}
                extraLine={pausedLine}
                actions={
                  resume ? (
                    can(current, "project.change_status") ? (
                      <ResumeProjectButton projectId={id} clientName={project.clientName} stageLabel={statusLabels[resume.to]} known={resume.known} />
                    ) : (
                      <p className="hint">A PM or an admin can resume it.</p>
                    )
                  ) : undefined
                }
              />
              <StandingCard view={nextView} />

              {intake ? (
                <CompletenessSummary
                  completeness={intake.completeness}
                  href={`/projects/${id}/intake`}
                />
              ) : null}

              {designDoc || approvedMockup ? (
                <ClientDesignCard
                  projectId={id}
                  doneLine={
                    designDoc
                      ? `Version ${designDoc.version}, from ${designDoc.source === "figma" ? "the designer's approved Figma design" : "the approved mockup"}${designDoc.conceptVersion ? ` (v${designDoc.conceptVersion})` : ""}, ${formatActivityWhen(designDoc.createdAt)}.`
                      : null
                  }
                  sections={designDoc ? [...designDoc.markdown.matchAll(/^## \d+\. (.+)$/gm)].map((m) => m[1]!) : []}
                  canWrite={can(current, "project.edit")}
                  approved={approvedMockup}
                />
              ) : null}

              {flags.length > 0 ? (
                // Never blocks design work; the founders see it before go-live.
                <div className="card golive-card">
                  <h2 className="card-title">For the go-live check</h2>
                  <p className="hint">
                    The founders see these before the site goes live. They don&rsquo;t hold up the
                    design, content or build.
                  </p>
                  <ul>
                    {flags.map((flag) => (
                      <li key={flag.key}>
                        <strong>{flag.label}:</strong> {flag.line}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {hours ? (
                <div className="card">
                  <h2 className="card-title" style={{ marginBottom: 6 }}>
                    Monthly edits
                  </h2>
                  <p className={hours.over > 0 ? "hint content-warn" : "hint"}>
                    {hours.line}. Requests, quotes and time are on <a href={`/projects/${id}/updates`}>Updates</a>.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "settings" ? (
            <>
              <TrackingCard
                projectId={id}
                initial={{ ga4: tracking.ga4, gtm: tracking.gtm, metaPixel: tracking.metaPixel, googleAds: tracking.googleAds, callRail: tracking.callRail, consentMode: tracking.consentMode }}
                canEdit={can(current, "project.edit")}
                savedLine={tracking.updatedAt ? `Last saved ${formatActivityWhen(tracking.updatedAt)}.` : null}
              />

              <div id="slack">
                <SlackCard
                  projectId={id}
                  canEdit={can(current, "project.edit")}
                  status={{
                    available: slack.available,
                    connected: slack.connected,
                    hint: slack.hint,
                    postComments: slack.postComments,
                    lastPost: slack.lastPostAt ? formatActivityWhen(slack.lastPostAt) : null,
                    lastError: slack.lastError,
                    lastErrorWhen: slack.lastErrorAt ? formatActivityWhen(slack.lastErrorAt) : null,
                  }}
                />
              </div>

              {cap ? (
                <ProjectCapCard
                  projectId={id}
                  isTest={cap.isTest}
                  capCents={cap.savedCapCents}
                  spent={formatMoney(Math.round(cap.spentDollars * 100))}
                  capLine={cap.capDollars === null ? "No cap is set." : `The cap is ${formatMoney(Math.round(cap.capDollars * 100))}; ${formatMoney(Math.max(0, Math.round((cap.capDollars - cap.spentDollars) * 100)))} is left.`}
                />
              ) : null}

              {money ? (
                <ProjectMoney
                  projectId={id}
                  packageKey={money.packageKey}
                  packageName={money.packageName}
                  buildFee={dollars(money.buildFeeCents)}
                  monthlyFee={dollars(money.monthlyFeeCents)}
                  buildFeeText={formatMoney(money.buildFeeCents)}
                  monthlyFeeText={formatMoney(money.monthlyFeeCents)}
                  liveOn={money.liveAt ? dayLabel(money.liveAt) : null}
                  cancelledOn={money.cancelledOn}
                  cancelledOnText={money.cancelledOn ? dayLabel(money.cancelledOn) : null}
                  cancelReason={money.cancelReason}
                  packages={money.packages.map((p) => ({ key: p.key, name: p.name, buildFee: dollars(p.buildFeeCents), monthlyFee: dollars(p.monthlyFeeCents) }))}
                  today={pacificToday()}
                  addons={money.addons
                    .filter((a) => !a.monthly)
                    .map((a) =>
                      a.quantity > 1
                        ? `${a.name}: ${a.quantity} pages${a.priceCents === null ? ", price not set" : ` at ${formatMoney(a.priceCents)}, ${formatMoney(a.priceCents * a.quantity)}`}`
                        : `${a.name}: ${a.priceCents === null ? "price not set" : formatMoney(a.priceCents)}`,
                    )}
                  monthlyAddons={money.addons.filter((a) => a.monthly).map((a) => `${a.name}: ${a.priceCents === null ? "price not set" : `${formatMoney(a.priceCents)} a month`}`)}
                />
              ) : null}

              {project.status === "paused" ? null : (
                <PauseProjectCard projectId={id} clientName={project.clientName} canPause={can(current, "project.change_status")} minReason={MIN_PAUSE_REASON} />
              )}

              {can(current, "project.delete") ? (
                <DeleteProjectArea
                  projectId={id}
                  clientName={project.clientName}
                  blocker={deleteBlocker(project.status, project.liveAt)}
                />
              ) : null}
            </>
          ) : null}

          {tab === "history" ? (
            <>
              <div className="card">
                <h2 className="card-title" style={{ marginBottom: 16 }}>
                  History
                </h2>
                <Timeline items={timeline} people={people} />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
