import { randomInt } from "node:crypto";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import {
  account,
  projectMember,
  session,
  user as userTable,
  userRole,
  verification,
} from "@tawd/core/schema";
import type { TeamRole } from "@tawd/core/schema";
import { forgetResetLinks } from "@/lib/password-reset";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Auth } from "@/lib/auth";
import type { ServiceContext as CoreServiceContext } from "@tawd/core/intake/service";
import { assertCan, type Viewer } from "@tawd/core/permissions";

/*
  The web app's context: core's, plus the auth instance that only the web
  app has. The worker uses core's directly.
*/
export interface ServiceContext extends CoreServiceContext {
  auth: Auth;
}

export interface TeamUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  isDisabled: boolean;
  mustChangePassword: boolean;
  roles: TeamRole[];
  createdAt: Date;
}

/*
  Temporary passwords are read off a screen and typed once, so the alphabet
  leaves out characters that look alike (zero and capital O, one and lowercase
  L). randomInt draws from the same source as the rest of the crypto here,
  not Math.random.
*/
const READABLE_ALPHABET =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTemporaryPassword(length = 20): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += READABLE_ALPHABET[randomInt(READABLE_ALPHABET.length)];
  }
  return out;
}

export async function listTeamUsers(db: Database): Promise<TeamUser[]> {
  // Deleted people are gone from the team; their history still names them.
  const rows = await db
    .select()
    .from(userTable)
    .where(isNull(userTable.deletedAt))
    .orderBy(asc(userTable.name));
  const roleRows = await db.select().from(userRole);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: row.role === "admin",
    isDisabled: row.banned === true,
    mustChangePassword: row.mustChangePassword,
    roles: roleRows
      .filter((r) => r.userId === row.id)
      .map((r) => r.role as TeamRole),
    createdAt: row.createdAt,
  }));
}

/** Active admins, used to stop the last one locking everybody out. */
async function countActiveAdmins(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userTable)
    .where(
      and(
        eq(userTable.role, "admin"),
        or(isNull(userTable.banned), eq(userTable.banned, false)),
      ),
    );
  return row?.count ?? 0;
}

export class UserManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserManagementError";
  }
}

export interface CreateTeamUserInput {
  name: string;
  email: string;
  isAdmin: boolean;
  roles: TeamRole[];
}

