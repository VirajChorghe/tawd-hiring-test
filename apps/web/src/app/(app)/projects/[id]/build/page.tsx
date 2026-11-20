import Link from "next/link";
import { NextStepBar } from "@/components/project/next-step-bar";
import { buildPartHref, buildPartStates, shownBuildPart } from "@/lib/build-parts";
import { loadNextStepFor } from "@/lib/next-step";
import type { Metadata } from "next";
import { StageLock } from "@/components/project/stage-lock";
import { notFound } from "next/navigation";

import { SiteCard } from "@/components/build/site-card";
import { HostingCard } from "@/components/build/hosting-card";
import { loadHosting } from "@/lib/hosting";
import { loadWpPreview } from "@/lib/wp-preview";
import { PAID_CERT_PRICE, certRetryDue, type WpCert } from "@tawd/core/wp-preview";
import { loadPreviewCheck } from "@/lib/delivery-checks";
import { loadConnect, type ConnectView } from "@/lib/connect";
import { loadFormMessages } from "@/lib/forms-relay";
import { loadWpLive } from "@/lib/wp-golive";
import { FormMessagesCard } from "@/components/build/form-messages-card";
import { SpeedCheckCard } from "@/components/build/speed-check-card";
import { ReviewPagesCard } from "@/components/build/review-pages-card";
import { loadPageReview, pagesChecklistItem } from "@/lib/page-review";
import { loadSpeedChecks, speedForGate } from "@/lib/speed-check";
import { SPEED_MINIMUM, SPEED_TARGET } from "@tawd/core/site";
import type { ConnectCardProps } from "@/components/build/connect-panels";
import { formatMoney } from "@/lib/pricing";
import { ChecklistCard, PreviewCard } from "@/components/build/preview-cards";
import { loadPreviews } from "@/lib/netlify";
import { GoLiveCard, type GoLiveCardProps } from "@/components/build/golive-card";
import { loadGoLive, type GoLiveView, type RegistryView } from "@/lib/golive";
import { DNSSEC_ON_MESSAGE } from "@tawd/core/site";
import type { DnsRecord } from "@tawd/core/site";
import { describeRecord } from "@tawd/core/site";
import type { Viewer } from "@tawd/core/permissions";
import { SeoCheckCard } from "@/components/build/seo-check-card";
import { HealthFlagsCard } from "@/components/build/health-flags-card";
import { healthChecklistItem, loadHealthFlags } from "@/lib/health-flags";
import { loadSeoGoLive } from "@/lib/seo-golive";
import type { SeoFinding } from "@tawd/core/site";
import { listPeopleNames } from "@/lib/users";
import type { ChecklistItem } from "@tawd/core/site";
import { ProjectHeading } from "@/components/project/heading";
import { loadJourneyFacts } from "@/lib/journey";
import { getDb } from "@tawd/core/db";
import { serviceHeartbeat } from "@tawd/core/schema";
import { eq } from "drizzle-orm";
import { can } from "@tawd/core/permissions";
import { formatWhen, projectChips } from "@/lib/labels";
import { getProject } from "@/lib/projects";
import { loadSiteView, loadStages, stagesCardProps, stagesChecklistItem, type BuiltPage } from "@/lib/site-builds";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";

export const metadata: Metadata = { title: "Build - TAWD" };
export const dynamic = "force-dynamic";

