import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { aiCall, figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { DESIGN_READ_JOB } from "@tawd/core/queue";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { QUEUE_ASK_MS, bandsGuess, estimateNewRead, newReadView, pngSize, startNewDesignRead } from "@/lib/design-read-new";

import { runDesignReadJob } from "../../../worker/src/design-read-job";
import { writePng } from "../../../worker/src/design-assets";
import { BAND_LIST_SYSTEM } from "../../../worker/src/design-read";
import { blank } from "../../../worker/src/design-pixels";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E4, the new design read, end to end with a stand-in for Claude (no AI
  spending) and the real browser for the pictures: a made-up page of four
  flat bands, the AI's replies scripted.
*/

// The browser library is the worker's, as in design-checks.test.ts.
const require = createRequire(import.meta.url);
type Browser = import("../../../worker/node_modules/playwright-core").Browser;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);

const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

let h: Harness;
let r2: FakeR2;
let queued: { name: string; data: Record<string, unknown> }[];
let browser: Browser;

beforeAll(async () => {
  if (!hasChrome) return;
  const { chromium } = require("../../../worker/node_modules/playwright-core");
  browser = await chromium.launch({ executablePath: CHROME });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  r2 = new FakeR2();
  setStorageForTesting(r2);
  queued = [];
  setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async () => null });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* A page 1000 x 1200: header 0-120 navy, hero 120-620 blue, services 620-1000 white, footer 1000-1200 dark grey. */
const BANDS: [number, number, [number, number, number]][] = [
  [0, 120, [10, 30, 70]],
  [120, 620, [40, 90, 200]],
  [620, 1000, [255, 255, 255]],
  [1000, 1200, [40, 40, 40]],
];
/** The page, or the same page `tall` times taller (every band edge times `tall`). */
async function framePng(tall = 1): Promise<Buffer> {
  const page = await browser.newPage();
  const img = blank(1000, 1200 * tall);
  for (let y = 0; y < 1200 * tall; y += 1) {
    const colour = BANDS.find(([top, bottom]) => y >= top * tall && y < bottom * tall)![2];
    for (let x = 0; x < 1000; x += 1) img.data.set([...colour, 255], (y * 1000 + x) * 4);
  }
  const png = Buffer.from(await writePng(page, img), "base64");
  await page.close();
  return png;
}

/**
  A stand-in for Claude: the band list (first with a gap, then right), then each band by its name. Like
  the real model, it answers the band list in the pixels of the picture it was sent (the size the first
  message states), for a page `tall` times the 1200 px one.
*/
function scriptedClient(tall = 1) {
  const sent: { system: string; user: string }[] = [];
  let listCalls = 0;
  const reply = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 } });
  const client = {
    messages: {
      stream: (params: { system: { text: string }[]; messages: { content: unknown }[] }) => ({
        finalMessage: async () => {
          const system = params.system[0]!.text;
          const last = params.messages[params.messages.length - 1]!.content;
          const user = typeof last === "string" ? last : (last as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join(" ");
          sent.push({ system, user });
          if (system === BAND_LIST_SYSTEM) {
            listCalls += 1;
            const first = params.messages[0]!.content as { type: string; text?: string }[];
            const seen = Number(/This picture is \d+ by (\d+)/.exec(first.map((b) => b.text ?? "").join(" "))?.[1]);
            const k = (seen / (1200 * tall)) * tall;
            // First reply: a 40 px gap between the hero and the services. Second: right, but the header's edge 4 px off (code snaps it).
            const bands =
              listCalls === 1
                ? [
                    { name: "Header", role: "header", top: 0, bottom: 116 },
                    { name: "Hero", role: "band", top: 116, bottom: 600 },
                    { name: "Services", role: "band", top: 640, bottom: 1000 },
                    { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
                  ]
                : [
                    { name: "Header", role: "header", top: 0, bottom: 116 },
                    { name: "Hero", role: "band", top: 116, bottom: 620 },
                    { name: "Services", role: "band", top: 620, bottom: 1000 },
                    { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
                  ];
            const inPicture = bands.map((b) => ({ ...b, top: Math.round(b.top * k), bottom: Math.round(b.bottom * k) }));
            return reply(`Here:\n${JSON.stringify({ bands: inPicture })}`);
          }
          const name = /Band "([^"]+)"/.exec(user)?.[1];
          if (name === "Services")
            return reply(JSON.stringify({ words: [{ text: "W H AT W E D O", role: "label", box: [40, 30, 300, 20] }, { text: "Drain cleaning", role: "heading", box: [40, 80, 300, 40] }], points: [{ name: "background", x: 500, y: 200 }], fonts: [{ role: "heading", family: "Barlow" }], pictures: [{ id: "drain", kind: "icon", box: [40, 140, 40, 40], label: "Drain cleaning" }] }));
          return reply(JSON.stringify({ words: [{ text: `${name} words`, role: "heading", box: [40, 20, 200, 30] }], points: [{ name: "background", x: 10, y: 10 }], fonts: [], pictures: [] }));
        },
      }),
    },
  };
  return { client: client as never, sent };
}

