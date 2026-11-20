"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ImproveError, revertToKept, startImprove } from "@/lib/content-improve";
import { prepareContent } from "@/lib/content-prep";
import { TeamSlackError, connectTeamSlack, disconnectTeamSlack, copyProjectWebhook } from "@/lib/team-slack";
import { ResumeError, pauseProject, resumeProject } from "@/lib/resume";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { TeamRole } from "@tawd/core/enums";
import { teamRoles } from "@tawd/core/enums";
import { getDb } from "@tawd/core/db";
import { isFileKind } from "@tawd/core/intake";
import type { IntakeSectionKey } from "@tawd/core/intake";
import {
  IntakeError,
  confirmUpload,
  getFileViewUrl,
  removeFile,
  requestUpload,
  saveIntakeSection,
  StaleIntakeError,
  setFileCaption,
} from "@tawd/core/intake/service";
import { PermissionError, can } from "@tawd/core/permissions";
import {
  MockupError,
  getConceptAssetUrl,
  planRun,
  resolvePicks,
  startAlternatives,
  startRun,
  stopRun,
} from "@/lib/mockups";
import type { DirectionId } from "@tawd/core/mockups";
import { ProjectDeleteError, deleteProject } from "@/lib/project-deletion";
import { setProjectCap, SpendError, setMonthlyLimit } from "@/lib/spend";
import {
  SlackSettingsError,
  connectSlack,
  disconnectSlack,
  sendSlackTest,
  setSlackComments,
} from "@/lib/slack-settings";
import {
  addComment,
  recordClientDecision,
  requestChanges,
  retryNotDone,
  rerunReview,
  setCommentResolved,
  setSendToClient,
  showHeldConcept,
} from "@/lib/concept-review";
import { listPeopleNames } from "@/lib/users";
import { approveWireframe, resetWireframe, saveWireframe, setWireframeEnabled } from "@/lib/wireframe";
import {
  PageReviewError,
  addReviewComment,
  approveReviewedPage,
  approveUnchanged,
  overridePageReview,
  setReviewCommentResolved,
  markReviewComment,
  startPageFix,
  withdrawApproval,
} from "@/lib/page-review";
import { GateError, createProject, getProject, updateProject } from "@/lib/projects";
import type { ActionState } from "@/lib/action-state";
import { getServiceContext } from "@/lib/server-context";
import {
  FigmaDesignError,
  chooseFinalPage,
  confirmPrefill,
  prefillIntakeFromDesign,
  queueFigmaImport,
  recheckFigma,
  saveFigmaLink,
} from "@/lib/figma";
import { DesignReviewError, setFindingTicked, setGroupTicked, startDesignReview } from "@/lib/design-review";
import { DesignCopyError, replayCopy, startDesignCopy } from "@/lib/design-copy";
import { StyleKitError, setKitFont, startStyleKit } from "@/lib/style-kit";
import { CopyRepairError, fillFromTemplates, repairCopies } from "@/lib/copy-repair";
import { SiteTidyError, saveLinkRules, startSiteTidy } from "@/lib/site-tidy";
import { SiteVideosError, saveSiteVideos } from "@/lib/site-videos";
import { SeoPassError, approveSeo, startSeoSuggest, type SeoValues } from "@/lib/seo-pass";
import { E2eCheckError, startE2eCheck } from "@/lib/e2e-check";
import { DesignSiteError, checkDesignBuild, decideOpenSuggestions, decideSuggestion, refreshDesignSite, reworkDesignPage, skipDesignReview, startDesignBuild, undoKitRepair } from "@/lib/design-site";
import {
  DesignImprovementError,
  putDesignOnBoard,
  setChangeDecision,
  startDecisionsVersion,
  startDesignImprovement,
} from "@/lib/design-improvement";
import { requestPasswordReset, resetPasswordWithLink } from "@/lib/password-reset";
import { sendTestEmail } from "@/lib/mail";
import { BrandGuideError, answerBrandGuideSuggestion, readBrandGuideLater } from "@/lib/brand-guide";
import { syncLikedSites } from "@/lib/liked-sites";
import { startPhotoTextCheck, startReferenceStudy } from "@/lib/mockup-inputs";
import { startPolish } from "@/lib/polish";
import { startDesignUpload } from "@/lib/design-upload";
import { HtmlMockupImportError, queueHtmlMockupImport, readHomepageAfterUpload } from "@/lib/html-mockup-import";
import { startNewDesignRead } from "@/lib/design-read-new";
import { correctReadBand } from "@/lib/design-read-corrections";
import { correctReadPicture, correctReadWord, preparePicturesAgain } from "@/lib/design-read-items";
import { startDesignPageBuild } from "@/lib/design-page";
import type { BandChange } from "@tawd/core/figma/read-corrections";
import type { PictureChange, WordChange } from "@tawd/core/figma/read-item-corrections";
import { PrivacyLawError, markLawChecked, recordPrivacyReview } from "@/lib/privacy-laws";
import { TwentyiSettingsError, chooseCertPath, choosePackageType, forgetServerKey, makeTwentyiKey, startTwentyiCheck } from "@/lib/twentyi";
import { HostingError, setFormPlugin, setHosting, type FormPlugin, type Hosting } from "@/lib/hosting";
import { WpPreviewError, checkWpPreviewHttps, confirmPackageLimit, removeWpPreview, requestPreviewCertificate, showWpLogin, startWpPreview } from "@/lib/wp-preview";
import { checkRecords, choosePath, detectDomain, makeClientLink } from "@/lib/connect";
import { attachWpDomain, checkWpHttps, confirmPaidCertificate, purgeWpCache, requestWpCertificate, setWpSuspended, wpGoLive, wpRollback, wpUndoRollback } from "@/lib/wp-golive";
import { FormsRelayError, resendMessage, sendTestMessages, viewMessage } from "@/lib/forms-relay";
import { checkAllSites, checkPreviewForm, saveInboxes, sendLabTest } from "@/lib/delivery-checks";
import { overrideSpeed, SpeedCheckError, startSpeedCheck, type SpeedTarget } from "@/lib/speed-check";
import { StepModelError, saveStepModel } from "@/lib/step-models";
import { StopError, stopWork } from "@/lib/stops";
import { acceptCopy, approveExactDesign, confirmDesignPages, decideMobile, renameDesignPages, startExactCopies, startMobileVersions, startPhonesByCode } from "@/lib/exact-design";
import {
  GoLiveError,
  attachNetlifyDomain,
  checkEmailRecords,
  checkHttps,
  checkNameservers,
  checkRegistry,
  confirmDomain,
  confirmEmailRecords,
  goLiveNow,
  readEmailRecords,
  recordBuildFeePaid,
  recordGa4,
  rollBack,
  setUpCloudflare,
  undoBuildFeePaid,
} from "@/lib/golive";
import { PricingError, saveAddonPrice, savePackage, setProjectCancelled, setProjectPrice } from "@/lib/pricing";
import { LogoError, chooseLogo, startLogoDesign, syncLogoAddon } from "@/lib/logo-design";
import { AuditError, addFullAudit, countSitePages, saveRedirect, startFullAudit, startQuickCheck } from "@/lib/seo-audit";
import { SeoCheckError, applySafeFixes, signOffSeo, startSeoGoLiveCheck } from "@/lib/seo-golive";
import {
  SeoDataError,
  makePagePlan,
  movePlanPage,
  removePlanPage,
  savePlanPage,
  setSeoLimit,
  startKeywordResearch,
  testDataForSeoConnection,
  loadDmaMarkets,
  type ConnectionTest,
  type PlanPageInput,
} from "@/lib/seo-data";
import {
  ContentError,
  addPageComment,
  approvePage,
  moveToBuild,
  checkAiWriting,
  recordCopyDecision,
  requestRedraft,
  resolvePageComment,
  saveDraftEdit,
  startDrafts,
} from "@/lib/content-drafts";
import { SiteError, siteReadiness, startSiteBuild, startSpeedUp, startStageBuild } from "@/lib/site-builds";
import { NetlifyError, deployPreview, recordPreviewDecision, syncFormRecipients } from "@/lib/netlify";
import { EditError, closeEditRequest, createEditRequest, logDevTime, rebuildWithEdit, startEdit } from "@/lib/edits";
import { SiteReadServiceError, approvePaidRead, setRouteCap, approveKeptPages, readSiteAgain, replacePlanWithSite, syncAfterTierChange, syncKeepChoice, syncSiteRead } from "@/lib/site-read";
import { approveHomeWords, startHomeWords, writeHomeWords } from "@/lib/home-words";
import { UpdatesError, logUpdateRequest, previewRequest, recordQuoteAnswer, saveInvoice, setIncludedHours, type InvoiceLine, type RequestInput } from "@/lib/updates";
import type { Tier } from "@tawd/core/enums";
import { requireUser, requireUserPendingPasswordChange } from "@/lib/session";
import { ClientDesignError, makeClientDesignDoc } from "@/lib/client-design";
import { HealthFlagError, confirmHealthFlag } from "@/lib/health-flags";
import { TrackingError, saveTracking } from "@/lib/tracking";
import { LogoApprovalError, recordLogoApproval, startLogoSwap } from "@/lib/logo-after-approval";
import type { TrackingConfig } from "@tawd/core/site";
import { signIn, signOut } from "@/lib/sign-in";
import {
  UserManagementError,
  changeOwnPassword,
  createTeamUser,
  deleteTeamUser,
  resetUserPassword,
  setUserAdmin,
  setUserName,
  setUserDisabled,
  setUserRoles,
} from "@/lib/users";
import {
  changePasswordSchema,
  createUserSchema,
  passwordSchema,
  projectSchema,
  signInSchema,
} from "@/lib/validation";

