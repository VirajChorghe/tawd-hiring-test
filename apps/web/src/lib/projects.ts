import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import {
  activityLog,
  concept,
  deletedProject,
  goLive,
  mockupRun,
  project,
  projectMember,
  user as userTable,
  userRole,
} from "@tawd/core/schema";
import type {
  Lane,
  LaneOption,
  ProjectStatus,
  TeamRole,
  Tier,
  Trade,
} from "@tawd/core/enums";
import { SYSTEM_ACTOR_ID, actorFields, recordActivity } from "@tawd/core/activity";
import { assessCompleteness } from "@tawd/core/intake";
import {
  describeGateRefusal,
  evaluateGate,
  isLeavingIntake,
} from "@tawd/core/intake";
import { emptyIntake } from "@tawd/core/intake";
import { loadIntake } from "@tawd/core/intake/service";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { ProjectInput } from "@/lib/validation";
import { notifySlack } from "@/lib/slack-notify";
import { personLabel } from "@/lib/users";
import { alias } from "drizzle-orm/pg-core";

// The person an entry is about, as opposed to the person who acted.
const targetUser = alias(userTable, "target_user");
import type { ServiceContext } from "@/lib/users";
import { priceSnapshot } from "@/lib/pricing";
import { connectTeamSlackToProject } from "@/lib/team-slack";

export interface ProjectSummary {
  id: string;
  clientName: string;
  trade: Trade;
  tier: Tier;
  lane: Lane;
  laneOption: LaneOption | null;
  conceptCount: number | null;
  /** The concepts the latest run built (shown and held), once a run exists (8 October 2026). */
  conceptsBuilt?: number | null;
  status: ProjectStatus;
  /** When it first went live (never cleared): such a project is never deleted. */
  liveAt: Date | null;
  updatedAt: Date;
  members: ProjectMemberSummary[];
}

export interface ProjectMemberSummary {
  id: string;
  name: string;
  roles: TeamRole[];
}

function toSummary(
  row: typeof project.$inferSelect,
  members: ProjectMemberSummary[],
): ProjectSummary {
  return {
    id: row.id,
    clientName: row.clientName,
    trade: row.trade as Trade,
    tier: row.tier as Tier,
    lane: row.lane as Lane,
    laneOption: (row.laneOption as LaneOption | null) ?? null,
    conceptCount: row.conceptCount,
    status: row.status as ProjectStatus,
    liveAt: row.liveAt,
    updatedAt: row.updatedAt,
    members,
  };
}

async function membersFor(
  db: Database,
  projectIds: string[],
): Promise<Map<string, ProjectMemberSummary[]>> {
  const map = new Map<string, ProjectMemberSummary[]>();
  if (projectIds.length === 0) return map;

  const rows = await db
    .select({
      projectId: projectMember.projectId,
      userId: userTable.id,
      name: userTable.name,
    })
    .from(projectMember)
    .innerJoin(userTable, eq(userTable.id, projectMember.userId))
    .where(inArray(projectMember.projectId, projectIds));

  const userIds = [...new Set(rows.map((row) => row.userId))];
  const roleRows =
    userIds.length === 0
      ? []
      : await db
          .select({ userId: userRole.userId, role: userRole.role })
          .from(userRole)
          .where(inArray(userRole.userId, userIds));

  for (const row of rows) {
    const list = map.get(row.projectId) ?? [];
    list.push({
      id: row.userId,
      name: row.name,
      roles: roleRows
        .filter((r) => r.userId === row.userId)
        .map((r) => r.role as TeamRole),
    });
    map.set(row.projectId, list);
  }
  return map;
}

export async function listProjects(
  db: Database,
  viewer: Viewer,
): Promise<ProjectSummary[]> {
  assertCan(viewer, "project.view");

  const rows = await db.select().from(project).orderBy(desc(project.updatedAt));
  const members = await membersFor(
    db,
    rows.map((r) => r.id),
  );

  return rows.map((row) => toSummary(row, members.get(row.id) ?? []));
}

