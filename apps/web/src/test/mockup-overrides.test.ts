import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog } from "@tawd/core/schema";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { homeWords } from "@tawd/core/schema";
import { MockupError, resolvePicks, startRun } from "@/lib/mockups";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

/*
  A direction the team changed on the setup screen is recorded, with who
  changed it and from what. The run itself cannot be queued here (there is
  no Redis in the tests), but the override is logged before queueing, so it
  is on record even when the run then fails to start.
*/

let h: Harness;
const previousRedis = process.env.REDIS_URL;

beforeEach(async () => {
  h = await createHarness();
  delete process.env.REDIS_URL;
});

afterEach(async () => {
  await h.close();
  if (previousRedis) process.env.REDIS_URL = previousRedis;
});

const suggested = [
  { label: "A" as const, direction: "rugged_craftsman" as const, skillId: "impeccable" as const, reason: "Suggested" },
  { label: "B" as const, direction: "classic_trust" as const, skillId: "ui_ux_pro_max" as const, reason: "" },
];

describe("changing a concept's direction", () => {
  it("logs the change with what TAWD had picked", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Example Well & Pump",
      trade: "well_and_pump",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
    // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    // The Home page words, used, so Generate isn't blocked (1 October 2026).
    await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });

    await expect(
      startRun(h.ctx, admin.viewer, {
        projectId,
        suggested,
        concepts: [
          suggested[0]!,
          { label: "B", direction: "warm_local", skillId: "taste", reason: "Chosen by the team" },
        ],
      }),
    ).rejects.toBeInstanceOf(MockupError);

    const rows = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mockups.directions_overridden"));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorEmail).toBe(admin.viewer.email);
    expect(rows[0]!.valueBefore).toEqual([{ concept: "B", direction: "classic_trust" }]);
    expect(rows[0]!.valueAfter).toEqual({
      concepts: [{ concept: "B", direction: "warm_local", skill: "taste" }],
    });
  });

  it("lets a PM go ahead without Bold Emergency for an emergency trade, and logs it", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "ABC Plumbers",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
    // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    // The Home page words, used, so Generate isn't blocked (1 October 2026).
    await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });

    // The run gets as far as the queue (none in tests), so the rule did not block it.
    await expect(
      startRun(h.ctx, admin.viewer, {
        projectId,
        concepts: [
          { label: "A", direction: "classic_trust", skillId: "ui_ux_pro_max", reason: "" },
          { label: "B", direction: "modern_clean", skillId: "impeccable", reason: "" },
        ],
      }),
    ).rejects.toThrow(/could not be queued/);

    const [row] = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mockups.directions_overridden"));
    expect((row!.valueAfter as { rulesWaived: string[] }).rulesWaived[0]).toContain("normally includes Bold Emergency");
  });

  it("logs nothing when TAWD's picks are used as they are", async () => {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Example Well & Pump",
      trade: "well_and_pump",
      tier: "starter",
      lane: "lane_1",
      laneOption: null,
      conceptCount: 2,
      status: "mockups",
      memberUserIds: [],
    });
    // Answered, so Design and Generate aren't blocked (the current website rule, 30 September 2026).
    await saveIntakeSection(h.ctx, admin.viewer, projectId, "website", { noCurrentWebsite: true });
    // The Home page words, used, so Generate isn't blocked (1 October 2026).
    await h.db.insert(homeWords).values({ projectId: projectId, source: "tawd", sections: [{ name: "Hero", words: "Words for the test." }], approvedAt: new Date() });

    await expect(
      startRun(h.ctx, admin.viewer, { projectId, suggested, concepts: suggested }),
    ).rejects.toBeInstanceOf(MockupError);

    const rows = await h.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mockups.directions_overridden"));
    expect(rows).toEqual([]);
  });
});

describe("resolving the team's picks against TAWD's plan", () => {
  const plan = {
    plan: { concepts: suggested, notes: [] },
    project: { trade: "well_and_pump" },
    hasFoundingYear: false,
  } as unknown as Parameters<typeof resolvePicks>[0];

  it("keeps TAWD's picks, skills included, when nothing changed", () => {
    expect(
      resolvePicks(plan, [
        { label: "A", direction: "rugged_craftsman" },
        { label: "B", direction: "classic_trust" },
      ]),
    ).toEqual(suggested);
  });

  it("marks a changed pick as the team's choice", () => {
    const out = resolvePicks(plan, [
      { label: "A", direction: "rugged_craftsman" },
      { label: "B", direction: "warm_local" },
    ]);
    expect(out[1]).toMatchObject({ direction: "warm_local", skillId: "taste", reason: "Chosen by the team" });
  });

  it("refuses a set that breaks a rule, with the reason", () => {
    expect(() =>
      resolvePicks(plan, [
        { label: "A", direction: "rugged_craftsman" },
        { label: "B", direction: "modern_clean" },
      ]),
    ).toThrow(/both be built with Impeccable/);
  });
});
