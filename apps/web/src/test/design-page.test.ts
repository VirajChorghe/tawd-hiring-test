import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { readPageKeys, type PageBuildStatus } from "@tawd/core/figma/read-page";
import { readAssetKeys } from "@tawd/core/figma/read-assets";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { estimateDesignPage, pageBuildView, startDesignPageBuild } from "@/lib/design-page";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E5a: an admin builds one page from a finished read. One paid call, so the
  estimate is shown first, only the latest attempt runs, and the page is
  written under the read it came from. No AI and no browser here: the job
  itself is the worker's, and what is checked is everything around it.
*/

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: Record<string, unknown> }[] = [];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({
    add: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data });
      return undefined;
    },
    getJob: async () => null,
  });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

async function saveRead(id: string, version: string, runId: string) {
  const read = {
    runId,
    width: 1000,
    height: 800,
    colours: [],
    notes: [],
    bands: [
      {
        band: { name: "Header", role: "header", top: 0, bottom: 120 },
        words: [{ text: "Pat Rivera", role: "heading", box: { x: 200, y: 30, w: 300, h: 40 } }],
        points: [],
        fonts: [],
        pictures: [],
        notes: [],
      },
    ],
  };
  await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`, Buffer.from(JSON.stringify(read)));
}

async function lane2WithRead(lane: "lane_2" | "lane_1" = "lane_2") {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Client",
    trade: "plumbing",
    tier: "growth",
    lane,
    laneOption: lane === "lane_2" ? "a" : null,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  } as never);
  const version = "upload-1";
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
  const runId = `design-read-${id}-1700000000000`;
  await saveRead(id, version, runId);
  await savePictures(id, version, runId);
  return { admin, id, version, runId };
}

/* The read's pictures, prepared. A build is refused without them (standing rule 9). */
async function savePictures(id: string, version: string, runId: string, error: string | null = null) {
  const sheet = { runId, version, page: 1, preparedAt: "2026-11-15T10:00:00.000Z", assets: [], error };
  await r2.put(readAssetKeys(id, version, 1, runId).list, Buffer.from(JSON.stringify(sheet)));
}

const statusOf = async (id: string, version: string, runId: string): Promise<PageBuildStatus | null> => {
  const bytes = await r2.get(readPageKeys(id, version, 1, runId).status);
  return bytes ? (JSON.parse(bytes.toString("utf8")) as PageBuildStatus) : null;
};

describe("what a build is expected to cost", () => {
  it("is one call's worth, and says it is a guess until one has run", async () => {
    const estimate = await estimateDesignPage(h.db as Database);
    expect(estimate.cost).toBeGreaterThan(0);
    expect(estimate.measured).toBe(false);
    expect(estimate.label).toMatch(/one call that sees the whole design/);
    expect(estimate.label).toMatch(/first guess until a real build has run/);
  });
});

describe("what the screen is told", () => {
  it("offers a build once a read is saved, and says none has been built", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    const view = await pageBuildView(h.db as Database, admin.viewer, id);
    expect(view.version).toBe(version);
    expect(view.runId).toBe(runId);
    expect(view.built).toBe(false);
    expect(view.estimate).not.toBeNull();
  });

  it("offers nothing at all to someone who is not an admin", async () => {
    const { admin, id } = await lane2WithRead();
    const member = await seedUser(h, admin.viewer, { email: "designer@example.com", roles: ["web_designer"] });
    const view = await pageBuildView(h.db as Database, member.viewer, id);
    expect(view).toMatchObject({ version: null, runId: null, estimate: null, built: false });
  });

  it("offers no build when the design has not been read yet", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Test Client",
      trade: "plumbing",
      tier: "growth",
      lane: "lane_2",
      laneOption: "a",
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    } as never);
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", fileName: "design.pdf", importStatus: "done" });
    const view = await pageBuildView(h.db as Database, admin.viewer, id);
    expect(view.runId).toBeNull();
    expect(view.estimate).toBeNull();
  });

  it("says a page is built once one is saved", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await r2.put(readPageKeys(id, version, 1, runId).html, Buffer.from("<!doctype html><html></html>"));
    expect((await pageBuildView(h.db as Database, admin.viewer, id)).built).toBe(true);
  });
});

describe("starting a build", () => {
  it("writes the status as queued before the job, queues it, and logs it", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await startDesignPageBuild(h.ctx, admin.viewer, id);

    const status = await statusOf(id, version, runId);
    expect(status?.state).toBe("queued");
    expect(status?.runId).toBe(runId);
    expect(status?.estimate).toBeGreaterThan(0);
    expect(status?.flags).toEqual([]);
    expect(status?.problems).toEqual([]);

    expect(queued).toHaveLength(1);
    expect(queued[0]!.name).toBe("design-read-page");
    expect(queued[0]!.data).toMatchObject({ projectId: id, version, page: 1, runId, attempt: status!.attempt });

    const logged = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(logged.some((row) => row.action === "figma.new_page_build_started")).toBe(true);
  });

  it("refuses anyone who is not an admin, and queues nothing", async () => {
    const { admin, id } = await lane2WithRead();
    const member = await seedUser(h, admin.viewer, { email: "designer@example.com", roles: ["web_designer"] });
    await expect(startDesignPageBuild(h.ctx, member.viewer, id)).rejects.toThrow(/only an admin/i);
    expect(queued).toHaveLength(0);
  });

  it("refuses a project that is not Lane 2", async () => {
    const { admin, id } = await lane2WithRead("lane_1");
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/Lane 2/);
    expect(queued).toHaveLength(0);
  });

  it("refuses when the design has not been read yet", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Test Client",
      trade: "plumbing",
      tier: "growth",
      lane: "lane_2",
      laneOption: "a",
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    } as never);
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: "upload-1", source: "upload", fileName: "design.pdf", importStatus: "done" });
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/Read the design with the new read first/);
    expect(queued).toHaveLength(0);
  });

  it("refuses a second press while one is running, so one read is never built twice at once", async () => {
    const { admin, id } = await lane2WithRead();
    await startDesignPageBuild(h.ctx, admin.viewer, id);
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/already being built/i);
    expect(queued).toHaveLength(1);
  });

  it("lets a build that has gone quiet be started again, under a new attempt", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await startDesignPageBuild(h.ctx, admin.viewer, id);
    const first = await statusOf(id, version, runId);

    /*
      Past PAGE_BUILD_STALE_MS, so it counts as stopped. That limit is
      deliberately longer than the worker's own 20-minute lock on the job:
      a build is silent for as long as its one call takes, and calling a
      live one "stopped" invites a second press and a second bill.
    */
    const stale = new Date(Date.now() - 26 * 60 * 1000).toISOString();
    await r2.put(readPageKeys(id, version, 1, runId).status, Buffer.from(JSON.stringify({ ...first, state: "working", updatedAt: stale })));

    await startDesignPageBuild(h.ctx, admin.viewer, id);
    const second = await statusOf(id, version, runId);
    expect(second?.state).toBe("queued");
    expect(second?.attempt).not.toBe(first!.attempt);
    expect(queued).toHaveLength(2);
  });

  /*
    Standing rule 9: never spend when the result will not be usable and a
    free step would put it right. With no pictures the build would come
    back with every one of them missing, and preparing them again costs
    nothing.
  */
  it("refuses when the read's pictures have not been prepared, and points at the free step", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, {
      clientName: "Test Client",
      trade: "plumbing",
      tier: "growth",
      lane: "lane_2",
      laneOption: "a",
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    } as never);
    const version = "upload-1";
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
    await saveRead(id, version, `design-read-${id}-1700000000000`);
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/Prepare the pictures again/);
    expect(queued).toHaveLength(0);
  });

  it("refuses when preparing the read's pictures failed", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await savePictures(id, version, runId, "could not be prepared");
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/Prepare the pictures again/);
    expect(queued).toHaveLength(0);
  });

  it("says nothing was spent when the queue will not take the job", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    setQueueForTesting({
      add: async () => {
        throw new Error("no queue");
      },
      getJob: async () => null,
    });
    await expect(startDesignPageBuild(h.ctx, admin.viewer, id)).rejects.toThrow(/queue isn't answering/i);
    const status = await statusOf(id, version, runId);
    expect(status?.state).toBe("failed");
    expect(status?.error).toMatch(/Nothing was spent/);
  });
});
