import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
  A concept waits for the study of the client's reference sites (found 30
  September 2026 while getting Nora Beagle Site ready): the study runs on
  another queue, so a concept could start first and be built without the
  brief that was paid for.
*/

import { eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { likedSiteShot } from "@tawd/core/schema";
import { createProject } from "@/lib/projects";
import { waitForReferenceStudies } from "../../../worker/src/pipeline";
import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
});
afterEach(async () => {
  setDbForTesting(null);
  await h.close();
});

async function project() {
  const admin = await seedAdmin(h);
  return createProject(h.ctx, admin.viewer, { clientName: "Nora Beagle Site", trade: "home_services", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 1, status: "mockups", memberUserIds: [] });
}

describe("a concept and the reference sites' study", () => {
  it("doesn't wait when nothing is being studied", async () => {
    const id = await project();
    await h.db.insert(likedSiteShot).values({ projectId: id, url: "https://example.com", status: "done", briefStatus: "done" } as never);
    expect(await waitForReferenceStudies(h.db as never, id, { sleep: async () => { throw new Error("should not wait"); } })).toBe("none");
  });

  it("waits while a study is queued or working, then builds with it", async () => {
    const id = await project();
    const [shot] = await h.db.insert(likedSiteShot).values({ projectId: id, url: "https://example.com", status: "done", briefStatus: "queued" } as never).returning();
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) await h.db.update(likedSiteShot).set({ briefStatus: "working" }).where(eq(likedSiteShot.id, shot!.id));
      if (polls === 3) await h.db.update(likedSiteShot).set({ briefStatus: "done" }).where(eq(likedSiteShot.id, shot!.id));
    };
    expect(await waitForReferenceStudies(h.db as never, id, { sleep, pollMs: 1000, timeoutMs: 60_000 })).toBe("done");
    expect(polls).toBe(3);
  });

  it("gives up after the limit and builds with what is there", async () => {
    const id = await project();
    await h.db.insert(likedSiteShot).values({ projectId: id, url: "https://example.com", status: "done", briefStatus: "working" } as never);
    let polls = 0;
    expect(await waitForReferenceStudies(h.db as never, id, { sleep: async () => void (polls += 1), pollMs: 1000, timeoutMs: 5000 })).toBe("timed_out");
    expect(polls).toBe(5);
  });
});
