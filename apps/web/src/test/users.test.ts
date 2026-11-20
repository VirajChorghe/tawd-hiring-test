import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog, session, user as userTable } from "@tawd/core/schema";
import { verifyActivityChain } from "@tawd/core/activity";
import { PermissionError } from "@tawd/core/permissions";
import { signIn } from "@/lib/sign-in";
import {
  UserManagementError,
  createTeamUser,
  generateTemporaryPassword,
  listTeamUsers,
  resetUserPassword,
  setUserAdmin,
  setUserDisabled,
  setUserName,
  setUserRoles,
} from "@/lib/users";
import { createHarness, seedAdmin, seedUser, viewer, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("only admins manage accounts", () => {
  it("refuses to let a PM create an account", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      roles: ["pm"],
    });

    await expect(
      createTeamUser(h.ctx, pm.viewer, {
        name: "Sneaky",
        email: "sneaky@velocitymedialab.com",
        isAdmin: true,
        roles: [],
      }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses to let a founder disable somebody", async () => {
    const admin = await seedAdmin(h);
    const founder = await seedUser(h, admin.viewer, {
      email: "founder@velocitymedialab.com",
      roles: ["founder"],
    });
    const target = await seedUser(h, admin.viewer, {
      email: "target@velocitymedialab.com",
    });

    await expect(
      setUserDisabled(h.ctx, founder.viewer, target.viewer.id, true),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses to let anyone reset another person's password", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
      roles: ["seo", "content"],
    });

    await expect(
      resetUserPassword(h.ctx, person.viewer, admin.viewer.id),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("creating an account", () => {
  it("stores the roles given and starts it disabled-free and unverified", async () => {
    const admin = await seedAdmin(h);

    await createTeamUser(h.ctx, admin.viewer, {
      name: "Dana",
      email: "dana@velocitymedialab.com",
      isAdmin: false,
      roles: ["web_designer", "seo"],
    });

    const users = await listTeamUsers(h.db);
    const dana = users.find((u) => u.email === "dana@velocitymedialab.com");

    expect(dana).toBeDefined();
    expect(dana?.roles.sort()).toEqual(["seo", "web_designer"]);
    expect(dana?.isAdmin).toBe(false);
    expect(dana?.isDisabled).toBe(false);
    expect(dana?.mustChangePassword).toBe(true);
  });

  it("refuses a duplicate email address", async () => {
    const admin = await seedAdmin(h);
    await seedUser(h, admin.viewer, { email: "taken@velocitymedialab.com" });

    await expect(
      createTeamUser(h.ctx, admin.viewer, {
        name: "Someone Else",
        email: "taken@velocitymedialab.com",
        isAdmin: false,
        roles: [],
      }),
    ).rejects.toBeInstanceOf(UserManagementError);
  });

  it("produces a temporary password that actually works", async () => {
    const admin = await seedAdmin(h);
    const created = await seedUser(h, admin.viewer, {
      email: "new@velocitymedialab.com",
    });

    const result = await signIn(
      h.ctx,
      new Headers(),
      "new@velocitymedialab.com",
      created.temporaryPassword,
    );

    expect(result).toEqual({ ok: true, redirectTo: "/change-password" });
  });

  it("never writes the password into the log", async () => {
    const admin = await seedAdmin(h);
    const created = await seedUser(h, admin.viewer, {
      email: "new@velocitymedialab.com",
    });

    const entries = await h.db.select().from(activityLog);
    const dumped = JSON.stringify(entries);

    expect(dumped).not.toContain(created.temporaryPassword);
  });
});

describe("temporary passwords", () => {
  it("avoids characters that look alike", () => {
    const password = generateTemporaryPassword(500);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it("is a different password every time", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generateTemporaryPassword()),
    );
    expect(seen.size).toBe(50);
  });
});

describe("disabling an account", () => {
  it("keeps the person's history", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    const before = await h.db.select().from(activityLog);
    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);
    const after = await h.db.select().from(activityLog);

    // Nothing removed, one entry added.
    expect(after.length).toBe(before.length + 1);
    const [row] = await h.db
      .select()
      .from(userTable)
      .where(eq(userTable.id, person.viewer.id));
    expect(row).toBeDefined();
  });

  it("ends their signed-in sessions there and then", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    await h.auth.api.signInEmail({
      body: {
        email: "person@velocitymedialab.com",
        password: person.temporaryPassword,
      },
      headers: new Headers(),
    });

    const live = await h.db
      .select()
      .from(session)
      .where(eq(session.userId, person.viewer.id));
    expect(live.length).toBeGreaterThan(0);

    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);

    const afterwards = await h.db
      .select()
      .from(session)
      .where(eq(session.userId, person.viewer.id));
    expect(afterwards).toHaveLength(0);
  });

  it("can be undone, and then they can sign in again", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);
    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, false);

    const result = await signIn(
      h.ctx,
      new Headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );
    expect(result.ok).toBe(true);
  });
});

