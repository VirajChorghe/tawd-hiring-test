import { and, eq, gte, sql } from "drizzle-orm";

import { activityLog, user as userTable, verification } from "@tawd/core/schema";
import { recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import { deliverMail } from "@/lib/mail";
import type { ServiceContext } from "@/lib/users";
import { ALLOWED_EMAIL_DOMAIN } from "@/lib/validation";

/*
  "Forgot password?", on Better Auth's own reset (Jason, 25 September 2026).

  - The reply is always the same, whether or not the address has an
    account, so the form never tells anyone who works here.
  - The link works once and for 30 minutes. Better Auth keeps only a hash
    of it (verification.storeIdentifier "hashed") and consumes it on use.
  - Only velocitymedialab.com addresses, and never a disabled or deleted
    account: no email is sent for those.
  - At most 3 emails an hour for one account, and 10 requests in 15 minutes
    from one address on the internet.
  - Setting the new password signs out every session and is logged.
*/

export const RESET_LINK_MINUTES = 30;
export const MAX_RESET_EMAILS_PER_HOUR = 3;
export const MAX_RESET_REQUESTS_PER_IP = 10;

export const RESET_REPLY =
  "If that address has an account, we've sent a link to set a new password. It works once, for 30 minutes.";

/* Asking for the link. Always the same answer, whatever happened. */
export async function requestPasswordReset(ctx: ServiceContext, headers: Headers, rawEmail: string): Promise<string> {
  const email = rawEmail.trim().toLowerCase();
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const [fromHere] = ctx.ipAddress
    ? await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.action, "user.password_reset_requested"),
            eq(activityLog.ipAddress, ctx.ipAddress),
            gte(activityLog.occurredAt, since),
          ),
        )
    : [{ count: 0 }];
  const tooMany = (fromHere?.count ?? 0) >= MAX_RESET_REQUESTS_PER_IP;
  const allowed = /^[^@\s]+@[^@\s]+$/.test(email) && email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);

  if (allowed && !tooMany) {
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the server log only; the person sees the same answer either way
    try {
      // Better Auth makes the token and calls sendResetEmail (below) for a real account.
      await ctx.auth.api.requestPasswordReset({ body: { email }, headers });
    } catch (error) {
      console.error(`Password reset request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  await recordActivity(ctx.db, {
    action: "user.password_reset_requested",
    entityType: "session",
    actorEmail: email,
    valueAfter: { outcome: !allowed ? "not a velocitymedialab.com address" : tooMany ? "too many requests from this address" : "handled" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return RESET_REPLY;
}

/*
  Better Auth's sendResetPassword: the email itself, for an account that
  exists. Disabled and deleted accounts, other domains, and a fourth request
  within the hour get nothing.
*/
export async function sendResetEmail(
  db: Database,
  user: { id: string; email: string; name: string },
  token: string,
  baseURL: string,
): Promise<void> {
  const [row] = await db
    .select({ banned: userTable.banned, deletedAt: userTable.deletedAt })
    .from(userTable)
    .where(eq(userTable.id, user.id))
    .limit(1);
  const email = user.email.toLowerCase();
  let outcome: string;
  if (!row || row.banned || row.deletedAt) {
    outcome = "not sent: the account is disabled";
  } else if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    outcome = "not sent: not a velocitymedialab.com address";
  } else {
    // Better Auth has already stored this request's token, so it counts itself.
    const [recent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(verification)
      .where(and(eq(verification.value, user.id), gte(verification.createdAt, new Date(Date.now() - 60 * 60 * 1000))));
    if ((recent?.count ?? 0) > MAX_RESET_EMAILS_PER_HOUR) {
      outcome = "not sent: 3 links already sent this hour";
    } else {
      const link = `${baseURL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
      // Sent after the page has answered; the send is logged on its own as "Email sent" or "Email not sent".
      deliverMail(db, { to: email, ...resetEmail(user.name, link) }, { purpose: "password reset link", userId: user.id });
      outcome = "sending";
    }
  }
  await recordActivity(db, {
    action: "user.password_reset_requested",
    entityType: "user",
    entityId: user.id,
    actorEmail: email,
    valueAfter: { outcome },
  });
}

function resetEmail(name: string, link: string) {
  const first = name.split(" ")[0] || "there";
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return {
    subject: "Set a new TAWD password",
    text: `Hi ${first},

Someone (hopefully you) asked to set a new password for TAWD. Open this link to choose one:

${link}

It works once, for ${RESET_LINK_MINUTES} minutes. If you didn't ask, ignore this email: your password stays as it is.

TAWD, Velocity Media Lab`,
    html: `<p>Hi ${escape(first)},</p>
<p>Someone (hopefully you) asked to set a new password for TAWD. Choose one here:</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#205af2;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Set a new password</a></p>
<p>It works once, for ${RESET_LINK_MINUTES} minutes. If you didn't ask, ignore this email: your password stays as it is.</p>
<p style="color:#5b6570">TAWD, Velocity Media Lab</p>`,
  };
}

/* Setting the new password from the link. False when the link is used up, expired or wrong. */
export async function resetPasswordWithLink(ctx: ServiceContext, token: string, newPassword: string): Promise<boolean> {
  try {
    await ctx.auth.api.resetPassword({ body: { token, newPassword } });
    return true;
  } catch {
    return false;
  }
}

/*
  Better Auth's onPasswordReset: the password they chose is their own now
  (no forced change at the next sign-in), and it is logged. Every session
  is signed out by Better Auth itself (revokeSessionsOnPasswordReset).
*/
export async function afterPasswordReset(db: Database, user: { id: string; email: string }): Promise<void> {
  await db.update(userTable).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(userTable.id, user.id));
  await recordActivity(db, {
    action: "user.password_reset_by_email",
    entityType: "user",
    entityId: user.id,
    actorUserId: user.id,
    actorEmail: user.email,
  });
}

/* A disabled or deleted account's unused reset links stop working at once. */
export async function forgetResetLinks(db: Database, userId: string): Promise<void> {
  await db.delete(verification).where(eq(verification.value, userId));
}
