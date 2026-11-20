import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { account, activityLog, projectMember, session, user as userTable, userRole } from "@tawd/core/schema";
import { verifyActivityChain } from "@tawd/core/activity";
import { PermissionError } from "@tawd/core/permissions";
import { createProject, getProjectTimeline, listAssignableUsers, listFullActivityLog } from "@/lib/projects";
import { signIn } from "@/lib/sign-in";
import { describeChanges } from "@/lib/timeline-text";
import {
  UserManagementError,
  createTeamUser,
  deleteTeamUser,
  listPeopleNames,
  listTeamUsers,
  setUserDisabled,
} from "@/lib/users";
import { changePasswordSchema } from "@/lib/validation";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

/*
  What the screen sweep changed underneath the screens: deleting a team
  member, who can be put on a project, the password rule, and History in
  plain words.
*/

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

const REASON = "Left VML at the end of September";

const lane1 = {
  clientName: "Dale Rowan",
  trade: "well_and_pump" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "intake" as const,
};

async function setup() {
  const admin = await seedAdmin(h);
  const sam = await seedUser(h, admin.viewer, {
    email: "sam@velocitymedialab.com",
    name: "Sam Lee",
    roles: ["seo"],
  });
  const projectId = await createProject(h.ctx, admin.viewer, {
    ...lane1,
    memberUserIds: [sam.viewer.id],
  });
  // Sam signs in once, so there is a session and some history to keep.
  await signIn(h.ctx, new Headers(), "sam@velocitymedialab.com", sam.temporaryPassword);
  return { admin, sam, projectId };
}

describe("deleting a team member", () => {
  it("is admins only", async () => {
    const { admin, sam } = await setup();
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(
      deleteTeamUser(h.ctx, pm.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: REASON }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("needs the name typed exactly and a reason", async () => {
    const { admin, sam } = await setup();
    await expect(
      deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "sam lee", reason: REASON }),
    ).rejects.toThrow(/does not match/);
    await expect(
      deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: "gone" }),
    ).rejects.toThrow(/reason of at least/);
    expect((await listTeamUsers(h.db)).some((u) => u.id === sam.viewer.id)).toBe(true);
  });

  it("refuses to delete yourself", async () => {
    const { admin } = await setup();
    await seedUser(h, admin.viewer, { email: "second@velocitymedialab.com", isAdmin: true });
    await expect(
      deleteTeamUser(h.ctx, admin.viewer, admin.viewer.id, { confirmName: "Test Admin", reason: REASON }),
    ).rejects.toThrow(/can't delete your own account/);
  });

  it("refuses to delete the last active admin", async () => {
    const admin = await seedAdmin(h);
    const other = await seedUser(h, admin.viewer, {
      email: "other@velocitymedialab.com",
      name: "Other Admin",
      isAdmin: true,
    });
    // With two admins, the other one could go...
    await setUserDisabled(h.ctx, admin.viewer, other.viewer.id, true);
    // ...but once disabled, admin is the only active one, and only another
    // admin could delete them anyway. So test it from the other side:
    await setUserDisabled(h.ctx, admin.viewer, other.viewer.id, false);
    await setUserDisabled(h.ctx, other.viewer, admin.viewer.id, true);
    await expect(
      deleteTeamUser(h.ctx, admin.viewer, other.viewer.id, { confirmName: "Other Admin", reason: REASON }),
    ).rejects.toThrow(/last active admin/);
  });

  it("removes sign-in, sessions, roles and project places, and releases the email", async () => {
    const { admin, sam, projectId } = await setup();
    expect((await h.db.select().from(session).where(eq(session.userId, sam.viewer.id))).length).toBe(1);

    await deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: REASON });

    expect(await h.db.select().from(session).where(eq(session.userId, sam.viewer.id))).toEqual([]);
    expect(await h.db.select().from(account).where(eq(account.userId, sam.viewer.id))).toEqual([]);
    expect(await h.db.select().from(userRole).where(eq(userRole.userId, sam.viewer.id))).toEqual([]);
    expect(
      await h.db.select().from(projectMember).where(eq(projectMember.projectId, projectId)),
    ).toEqual([]);

    const [row] = await h.db.select().from(userTable).where(eq(userTable.id, sam.viewer.id));
    expect(row).toMatchObject({ name: "Sam Lee", banned: true, role: "user" });
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(row!.email).not.toBe("sam@velocitymedialab.com");

    // They cannot sign in; the address can be given to someone new.
    const attempt = await signIn(h.ctx, new Headers(), "sam@velocitymedialab.com", sam.temporaryPassword);
    expect(attempt.ok).toBe(false);
    await expect(
      createTeamUser(h.ctx, admin.viewer, { name: "Sam Lee", email: "sam@velocitymedialab.com", isAdmin: false, roles: [] }),
    ).resolves.toBeDefined();
  });

  it("leaves the team list, the assignable list, and cannot be deleted twice", async () => {
    const { admin, sam } = await setup();
    await deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: REASON });

    expect((await listTeamUsers(h.db)).map((u) => u.id)).not.toContain(sam.viewer.id);
    expect((await listAssignableUsers(h.db)).map((u) => u.id)).not.toContain(sam.viewer.id);
    await expect(
      deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: REASON }),
    ).rejects.toBeInstanceOf(UserManagementError);
  });

  it("keeps every history entry, names them as deleted, and records who deleted them and why", async () => {
    const { admin, sam, projectId } = await setup();
    const before = await h.db.select().from(activityLog).where(eq(activityLog.actorUserId, sam.viewer.id));
    expect(before.length).toBeGreaterThan(0);

    await deleteTeamUser(h.ctx, admin.viewer, sam.viewer.id, { confirmName: "Sam Lee", reason: REASON });

    const after = await h.db.select().from(activityLog).where(eq(activityLog.actorUserId, sam.viewer.id));
    expect(after.map((a) => a.hash)).toEqual(before.map((b) => b.hash));

    const log = await listFullActivityLog(h.db, admin.viewer);
    const theirs = log.filter((e) => e.actorEmail === "sam@velocitymedialab.com");
    expect(theirs.every((e) => e.actorName === "(deleted user) Sam Lee")).toBe(true);

    const deletion = log.find((e) => e.action === "user.deleted")!;
    expect(deletion.userName).toBe("(deleted user) Sam Lee");
    expect(deletion.valueBefore).toMatchObject({ name: "Sam Lee", email: "sam@velocitymedialab.com", roles: ["seo"], projects: 1 });
    expect(deletion.valueAfter).toEqual({ reason: REASON });

    // The project's History names them too.
    const people = await listPeopleNames(h.db);
    expect(people.get(sam.viewer.id)).toBe("(deleted user) Sam Lee");
    const timeline = await getProjectTimeline(h.db, admin.viewer, projectId);
    const created = timeline.find((t) => t.action === "project.created")!;
    expect(describeChanges(created.action, created.valueBefore, created.valueAfter, people)).toContain(
      "Added (deleted user) Sam Lee",
    );

    expect((await verifyActivityChain(h.db)).valid).toBe(true);
  });
});