async function lane2WithRead(tall = 1): Promise<{ admin: Awaited<ReturnType<typeof seedAdmin>>; id: string; version: string }> {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Pat Rivera", trade: "plumbing", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: 1, status: "intake", memberUserIds: [] });
  const version = "upload-1";
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
  await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/frames/page-1.png`, await framePng(tall));
  return { admin, id, version };
}

/** Starts the job the way the screen does: the status says "queued" with this start's runId first. */
async function runAsStarted(id: string, version: string, startedBy: string, client: never, runId = "run-1"): Promise<void> {
  const at = new Date().toISOString();
  await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`, Buffer.from(JSON.stringify({ state: "queued", runId, version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
  await runDesignReadJob({ projectId: id, startedByUserId: startedBy, version, page: 1, runId }, config, client, browser);
}

describe("the estimate", () => {
  it("guesses the bands from the page's height, and reads a PNG's size from its header", () => {
    expect(bandsGuess(4056)).toBe(11);
    expect(bandsGuess(500)).toBe(4);
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(1400, 16);
    png.writeUInt32BE(4056, 20);
    expect(pngSize(png)).toEqual({ width: 1400, height: 4056 });
    expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
  });

  it("counts one whole-page call and one per band, and says when it is a first guess", async () => {
    const estimate = await estimateNewRead(h.db as Database, 4056);
    expect(estimate.bands).toBe(11);
    expect(estimate.measured).toBe(false);
    expect(estimate.label).toMatch(/^About \$/);
    expect(estimate.label).toMatch(/a look at the whole page for its bands \(a second one if its band list doesn't cover the page\), then one look at each band \(about 11 for a page 4056px tall\)/);
    expect(estimate.label).toMatch(/a first guess/);
    expect(estimate.cost).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasChrome)("the new read, end to end (stand-in Claude, real browser)", () => {
  it("asks again when the band list leaves a gap, snaps edges, tidies words, measures colours, and records every call", async () => {
    const { admin, id, version } = await lane2WithRead();
    const { client, sent } = scriptedClient();
    await runAsStarted(id, version, admin.viewer.id, client);

    // Asked again once, naming the gap.
    const listCalls = sent.filter((s) => s.system === BAND_LIST_SYSTEM);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]!.user).toMatch(/A gap of 40 pixels/);

    const prefix = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/`;
    const read = JSON.parse((await r2.get(`${prefix}page-1.json`))!.toString("utf8"));
    // The header's edge, said 116, is snapped onto the colour change at 120.
    expect(read.bands.map((b: { band: { name: string; top: number; bottom: number } }) => [b.band.name, b.band.top, b.band.bottom])).toEqual([
      ["Header", 0, 120],
      ["Hero", 120, 620],
      ["Services", 620, 1000],
      ["Footer", 1000, 1200],
    ]);
    const services = read.bands[2];
    expect(services.words.map((w: { text: string }) => w.text)).toEqual(["WHAT WE DO", "Drain cleaning"]);
    // Every rejoined heading is said, so a person can check where the spaces went.
    expect(services.notes).toContain('Read the spaced capitals "W H AT W E D O" as "WHAT WE DO"; check the spacing.');
    expect(services.words[0].box).toEqual({ x: 40, y: 650, w: 300, h: 20 });
    expect(services.pictures[0]).toMatchObject({ id: "b3-drain", kind: "icon", label: "Drain cleaning" });
    expect(read.colours.find((c: { name: string }) => c.name === "Header: background").hex).toBe("#0a1e46");
    expect(read.colours.find((c: { name: string }) => c.name === "Services: background").hex).toBe("#ffffff");

    const status = JSON.parse((await r2.get(`${prefix}status.json`))!.toString("utf8"));
    expect(status).toMatchObject({ state: "done", version, page: 1, calls: 6, bands: 4, error: null });
    const calls = await h.db.select().from(aiCall).where(eq(aiCall.projectId, id));
    expect(calls.map((c) => c.scope).sort()).toEqual(["band", "band", "band", "band", "band_list", "band_list"]);
    expect(new Set(calls.map((c) => c.step))).toEqual(new Set(["design_read"]));

    // The admin sees it; nobody else does.
    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.result!.bands.map((b) => [b.name, b.words, b.pictures])).toEqual([
      ["Header", 1, 0],
      ["Hero", 1, 0],
      ["Services", 2, 1],
      ["Footer", 1, 0],
    ]);
    expect(view!.status!.state).toBe("done");
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    expect(await newReadView(h.db as Database, pm.viewer, id)).toBeNull();
  });

  // Fable's review of E4a: a page bigger than the model reads is sent smaller, and the band list is checked (and named back) in that picture's pixels.
  it("reads a tall page sent smaller: names the gap in the picture's own pixels and lands every band on the design", async () => {
    const { admin, id, version } = await lane2WithRead(3);
    const { client, sent } = scriptedClient(3);
    await runAsStarted(id, version, admin.viewer.id, client);
    const listCalls = sent.filter((s) => s.system === BAND_LIST_SYSTEM);
    expect(listCalls).toHaveLength(2);
    const sentHeight = Number(/from 0 to (\d+) in this picture's own pixels/.exec(listCalls[1]!.user)?.[1]);
    expect(sentHeight).toBeLessThan(3600);
    // The 120 px gap on the design is named in the smaller picture's pixels.
    const gap = Number(/A gap of (\d+) pixels/.exec(listCalls[1]!.user)?.[1]);
    expect(gap).toBe(Math.round(120 * (sentHeight / 3600)));
    // Nothing else is wrong with that list: a problem stated against the design's own height would be a false one.
    expect(listCalls[1]!.user).not.toMatch(/Nothing covers|3600/);
    const read = JSON.parse((await r2.get(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`))!.toString("utf8"));
    expect(read.bands.map((b: { band: { top: number; bottom: number } }) => [b.band.top, b.band.bottom])).toEqual([
      [0, 360],
      [360, 1860],
      [1860, 3000],
      [3000, 3600],
    ]);
    expect(read.notes.filter((n: string) => n.startsWith("Band list"))).toEqual([]);
  });

  it("fails with a reason, and spends nothing, when the upload's page picture is missing", async () => {
    const { admin, id, version } = await lane2WithRead();
    await r2.remove(`${projectStoragePrefix(id)}design-upload/${version}/frames/page-1.png`);
    const { client, sent } = scriptedClient();
    await expect(runAsStarted(id, version, admin.viewer.id, client)).rejects.toThrow(/no saved picture/);
    expect(sent).toHaveLength(0);
    const status = JSON.parse((await r2.get(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`))!.toString("utf8"));
    expect(status).toMatchObject({ state: "failed", calls: 0 });
    expect(status.error).toMatch(/no saved picture/);
  });
});

describe.skipIf(!hasChrome)("a job runs only while it is the latest start and has not begun before", () => {
  const statusOf = async (id: string, version: string) => JSON.parse((await r2.get(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`))!.toString("utf8"));
  const write = (id: string, version: string, status: Record<string, unknown>) =>
    r2.put(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`, Buffer.from(JSON.stringify({ version, page: 1, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null, ...status })));

  // A restart re-runs a lost job: it must not pay for the read again without anyone asking, however late it comes back.
  it.each([0, 45])("stops before any call when its own start is already working (news %i minutes old)", async (minutes) => {
    const { admin, id, version } = await lane2WithRead();
    const at = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    await write(id, version, { state: "working", runId: "run-1", startedAt: at, updatedAt: at, calls: 2, bands: 4 });
    const { client, sent } = scriptedClient();
    await runDesignReadJob({ projectId: id, startedByUserId: admin.viewer.id, version, page: 1, runId: "run-1" }, config, client, browser);
    expect(sent).toHaveLength(0);
    const status = await statusOf(id, version);
    expect(status).toMatchObject({ state: "failed", runId: "run-1", calls: 2 });
    expect(status.error).toMatch(/worker restarted during the read/);
  });

  // Fable's re-read: a start that waited so long the screen offered a new one is replaced, and never runs as well.
  it("stops without touching the status when a newer start replaced it", async () => {
    const { admin, id, version } = await lane2WithRead();
    const at = new Date().toISOString();
    await write(id, version, { state: "queued", runId: "run-2", startedAt: at, updatedAt: at });
    const { client, sent } = scriptedClient();
    await runDesignReadJob({ projectId: id, startedByUserId: admin.viewer.id, version, page: 1, runId: "run-1" }, config, client, browser);
    expect(sent).toHaveLength(0);
    expect(await statusOf(id, version)).toMatchObject({ state: "queued", runId: "run-2" });
  });

  it("does not run again once its start has finished", async () => {
    const { admin, id, version } = await lane2WithRead();
    const at = new Date().toISOString();
    await write(id, version, { state: "done", runId: "run-1", startedAt: at, updatedAt: at, finishedAt: at, calls: 6 });
    const { client, sent } = scriptedClient();
    await runDesignReadJob({ projectId: id, startedByUserId: admin.viewer.id, version, page: 1, runId: "run-1" }, config, client, browser);
    expect(sent).toHaveLength(0);
    expect(await statusOf(id, version)).toMatchObject({ state: "done", calls: 6 });
  });

  it("goes ahead from its own queued start", async () => {
    const { admin, id, version } = await lane2WithRead();
    const { client, sent } = scriptedClient();
    await runAsStarted(id, version, admin.viewer.id, client);
    expect(sent.length).toBeGreaterThan(0);
    expect(await statusOf(id, version)).toMatchObject({ state: "done", runId: "run-1" });
  });
});

describe.skipIf(!hasChrome)("the new read when the design changed meanwhile", () => {
  it("refuses, and spends nothing, when a newer upload replaced the one it was started for", async () => {
    const { admin, id, version } = await lane2WithRead();
    await h.db.update(figmaDesign).set({ fileKey: "upload-2" }).where(eq(figmaDesign.projectId, id));
    const { client, sent } = scriptedClient();
    await expect(runAsStarted(id, version, admin.viewer.id, client)).rejects.toThrow(/no longer the project's design/);
    expect(sent).toHaveLength(0);
  });
});

describe.skipIf(!hasChrome)("starting the new read", () => {
  it("is for an admin only, queues the job with the upload's version, and won't start twice", async () => {
    const { admin, id, version } = await lane2WithRead();
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(startNewDesignRead(h.ctx, pm.viewer, id)).rejects.toThrow(/Only an admin/);
    expect(queued).toHaveLength(0);

    await startNewDesignRead(h.ctx, admin.viewer, id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.name).toBe(DESIGN_READ_JOB);
    const runId = queued[0]!.data.runId as string;
    expect(queued[0]!.data).toEqual({ projectId: id, startedByUserId: admin.viewer.id, version, page: 1, runId });

    // The start itself marks the read queued, so a second start (another tab, a double click) is refused at once while its job waits.
    setQueueForTesting({ add: async (name, data) => void queued.push({ name, data: data as Record<string, unknown> }), getJob: async (jobId) => (jobId === runId ? { remove: async () => undefined, getState: async () => "waiting" } : null) });
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/already running/);
    expect(queued).toHaveLength(1);
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    expect(JSON.parse((await r2.get(statusKey))!.toString("utf8"))).toMatchObject({ state: "queued", runId, version, page: 1 });
  });

  it("lets a read that stopped without news for 30 minutes be run again, and says it stopped", async () => {
    const { admin, id, version } = await lane2WithRead();
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "working", version, page: 1, startedAt: old, updatedAt: old, finishedAt: null, calls: 3, inputTokens: 0, outputTokens: 0, bands: 4, error: null })));
    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.stalled).toBe(true);
    await startNewDesignRead(h.ctx, admin.viewer, id);
    expect(queued).toHaveLength(1);
  });

  // Fable's re-read: a read waiting its turn behind other work is never called stopped for waiting, however long.
  it("never calls a queued read stopped while its job waits in the queue, however long", async () => {
    const { admin, id, version } = await lane2WithRead();
    setQueueForTesting({ add: async () => undefined, getJob: async (jobId) => (jobId === "run-1" ? { remove: async () => undefined, getState: async () => "waiting" } : null) });
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const old = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "queued", runId: "run-1", version, page: 1, startedAt: old, updatedAt: old, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    expect((await newReadView(h.db as Database, admin.viewer, id))!.stalled).toBe(false);
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/already running/);
  });

  // Fable's third read: a queued read whose job is gone (lost from the queue, failed before it began) must not block a new start forever.
  it.each([
    { what: "no longer in the queue", job: null },
    { what: "failed before it began", job: { remove: async () => undefined, getState: async () => "failed" } },
  ])("lets a queued read whose job is $what be run again", async ({ job }) => {
    const { admin, id, version } = await lane2WithRead();
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const at = new Date().toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "queued", runId: "run-1", version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    const added: unknown[] = [];
    setQueueForTesting({ add: async (_name, data) => void added.push(data), getJob: async () => job });
    expect((await newReadView(h.db as Database, admin.viewer, id))!.stalled).toBe(true);
    await startNewDesignRead(h.ctx, admin.viewer, id);
    expect(added).toHaveLength(1);
  });

  it("does not offer a new start when the queue can't say where the job is", async () => {
    const { admin, id, version } = await lane2WithRead();
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const at = new Date().toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "queued", runId: "run-1", version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    setQueueForTesting({ add: async () => undefined, getJob: async () => { throw new Error("redis down"); } });
    expect((await newReadView(h.db as Database, admin.viewer, id))!.stalled).toBe(false);
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/already running/);
  });

  // Fable's fourth read: the queue's connection retries without end, so a down queue can hang rather than fail.
  it("does not hold the page up, or offer a new start, when the queue never answers", async () => {
    const { admin, id, version } = await lane2WithRead();
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const at = new Date().toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "queued", runId: "run-1", version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    setQueueForTesting({ add: async () => undefined, getJob: () => new Promise(() => undefined) });
    const started = Date.now();
    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(Date.now() - started).toBeLessThan(QUEUE_ASK_MS + 2000);
    expect(view!.stalled).toBe(false);
  }, 15_000);

  it("refuses while a read with fresh news is working", async () => {
    const { admin, id, version } = await lane2WithRead();
    const statusKey = `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
    const now = new Date().toISOString();
    await r2.put(statusKey, Buffer.from(JSON.stringify({ state: "working", version, page: 1, startedAt: now, updatedAt: now, finishedAt: null, calls: 1, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    expect((await newReadView(h.db as Database, admin.viewer, id))!.stalled).toBe(false);
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/already running/);
    expect(queued).toHaveLength(0);
  });

  it("says so in the status when the queue isn't answering", async () => {
    const { admin, id, version } = await lane2WithRead();
    setQueueForTesting({ add: async () => { throw new Error("redis down"); }, getJob: async () => null });
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/job queue isn't answering/);
    const status = JSON.parse((await r2.get(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`))!.toString("utf8"));
    expect(status).toMatchObject({ state: "failed" });
    expect(status.error).toMatch(/never started/);
  });

  it("needs a finished upload read to start from", async () => {
    const { admin, id } = await lane2WithRead();
    await h.db.update(figmaDesign).set({ importStatus: "working" }).where(eq(figmaDesign.projectId, id));
    await expect(startNewDesignRead(h.ctx, admin.viewer, id)).rejects.toThrow(/Read the uploaded design first/);
  });
});
