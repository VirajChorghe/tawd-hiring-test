import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { user as userTable } from "@tawd/core/schema";
import { recordActivity } from "@tawd/core/activity";
import {
  MAX_FAILED_ATTEMPTS,
  countRecentFailures,
  signIn,
} from "@/lib/sign-in";
import { changeOwnPassword, setUserDisabled } from "@/lib/users";
import { emailSchema, passwordSchema } from "@/lib/validation";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

const headers = () => new Headers();

describe("signing in", () => {
  it("accepts the right password", async () => {
    const admin = await seedAdmin(h);

    const result = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    expect(result.ok).toBe(true);
  });

  it("sends a brand new account to change its temporary password", async () => {
    const admin = await seedAdmin(h);

    const result = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    expect(result).toEqual({ ok: true, redirectTo: "/change-password" });
  });

  it("rejects the wrong password", async () => {
    await seedAdmin(h);

    const result = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      "definitely-not-the-password",
    );

    expect(result.ok).toBe(false);
  });

  it("gives the same message for an unknown address as for a wrong password", async () => {
    await seedAdmin(h);

    const wrongPassword = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      "wrong-password-here",
    );
    const noSuchAccount = await signIn(
      h.ctx,
      headers(),
      "nobody@velocitymedialab.com",
      "wrong-password-here",
    );

    expect(wrongPassword.ok).toBe(false);
    expect(noSuchAccount.ok).toBe(false);
    expect(
      wrongPassword.ok === false && noSuchAccount.ok === false
        ? wrongPassword.message === noSuchAccount.message
        : null,
    ).toBe(true);
  });

  it("blocks a disabled account even with the correct password", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    const before = await signIn(
      h.ctx,
      headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );
    expect(before.ok).toBe(true);

    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);

    const after = await signIn(
      h.ctx,
      headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );
    expect(after.ok).toBe(false);
  });

  it("records the failure reason for a disabled account", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });
    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);

    await signIn(
      h.ctx,
      headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );

    const { activityLog } = await import("@tawd/core/schema");
    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "login.failed"));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.valueAfter).toEqual({ reason: "account_disabled" });
  });
});

describe("slowing down repeated failures", () => {
  it("locks an address after five failures in the window", async () => {
    const admin = await seedAdmin(h);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const attempt = await signIn(
        h.ctx,
        headers(),
        "admin@velocitymedialab.com",
        "wrong-password-here",
      );
      expect(attempt.ok).toBe(false);
    }

    expect(
      await countRecentFailures(h.ctx, "admin@velocitymedialab.com"),
    ).toBe(MAX_FAILED_ATTEMPTS);

    // The correct password is now refused too: that is the lockout working.
    const locked = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    expect(locked.ok).toBe(false);
    expect(locked.ok === false ? locked.message : "").toMatch(/15 minutes/);
  });

  it("lets the address back in once the window has passed", async () => {
    const admin = await seedAdmin(h);

    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await signIn(
        h.ctx,
        headers(),
        "admin@velocitymedialab.com",
        "wrong-password-here",
        longAgo,
      );
    }

    // Those failures are outside the fifteen minute window, so they no
    // longer count against this attempt.
    const result = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    expect(result.ok).toBe(true);
  });

  it("locks one address without affecting another", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await signIn(h.ctx, headers(), "admin@velocitymedialab.com", "wrong-one");
    }

    const other = await signIn(
      h.ctx,
      headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );

    expect(other.ok).toBe(true);
  });
});

describe("the forced first password change", () => {
  it("starts every new account needing one", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    const [row] = await h.db
      .select()
      .from(userTable)
      .where(eq(userTable.id, person.viewer.id));

    expect(row?.mustChangePassword).toBe(true);
  });

  it("clears the flag once the password is changed", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    const signedIn = await h.auth.api.signInEmail({
      body: {
        email: "person@velocitymedialab.com",
        password: person.temporaryPassword,
      },
      headers: headers(),
      returnHeaders: true,
    });

    const cookie = signedIn.headers.get("set-cookie") ?? "";
    const withSession = new Headers({ cookie: cookie.split(";")[0] ?? "" });

    await changeOwnPassword(
      h.ctx,
      person.viewer,
      withSession,
      person.temporaryPassword,
      "a-proper-long-password",
    );

    const [row] = await h.db
      .select()
      .from(userTable)
      .where(eq(userTable.id, person.viewer.id));

    expect(row?.mustChangePassword).toBe(false);
  });

  it("sends an established account to the landing page (Projects for admins, My work for everyone else)", async () => {
    const admin = await seedAdmin(h);
    await h.db
      .update(userTable)
      .set({ mustChangePassword: false })
      .where(eq(userTable.id, admin.viewer.id));

    const result = await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    expect(result).toEqual({ ok: true, redirectTo: "/" });
  });
});

describe("account rules", () => {
  it("only allows velocitymedialab.com addresses", () => {
    expect(emailSchema.safeParse("owner@velocitymedialab.com").success).toBe(true);
    expect(emailSchema.safeParse("someone@gmail.com").success).toBe(false);
    expect(emailSchema.safeParse("attacker@notvelocitymedialab.com").success).toBe(
      false,
    );
  });

  it("requires a password of at least twelve characters", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("a-proper-long-password").success).toBe(true);
  });
});

describe("what the log records about signing in", () => {
  it("records a success with who and from where", async () => {
    const admin = await seedAdmin(h);

    await signIn(
      h.ctx,
      headers(),
      "admin@velocitymedialab.com",
      admin.temporaryPassword,
    );

    const { activityLog } = await import("@tawd/core/schema");
    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "login.succeeded"));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorEmail).toBe("admin@velocitymedialab.com");
    expect(entries[0]?.ipAddress).toBe("203.0.113.10");
  });

  it("records a failed attempt from an address with no account", async () => {
    await recordActivity(h.db, { action: "logout", entityType: "session" });

    await signIn(
      h.ctx,
      headers(),
      "stranger@velocitymedialab.com",
      "guessing-away",
    );

    const { activityLog } = await import("@tawd/core/schema");
    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "login.failed"));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorEmail).toBe("stranger@velocitymedialab.com");
    expect(entries[0]?.actorUserId).toBeNull();
  });
});