describe("who can be put on a project", () => {
  it("lists active people with their roles, and keeps anyone already on the project", async () => {
    const { admin, sam } = await setup();
    const dee = await seedUser(h, admin.viewer, { email: "dee@velocitymedialab.com", name: "Dee Morgan", roles: ["web_designer", "content"] });
    await setUserDisabled(h.ctx, admin.viewer, sam.viewer.id, true);

    const fresh = await listAssignableUsers(h.db);
    expect(fresh.map((p) => p.name)).not.toContain("Sam Lee");
    expect(fresh.find((p) => p.id === dee.viewer.id)?.roles.sort()).toEqual(["content", "web_designer"]);

    // Editing a project Sam is still on keeps Sam, so saving never drops him.
    const editing = await listAssignableUsers(h.db, [sam.viewer.id]);
    expect(editing.map((p) => p.name)).toContain("Sam Lee");
  });
});

describe("choosing a password", () => {
  it("refuses keeping the temporary one", () => {
    const same = changePasswordSchema.safeParse({
      currentPassword: "temporary-password-123",
      newPassword: "temporary-password-123",
      confirmPassword: "temporary-password-123",
    });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.message).toBe("Choose a password different from the one you have now");

    expect(
      changePasswordSchema.safeParse({
        currentPassword: "temporary-password-123",
        newPassword: "correct horse battery",
        confirmPassword: "correct horse battery",
      }).success,
    ).toBe(true);
  });
});

describe("History in plain words", () => {
  const people = new Map([
    ["u1", "Dee Morgan"],
    ["u2", "Priya Shah"],
  ]);

  it.each([
    ["project.created", {}, { trade: "well_and_pump", tier: "starter", lane: "lane_1", conceptCount: 3, memberUserIds: ["u1"] }, ["Well and pump, Starter tier, Lane 1: no design supplied, 3 concepts", "Added Dee Morgan"]],
    ["project.updated", { tier: "starter", clientName: "A" }, { tier: "growth", clientName: "A" }, ["Tier: Starter to Growth"]],
    ["project.members_changed", { memberUserIds: ["u1"] }, { memberUserIds: ["u2"] }, ["Added Priya Shah", "Removed Dee Morgan"]],
    ["project.status_changed", { status: "intake" }, { status: "mockups" }, ["Intake to Design"]],
    ["intake.updated", { section: "business", phone: "" }, { section: "business", phone: "916" }, ["Business: phone"]],
    ["intake.updated", { section: "services", mainServiceId: "" }, { section: "services", mainServiceId: "s1" }, ["Services: main service"]],
    ["mockups.run_started", {}, { concepts: [{ label: "A", direction: "rugged_craftsman" }] }, ["A: Rugged Craftsman"]],
  ] as const)("%s reads in plain words", (action, before, after, lines) => {
    expect(describeChanges(action, before, after, people)).toEqual(lines);
  });

  it("never shows raw ids or JSON", () => {
    const lines = describeChanges("project.updated", { memberUserIds: ["u1"] }, { memberUserIds: ["x9"] }, people);
    expect(lines.join(" ")).not.toMatch(/u1|x9|\[|\{/);
  });
});
