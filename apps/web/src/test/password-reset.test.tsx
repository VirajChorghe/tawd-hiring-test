import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Forgot password (25 September 2026): Better Auth's own reset, sent over
  SMTP. One reply for everyone; a link that works once, for 30 minutes,
  kept only as a hash; velocitymedialab.com only; never for a disabled
  account; at most 3 emails an hour per account and 10 requests per
  address; every session signed out; logged. And "Change password" for
  anyone signed in.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

import { activityLog, session, user as userTable, verification } from "@tawd/core/schema";
import { setMailSenderForTesting, settleMail, type OutgoingMail } from "@/lib/mail";
import {
  MAX_RESET_REQUESTS_PER_IP,
  RESET_REPLY,
  requestPasswordReset,
  resetPasswordWithLink,
} from "@/lib/password-reset";
import { MAX_FAILED_ATTEMPTS, countRecentFailures, signIn } from "@/lib/sign-in";
import { changeOwnPassword, deleteTeamUser, setUserDisabled } from "@/lib/users";
import { describeChanges } from "@/lib/timeline-text";
import { ChangePasswordForm } from "@/app/change-password/form";
import { SignInForm } from "@/app/login/form";
import { ForgotPasswordForm } from "@/app/forgot-password/form";
import { ResetPasswordForm } from "@/app/reset-password/form";
import { TopBar } from "@/components/ui/top-bar";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
let sent: OutgoingMail[];

beforeEach(async () => {
  h = await createHarness();
  sent = [];
  setMailSenderForTesting(async (mail) => void sent.push(mail));
});

afterEach(async () => {
  setMailSenderForTesting(null);
  await h.close();
});

const headers = () => new Headers();
const EMAIL = "person@velocitymedialab.com";

/* Asks for a link, and waits for the email to go (it is sent in the background). */
async function ask(ctx: Harness["ctx"], email: string): Promise<string> {
  const reply = await requestPasswordReset(ctx, headers(), email);
  await settleMail();
  return reply;
}

async function person() {
  const admin = await seedAdmin(h);
  const seeded = await seedUser(h, admin.viewer, { email: EMAIL, name: "Pat Person" });
  return { admin, ...seeded };
}

/* The token from the emailed link. */
const tokenOf = (mail: OutgoingMail) => new URL(/https?:\/\/\S+reset-password\?token=[^\s"]+/.exec(mail.text)![0]).searchParams.get("token")!;

describe("asking for the link", () => {
  it("emails a link to set a new password, keeps only a hash of it, and says the same to everyone", async () => {
    const { viewer } = await person();
    expect(await ask(h.ctx, " Person@VelocityMediaLab.com ")).toBe(RESET_REPLY);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: EMAIL, subject: "Set a new TAWD password" });
    expect(sent[0]!.text).toContain("Hi Pat,");
    expect(sent[0]!.text).toContain("It works once, for 30 minutes.");
    expect(sent[0]!.text).toMatch(/http:\/\/localhost:3000\/reset-password\?token=/);
    expect(sent[0]!.html).toContain("Set a new password</a>");

    // The database holds a hash, never the token itself.
    const token = tokenOf(sent[0]!);
    const rows = await h.db.select().from(verification);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(viewer.id);
    expect(rows[0]!.identifier).not.toContain(token);
    // 30 minutes.
    const minutes = (rows[0]!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);

    // No account, another domain: the same words, and no email.
    expect(await ask(h.ctx, "nobody@velocitymedialab.com")).toBe(RESET_REPLY);
    expect(await ask(h.ctx, "pat@gmail.com")).toBe(RESET_REPLY);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for a disabled account, and disabling or deleting one kills its unused links", async () => {
    const { admin, viewer } = await person();
    await ask(h.ctx, EMAIL);
    expect(await h.db.select().from(verification)).toHaveLength(1);

    await setUserDisabled(h.ctx, admin.viewer, viewer.id, true);
    expect(await h.db.select().from(verification)).toHaveLength(0);
    await ask(h.ctx, EMAIL);
    expect(sent).toHaveLength(1);
    expect(await resetPasswordWithLink(h.ctx, tokenOf(sent[0]!), "a-brand-new-password")).toBe(false);

    await setUserDisabled(h.ctx, admin.viewer, viewer.id, false);
    await ask(h.ctx, EMAIL);
    expect(sent).toHaveLength(2);
    await deleteTeamUser(h.ctx, admin.viewer, viewer.id, { confirmName: "Pat Person", reason: "Left the company this week" });
    expect(await h.db.select().from(verification).where(eq(verification.value, viewer.id))).toHaveLength(0);
  });

  it("sends at most 3 emails an hour for one account, and stops a flood from one address", async () => {
    await person();
    for (let i = 0; i < 5; i += 1) await ask(h.ctx, EMAIL);
    await settleMail();
    expect(sent).toHaveLength(3);

    const flood = { ...h.ctx, ipAddress: "198.51.100.7" };
    for (let i = 0; i < MAX_RESET_REQUESTS_PER_IP + 2; i += 1) await ask(flood, `x${i}@velocitymedialab.com`);
    const outcomes = (await h.db.select().from(activityLog).where(eq(activityLog.ipAddress, "198.51.100.7"))).map(
      (row) => (row.valueAfter as { outcome: string }).outcome,
    );
    expect(outcomes.filter((o) => o === "too many requests from this address")).toHaveLength(2);
  });
});