/* Build A (8a): the static site, from the approved mockup and copy. Four parts since 30 September 2026 (lib/build-parts.ts). */
export default async function BuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const asked = ((await searchParams) ?? {}).part;
  const current = await requireUser();
  const db = getDb();
  const project = await getProject(db, current, id);
  const journey = project ? await loadJourneyFacts(db, id) : null;
  if (!project) notFound();
  const view = await loadSiteView(db, id);
  const previews = await loadPreviews(db, id);
  const people = await listPeopleNames(db);
  const seoCheck = await loadSeoGoLive(db, id);
  const golive = await loadGoLive(db, id);
  const health = await loadHealthFlags(db, id, people);
  const hosting = await loadHosting(db, id);
  const wp = await loadWpPreview(db, id);
  const connect = await loadConnect(db, id);
  const formMessages = await loadFormMessages(db, id);
  const wpLive = hosting?.hosting === "wordpress" ? await loadWpLive(db, id) : null;
  const showPrices = can(current, "money.manage");
  const { readiness } = view;

  const missing = readiness.exact
    ? [
        // Lane 2, Option A: the approved design's own pages (28 September 2026).
        ...(readiness.mockupApproved ? [] : ["The client's approval of the design isn't recorded yet (Design)."]),
        ...(readiness.pageCount === 0 ? ["The design's pages aren't confirmed yet (Design)."] : []),
        ...(readiness.waiting.length ? [`These pages aren't copied yet: ${readiness.waiting.join(", ")} (Design).`] : []),
      ]
    : [
        ...(readiness.mockupApproved ? [] : ["The client hasn't approved a mockup yet: the site is built from the approved one (Design)."]),
        ...(readiness.pageCount === 0 ? ["There is no page plan yet (Content)."] : []),
        ...(readiness.waiting.length
          ? [
              readiness.designOnly
                ? `These pages have no words from the current site yet (it couldn't read them): ${readiness.waiting.join(", ")}. Add their words on Content (open the page and Edit), or remove them from the plan.`
                : `Content hasn't approved these pages yet: ${readiness.waiting.join(", ")}.`,
            ]
          : []),
      ];
  const warnings = readiness.clientApprovedCopy ? [] : ["The client hasn't approved the copy pack yet. You can build now and again once they have."];
  const latest = view.latest;
  const state = !latest ? "none" : latest.status === "queued" || latest.status === "working" ? "working" : (latest.status as "done" | "failed");
  const done = view.lastDone;
  const base = done ? `/projects/${id}/build/site/${done.version}` : null;
  const pages = (done?.pages as BuiltPage[] | undefined) ?? [];
  const prefix = `projects/${id.toLowerCase()}/site/v${done?.version ?? 0}/`;
  // Staged builds (Lane 1, 6 October 2026): the stages, and whether every planned page is built.
  const stages = readiness.exact ? null : await loadStages(db, id);
  const partialLine = done && stages && !stages.allBuilt ? `${stages.count.line} in version ${done.version}: the others show a "Coming soon" page. Go-live waits until every planned page is built.` : null;
  const partFacts = {
    lane: project.lane,
    allBuilt: stages ? stages.allBuilt : true,
    hasBuild: Boolean(done),
    building: state === "working",
    signedOff: seoCheck.signedOff,
    previewApproved: previews.decision?.outcome === "approved",
    live: project.status === "live",
  };
  const part = shownBuildPart(asked, partFacts);
  const pms = project.members.filter((m) => m.roles.includes("pm")).map((m) => m.name);
  const pageReview = part === "check" ? await loadPageReview(db, id, people) : null;
  const pagesItem = pageReview ? pagesChecklistItem(pageReview) : null;
  const pagesOverride = pageReview?.overridden ? golive.row : null;

  return (
    <>
      <ProjectHeading
        projectId={id}
        clientName={project.clientName}
        crumb={part === "golive" ? "Go live" : "Build & preview"}
        chips={projectChips(project)}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        journey={journey!}
        viewing="build"
        slackWarning={await slackWarningFor(db, id)}
      />
      <div className="page">
        <StageLock projectId={id} status={project.status} lane={project.lane} stage="build" designOnly={journey?.projectType === "design_only"} />
        {project.lane === "lane_2" ? null : (
          <nav className="build-parts" aria-label="Build parts">
            {buildPartStates(partFacts).map((p, i) => (
              <Link key={p.key} href={buildPartHref(id, p.key)} className={p.key === part ? "build-part is-active" : "build-part"} aria-current={p.key === part ? "page" : undefined}>
                <span>
                  {i + 1} · {p.label}
                </span>
                <span className={p.state === "Done" ? "build-part-state is-done" : "build-part-state"}>{p.state}</span>
              </Link>
            ))}
          </nav>
        )}
        <div className="stack">
          {part === "build" ? (
            <>
              <div id="site">
                <SiteCard
                  projectId={id}
                  canBuild={can(current, "project.edit")}
                  missing={missing}
                  warnings={warnings}
                  estimateLine={view.estimate.label}
                  state={state}
                  step={latest?.step ?? null}
                  failure={latest?.status === "failed" ? latest.failureReason : null}
                  doneLine={
                    done
                      ? `Version ${done.version}, built ${formatWhen(done.finishedAt ?? done.createdAt)}: ${pages.length} page${pages.length === 1 ? "" : "s"}, ${done.fileCount} files.${latest && latest.id !== done.id && state !== "working" ? " A later build didn't finish; this is the last good one." : ""}`
                      : null
                  }
                  siteHref={base ? `${base}/` : null}
                  canSpeedUp={Boolean(done) && !((done?.checks ?? []) as { key: string; ok: boolean }[]).some((c) => c.key === "speed" && c.ok)}
                  stages={stages ? stagesCardProps(stages) : null}
                  pages={pages.map((p) => ({
                    name: p.name,
                    path: p.path,
                    href: `${base}${p.path}`,
                    shot: p.shotKey && p.shotKey.startsWith(prefix) ? `${base}/${p.shotKey.slice(prefix.length)}` : null,
                    placeholders: p.placeholders.length,
                  }))}
                />
              </div>

              {hosting ? (
                <HostingCard
                  projectId={id}
                  hosting={hosting.hosting}
                  canChange={can(current, "project.edit")}
                  locked={hosting.locked}
                  isPro={hosting.isPro}
                  showPrices={showPrices}
                  addonPrice={hosting.addonPrice}
                  addonLine={
                    hosting.addonOnProject
                      ? showPrices
                        ? `WordPress hosting, ${hosting.addonOnProject.priceCents === null ? "price not set yet" : `${formatMoney(hosting.addonOnProject.priceCents)} a month`}`
                        : "the WordPress hosting add-on is on its price"
                      : null
                  }
                  wpPreview={
                    wp
                      ? {
                          state: wp.state,
                          host: wp.host,
                          stagingHost: wp.stagingHost,
                          onStaging: wp.onStaging,
                          needsFreshPackage: wp.needsFreshPackage,
                          keepsLegacyPackage: wp.keepsLegacyPackage,
                          move: wp.move,
                          previewDomain: wp.previewDomain,
                          ipv4: wp.ipv4,
                          suspended: Boolean(wp.suspendedAt),
                          suspendedLine: wp.suspendedAt ? `Suspended at 20i ${formatWhen(wp.suspendedAt)}: visitors don't see the site.` : null,
                          previewCert: wp.certs.preview ? { state: wp.certs.preview.state, note: wp.certs.preview.note, expires: wp.certs.preview.expiresAt ? wp.certs.preview.expiresAt.slice(0, 10) : null, retry: certRetryDue(wp.certs.preview) } : null,
                          needsLimitConfirm: wp.needsLimitConfirm && !wp.limitConfirmedBy,
                          packagesUsed: wp.packagesUsed,
                          plan: wp.plan,
                          fromBluehost: wp.fromBluehost,
                          suspendPending: wp.suspendJob && "pending" in wp.suspendJob ? wp.suspendJob.pending : null,
                          suspendRefused: wp.suspendJob && "refused" in wp.suspendJob ? `20i didn't ${wp.suspendJob.refused} the site (${formatWhen(wp.suspendJob.at)}): ${wp.suspendJob.reason}. Try again, or do it in My20i.` : null,
                          version: wp.version,
                          deployedVersion: wp.deployedVersion,
                          latestBuild: wp.latestBuild,
                          https: wp.https,
                          steps: wp.steps,
                          removing: wp.removing,
                          blockers: wp.blockers,
                          canDeploy: can(current, "project.edit"),
                          isAdmin: can(current, "settings.manage"),
                          liveDomain: wpLive?.liveState === "live" ? wpLive.domain : null,
                          gravityForms: hosting.formPlugin === "gravityforms",
                          formCheck: await previewCheckLine(db, id),
                          statusLine:
                            wp.state === "deploying"
                              ? `Deploying version ${wp.version}${wp.startedBy ? `, started by ${people.get(wp.startedBy) ?? "a team member"}` : ""}.`
                              : wp.state === "removing"
                                ? "Removing the site from 20i."
                                : wp.state === "ready" && wp.deployedAt
                                  ? `Version ${wp.deployedVersion} is on the preview, deployed ${formatWhen(wp.deployedAt)}${wp.startedBy ? ` by ${people.get(wp.startedBy) ?? "a team member"}` : ""}.`
                                  : wp.state === "removed"
                                    ? "The preview was removed."
                                    : null,
                        }
                      : null
                  }
                  formPlugin={{ value: hosting.formPlugin, keyMissing: await gfKeyMissing(db) }}
                  wpPackage={{ version: done?.version ?? null, href: done ? `/projects/${id}/build/wordpress-package/${done.version}` : null }}
                  changedLine={hosting.changed ? `Changed ${formatWhen(hosting.changed.at)}${hosting.changed.userId ? ` by ${people.get(hosting.changed.userId) ?? "a team member"}` : ""}.` : null}
                />
              ) : null}
            </>
          ) : null}

          {part === "check" ? (
            <>
              {done?.checks ? (
                <ChecklistCard
                  version={done.version}
                  items={[
                    // Health and beauty rules: each flag fixed or confirmed with the client (26 September 2026).
                    ...(done.checks as ChecklistItem[]).map((c) => (c.key === "health" && health ? healthChecklistItem(c, health.flags) : c)),
                    // The SEO team's sign-off of this version (26 September 2026): go-live needs it.
                    {
                      key: "seo-signoff",
                      label: "SEO team sign-off",
                      ok: seoCheck.signedOff,
                      detail: seoCheck.signedOff ? "Signed off for this version" : "Run the SEO check below, then the SEO team signs off",
                      blocksGoLive: true,
                    },
                    // Every planned page built (staged builds, 6 October 2026).
                    ...(stagesChecklistItem(stages) ? [stagesChecklistItem(stages)!] : []),
                    // Every page reviewed and approved (step 3a, 3 October 2026).
                    ...(pagesItem ? [pagesItem] : []),
                  ]}
                />
              ) : null}

              {pageReview && pageReview.version !== null && pageReview.pages.length > 0 ? (
                <ReviewPagesCard
                  projectId={id}
                  version={pageReview.version}
                  canReview={can(current, "site.review_pages")}
                  canOverride={can(current, "site.golive")}
                  overriddenLine={
                    pagesOverride?.pagesOverrideAt
                      ? `${people.get(pagesOverride.pagesOverrideBy ?? "") ?? "A founder"} let version ${pageReview.version} go live with ${pageReview.approvedCount} of ${pageReview.pages.length} pages approved, ${formatWhen(pagesOverride.pagesOverrideAt)}.`
                      : null
                  }
                  pages={pageReview.pages.map((p) => ({
                    pageId: p.pageId,
                    name: p.name,
                    path: p.path,
                    approvedLine: p.approved ? `Approved by ${p.approved.by.split(" ")[0]} on version ${p.approved.version}, ${formatWhen(p.approved.at)}` : null,
                    partsChangedOnly: p.partsChangedOnly,
                    openComments: p.openComments,
                  }))}
                />
              ) : null}

              {health ? (
                <HealthFlagsCard
                  projectId={id}
                  version={health.version}
                  canConfirm={can(current, "project.edit")}
                  flags={health.flags.map((f) => ({
                    id: f.id,
                    rule: f.rule,
                    found: f.found,
                    confirmedLine: f.confirmed ? `Confirmed with the client by ${f.confirmed.by}, ${formatWhen(f.confirmed.at)}: ${f.confirmed.note}` : null,
                  }))}
                />
              ) : null}

              <div id="seo-check">
                <SeoCheckCard
                  projectId={id}
                  canRun={can(current, "seo.research")}
                  canFix={can(current, "content.plan")}
                  canSignOff={can(current, "seo.signoff")}
                  hasBuild={Boolean(done)}
                  estimateLine={seoCheck.estimate.label}
                  state={seoCheck.check ? (seoCheck.check.status as "queued" | "working" | "done" | "failed") : "none"}
                  checkId={seoCheck.check?.id ?? null}
                  doneLine={seoCheck.check?.status === "done" && seoCheck.check.finishedAt ? `Version ${seoCheck.check.version}, checked ${formatWhen(seoCheck.check.finishedAt)}.` : null}
                  stale={Boolean(seoCheck.check && seoCheck.latestVersion !== null && seoCheck.check.version !== seoCheck.latestVersion)}
                  summary={seoCheck.check?.summary ?? null}
                  failure={seoCheck.check?.failureReason ?? null}
                  findings={((seoCheck.check?.findings as SeoFinding[] | undefined) ?? []).map((f) => ({ key: f.key, page: f.page, problem: f.problem, fix: f.fix, safe: f.safe, fixed: Boolean(f.fixed) }))}
                  signedOffLine={
                    seoCheck.signedOff && seoCheck.check?.signedOffAt
                      ? `Signed off by ${people.get(seoCheck.check.signedOffByUserId ?? "") ?? "the SEO team"}, ${formatWhen(seoCheck.check.signedOffAt)}${seoCheck.check.signOffNote ? `: "${seoCheck.check.signOffNote}"` : "."}`
                      : null
                  }
                />
              </div>
            </>
          ) : null}

          {part === "preview" ? (
              <div id="preview">
                <PreviewCard
                  projectId={id}
                  canDeploy={can(current, "project.edit")}
                  missing={previews.setup.missing}
                  hasBuild={Boolean(done)}
                  staleLine={
                    done && previews.deploys[0]?.state === "ready" && previews.deploys[0].version !== done.version
                      ? `Version ${done.version} is the latest build; the preview shows version ${previews.deploys[0].version}.`
                      : null
                  }
                  partialLine={partialLine}
                  uploading={previews.deploys[0]?.state === "uploading"}
                  deploys={previews.deploys.map((d) => ({
                    id: d.id,
                    line: `Version ${d.version}, ${formatWhen(d.readyAt ?? d.createdAt)}${d.startedByUserId ? `, by ${people.get(d.startedByUserId) ?? "a team member"}` : ""}`,
                    url: d.url,
                    state: d.state as "uploading" | "ready" | "failed",
                    error: d.error,
                    warning: d.state === "ready" ? d.accessWarning : null,
                  }))}
                  site={previews.site ? { url: previews.site.url, formEmails: previews.site.formEmails as string[] } : null}
                  decisionLine={
                    previews.decision
                      ? `${previews.decision.outcome === "approved" ? "The client approved the site" : "The client asked for changes"} (${previews.decision.channel}, ${formatWhen(previews.decision.createdAt)}): "${previews.decision.clientSaid}"`
                      : null
                  }
                  decisionChanges={previews.decision?.outcome === "changes_requested"}
                  wordpress={hosting?.hosting === "wordpress" ? { ready: wp?.state === "ready" && wp.deployedVersion != null } : null}
                />
              </div>
          ) : null}

          {part === "golive" ? (
            <>
              <SpeedCheckCard
                projectId={id}
                canCheck={can(current, "project.edit")}
                targets={(await loadSpeedChecks(db, id)).map((t) => ({ ...t, last: t.last ? { ...t.last, when: formatWhen(t.last.at) } : null }))}
                gate={speedGateLine(await speedForGate(db, id), can(current, "site.golive"))}
              />
              <FormMessagesCard
                projectId={id}
                canEdit={can(current, "project.edit")}
                setupMissing={formMessages.setup.missing}
                recipients={formMessages.recipients.map((r) => ({ ...r, line: r.line?.replace(/(Confirmed|Test sent) (\S+)$/, (_m, word: string, at: string) => `${word} ${formatWhen(new Date(at))}`) ?? null }))}
                messages={formMessages.messages.map((m) => ({ id: m.id, when: formatWhen(m.at), form: m.form, visitor: m.visitor, status: m.status, detail: m.detail }))}
                alert={formMessages.alert}
              />
              <div id="go-live">
                <GoLiveCard {...goLiveCardProps(id, golive, current, people)} pmLine={pms.length ? pms.join(", ") : "A PM"} connect={{ ...connectProps(connect, golive, people), wordpress: hosting?.hosting === "wordpress" }}
                  wordpress={
                    hosting?.hosting === "wordpress"
                      ? {
                          domain: wpLive?.domain ?? golive.row.domain,
                          previewHost: wpLive?.previewHost ?? "the preview address",
                          onHost: Boolean(wpLive?.onHost),
                          onHostLine: wpLive?.onHostAt ? `${wpLive.domain} and www are on the site's 20i package (IP ${wpLive.ipv4 ?? "unknown"}), added ${formatWhen(wpLive.onHostAt)}.` : null,
                          note: wpLive?.note ?? null,
                          certPath: wpLive?.certPath ?? "manual",
                          cert: wpLive?.cert ? { state: wpLive.cert.state, line: wpCertLine(wpLive.cert), note: wpLive.cert.note, paidId: wpLive.cert.paidId ?? null, retry: certRetryDue(wpLive.cert) } : null,
                          paidPrice: PAID_CERT_PRICE,
                          isAdmin: can(current, "settings.manage"),
                          ipLine: wpLive?.ipProblem
                            ? wpLive.ipProblem.fixedAt
                              ? `20i moved the site to ${wpLive.ipProblem.apiIp}; TAWD pointed the domain at it (VML's Cloudflare).`
                              : `20i moved the site to ${wpLive.ipProblem.apiIp}, and the domain still points at ${wpLive.ipProblem.apex.join(", ") || "nothing"}: the client changes the A record (Connect the domain shows it; Make a new client link sends them the steps).`
                            : null,
                          suspended: Boolean(wpLive?.suspended),
                          liveState: wpLive?.liveState ?? null,
                          liveSteps: wpLive?.liveSteps ?? [],
                          hasBackup: Boolean(wpLive?.rollbackTo),
                          backupLine: wpLive?.rollbackTo ? `${wpLive.rollbackTo.kind === "golive" ? "before go-live" : "before the update"}, ${formatWhen(new Date(wpLive.rollbackTo.at))}` : null,
                          undoLine: wpLive?.undoTo ? `as it was before the Roll back, ${formatWhen(new Date(wpLive.undoTo.at))}` : null,
                        }
                      : null
                  }
                />
              </div>

              <p className="hint" id="edits">
                Monthly edits are on <a href={`/projects/${id}/updates`}>Updates</a>{project.status === "live" ? "." : ", once the site is live."}
              </p>
            </>
          ) : null}
        </div>
      </div>
      <NextStepBar next={await loadNextStepFor(db, current, id)} here={`/projects/${id}/build?part=${part}`} />
    </>
  );
}

