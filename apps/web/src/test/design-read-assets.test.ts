import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { figmaDesign } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { ASSET_FILE_NAME, isReadRunId, readAssetKeys, sheetFiles, type AssetSheet } from "@tawd/core/figma/read-assets";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { newReadView } from "@/lib/design-read-new";
import { assetFile } from "@/lib/design-read-assets";

import { RESTARTED_IN_PICTURES, runDesignReadJob } from "../../../worker/src/design-read-job";
import { writePng } from "../../../worker/src/design-assets";
import { MAX_DRAWN_OVER, OVER_AREA, PICTURES_FAILED, boundDrawnOver, setAssetWriteMsForTesting } from "../../../worker/src/design-read-assets";
import { BAND_LIST_SYSTEM } from "../../../worker/src/design-read";
import { blank } from "../../../worker/src/design-pixels";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E4b-1: after a new design read, the worker cuts every picture the read
  named out of the design and treats it by kind (E3), saves it under the
  read's own run, and the admin panel shows that sheet; a route serves the
  pictures. End to end with a stand-in for Claude (no AI spending) and the
  real browser for the pictures.
*/

const require = createRequire(import.meta.url);
type Browser = import("../../../worker/node_modules/playwright-core").Browser;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const hasChrome = fs.existsSync(CHROME);

const config: WorkerConfig = { databaseUrl: "unused", redisUrl: "unused", anthropicApiKey: "unused", model: "claude-opus-5-5", skillsDir: path.resolve(__dirname, "../../../../skills"), effort: "high" };

let h: Harness;
let r2: FakeR2;
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
  setQueueForTesting({ add: async () => undefined, getJob: async () => null });
});
afterEach(async () => {
  setQueueForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

/* A page 1000 x 1200: header navy, hero blue, services white, footer dark grey with a red logo at 40-120 x 1050-1090. */
const BANDS: [number, number, [number, number, number]][] = [
  [0, 120, [10, 30, 70]],
  [120, 620, [40, 90, 200]],
  [620, 1000, [255, 255, 255]],
  [1000, 1200, [40, 40, 40]],
];
async function framePng(): Promise<Buffer> {
  const page = await browser.newPage();
  const img = blank(1000, 1200);
  for (let y = 0; y < 1200; y += 1) {
    const colour = BANDS.find(([top, bottom]) => y >= top && y < bottom)![2];
    for (let x = 0; x < 1000; x += 1) {
      const logo = x >= 40 && x < 120 && y >= 1050 && y < 1090;
      img.data.set([...(logo ? [200, 30, 30] : colour), 255], (y * 1000 + x) * 4);
    }
  }
  const png = Buffer.from(await writePng(page, img), "base64");
  await page.close();
  return png;
}

/* A stand-in for Claude: the band list, then each band; the hero is a background with a headline drawn over it, the services have an icon, the footer a logo. */
function scriptedClient(heroOver: number[][] = [[100, 100, 400, 80]]) {
  const reply = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 } });
  const client = {
    messages: {
      stream: (params: { system: { text: string }[]; messages: { content: unknown }[] }) => ({
        finalMessage: async () => {
          const system = params.system[0]!.text;
          const last = params.messages[params.messages.length - 1]!.content;
          const user = typeof last === "string" ? last : (last as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join(" ");
          if (system === BAND_LIST_SYSTEM) {
            const first = params.messages[0]!.content as { type: string; text?: string }[];
            const seen = Number(/This picture is \d+ by (\d+)/.exec(first.map((b) => b.text ?? "").join(" "))?.[1]);
            const k = seen / 1200;
            const bands = [
              { name: "Header", role: "header", top: 0, bottom: 120 },
              { name: "Hero", role: "band", top: 120, bottom: 620 },
              { name: "Services", role: "band", top: 620, bottom: 1000 },
              { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
            ].map((b) => ({ ...b, top: Math.round(b.top * k), bottom: Math.round(b.bottom * k) }));
            return reply(JSON.stringify({ bands }));
          }
          const name = /Band "([^"]+)"/.exec(user)?.[1];
          const pictures =
            name === "Hero"
              ? [{ id: "hero", kind: "background", box: [0, 0, 1000, 500], drawnOver: heroOver }]
              : name === "Services"
                ? [{ id: "drain", kind: "icon", box: [40, 140, 40, 40], label: "Drain cleaning" }]
                : name === "Footer"
                  ? [{ id: "logo", kind: "logo", box: [30, 40, 100, 60] }]
                  : [];
          return reply(JSON.stringify({ words: [{ text: `${name} words`, role: "heading", box: [40, 20, 200, 30] }], points: [{ name: "background", x: 10, y: 10 }], fonts: [], pictures }));
        },
      }),
    },
  };
  return client as never;
}