describe("setting the new password", () => {
  it("works once, signs out every session, clears the forced change, lifts the lockout, and is logged", async () => {
    const { viewer, temporaryPassword } = await person();
    // Locked out after five wrong tries.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) await signIn(h.ctx, headers(), EMAIL, "wrong-password-here");
    expect(await countRecentFailures(h.ctx, EMAIL)).toBe(MAX_FAILED_ATTEMPTS);
    await h.auth.api.signInEmail({ body: { email: EMAIL, password: temporaryPassword }, headers: headers() });
    expect(await h.db.select().from(session).where(eq(session.userId, viewer.id))).toHaveLength(1);

    await ask(h.ctx, EMAIL);
    const token = tokenOf(sent[0]!);
    expect(await resetPasswordWithLink(h.ctx, token, "a-brand-new-password")).toBe(true);

    expect(await h.db.select().from(session).where(eq(session.userId, viewer.id))).toHaveLength(0);
    const [row] = await h.db.select().from(userTable).where(eq(userTable.id, viewer.id));
    expect(row!.mustChangePassword).toBe(false);
    expect(await countRecentFailures(h.ctx, EMAIL)).toBe(0);
    expect(await signIn(h.ctx, headers(), EMAIL, "a-brand-new-password")).toEqual({ ok: true, redirectTo: "/" });

    // Used up.
    expect(await resetPasswordWithLink(h.ctx, token, "another-new-password")).toBe(false);
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "user.password_reset_by_email"));
    expect(log).toMatchObject({ entityId: viewer.id, actorEmail: EMAIL });
  });

  it("refuses an expired link, a made-up one, and a short password", async () => {
    await person();
    await ask(h.ctx, EMAIL);
    const token = tokenOf(sent[0]!);
    expect(await resetPasswordWithLink(h.ctx, "not-a-real-token", "a-brand-new-password")).toBe(false);
    expect(await resetPasswordWithLink(h.ctx, token, "short")).toBe(false);
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await resetPasswordWithLink(h.ctx, token, "a-brand-new-password")).toBe(false);
  });

  it("says in History what happened, never the link", async () => {
    await person();
    await ask(h.ctx, EMAIL);
    const rows = await h.db.select().from(activityLog).where(eq(activityLog.action, "user.password_reset_requested"));
    const outcomes = rows.map((r) => (r.valueAfter as { outcome: string }).outcome);
    expect(outcomes).toContain("sending");
    expect(JSON.stringify(rows)).not.toContain(tokenOf(sent[0]!));
    expect(describeChanges("user.password_reset_requested", null, { outcome: "sending" }, new Map())).toEqual(["Sending the email"]);
    const [delivered] = await h.db.select().from(activityLog).where(eq(activityLog.action, "email.sent"));
    expect(delivered).toBeDefined();
    expect(JSON.stringify(delivered)).not.toContain(tokenOf(sent[0]!));
  });
});

describe("changing your password while signed in", () => {
  it("works for an account that already chose one, and signs out the other devices", async () => {
    const { viewer, temporaryPassword } = await person();
    const first = await h.auth.api.signInEmail({ body: { email: EMAIL, password: temporaryPassword }, headers: headers(), returnHeaders: true });
    const cookie = new Headers({ cookie: (first.headers.get("set-cookie") ?? "").split(";")[0] ?? "" });
    await changeOwnPassword(h.ctx, viewer, cookie, temporaryPassword, "my-first-own-password");
    await h.auth.api.signInEmail({ body: { email: EMAIL, password: "my-first-own-password" }, headers: headers() });
    const again = await h.auth.api.signInEmail({ body: { email: EMAIL, password: "my-first-own-password" }, headers: headers(), returnHeaders: true });
    const here = new Headers({ cookie: (again.headers.get("set-cookie") ?? "").split(";")[0] ?? "" });
    expect(await h.db.select().from(session).where(eq(session.userId, viewer.id))).toHaveLength(3);

    await changeOwnPassword(h.ctx, viewer, here, "my-first-own-password", "my-second-own-password");
    // Only the session that made the change is left.
    expect(await h.db.select().from(session).where(eq(session.userId, viewer.id))).toHaveLength(1);
  });
});

describe("the screens", () => {
  it("links Sign in to Forgot password, and says when the password was changed", () => {
    const html = renderToStaticMarkup(<SignInForm initialError={null} initialNotice="Your password is changed. Sign in with the new one." />);
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain("Forgot password?");
    expect(html).toContain("Your password is changed. Sign in with the new one.");
  });

  it("asks for the email, and sets a new password from the link with the same rules", () => {
    expect(renderToStaticMarkup(<ForgotPasswordForm />)).toContain("Send the link");
    const reset = renderToStaticMarkup(<ResetPasswordForm token="abc" />);
    expect(reset).toContain("Set a new password");
    expect(reset).toContain("At least 12 characters");
    expect(reset).toContain('name="token" value="abc"');
    expect(renderToStaticMarkup(<ResetPasswordForm token="" />)).toContain("Ask for a new link");
  });

  it("offers Change password under the email in the top bar, worded for a change by choice", () => {
    const bar = renderToStaticMarkup(<TopBar user={{ email: EMAIL, canManageUsers: false, canViewActivity: false, canViewSpend: false }} />);
    expect(bar).toContain('href="/change-password"');
    expect(bar).toContain("Change password");
    const byChoice = renderToStaticMarkup(<ChangePasswordForm email={EMAIL} forced={false} />);
    expect(byChoice).toContain("Change your password");
    expect(byChoice).toContain("Current password");
    const first = renderToStaticMarkup(<ChangePasswordForm email={EMAIL} forced />);
    expect(first).toContain("Choose your password");
    expect(first).toContain("Temporary password");
  });
});