/* The WordPress certificate's line on the Go live card (20i, 5 October 2026). */
function wpCertLine(cert: WpCert): string {
  const by = cert.source === "letsencrypt" ? "TAWD's Let's Encrypt certificate" : cert.source === "twentyi_paid" ? `20i's certificate${cert.paidPrice ? ` ($${cert.paidPrice.toFixed(2)} a year${cert.renewsAt ? `, renews ${cert.renewsAt.slice(0, 10)}` : ""})` : ""}` : "A certificate installed by hand";
  const until = cert.expiresAt ? ` until ${cert.expiresAt.slice(0, 10)}` : "";
  if (cert.state === "ok") return `${by} for ${cert.host}${until}: HTTPS works.`;
  if (cert.state === "installing") return `${by} for ${cert.host}${until}: being installed at 20i (up to 30 minutes).`;
  if (cert.state === "requested") return certRetryDue(cert) ? `${by} for ${cert.host}: asked for over half an hour ago and not finished (the worker may have restarted). Try again.` : `${by} for ${cert.host}: on its way.`;
  return `${by} for ${cert.host}: not issued.`;
}

/* The Go live card's lines, in plain words, from the go-live row (Phase 9, 28 September 2026). */
/* The registrar and DNSSEC panel (28 September 2026). */
function registryProps(r: GoLiveView["row"]): GoLiveCardProps["steps"]["registry"] {
  const reg = r.registry as RegistryView | null;
  if (!reg) return null;
  return {
    registrar: reg.registrar,
    registrarUrl: reg.registrarUrl && /^https?:\/\//.test(reg.registrarUrl) ? reg.registrarUrl : null,
    nameservers: reg.nameservers,
    dnssec: reg.dnssec,
    checkedLine: `Checked ${formatWhen(new Date(reg.checkedAt))} (RDAP and public DNS).`,
    blocker: reg.dnssec === true && r.domain ? DNSSEC_ON_MESSAGE(r.domain, reg.registrar) : null,
  };
}

