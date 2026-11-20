import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, designReadCorrection, figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { readAssetKeys, type PrepareStatus } from "@tawd/core/figma/read-assets";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { correctReadPicture, correctReadWord, loadPrepareStatus, loadSavedReadItems, newReadItems, preparePicturesAgain } from "@/lib/design-read-items";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E4b-2b: an admin corrects a word or a picture of the new design read, and
  prepares the read's pictures again for free. No browser and no AI: the
  saved read is written by hand.
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

const HERO = { x: 0, y: 200, w: 1000, h: 400 };
const LOGO = { x: 40, y: 20, w: 120, h: 60 };
const TITLE = { x: 200, y: 30, w: 300, h: 40 };
const BLUR = { x: 200, y: 90, w: 400, h: 50 };

async function saveRead(id: string, version: string, runId: string) {
  const read = {
    runId,
    width: 1000,
    height: 1200,
    colours: [],
    notes: [],
    bands: [
      {
        band: { name: "Header", role: "header", top: 0, bottom: 120 },
        words: [
          { text: "Pat Rivera", role: "heading", box: TITLE },
          { text: "Plumbing & Heatlng", role: "paragraph", box: BLUR, unsure: true },
        ],
        points: [],
        fonts: [],
        pictures: [{ id: "a1", kind: "photo", box: LOGO }],
        notes: [],
      },
      {
        band: { name: "Hero", role: "band", top: 120, bottom: 700 },
        words: [],
        points: [],
        fonts: [],
        pictures: [{ id: "a2", kind: "photo", box: HERO }],
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
  return { admin, id, version, runId };
}

describe("reading the saved read's words and pictures", () => {
  it("lists every word and picture with the band it sits in", async () => {
    const { id, version } = await lane2WithRead();
    const saved = await loadSavedReadItems(id, version);
    expect(saved?.words.map((w) => [w.text, w.band])).toEqual([
      ["Pat Rivera", "Header"],
      ["Plumbing & Heatlng", "Header"],
    ]);
    expect(saved?.pictures.map((p) => [p.id, p.band])).toEqual([
      ["a1", "Header"],
      ["a2", "Hero"],
    ]);
    expect(saved?.words[1]!.unsure).toBe(true);
  });

  it("gives nothing when there is no saved read", async () => {
    const { id } = await lane2WithRead();
    expect(await loadSavedReadItems(id, "another-upload")).toBeNull();
  });
});

describe("correcting a word", () => {
  it("saves the correction, logs it, and shows the word corrected", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await correctReadWord(h.ctx, admin.viewer, id, { anchor: BLUR, change: { text: "Plumbing & Heating" }, runId });

    const rows = await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe("word");
    expect(rows[0]!.anchor).toEqual(BLUR);

    const items = await newReadItems(h.db as Database, id, version);
    expect(items?.words[1]!.text).toBe("Plumbing & Heating");
    expect(items?.words[1]!.unsure).toBe(false);
    expect(items?.words[1]!.corrected).not.toBeNull();
    // The other word is untouched.
    expect(items?.words[0]!.corrected).toBeNull();

    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    const entry = log.find((e) => e.action === "figma.new_read_word_corrected");
    expect(entry).toBeTruthy();
    expect((entry!.valueBefore as { word: { text: string } }).word.text).toBe("Plumbing & Heatlng");
    expect((entry!.valueAfter as { word: { text: string } }).word.text).toBe("Plumbing & Heating");
  });

  it("refuses anyone who is not an admin", async () => {
    const { admin, id, runId } = await lane2WithRead();
    const plain = await seedUser(h, admin.viewer, { email: "pm@example.com", roles: ["pm"] });
    await expect(correctReadWord(h.ctx, plain.viewer, id, { anchor: BLUR, change: { text: "No" }, runId })).rejects.toThrow(/admin/i);
    expect(await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id))).toHaveLength(0);
  });

  it("refuses a project that is not Lane 2", async () => {
    const one = await lane2WithRead("lane_1");
    await expect(correctReadWord(h.ctx, one.admin.viewer, one.id, { anchor: BLUR, change: { text: "No" }, runId: one.runId })).rejects.toThrow(/Lane 2/);
    expect(await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, one.id))).toHaveLength(0);
  });

  it("refuses a form opened on an earlier read", async () => {
    const { admin, id, runId } = await lane2WithRead();
    await expect(correctReadWord(h.ctx, admin.viewer, id, { anchor: BLUR, change: { text: "Hi" }, runId: `${runId}-old` })).rejects.toThrow(/read again/i);
    expect(await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id))).toHaveLength(0);
  });

  it("refuses an anchor that is not a word of the saved read, and a change that does nothing", async () => {
    const { admin, id, runId } = await lane2WithRead();
    await expect(correctReadWord(h.ctx, admin.viewer, id, { anchor: { x: 1, y: 1, w: 2, h: 2 }, change: { text: "Hi" }, runId })).rejects.toThrow(/no longer in the read/i);
    await expect(correctReadWord(h.ctx, admin.viewer, id, { anchor: TITLE, change: { text: "Pat Rivera" }, runId })).rejects.toThrow(/Nothing was changed/);
  });
});

