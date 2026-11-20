import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { user: unknown } = { user: null };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/admin/failures",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));

import { setDbForTesting } from "@tawd/core/db";
import { jobFailure } from "@tawd/core/schema";
import FailedJobsPage from "@/app/(app)/admin/failures/page";
import { createProject } from "@/lib/projects";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db);
});
afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

describe("Failed jobs page (audit F-040)", () => {
  it("refuses someone who is not an admin", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    state.user = pm.viewer;
    await expect(FailedJobsPage()).rejects.toThrow("redirect /projects");
  });

  it("lists failures newest first with the project's name and the stack behind a details", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const projectId = await createProject(h.ctx, admin.viewer, {
      trade: "well_and_pump", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [], clientName: "Pat Rivera",
    });
    await h.db.insert(jobFailure).values([
      { queue: "q", jobName: "older", label: "Older thing", errorClass: "Error", message: "first", occurredAt: new Date("2026-11-01T10:00:00Z") },
      { queue: "q", jobName: "newer", projectId, label: "Newer thing", errorClass: "TypeError", message: "second", stack: "TypeError: second\n    at x", occurredAt: new Date("2026-11-02T10:00:00Z") },
    ]);
    const html = renderToStaticMarkup(await FailedJobsPage());
    expect(html.indexOf("Newer thing")).toBeLessThan(html.indexOf("Older thing"));
    expect(html).toContain("Pat Rivera");
    expect(html).toContain("<details>");
    expect(html).toContain("TypeError: second");
  });
});

describe("worker wiring", () => {
  it("every handler that logs a failure also records it", () => {
    const lines = readFileSync(new URL("../../../worker/src/index.ts", import.meta.url), "utf8").split("\n");
    const logged = lines.map((l, i) => ({ l, i })).filter(({ l }) => /console\.error\(`.* failed: \$\{/.test(l));
    expect(logged.length).toBeGreaterThan(25);
    for (const { l, i } of logged) {
      expect(lines.slice(i, i + 3).join("\n"), l.trim()).toContain("recordFailure(");
    }
  });
});