export async function createTeamUser(
  ctx: ServiceContext,
  actor: Viewer,
  input: CreateTeamUserInput,
): Promise<{ userId: string; temporaryPassword: string }> {
  assertCan(actor, "user.manage");

  const email = input.email.trim().toLowerCase();

  const [existing] = await ctx.db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);
  if (existing) {
    throw new UserManagementError("An account with that email already exists");
  }

  const temporaryPassword = generateTemporaryPassword();

  // Better Auth creates the user row and the hashed credential together.
  const created = await ctx.auth.api.createUser({
    body: {
      email,
      name: input.name.trim(),
      password: temporaryPassword,
      role: input.isAdmin ? "admin" : "user",
      data: { mustChangePassword: true },
    },
  });

  const userId = created.user.id;

  if (input.roles.length > 0) {
    await ctx.db
      .insert(userRole)
      .values(input.roles.map((role) => ({ userId, role })));
  }

  await recordActivity(ctx.db, {
    action: "user.created",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueAfter: {
      email,
      name: input.name.trim(),
      isAdmin: input.isAdmin,
      roles: input.roles,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return { userId, temporaryPassword };
}

export async function setUserDisabled(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
  disabled: boolean,
): Promise<void> {
  assertCan(actor, "user.manage");

  const [target] = await ctx.db
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!target) throw new UserManagementError("That account no longer exists");

  const wasDisabled = target.banned === true;
  if (wasDisabled === disabled) return;

  // Disabling yourself would sign you out mid-click with nobody to undo it.
  if (disabled && target.id === actor.id) {
    throw new UserManagementError(
      "You can't disable your own account. Ask another admin to do it.",
    );
  }

  if (
    disabled &&
    target.role === "admin" &&
    (await countActiveAdmins(ctx.db)) <= 1
  ) {
    throw new UserManagementError(
      "This is the last active admin. Make someone else an admin first.",
    );
  }

  await ctx.db
    .update(userTable)
    .set({ banned: disabled, updatedAt: new Date() })
    .where(eq(userTable.id, userId));

  // Disabling has to bite immediately, so existing sessions go too. Without
  // this the person stays signed in until their session happens to expire.
  // An unused "forgot password" link stops working too.
  if (disabled) {
    await ctx.db.delete(session).where(eq(session.userId, userId));
    await forgetResetLinks(ctx.db, userId);
  }

  await recordActivity(ctx.db, {
    action: disabled ? "user.disabled" : "user.enabled",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueBefore: { isDisabled: wasDisabled },
    valueAfter: { isDisabled: disabled },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setUserName(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
  name: string,
): Promise<void> {
  assertCan(actor, "user.manage");

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new UserManagementError("Enter a name.");
  }
  if (trimmed.length > 120) {
    throw new UserManagementError("That name is too long.");
  }

  const [target] = await ctx.db
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!target) throw new UserManagementError("That account no longer exists");
  if (target.name === trimmed) return;

  await ctx.db
    .update(userTable)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(eq(userTable.id, userId));

  await recordActivity(ctx.db, {
    action: "user.renamed",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueBefore: { name: target.name },
    valueAfter: { name: trimmed },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setUserRoles(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
  roles: TeamRole[],
): Promise<void> {
  assertCan(actor, "user.manage");

  const existing = await ctx.db
    .select({ role: userRole.role })
    .from(userRole)
    .where(eq(userRole.userId, userId));
  const before = existing.map((r) => r.role as TeamRole).sort();
  const after = [...new Set(roles)].sort();

  if (before.join(",") === after.join(",")) return;

  await ctx.db.delete(userRole).where(eq(userRole.userId, userId));
  if (after.length > 0) {
    await ctx.db
      .insert(userRole)
      .values(after.map((role) => ({ userId, role })));
  }

  await recordActivity(ctx.db, {
    action: "user.roles_changed",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueBefore: { roles: before },
    valueAfter: { roles: after },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setUserAdmin(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  assertCan(actor, "user.manage");

  const [target] = await ctx.db
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!target) throw new UserManagementError("That account no longer exists");

  const wasAdmin = target.role === "admin";
  if (wasAdmin === isAdmin) return;

  if (!isAdmin && (await countActiveAdmins(ctx.db)) <= 1) {
    throw new UserManagementError(
      "This is the last active admin. Make someone else an admin first.",
    );
  }

  await ctx.db
    .update(userTable)
    .set({ role: isAdmin ? "admin" : "user", updatedAt: new Date() })
    .where(eq(userTable.id, userId));

  await recordActivity(ctx.db, {
    action: "user.admin_changed",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueBefore: { isAdmin: wasAdmin },
    valueAfter: { isAdmin },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function resetUserPassword(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
): Promise<string> {
  assertCan(actor, "user.manage");

  const [target] = await ctx.db
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!target) throw new UserManagementError("That account no longer exists");

  const temporaryPassword = generateTemporaryPassword();
  const authContext = await ctx.auth.$context;
  const hashed = await authContext.password.hash(temporaryPassword);

  await ctx.db
    .update(account)
    .set({ password: hashed, updatedAt: new Date() })
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")));

  await ctx.db
    .update(userTable)
    .set({ mustChangePassword: true, updatedAt: new Date() })
    .where(eq(userTable.id, userId));

  // The old password is gone, so the old sessions should be too.
  await ctx.db.delete(session).where(eq(session.userId, userId));

  await recordActivity(ctx.db, {
    action: "user.password_reset",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    // Never the password itself, in the log or anywhere else.
    valueAfter: { mustChangePassword: true },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return temporaryPassword;
}

export const MIN_DELETE_REASON_LENGTH = 10;

/*
  Deleting a team member, for good. Admins only.

  The row itself stays: the activity log is append-only and points at it,
  and the database refuses to change the log. Everything else goes - the
  sign-in credential, every session, the team roles and project places -
  and the email is released so it can be used for a new account. The name
  is kept, so every entry they made still reads "(deleted user) Sam Lee".

  Guards: nobody deletes themselves, and the last active admin cannot be
  deleted. The name must be typed exactly, with a reason for the log.
*/
export async function deleteTeamUser(
  ctx: ServiceContext,
  actor: Viewer,
  userId: string,
  input: { confirmName: string; reason: string },
): Promise<void> {
  assertCan(actor, "user.manage");

  const [target] = await ctx.db
    .select()
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!target || target.deletedAt) {
    throw new UserManagementError("That account no longer exists");
  }

  if (target.id === actor.id) {
    throw new UserManagementError(
      "You can't delete your own account. Ask another admin to do it.",
    );
  }

  if (
    target.role === "admin" &&
    target.banned !== true &&
    (await countActiveAdmins(ctx.db)) <= 1
  ) {
    throw new UserManagementError(
      "This is the last active admin. Make someone else an admin first.",
    );
  }

  if (input.confirmName.trim() !== target.name) {
    throw new UserManagementError(
      `The name you typed does not match. Type "${target.name}" exactly to confirm.`,
    );
  }

  const reason = input.reason.trim();
  if (reason.length < MIN_DELETE_REASON_LENGTH) {
    throw new UserManagementError(
      `Give a reason of at least ${MIN_DELETE_REASON_LENGTH} characters. It is recorded in the activity log.`,
    );
  }

  const roles = await ctx.db
    .select({ role: userRole.role })
    .from(userRole)
    .where(eq(userRole.userId, userId));
  const places = await ctx.db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .where(eq(projectMember.userId, userId));

  await ctx.db.transaction(async (tx) => {
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    // Any unused "forgot password" link.
    await tx.delete(verification).where(eq(verification.value, userId));
    await tx.delete(userRole).where(eq(userRole.userId, userId));
    await tx.delete(projectMember).where(eq(projectMember.userId, userId));
    await tx
      .update(userTable)
      .set({
        deletedAt: new Date(),
        banned: true,
        role: "user",
        // Released for reuse; the log keeps the address it was recorded under.
        email: `deleted-${userId}@deleted.invalid`,
        image: null,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, userId));
  });

  await recordActivity(ctx.db, {
    action: "user.deleted",
    entityType: "user",
    entityId: userId,
    ...actorFields(actor),
    valueBefore: {
      name: target.name,
      email: target.email,
      isAdmin: target.role === "admin",
      roles: roles.map((r) => r.role),
      projects: places.length,
    },
    valueAfter: { reason },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/** Everyone's name by id, deleted people labeled, for history. */
export async function listPeopleNames(db: Database): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: userTable.id, name: userTable.name, deletedAt: userTable.deletedAt })
    .from(userTable);
  return new Map(rows.map((r) => [r.id, personLabel(r.name, r.deletedAt) ?? r.name]));
}

/** How a person is named in history: "(deleted user) Sam Lee" once deleted. */
export function personLabel(
  name: string | null,
  deletedAt: Date | null | undefined,
): string | null {
  if (!name) return null;
  return deletedAt ? `(deleted user) ${name}` : name;
}

/**
 * Someone changing their own password, including the forced change on first
 * sign-in. Better Auth verifies the current password before accepting.
 */
export async function changeOwnPassword(
  ctx: ServiceContext,
  actor: Viewer,
  headers: Headers,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await ctx.auth.api.changePassword({
    body: { currentPassword, newPassword, revokeOtherSessions: true },
    headers,
  });

  await ctx.db
    .update(userTable)
    .set({ mustChangePassword: false, updatedAt: new Date() })
    .where(eq(userTable.id, actor.id));

  await recordActivity(ctx.db, {
    action: "user.password_changed",
    entityType: "user",
    entityId: actor.id,
    ...actorFields(actor),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
