import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog, goLive } from "@tawd/core/schema";
import { verifyActivityChain } from "@tawd/core/activity";
import { PermissionError } from "@tawd/core/permissions";
import {
  createProject,
  getProject,
  getProjectTimeline,
  listFullActivityLog,
  listProjects,
  updateProject,
} from "@/lib/projects";
import { projectSchema } from "@/lib/validation";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

const lane1 = {
  clientName: "Sacramento Drain Pros",
  trade: "plumbing" as const,
  tier: "starter" as const,
  lane: "lane_1" as const,
  laneOption: null,
  conceptCount: 3,
  status: "intake" as const,
  memberUserIds: [] as string[],
};

describe("who can create and edit projects", () => {
  it("lets a PM create one", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      roles: ["pm"],
    });

    const id = await createProject(h.ctx, pm.viewer, lane1);
    expect(id).toBeTruthy();
  });

  it("lets an admin create one without holding the PM role", async () => {
    const admin = await seedAdmin(h);
    await expect(createProject(h.ctx, admin.viewer, lane1)).resolves.toBeTruthy();
  });

  it("refuses an SEO or Content person", async () => {
    const admin = await seedAdmin(h);
    for (const role of ["seo", "content", "web_designer", "founder"] as const) {
      const person = await seedUser(h, admin.viewer, {
        email: `${role}@velocitymedialab.com`,
        roles: [role],
      });
      await expect(
        createProject(h.ctx, person.viewer, lane1),
      ).rejects.toBeInstanceOf(PermissionError);
    }
  });

  it("still lets everybody read the list", async () => {
    const admin = await seedAdmin(h);
    await createProject(h.ctx, admin.viewer, lane1);

    const content = await seedUser(h, admin.viewer, {
      email: "content@velocitymedialab.com",
      roles: ["content"],
    });

    const visible = await listProjects(h.db, content.viewer);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.clientName).toBe("Sacramento Drain Pros");
  });

  it("shows a disabled person nothing", async () => {
    const admin = await seedAdmin(h);
    await createProject(h.ctx, admin.viewer, lane1);

    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });

    await expect(
      listProjects(h.db, { ...person.viewer, isDisabled: true }),
    ).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("the lane and concept rules from the profile", () => {
  it("accepts Lane 1 with three concepts", () => {
    expect(projectSchema.safeParse(lane1).success).toBe(true);
  });

  it("rejects Lane 1 carrying an A or B option", () => {
    const result = projectSchema.safeParse({ ...lane1, laneOption: "a" });
    expect(result.success).toBe(false);
  });

  it("rejects Lane 2 with no option chosen", () => {
    const result = projectSchema.safeParse({
      ...lane1,
      lane: "lane_2",
      laneOption: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Lane 2 Option A carrying concepts, since it has none", () => {
    const result = projectSchema.safeParse({
      ...lane1,
      lane: "lane_2",
      laneOption: "a",
      conceptCount: 2,
    });
    expect(result.success).toBe(false);
  });

  it("accepts Lane 2 Option A with no concepts", () => {
    const result = projectSchema.safeParse({
      ...lane1,
      lane: "lane_2",
      laneOption: "a",
      conceptCount: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts Lane 2 Option B with one concept", () => {
    const result = projectSchema.safeParse({
      ...lane1,
      lane: "lane_2",
      laneOption: "b",
      conceptCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a concept count outside one to three", () => {
    expect(projectSchema.safeParse({ ...lane1, conceptCount: 0 }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...lane1, conceptCount: 4 }).success).toBe(
      false,
    );
  });

  it("rejects an empty client name", () => {
    expect(projectSchema.safeParse({ ...lane1, clientName: "  " }).success).toBe(
      false,
    );
  });

  it("rejects a trade that is not on the list", () => {
    expect(
      projectSchema.safeParse({ ...lane1, trade: "crypto_consulting" }).success,
    ).toBe(false);
  });
});

describe("assigning team members", () => {
  it("stores and returns them", async () => {
    const admin = await seedAdmin(h);
    const designer = await seedUser(h, admin.viewer, {
      email: "designer@velocitymedialab.com",
      name: "Dee",
      roles: ["web_designer"],
    });

    const id = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      memberUserIds: [designer.viewer.id],
    });

    const loaded = await getProject(h.db, admin.viewer, id);
    // With their team roles, for the header's "Team: Dee (Web Designer)".
    expect(loaded?.members).toEqual([
      { id: designer.viewer.id, name: "Dee", roles: ["web_designer"] },
    ]);
  });
});

describe("what editing writes to the log", () => {
  it("records the before and after of an ordinary edit", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, lane1);

    await updateProject(h.ctx, admin.viewer, id, {
      ...lane1,
      clientName: "Sacramento Drain Professionals",
      tier: "growth",
    });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.updated"));

    const before = entry?.valueBefore as Record<string, unknown>;
    const after = entry?.valueAfter as Record<string, unknown>;

    expect(before.clientName).toBe("Sacramento Drain Pros");
    expect(after.clientName).toBe("Sacramento Drain Professionals");
    expect(before.tier).toBe("starter");
    expect(after.tier).toBe("growth");
  });

  /*
    Started past Intake on purpose. Leaving Intake is governed by the intake
    gate, which has its own tests in intake-service.test.ts; these are about
    what a status change writes to the log.
  */
  it("gives a status change its own entry", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      status: "mockups",
    });

    await updateProject(h.ctx, admin.viewer, id, { ...lane1, status: "content" });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.status_changed"));

    expect(entry?.valueBefore).toEqual({ status: "mockups" });
    expect(entry?.valueAfter).toEqual({ status: "content" });
  });

  it("gives a change of assignment its own entry", async () => {
    const admin = await seedAdmin(h);
    const person = await seedUser(h, admin.viewer, {
      email: "person@velocitymedialab.com",
    });
    const id = await createProject(h.ctx, admin.viewer, lane1);

    await updateProject(h.ctx, admin.viewer, id, {
      ...lane1,
      memberUserIds: [person.viewer.id],
    });

    const [entry] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.members_changed"));

    expect(entry?.valueBefore).toEqual({ memberUserIds: [] });
    expect(entry?.valueAfter).toEqual({ memberUserIds: [person.viewer.id] });
  });

  it("writes no status entry when the status did not move", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, lane1);

    await updateProject(h.ctx, admin.viewer, id, {
      ...lane1,
      clientName: "Renamed Only",
    });

    const entries = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "project.status_changed"));
    expect(entries).toHaveLength(0);
  });
});

