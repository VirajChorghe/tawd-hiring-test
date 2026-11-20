import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Health and beauty rules before go-live (26 September 2026): each flag on
  the newest build is fixed (gone from a new build) or ticked "Confirmed
  with the client" by a PM, logged. The go-live checklist waits for all.
*/

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, healthFlagConfirmation, siteBuild } from "@tawd/core/schema";
import { healthFlagItems, healthFlags } from "@tawd/core/content";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { PermissionError } from "@tawd/core/permissions";
import type { ChecklistItem } from "@tawd/core/site";
import { confirmHealthFlag, healthChecklistItem, loadHealthFlags } from "@/lib/health-flags";
import { createProject } from "@/lib/projects";
import { deleteProject } from "@/lib/project-deletion";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});

afterEach(async () => {
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const flagsFor = (text: string) => healthFlagItems(healthFlags(text, { clientWords: "", beforeAfterPermission: false }));

async function builtWith(text: string) {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Glow Med Spa", trade: "med_spa", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [] });
  const health: ChecklistItem = { key: "health", label: "Health and beauty rules", ok: false, detail: "For the PM", blocksGoLive: true, flags: flagsFor(text) };
  await h.db.insert(siteBuild).values({ projectId: id, version: 1, status: "done", pages: [], fileCount: 1, checks: [health] });
  return { admin, id, health };
}

describe("one item per thing to resolve", () => {
  it("splits each rule's words, so each is confirmed on its own", () => {
    expect(flagsFor("Guaranteed results, pain-free. Our registered nurse.").map((f) => f.id)).toEqual([
      "promise:guaranteed results",
      "promise:pain-free",
      "credential:registered nurse",
    ]);
  });
});

describe("resolving the flags before go-live", () => {
  it("blocks go-live until every flag is confirmed with the client by a PM, and logs each", async () => {
    const { admin, id, health } = await builtWith("Guaranteed results. Our registered nurse.");
    const names = new Map<string, string>();
    let view = await loadHealthFlags(h.db, id, names);
    expect(healthChecklistItem(health, view!.flags)).toMatchObject({ ok: false, blocksGoLive: true, detail: expect.stringMatching(/^2 to fix or confirm with the client/) });

    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(confirmHealthFlag(h.ctx, seo.viewer, id, "promise:guaranteed results", "ok")).rejects.toThrow(PermissionError);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await confirmHealthFlag(h.ctx, pm.viewer, id, "promise:guaranteed results", "The owner offers a written guarantee; checked by phone.");
    await expect(confirmHealthFlag(h.ctx, pm.viewer, id, "promise:guaranteed results", "again")).rejects.toThrow("already confirmed");
    await expect(confirmHealthFlag(h.ctx, pm.viewer, id, "promise:cure", "x")).rejects.toThrow("isn't on the newest build");

    view = await loadHealthFlags(h.db, id, names);
    expect(healthChecklistItem(health, view!.flags).detail).toMatch(/^1 to fix or confirm with the client \(1 confirmed\)/);
    await confirmHealthFlag(h.ctx, pm.viewer, id, "credential:registered nurse", "Licence RN 12345 seen.");
    view = await loadHealthFlags(h.db, id, names);
    expect(healthChecklistItem(health, view!.flags)).toMatchObject({ ok: true, detail: "All 2 confirmed with the client" });

    const logs = (await h.db.select().from(activityLog)).filter((l) => l.action === "health.flag_confirmed");
    expect(logs.map((l) => (l.valueAfter as { found: string }).found)).toEqual(["Guaranteed results", "registered nurse"]);
  });

  it("counts a flag gone from a newer build as fixed, and keeps a confirmation for the same words", async () => {
    const { admin, id, health } = await builtWith("Guaranteed results. Pain-free.");
    await confirmHealthFlag(h.ctx, admin.viewer, id, "promise:pain-free", "Client's own wording, confirmed.");
    await h.db.insert(siteBuild).values({ projectId: id, version: 2, status: "done", pages: [], fileCount: 1, checks: [{ ...health, flags: flagsFor("Pain-free.") }] });
    const view = await loadHealthFlags(h.db, id, new Map());
    expect(view).toMatchObject({ version: 2 });
    expect(view!.flags.map((f) => [f.id, Boolean(f.confirmed)])).toEqual([["promise:pain-free", true]]);
    expect(healthChecklistItem(health, view!.flags).ok).toBe(true);
  });

  it("shows the flags on the Build page with the checklist item, and deleting the project removes the confirmations", async () => {
    const { admin, id } = await builtWith("Guaranteed results.");
    await confirmHealthFlag(h.ctx, admin.viewer, id, "promise:guaranteed results", "Checked with the owner.");
    state.user = admin.viewer;
    const { default: BuildPage } = await import("@/app/(app)/projects/[id]/build/page");
    const html = renderToStaticMarkup(await BuildPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ part: "check" }) }));
    expect(html).toContain("Health and beauty rules");
    expect(html).toContain("All 1 confirmed with the client");
    expect(html).toContain("Confirmed with the client by Test Admin");

    await deleteProject(h.ctx, admin.viewer, id, { confirmName: "Glow Med Spa", reason: "Test project, removing it" });
    expect(await h.db.select().from(healthFlagConfirmation).where(eq(healthFlagConfirmation.projectId, id))).toEqual([]);
  });
});
