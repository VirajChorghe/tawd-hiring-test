import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  An intake save's follow-ups (29 October 2026, CodeRabbit on PR #14): the
  section is saved either way, and a follow-up that fails is named in the
  result so the save bar can offer Try again.
*/

const state = vi.hoisted(() => ({ user: null as unknown, ctx: null as unknown, logoFails: false }));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("@/lib/server-context", () => ({ getServiceContext: async () => state.ctx }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/logo-design", async (original) => ({
  ...(await original<typeof import("@/lib/logo-design")>()),
  syncLogoAddon: async () => {
    if (state.logoFails) throw new Error("database busy");
  },
}));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { saveIntakeSectionAction } from "@/app/actions";
import { loadIntake } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  state.ctx = h.ctx;
});

afterEach(async () => {
  state.user = null;
  state.logoFails = false;
  setDbForTesting(null);
  await h.close();
});

describe("an intake save's follow-ups", () => {
  it("keeps the save and names the logo add-on when it didn't update", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Happy Beagle Lady", trade: "photography", tier: "growth", lane: "lane_1", laneOption: null, conceptCount: 1, status: "intake", memberUserIds: [] });

    state.logoFails = true;
    const failed = await saveIntakeSectionAction(id, "brand", { tawdDesignsLogo: true });
    expect(failed).toMatchObject({ ok: true, warning: "Saved, but these didn't update: logo add-on. Try again in a minute." });
    expect((await loadIntake(h.db, admin.viewer, id))?.data.brand.tawdDesignsLogo).toBe(true);

    state.logoFails = false;
    const again = await saveIntakeSectionAction(id, "brand", { tawdDesignsLogo: true });
    expect(again.ok && again.warning).toBeFalsy();
  });
});