/*
  Every mutation in TAWD goes through one of these.

  Two habits worth keeping: the permission check happens in the service layer
  rather than here, so it cannot be skipped by adding a new caller; and an
  unexpected failure returns a short message rather than leaking a database
  error into the browser.
*/

function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function messageFor(error: unknown): string {
  if (error instanceof PermissionError) {
    return "You do not have permission to do that.";
  }
  if (
    error instanceof UserManagementError ||
    error instanceof IntakeError ||
    error instanceof GateError ||
    error instanceof MockupError ||
    error instanceof PageReviewError ||
    error instanceof SiteReadServiceError ||
    error instanceof ImproveError ||
    error instanceof GoLiveError ||
    error instanceof PrivacyLawError ||
    error instanceof TwentyiSettingsError ||
    error instanceof HostingError ||
    error instanceof WpPreviewError ||
    error instanceof FormsRelayError ||
    error instanceof StepModelError ||
    error instanceof StopError ||
    error instanceof SlackSettingsError ||
    error instanceof TeamSlackError ||
    error instanceof ResumeError ||
    error instanceof FigmaDesignError ||
    error instanceof DesignReviewError ||
    error instanceof DesignCopyError ||
    error instanceof StyleKitError ||
    error instanceof CopyRepairError ||
    error instanceof SiteTidyError ||
    error instanceof SiteVideosError ||
    error instanceof SeoPassError ||
    error instanceof DesignSiteError ||
    error instanceof DesignImprovementError ||
    error instanceof BrandGuideError ||
    error instanceof PricingError ||
    error instanceof SeoDataError ||
    error instanceof ContentError ||
    error instanceof SiteError ||
    error instanceof NetlifyError ||
    error instanceof EditError ||
    error instanceof UpdatesError ||
    error instanceof LogoError ||
    error instanceof AuditError ||
    error instanceof SeoCheckError ||
    error instanceof ClientDesignError ||
    error instanceof HealthFlagError ||
    error instanceof TrackingError ||
    error instanceof SpeedCheckError ||
    error instanceof LogoApprovalError ||
    error instanceof HtmlMockupImportError
  ) {
    return error.message;
  }
  console.error("Action failed:", error);
  return "Something went wrong. Try again.";
}

function failed(error: unknown): ActionState {
  return { error: messageFor(error) };
}

/* ---------- signing in and out ---------- */

export async function signInAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  const ctx = await getServiceContext();
  const result = await signIn(
    ctx,
    await headers(),
    parsed.data.email,
    parsed.data.password,
  );

  if (!result.ok) return { error: result.message };

  redirect(result.redirectTo);
}

export async function signOutAction(): Promise<void> {
  const current = await requireUserPendingPasswordChange();
  const ctx = await getServiceContext();

  await signOut(ctx, await headers(), { id: current.id, email: current.email });

  // Always the Signed-out page, never a bare bounce to Sign in.
  redirect("/signed-out");
}

export async function changePasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const current = await requireUserPendingPasswordChange();

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  const ctx = await getServiceContext();

  try {
    await changeOwnPassword(
      ctx,
      current,
      await headers(),
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
  } catch {
    // The only likely cause is the current password being wrong. Better Auth
    // does not distinguish further, and neither should the message.
    return {
      fieldErrors: { currentPassword: ["That current password is not right"] },
    };
  }

  // First sign-in: on to work. A change by choice stays on the page and says so.
  if (current.mustChangePassword) redirect("/");
  return { notice: "Your password is changed. You're still signed in here; every other device is signed out." };
}

/* ---------- projects ---------- */

function projectFormValues(formData: FormData) {
  const laneOption = formData.get("laneOption");
  const conceptCount = formData.get("conceptCount");

  return {
    clientName: formData.get("clientName"),
    trade: formData.get("trade"),
    tier: formData.get("tier"),
    lane: formData.get("lane"),
    laneOption: laneOption === "" || laneOption === null ? null : laneOption,
    conceptCount:
      conceptCount === "" || conceptCount === null ? null : conceptCount,
    // Never from the form: new projects start at Intake, and a project only
    // moves on through the stage flow and its gates.
    status: "intake",
    memberUserIds: formData.getAll("memberUserIds").map(String),
  };
}

