import { loadNextStepFor } from "@/lib/next-step";
import { loadSiteRead, sitePanelView } from "@/lib/site-read";
import type { Metadata } from "next";
import { getDmaMarkets } from "@/lib/seo-data";
import { notFound } from "next/navigation";

import { ProjectHeader } from "@/components/intake/project-header";
import { loadJourneyFacts } from "@/lib/journey";
import { slackWarningFor } from "@/lib/slack-settings";
import { IntakeWorkspace, type Section } from "@/components/intake/workspace";
import { figmaBadge, figmaSectionView, loadFigmaDesign, pendingPrefills } from "@/lib/figma";
import { figmaReadsThisMonth } from "@tawd/core/figma/service";
import { getDb } from "@tawd/core/db";
import { projectChips } from "@/lib/labels";
import { intakeSectionKeys, type IntakeSectionKey } from "@tawd/core/intake";
import { buildSectionStatuses, hasAnyContent } from "@tawd/core/intake";
import { loadIntake } from "@tawd/core/intake/service";
import { latestPrefillStamp } from "@tawd/core/intake/prefill";
import { can } from "@tawd/core/permissions";
import { getProject } from "@/lib/projects";
import { loadBrandGuide } from "@/lib/brand-guide";
import { loadLogoDesign } from "@/lib/logo-design";
import { loadPhotoTextCheck, loadReferenceStudy } from "@/lib/mockup-inputs";
import { planDesignUpload } from "@/lib/design-upload";
import { sweepStuckWork } from "@tawd/core/stuck-work";
import { loadLikedShots } from "@/lib/liked-sites";
import { requireUser } from "@/lib/session";
import { typeChangeWork } from "@/lib/project-type";
import { newReadView } from "@/lib/design-read-new";
import { newReadCorrections } from "@/lib/design-read-corrections";
import { loadPrepareStatus, newReadItems } from "@/lib/design-read-items";
import { pageBuildView } from "@/lib/design-page";
import { homepageBadge, loadHomepageRead } from "@/lib/html-mockup-import";

export const metadata: Metadata = { title: "Intake - TAWD" };
export const dynamic = "force-dynamic";

