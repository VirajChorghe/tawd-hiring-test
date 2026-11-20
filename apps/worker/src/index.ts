import { eq } from "drizzle-orm";
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { getDb } from "@tawd/core/db";
import { WORKER_VERSION, startHeartbeat } from "./heartbeat";
import { recordFailure } from "./failures";
import { sweepStalledSiteBuilds, sweepStuckWork } from "@tawd/core/stuck-work";
import { concept, conceptStep, mockupRun } from "@tawd/core/schema";
import { actorFields, checkActivityChainFull, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import {
  CHANGES_JOB,
  DESIGN_REVIEW_JOB,
  FAITHFUL_COPY_JOB,
  DESIGN_IMPROVE_JOB,
  DESIGN_DECISIONS_JOB,
  LIKED_SITES_JOB,
  HOME_WORDS_JOB,
  REFERENCE_STUDY_JOB,
  PHOTO_TEXT_JOB,
  POLISH_JOB,
  DESIGN_UPLOAD_JOB,
  DESIGN_READ_JOB,
  DESIGN_PICTURES_JOB,
  DESIGN_PAGE_JOB,
  DESIGN_MOBILE_JOB,
  STYLE_KIT_JOB,
  COPY_REPAIR_JOB,
  TEMPLATE_FILL_JOB,
  SITE_TIDY_JOB,
  SEO_SUGGEST_JOB,
  type DesignUploadJobData,
  type DesignReadJobData,
  type DesignPicturesJobData,
  type DesignPageJobData,
  type DesignMobileJobData,
  type StyleKitJobData,
  type CopyRepairJobData,
  type TemplateFillJobData,
  type SiteTidyJobData,
  type SeoSuggestJobData,
  type ReferenceStudyJobData,
  type PhotoTextJobData,
  type PolishJobData,
  FIGMA_IMPORT_JOB,
  HTML_MOCKUP_IMPORT_JOB,
  MOCKUP_QUEUE,
  COPY_QUEUE,
  DRAFT_QUEUE,
  CONCEPT_QUEUE,
  type ChangesJobData,
  type ConceptJobData,
  type DesignReviewJobData,
  CONTENT_DRAFT_JOB,
  type ContentDraftJobData,
  SITE_BUILD_JOB,
  type SiteBuildJobData,
  SITE_EDIT_JOB,
  type SiteEditJobData,
  PAGE_FIX_JOB,
  type PageFixJobData,
  LOGO_JOB,
  LOGO_SWAP_JOB,
  type LogoJobData,
  type LogoSwapJobData,
  SEO_AUDIT_JOB,
  type SeoAuditJobData,
  SEO_GOLIVE_JOB,
  type SeoGoLiveJobData,
  TWENTYI_CHECK_JOB,
  type TwentyiCheckJobData,
  WP_SITES_DAILY_JOB,
  WP_HOLDER_WATCH_JOB,
  type WpSitesDailyJobData,
  WP_QUEUE,
  READS_QUEUE,
  WP_PREVIEW_JOB,
  SPEED_CHECK_JOB,
  type SpeedCheckJobData,
  type WpPreviewJobData,
  type FaithfulCopyJobData,
  type DesignImproveJobData,
  type DesignDecisionsJobData,
  type LikedSitesJobData,
  SITE_READ_JOB,
  LEGACY_READ_JOBS,
  type SiteReadJobData,
  type HomeWordsJobData,
  type FigmaImportJobData,
  type HtmlMockupImportJobData,
} from "@tawd/core/queue";
import { importFigmaDesign } from "@tawd/core/figma/service";
import { markDesignReviewFailed, runDesignReviewJob } from "./design-review";
import { markDesignCopyFailed, runFaithfulCopyJob } from "./faithful-copy";
import { markDesignImprovementFailed, runDesignImproveJob } from "./design-improve";
import { markDesignDecisionsFailed, runDesignDecisionsJob } from "./design-decisions";
import { runLikedSitesJob } from "./liked-sites";
import { runSiteReadJob } from "./site-read";
import { runHomeWordsJob } from "./home-words";
import { runReferenceStudyJob } from "./reference-study";
import { markPhotoTextFailed, runPhotoTextJob } from "./photo-text";
import { markPolishFailed, runPolishJob } from "./polish";
import { markDesignUploadFailed, runDesignUploadJob } from "./design-upload";
import { runDesignReadJob } from "./design-read-job";
import { runDesignPicturesJob } from "./design-pictures-job";
import { runDesignPageJob } from "./design-page-job";
import { markDesignMobileFailed, runDesignMobileJob } from "./design-mobile";
import { markContentDraftFailed, runContentDraftJob } from "./content-draft";
import { markSiteBuildFailed, markSiteEditFailed, runSiteBuildJob, runSiteEditJob } from "./site-build";
import { markPageFixFailed, runPageFixJob } from "./page-fix";
import { markLogoFailed, runLogoJob } from "./logo-design";
import { markLogoSwapFailed, runLogoSwapJob } from "./logo-swap";
import { markSeoAuditFailed, runSeoAuditJob } from "./seo-audit-report";
import { markSeoGoLiveFailed, runSeoGoLiveJob } from "./seo-golive";
import { markTwentyiCheckFailed, runTwentyiCheckJob } from "./twentyi-check";
import { runWpSitesDailyJob } from "./wp-sites-daily";
import { runHolderWatch } from "./holder-watch";
import { runSpeedCheckJob } from "./speed-check";
import { markWpPreviewFailed, recoverPreviewHolder, runWpPreviewJob, setWpLater, teamSlack } from "./wp-preview";
import { MODELS, type DirectionId, type SkillId } from "@tawd/core/mockups";

import { markChangesFailed, runChangesJob } from "./changes";
import { createClient, verifyModel } from "./claude";
import { loadConfig } from "./config";
import { afterConceptJob, runConceptJob } from "./pipeline";
import { withBrowser, withSharedBrowser } from "./render";
import { runJobWithStops } from "./stop";
import { EXPECTED_SCHEMA_WHEN, latestAppliedMigration, waitForSchema } from "./schema-ready";
import { markStyleKitFailed, runStyleKitJob } from "./style-kit-job";
import { runHtmlMockupImportJob } from "./html-mockup-import";
import { markCopyRepairFailed, runCopyRepairJob } from "./copy-repair-job";
import { markTemplateFillFailed, runTemplateFillJob } from "./template-fill-job";
import { runPhoneByCodeJob } from "./phone-by-code-job";
import { runSiteTidyJob } from "./site-tidy-job";
import { runSeoSuggestJob } from "./seo-suggest";
import { loadSavedTurns, replayingClient, runWithReplay, type ReplayRequest } from "./replay";
import { standInTurnsFor } from "./e2e-check";
import {
  REVIEW_JOB,
  markReviewFailed,
  reviewJobId,
  runReviewJob,
  type ReviewJob,
} from "./review";

/*
  The worker.

  It takes one concept at a time - concurrency 1, deliberately - launches a
  browser for that job, and closes it again afterwards. Everything else is
  error handling and saying clearly what went wrong.
*/

const config = loadConfig();
// Replay (28 September 2026): inside a replayed job, calls are answered from saved answers, never sent.
const anthropic = replayingClient(createClient(config));

console.log(`TAWD worker ${WORKER_VERSION} starting. Model: ${config.model}`);
startHeartbeat();

// No job until the database has this build's migrations (the web app applies them; schema-ready.ts).
await waitForSchema({ expected: EXPECTED_SCHEMA_WHEN, readLatest: () => latestAppliedMigration(), alert: teamSlack });

/*
  Site builds a stopped worker left "working" (audit F-006, 12 November 2026):
  swept when the worker starts and every five minutes. Only builds with no
  heartbeat for ten minutes, so one a still-running worker has is never touched.
*/
const sweepBuilds = async () => {
  await sweepStalledSiteBuilds(getDb())
    .then((ids) => {
      if (ids.length) console.log(`Marked ${ids.length} stalled site build${ids.length === 1 ? "" : "s"} as failed.`);
    })
    .catch((error) => console.warn(`Couldn't sweep stalled site builds: ${error instanceof Error ? error.message : "unknown error"}`));
  /*
    D5 (audit F-042): the rest of the stuck work (mockup runs, reads, design
    reviews and copies) is swept here too. It used to be settled only when
    someone opened the mockups, Spend or intake screen, so work could sit at
    "Running" for days with nobody looking. The screens still sweep first,
    which is harmless.
  */
  await sweepStuckWork(getDb())
    .then((swept) => {
      const count = Object.values(swept).reduce((n, list) => n + list.length, 0);
      if (count) console.log(`Settled ${count} piece${count === 1 ? "" : "s"} of stuck work.`);
    })
    .catch((error) => console.warn(`Couldn't sweep stuck work: ${error instanceof Error ? error.message : "unknown error"}`));
};
void sweepBuilds();
setInterval(() => void sweepBuilds(), 5 * 60_000).unref();

const check = await verifyModel(anthropic, config.model);
if (!check.ok) {
  // Not fatal: the queue may be idle and somebody may be about to fix it.
  // But it is the first thing in the log, in plain words.
  console.error("\n" + "-".repeat(70));
  console.error(check.message);
  console.error("-".repeat(70) + "\n");
} else {
  console.log(`Model ${config.model} is available.`);
}
// The cheaper models some steps run on (27 September 2026): a missing one is a warning, not a stop.
for (const other of MODELS.filter((m) => m.id !== config.model)) {
  const found = await verifyModel(anthropic, other.id);
  console.log(found.ok ? `Model ${other.id} (${other.label}) is available.` : `Warning: ${other.label} (${other.id}) isn't available; steps set to it will fail until it is changed on Spend.`);
}

const connection = new IORedis(config.redisUrl, {
  // BullMQ requires this; without it a blocking read can be cut short.
  maxRetriesPerRequest: null,
});

/*
  The same queue the web app uses, so the review job waits its turn behind
  any concept still queued: concurrency 1 covers both kinds of job.
*/
const queue = new Queue(MOCKUP_QUEUE, { connection });
async function queueReview(runId: string, projectId: string): Promise<void> {
  await queue.add(
    REVIEW_JOB,
    { runId, projectId } satisfies ReviewJob,
    {
      // One id per run: a second add is ignored, so it can never run twice.
      jobId: reviewJobId(runId),
      // Not retried: a retry would pay for every review call again. If it
      // fails, the concepts keep their latest versions and the run says so.
      attempts: 1,
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
  console.log(`Run ${runId}: every concept is built, review queued.`);
}

async function handleReview(job: Job<ReviewJob>): Promise<void> {
  const { runId } = job.data;
  console.log(`Run ${runId}: Creative Director review starting.`);
  try {
    await withBrowser((browser) => runReviewJob(job.data, config, anthropic, browser));
    console.log(`Run ${runId}: review finished.`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The review did not finish.";
    console.error(`Run ${runId}: review failed: ${message}`);
    await recordFailure(job, error, `Run ${runId}: review`);
    await markReviewFailed(runId, message);
  }
}

async function handleDesignReview(job: Job<DesignReviewJobData>): Promise<void> {
  const { reviewId } = job.data;
  console.log(`Design review ${reviewId}: starting.`);
  try {
    await withBrowser((browser) => runDesignReviewJob(job.data, config, anthropic, browser));
    console.log(`Design review ${reviewId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The review did not finish.";
    console.error(`Design review ${reviewId} failed: ${message}`);
    await recordFailure(job, error, `Design review ${reviewId}`);
    await markDesignReviewFailed(reviewId, message);
  }
}

async function handleWpPreview(job: Job<WpPreviewJobData>): Promise<void> {
  const { projectId, action } = job.data;
  console.log(`WordPress preview ${projectId} (${action}): starting.`);
  try {
    // No AI and no browser: fixed commands over SSH, one step at a time.
    await runWpPreviewJob(job.data);
    console.log(`WordPress preview ${projectId} (${action}): finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The WordPress preview did not finish.";
    console.error(`WordPress preview ${projectId} (${action}) failed: ${message}`);
    await recordFailure(job, error, `WordPress preview ${projectId} (${action})`);
    await markWpPreviewFailed(projectId, message, job.data);
  }
}

async function handleTwentyiCheck(job: Job<TwentyiCheckJobData>): Promise<void> {
  const { checkId } = job.data;
  console.log(`20i account check ${checkId}: starting.`);
  try {
    // No AI and no browser: read-only calls to 20i's API.
    await runTwentyiCheckJob(job.data);
    console.log(`20i account check ${checkId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The check did not finish.";
    console.error(`20i account check ${checkId} failed: ${message}`);
    await recordFailure(job, error, `20i account check ${checkId}`);
    await markTwentyiCheckFailed(checkId, message);
  }
}

async function handleWpSitesDaily(job: Job<WpSitesDailyJobData>): Promise<void> {
  console.log("WordPress sites, daily work: starting.");
  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the worker's log only
  try {
    // No AI and no browser: 20i's API, public DNS, Cloudflare and Let's Encrypt.
    const summary = await runWpSitesDailyJob(job.data);
    console.log(`WordPress sites, daily work: ${summary}`);
  } catch (error) {
    console.error(`WordPress sites, daily work failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, "WordPress sites, daily work");
  }
  // The activity log, checked whole once a day (13 October 2026): the Activity page checks only the newest entries.
  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the worker's log only
  try {
    const chain = await checkActivityChainFull(getDb());
    console.log(`Activity log, full check: ${chain.entriesChecked} entries, ${chain.valid ? "all intact" : `broken at ${chain.brokenAtSeq}`}.`);
    if (!chain.valid) await teamSlack(`:rotating_light: The activity log does not verify from entry ${chain.brokenAtSeq} (${chain.reason}). Tell Jason.`);
  } catch (error) {
    console.error(`Activity log, full check failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, "Activity log, full check");
  }
}

async function handleSeoGoLive(job: Job<SeoGoLiveJobData>): Promise<void> {
  const { checkId } = job.data;
  console.log(`SEO go-live check ${checkId}: starting.`);
  try {
    // Text only: the built files are read from storage.
    await runSeoGoLiveJob(job.data, config, anthropic);
    console.log(`SEO go-live check ${checkId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The check did not finish.";
    console.error(`SEO go-live check ${checkId} failed: ${message}`);
    await recordFailure(job, error, `SEO go-live check ${checkId}`);
    await markSeoGoLiveFailed(checkId, message);
  }
}

async function handleSeoAudit(job: Job<SeoAuditJobData>): Promise<void> {
  const { auditId } = job.data;
  console.log(`SEO audit report ${auditId}: starting.`);
  try {
    // Text only: no browser.
    await runSeoAuditJob(job.data, config, anthropic);
    console.log(`SEO audit report ${auditId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report did not finish.";
    console.error(`SEO audit report ${auditId} failed: ${message}`);
    await recordFailure(job, error, `SEO audit report ${auditId}`);
    await markSeoAuditFailed(auditId, message);
  }
}

async function handleLogo(job: Job<LogoJobData>): Promise<void> {
  const { designId } = job.data;
  console.log(`Logo design ${designId}: starting.`);
  try {
    await withBrowser((browser) => runLogoJob(job.data, config, anthropic, browser));
    console.log(`Logo design ${designId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The logo design did not finish.";
    console.error(`Logo design ${designId} failed: ${message}`);
    await recordFailure(job, error, `Logo design ${designId}`);
    await markLogoFailed(designId, message);
  }
}

/* Mockup inputs and the polish (27 September 2026). */
async function handleReferenceStudy(job: Job<ReferenceStudyJobData>): Promise<void> {
  const { projectId } = job.data;
  console.log(`Reference study for project ${projectId}: starting.`);
  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the worker's log only
  try {
    await runReferenceStudyJob(job.data, config, anthropic);
    console.log(`Reference study for project ${projectId}: finished.`);
  } catch (error) {
    console.error(`Reference study for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, `Reference study for project ${projectId}`);
  }
}

async function handlePhotoText(job: Job<PhotoTextJobData>): Promise<void> {
  const { checkId } = job.data;
  console.log(`Photo text check ${checkId}: starting.`);
  try {
    await withBrowser((browser) => runPhotoTextJob(job.data, config, anthropic, browser));
    console.log(`Photo text check ${checkId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The photo text check did not finish.";
    console.error(`Photo text check ${checkId} failed: ${message}`);
    await recordFailure(job, error, `Photo text check ${checkId}`);
    await markPhotoTextFailed(checkId, message);
  }
}

/* The new design read (E4, admin only): its status file says failed with the reason; nothing else changes. */
async function handleDesignRead(job: Job<DesignReadJobData>): Promise<void> {
  const { projectId } = job.data;
  console.log(`New-route design read for project ${projectId}: reading.`);
  try {
    await withBrowser((browser) => runDesignReadJob(job.data, config, anthropic, browser));
    console.log(`New-route design read for project ${projectId}: read.`);
  } catch (error) {
    console.error(`New-route design read for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, `New-route design read for project ${projectId}`);
  }
}

async function handleDesignPictures(job: Job<DesignPicturesJobData>): Promise<void> {
  const { projectId } = job.data;
  console.log(`Preparing a read's pictures again for project ${projectId}.`);
  try {
    await withBrowser((browser) => runDesignPicturesJob(job.data, browser));
    console.log(`Preparing a read's pictures again for project ${projectId}: done.`);
  } catch (error) {
    console.error(`Preparing a read's pictures again for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, `Preparing a read's pictures again for project ${projectId}`);
  }
}

async function handleDesignPage(job: Job<DesignPageJobData>): Promise<void> {
  const { projectId } = job.data;
  console.log(`Building a page from the read for project ${projectId}.`);
  try {
    // The browser is only for scaling the design picture down to what the
    // model can take; nothing is rendered here. The built page is looked at
    // in a real browser by the checks, which are E5b.
    await withBrowser((browser) => runDesignPageJob(job.data, config, anthropic, browser));
    console.log(`Building a page from the read for project ${projectId}: done.`);
  } catch (error) {
    console.error(`Building a page from the read for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
    await recordFailure(job, error, `Building a page from the read for project ${projectId}`);
  }
}

async function handleDesignUpload(job: Job<DesignUploadJobData>): Promise<void> {
  const { projectId, version } = job.data;
  console.log(`Design upload for project ${projectId}: reading.`);
  try {
    await withBrowser((browser) => runDesignUploadJob(job.data, config, anthropic, browser));
    console.log(`Design upload for project ${projectId}: read.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The design couldn't be read.";
    console.error(`Design upload for project ${projectId} failed: ${message}`);
    await recordFailure(job, error, `Design upload for project ${projectId}`);
    await markDesignUploadFailed(projectId, version, message);
  }
}

async function handleDesignMobile(job: Job<DesignMobileJobData>): Promise<void> {
  const { copyId } = job.data;
  console.log(`Phone version of copy ${copyId}: starting.`);
  try {
    // By code ($0) when asked, else the AI's phone version.
    await withBrowser((browser) => (job.data.byCode ? runPhoneByCodeJob(getDb(), browser, job.data) : runDesignMobileJob(job.data, config, anthropic, browser)));
    console.log(`Phone version of copy ${copyId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The phone version didn't finish.";
    console.error(`Phone version of copy ${copyId} failed: ${message}`);
    await recordFailure(job, error, `Phone version of copy ${copyId}`);
    await markDesignMobileFailed(copyId, message);
  }
}

async function handleStyleKit(job: Job<StyleKitJobData>): Promise<void> {
  const { kitId } = job.data;
  console.log(`Style kit ${kitId}: starting.`);
  try {
    await withBrowser((browser) => runStyleKitJob(getDb(), browser, job.data));
    console.log(`Style kit ${kitId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The style kit didn't finish.";
    console.error(`Style kit ${kitId} failed: ${message}`);
    await recordFailure(job, error, `Style kit ${kitId}`);
    await markStyleKitFailed(getDb(), kitId, message);
  }
}

async function handleTemplateFill(job: Job<TemplateFillJobData>): Promise<void> {
  const { copyId } = job.data;
  console.log(`Template fill ${copyId}: starting.`);
  try {
    await withBrowser((browser) => runTemplateFillJob(getDb(), browser, job.data));
    console.log(`Template fill ${copyId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The fill didn't finish.";
    console.error(`Template fill ${copyId} failed: ${message}`);
    await recordFailure(job, error, `Template fill ${copyId}`);
    await markTemplateFillFailed(getDb(), copyId, message);
  }
}

async function handleCopyRepair(job: Job<CopyRepairJobData>): Promise<void> {
  const { copyId } = job.data;
  console.log(`Kit repair of copy ${copyId}: starting.`);
  try {
    await withBrowser((browser) => runCopyRepairJob(getDb(), browser, job.data));
    console.log(`Kit repair of copy ${copyId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The kit repair didn't finish.";
    console.error(`Kit repair of copy ${copyId} failed: ${message}`);
    await recordFailure(job, error, `Kit repair of copy ${copyId}`);
    await markCopyRepairFailed(getDb(), copyId, message);
  }
}

async function handlePolish(job: Job<PolishJobData>): Promise<void> {
  const { passId } = job.data;
  console.log(`Critique and polish ${passId}: starting.`);
  try {
    await withBrowser((browser) => runPolishJob(job.data, config, anthropic, browser));
    console.log(`Critique and polish ${passId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The critique and polish did not finish.";
    console.error(`Critique and polish ${passId} failed: ${message}`);
    await recordFailure(job, error, `Critique and polish ${passId}`);
    await markPolishFailed(passId, message);
  }
}

/* The logo after approval: no AI, one render. */
async function handleLogoSwap(job: Job<LogoSwapJobData>): Promise<void> {
  const { swapId } = job.data;
  console.log(`Logo swap ${swapId}: starting.`);
  try {
    await withBrowser((browser) => runLogoSwapJob(job.data, config, browser));
    console.log(`Logo swap ${swapId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The new logo could not be put in.";
    console.error(`Logo swap ${swapId} failed: ${message}`);
    await recordFailure(job, error, `Logo swap ${swapId}`);
    await markLogoSwapFailed(swapId, message);
  }
}

async function handleSiteEdit(job: Job<SiteEditJobData>): Promise<void> {
  const { requestId } = job.data;
  console.log(`Site edit ${requestId}: starting.`);
  try {
    await withBrowser((browser) => runSiteEditJob(job.data, config, anthropic, browser));
    console.log(`Site edit ${requestId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The edit did not finish.";
    console.error(`Site edit ${requestId} failed: ${message}`);
    await recordFailure(job, error, `Site edit ${requestId}`);
    await markSiteEditFailed(requestId, message);
  }
}

async function handlePageFix(job: Job<PageFixJobData>): Promise<void> {
  const { fixId } = job.data;
  console.log(`Page fix ${fixId}: starting.`);
  try {
    await withBrowser((browser) => runPageFixJob(job.data, config, anthropic, browser));
    console.log(`Page fix ${fixId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The fix did not finish.";
    console.error(`Page fix ${fixId} failed: ${message}`);
    await recordFailure(job, error, `Page fix ${fixId}`);
    await markPageFixFailed(fixId, message);
  }
}

async function handleSiteBuild(job: Job<SiteBuildJobData>): Promise<void> {
  const { buildId } = job.data;
  console.log(`Site build ${buildId}: starting.`);
  try {
    await withBrowser((browser) => runSiteBuildJob(job.data, config, anthropic, browser));
    console.log(`Site build ${buildId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The site build did not finish.";
    console.error(`Site build ${buildId} failed: ${message}`);
    await recordFailure(job, error, `Site build ${buildId}`);
    await markSiteBuildFailed(buildId, message);
  }
}

async function handleContentDraft(job: Job<ContentDraftJobData>): Promise<void> {
  const { draftId } = job.data;
  console.log(`Page draft ${draftId}: starting.`);
  try {
    // Text only: no browser.
    await runContentDraftJob(job.data, config, anthropic);
    console.log(`Page draft ${draftId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The draft did not finish.";
    console.error(`Page draft ${draftId} failed: ${message}`);
    await recordFailure(job, error, `Page draft ${draftId}`);
    await markContentDraftFailed(draftId, message);
  }
}

async function handleDesignDecisions(job: Job<DesignDecisionsJobData>): Promise<void> {
  const { improvementId } = job.data;
  console.log(`Designer's decisions version ${improvementId}: starting.`);
  try {
    await withBrowser((browser) => runDesignDecisionsJob(job.data, config, anthropic, browser));
    console.log(`Designer's decisions version ${improvementId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The version did not finish.";
    console.error(`Designer's decisions version ${improvementId} failed: ${message}`);
    await recordFailure(job, error, `Designer's decisions version ${improvementId}`);
    await markDesignDecisionsFailed(improvementId, message);
  }
}

async function handleDesignImprove(job: Job<DesignImproveJobData>): Promise<void> {
  const { improvementId } = job.data;
  console.log(`Improved design ${improvementId}: starting.`);
  try {
    await withBrowser((browser) => runDesignImproveJob(job.data, config, anthropic, browser));
    console.log(`Improved design ${improvementId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The improved design did not finish.";
    console.error(`Improved design ${improvementId} failed: ${message}`);
    await recordFailure(job, error, `Improved design ${improvementId}`);
    await markDesignImprovementFailed(improvementId, message);
  }
}

async function handleFaithfulCopy(job: Job<FaithfulCopyJobData>): Promise<void> {
  const { copyId } = job.data;
  console.log(`Faithful copy ${copyId}: starting.`);
  try {
    // Copies run several at once, sharing one Chromium (28 September 2026).
    await withSharedBrowser((browser) => runFaithfulCopyJob(job.data, config, anthropic, browser));
    console.log(`Faithful copy ${copyId}: finished.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The copy did not finish.";
    console.error(`Faithful copy ${copyId} failed: ${message}`);
    await recordFailure(job, error, `Faithful copy ${copyId}`);
    await markDesignCopyFailed(copyId, message);
  }
}

async function handleChanges(job: Job<ChangesJobData>): Promise<void> {
  const { requestId } = job.data;
  console.log(`Changes ${requestId}: starting.`);
  try {
    await withBrowser((browser) => runChangesJob(job.data, config, anthropic, browser));
    console.log(`Changes ${requestId}: new version ready.`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The changes did not finish.";
    console.error(`Changes ${requestId} failed: ${message}`);
    await recordFailure(job, error, `Changes ${requestId}`);
    await markChangesFailed(requestId, message);
  }
}

type AnyJobData =
  | ConceptJobData
  | ReviewJob
  | ChangesJobData
  | FigmaImportJobData
  | HtmlMockupImportJobData
  | DesignReviewJobData
  | FaithfulCopyJobData
  | DesignImproveJobData
  | DesignDecisionsJobData
  | LikedSitesJobData
  | ContentDraftJobData
  | SiteBuildJobData
  | SiteEditJobData
  | LogoJobData
  | SeoAuditJobData
  | SeoGoLiveJobData
  | TwentyiCheckJobData
  | WpSitesDailyJobData
  | WpPreviewJobData;

// Every job runs with its stop keys, so the Stop button reaches it before its next AI call (28 September 2026).
const processJob = async (anyJob: Job<AnyJobData>) => {
  // A replayed job ($0): its calls are answered from the saved answers of the runs it names.
  const replay = (anyJob.data as { replay?: ReplayRequest }).replay;
  let turns = replay ? await loadSavedTurns(getDb(), replay.fromRunIds) : null;
  if (replay) console.log(`Replaying ${anyJob.name} from ${replay.fromRunIds.join(", ")}: ${[...turns!.values()].reduce((n, t) => n + t.length, 0)} saved answers.`);
  // The end-to-end check's build ($0): answered from stand-ins, only for the check's own project.
  if (anyJob.name === SITE_BUILD_JOB && (anyJob.data as SiteBuildJobData).standIn) {
    try {
      turns = await standInTurnsFor((anyJob.data as SiteBuildJobData).projectId);
    } catch (error) {
      await markSiteBuildFailed((anyJob.data as SiteBuildJobData).buildId, error instanceof Error ? error.message : "Stand-in answers refused.");
      return;
    }
  }
  return runWithReplay(turns, () => runJobWithStops(anyJob, () => handleJob(anyJob)));
};

const handleJob = async (anyJob: Job<AnyJobData>) => {
    // No AI and no browser: the frames and images come from Figma, into R2.
    // No AI: photographs of the sites the client likes.
    if (anyJob.name === LIKED_SITES_JOB) {
      const { projectId } = anyJob.data as LikedSitesJobData;
      console.log(`Liked websites for project ${projectId}: photographing.`);
      await withBrowser((browser) => runLikedSitesJob(anyJob.data as LikedSitesJobData, browser)).catch(async (error: unknown) => {
        console.error(`Liked websites for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `Liked websites for project ${projectId}`);
      });
      return;
    }
    // No AI: one read of the current site, its pages and its home page's look (0.96.0). A job queued by the old app during a deploy runs the same way.
    if (anyJob.name === SITE_READ_JOB || anyJob.name === LEGACY_READ_JOBS.pages) {
      const data = anyJob.data as SiteReadJobData;
      console.log(`Current site for project ${data.projectId}: reading.`);
      await runSiteReadJob(data).catch(async (error: unknown) => {
        console.error(`Current site for project ${data.projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `Current site for project ${data.projectId}`);
      });
      return;
    }
    // The old home-page-only read (before 0.96.0): its work is part of the read above now.
    if (anyJob.name === LEGACY_READ_JOBS.home) {
      console.log("An old current-site job was let go: the one site read replaces it.");
      return;
    }
    // Paid, estimate first: the home page's words for a new site (1 October 2026).
    if (anyJob.name === HOME_WORDS_JOB) {
      const { projectId } = anyJob.data as HomeWordsJobData;
      console.log(`Home page words for project ${projectId}: writing.`);
      await runHomeWordsJob(anyJob.data as HomeWordsJobData, config, anthropic).catch(async (error: unknown) => {
        console.error(`Home page words for project ${projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `Home page words for project ${projectId}`);
      });
      return;
    }
    if (anyJob.name === REFERENCE_STUDY_JOB) {
      await handleReferenceStudy(anyJob as Job<ReferenceStudyJobData>);
      return;
    }
    if (anyJob.name === PHOTO_TEXT_JOB) {
      await handlePhotoText(anyJob as Job<PhotoTextJobData>);
      return;
    }
    if (anyJob.name === SEO_SUGGEST_JOB) {
      const data = anyJob.data as SeoSuggestJobData;
      console.log(`SEO suggestions for project ${data.projectId}: starting.`);
      await withBrowser((browser) => runSeoSuggestJob(getDb(), browser, data)).catch(async (error: unknown) => {
        console.error(`SEO suggestions for project ${data.projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `SEO suggestions for project ${data.projectId}`);
      });
      return;
    }
    if (anyJob.name === SITE_TIDY_JOB) {
      const data = anyJob.data as SiteTidyJobData;
      console.log(`Words and links tidy for project ${data.projectId}: starting.`);
      await withBrowser((browser) => runSiteTidyJob(getDb(), browser, data)).catch(async (error: unknown) => {
        console.error(`Words and links tidy for project ${data.projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `Words and links tidy for project ${data.projectId}`);
      });
      return;
    }
    if (anyJob.name === TEMPLATE_FILL_JOB) {
      await handleTemplateFill(anyJob as Job<TemplateFillJobData>);
      return;
    }
    if (anyJob.name === COPY_REPAIR_JOB) {
      await handleCopyRepair(anyJob as Job<CopyRepairJobData>);
      return;
    }
    if (anyJob.name === STYLE_KIT_JOB) {
      await handleStyleKit(anyJob as Job<StyleKitJobData>);
      return;
    }
    if (anyJob.name === DESIGN_MOBILE_JOB) {
      await handleDesignMobile(anyJob as Job<DesignMobileJobData>);
      return;
    }
    if (anyJob.name === DESIGN_UPLOAD_JOB) {
      await handleDesignUpload(anyJob as Job<DesignUploadJobData>);
      return;
    }
    if (anyJob.name === DESIGN_READ_JOB) {
      await handleDesignRead(anyJob as Job<DesignReadJobData>);
      return;
    }
    if (anyJob.name === DESIGN_PICTURES_JOB) {
      await handleDesignPictures(anyJob as Job<DesignPicturesJobData>);
      return;
    }
    if (anyJob.name === DESIGN_PAGE_JOB) {
      await handleDesignPage(anyJob as Job<DesignPageJobData>);
      return;
    }
    if (anyJob.name === POLISH_JOB) {
      await handlePolish(anyJob as Job<PolishJobData>);
      return;
    }
    if (anyJob.name === WP_PREVIEW_JOB) {
      await handleWpPreview(anyJob as Job<WpPreviewJobData>);
      return;
    }
    if (anyJob.name === SPEED_CHECK_JOB) {
      // No AI and no browser: Google PageSpeed on a preview.
      await runSpeedCheckJob((anyJob as Job<SpeedCheckJobData>).data);
      return;
    }
    if (anyJob.name === TWENTYI_CHECK_JOB) {
      await handleTwentyiCheck(anyJob as Job<TwentyiCheckJobData>);
      return;
    }
    if (anyJob.name === WP_SITES_DAILY_JOB) {
      await handleWpSitesDaily(anyJob as Job<WpSitesDailyJobData>);
      return;
    }
    if (anyJob.name === WP_HOLDER_WATCH_JOB) {
      // The preview domain's placeholder and registration (0.122.0): never throws, no AI, no browser.
      console.log(`The preview domain's watch: ${await runHolderWatch()}`);
      return;
    }
    if (anyJob.name === SEO_GOLIVE_JOB) {
      await handleSeoGoLive(anyJob as Job<SeoGoLiveJobData>);
      return;
    }
    if (anyJob.name === SEO_AUDIT_JOB) {
      await handleSeoAudit(anyJob as Job<SeoAuditJobData>);
      return;
    }
    if (anyJob.name === LOGO_SWAP_JOB) {
      await handleLogoSwap(anyJob as Job<LogoSwapJobData>);
      return;
    }
    if (anyJob.name === LOGO_JOB) {
      await handleLogo(anyJob as Job<LogoJobData>);
      return;
    }
    if (anyJob.name === SITE_EDIT_JOB) {
      await handleSiteEdit(anyJob as Job<SiteEditJobData>);
      return;
    }
    if (anyJob.name === PAGE_FIX_JOB) {
      await handlePageFix(anyJob as Job<PageFixJobData>);
      return;
    }
    if (anyJob.name === SITE_BUILD_JOB) {
      await handleSiteBuild(anyJob as Job<SiteBuildJobData>);
      return;
    }
    if (anyJob.name === CONTENT_DRAFT_JOB) {
      await handleContentDraft(anyJob as Job<ContentDraftJobData>);
      return;
    }
    if (anyJob.name === DESIGN_DECISIONS_JOB) {
      await handleDesignDecisions(anyJob as Job<DesignDecisionsJobData>);
      return;
    }
    if (anyJob.name === DESIGN_IMPROVE_JOB) {
      await handleDesignImprove(anyJob as Job<DesignImproveJobData>);
      return;
    }
    if (anyJob.name === FAITHFUL_COPY_JOB) {
      await handleFaithfulCopy(anyJob as Job<FaithfulCopyJobData>);
      return;
    }
    if (anyJob.name === DESIGN_REVIEW_JOB) {
      await handleDesignReview(anyJob as Job<DesignReviewJobData>);
      return;
    }
    if (anyJob.name === FIGMA_IMPORT_JOB) {
      const { projectId } = anyJob.data as FigmaImportJobData;
      console.log(`Figma import for project ${projectId} starting.`);
      await importFigmaDesign(getDb(), projectId);
      return;
    }
    // No AI and no network: a homepage supplied as HTML, stored as a concept and photographed.
    if (anyJob.name === HTML_MOCKUP_IMPORT_JOB) {
      const data = anyJob.data as HtmlMockupImportJobData;
      console.log(`Supplied homepage for project ${data.projectId}: reading.`);
      await withBrowser((browser) => runHtmlMockupImportJob(getDb(), browser, data)).catch(async (error: unknown) => {
        console.error(`Supplied homepage for project ${data.projectId} failed: ${error instanceof Error ? error.message : "unknown"}`);
        await recordFailure(anyJob, error, `Supplied homepage for project ${data.projectId}`);
      });
      return;
    }
    if (anyJob.name === REVIEW_JOB) {
      await handleReview(anyJob as Job<ReviewJob>);
      return;
    }
    if (anyJob.name === CHANGES_JOB) {
      await handleChanges(anyJob as Job<ChangesJobData>);
      return;
    }

    const job = anyJob as Job<ConceptJobData>;
    const db = getDb();
    const data = job.data;

    console.log(
      `Concept ${data.label} (${data.direction}, ${data.skillId}) starting.`,
    );

    const [run] = await db
      .select()
      .from(mockupRun)
      .where(eq(mockupRun.id, data.runId))
      .limit(1);

    /*
      Somebody pressed Stop while this was waiting its turn, or the run was
      marked as not finishing while the worker was away (stuck-work.ts).
    */
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      // A swept run's concepts already say why; only Stop marks them stopped.
      if (!run || run.status === "stopped") {
        await db
          .update(concept)
          .set({ status: "stopped" })
          .where(eq(concept.id, data.conceptId));
      }
      console.log(`Concept ${data.label} skipped: the run is ${run?.status ?? "gone"}.`);
      return;
    }

    if (run.status === "queued") {
      await db
        .update(mockupRun)
        .set({ status: "running" })
        .where(eq(mockupRun.id, data.runId));
    }

    try {
      const ran = await withSharedBrowser((browser) =>
        runConceptJob(
          {
            runId: data.runId,
            conceptId: data.conceptId,
            projectId: data.projectId,
            label: data.label,
            direction: data.direction as DirectionId,
            skillId: data.skillId as SkillId,
          },
          config,
          anthropic,
          browser,
        ),
      );
      // False means the concept is not this delivery's to build: it is no longer queued or running, or another delivery holds it with a heartbeat under ten minutes old (audit F-007). A concept whose worker stopped is taken over by runConceptJob, which returns true. The holder finishes the run's bookkeeping, not this one.
      if (!ran) {
        console.log(`Concept ${data.label} skipped: another delivery of the job holds it, or it is already finished.`);
        return;
      }
      console.log(`Concept ${data.label} is ready.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong.";
      console.error(`Concept ${data.label} failed: ${message}`);
      await recordFailure(anyJob, error, `Concept ${data.label}`);

      await db
        .update(concept)
        .set({ status: "failed", failureReason: message })
        .where(eq(concept.id, data.conceptId));

      // Whichever step was mid-flight should say so rather than spin.
      await db
        .update(conceptStep)
        .set({ status: "failed", detail: message, finishedAt: new Date() })
        .where(eq(conceptStep.conceptId, data.conceptId));

      await recordActivity(db, {
        action: "mockups.concept_failed",
        entityType: "project",
        entityId: data.projectId,
        ...actorFields(SYSTEM_ACTOR),
        valueAfter: { concept: data.label, reason: message },
        ipAddress: null,
        userAgent: null,
      });

      // Swallowed on purpose: one concept failing must not stop the others,
      // which is what the design promises on the generating screen.
    }

    await afterConceptJob(data.runId, queueReview);
};

const worker = new Worker<AnyJobData>(
  MOCKUP_QUEUE,
  processJob,
  {
    connection,
    /*
      One at a time. The design says "Concepts render one at a time to
      protect the server" and means it: Chromium peaks near a gigabyte on a
      tall page, on a box shared with Velocity Reports.
    */
    concurrency: 1,
    // A concept can legitimately take several minutes.
    lockDuration: 20 * 60 * 1000,
  },
);

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id ?? "unknown"} failed outright:`, error.message);
  void recordFailure(job, error, `Job ${job?.id ?? "unknown"} failed outright`);
});

// Not recorded as a failed job: these are connection errors (a Redis blip fires them over and over) and would bury real failures (the batch D review).
worker.on("error", (error) => {
  console.error("Worker error:", error.message);
});

/*
  Work at once (28 September 2026): copies, page drafts and concepts have
  their own queues and run several at a time; the shared Chromium keeps the
  memory to one browser. The numbers are settings on the worker in Coolify.
*/
const atOnce = (name: string, fallback: number) => Math.max(1, Number(process.env[name]) || fallback);
const extraWorkers = [
  new Worker<AnyJobData>(COPY_QUEUE, processJob, { connection, concurrency: atOnce("TAWD_COPIES_AT_ONCE", 2), lockDuration: 20 * 60 * 1000 }),
  new Worker<AnyJobData>(DRAFT_QUEUE, processJob, { connection, concurrency: atOnce("TAWD_DRAFTS_AT_ONCE", 4), lockDuration: 10 * 60 * 1000 }),
  new Worker<AnyJobData>(CONCEPT_QUEUE, processJob, { connection, concurrency: atOnce("TAWD_CONCEPTS_AT_ONCE", 2), lockDuration: 20 * 60 * 1000 }),
  // WordPress on 20i (5 October 2026): one job at a time, and a go-live (backup, search and replace, checks) may take longer than 20 minutes.
  new Worker<AnyJobData>(WP_QUEUE, processJob, { connection, concurrency: 1, lockDuration: 60 * 60 * 1000 }),
  // Site reads (7 October 2026): one at a time, no browser; an Internet Archive read is about 5 seconds a page.
  new Worker<AnyJobData>(READS_QUEUE, processJob, { connection, concurrency: 1, lockDuration: 30 * 60 * 1000 }),
];
for (const extra of extraWorkers) {
  extra.on("failed", (job, error) => {
    console.error(`Job ${job?.id ?? "unknown"} failed outright:`, error.message);
    void recordFailure(job, error, `Job ${job?.id ?? "unknown"} failed outright`);
  });
  // Connection errors, not failed jobs: logged, not recorded (see worker.on("error") above).
  extra.on("error", (error) => {
    console.error("Worker error:", error.message);
  });
}

/*
  WordPress previews' follow-up jobs (12 October 2026): the moved preview's check and the placeholder's switch-off check, delayed on
  the WordPress queue so a restart keeps them. A job id already waiting keeps its place; finished ones are dropped so an id can be used
  again. At the start, a switch-off check in progress gets its next step queued again (the placeholder is never left off).
*/
const wpQueue = new Queue(WP_QUEUE, { connection });
setWpLater(async (data, delayMs, jobId) => {
  await wpQueue.add(WP_PREVIEW_JOB, data, { delay: delayMs, jobId, attempts: 1, removeOnComplete: true, removeOnFail: true });
});
void recoverPreviewHolder("start");

console.log(
  `Listening on the ${MOCKUP_QUEUE} queue one job at a time; copies ${atOnce("TAWD_COPIES_AT_ONCE", 2)}, drafts ${atOnce("TAWD_DRAFTS_AT_ONCE", 4)} and concepts ${atOnce("TAWD_CONCEPTS_AT_ONCE", 2)} at once; WordPress jobs one at a time on ${WP_QUEUE}; site reads one at a time on ${READS_QUEUE}.`,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received. Finishing the current concept first.`);
  await worker.close();
  await Promise.all(extraWorkers.map((w) => w.close()));
  await queue.close();
  await wpQueue.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