describe("not locking everybody out", () => {
  it("refuses to disable the last active admin", async () => {
    const admin = await seedAdmin(h);

    await expect(
      setUserDisabled(h.ctx, admin.viewer, admin.viewer.id, true),
    ).rejects.toBeInstanceOf(UserManagementError);
  });

  it("refuses to remove the last admin switch", async () => {
    const admin = await seedAdmin(h);

    await expect(
      setUserAdmin(h.ctx, admin.viewer, admin.viewer.id, false),
    ).rejects.toBeInstanceOf(UserManagementError);
  });

  it("allows it once a second admin exists", async () => {
    const admin = await seedAdmin(h);
    const second = await seedUser(h, admin.viewer, {
      email: "second@velocitymedialab.com",
      isAdmin: true,
    });

    // The other admin does it: nobody may disable themselves.
    await expect(
      setUserDisabled(h.ctx, second.viewer, admin.viewer.id, true),
    ).resolves.toBeUndefined();

    const users = await listTeamUsers(h.db);
    expect(users.find((u) => u.id === second.viewer.id)?.isAdmin).toBe(true);
  });

  it("counts a disabled admin as not active", async () => {
    const admin = await seedAdmin(h);
    const second = await seedUser(h, admin.viewer, {
      email: "second@velocitymedialab.com",
      isAdmin: true,
    });

    await setUserDisabled(h.ctx, admin.viewer, second.viewer.id, true);

    // Only one active admin remains, so the guard should hold again.
    await expect(
      setUserAdmin(h.ctx, admin.viewer, admin.viewer.id, false),
    ).rejects.toBeInstanceOf(UserManagementError);
  });
});

describe("disabling yourself", () => {
  it("is refused, even with another admin to spare", async () => {
    const admin = await seedAdmin(h);
    await seedUser(h, admin.viewer, {
      email: "second@velocitymedialab.com",
      isAdmin: true,
    });

    await expect(
      setUserDisabled(h.ctx, admin.viewer, admin.viewer.id, true),
    ).rejects.toThrow(/can't disable your own account/);

    const users = await listTeamUsers(h.db);
    expect(users.find((u) => u.id === admin.viewer.id)?.isDisabled).toBe(false);
  });
});

describe("renaming someone", () => {
  it("changes the name and logs before and after", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
      name: "Jason Test",
    });

    await setUserName(h.ctx, admin.viewer, person.viewer.id, "  Jason Tester ");

    const users = await listTeamUsers(h.db);
    expect(users.find((u) => u.id === person.viewer.id)?.name).toBe("Jason Tester");

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user.renamed"));
    expect(entry?.valueBefore).toEqual({ name: "Jason Test" });
    expect(entry?.valueAfter).toEqual({ name: "Jason Tester" });
  });

  it("refuses an empty name", async () => {
    const admin = await seedAdmin(h);
    await expect(
      setUserName(h.ctx, admin.viewer, admin.viewer.id, "   "),
    ).rejects.toBeInstanceOf(UserManagementError);
  });

  it("is admin only", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      roles: ["pm"],
    });
    await expect(
      setUserName(h.ctx, pm.viewer, admin.viewer.id, "Someone Else"),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("logs nothing when the name is unchanged", async () => {
    const admin = await seedAdmin(h);
    await setUserName(h.ctx, admin.viewer, admin.viewer.id, "Test Admin");
    const rows = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user.renamed"));
    expect(rows).toEqual([]);
  });
});