export async function createProjectAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const current = await requireUser();

  const parsed = projectSchema.safeParse(projectFormValues(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  let projectId: string;
  try {
    const ctx = await getServiceContext();
    projectId = await createProject(ctx, current, parsed.data);
  } catch (error) {
    return failed(error);
  }

  revalidatePath("/projects");
  // Straight into the intake, which is the next thing anyone does.
  redirect(`/projects/${projectId}/intake`);
}

export async function updateProjectAction(
  projectId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const current = await requireUser();

  const ctx = await getServiceContext();
  const existing = await getProject(ctx.db, current, projectId);
  if (!existing) return { error: "That project no longer exists." };

  // Editing changes the details, never the stage: the stage is kept as it is.
  const parsed = projectSchema.safeParse({
    ...projectFormValues(formData),
    status: existing.status,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  try {
    await updateProject(ctx, current, projectId, parsed.data);
  } catch (error) {
    return failed(error);
  }
  // A higher tier: pages left over the old limit are read too (free, 0.96.0).
  await syncAfterTierChange(ctx, projectId).catch((error: unknown) => console.error(`Current site after a tier change: ${error instanceof Error ? error.message : "unknown"}`));

  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

/* ---------- user administration ---------- */

/*
  The Team page. Called directly by the page's panel and dialog rather than
  through form posts, so each answers with exactly what the screen shows:
  a message, a field error, or a temporary password shown once.
*/
export type TeamActionResult =
  | { ok: true; notice?: string; temporaryPassword?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export async function createTeamMemberAction(input: {
  name: string;
  email: string;
  isAdmin: boolean;
  roles: string[];
}): Promise<TeamActionResult> {
  const current = await requireUser();

  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const [key, messages] of Object.entries(fieldErrorsOf(parsed.error))) {
      if (messages?.[0]) fieldErrors[key] = messages[0];
    }
    return { ok: false, message: "Check the highlighted fields.", fieldErrors };
  }

  try {
    const ctx = await getServiceContext();
    const created = await createTeamUser(ctx, current, parsed.data);
    revalidatePath("/admin/users");
    return {
      ok: true,
      notice: `Account created for ${parsed.data.email}.`,
      temporaryPassword: created.temporaryPassword,
    };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function updateTeamMemberAction(
  userId: string,
  input: { name: string; roles: string[]; isAdmin: boolean },
): Promise<TeamActionResult> {
  const current = await requireUser();

  const roles = z.array(z.enum(teamRoles)).safeParse(input.roles);
  if (!roles.success) return { ok: false, message: "That is not a valid set of roles." };

  try {
    const ctx = await getServiceContext();
    // All three in one transaction (13 October 2026, the whole-code review): a name or roles refused after the admin switch
    // changed leaves everything as it was, never the admin taken away on its own.
    await ctx.db.transaction(async (tx) => {
      const inTx = { ...ctx, db: tx as unknown as typeof ctx.db };
      await setUserAdmin(inTx, current, userId, input.isAdmin);
      await setUserName(inTx, current, userId, input.name);
      await setUserRoles(inTx, current, userId, roles.data as TeamRole[]);
    });
    revalidatePath("/admin/users");
    return { ok: true, notice: "Changes saved." };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setTeamMemberDisabledAction(
  userId: string,
  disabled: boolean,
): Promise<TeamActionResult> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await setUserDisabled(ctx, current, userId, disabled);
    revalidatePath("/admin/users");
    return { ok: true, notice: disabled ? "Account disabled." : "Account enabled." };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function resetTeamMemberPasswordAction(
  userId: string,
): Promise<TeamActionResult> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    const temporaryPassword = await resetUserPassword(ctx, current, userId);
    revalidatePath("/admin/users");
    return {
      ok: true,
      notice: "Password reset. They choose a new one when they next sign in.",
      temporaryPassword,
    };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function deleteTeamMemberAction(
  userId: string,
  confirmName: string,
  reason: string,
): Promise<TeamActionResult> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await deleteTeamUser(ctx, current, userId, { confirmName, reason });
    revalidatePath("/admin/users");
    return { ok: true, notice: "Account deleted." };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- intake ---------- */

export type IntakeSaveResult =
  | { ok: true; changedPaths: string[]; warning?: string; prefillStamp?: string | null }
  // stale: TAWD filled answers in this section after the form loaded; nothing was saved (the form offers Reload).
  | { ok: false; message: string; stale?: true };

/*
  Called directly by the workspace rather than through a form, because the
  intake keeps its answers in React state: one section is on screen, and the
  save bar sends that section's values as they stand.
*/
export async function saveIntakeSectionAction(
  projectId: string,
  section: IntakeSectionKey,
  values: unknown,
  // What the form was loaded with (latestPrefillStamp). Left out, the save is not checked.
  prefillStamp?: string | null,
): Promise<IntakeSaveResult> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    const result = await saveIntakeSection(
      ctx,
      current,
      projectId,
      section,
      values,
      prefillStamp === undefined ? {} : { prefillStamp },
    );

    // The section is saved by now: a follow-up that fails never shows as "not saved" (13 October 2026, the whole-code review),
    // but it is named on the save bar with Try again, which runs it again (29 October 2026, CodeRabbit on PR #14).
    const missed: string[] = [];
    const followUp = (name: string, run: () => Promise<unknown>) =>
      run().catch((error: unknown) => {
        console.error(`${name}: ${error instanceof Error ? error.message : "unknown"}`);
        missed.push(name.toLowerCase());
      });
    // "Websites they like": new ones get a screenshot, removed ones lose theirs.
    if (section === "website") {
      await followUp("Liked sites", () => syncLikedSites(ctx, projectId));
      // One read of the current site: its pages and its home page, free (0.96.0).
      await followUp("Current site", () => syncSiteRead(ctx, projectId));
      // The free "Don't lose it" check of the current website starts by itself.
      await followUp("Current site check", () => startQuickCheck(ctx, current, projectId, { auto: true }));
    }
    // Keep all content as is: with the site already read, the page plan makes itself (0.96.0).
    if (section === "content") await followUp("The kept page plan", () => syncKeepChoice(ctx, projectId));
    // "TAWD designs the logo": the add-on follows the tick box.
    if (section === "brand") await followUp("Logo add-on", () => syncLogoAddon(ctx, current, projectId));
    // F1: who gets the form messages changed: the live Netlify site's emails follow (a failure doesn't stop the save).
    if (section === "forms" || section === "business") await followUp("Form recipients", () => syncFormRecipients(ctx.db, current, projectId));

    revalidatePath(`/projects/${projectId}/intake`);
    revalidatePath(`/projects/${projectId}`);

    return {
      ok: true,
      changedPaths: result.changedPaths,
      ...(result.prefillStamp !== undefined ? { prefillStamp: result.prefillStamp } : {}),
      ...(missed.length ? { warning: `Saved, but these didn't update: ${missed.join(", ")}. Try again in a minute.` } : {}),
    };
  } catch (error) {
    if (error instanceof StaleIntakeError) return { ok: false, message: error.message, stale: true };
    return { ok: false, message: messageFor(error) };
  }
}

/*
  Photo captions live on the file rows rather than in the section document,
  so they are saved alongside the Photos section rather than on blur. Each
  caption that actually changed still gets its own log entry, as before.
*/
export async function savePhotoCaptionsAction(
  projectId: string,
  captions: Record<string, string>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    for (const [fileId, caption] of Object.entries(captions)) {
      await setFileCaption(ctx, current, fileId, caption);
    }

    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/*
  Moving a project on from Intake.

  This is a second route to exactly the same thing the Edit page does: the
  gate, the override rules and the logging all live in updateProject, so
  nothing here can soften them.
*/
export async function moveToMockupsAction(
  projectId: string,
  options: { continueWithoutMissing?: boolean; note?: string | null } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const db = getDb();
    const project = await getProject(db, current, projectId);
    if (!project) return { ok: false, message: "That project no longer exists." };

    const ctx = await getServiceContext();
    await updateProject(
      ctx,
      current,
      projectId,
      {
        clientName: project.clientName,
        trade: project.trade,
        tier: project.tier,
        lane: project.lane,
        laneOption: project.laneOption,
        conceptCount: project.conceptCount,
        status: "mockups",
        memberUserIds: project.members.map((m) => m.id),
      },
      {
        continueWithoutMissing: Boolean(options.continueWithoutMissing),
        note: options.note?.trim() || null,
      },
    );

    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/*
  The upload dance, in three calls.

  These return a result rather than throwing, because the uploader calls them
  directly and needs to show the reason rather than a generic error page.
*/
export type UploadTicketResult =
  | { ok: true; fileId: string; uploadUrl: string }
  | { ok: false; message: string };

export async function requestUploadAction(
  projectId: string,
  kind: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<UploadTicketResult> {
  const current = await requireUser();

  if (!isFileKind(kind)) return { ok: false, message: "Unknown kind of file." };

  try {
    const ctx = await getServiceContext();
    const ticket = await requestUpload(
      ctx,
      current,
      projectId,
      kind,
      fileName,
      contentType,
      sizeBytes,
    );
    return { ok: true, ...ticket };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function confirmUploadAction(
  fileId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await confirmUpload(ctx, current, fileId);
    // A brand guide PDF is read once, in the background, into suggestions.
    readBrandGuideLater(ctx.db, fileId);
    // A finished homepage (HTML) is read once, by itself, right now: free, no AI, nothing to press. Never fails the upload.
    await readHomepageAfterUpload(ctx, current, fileId);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setFileCaptionAction(
  fileId: string,
  caption: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await setFileCaption(ctx, current, fileId, caption);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function removeFileAction(
  fileId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await removeFile(ctx, current, fileId);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/** A link to a stored file that works for five minutes. */
export async function openFileAction(
  fileId: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const url = await getFileViewUrl(getDb(), current, fileId);
    if (!url) return { ok: false, message: "That file is no longer there." };
    return { ok: true, url };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- the mockup engine ---------- */

export async function startRunAction(
  projectId: string,
  conceptCount: number,
  picks?: { label: "A" | "B" | "C"; direction: DirectionId }[],
  options: { polish?: boolean } = {},
): Promise<{ ok: true; runId: string } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const plan = await planRun(current, projectId, conceptCount);
    const ctx = await getServiceContext();

    const runId = await startRun(ctx, current, {
      projectId,
      concepts: resolvePicks(plan, picks),
      suggested: plan.plan.concepts,
      polish: options.polish ?? true,
    });

    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, runId };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function stopRunAction(
  projectId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await stopRun(ctx, current, runId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- team review and the client (3c) ---------- */

export async function showHeldConceptAction(
  projectId: string,
  conceptId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await showHeldConcept(await getServiceContext(), current, conceptId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setSendToClientAction(
  projectId: string,
  conceptId: string,
  send: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await setSendToClient(await getServiceContext(), current, conceptId, send);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The logo after approval: the new logo into the approved concept (no AI). */
export async function startLogoSwapAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startLogoSwap(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The logo after approval: the client's approval of the logo, recorded. */
export async function recordLogoApprovalAction(projectId: string, input: { channel: string; clientSaid: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await recordLogoApproval(await getServiceContext(), current, projectId, input);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Admins: the TV markets (DMAs), one free DataForSEO call. */
export async function loadDmaMarketsAction(): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const { count } = await loadDmaMarkets(await getServiceContext(), current);
    revalidatePath("/admin/spend");
    return { ok: true, count };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Admins: the DataForSEO connection, tested from the server. */
export async function testDataForSeoAction(): Promise<{ ok: true; result: ConnectionTest } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    return { ok: true, result: await testDataForSeoConnection(await getServiceContext(), current) };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* A project's tracking codes: IDs only, written into the site on its next build. */
export async function saveTrackingAction(projectId: string, input: TrackingConfig): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await saveTracking(await getServiceContext(), current, projectId, input);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Health and beauty rules: a flag confirmed with the client, before go-live. */
export async function confirmHealthFlagAction(projectId: string, flagId: string, note: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await confirmHealthFlag(await getServiceContext(), current, projectId, flagId, note);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The client's DESIGN.md, written again from the approved design. */
export async function makeClientDesignDocAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await makeClientDesignDoc(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function recordClientDecisionAction(
  projectId: string,
  input: { conceptId: string; channel: string; changesRequested: boolean; clientSaid: string; logoApproved?: boolean },
): Promise<{ ok: true; movedToContent: boolean } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const result = await recordClientDecision(await getServiceContext(), current, input);
    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/projects");
    return { ok: true, movedToContent: result.movedToContent };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function addCommentAction(
  projectId: string,
  input: {
    conceptId: string;
    version: number;
    body: string;
    pinX?: number | null;
    pinY?: number | null;
    band?: number | null;
    parentId?: string | null;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await addComment(await getServiceContext(), current, input);
    revalidatePath(`/projects/${projectId}/mockups/${input.conceptId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setCommentResolvedAction(
  projectId: string,
  conceptId: string,
  commentId: string,
  resolved: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await setCommentResolved(await getServiceContext(), current, commentId, resolved);
    revalidatePath(`/projects/${projectId}/mockups/${conceptId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function requestChangesAction(
  projectId: string,
  input: { conceptId: string; notes: string; includeComments: boolean },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await requestChanges(await getServiceContext(), current, input);
    revalidatePath(`/projects/${projectId}/mockups/${input.conceptId}`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- The wireframe (3 October 2026) ---------- */

async function wireframeAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>, current: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await run(await getServiceContext(), current);
    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function saveWireframeAction(projectId: string, sections: unknown) {
  return wireframeAction(projectId, (ctx, current) => saveWireframe(ctx, current, projectId, sections));
}

export async function approveWireframeAction(projectId: string, sections: unknown) {
  return wireframeAction(projectId, (ctx, current) => approveWireframe(ctx, current, projectId, sections));
}

export async function resetWireframeAction(projectId: string) {
  return wireframeAction(projectId, (ctx, current) => resetWireframe(ctx, current, projectId));
}

export async function setWireframeEnabledAction(projectId: string, enabled: boolean) {
  return wireframeAction(projectId, (ctx, current) => setWireframeEnabled(ctx, current, projectId, enabled));
}

/* ---------- The page-by-page review (step 3a, 3 October 2026) ---------- */

type Done = { ok: true } | { ok: false; message: string };

async function pageReviewAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>, current: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<Done> {
  const current = await requireUser();
  try {
    await run(await getServiceContext(), current);
    revalidatePath(`/projects/${projectId}/build`);
    revalidatePath(`/projects/${projectId}/build/review`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function addReviewCommentAction(
  projectId: string,
  input: {
    pageId: string;
    body: string;
    area?: "header" | "footer" | "main" | null;
    section?: number | null;
    sectionLabel?: string | null;
    pinX?: number | null;
    pinY?: number | null;
    parentId?: string | null;
  },
): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => addReviewComment(ctx, current, { projectId, ...input }));
}

export async function setReviewCommentResolvedAction(projectId: string, commentId: string, resolved: boolean): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => setReviewCommentResolved(ctx, current, projectId, commentId, resolved));
}

/* 3c: the reviewer's Done or Not done on a comment sent in a fix (no AI). */
export async function markReviewCommentAction(projectId: string, commentId: string, outcome: "done" | "not_done"): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => markReviewComment(ctx, current, projectId, commentId, outcome === "done" ? "done" : "not_done"));
}

export async function approveReviewedPageAction(projectId: string, pageId: string): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => approveReviewedPage(ctx, current, projectId, pageId));
}

export async function withdrawPageApprovalAction(projectId: string, pageId: string): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => withdrawApproval(ctx, current, projectId, pageId));
}

export async function approveUnchangedPagesAction(projectId: string): Promise<Done> {
  return pageReviewAction(projectId, async (ctx, current) => approveUnchanged(ctx, current, projectId, await listPeopleNames(ctx.db)));
}

export async function startPageFixAction(projectId: string, pageId: string): Promise<Done> {
  return pageReviewAction(projectId, (ctx, current) => startPageFix(ctx, current, projectId, pageId));
}

export async function overridePageReviewAction(projectId: string): Promise<Done> {
  return pageReviewAction(projectId, async (ctx, current) => overridePageReview(ctx, current, projectId, await listPeopleNames(ctx.db)));
}

/* The second try for comments the Creative Director found not done (2 October 2026). */
export async function retryNotDoneAction(
  projectId: string,
  conceptId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await retryNotDone(await getServiceContext(), current, { conceptId });
    revalidatePath(`/projects/${projectId}/mockups/${conceptId}`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Mockup inputs and the polish (27 September 2026) ---------- */

export async function startReferenceStudyAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startReferenceStudy(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/intake`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startPhotoTextCheckAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startPhotoTextCheck(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startPolishAction(projectId: string, conceptId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startPolish(await getServiceContext(), current, conceptId);
    revalidatePath(`/projects/${projectId}/mockups/${conceptId}`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function confirmDesignPagesAction(projectId: string, pages: { id: string; name: string; slug: string }[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await confirmDesignPages(await getServiceContext(), current, projectId, pages);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startMobileVersionsAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startMobileVersions(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startDesignBuildAction(projectId: string, slugs: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startDesignBuild(await getServiceContext(), current, projectId, slugs);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function reworkDesignPageAction(projectId: string, key: string, feedback: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await reworkDesignPage(await getServiceContext(), current, projectId, key, feedback);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function refreshDesignSiteAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await refreshDesignSite(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function checkDesignBuildAction(projectId: string, slugs: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await checkDesignBuild(await getServiceContext(), current, projectId, slugs);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startE2eCheckAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startE2eCheck(await getServiceContext(), current);
    revalidatePath("/admin/system");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof E2eCheckError ? error.message : messageFor(error) };
  }
}

export async function decideSuggestionAction(projectId: string, findingId: string, decision: "accepted" | "rejected"): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await decideSuggestion(await getServiceContext(), current, projectId, findingId, decision);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function decideOpenSuggestionsAction(projectId: string, decision: "accepted" | "rejected"): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await decideOpenSuggestions(await getServiceContext(), current, projectId, decision);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function skipDesignReviewAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await skipDesignReview(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function undoKitRepairAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await undoKitRepair(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startSeoSuggestAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startSeoSuggest(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function approveSeoAction(projectId: string, pageId: string, values: SeoValues): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await approveSeo(await getServiceContext(), current, projectId, pageId, values);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function saveSiteVideosAction(projectId: string, text: string): Promise<{ ok: true; saved: number; rejected: string[] } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const result = await saveSiteVideos(await getServiceContext(), current, projectId, text);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startSiteTidyAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startSiteTidy(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function saveLinkRulesAction(projectId: string, choices: { words: string; to: string }[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await saveLinkRules(await getServiceContext(), current, projectId, choices);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function renameDesignPagesAction(projectId: string, pages: { id: string; name: string; slug: string }[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await renameDesignPages(await getServiceContext(), current, projectId, pages);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startPhonesByCodeAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startPhonesByCode(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function decideMobileAction(projectId: string, copyId: string, input: { decision: "accepted" | "pushed_back"; note: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await decideMobile(await getServiceContext(), current, projectId, copyId, input);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function approveExactDesignAction(projectId: string, input: { channel: string; clientSaid: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await approveExactDesign(await getServiceContext(), current, projectId, input);
    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}/build`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function acceptCopyAction(projectId: string, copyId: string, note: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await acceptCopy(await getServiceContext(), current, projectId, copyId, note);
    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}/mockups/design/copy`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function fillFromTemplatesAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await fillFromTemplates(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function repairCopiesAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await repairCopies(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startStyleKitAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startStyleKit(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setKitFontAction(projectId: string, role: string, family: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    if (!["script", "display", "serif", "sans"].includes(role)) return { ok: false, message: "That kind of lettering isn't in the kit." };
    await setKitFont(await getServiceContext(), current, projectId, role as "script" | "display" | "serif" | "sans", family);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function replayCopyAction(projectId: string, copyId: string): Promise<{ ok: true; copyId: string } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const id = await replayCopy(await getServiceContext(), current, projectId, copyId);
    revalidatePath(`/projects/${projectId}/mockups`);
    revalidatePath(`/projects/${projectId}/mockups/design/copy`);
    return { ok: true, copyId: id };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startExactCopiesAction(projectId: string, frameIds?: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startExactCopies(await getServiceContext(), current, projectId, frameIds);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function markLawCheckedAction(key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await markLawChecked(await getServiceContext(), current, key);
    revalidatePath("/admin/privacy-laws");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function recordPrivacyReviewAction(note: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await recordPrivacyReview(await getServiceContext(), current, note);
    revalidatePath("/admin/privacy-laws");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Build B on 20i (admins, 5 October 2026) ---------- */

async function twentyiAction(run: (ctx: Awaited<ReturnType<typeof getServiceContext>>, current: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await run(await getServiceContext(), current);
    revalidatePath("/admin/system");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function makeTwentyiKeyAction(replace: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  return twentyiAction((ctx, current) => makeTwentyiKey(ctx, current, replace));
}

export async function startTwentyiCheckAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  return twentyiAction((ctx, current) => startTwentyiCheck(ctx, current));
}

export async function choosePackageTypeAction(typeId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  return twentyiAction((ctx, current) => choosePackageType(ctx, current, typeId));
}

export async function chooseCertPathAction(path: string): Promise<{ ok: true } | { ok: false; message: string }> {
  return twentyiAction((ctx, current) => chooseCertPath(ctx, current, path));
}

export async function forgetServerKeyAction(host: string): Promise<{ ok: true } | { ok: false; message: string }> {
  return twentyiAction((ctx, current) => forgetServerKey(ctx, current, host));
}

/* Stop running work (28 September 2026): the running part ends before its next AI call; waiting parts don't start. */
export async function stopWorkAction(projectId: string, kind: string, copyId: string | null): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await stopWork(await getServiceContext(), current, projectId, kind, copyId);
    revalidatePath(`/projects/${projectId}`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* A test project's AI cap (admins, logged; 28 September 2026). */
export async function setProjectCapAction(projectId: string, input: { isTest: boolean; capDollars: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await setProjectCap(await getServiceContext(), current, projectId, input);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The model an AI step runs on (admins, logged). */
export async function saveStepModelAction(step: string, model: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await saveStepModel(await getServiceContext(), current, step, model);
    revalidatePath("/admin/spend");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Build B, 4b: where the site lives (PMs and admins; locked once live). */
export async function setHostingAction(projectId: string, hosting: Hosting): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await setHosting(await getServiceContext(), current, projectId, hosting);
    revalidatePath(`/projects/${projectId}/build`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* F3, Connect the domain. */
async function connectStep(projectId: string, work: (ctx: Awaited<ReturnType<typeof getServiceContext>>, viewer: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await work(await getServiceContext(), current);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function detectDomainAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => detectDomain(ctx, viewer, projectId));
}

export async function choosePathAction(projectId: string, path: "records" | "access" | "vml_dns") {
  return connectStep(projectId, (ctx, viewer) => choosePath(ctx, viewer, projectId, path));
}

export async function checkRecordsAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => checkRecords(ctx, viewer, projectId, "pm"));
}

export async function makeClientLinkAction(projectId: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const url = await makeClientLink(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true, url };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* F4: proving form messages keep arriving (System, Email delivery). */
async function systemStep(work: (ctx: Awaited<ReturnType<typeof getServiceContext>>, viewer: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await work(await getServiceContext(), current);
    revalidatePath("/admin/system");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function saveInboxesAction(text: string) {
  return systemStep((ctx, viewer) => saveInboxes(ctx, viewer, text));
}

export async function sendLabTestAction() {
  return systemStep((ctx, viewer) => sendLabTest(ctx, viewer));
}

export async function startSpeedCheckAction(projectId: string, target: SpeedTarget): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startSpeedCheck(await getServiceContext(), current, projectId, target);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function overrideSpeedAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await overrideSpeed(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function checkPreviewFormAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await checkPreviewForm(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function checkAllSitesAction() {
  return systemStep((ctx, viewer) => checkAllSites(ctx, viewer));
}

/* B3: a WordPress site's go-live (on 20i since 5 October 2026). */
export async function attachWpDomainAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => attachWpDomain(ctx, viewer, projectId));
}

export async function checkWpHttpsAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => checkWpHttps(ctx, viewer, projectId));
}

export async function requestWpCertificateAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => requestWpCertificate(ctx, viewer, projectId));
}

export async function confirmPaidCertificateAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => confirmPaidCertificate(ctx, viewer, projectId));
}

export async function wpGoLiveAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => wpGoLive(ctx, viewer, projectId));
}

export async function wpRollbackAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => wpRollback(ctx, viewer, projectId));
}

export async function wpUndoRollbackAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => wpUndoRollback(ctx, viewer, projectId));
}

/* F2: form messages through TAWD. */
export async function sendTestMessagesAction(projectId: string) {
  return connectStep(projectId, (ctx, viewer) => sendTestMessages(ctx, viewer, projectId));
}

export async function resendFormMessageAction(projectId: string, messageId: string) {
  return connectStep(projectId, (ctx, viewer) => resendMessage(ctx, viewer, projectId, messageId));
}

export async function viewFormMessageAction(
  projectId: string,
  messageId: string,
): Promise<{ ok: true; message: { fields: { label: string; value: string }[]; files: { name: string; url: string }[] } } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const m = await viewMessage(await getServiceContext(), current, projectId, messageId);
    return { ok: true, message: { fields: m.fields, files: m.files } };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Build B, B2: the WordPress preview (on 20i since 5 October 2026). */
export async function wpPreviewAction(
  projectId: string,
  what: "deploy" | "remove" | "https" | "preview_cert" | "confirm_limit" | "suspend" | "restore" | "purge",
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    if (what === "deploy") await startWpPreview(ctx, current, projectId);
    else if (what === "remove") await removeWpPreview(ctx, current, projectId);
    else if (what === "preview_cert") await requestPreviewCertificate(ctx, current, projectId);
    else if (what === "confirm_limit") await confirmPackageLimit(ctx, current, projectId);
    else if (what === "suspend" || what === "restore") await setWpSuspended(ctx, current, projectId, what === "suspend");
    else if (what === "purge") await purgeWpCache(ctx, current, projectId);
    else await checkWpPreviewHttps(ctx, current, projectId);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function showWpLoginAction(projectId: string): Promise<{ ok: true; login: { url: string; user: string; password: string } } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    return { ok: true, login: await showWpLogin(await getServiceContext(), current, projectId) };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setFormPluginAction(projectId: string, formPlugin: FormPlugin): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await setFormPlugin(await getServiceContext(), current, projectId, formPlugin);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startDesignUploadAction(projectId: string, all = false, pages?: number[]): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startDesignUpload(await getServiceContext(), current, projectId, { all, pages });
    revalidatePath(`/projects/${projectId}/intake`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* "Read it again" for the supplied homepage: after a failure, or when the first reading never started. Free (no AI). */
export async function readHomepageAgainAction(projectId: string, again = false): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await queueHtmlMockupImport(await getServiceContext(), current, projectId, { again });
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The new design read (E4, admin only while the new route is built beside the current one). */
export async function startNewDesignReadAction(projectId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startNewDesignRead(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

// E4b-2: an admin corrects a band of the new read (name, kind, edges); kept across re-reads of the same upload.
export async function correctReadBandAction(
  projectId: string,
  anchor: { top: number; bottom: number },
  change: BandChange,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await correctReadBand(await getServiceContext(), current, projectId, { anchor, change, runId });
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

// E4b-2b: an admin corrects a word the new read misread (its text, its kind); kept across re-reads.
export async function correctReadWordAction(
  projectId: string,
  anchor: { x: number; y: number; w: number; h: number },
  change: WordChange,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await correctReadWord(await getServiceContext(), current, projectId, { anchor, change, runId });
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

// E4b-2b: an admin corrects a picture's kind or its box; kept across re-reads, and used by the free prepare.
export async function correctReadPictureAction(
  projectId: string,
  anchor: { x: number; y: number; w: number; h: number },
  change: PictureChange,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await correctReadPicture(await getServiceContext(), current, projectId, { anchor, change, runId });
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

// E4b-2b: prepare a finished read's pictures again. Free: no AI call, so no estimate and no spend check.
export async function preparePicturesAgainAction(
  projectId: string,
  version: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await preparePicturesAgain(await getServiceContext(), current, projectId, version, runId);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

// E5a: build one page from a finished read. Paid: one call, its estimate shown before it starts.
export async function buildDesignPageAction(projectId: string, page = 1): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await startDesignPageBuild(await getServiceContext(), current, projectId, page);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Go-live (Phase 9, 28 September 2026) ---------- */

async function goLiveAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>, current: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await run(await getServiceContext(), current);
    revalidatePath(`/projects/${projectId}/build`);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function recordBuildFeePaidAction(projectId: string, input: { paidOn: string; method: string; note: string }) {
  return goLiveAction(projectId, (ctx, current) => recordBuildFeePaid(ctx, current, projectId, input));
}
export async function undoBuildFeePaidAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => undoBuildFeePaid(ctx, current, projectId));
}
export async function confirmDomainAction(projectId: string, input: { domain: string; registrar: string; registrant: string; inClientsName: boolean }) {
  return goLiveAction(projectId, (ctx, current) => confirmDomain(ctx, current, projectId, input));
}
export async function readEmailRecordsAction(projectId: string, selectors: string[]) {
  return goLiveAction(projectId, (ctx, current) => readEmailRecords(ctx, current, projectId, selectors));
}
export async function setUpCloudflareAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => setUpCloudflare(ctx, current, projectId));
}
export async function checkEmailRecordsAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => checkEmailRecords(ctx, current, projectId));
}
export async function confirmEmailRecordsAction(projectId: string, input: { confirmedWithProvider: boolean; note: string }) {
  return goLiveAction(projectId, (ctx, current) => confirmEmailRecords(ctx, current, projectId, input));
}
export async function attachNetlifyDomainAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => attachNetlifyDomain(ctx, current, projectId));
}
export async function checkRegistryAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => checkRegistry(ctx, current, projectId));
}
export async function checkNameserversAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => checkNameservers(ctx, current, projectId));
}
export async function checkHttpsAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => checkHttps(ctx, current, projectId));
}
export async function recordGa4Action(projectId: string, input: { propertyId: string; measurementId: string; vmlIsEditor: boolean }) {
  return goLiveAction(projectId, (ctx, current) => recordGa4(ctx, current, projectId, input));
}
export async function goLiveNowAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => goLiveNow(ctx, current, projectId));
}
export async function rollBackAction(projectId: string) {
  return goLiveAction(projectId, (ctx, current) => rollBack(ctx, current, projectId));
}

/* ---------- Slack (3d) ---------- */

type SimpleResult = { ok: true } | { ok: false; message: string };

async function slackAction(projectId: string, run: () => Promise<void>): Promise<SimpleResult> {
  try {
    await run();
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function connectSlackAction(projectId: string, webhookUrl: string): Promise<SimpleResult> {
  const current = await requireUser();
  return slackAction(projectId, async () =>
    connectSlack(await getServiceContext(), current, projectId, webhookUrl),
  );
}

export async function disconnectSlackAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return slackAction(projectId, async () => disconnectSlack(await getServiceContext(), current, projectId));
}

export async function setSlackCommentsAction(projectId: string, on: boolean): Promise<SimpleResult> {
  const current = await requireUser();
  return slackAction(projectId, async () =>
    setSlackComments(await getServiceContext(), current, projectId, on),
  );
}

export async function sendSlackTestAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const result = await sendSlackTest(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}`);
    return result;
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function rerunReviewAction(
  projectId: string,
  runId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    await rerunReview(await getServiceContext(), current, runId);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/** A five-minute link to a concept's rendered page or its source. */
export async function openConceptAssetAction(
  conceptId: string,
  kind: "png" | "html",
  version?: number,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const url = await getConceptAssetUrl(current, conceptId, kind, version);
    if (!url) {
      return { ok: false, message: "That file is not there yet." };
    }
    return { ok: true, url };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- deleting a project ---------- */

export async function deleteProjectAction(
  projectId: string,
  confirmName: string,
  reason: string,
): Promise<
  | { ok: true; clientName: string; filesRemoved: number }
  | { ok: false; message: string }
> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    const result = await deleteProject(ctx, current, projectId, {
      confirmName,
      reason,
    });
    revalidatePath("/projects");
    return { ok: true, clientName: result.clientName, filesRemoved: result.filesRemoved };
  } catch (error) {
    if (error instanceof ProjectDeleteError) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- spend ---------- */

export async function setMonthlyLimitAction(
  dollars: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await requireUser();

  try {
    const ctx = await getServiceContext();
    await setMonthlyLimit(ctx, current, dollars);
    revalidatePath("/admin/spend");
    return { ok: true };
  } catch (error) {
    if (error instanceof SpendError) return { ok: false, message: error.message };
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Lane 2, Option B: the Figma design ---------- */

async function figmaAction(projectId: string, run: () => Promise<unknown>): Promise<SimpleResult> {
  try {
    await run();
    revalidatePath(`/projects/${projectId}/intake`);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function saveFigmaLinkAction(projectId: string, link: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => saveFigmaLink(await getServiceContext(), current, projectId, link));
}

export async function recheckFigmaAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => recheckFigma(await getServiceContext(), current, projectId));
}

export async function chooseFigmaPageAction(projectId: string, pageId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => chooseFinalPage(await getServiceContext(), current, projectId, pageId));
}

export async function importFigmaAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => queueFigmaImport(await getServiceContext(), current, projectId));
}

export async function startDesignReviewAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => startDesignReview(await getServiceContext(), current, projectId));
}

export async function setFindingTickedAction(projectId: string, findingId: string, ticked: boolean): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    await setFindingTicked(await getServiceContext(), current, projectId, findingId, ticked);
    revalidatePath(`/projects/${projectId}/mockups/design`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function prefillIntakeAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => prefillIntakeFromDesign(await getServiceContext(), current, projectId));
}

export async function confirmPrefillAction(projectId: string, fieldKey: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => confirmPrefill(await getServiceContext(), current, projectId, fieldKey));
}

export async function setGroupTickedAction(
  projectId: string,
  grade: "must_fix" | "should_fix" | "confirm_fact",
  ticked: boolean,
): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    await setGroupTicked(await getServiceContext(), current, projectId, grade, ticked);
    revalidatePath(`/projects/${projectId}/mockups/design`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startDesignCopyAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => startDesignCopy(await getServiceContext(), current, projectId));
}

export async function startDesignImprovementAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => startDesignImprovement(await getServiceContext(), current, projectId));
}

/* ---------- forgot password ---------- */

/* "Forgot password?": always the same answer, so the form never says who has an account. */
export async function requestPasswordResetAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { fieldErrors: { email: ["Enter your email address"] } };
  const ctx = await getServiceContext();
  return { notice: await requestPasswordReset(ctx, await headers(), email) };
}

/* "Set a new password", from the emailed link. Same rules as choosing one. */
export async function resetPasswordAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const token = String(formData.get("token") ?? "");
  const parsed = z
    .object({ newPassword: passwordSchema, confirmPassword: z.string() })
    .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "The two passwords don't match" })
    .safeParse({ newPassword: formData.get("newPassword"), confirmPassword: formData.get("confirmPassword") });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  if (!token) return { error: "This link isn't complete. Ask for a new one." };
  const ctx = await getServiceContext();
  const ok = await resetPasswordWithLink(ctx, token, parsed.data.newPassword);
  if (!ok) return { error: "This link has expired or has already been used. Ask for a new one." };
  redirect("/login?reset=1");
}

/* ---------- email ---------- */

/* "Send a test email" on the Team page: admins only, to their own address. */
export async function sendTestEmailAction(): Promise<{ ok: boolean; message: string }> {
  const current = await requireUser();
  if (!can(current, "user.manage")) return { ok: false, message: "Only admins can send a test email." };
  return sendTestEmail(getDb(), current.email);
}

/* ---------- the designer's decisions (4c-2) ---------- */

export async function setChangeDecisionAction(
  projectId: string,
  changeNumber: number,
  decision: "accepted" | "pushed_back" | null,
  note: string,
): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () =>
    setChangeDecision(await getServiceContext(), current, projectId, changeNumber, decision, note),
  );
}

export async function startDecisionsVersionAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => startDecisionsVersion(await getServiceContext(), current, projectId));
}

/* Lane 2, Option B: one or two alternatives to the designer's design (4c-2b). */
export async function startAlternativesAction(projectId: string, count: number): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => startAlternatives(await getServiceContext(), current, projectId, count));
}

/* The final version of the designer's design on the concept board as Concept 1. */
export async function putDesignOnBoardAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () => putDesignOnBoard(await getServiceContext(), current, projectId));
}

/* "From the brand guide": the PM used or dismissed a suggestion. */
export async function answerBrandGuideSuggestionAction(
  projectId: string,
  readingId: string,
  key: string,
  outcome: "used" | "dismissed",
): Promise<SimpleResult> {
  const current = await requireUser();
  return figmaAction(projectId, async () =>
    answerBrandGuideSuggestion(await getServiceContext(), current, projectId, readingId, key, outcome),
  );
}

/* ---------- pricing and revenue (admins) ---------- */

async function pricingAction(paths: string[], run: (ctx: Awaited<ReturnType<typeof getServiceContext>>) => Promise<unknown>): Promise<SimpleResult> {
  try {
    const ctx = await getServiceContext();
    await run(ctx);
    for (const path of [...paths, "/admin/pricing", "/admin/revenue"]) revalidatePath(path);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function savePackageAction(input: { key: string | null; name: string; buildFee: string; monthlyFee: string }): Promise<SimpleResult> {
  const current = await requireUser();
  return pricingAction([], (ctx) => savePackage(ctx, current, input));
}

export async function setProjectPriceAction(
  projectId: string,
  input: { packageKey: string; buildFee: string; monthlyFee: string; reason: string },
): Promise<SimpleResult> {
  const current = await requireUser();
  return pricingAction([`/projects/${projectId}`], (ctx) => setProjectPrice(ctx, current, projectId, input));
}

export async function setProjectCancelledAction(projectId: string, input: { on: string; reason: string } | null): Promise<SimpleResult> {
  const current = await requireUser();
  return pricingAction([`/projects/${projectId}`], (ctx) => setProjectCancelled(ctx, current, projectId, input));
}

/* ---------- SEO and content, 7a: keyword research and the page plan ---------- */

async function contentAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>) => Promise<unknown>): Promise<SimpleResult> {
  try {
    const ctx = await getServiceContext();
    await run(ctx);
    revalidatePath(`/projects/${projectId}/content`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startKeywordResearchAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => startKeywordResearch(ctx, current, projectId));
}

export async function makePagePlanAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => makePagePlan(ctx, current, projectId));
}

export async function savePlanPageAction(projectId: string, pageId: string | null, input: PlanPageInput): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => savePlanPage(ctx, current, projectId, pageId, input));
}

export async function removePlanPageAction(projectId: string, pageId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => removePlanPage(ctx, current, projectId, pageId));
}

export async function movePlanPageAction(projectId: string, pageId: string, direction: "up" | "down"): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => movePlanPage(ctx, current, projectId, pageId, direction));
}