async function lane2WithRead(): Promise<{ admin: Awaited<ReturnType<typeof seedAdmin>>; id: string; version: string }> {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Test Client", trade: "plumbing", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: 1, status: "intake", memberUserIds: [] });
  const version = "upload-1";
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
  await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/frames/page-1.png`, await framePng());
  return { admin, id, version };
}

const statusKey = (id: string, version: string) => `${projectStoragePrefix(id)}design-upload/${version}/read-v2/status.json`;
const resultKey = (id: string, version: string) => `${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`;
const runIdFor = (id: string, at: number) => `design-read-${id}-${at}`;

async function runAsStarted(id: string, version: string, startedBy: string, runId: string, client = scriptedClient()): Promise<void> {
  const at = new Date().toISOString();
  await r2.put(statusKey(id, version), Buffer.from(JSON.stringify({ state: "queued", runId, version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
  await runDesignReadJob({ projectId: id, startedByUserId: startedBy, version, page: 1, runId }, config, client, browser);
}

const isPng = (b: Buffer | null) => b !== null && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

describe("a read's run id and file names", () => {
  it("knows a run id of this project from any other", () => {
    expect(isReadRunId("p1", "design-read-p1-1700000000000")).toBe(true);
    expect(isReadRunId("p1", "design-read-p2-1700000000000")).toBe(false);
    expect(isReadRunId("p1", "design-read-p1-1700000000000/../x")).toBe(false);
    expect(isReadRunId("p1", "run-1")).toBe(false);
    expect(isReadRunId("p1", undefined)).toBe(false);
  });

  it("allows only the names the worker makes", () => {
    for (const ok of ["p1.png", "p12-hid3.png"]) expect(ASSET_FILE_NAME.test(ok)).toBe(true);
    for (const bad of ["list.json", "../p1.png", "p1.png/..", "p1.PNG", "x.png", "p1-hid.png"]) expect(ASSET_FILE_NAME.test(bad)).toBe(false);
  });

  it("lists only the files a sheet names that pass the rule", () => {
    const sheet = { assets: [{ file: "p1.png", patches: [{ hid: "p1-hid1.png" }] }, { file: "../evil", patches: [] }, { file: null, patches: [] }] } as unknown as AssetSheet;
    expect([...sheetFiles(sheet)].sort()).toEqual(["p1-hid1.png", "p1.png"]);
  });
});

/* The route's checks, on a sheet written by hand, so they run on every machine (no browser needed). */
describe("serving a read's pictures", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  async function withSheet() {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Test Client", trade: "plumbing", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: 1, status: "intake", memberUserIds: [] });
    const version = "upload-1";
    await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
    const runId = runIdFor(id, 1_700_000_000_000);
    const keys = readAssetKeys(id, version, 1, runId);
    const sheet: AssetSheet = { runId, version, page: 1, preparedAt: "2026-11-14T10:00:00Z", error: null, assets: [{ id: "b2-hero", kind: "background", box: { x: 0, y: 0, w: 10, h: 10 }, file: "p1.png", width: 10, height: 10, icon: null, patches: [{ box: { x: 1, y: 1, w: 2, h: 2 }, method: "blend", feather: 0, hid: "p1-hid1.png" }], transparentOn: null, fadedEdges: [], flags: [] }] };
    await r2.put(keys.list, Buffer.from(JSON.stringify(sheet)));
    await r2.put(keys.file("p1.png"), PNG);
    await r2.put(keys.file("p1-hid1.png"), PNG);
    await r2.put(keys.file("p9.png"), PNG); // there, under the name rule, but not on the sheet
    return { admin, id, version, runId, keys, sheet };
  }

  it("serves a listed picture, and what a patch hid, to an admin", async () => {
    const { admin, id, runId } = await withSheet();
    const db = h.db as Database;
    expect(await assetFile(db, admin.viewer, id, runId, "p1.png")).toEqual(PNG);
    expect(await assetFile(db, admin.viewer, id, runId, "p1-hid1.png")).toEqual(PNG);
  });

  it("refuses everyone but an admin, other projects' runs, and anything the sheet doesn't list", async () => {
    const { admin, id, runId } = await withSheet();
    const db = h.db as Database;
    const designer = await seedUser(h, admin.viewer, { email: "designer@example.com", roles: ["web_designer"] });
    expect(await assetFile(db, designer.viewer, id, runId, "p1.png")).toBeNull();
    expect(await assetFile(db, admin.viewer, id, runIdFor("someone-else", 1_700_000_000_000), "p1.png")).toBeNull();
    for (const name of ["p9.png", "p2.png", "list.json", "../status.json", "p1.png/..", ".."]) expect(await assetFile(db, admin.viewer, id, runId, name)).toBeNull();
    const other = await createProject(h.ctx, admin.viewer, { clientName: "Other Client", trade: "plumbing", tier: "growth", lane: "lane_2", laneOption: "a", conceptCount: 1, status: "intake", memberUserIds: [] });
    expect(await assetFile(db, admin.viewer, other, runId, "p1.png")).toBeNull();
  });

  it("still shows the read when its pictures' sheet can't be loaded", async () => {
    const { admin, id, version, runId, keys } = await withSheet();
    await r2.put(resultKey(id, version), Buffer.from(JSON.stringify({ runId, width: 10, height: 10, bands: [{ band: { name: "Hero", role: "band", top: 0, bottom: 10 }, words: [], pictures: [{}], notes: [] }], colours: [], notes: [] })));
    const get = r2.get.bind(r2);
    r2.get = async (key: string) => {
      if (key === keys.list) throw new Error("storage hiccup");
      return get(key);
    };
    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.result!.bands).toHaveLength(1);
    expect(view!.assets).toMatchObject({ runId, sheet: null, loadFailed: true });
  });

  it("after a worker restart during the picture step, says the read is complete and only its pictures are missing", async () => {
    const { admin, id, version, runId } = await withSheet();
    const at = new Date().toISOString();
    await r2.put(statusKey(id, version), Buffer.from(JSON.stringify({ state: "working", runId, version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 5, inputTokens: 0, outputTokens: 0, bands: 4, error: null, phase: "pictures" })));
    // The queue runs the job again after the restart; it stops before any call (no browser is needed).
    await runDesignReadJob({ projectId: id, startedByUserId: admin.viewer.id, version, page: 1, runId }, config, scriptedClient(), undefined as never);
    const status = JSON.parse(r2.objects.get(statusKey(id, version))!.toString("utf8")) as { state: string; error: string; phase?: string };
    expect(status).toMatchObject({ state: "failed", error: RESTARTED_IN_PICTURES, phase: "pictures" });
  });

  it("answers not found, never an error, for a project address that isn't an id", async () => {
    const { admin } = await withSheet();
    await expect(assetFile(h.db as Database, admin.viewer, "not-a-uuid", "design-read-not-a-uuid-1700000000000", "p1.png")).resolves.toBeNull();
  });

  it("refuses a sheet that belongs to another run, an older upload's run, and a design that isn't an upload", async () => {
    const { admin, id, runId, keys, sheet } = await withSheet();
    const db = h.db as Database;
    await r2.put(keys.list, Buffer.from(JSON.stringify({ ...sheet, runId: runIdFor(id, 1_700_000_999_999) })));
    expect(await assetFile(db, admin.viewer, id, runId, "p1.png")).toBeNull();
    await r2.put(keys.list, Buffer.from(JSON.stringify(sheet)));
    await h.db.update(figmaDesign).set({ fileKey: "upload-2" }).where(eq(figmaDesign.projectId, id));
    expect(await assetFile(db, admin.viewer, id, runId, "p1.png")).toBeNull();
    await h.db.update(figmaDesign).set({ fileKey: "upload-1", source: "figma" }).where(eq(figmaDesign.projectId, id));
    expect(await assetFile(db, admin.viewer, id, runId, "p1.png")).toBeNull();
  });
});

describe.skipIf(!hasChrome)("the pictures of a new read (stand-in Claude, real browser)", () => {
  it("prepares every picture after the read, under the read's own run, and the panel shows that sheet", async () => {
    const { admin, id, version } = await lane2WithRead();
    const runId = runIdFor(id, 1_700_000_000_000);
    const written: string[] = [];
    // For each write, the phase the status said at that moment.
    const phases: (string | undefined)[] = [];
    let phase: string | undefined;
    const put = r2.put.bind(r2);
    r2.put = async (key: string, body: Buffer) => {
      if (key === statusKey(id, version)) phase = (JSON.parse(body.toString("utf8")) as { phase?: string }).phase;
      written.push(key);
      phases.push(phase);
      return put(key, body);
    };
    await runAsStarted(id, version, admin.viewer.id, runId);
    // The status says the pictures are being prepared before any of them is written (the read is already saved).
    const firstAsset = written.findIndex((k) => k.includes("/read-v2/assets/"));
    const resultAt = written.indexOf(resultKey(id, version));
    expect(resultAt).toBeGreaterThan(-1);
    expect(resultAt).toBeLessThan(firstAsset);
    expect(phases.slice(0, firstAsset).includes("pictures")).toBe(true);
    // News after every picture (three here), so a long picture step never looks stopped.
    expect(written.slice(firstAsset).filter((k) => k === statusKey(id, version)).length).toBeGreaterThanOrEqual(3);
    // The sheet is written after every picture, so it never names a file that isn't there yet.
    const assetWrites = written.filter((k) => k.includes("/read-v2/assets/"));
    const list = readAssetKeys(id, version, 1, runId).list;
    expect(assetWrites.at(-1)).toBe(list);
    expect(assetWrites.filter((k) => k === list)).toHaveLength(1);

    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.status!.state).toBe("done");
    expect(view!.assets!.runId).toBe(runId);
    expect(view!.assets!.base).toBe(`/projects/${id}/intake/design-read-assets/${runId}/`);
    const sheet = view!.assets!.sheet!;
    expect(sheet.error).toBeNull();
    expect(sheet.assets.map((a) => [a.id, a.kind, a.file])).toEqual([
      ["b2-hero", "background", "p1.png"],
      ["b3-drain", "icon", null],
      ["b4-logo", "logo", "p3.png"],
    ]);
    const [hero, drain, logo] = sheet.assets;
    expect(hero!.patches).toHaveLength(1);
    expect(hero!.patches[0]).toMatchObject({ method: "blend", hid: "p1-hid1.png" });
    expect(hero!.flags).toEqual([]);
    expect(drain!.icon).not.toBeNull();
    expect(logo!.transparentOn).not.toBeNull();

    const keys = readAssetKeys(id, version, 1, runId);
    for (const name of ["p1.png", "p1-hid1.png", "p3.png"]) expect(isPng(r2.objects.get(keys.file(name)) ?? null)).toBe(true);
    // An icon is never cut, so no p2.png.
    expect(r2.objects.has(keys.file("p2.png"))).toBe(false);
  });

  it("serves the pictures the worker really wrote", async () => {
    const { admin, id, version } = await lane2WithRead();
    const runId = runIdFor(id, 1_700_000_000_000);
    await runAsStarted(id, version, admin.viewer.id, runId);
    const db = h.db as Database;
    expect(isPng(await assetFile(db, admin.viewer, id, runId, "p1.png"))).toBe(true);
    expect(isPng(await assetFile(db, admin.viewer, id, runId, "p1-hid1.png"))).toBe(true);
    expect(isPng(await assetFile(db, admin.viewer, id, runId, "p3.png"))).toBe(true);
  });

  it("shows the pictures of the read on screen, not those of a newer start still working, and moves to a new read's own once it is saved", async () => {
    const { admin, id, version } = await lane2WithRead();
    const first = runIdFor(id, 1_700_000_000_000);
    await runAsStarted(id, version, admin.viewer.id, first);

    // A newer start is working: the saved read is still the first one, and so is its sheet.
    const at = new Date().toISOString();
    const second = runIdFor(id, 1_700_000_100_000);
    await r2.put(statusKey(id, version), Buffer.from(JSON.stringify({ state: "working", runId: second, version, page: 1, startedAt: at, updatedAt: at, finishedAt: null, calls: 1, inputTokens: 0, outputTokens: 0, bands: null, error: null })));
    let view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.assets!.runId).toBe(first);
    expect(view!.assets!.sheet!.assets).toHaveLength(3);

    // The second read finishes: its own sheet, under its own run.
    await runAsStarted(id, version, admin.viewer.id, second);
    view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.assets!.runId).toBe(second);
    expect(view!.assets!.sheet!.runId).toBe(second);
    expect(view!.assets!.base).toContain(`/${second}/`);
  });

  it("shows no sheet for a read saved before pictures were prepared (no run id)", async () => {
    const { admin, id, version } = await lane2WithRead();
    await runAsStarted(id, version, admin.viewer.id, runIdFor(id, 1_700_000_000_000));
    const saved = JSON.parse(r2.objects.get(resultKey(id, version))!.toString("utf8")) as Record<string, unknown>;
    delete saved.runId;
    await r2.put(resultKey(id, version), Buffer.from(JSON.stringify(saved)));

    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.result).not.toBeNull();
    expect(view!.assets).toBeNull();
  });

  it("keeps the read, and says why, when the pictures could not be prepared", async () => {
    const { admin, id, version } = await lane2WithRead();
    const put = r2.put.bind(r2);
    r2.put = async (key: string, body: Buffer) => {
      if (key.includes("/read-v2/assets/") && key.endsWith(".png")) throw new Error("storage is full");
      return put(key, body);
    };
    await runAsStarted(id, version, admin.viewer.id, runIdFor(id, 1_700_000_000_000));

    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.status!.state).toBe("done");
    expect(view!.result!.bands).toHaveLength(4);
    expect(view!.assets!.sheet!.assets).toEqual([]);
    // The reason goes to the worker's log, not the screen.
    expect(view!.assets!.sheet!.error).toBe(PICTURES_FAILED);
    expect(view!.assets!.sheet!.error).not.toContain("storage is full");
  });

  // CodeRabbit on #96: a stalled storage write must not hold the job (and the browser) forever.
  it("counts a picture write that never finishes as failed, and still finishes the read", async () => {
    const { admin, id, version } = await lane2WithRead();
    const put = r2.put.bind(r2);
    r2.put = async (key: string, body: Buffer) => {
      if (key.includes("/read-v2/assets/") && key.endsWith(".png")) return new Promise<void>(() => undefined);
      return put(key, body);
    };
    setAssetWriteMsForTesting(50);
    try {
      await runAsStarted(id, version, admin.viewer.id, runIdFor(id, 1_700_000_000_000));
    } finally {
      setAssetWriteMsForTesting(null);
    }
    const view = await newReadView(h.db as Database, admin.viewer, id);
    expect(view!.status!.state).toBe("done");
    expect(view!.assets!.sheet!.error).toBe(PICTURES_FAILED);
  });

  // CodeRabbit on #96: the "preparing pictures" status is best effort; the pictures are still prepared.
  it("prepares the pictures even when the 'preparing' status can't be saved", async () => {
    const { admin, id, version } = await lane2WithRead();
    const put = r2.put.bind(r2);
    r2.put = async (key: string, body: Buffer) => {
      // Every "working, preparing pictures" update fails; the final "done" one goes through.
      const status = key === statusKey(id, version) ? (JSON.parse(body.toString("utf8")) as { state: string; phase?: string }) : null;
      if (status?.state === "working" && status.phase === "pictures") throw new Error("status write failed");
      return put(key, body);
    };
    const runId = runIdFor(id, 1_700_000_000_000);
    await runAsStarted(id, version, admin.viewer.id, runId);
    const sheet = JSON.parse(r2.objects.get(readAssetKeys(id, version, 1, runId).list)!.toString("utf8")) as AssetSheet;
    expect(sheet.error).toBeNull();
    expect(sheet.assets).toHaveLength(3);
  });

  // CodeRabbit on #96: the AI sets how many boxes are drawn over a background; each patch keeps a copy of what it hid.
  it("wipes at most ten boxes on one picture and flags the rest", async () => {
    const { admin, id, version } = await lane2WithRead();
    const boxes = Array.from({ length: 12 }, (_, i) => [20 + i * 70, 300, 40, 40]);
    const runId = runIdFor(id, 1_700_000_000_000);
    await runAsStarted(id, version, admin.viewer.id, runId, scriptedClient(boxes));
    const sheet = (await newReadView(h.db as Database, admin.viewer, id))!.assets!.sheet!;
    const hero = sheet.assets.find((a) => a.id === "b2-hero")!;
    expect(hero.patches).toHaveLength(MAX_DRAWN_OVER);
    expect(hero.flags).toContain(`b2-hero: only the first ${MAX_DRAWN_OVER} of 12 boxes drawn over it were wiped (TAWD wipes at most ${MAX_DRAWN_OVER}, covering at most ${OVER_AREA} times the picture); the rest still show, so upload the picture without them.`);
  });
});

describe("how many drawn-over boxes are wiped", () => {
  const request = (drawnOver: { x: number; y: number; w: number; h: number }[]) => ({ id: "b2-hero", kind: "background" as const, box: { x: 0, y: 0, w: 100, h: 100 }, drawnOver });
  it("keeps them in order up to the count, and up to twice the picture's area", () => {
    const small = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 0, w: 5, h: 5 }));
    expect(boundDrawnOver(request(small))).toMatchObject({ left: 2 });
    expect(boundDrawnOver(request(small)).request.drawnOver).toEqual(small.slice(0, MAX_DRAWN_OVER));
    // Three full-picture boxes: the third would make three times the area.
    const full = [0, 1, 2].map(() => ({ x: 0, y: 0, w: 100, h: 100 }));
    expect(boundDrawnOver(request(full))).toMatchObject({ left: 1 });
    // Only the part over the picture counts.
    expect(boundDrawnOver(request([{ x: -1000, y: -1000, w: 1050, h: 1050 }, { x: 0, y: 0, w: 100, h: 100 }]))).toMatchObject({ left: 0 });
  });

  it("leaves other kinds alone", () => {
    expect(boundDrawnOver({ id: "logo", kind: "logo", box: { x: 0, y: 0, w: 10, h: 10 } })).toMatchObject({ left: 0 });
  });
});