/* The speed gate in words, for the Speed check card (Jason, 1 October 2026: aim 90, 85 to 89 the buffer, under 85 blocks go-live). */
function speedGateLine(speed: Awaited<ReturnType<typeof speedForGate>>, canOverride: boolean) {
  if (!speed.checked) return { state: "none" as const, line: `Go live needs a Speed check of the ${speed.preview} of the latest build: ${SPEED_MINIMUM} or more on a phone and a computer (the aim is ${SPEED_TARGET}).`, canOverride: false };
  const low = Math.min(speed.checked.phone ?? 0, speed.checked.computer ?? 0);
  const scores = `phone ${speed.checked.phone ?? "no score"}, computer ${speed.checked.computer ?? "no score"}`;
  if (low < SPEED_MINIMUM && speed.overridden) return { state: "overridden" as const, line: `Speed for go-live: ${scores}, below ${SPEED_MINIMUM}; a founder let this build go live.`, canOverride: false };
  if (low < SPEED_MINIMUM) return { state: "low" as const, line: `Speed for go-live: ${scores}. Both need ${SPEED_MINIMUM} or more (the aim is ${SPEED_TARGET}), or a founder lets it go live.`, canOverride };
  if (low < SPEED_TARGET) return { state: "buffer" as const, line: `Speed for go-live: ${scores}, within the buffer (the aim is ${SPEED_TARGET}).`, canOverride: false };
  return { state: "good" as const, line: `Speed for go-live: ${scores}. Good.`, canOverride: false };
}