/* A blocked-site route's monthly cap (Jina Reader, Zyte): admins (settings.manage), logged. */
export async function setRouteCapAction(route: "jina" | "zyte", dollars: number): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    await setRouteCap(await getServiceContext(), current, route, dollars);
    revalidatePath("/admin/spend");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function setSeoLimitAction(dollars: number): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await setSeoLimit(ctx, current, dollars);
    revalidatePath("/admin/spend");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- 7b: page drafts and the content review ---------- */

export async function startDraftsAction(projectId: string, pageIds?: string[], direction?: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => startDrafts(ctx, current, projectId, { pageIds, direction }));
}

export async function requestRedraftAction(projectId: string, pageId: string, note: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => requestRedraft(ctx, current, projectId, pageId, note));
}

/* Design + content (0.100.0): improve these pages' words from the current site's (paid; Home first). */
export async function startImproveAction(projectId: string, pageIds: string[]): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => startImprove(ctx, current, projectId, { pageIds }));
}

/* Prepare the content (0.100.0): keyword research, the plan and the Home page's draft, in order, from one consent. */
export async function prepareContentAction(projectId: string, keywords: boolean): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => prepareContent(ctx, current, projectId, { keywords }));
}

/* Put a page back to the current site's words (free). */
export async function revertToKeptAction(projectId: string, pageId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => revertToKept(ctx, current, projectId, pageId));
}

