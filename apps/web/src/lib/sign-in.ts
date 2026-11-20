import { and, eq, gte, sql } from "drizzle-orm";

import { account, loginAttempt, user as userTable } from "@tawd/core/schema";
import { recordActivity } from "@tawd/core/activity";
import type { ServiceContext } from "@/lib/users";

/*
  Signing in.

  Throttling lives here rather than relying only on Better Auth's rate
  limiter, because the rule needs to be ours to reason about and to test:
  five failures for one email address inside fifteen minutes locks that
  address for fifteen minutes.

  Two deliberate choices:

  - The throttle is keyed on the email address, not the IP. Everyone on the
    team shares an office connection, so locking an IP would lock the team.
  - Every failure returns the same message whether or not the account exists,
    so the form never reveals who has an account.
*/

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_WINDOW_MINUTES = 15;

// Worded as the approved Sign in design has it, lockout rule included.
export const GENERIC_FAILURE =
  "Email or password is incorrect. After 5 tries, sign-in pauses for 15 minutes.";
export const LOCKED_MESSAGE =
  "Too many tries. Sign-in is paused for 15 minutes for this email; try again after that.";

export type SignInResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string };

function windowStart(now: Date): Date {
  return new Date(now.getTime() - LOCKOUT_WINDOW_MINUTES * 60 * 1000);
}

export async function countRecentFailures(
  ctx: ServiceContext,
  email: string,
  now = new Date(),
): Promise<number> {
  /*
    Failures before the password last changed don't count: someone who was
    locked out and set a new password from the emailed link can sign in
    with it straight away.
  */
  const [changed] = await ctx.db
    .select({ at: account.updatedAt })
    .from(account)
    .innerJoin(userTable, eq(userTable.id, account.userId))
    .where(and(eq(userTable.email, email), eq(account.providerId, "credential")))
    .limit(1);
  const start = windowStart(now);
  const since = changed?.at && changed.at > start ? changed.at : start;
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempt)
    .where(
      and(
        eq(loginAttempt.email, email),
        eq(loginAttempt.succeeded, false),
        gte(loginAttempt.attemptedAt, since),
      ),
    );
  return row?.count ?? 0;
}

async function recordAttempt(
  ctx: ServiceContext,
  email: string,
  succeeded: boolean,
  now: Date,
): Promise<void> {
  await ctx.db.insert(loginAttempt).values({
    email,
    ipAddress: ctx.ipAddress,
    succeeded,
    attemptedAt: now,
  });
}

export async function signIn(
  ctx: ServiceContext,
  headers: Headers,
  rawEmail: string,
  password: string,
  now = new Date(),
): Promise<SignInResult> {
  const email = rawEmail.trim().toLowerCase();

  if ((await countRecentFailures(ctx, email, now)) >= MAX_FAILED_ATTEMPTS) {
    await recordActivity(ctx.db, {
      action: "login.failed",
      entityType: "session",
      actorEmail: email,
      valueAfter: { reason: "locked_out" },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      occurredAt: now,
    });
    return { ok: false, message: LOCKED_MESSAGE };
  }

  let signedInUserId: string | null = null;

  try {
    const result = await ctx.auth.api.signInEmail({
      body: { email, password },
      headers,
    });
    signedInUserId = result.user?.id ?? null;
  } catch {
    // Better Auth throws for a wrong password and for a disabled account
    // alike. Both are the same generic failure to the person typing.
    signedInUserId = null;
  }

  if (!signedInUserId) {
    await recordAttempt(ctx, email, false, now);

    const [existing] = await ctx.db
      .select({ id: userTable.id, banned: userTable.banned })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);

    await recordActivity(ctx.db, {
      action: "login.failed",
      entityType: "session",
      actorUserId: existing?.id ?? null,
      actorEmail: email,
      valueAfter: {
        reason: existing?.banned === true ? "account_disabled" : "bad_credentials",
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      occurredAt: now,
    });

    return { ok: false, message: GENERIC_FAILURE };
  }

  await recordAttempt(ctx, email, true, now);

  const [row] = await ctx.db
    .select({ mustChangePassword: userTable.mustChangePassword })
    .from(userTable)
    .where(eq(userTable.id, signedInUserId))
    .limit(1);

  await recordActivity(ctx.db, {
    action: "login.succeeded",
    entityType: "session",
    actorUserId: signedInUserId,
    actorEmail: email,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    occurredAt: now,
  });

  return {
    ok: true,
    redirectTo: row?.mustChangePassword ? "/change-password" : "/",
  };
}

export async function signOut(
  ctx: ServiceContext,
  headers: Headers,
  actor: { id: string; email: string },
): Promise<void> {
  await ctx.auth.api.signOut({ headers });

  await recordActivity(ctx.db, {
    action: "logout",
    entityType: "session",
    actorUserId: actor.id,
    actorEmail: actor.email,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
