import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The whole-code review (13 October 2026): the Speed check's own messages
  reach the person who pressed the button, never "Something went wrong".
*/

const state: { user: unknown; ctx: unknown } = { user: null, ctx: null };

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/session", () => ({
  requireUser: async () => state.user,
  requireUserPendingPasswordChange: async () => state.user,
}));
vi.mock("@/lib/server-context", () => ({ getServiceContext: async () => state.ctx }));

import { startSpeedCheckAction } from "@/app/actions";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("the Speed check button", () => {
  it("shows the check's own reason", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    state.ctx = h.ctx;
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "pro", clientName: "Nora Beagle Site" });
    expect(await startSpeedCheckAction(id, "netlify")).toEqual({ ok: false, message: "Deploy the Netlify preview first." });
  });
});