describe("correcting a picture", () => {
  it("changes the kind and logs it", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await correctReadPicture(h.ctx, admin.viewer, id, { anchor: LOGO, change: { kind: "logo" }, runId });
    const items = await newReadItems(h.db as Database, id, version);
    expect(items?.pictures[0]!.kind).toBe("logo");
    expect(items?.pictures[1]!.kind).toBe("photo");
    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(log.some((e) => e.action === "figma.new_read_picture_corrected")).toBe(true);
  });

  it("says why, rather than 'nothing was changed', when two things sit in exactly the same place", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    // A background and a photo drawn over exactly the same region: neither is "the" one.
    const read = JSON.parse((await r2.get(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`))!.toString("utf8")) as {
      bands: { pictures: { id: string; kind: string; box: typeof HERO }[] }[];
    };
    read.bands[1]!.pictures.push({ id: "a3", kind: "background", box: HERO });
    await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`, Buffer.from(JSON.stringify(read)));

    await expect(correctReadPicture(h.ctx, admin.viewer, id, { anchor: HERO, change: { kind: "logo" }, runId })).rejects.toThrow(/same place/i);
    expect(await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id))).toHaveLength(0);
  });

  it("refuses a box that would leave the design, and saves nothing", async () => {
    const { admin, id, runId } = await lane2WithRead();
    await expect(correctReadPicture(h.ctx, admin.viewer, id, { anchor: LOGO, change: { box: { x: 950, y: 20, w: 120, h: 60 } }, runId })).rejects.toThrow(/inside the design/i);
    expect(await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id))).toHaveLength(0);
  });
});

describe("preparing the pictures again", () => {
  it("queues the free job, writes its status, and logs it", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await preparePicturesAgain(h.ctx, admin.viewer, id, version, runId);

    expect(queued).toHaveLength(1);
    expect(queued[0]!.name).toBe("design-read-pictures");
    expect(queued[0]!.data).toMatchObject({ projectId: id, version, runId, page: 1 });

    const status = await loadPrepareStatus(id, version, runId);
    expect(status?.status.state).toBe("queued");
    expect(status?.status.attempt).toBe(queued[0]!.data.attempt);

    const log = await h.db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(log.some((e) => e.action === "figma.new_read_pictures_prepared")).toBe(true);
  });

  it("refuses a second press while one is running, and allows it once that one has gone quiet", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await preparePicturesAgain(h.ctx, admin.viewer, id, version, runId);
    await expect(preparePicturesAgain(h.ctx, admin.viewer, id, version, runId)).rejects.toThrow(/already being prepared/i);
    expect(queued).toHaveLength(1);

    // The same attempt, but with no news for longer than the limit: it counts as stopped.
    const key = readAssetKeys(id, version, 1, runId).status;
    const stale = JSON.parse((await r2.get(key))!.toString("utf8")) as PrepareStatus;
    stale.updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await r2.put(key, Buffer.from(JSON.stringify(stale)));
    await preparePicturesAgain(h.ctx, admin.viewer, id, version, runId);
    expect(queued).toHaveLength(2);
    expect(queued[1]!.data.attempt).not.toBe(queued[0]!.data.attempt);
  });

  it("refuses anyone who is not an admin, and a read that is no longer the saved one", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    const plain = await seedUser(h, admin.viewer, { email: "pm@example.com", roles: ["pm"] });
    await expect(preparePicturesAgain(h.ctx, plain.viewer, id, version, runId)).rejects.toThrow(/admin/i);
    await expect(preparePicturesAgain(h.ctx, admin.viewer, id, version, `${runId}-old`)).rejects.toThrow(/read again/i);
    expect(queued).toHaveLength(0);
  });

  it("says the queue is the problem, and does not leave the status saying queued, when the queue refuses", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    setQueueForTesting({
      add: async () => {
        throw new Error("no queue");
      },
      getJob: async () => null,
    });
    await expect(preparePicturesAgain(h.ctx, admin.viewer, id, version, runId)).rejects.toThrow(/queue isn't answering/i);
    const status = await loadPrepareStatus(id, version, runId);
    expect(status?.status.state).toBe("failed");
  });
});