export default async function IntakePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { id } = await params;
  const { section } = await searchParams;

  const current = await requireUser();
  const db = getDb();

  const project = await getProject(db, current, id);
  if (!project) notFound();

  // Read before the intake, so a fill that lands between the two can only make the stamp older than what the form shows, never newer.
  const prefillStamp = await latestPrefillStamp(db, id);
  const intake = await loadIntake(db, current, id);
  if (!intake) notFound();

  const fileCounts: Record<string, number> = {};
  for (const file of intake.files) {
    fileCounts[file.kind] = (fileCounts[file.kind] ?? 0) + 1;
  }

  const hasContent = Object.fromEntries(
    intakeSectionKeys.map((key) => [key, hasAnyContent(intake.data[key])]),
  ) as Record<IntakeSectionKey, boolean>;

  const sections = buildSectionStatuses({
    completeness: intake.completeness,
    tierWarning: intake.tierWarning,
    fitWarning: intake.fitWarning,
    fileCounts,
    hasContent,
  });

  // Lane 2, Option B: the Figma design, as a tenth section. Since 28 September 2026 the design can be
  // uploaded as a PDF or images too, on either option of Lane 2.
  const optionB = project.lane === "lane_2" && project.laneOption === "b";
  const lane2 = project.lane === "lane_2";
  // A read the worker lost shows as failed here too, not "Reading" forever (27 September 2026).
  if (lane2) await sweepStuckWork(db);
  const figmaView = lane2 ? await loadFigmaDesign(db, id) : null;
  const uploadPlan = lane2 ? await planDesignUpload(db, id) : null;
  // The new design read (E4): admins only while the new route is built; null for everyone else.
  const newRead = lane2 ? await newReadView(db, current, id) : null;
  const newReadFixes = newRead ? await newReadCorrections(db, id, newRead) : null;
  // E4b-2b: the words and pictures as they are now, and how preparing the pictures again is going.
  const newReadThings = newRead?.result ? await newReadItems(db, id, newRead.version) : null;
  const newReadPrepare = newRead?.version && newRead.result?.runId ? await loadPrepareStatus(id, newRead.version, newRead.result.runId) : null;
  // E5a: the page built from that read, and what one would cost.
  const newReadBuild = newRead?.result?.runId ? await pageBuildView(db, current, id, newRead.page) : null;
  /*
    A finished homepage file (16 November 2026) is a mockup made by hand, so it is Lane 1's: its upload is the "Homepage file" item
    in a Lane 1 project's section list. Lane 2 (a design to reproduce) has no upload for it; a Lane 2 project that already holds a
    file still shows it (and can remove it) in its Design section.
  */
  const homepageRead = await loadHomepageRead(db, id);
  const homepage = lane2 ? null : { read: homepageRead, badge: homepageBadge(homepageRead) };
  const figma = lane2
    ? {
        view: figmaView ? figmaSectionView(figmaView) : null,
        readsThisMonth: figmaView?.readsThisMonth ?? (await figmaReadsThisMonth(db)),
        badge: figmaBadge(figmaView),
        homepageRead,
        upload: uploadPlan
          ? {
              files: intake.files.filter((f) => f.kind === "design_file").map((f) => ({ id: f.id, kind: f.kind, fileName: f.fileName, sizeBytes: f.sizeBytes, caption: f.caption })),
              pages: uploadPlan.pages,
              visionPages: uploadPlan.visionPages,
              estimateLine: uploadPlan.estimate.label,
              keptPages: uploadPlan.keptPages,
              estimateAllLine: uploadPlan.estimateAll.label,
              pageList: uploadPlan.pageList,
              perSlice: uploadPlan.perSlice,
              figmaLinkAllowed: optionB,
            }
          : null,
      }
    : null;

  const initialSection: Section =
    section === "figma" && lane2
      ? "figma"
      : section === "homepage" && homepage
        ? "homepage"
        : section && (intakeSectionKeys as readonly string[]).includes(section)
        ? (section as IntakeSectionKey)
        : "business";

  const chips = projectChips(project);

  return (
    <>
      <ProjectHeader
        slackWarning={await slackWarningFor(getDb(), id)}
        projectId={id}
        clientName={project.clientName}
        chips={chips}
        members={project.members}
        canEditTeam={can(current, "project.assign_members")}
        status={project.status}
        journey={(await loadJourneyFacts(getDb(), id, intake.completeness.isComplete))!}
        missing={intake.completeness.missing}
        totalRequired={intake.completeness.totalCount}
        canMove={can(current, "project.change_status")}
        canOverride={can(current, "intake.override_gate")}
        next={await loadNextStepFor(db, current, id)}
      />

      <IntakeWorkspace
        projectId={id}
        projectName={project.clientName}
        data={intake.data}
        files={intake.files.map((file) => ({
          id: file.id,
          kind: file.kind,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          caption: file.caption,
        }))}
        completeness={intake.completeness}
        tierWarning={intake.tierWarning}
        trade={project.trade}
        lane={project.lane}
        typeWork={await typeChangeWork(db, id)}
        sections={sections}
        canEdit={can(current, "intake.edit")}
        canEditDesign={can(current, "intake.design")}
        canChangeTier={can(current, "project.edit")}
        initialSection={initialSection}
        figma={figma}
        homepage={homepage}
        prefillStamp={prefillStamp}
        prefills={await pendingPrefills(db, id)}
        brandGuide={await loadBrandGuide(db, id)}
        logoDesign={intake.data.brand.tawdDesignsLogo ? await loadLogoDesign(db, id) : null}
        likedShots={await loadLikedShots(db, id)}
        currentSite={sitePanelView(await loadSiteRead(db, id, { signShot: true }), current)}
        referenceStudy={await loadReferenceStudy(db, id)}
        photoText={await loadPhotoTextCheck(db, id, intake.files.filter((f) => f.kind === "photo").length)}
        dmaOptions={(await getDmaMarkets(db)).dmas}
        stillInIntake={project.status === "intake"}
        showContinue={project.status === "intake" || project.status === "mockups"}
        canMove={can(current, "project.change_status")}
        newRead={newRead ? { view: newRead, corrections: newReadFixes, items: newReadThings, prepare: newReadPrepare, build: newReadBuild } : null}
      />
    </>
  );
}