/* The WordPress preview's last form check by hand, its time in words. */
async function previewCheckLine(db: ReturnType<typeof getDb>, projectId: string) {
  const check = await loadPreviewCheck(db, projectId);
  return check ? { status: check.status, detail: check.detail, at: formatWhen(check.at) } : null;
}

/* Whether the worker reported VML's Gravity Forms licence key (names only, never the value). */
async function gfKeyMissing(db: ReturnType<typeof getDb>): Promise<boolean> {
  const [worker] = await db.select().from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
  return !((worker?.env ?? {}) as Record<string, boolean>).GRAVITY_FORMS_LICENSE_KEY;
}

/* F3, Connect the domain: the card's lines, in plain words. */
function connectProps(v: ConnectView, golive: GoLiveView, people: Map<string, string>): ConnectCardProps {
  const f = v.found;
  const by = { pm: "by the PM", client: "after the client said it's done", auto: "automatically" } as const;
  const access = process.env.VML_DNS_ACCESS_EMAIL?.trim() || "your Velocity Media Lab contact's email";
  return {
    path: v.path,
    found: f
      ? {
          dns: f.host?.name ?? null,
          dnsUrl: f.host?.url ?? null,
          email: f.email?.name ?? null,
          pointsAt: f.snapshot.apexA.join(", ") || "nothing yet",
          advice: f.advice.path,
          adviceWhy: `Recommended: ${f.advice.why}`,
          lookedUpLine: `Looked up ${formatWhen(new Date(f.at))}.`,
        }
      : null,
    wanted: v.wanted.map((w) => ({ type: w.type, host: w.host, value: w.value })),
    changes: v.changes,
    checkLine: v.check && !v.check.ok ? `Checked ${formatWhen(new Date(v.check.at))} (${by[v.check.by]}): not yet. ${v.check.changes.length} change${v.check.changes.length === 1 ? "" : "s"} to go.` : null,
    recordsOk: Boolean(v.recordsOkAt),
    okLine: v.recordsOkAt ? `Pointing at the new site on both public resolvers since ${formatWhen(v.recordsOkAt)}.` : null,
    clientLinkLine: v.clientLinkAt ? `Link made ${formatWhen(v.clientLinkAt)}${golive.row.clientLinkBy ? ` by ${people.get(golive.row.clientLinkBy) ?? "a team member"}` : ""}.` : null,
    clientDoneLine: v.clientDoneAt ? `The client said it's done, ${formatWhen(v.clientDoneAt)}.` : null,
    instructions: v.instructions,
    access: v.guide?.access ? v.guide.access.replace("the VML email below", access) : null,
    emailLine: `Leave everything else alone: the email records (MX, TXT)${f?.email ? ` for ${f.email.name}` : ""} must not change.`,
    locked: Boolean(golive.row.wentLiveAt),
  };
}