export async function getProject(
  db: Database,
  viewer: Viewer,
  projectId: string,
): Promise<ProjectSummary | null> {
  assertCan(viewer, "project.view");

  const [row] = await db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) return null;

  const members = await membersFor(db, [row.id]);
  // The header's chip says what was built, not the number planned at creation (8 October 2026).
  const [latestRun] = await db.select({ id: mockupRun.id }).from(mockupRun).where(eq(mockupRun.projectId, row.id)).orderBy(desc(mockupRun.createdAt)).limit(1);
  const conceptsBuilt = latestRun
    ? (await db.select({ status: concept.status }).from(concept).where(eq(concept.runId, latestRun.id))).filter((c) => c.status === "ready" || c.status === "held").length
    : null;
  return { ...toSummary(row, members.get(row.id) ?? []), conceptsBuilt };
}

export interface TimelineEntry {
  seq: number;
  occurredAt: Date;
  action: string;
  actorName: string | null;
  actorEmail: string | null;
  valueBefore: unknown;
  valueAfter: unknown;
}

/** The project page's own slice of the activity log. */
export async function getProjectTimeline(
  db: Database,
  viewer: Viewer,
  projectId: string,
): Promise<TimelineEntry[]> {
  assertCan(viewer, "project.view");

  const rows = await db
    .select({
      seq: activityLog.seq,
      occurredAt: activityLog.occurredAt,
      action: activityLog.action,
      actorEmail: activityLog.actorEmail,
      actorName: userTable.name,
      actorDeletedAt: userTable.deletedAt,
      valueBefore: activityLog.valueBefore,
      valueAfter: activityLog.valueAfter,
    })
    .from(activityLog)
    .leftJoin(userTable, eq(userTable.id, activityLog.actorUserId))
    .where(
      and(
        eq(activityLog.entityType, "project"),
        eq(activityLog.entityId, projectId),
      ),
    )
    .orderBy(desc(activityLog.seq));

  return rows.map((row) => ({
    seq: row.seq,
    occurredAt: row.occurredAt,
    action: row.action,
    actorName: personLabel(row.actorName, row.actorDeletedAt),
    actorEmail: row.actorEmail,
    valueBefore: row.valueBefore,
    valueAfter: row.valueAfter,
  }));
}

/** The fields the log records, kept free of timestamps so diffs stay honest. */
function loggedShape(input: {
  clientName: string;
  trade: string;
  tier: string;
  lane: string;
  laneOption: string | null;
  conceptCount: number | null;
  status: string;
  memberUserIds: string[];
}) {
  return {
    clientName: input.clientName,
    trade: input.trade,
    tier: input.tier,
    lane: input.lane,
    laneOption: input.laneOption,
    conceptCount: input.conceptCount,
    status: input.status,
    memberUserIds: [...input.memberUserIds].sort(),
  };
}

export async function createProject(
  ctx: ServiceContext,
  actor: Viewer,
  input: ProjectInput,
  options: { teamSlack?: boolean } = {},
): Promise<string> {
  assertCan(actor, "project.create");

  // The project keeps the price its package had today, even if the price list changes later.
  const price = await priceSnapshot(ctx.db, input.tier);

  const [created] = await ctx.db
    .insert(project)
    .values({
      ...price,
      clientName: input.clientName,
      trade: input.trade,
      tier: input.tier,
      lane: input.lane,
      laneOption: input.laneOption,
      conceptCount: input.conceptCount,
      status: input.status,
      createdByUserId: actor.id === SYSTEM_ACTOR_ID ? null : actor.id,
    })
    .returning({ id: project.id });

  const projectId = created!.id;

  if (input.memberUserIds.length > 0) {
    await ctx.db
      .insert(projectMember)
      .values(input.memberUserIds.map((userId) => ({ projectId, userId })));
  }

  await recordActivity(ctx.db, {
    action: "project.created",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: loggedShape(input),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  // Jason, 3 November 2026: a new project posts to the team's Slack channel from the start (changeable on the project).
  if (options.teamSlack !== false) await connectTeamSlackToProject(ctx, actor, projectId);

  return projectId;
}

export class GateError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "GateError";
    this.missing = missing;
  }
}

