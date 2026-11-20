import { and, desc, eq } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import { projectStatuses, type ProjectStatus } from "@tawd/core/enums";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { activityLog, goLive, project, user } from "@tawd/core/schema";
import { notifySlack } from "@/lib/slack-notify";
import type { ServiceContext } from "@/lib/users";

/*
  Pause and Resume project (Jason, 29-30 September 2026). A paused project was a dead
  end. A PM or an admin resumes it, and it goes back to the stage it was
  paused at, read from the activity log. Logged like any stage change.
*/

export class ResumeError extends Error {}

/* The stage it was at when it was paused, or null when the log doesn't say. */
export async function stageBeforePause(db: Database, projectId: string): Promise<ProjectStatus | null> {
  const rows = await db
    .select({ before: activityLog.valueBefore, after: activityLog.valueAfter })
    .from(activityLog)
    .where(and(eq(activityLog.entityType, "project"), eq(activityLog.entityId, projectId), eq(activityLog.action, "project.status_changed")))
    .orderBy(desc(activityLog.seq))
    .limit(20);
  for (const row of rows) {
    const to = (row.after as { status?: string } | null)?.status;
    const from = (row.before as { status?: string } | null)?.status;
    if (to === "paused") return from && from !== "paused" && (projectStatuses as readonly string[]).includes(from) ? (from as ProjectStatus) : null;
  }
  return null;
}

export interface ResumePlan {
  to: ProjectStatus;
  /** False when the log didn't say, and it goes back to Intake. */
  known: boolean;
}

export async function planResume(db: Database, projectId: string): Promise<ResumePlan> {
  const before = await stageBeforePause(db, projectId);
  if (before === "live") {
    // Live again only if it really went live.
    const [live] = await db.select({ at: goLive.wentLiveAt }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
    if (!live?.at) return { to: "build", known: true };
  }
  return before ? { to: before, known: true } : { to: "intake", known: false };
}

export async function resumeProject(ctx: ServiceContext, actor: Viewer, projectId: string, note: string | null = null): Promise<ProjectStatus> {
  assertCan(actor, "project.change_status");
  const [row] = await ctx.db.select({ status: project.status }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new ResumeError("That project no longer exists.");
  if (row.status !== "paused") throw new ResumeError("This project isn't paused.");
  const plan = await planResume(ctx.db, projectId);
  await ctx.db.update(project).set({ status: plan.to, updatedAt: new Date() }).where(eq(project.id, projectId));
  const said = note?.trim().slice(0, 1000) || null;
  await recordActivity(ctx.db, {
    action: "project.status_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { status: "paused" },
    valueAfter: { status: plan.to, resumed: true, ...(plan.known ? {} : { unknownStage: true }), ...(said ? { note: said } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  notifySlack(ctx.db, projectId, { kind: "stage_changed", from: "paused", to: plan.to });
  return plan.to;
}

/*
  Pause project (Jason, 30 September 2026): a PM or an admin pauses a
  project with a reason. The stages lock; work already running finishes.
  Logged like any stage change, with the reason; Resume takes it back.
*/
export const MIN_PAUSE_REASON = 10;

export async function pauseProject(ctx: ServiceContext, actor: Viewer, projectId: string, reason: string): Promise<void> {
  assertCan(actor, "project.change_status");
  const said = reason.trim();
  if (said.length < MIN_PAUSE_REASON) throw new ResumeError(`Say why it is paused (at least ${MIN_PAUSE_REASON} characters).`);
  const [row] = await ctx.db.select({ status: project.status }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new ResumeError("That project no longer exists.");
  if (row.status === "paused") throw new ResumeError("This project is already paused.");
  await ctx.db.update(project).set({ status: "paused", updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.status_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { status: row.status },
    valueAfter: { status: "paused", reason: said.slice(0, 1000) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  notifySlack(ctx.db, projectId, { kind: "stage_changed", from: row.status, to: "paused" });
}

/* Who paused it, when and why, for the Next step card; null when the log doesn't say. */
export async function lastPause(db: Database, projectId: string): Promise<{ by: string | null; at: Date; reason: string | null } | null> {
  const rows = await db
    .select({ after: activityLog.valueAfter, at: activityLog.occurredAt, by: user.name })
    .from(activityLog)
    .leftJoin(user, eq(user.id, activityLog.actorUserId))
    .where(and(eq(activityLog.entityType, "project"), eq(activityLog.entityId, projectId), eq(activityLog.action, "project.status_changed")))
    .orderBy(desc(activityLog.seq))
    .limit(20);
  const hit = rows.find((r) => (r.after as { status?: string } | null)?.status === "paused");
  if (!hit) return null;
  return { by: hit.by ?? null, at: hit.at, reason: (hit.after as { reason?: string }).reason ?? null };
}
