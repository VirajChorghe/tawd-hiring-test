/*
  The job queue's names and shapes, shared so the web app and the worker
  cannot drift apart on what a job looks like.

  One queue, and the worker runs it at concurrency 1. Renders happen one at
  a time on purpose: the droplet is shared with a client-facing application
  and Chromium is the largest thing TAWD runs.
*/

export const MOCKUP_QUEUE = "tawd-mockups";

export interface ConceptJobData {
  runId: string;
  conceptId: string;
  projectId: string;
  label: string;
  direction: string;
  skillId: string;
}

export const CONCEPT_JOB = "build-concept";

/*
  Named after the concept, so a stuck job is obvious in a queue listing.

  A hyphen, not a colon. BullMQ uses ":" as its Redis key separator and
  rejects a custom job id containing one, which is a runtime error at the
  moment of queueing rather than anything a type would catch. See the test
  in mockup-queue.test.ts, which runs the real library's validation.
*/
export function conceptJobId(conceptId: string): string {
  return `concept-${conceptId}`;
}

/*
  Whether a run is still working.

  Only an active run should hide the setup form. A run that finished,
  failed or was stopped must leave the options available, or the page traps
  you on a dead run with no way to start another - which is exactly what
  happened after the first attempt failed at the queue.
*/
export function isRunActive(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

/*
  Request changes: one concept, one new version from the team's notes and
  pins (or from what the client said), then the checks and one Creative
  Director scoring pass. Same queue, so it waits its turn behind any render.
*/
export const CHANGES_JOB = "concept-changes";

export interface ChangesJobData {
  requestId: string;
  conceptId: string;
  projectId: string;
}

export function changesJobId(requestId: string): string {
  return `changes-${requestId}`;
}

/*
  The Creative Director's job for a run. The worker queues it once every
  concept has settled; "Run the review again" queues it with retry set,
  under its own id so it is never mistaken for the first one.
*/
export const REVIEW_JOB = "review-run";

export interface ReviewJobData {
  runId: string;
  projectId: string;
  retry?: boolean;
}

export function reviewJobId(runId: string, attempt?: string): string {
  return attempt ? `review-${runId}-${attempt}` : `review-${runId}`;
}

/*
  Lane 2, Option B: importing the designer's Figma file (the frames rendered
  to images, the design's own images downloaded). No AI; same queue, so it
  waits its turn behind any render.
*/
export const FIGMA_IMPORT_JOB = "figma-import";

export interface FigmaImportJobData {
  projectId: string;
}

export function figmaImportJobId(projectId: string, at: number): string {
  return `figma-${projectId}-${at}`;
}

/*
  Lane 2, Option B, stop 4b: the Creative Director reviewing the designer's
  homepage frame. One AI call (one retry if the answer can't be used).
*/
export const DESIGN_REVIEW_JOB = "design-review";

export interface DesignReviewJobData {
  reviewId: string;
  projectId: string;
}

export function designReviewJobId(reviewId: string): string {
  return `design-review-${reviewId}`;
}

/*
  Lane 2, Option B: the faithful copy of the designer's homepage frame,
  built as HTML, rendered and compared with the Figma frame. One AI call.
*/
export const FAITHFUL_COPY_JOB = "faithful-copy";

export interface FaithfulCopyJobData {
  copyId: string;
  projectId: string;
  /** Replay (28 September 2026): build from these runs' saved AI answers, for $0. */
  replay?: { fromRunIds: string[] };
}

export function faithfulCopyJobId(copyId: string): string {
  return `faithful-copy-${copyId}`;
}

/*
  Lane 2, Option B, 4c: the ticked fixes applied to the faithful copy, one
  section at a time, as tracked changes; then one Creative Director re-score.
*/
export const DESIGN_IMPROVE_JOB = "design-improve";

export interface DesignImproveJobData {
  improvementId: string;
  projectId: string;
}

export function designImproveJobId(improvementId: string): string {
  return `design-improve-${improvementId}`;
}

/*
  Lane 2, Option B, 4c-2: the version with the designer's decisions. The
  pushed-back changes taken out of the improved design: whole sections put
  back for free, one small AI edit per section with a mix.
*/
export const DESIGN_DECISIONS_JOB = "design-decisions";

export interface DesignDecisionsJobData {
  improvementId: string;
  projectId: string;
}

export function designDecisionsJobId(improvementId: string): string {
  return `design-decisions-${improvementId}`;
}

/*
  "Websites they like": each listed site photographed once (first screen,
  1440 wide) by the worker. No AI.
*/
export const LIKED_SITES_JOB = "liked-sites";

/* Content first (1 October 2026): one AI call writes the home page's words for a new site. Paid, estimate first. */
export const HOME_WORDS_JOB = "home-words";

export interface HomeWordsJobData {
  projectId: string;
  startedByUserId: string | null;
}

export function homeWordsJobId(projectId: string, at: number): string {
  return `home-words-${projectId}-${at}`;
}

/*
  One read of the current site (0.96.0, docs/plans/flow-a-one-read.md): its
  pages by plain requests and the home page in the shared browser, on the
  reads queue, one at a time. No AI. Replaces 0.89.0's "site-import" and
  0.30's "current-site" jobs (LEGACY_READ_JOBS: a job queued by the old
  web app during a deploy still runs, or is let go).
*/
export const SITE_READ_JOB = "site-read";
export const LEGACY_READ_JOBS = { pages: "site-import", home: "current-site" } as const;

export interface SiteReadJobData {
  projectId: string;
  importId: string;
}

export function siteReadJobId(importId: string, at: number): string {
  return `site-read-${importId}-${at}`;
}

export interface LikedSitesJobData {
  projectId: string;
}

export function likedSitesJobId(projectId: string, at: number): string {
  return `liked-sites-${projectId}-${at}`;
}

/*
  Phase 7b: one page's copy, drafted (or redrafted) by AI from the intake,
  the page plan and the approved mockup's voice. One AI call; the answer
  is saved before it is read.
*/
export const CONTENT_DRAFT_JOB = "content-draft";

export interface ContentDraftJobData {
  draftId: string;
  projectId: string;
}

export function contentDraftJobId(draftId: string): string {
  return `content-draft-${draftId}`;
}

/*
  Build A (8a): the static site, built from the approved mockup and the
  approved page copy with Astro. One AI call for the shared parts and one
  per page; the answers are saved before they are read.
*/
export const SITE_BUILD_JOB = "site-build";

export interface SiteBuildJobData {
  buildId: string;
  projectId: string;
  /** The end-to-end check's build: answered from stand-ins, no AI (only for the check's own project). */
  standIn?: boolean;
}

export function siteBuildJobId(buildId: string): string {
  return `site-build-${buildId}`;
}

/*
  Build A, 8c: a monthly edit, made page by page on the live build's own
  source. One AI call a page; the answers are saved before they are read.
*/
export const SITE_EDIT_JOB = "site-edit";

/* Fix these (3 October 2026): one page's review comments, then a new build version from the saved sources. */
export const PAGE_FIX_JOB = "page-fix";

export interface PageFixJobData {
  fixId: string;
  projectId: string;
}

export function pageFixJobId(fixId: string): string {
  return `page-fix-${fixId}`;
}

export interface SiteEditJobData {
  requestId: string;
  projectId: string;
}

export function siteEditJobId(requestId: string): string {
  return `site-edit-${requestId}`;
}

/* Add-on: TAWD designs a logo for a client with none. One AI call. */
export const LOGO_JOB = "logo-design";

export interface LogoJobData {
  designId: string;
  projectId: string;
}

export function logoJobId(designId: string): string {
  return `logo-design-${designId}`;
}

/* The Senior SEO agent's report on a full SEO audit (the data is gathered first). One AI call. */
export const SEO_AUDIT_JOB = "seo-audit-report";

export interface SeoAuditJobData {
  auditId: string;
  projectId: string;
}

export function seoAuditJobId(auditId: string): string {
  return `seo-audit-report-${auditId}`;
}

/* The Senior SEO Manager's check of the built site before go-live. One AI call. */
export const SEO_GOLIVE_JOB = "seo-golive-check";

export interface SeoGoLiveJobData {
  checkId: string;
  projectId: string;
}

export function seoGoLiveJobId(checkId: string): string {
  return `seo-golive-check-${checkId}`;
}

/* The logo after approval: the intake's current logo put into the approved concept, as a new version. No AI. */
export const LOGO_SWAP_JOB = "logo-swap";

export interface LogoSwapJobData {
  swapId: string;
  projectId: string;
}

export function logoSwapJobId(swapId: string): string {
  return `logo-swap-${swapId}`;
}

/*
  Mockup inputs and the polish (27 September 2026). The reference study
  turns each reference site's outline and screenshot into a short brief
  (one AI call per site); the photo text check reads the visible text in
  the client's photos (one AI call) and compares it with the intake; the
  polish pass runs Impeccable's critique, then polish, once on a concept.
*/
export const REFERENCE_STUDY_JOB = "reference-study";

export interface ReferenceStudyJobData {
  projectId: string;
  startedByUserId: string | null;
}

export function referenceStudyJobId(projectId: string, at: number): string {
  return `reference-study-${projectId}-${at}`;
}

export const PHOTO_TEXT_JOB = "photo-text-check";

export interface PhotoTextJobData {
  checkId: string;
  projectId: string;
}

export function photoTextJobId(checkId: string): string {
  return `photo-text-${checkId}`;
}

export const POLISH_JOB = "polish-pass";

export interface PolishJobData {
  passId: string;
  projectId: string;
  conceptId: string;
}

export function polishJobId(passId: string): string {
  return `polish-${passId}`;
}

/* Lane 2 without Figma (28 September 2026): the uploaded PDF or images, read into the design. */
export const DESIGN_UPLOAD_JOB = "design-upload-read";

export interface DesignUploadJobData {
  projectId: string;
  startedByUserId: string | null;
  /** The version the web app gave this read (the storage folder). */
  version: string;
  /** Read every page again; otherwise pages already read from these same files are kept (27 September 2026). */
  all?: boolean;
  /**
   * The pages (read from the picture) to read now, when the PM chose them
   * (27 September 2026: the home page first, then the rest). Kept pages not
   * chosen are reused; pages never read and not chosen are left out.
   */
  pages?: number[];
}

export function designUploadJobId(projectId: string, at: number): string {
  return `design-upload-${projectId}-${at}`;
}

/*
  The new design read (E4, Lane 2, 14 November 2026): the band list from a
  look at the whole page, then each band at full size. Admin only while the
  new route is built beside the current one; reads a page picture an upload
  read already saved, and writes its result next to it. Stoppable like the
  current read (stops.ts, "design_read").
*/
export const DESIGN_READ_JOB = "design-read-new-route";

export interface DesignReadJobData {
  projectId: string;
  startedByUserId: string | null;
  /** The upload read whose saved page picture is read (figma_design.file_key). */
  version: string;
  /** The page number, as the upload read numbered it. */
  page: number;
  /** This start's own id, also written in the read's status: a job runs only while it is the latest start and has not begun before. */
  runId: string;
}

export function designReadJobId(projectId: string, at: number): string {
  return `design-read-${projectId}-${at}`;
}

/*
  Preparing a finished read's pictures again, without reading the design
  again (E4b-2b, Lane 2, 15 November 2026). Free: no AI call is made. It
  cuts and treats the pictures of a read that is already saved, with a
  person's corrections to their kinds and boxes applied first, so a wrong
  kind can be put right without paying for the read a second time (the gap
  left by E4b-1). It never touches the read itself.
*/
export const DESIGN_PICTURES_JOB = "design-read-pictures";

export interface DesignPicturesJobData {
  projectId: string;
  startedByUserId: string | null;
  /** The upload whose read this prepares (figma_design.file_key). */
  version: string;
  page: number;
  /** The read whose pictures these are: its own runId, not a new one. */
  runId: string;
  /** This attempt's own id, written in the pictures' status: only the latest attempt runs. */
  attempt: string;
}

export function designPicturesJobId(projectId: string, at: number): string {
  return `design-pictures-${projectId}-${at}`;
}

/*
  Building one page from a finished read (E5a, Lane 2, 15 November 2026;
  spec 15 section 6 stage 4). One paid call: the design picture, the band
  list, the measurements and the asset list in, one page and one stylesheet
  out. It is behind the admin switch beside the current route, and like the
  free prepare only the latest attempt runs.
*/
export const DESIGN_PAGE_JOB = "design-read-page";

export interface DesignPageJobData {
  projectId: string;
  startedByUserId: string | null;
  /** The upload whose read this builds from (figma_design.file_key). */
  version: string;
  page: number;
  /** The finished read this builds from: its own runId. */
  runId: string;
  /** This attempt's own id, written in the build's status: only the latest attempt runs. */
  attempt: string;
  /** What it was estimated to cost. Carried so the screen can show it and E5b's rounds can stop at twice it; one call has nothing yet to count against. */
  estimate: number;
}

export function designPageJobId(projectId: string, at: number): string {
  return `design-page-${projectId}-${at}`;
}

/* Option A: the phone version of one exactly copied page (28 September 2026). */
export const DESIGN_MOBILE_JOB = "design-mobile";

export interface DesignMobileJobData {
  copyId: string;
  projectId: string;
  /** Made by code, $0 (29 September 2026), instead of the AI. */
  byCode?: boolean;
}

export function designMobileJobId(copyId: string, at: number): string {
  return `design-mobile-${copyId}-${at}`;
}

/* The style kit (28 September 2026): found by code from the design's pages. No AI; one at a time with the other browser work. */
export const STYLE_KIT_JOB = "style-kit";

export interface StyleKitJobData {
  kitId: string;
  projectId: string;
}

export function styleKitJobId(kitId: string): string {
  return `style-kit-${kitId}`;
}

/* The kit repair (29 September 2026): a copy made right with the style kit by code. No AI; browser work, one at a time. */
export const COPY_REPAIR_JOB = "copy-repair";

export interface CopyRepairJobData {
  /** The new copy the repair makes (its repair_of names the copy repaired). */
  copyId: string;
  projectId: string;
}

export function copyRepairJobId(copyId: string): string {
  return `copy-repair-${copyId}`;
}

/* Filling a page from a page that shares its layout (29 September 2026). No AI; browser work, one at a time. */
export const TEMPLATE_FILL_JOB = "template-fill";

export interface TemplateFillJobData {
  /** The new copy the fill makes (its filled_from names the template page's copy). */
  copyId: string;
  projectId: string;
}

export function templateFillJobId(copyId: string): string {
  return `template-fill-${copyId}`;
}

/* The words and links tidy of every page's copy (29 September 2026). No AI; one at a time. */
export const SITE_TIDY_JOB = "site-tidy";

export interface SiteTidyJobData {
  projectId: string;
}

export function siteTidyJobId(projectId: string, at: number): string {
  return `site-tidy-${projectId}-${at}`;
}

/* The minimal SEO pass (29 September 2026): suggestions by code for every page. No AI. */
export const SEO_SUGGEST_JOB = "seo-suggest";

export interface SeoSuggestJobData {
  projectId: string;
}

export function seoSuggestJobId(projectId: string, at: number): string {
  return `seo-suggest-${projectId}-${at}`;
}

/* Build B, B2: deploy (or remove) a project's WordPress site on 20i (by its API and over SSH). No AI. */
export const WP_PREVIEW_JOB = "wp-preview";

export type WpPreviewAction = "deploy" | "remove" | "https" | "attach" | "cert" | "https_live" | "golive" | "rollback" | "undo_rollback" | "suspend" | "restore" | "purge" | "move_check" | "holder_test";

export interface WpPreviewJobData {
  projectId: string;
  /**
   * deploy, remove, https (Check HTTPS on the preview); B3: attach (the client's domain on the package),
   * cert (the certificate, per the HTTPS path), https_live (Check HTTPS on the domain), golive, rollback, undo_rollback;
   * 20i: suspend, restore, purge (20i's cache).
   */
  action: WpPreviewAction;
  /** cert: which address's certificate (the preview's or the client's domain). */
  target?: "preview" | "live";
  /** Who asked (suspend, restore, purge), for the activity log. */
  by?: string;
  /** move_check (12 October 2026): the preview moved from 20i's address (from) to the preview domain (to), and this is try number tries. */
  from?: string;
  to?: string;
  tries?: number;
}

export function wpPreviewJobId(projectId: string, at: number): string {
  return `wp-preview-${projectId}-${at}`;
}

/* The Speed check (1 October 2026): Google PageSpeed on a preview, phone and computer. No AI, no browser. */
export const SPEED_CHECK_JOB = "speed-check";

export interface SpeedCheckJobData {
  checkId: string;
}

export function speedCheckJobId(checkId: string): string {
  return `speed-check-${checkId}`;
}

/* Build B on 20i: "Check the 20i account", read-only calls to 20i's API (the key is on the worker only). No AI. */
export const TWENTYI_CHECK_JOB = "twentyi-check";

export interface TwentyiCheckJobData {
  checkId: string;
}

export function twentyiCheckJobId(checkId: string): string {
  return `twentyi-check-${checkId}`;
}

/* Build B on 20i: the daily work (IP watch, certificate renewals and warnings), queued by the web's hourly tick. No AI. */
export const WP_SITES_DAILY_JOB = "wp-sites-daily";

export interface WpSitesDailyJobData {
  /** When the web's tick queued it (the stamp the run is recorded against). */
  at: string;
}

export function wpSitesDailyJobId(at: string): string {
  return `wp-sites-daily-${at.replace(/[^0-9]/g, "")}`;
}

/*
  The preview domain's watch (0.122.0, Jason 3 November 2026): every hour, the placeholder package at 20i (on, there), and once a
  day the preview domain's registration (its expiry date, from RDAP). Live WordPress sites depend on both. Queued by the web's
  hourly tick. No AI.
*/
export const WP_HOLDER_WATCH_JOB = "wp-holder-watch";

export interface WpHolderWatchJobData {
  at: string;
}

/** One a clock hour: a second tick in the same hour finds the job already there. */
export function wpHolderWatchJobId(at: string): string {
  return `wp-holder-watch-${at.replace(/[^0-9]/g, "").slice(0, 10)}`;
}

/*
  Work at once (28 September 2026): three kinds of job get their own queue,
  so they no longer wait one at a time behind everything else. Copies and
  concepts share one Chromium in the worker; drafts use no browser. Every
  other job stays on MOCKUP_QUEUE, one at a time.
*/
export const COPY_QUEUE = "tawd-copies";
export const DRAFT_QUEUE = "tawd-drafts";
export const CONCEPT_QUEUE = "tawd-concepts";
/*
  WordPress on 20i (5 October 2026, Fable's review finding 12): its jobs
  wait on SSH and 20i, not on a browser, and a go-live (backup, search and
  replace, checks) can outlast the main queue's 20-minute lock. They run on
  their own queue, one at a time, with a longer lock.
*/
export const WP_QUEUE = "tawd-wordpress";
/*
  Site reads (0.94.0; one read since 0.96.0): a 50-page site takes about a
  minute, so reads run on their own queue, one at a time, and never hold
  concepts and renders. The home page's look opens one tab in the shared
  Chromium (5-20 s), not a browser of its own.
*/
export const READS_QUEUE = "tawd-reads";

export function queueFor(jobName: string): string {
  if (jobName === FAITHFUL_COPY_JOB) return COPY_QUEUE;
  if (jobName === CONTENT_DRAFT_JOB) return DRAFT_QUEUE;
  if (jobName === CONCEPT_JOB) return CONCEPT_QUEUE;
  if (jobName === WP_PREVIEW_JOB || jobName === TWENTYI_CHECK_JOB || jobName === WP_SITES_DAILY_JOB || jobName === WP_HOLDER_WATCH_JOB) return WP_QUEUE;
  if (jobName === SITE_READ_JOB || jobName === LEGACY_READ_JOBS.pages) return READS_QUEUE;
  return MOCKUP_QUEUE;
}

export const QUEUES = [MOCKUP_QUEUE, COPY_QUEUE, DRAFT_QUEUE, CONCEPT_QUEUE, WP_QUEUE, READS_QUEUE] as const;

/*
  A homepage supplied as one finished HTML file (16 November 2026): read,
  stored as a concept version and photographed, so the site is built from it
  like from any approved mockup. No AI and no network; same queue, so it
  waits its turn behind any render.
*/
export const HTML_MOCKUP_IMPORT_JOB = "html-mockup-import";

export interface HtmlMockupImportJobData {
  projectId: string;
  /** Who supplied the file: the activity entry names them. */
  startedByUserId: string;
  /** "Read it again" was pressed: read the file even though this exact file was read already. */
  again?: boolean;
}

/*
  One id per uploaded file, so a repeated confirm or a double click is one job
  (BullMQ keeps a job's id for a day and ignores a second add with it). "Read
  it again" adds a minute, so two clicks in the same minute are one job too.
*/
export function htmlMockupImportJobId(projectId: string, fileId: string, again?: number): string {
  return `html-mockup-${projectId}-${fileId}${again === undefined ? "" : `-again-${Math.floor(again / 60_000)}`}`;
}
