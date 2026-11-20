import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Every stage page for every lane (Jason, 29 September 2026: Nora Beagle
  Site's "Move to Build" opened "Page not found"). The cause was the Docker
  ignore rules dropping every folder named "build", the Build page's too;
  so the image's files are checked here, and each stage page is shown for
  each lane at each status: never "not found", and a locked stage says why
  and what to do next.
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

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { project as projectTable } from "@tawd/core/schema";
import BuildPage from "@/app/(app)/projects/[id]/build/page";
import ContentPage from "@/app/(app)/projects/[id]/content/page";
import { createProject } from "@/lib/projects";
import { STAGES, lockedStage, stageHref } from "@/lib/stages";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});
afterEach(async () => {
  state.user = null;
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

describe("the image keeps every page of the app", () => {
  it("drops no source file of the app, the worker or core (\"**/build\" once dropped the Build page)", () => {
    const root = path.resolve(__dirname, "../../../..");
    const patterns = fs
      .readFileSync(path.join(root, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
    const toRegex = (p: string) => {
      const body = p
        .replace(/\/$/, "")
        .split("/")
        .map((part) => (part === "**" ? "(?:.*/)?" : `${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}/`))
        .join("")
        .replace(/\/$/, "");
      return new RegExp(`^${body}(?:/|$)`);
    };
    const rules = patterns.map(toRegex);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    for (const src of ["apps/web/src", "apps/worker/src", "packages/core/src"]) walk(path.join(root, src));
    const dropped = files.filter((f) => !/\.(md)$/.test(f) && rules.some((r) => r.test(f)));
    expect(dropped).toEqual([]);
    // The rule that caused it is gone for good.
    expect(patterns).not.toContain("**/build");
  });
});

describe("stage pages for every lane", () => {
  const lanes = [
    { lane: "lane_1", laneOption: null, conceptCount: 3 },
    { lane: "lane_2", laneOption: "a", conceptCount: null },
    { lane: "lane_2", laneOption: "b", conceptCount: 1 },
  ] as const;
  const statuses = ["intake", "mockups", "content", "build", "qa", "live", "paused"] as const;

  it("says why a stage is locked and what to do next, with a link to where the work is", () => {
    const id = "p1";
    expect(lockedStage({ projectId: id, status: "content", lane: "lane_1", stage: "build" })).toEqual({
      why: "Build & preview unlocks after the client approves the copy.",
      next: "The project is at Content: finish it there first.",
      href: "/projects/p1/content",
      label: "Go to Content",
    });
    expect(lockedStage({ projectId: id, status: "build", lane: "lane_1", stage: "build" })).toBeNull();
    expect(lockedStage({ projectId: id, status: "mockups", lane: "lane_2", stage: "build" })).toMatchObject({ href: "/projects/p1/mockups", why: expect.stringContaining("approves the preview") });
    expect(lockedStage({ projectId: id, status: "build", lane: "lane_2", stage: "content" })).toMatchObject({ href: "/projects/p1/mockups", why: expect.stringContaining("no Content step") });
    expect(lockedStage({ projectId: id, status: "paused", lane: "lane_1", stage: "build" })).toMatchObject({ why: "This project is paused." });
    // QA and Live have no pages of their own: their links are the project page.
    expect(STAGES.map((s) => stageHref(id, s))).toEqual(["/projects/p1/intake", "/projects/p1/mockups", "/projects/p1/content", "/projects/p1/build", "/projects/p1", "/projects/p1"]);
  });

  it("opens Build and Content for each lane at each status: never \"not found\"; locked ones say so", async () => {
    const admin = await seedAdmin(h);
    state.user = admin.viewer;
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Nora Beagle Site", trade: "photography", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    for (const l of lanes) {
      for (const status of statuses) {
        await h.db.update(projectTable).set({ lane: l.lane, laneOption: l.laneOption, conceptCount: l.conceptCount, status }).where(eq(projectTable.id, id));
        for (const [stage, Page] of [["build", BuildPage], ["content", ContentPage]] as const) {
          const where = `${l.lane}${l.laneOption ? `/${l.laneOption}` : ""} at ${status}, ${stage}`;
          let html = "";
          try {
            html = renderToStaticMarkup((await Page({ params: Promise.resolve({ id }) })) as React.ReactElement);
          } catch (error) {
            throw new Error(`${where}: ${(error as Error).message}`);
          }
          const lock = lockedStage({ projectId: id, status, lane: l.lane, stage });
          // Lane 1 at Design, on Content: keywords and the page plan can start early, so one friendly line and no lock card.
          if (l.lane === "lane_1" && status === "mockups" && stage === "content") {
            expect(html, where).toContain("You&#x27;re early");
            expect(html, where).not.toContain("Not yet: this stage is locked");
          } else if (lock) {
            expect(html, where).toContain("Not yet: this stage is locked");
            expect(html, where).toContain(lock.why.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
            expect(html, where).toContain(`href="${lock.href}"`);
          } else expect(html, where).not.toContain("Not yet: this stage is locked");
        }
      }
    }
  }, 240_000);
});