function goLiveCardProps(projectId: string, view: GoLiveView, current: Viewer, people: Map<string, string>): Omit<GoLiveCardProps, "pmLine" | "connect"> {
  const r = view.row;
  const who = (id: string | null) => (id ? (people.get(id) ?? "a team member") : "a team member");
  const records = ((r.emailRecords as DnsRecord[] | null) ?? []).map(describeRecord);
  const check = (r.emailCheck as { record: string; ok: boolean }[] | null) ?? [];
  const nameservers = (r.nameservers as string[] | null) ?? [];
  const live = view.liveDeploys.find((d) => d.state === "ready");
  return {
    projectId,
    canEdit: can(current, "project.edit"),
    canGoLive: can(current, "site.golive"),
    canMoney: can(current, "golive.fee"),
    cloudflareMissing: view.cloudflare.missing,
    fee: view.fee ? { line: `Paid ${view.fee.paidOn} by ${view.fee.method}${view.fee.note ? ` (${view.fee.note})` : ""}.` } : null,
    domainFromIntake: view.domainFromIntake,
    steps: {
      domain: {
        done: Boolean(r.domainConfirmedAt),
        line: r.domainConfirmedAt ? `${r.domain}, at ${r.registrar}, registered to ${r.registrant}. Confirmed by ${who(r.domainConfirmedBy)}, ${formatWhen(r.domainConfirmedAt)}.` : "The domain, its registrar and the registrant (always the client).",
        domain: r.domain,
        registrar: r.registrar ?? "",
        registrant: r.registrant ?? "",
      },
      email: {
        done: Boolean(r.emailReadAt),
        line: r.emailReadAt ? `${records.length} record${records.length === 1 ? "" : "s"} found, ${formatWhen(r.emailReadAt)}.${records.some((x) => x.startsWith("MX")) ? "" : " No MX records: the domain may not have email."}` : "Read from public DNS before anything changes.",
        records,
        selectors: (r.dkimSelectors as string[] | null) ?? [],
      },
      cloudflare: {
        done: Boolean(r.cloudflareReadyAt),
        line: r.cloudflareReadyAt ? `The zone is on VML's Cloudflare account with the email records and the Netlify records (not proxied), ${formatWhen(r.cloudflareReadyAt)}.` : "The zone on VML's Cloudflare account, with the email records copied and the site's records added.",
        nameservers,
      },
      check: {
        done: Boolean(r.emailVerifiedAt),
        line: r.emailVerifiedAt ? `Every email record matches on Cloudflare and at its nameserver, ${formatWhen(r.emailVerifiedAt)}.` : check.length ? `${check.filter((c) => !c.ok).length} of ${check.length} don't match yet.` : "Each copied record checked on Cloudflare and at its nameserver.",
        results: check,
      },
      confirm: {
        done: Boolean(r.emailConfirmedAt),
        line: r.emailConfirmedAt ? `Confirmed with the client's email provider by ${who(r.emailConfirmedBy)}, ${formatWhen(r.emailConfirmedAt)}: ${r.emailConfirmNote}` : "The PM confirms the records with the client's email provider.",
      },
      netlify: { done: Boolean(r.netlifyDomainAt), line: r.netlifyDomainAt ? `${r.domain} and www.${r.domain} are on the Netlify site, ${formatWhen(r.netlifyDomainAt)}.` : "The domain and www added to the project's Netlify site." },
      registry: registryProps(r),
      switched: { done: Boolean(r.nameserversSwitchedAt), line: r.nameserversSwitchedAt ? `Switched to Cloudflare's nameservers, seen ${formatWhen(r.nameserversSwitchedAt)}.` : "Done at the registrar by the client or the PM; TAWD checks it." },
      https: { done: Boolean(r.httpsConfirmedAt), line: r.httpsConfirmedAt ? `https://${r.domain} answers with a valid certificate, ${formatWhen(r.httpsConfirmedAt)}.` : "Netlify issues the certificate after the switch; TAWD checks it." },
      ga4: { done: Boolean(r.ga4RecordedAt), line: r.ga4RecordedAt ? `Property ${r.ga4PropertyId} (${r.ga4MeasurementId}), the client's own, VML as Editor. Recorded by ${who(r.ga4EditorConfirmedBy)}, ${formatWhen(r.ga4RecordedAt)}.` : "Recorded by hand; the site loads the ID from the Tracking card." },
    },
    gate: view.gate,
    live: r.wentLiveAt ? { line: `Live on ${r.liveUrl} since ${formatWhen(r.wentLiveAt)}, showing build v${r.liveVersion}${live ? ` (published ${formatWhen(live.readyAt ?? r.wentLiveAt)})` : ""}.`, url: r.liveUrl } : null,
    canRollBack: view.canRollBack,
    lastError: r.lastError,
  };
}