export async function saveDraftEditAction(projectId: string, pageId: string, body: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => saveDraftEdit(ctx, current, projectId, pageId, body));
}

export async function approvePageAction(projectId: string, pageId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => approvePage(ctx, current, projectId, pageId));
}

export async function addPageCommentAction(projectId: string, pageId: string, body: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => addPageComment(ctx, current, projectId, pageId, body));
}

export async function resolvePageCommentAction(projectId: string, commentId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => resolvePageComment(ctx, current, projectId, commentId));
}

export async function checkAiWritingAction(projectId: string, pageId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => checkAiWriting(ctx, current, projectId, pageId));
}

export async function recordCopyDecisionAction(
  projectId: string,
  input: { outcome: "approved" | "changes_requested"; channel: string; clientSaid: string },
): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => recordCopyDecision(ctx, current, projectId, input));
}

/* ---------- Build A, 8a: the site ---------- */

/* Staged builds (6 October 2026): the next stage, every remaining page, or the whole site again; an exact Lane 2 build (admins) as before. */
export async function startSiteBuildAction(projectId: string, which: "next" | "remaining" | "whole" = "next"): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    if ((await siteReadiness(ctx.db, projectId)).exact) await startSiteBuild(ctx, current, projectId);
    else await startStageBuild(ctx, current, projectId, which);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startSpeedUpAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    await startSpeedUp(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/build`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Build A, 8b: preview deploys ---------- */

async function buildAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>) => Promise<unknown>): Promise<SimpleResult> {
  try {
    const ctx = await getServiceContext();
    await run(ctx);
    // The Build page and, since 1 October 2026, Updates.
    revalidatePath(`/projects/${projectId}`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function deployPreviewAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => deployPreview(ctx, current, projectId));
}

export async function recordPreviewDecisionAction(
  projectId: string,
  input: { outcome: "approved" | "changes_requested"; channel: string; clientSaid: string },
): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => recordPreviewDecision(ctx, current, projectId, input));
}

/* Pause a project with a reason (30 September 2026). PM or admin; logged. */
export async function pauseProjectAction(projectId: string, reason: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await pauseProject(ctx, current, projectId, reason);
    revalidatePath(`/projects/${projectId}`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* Resume a paused project (29 September 2026): back to the stage it was paused at. PM or admin; logged. */
export async function resumeProjectAction(projectId: string, note: string | null): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await resumeProject(ctx, current, projectId, note);
    revalidatePath(`/projects/${projectId}`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function moveToBuildAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await moveToBuild(ctx, current, projectId);
    revalidatePath(`/projects/${projectId}`, "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Build A, 8c: monthly edits and dev hours ---------- */

export async function createEditRequestAction(
  projectId: string,
  input: { kind: "edit" | "quote"; clientWords: string; teamNote: string; requestedOn: string; pageIds: string[] },
): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => createEditRequest(ctx, current, projectId, input));
}

/* ---------- Content first, part 2 (1 October 2026): the Home page words ---------- */

export async function startHomeWordsAction(projectId: string, source: "current_site" | "client_copy"): Promise<SimpleResult> {
  const current = await requireUser();
  return designAction(projectId, (ctx) => startHomeWords(ctx, current, projectId, source));
}

export async function writeHomeWordsAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return designAction(projectId, (ctx) => writeHomeWords(ctx, current, projectId));
}

export async function approveHomeWordsAction(projectId: string, input: { sections: { name: string; words: string }[]; testimonials: { text: string; confirmed: boolean }[] }): Promise<SimpleResult> {
  const current = await requireUser();
  return designAction(projectId, (ctx) => approveHomeWords(ctx, current, projectId, input));
}

async function designAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>) => Promise<unknown>): Promise<SimpleResult> {
  try {
    const ctx = await getServiceContext();
    await run(ctx);
    revalidatePath(`/projects/${projectId}/mockups`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* A blocked site's paid read over $1: the go (Fable's review M6). */
export async function approvePaidReadAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    await approvePaidRead(await getServiceContext(), current, projectId);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* The current website, read again ($0, no AI): on Intake (intake.edit or content.plan). */
export async function readSiteAgainAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await readSiteAgain(ctx, current, projectId);
    revalidatePath(`/projects/${projectId}/intake`);
    revalidatePath(`/projects/${projectId}/content`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

/* ---------- Updates (1 October 2026) ---------- */

export async function logUpdateRequestAction(projectId: string, input: RequestInput): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => logUpdateRequest(ctx, current, projectId, input));
}

/* What logging the request would do (a quote, and why). Reads only. */
export async function previewUpdateRequestAction(projectId: string, input: { category: string; redesign: boolean; estimateHours: string }) {
  await requireUser();
  return previewRequest(getDb(), projectId, input);
}

export async function recordQuoteAnswerAction(projectId: string, quoteId: string, input: { outcome: "approved" | "declined"; channel: string; clientSaid: string }): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => recordQuoteAnswer(ctx, current, projectId, quoteId, input));
}

export async function saveInvoiceAction(projectId: string, month: string, lines: InvoiceLine[]): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => saveInvoice(ctx, current, projectId, month, lines));
}

export async function setIncludedHoursAction(tier: Tier, hours: string): Promise<SimpleResult> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    await setIncludedHours(ctx, current, tier, hours);
    revalidatePath("/admin/pricing");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startEditAction(projectId: string, requestId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => startEdit(ctx, current, projectId, requestId));
}

export async function rebuildWithEditAction(projectId: string, requestId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => rebuildWithEdit(ctx, current, projectId, requestId));
}

export async function closeEditRequestAction(projectId: string, requestId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => closeEditRequest(ctx, current, projectId, requestId));
}

export async function logDevTimeAction(projectId: string, input: { requestId: string | null; minutes: number; note: string; workedOn: string }): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => logDevTime(ctx, current, projectId, input));
}

/* ---------- add-ons, and the logo TAWD designs ---------- */

export async function saveAddonPriceAction(key: string, price: string): Promise<SimpleResult> {
  const current = await requireUser();
  return pricingAction([], (ctx) => saveAddonPrice(ctx, current, key, price));
}

async function logoAction(projectId: string, run: (ctx: Awaited<ReturnType<typeof getServiceContext>>) => Promise<unknown>): Promise<SimpleResult> {
  try {
    const ctx = await getServiceContext();
    await run(ctx);
    revalidatePath(`/projects/${projectId}/intake`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function startLogoDesignAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return logoAction(projectId, (ctx) => startLogoDesign(ctx, current, projectId));
}

export async function chooseLogoAction(projectId: string, designId: string, index: number): Promise<SimpleResult> {
  const current = await requireUser();
  return logoAction(projectId, (ctx) => chooseLogo(ctx, current, projectId, designId, index));
}

/* ---------- SEO audits of the current website ---------- */

/* Keep the current site: the one decision (replace a plan that has work with the site's pages), approve the kept pages. */
export async function replacePlanWithSiteAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => replacePlanWithSite(ctx, current, projectId));
}

export async function approveKeptPagesAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => approveKeptPages(ctx, current, projectId));
}

export async function startQuickCheckAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => startQuickCheck(ctx, current, projectId));
}

export async function countSitePagesAction(
  projectId: string,
): Promise<{ ok: true; pageCount: number; bandName: string; price: string | null } | { ok: false; message: string }> {
  const current = await requireUser();
  try {
    const ctx = await getServiceContext();
    const counted = await countSitePages(ctx, current, projectId);
    const price = can(current, "money.manage") ? (counted.quoted ? "quoted case by case" : counted.priceCents === null ? "price not set yet" : `$${(counted.priceCents / 100).toLocaleString("en-US")}`) : null;
    return { ok: true, pageCount: counted.pageCount, bandName: counted.bandName, price };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function addFullAuditAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => addFullAudit(ctx, current, projectId));
}

export async function startFullAuditAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => startFullAudit(ctx, current, projectId));
}

/* A page the audit suggests, added to the plan with its main keyword. */
export async function addSuggestedPageAction(projectId: string, name: string, mainKeyword: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) =>
    savePlanPage(ctx, current, projectId, null, { kind: "service", name, slug: "", mainKeyword, supportingKeywords: "", title: "", metaDescription: "", h1: name }),
  );
}

export async function saveRedirectAction(projectId: string, from: string, to: string): Promise<SimpleResult> {
  const current = await requireUser();
  return contentAction(projectId, (ctx) => saveRedirect(ctx, current, projectId, from, to));
}

/* ---------- the Senior SEO Manager's check before go-live ---------- */

export async function startSeoGoLiveCheckAction(projectId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => startSeoGoLiveCheck(ctx, current, projectId));
}

export async function applySafeFixesAction(projectId: string, checkId: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, async (ctx) => {
    await applySafeFixes(ctx, current, projectId, checkId);
    revalidatePath(`/projects/${projectId}/content`);
  });
}

export async function signOffSeoAction(projectId: string, checkId: string, note: string): Promise<SimpleResult> {
  const current = await requireUser();
  return buildAction(projectId, (ctx) => signOffSeo(ctx, current, projectId, checkId, note));
}

/* ---------- the team's Slack channel, on System (29 September 2026) ---------- */

async function teamSlackAction(run: () => Promise<void>): Promise<SimpleResult> {
  try {
    await run();
    revalidatePath("/admin/system");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageFor(error) };
  }
}

export async function connectTeamSlackAction(webhookUrl: string): Promise<SimpleResult> {
  const current = await requireUser();
  return teamSlackAction(async () => connectTeamSlack(await getServiceContext(), current, webhookUrl));
}

export async function copyProjectWebhookAction(): Promise<SimpleResult> {
  const current = await requireUser();
  return teamSlackAction(async () => copyProjectWebhook(await getServiceContext(), current));
}

export async function disconnectTeamSlackAction(): Promise<SimpleResult> {
  const current = await requireUser();
  return teamSlackAction(async () => disconnectTeamSlack(await getServiceContext(), current));
}
