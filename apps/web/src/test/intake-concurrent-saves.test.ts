import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog } from "@tawd/core/schema";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

/*
  D2 (audit F-012, probe p3): two people saving different intake sections at
  the same moment. Each save read the whole intake, changed its section and
  wrote the whole thing back, so the later write put the earlier one's
  section back as it was: one save silently lost, and the log said both
  were saved. On a project with no intake row yet, the second save failed
  with a raw database error.
*/

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function project(admin: Awaited<ReturnType<typeof seedAdmin>>) {
  return createProject(h.ctx, admin.viewer, {
    clientName: "Example Plumbing",
    trade: "plumbing",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
}

describe("two intake saves at the same moment", () => {
  it("keeps both sections when the intake already exists", async () => {
    const admin = await seedAdmin(h);
    const id = await project(admin);
    await saveIntakeSection(h.ctx, admin.viewer, id, "brand", { moodWords: ["calm"] });

    await Promise.all([
      saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Example Plumbing", city: "Reno" }),
      saveIntakeSection(h.ctx, admin.viewer, id, "process", { guarantees: "1-year labour warranty" }),
    ]);

    const intake = await loadIntake(h.db as never, admin.viewer, id);
    expect(intake!.data.business.city).toBe("Reno");
    expect(intake!.data.process.guarantees).toBe("1-year labour warranty");
    expect(intake!.data.brand.moodWords).toEqual(["calm"]);
  });

  it("keeps both when neither had been saved before (no raw database error)", async () => {
    const admin = await seedAdmin(h);
    const id = await project(admin);

    await Promise.all([
      saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Example Plumbing", city: "Reno" }),
      saveIntakeSection(h.ctx, admin.viewer, id, "process", { guarantees: "1-year labour warranty" }),
    ]);

    const intake = await loadIntake(h.db as never, admin.viewer, id);
    expect(intake!.data.business.city).toBe("Reno");
    expect(intake!.data.process.guarantees).toBe("1-year labour warranty");
  });

  it("logs exactly what is stored", async () => {
    const admin = await seedAdmin(h);
    const id = await project(admin);
    await Promise.all([
      saveIntakeSection(h.ctx, admin.viewer, id, "business", { name: "Example Plumbing", city: "Reno" }),
      saveIntakeSection(h.ctx, admin.viewer, id, "process", { guarantees: "1-year labour warranty" }),
    ]);
    const logged = await h.db.select().from(activityLog).where(eq(activityLog.action, "intake.updated"));
    expect(logged.map((l) => (l.valueAfter as { section: string }).section).sort()).toEqual(["business", "process"]);
  });
});