describe("the project timeline", () => {
  it("shows this project's history, newest first, and nobody else's", async () => {
    const admin = await seedAdmin(h);
    const first = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      status: "mockups",
    });
    const second = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      clientName: "Reno HVAC",
      trade: "hvac",
    });

    await updateProject(h.ctx, admin.viewer, first, {
      ...lane1,
      status: "content",
    });

    const timeline = await getProjectTimeline(h.db, admin.viewer, first);
    const actions = timeline.map((t) => t.action);

    expect(actions).toEqual([
      "project.updated",
      "project.status_changed",
      "project.created",
    ]);

    const other = await getProjectTimeline(h.db, admin.viewer, second);
    expect(other.map((t) => t.action)).toEqual(["project.created"]);
  });

  it("names who did it", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      name: "Priya",
      roles: ["pm"],
    });

    const id = await createProject(h.ctx, pm.viewer, lane1);
    const timeline = await getProjectTimeline(h.db, admin.viewer, id);

    expect(timeline[0]?.actorName).toBe("Priya");
    expect(timeline[0]?.actorEmail).toBe("pm@velocitymedialab.com");
  });
});

describe("the full activity log page", () => {
  it("is admin only", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      roles: ["pm"],
    });

    await expect(listFullActivityLog(h.db, pm.viewer)).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(listFullActivityLog(h.db, admin.viewer)).resolves.toBeDefined();
  });

  it("covers user actions as well as project ones", async () => {
    const admin = await seedAdmin(h);
    await createProject(h.ctx, admin.viewer, lane1);

    const entries = await listFullActivityLog(h.db, admin.viewer);
    const types = new Set(entries.map((e) => e.entityType));

    expect(types.has("user")).toBe(true);
    expect(types.has("project")).toBe(true);
  });
});