describe("resetting a password", () => {
  it("invalidates the old one and forces a change", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    const fresh = await resetUserPassword(h.ctx, admin.viewer, person.viewer.id);
    expect(fresh).not.toBe(person.temporaryPassword);

    const withOld = await signIn(
      h.ctx,
      new Headers(),
      "person@velocitymedialab.com",
      person.temporaryPassword,
    );
    expect(withOld.ok).toBe(false);

    const withNew = await signIn(
      h.ctx,
      new Headers(),
      "person@velocitymedialab.com",
      fresh,
    );
    expect(withNew).toEqual({ ok: true, redirectTo: "/change-password" });
  });
});

describe("changing roles", () => {
  it("records what changed, both directions", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
      roles: ["seo"],
    });

    await setUserRoles(h.ctx, admin.viewer, person.viewer.id, ["pm", "content"]);

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user.roles_changed"));

    expect(entry?.valueBefore).toEqual({ roles: ["seo"] });
    expect(entry?.valueAfter).toEqual({ roles: ["content", "pm"] });
  });

  it("writes nothing when the roles are unchanged", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
      roles: ["seo", "content"],
    });

    await setUserRoles(h.ctx, admin.viewer, person.viewer.id, ["content", "seo"]);

    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user.roles_changed"));
    expect(entries).toHaveLength(0);
  });
});

describe("the log stays verifiable through all of this", () => {
  it("keeps an unbroken chain across many actions", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
      roles: ["seo"],
    });

    await setUserRoles(h.ctx, admin.viewer, person.viewer.id, ["pm"]);
    await setUserAdmin(h.ctx, admin.viewer, person.viewer.id, true);
    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, true);
    await setUserDisabled(h.ctx, admin.viewer, person.viewer.id, false);
    await resetUserPassword(h.ctx, admin.viewer, person.viewer.id);
    await signIn(h.ctx, new Headers(), "person@velocitymedialab.com", "wrong");

    const result = await verifyActivityChain(h.db);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBeGreaterThan(6);
  });

  it("credits the bootstrap admin to the system, with no invented user id", async () => {
    await seedAdmin(h);

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "user.created"));

    expect(entry?.actorUserId).toBeNull();
    expect(entry?.actorEmail).toBe("system:create-admin");
  });
});

describe("listing the team", () => {
  it("returns everybody with their roles attached", async () => {
    const admin = await seedAdmin(h);
    await seedUser(h, admin.viewer, {
      email: "a@velocitymedialab.com",
      name: "Aaron",
      roles: ["pm"],
    });
    await seedUser(h, admin.viewer, {
      email: "b@velocitymedialab.com",
      name: "Bella",
      roles: ["seo", "content"],
    });

    const users = await listTeamUsers(h.db);
    expect(users).toHaveLength(3);
    expect(users.find((u) => u.name === "Bella")?.roles.sort()).toEqual([
      "content",
      "seo",
    ]);
  });
});

describe("a viewer built from a disabled row", () => {
  it("is refused by the service layer before it touches the database", async () => {
    const admin = await seedAdmin(h);

    await expect(
      createTeamUser(
        h.ctx,
        viewer({ ...admin.viewer, isDisabled: true }),
        {
          name: "Nope",
          email: "nope@velocitymedialab.com",
          isAdmin: false,
          roles: [],
        },
      ),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});