export async function updateProject(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: ProjectInput,
  options: {
    /** "Continue without these": move on with required items missing. */
    continueWithoutMissing?: boolean;
    note?: string | null;
    /** Older name for the note; passing one also means continuing. */
    overrideReason?: string | null;
  } = {},
): Promise<void> {
  assertCan(actor, "project.edit");

  const [existing] = await ctx.db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!existing) throw new Error("That project no longer exists");

  const existingMembers = await ctx.db
    .select({ userId: projectMember.userId })
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId));

  const before = loggedShape({
    clientName: existing.clientName,
    trade: existing.trade,
    tier: existing.tier,
    lane: existing.lane,
    laneOption: existing.laneOption,
    conceptCount: existing.conceptCount,
    status: existing.status,
    memberUserIds: existingMembers.map((m) => m.userId),
  });
  const after = loggedShape(input);

  const statusChanged = before.status !== after.status;
  const membersChanged =
    before.memberUserIds.join(",") !== after.memberUserIds.join(",");

  /*
    The step out of Intake. Missing required answers are a warning: the
    person must choose "Continue without these", which is logged with what
    was missing, and the items show as placeholders on the concepts.
    Checked here rather than in the form so no other caller can route round
    it. See src/lib/intake/gate.ts.
  */
  let gateOverride: { reason: string; missing: string[] } | null = null;

  if (statusChanged && isLeavingIntake(before.status as ProjectStatus, after.status as ProjectStatus)) {
    const loaded = await loadIntake(ctx.db, actor, projectId);
    const completeness =
      loaded?.completeness ??
      assessCompleteness({
        projectTrade: existing.trade,
        intake: emptyIntake(),
        files: [],
      });

    const decision = evaluateGate({
      from: before.status as ProjectStatus,
      to: after.status as ProjectStatus,
      completeness,
      // An older caller passing a reason is choosing to continue too.
      continueWithoutMissing: Boolean(options.continueWithoutMissing) || options.overrideReason != null,
      note: options.note ?? options.overrideReason ?? null,
    });

    if (!decision.allowed) {
      throw new GateError(
        describeGateRefusal(decision),
        decision.reason === "incomplete"
          ? decision.missing.map((m) => m.label)
          : [],
      );
    }

    if (decision.overrideUsed) {
      gateOverride = {
        reason: decision.reason,
        missing: decision.missing.map((m) => m.label),
      };
    }
  }

  // Phase 9: a project becomes Live only through Go live on the Build page, which checks the gate and deploys.
  if (input.status === "live" && existing.status !== "live") {
    const [live] = await ctx.db.select({ at: goLive.wentLiveAt }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
    if (!live?.at) throw new GateError("A project goes live from the Build page: Go live checks the gate and puts the site on the client's domain.", []);
  }

  await ctx.db
    .update(project)
    .set({
      clientName: input.clientName,
      trade: input.trade,
      tier: input.tier,
      lane: input.lane,
      laneOption: input.laneOption,
      conceptCount: input.conceptCount,
      status: input.status,
      // Going Live counts as paid: the first time, the date is kept for revenue.
      ...(input.status === "live" && !existing.liveAt ? { liveAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(project.id, projectId));

  if (membersChanged) {
    assertCan(actor, "project.assign_members");
    await ctx.db
      .delete(projectMember)
      .where(eq(projectMember.projectId, projectId));
    if (input.memberUserIds.length > 0) {
      await ctx.db
        .insert(projectMember)
        .values(input.memberUserIds.map((userId) => ({ projectId, userId })));
    }
  }

  /*
    A status change gets its own entry as well as the general edit, because
    "who moved this to Live and when" is the question people actually ask of
    the log. Both entries carry the same before and after values.
  */
  /*
    Recorded before the status change itself, so reading the log top to
    bottom shows the override and then what it allowed. The reason and the
    exact list of what was missing are both kept: later on the question is
    always "what did we skip", not merely "was something skipped".
  */
  if (gateOverride) {
    await recordActivity(ctx.db, {
      action: "project.gate_overridden",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueBefore: { status: before.status, missing: gateOverride.missing },
      valueAfter: { status: after.status, reason: gateOverride.reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  if (statusChanged) {
    assertCan(actor, "project.change_status");
    await recordActivity(ctx.db, {
      action: "project.status_changed",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueBefore: { status: before.status },
      valueAfter: { status: after.status },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    // Going live is a stage change too; Slack words it as "is live".
    notifySlack(ctx.db, projectId, {
      kind: "stage_changed",
      from: String(before.status),
      to: String(after.status),
    });
  }

  if (membersChanged) {
    await recordActivity(ctx.db, {
      action: "project.members_changed",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueBefore: { memberUserIds: before.memberUserIds },
      valueAfter: { memberUserIds: after.memberUserIds },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  await recordActivity(ctx.db, {
    action: "project.updated",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: before,
    valueAfter: after,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface FullLogEntry extends TimelineEntry {
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  /** The project's client name, when the entry is about a project. */
  projectName?: string | null;
  /** The old name, when the project has since been deleted. */
  deletedProjectName?: string | null;
  /** For entries about a person: their name, "(deleted user) ..." if deleted. */
  userName?: string | null;
}

export interface ActivityFilters {
  /** A user id, or SYSTEM_ACTOR_ID for entries with no signed-in person. */
  actorUserId?: string;
  /** "mockups" for a whole group, or "mockups.run_started" for one action. */
  action?: string;
  projectId?: string;
  /** Inclusive dates, YYYY-MM-DD, read in Pacific time like the log shows. */
  from?: string;
  to?: string;
  /** Free text: person, action, project, or anything in the recorded values. */
  q?: string;
  /** Action keys whose display label matches q, worked out by the caller. */
  actionsMatchingQ?: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/*
  Filters for the activity log.

  Every value arrives from a query string, so each one is used only as a
  bound parameter, never spliced into SQL. Dates are read as whole days in
  Pacific time, which is the time the log is displayed in.
*/
function activityConditions(filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.actorUserId === SYSTEM_ACTOR_ID) {
    conditions.push(isNull(activityLog.actorUserId));
  } else if (filters.actorUserId) {
    conditions.push(eq(activityLog.actorUserId, filters.actorUserId));
  }

  if (filters.action) {
    conditions.push(
      filters.action.includes(".")
        ? eq(activityLog.action, filters.action)
        : or(
            eq(activityLog.action, filters.action),
            like(activityLog.action, `${filters.action.replace(/[%_\\]/g, "")}.%`),
          )!,
    );
  }

  if (filters.projectId) {
    conditions.push(
      and(
        eq(activityLog.entityType, "project"),
        eq(activityLog.entityId, filters.projectId),
      )!,
    );
  }

  if (filters.from && DATE_ONLY.test(filters.from)) {
    conditions.push(
      sql`${activityLog.occurredAt} >= (${filters.from}::date::timestamp at time zone 'America/Los_Angeles')`,
    );
  }
  if (filters.to && DATE_ONLY.test(filters.to)) {
    conditions.push(
      sql`${activityLog.occurredAt} < ((${filters.to}::date + 1)::timestamp at time zone 'America/Los_Angeles')`,
    );
  }

  const q = filters.q?.trim();
  if (q) {
    // Escape LIKE's own wildcards so "50%" searches for "50%".
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const matches: SQL[] = [
      ilike(activityLog.actorEmail, pattern),
      ilike(userTable.name, pattern),
      ilike(activityLog.action, pattern),
      ilike(activityLog.entityId, pattern),
      ilike(project.clientName, pattern),
      ilike(deletedProject.clientName, pattern),
      sql`${activityLog.valueBefore}::text ilike ${pattern}`,
      sql`${activityLog.valueAfter}::text ilike ${pattern}`,
    ];
    if (filters.actionsMatchingQ && filters.actionsMatchingQ.length > 0) {
      matches.push(inArray(activityLog.action, filters.actionsMatchingQ));
    }
    conditions.push(or(...matches)!);
  }

  return conditions;
}

export async function listFullActivityLog(
  db: Database,
  viewer: Viewer,
  limit = 200,
  filters: ActivityFilters = {},
): Promise<FullLogEntry[]> {
  assertCan(viewer, "activity.view_all");

  const conditions = activityConditions(filters);

  const rows = await db
    .select({
      seq: activityLog.seq,
      occurredAt: activityLog.occurredAt,
      action: activityLog.action,
      entityType: activityLog.entityType,
      entityId: activityLog.entityId,
      actorEmail: activityLog.actorEmail,
      actorName: userTable.name,
      actorDeletedAt: userTable.deletedAt,
      targetName: targetUser.name,
      targetDeletedAt: targetUser.deletedAt,
      valueBefore: activityLog.valueBefore,
      valueAfter: activityLog.valueAfter,
      ipAddress: activityLog.ipAddress,
      projectName: project.clientName,
      deletedProjectName: deletedProject.clientName,
    })
    .from(activityLog)
    .leftJoin(userTable, eq(userTable.id, activityLog.actorUserId))
    // For entries about a person: who they were about, by name.
    .leftJoin(
      targetUser,
      and(eq(activityLog.entityType, "user"), eq(activityLog.entityId, targetUser.id)),
    )
    // entity_id is text and holds user ids too, so compare as text.
    .leftJoin(
      project,
      and(
        eq(activityLog.entityType, "project"),
        eq(activityLog.entityId, sql`${project.id}::text`),
      ),
    )
    // A deleted project's entries stay, and still name it.
    .leftJoin(
      deletedProject,
      and(
        eq(activityLog.entityType, "project"),
        eq(activityLog.entityId, sql`${deletedProject.id}::text`),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.seq))
    .limit(limit);

  return rows.map(({ actorDeletedAt, targetName, targetDeletedAt, ...row }) => ({
    ...row,
    actorName: personLabel(row.actorName, actorDeletedAt),
    userName: personLabel(targetName, targetDeletedAt),
  }));
}

/** The people and projects the log's filters offer. */
export async function listActivityFilterOptions(
  db: Database,
  viewer: Viewer,
): Promise<{
  people: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}> {
  assertCan(viewer, "activity.view_all");

  const people = (
    await db
      .select({ id: userTable.id, name: userTable.name, deletedAt: userTable.deletedAt })
      .from(userTable)
      .orderBy(asc(userTable.name))
  ).map((p) => ({ id: p.id, name: personLabel(p.name, p.deletedAt) ?? p.name }));

  const live = await db
    .select({ id: project.id, name: project.clientName })
    .from(project)
    .orderBy(asc(project.clientName));

  // Deleted projects can still be filtered on: their history is kept.
  const deleted = await db
    .select({ id: deletedProject.id, name: deletedProject.clientName })
    .from(deletedProject)
    .orderBy(asc(deletedProject.clientName));

  return {
    people,
    projects: [
      ...live,
      ...deleted.map((p) => ({ id: p.id, name: `${p.name} (deleted)` })),
    ],
  };
}

/*
  People who can be put on a project: active accounts, with their team
  roles. Anyone already on the project stays in the list even if disabled
  since, so saving the form never silently drops them.
*/
export async function listAssignableUsers(
  db: Database,
  keepIds: string[] = [],
): Promise<{ id: string; name: string; email: string; roles: TeamRole[] }[]> {
  const people = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      banned: userTable.banned,
      deletedAt: userTable.deletedAt,
    })
    .from(userTable)
    .orderBy(asc(userTable.name));

  const roles = await db.select().from(userRole);

  return people
    .filter((p) => keepIds.includes(p.id) || (!p.banned && !p.deletedAt))
    .map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      roles: roles.filter((r) => r.userId === p.id).map((r) => r.role as TeamRole),
    }));
}
