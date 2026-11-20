import { and, eq } from "drizzle-orm";

import {
  designCopy,
  designImprovement,
  designReview,
  editRequest,
  figmaDesign,
  logoDesign,
  pageDraft,
  photoTextCheck,
  polishPass,
  seoAudit,
  seoGoLiveCheck,
  siteBuild,
  stopRequest,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { PermissionError, can, type Viewer } from "@tawd/core/permissions";
import { STOP_KINDS, copyStopKey, isStopKind, stopKey, type StopKind } from "@tawd/core/stops";
import { personLabel, type ServiceContext } from "@/lib/users";
import { user as userTable } from "@tawd/core/schema";

/*
  The Stop button (Jason, 28 September 2026). Stopping a kind of work on a
  project (or one copy):
  - records the stop, so a job already running ends before its next AI
    call (the worker checks in stepModel) and keeps what it finished;
  - marks every job of that kind still waiting in the queue as stopped, so
    nothing more starts;
  - logs it.
  Anyone who could start that kind of work can stop it.
*/

type Db = ServiceContext["db"];

export class StopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopError";
  }
}

function mayStop(actor: Viewer, kind: StopKind): boolean {
  if (can(actor, "project.edit")) return true;
  if (kind === "drafts") return can(actor, "content.plan");
  if (kind === "seo_audit" || kind === "seo_golive") return can(actor, "seo.research") || can(actor, "seo.signoff");
  if (kind === "design_review" || kind === "design_improve" || kind === "copies" || kind === "phone_versions") return can(actor, "design.decide");
  return false;
}

/* Marks the queued jobs of a kind as stopped; returns how many. Running ones end in the worker. */
async function stopWaiting(db: Db, kind: StopKind, projectId: string, copyId: string | null, reason: string): Promise<number> {
  const now = new Date();
  const count = (rows: unknown[]) => rows.length;
  switch (kind) {
    /*
      E5a: the build's own status lives in storage, not in a table, so there
      is no waiting row here to mark. The stop is still real: the worker
      calls stepModel before the one AI call, and stepModel ends a stopped
      job there, before anything is paid for.
    */
    case "design_page":
      return 0;
    case "design_read":
      return count(await db.update(figmaDesign).set({ importStatus: "failed", importFailure: reason, importProgress: null }).where(and(eq(figmaDesign.projectId, projectId), eq(figmaDesign.importStatus, "queued"))).returning({ id: figmaDesign.projectId }));
    case "copies":
      return count(
        await db
          .update(designCopy)
          .set({ status: "failed", failureReason: reason, finishedAt: now })
          .where(and(eq(designCopy.projectId, projectId), eq(designCopy.status, "queued"), ...(copyId ? [eq(designCopy.id, copyId)] : [])))
          .returning({ id: designCopy.id }),
      );
    case "phone_versions":
      return count(await db.update(designCopy).set({ mobileStatus: "failed", mobileFailure: reason }).where(and(eq(designCopy.projectId, projectId), eq(designCopy.mobileStatus, "queued"))).returning({ id: designCopy.id }));
    case "drafts":
      return count(await db.update(pageDraft).set({ status: "failed", failureReason: reason, finishedAt: now }).where(and(eq(pageDraft.projectId, projectId), eq(pageDraft.status, "queued"))).returning({ id: pageDraft.id }));
    case "site_build":
      return count(await db.update(siteBuild).set({ status: "failed", step: null, failureReason: reason, finishedAt: now }).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "queued"))).returning({ id: siteBuild.id }));
    case "site_edit":
      return count(await db.update(editRequest).set({ status: "failed", failureReason: reason }).where(and(eq(editRequest.projectId, projectId), eq(editRequest.status, "queued"))).returning({ id: editRequest.id }));
    case "logo":
      return count(await db.update(logoDesign).set({ status: "failed", failureReason: reason, finishedAt: now }).where(and(eq(logoDesign.projectId, projectId), eq(logoDesign.status, "queued"))).returning({ id: logoDesign.id }));
    case "seo_audit":
      return count(await db.update(seoAudit).set({ status: "failed", step: null, failureReason: reason, finishedAt: now }).where(and(eq(seoAudit.projectId, projectId), eq(seoAudit.status, "queued"))).returning({ id: seoAudit.id }));
    case "seo_golive":
      return count(await db.update(seoGoLiveCheck).set({ status: "failed", failureReason: reason, finishedAt: now }).where(and(eq(seoGoLiveCheck.projectId, projectId), eq(seoGoLiveCheck.status, "queued"))).returning({ id: seoGoLiveCheck.id }));
    case "photo_text":
      return count(await db.update(photoTextCheck).set({ status: "failed", failureReason: reason.slice(0, 300), finishedAt: now }).where(and(eq(photoTextCheck.projectId, projectId), eq(photoTextCheck.status, "queued"))).returning({ id: photoTextCheck.id }));
    case "polish":
      return count(await db.update(polishPass).set({ status: "failed", failureReason: reason, finishedAt: now }).where(and(eq(polishPass.projectId, projectId), eq(polishPass.status, "queued"))).returning({ id: polishPass.id }));
    case "design_review":
      return count(await db.update(designReview).set({ status: "failed", failureReason: reason, finishedAt: now }).where(and(eq(designReview.projectId, projectId), eq(designReview.status, "queued"))).returning({ id: designReview.id }));
    case "design_improve":
      return count(await db.update(designImprovement).set({ status: "failed", detail: null, failureReason: reason, finishedAt: now }).where(and(eq(designImprovement.projectId, projectId), eq(designImprovement.status, "queued"))).returning({ id: designImprovement.id }));
    // The reference study's waiting sites and the mockup run's concepts end in the worker (the run's own Stop drops its queued concepts).
    case "reference_study":
    case "mockups":
    case "changes":
      return 0;
  }
}

export async function stopWork(ctx: ServiceContext, actor: Viewer, projectId: string, kind: string, copyId: string | null = null): Promise<{ waiting: number }> {
  if (!isStopKind(kind)) throw new StopError("That isn't work TAWD can stop.");
  if (!mayStop(actor, kind)) throw new PermissionError("project.edit");
  const key = copyId ? copyStopKey(copyId) : stopKey(kind, projectId);
  const now = new Date();
  await ctx.db
    .insert(stopRequest)
    .values({ key, projectId, requestedByUserId: actor.id, requestedAt: now })
    .onConflictDoUpdate({ target: stopRequest.key, set: { requestedByUserId: actor.id, requestedAt: now, projectId } });
  const [me] = await ctx.db.select({ name: userTable.name, deletedAt: userTable.deletedAt }).from(userTable).where(eq(userTable.id, actor.id)).limit(1);
  const who = me ? (personLabel(me.name, me.deletedAt) ?? "a team member") : "a team member";
  const waiting = await stopWaiting(ctx.db, kind, projectId, copyId, `Stopped by ${who} before it started.`);
  await recordActivity(ctx.db, {
    action: "work.stopped",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { what: STOP_KINDS[kind].label, ...(copyId ? { copyId } : {}), waitingStopped: waiting },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { waiting };
}

/* Used by the mockup run's own Stop too: a concept being built ends at its next AI call. */
export async function recordStop(db: Db, actorId: string, projectId: string, kind: StopKind): Promise<void> {
  const now = new Date();
  await db
    .insert(stopRequest)
    .values({ key: stopKey(kind, projectId), projectId, requestedByUserId: actorId, requestedAt: now })
    .onConflictDoUpdate({ target: stopRequest.key, set: { requestedByUserId: actorId, requestedAt: now } });
}