describe("filtering the activity log", () => {
  async function seedLog() {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, {
      email: "pm@velocitymedialab.com",
      name: "Priya",
      roles: ["pm"],
    });
    const drains = await createProject(h.ctx, pm.viewer, lane1);
    const wells = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      clientName: "Example Well & Pump",
    });
    return { admin, pm, drains, wells };
  }

  it("filters by person", async () => {
    const { admin, pm } = await seedLog();
    const entries = await listFullActivityLog(h.db, admin.viewer, 200, {
      actorUserId: pm.viewer.id,
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.actorEmail === "pm@velocitymedialab.com")).toBe(true);
  });

  it("filters by a whole action group or one action", async () => {
    const { admin } = await seedLog();
    const group = await listFullActivityLog(h.db, admin.viewer, 200, { action: "project" });
    expect(group.length).toBeGreaterThan(0);
    expect(group.every((e) => e.action.startsWith("project."))).toBe(true);

    const one = await listFullActivityLog(h.db, admin.viewer, 200, {
      action: "project.created",
    });
    expect(one.map((e) => e.action)).toEqual(["project.created", "project.created"]);
  });

  it("filters by project, and names the project", async () => {
    const { admin, wells } = await seedLog();
    const entries = await listFullActivityLog(h.db, admin.viewer, 200, { projectId: wells });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.entityId === wells)).toBe(true);
    expect(entries[0]?.projectName).toBe("Example Well & Pump");
  });

  it("filters by date range, whole days inclusive", async () => {
    const { admin } = await seedLog();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(new Date());

    const inRange = await listFullActivityLog(h.db, admin.viewer, 200, {
      from: today,
      to: today,
    });
    expect(inRange.length).toBeGreaterThan(0);

    const before = await listFullActivityLog(h.db, admin.viewer, 200, {
      to: "2000-01-01",
    });
    expect(before).toEqual([]);
  });

  it("searches names, projects and recorded values", async () => {
    const { admin } = await seedLog();

    const byProject = await listFullActivityLog(h.db, admin.viewer, 200, { q: "example" });
    expect(byProject.length).toBeGreaterThan(0);
    expect(byProject.every((e) => JSON.stringify(e).toLowerCase().includes("example"))).toBe(true);

    const byPerson = await listFullActivityLog(h.db, admin.viewer, 200, { q: "priya" });
    expect(byPerson.length).toBeGreaterThan(0);
  });

  it("treats search wildcards and quotes as plain text", async () => {
    const { admin } = await seedLog();
    await expect(
      listFullActivityLog(h.db, admin.viewer, 200, { q: "%' or 1=1 --" }),
    ).resolves.toEqual([]);
    // A bare "%" would match everything if it were not escaped.
    await expect(
      listFullActivityLog(h.db, admin.viewer, 200, { q: "%" }),
    ).resolves.toEqual([]);
  });

  it("ignores a malformed date rather than failing", async () => {
    const { admin } = await seedLog();
    const entries = await listFullActivityLog(h.db, admin.viewer, 200, {
      from: "yesterday'; drop table x",
    });
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("the chain survives project work too", () => {
  it("stays verifiable after a run of edits", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      ...lane1,
      status: "mockups",
    });

    // Since Phase 9 a project becomes Live through Go live, which records the go-live first.
    await h.db.insert(goLive).values({ projectId: id, wentLiveAt: new Date() });
    for (const status of ["content", "build", "qa", "live"] as const) {
      await updateProject(h.ctx, admin.viewer, id, { ...lane1, status });
    }

    const result = await verifyActivityChain(h.db);
    expect(result.valid).toBe(true);
    expect(result.brokenAtSeq).toBeNull();
  });
});
