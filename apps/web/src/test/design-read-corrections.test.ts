import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, designReadCorrection, figmaDesign, user } from "@tawd/core/schema";
import { setStorageForTesting, projectStoragePrefix } from "@tawd/core/intake/storage";
import { createProject } from "@/lib/projects";
import { setQueueForTesting } from "@/lib/mockups";
import { loadSavedReadBands, newReadView } from "@/lib/design-read-new";
import { correctReadBand, loadBandCorrections, newReadCorrections } from "@/lib/design-read-corrections";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  E4b-2: an admin corrects a band of the new design read; the correction is
  saved as a new row, logged, shown, and kept when the design is read again
  (Jason, 14 November). No browser and no AI: the saved read is written by
  hand.
*/

let h: Harness;
let r2: FakeR2;

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

type Band = { name: string; role: "header" | "band" | "footer"; top: number; bottom: number };
const BANDS: Band[] = [
  { name: "Header", role: "header", top: 0, bottom: 120 },
  { name: "Hero", role: "band", top: 120, bottom: 620 },
  { name: "Services", role: "band", top: 620, bottom: 1000 },
  { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
];

async function saveRead(id: string, version: string, runId: string, bands: Band[]) {
  const read = { runId, width: 1000, height: 1200, bands: bands.map((band) => ({ band, words: [], points: [], fonts: [], pictures: [], notes: [] })), colours: [], notes: [] };
  await r2.put(`${projectStoragePrefix(id)}design-upload/${version}/read-v2/page-1.json`, Buffer.from(JSON.stringify(read)));
}

async function lane2WithRead(lane: "lane_2" | "lane_1" = "lane_2") {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { clientName: "Test Client", trade: "plumbing", tier: "growth", lane, laneOption: lane === "lane_2" ? "a" : null, conceptCount: 1, status: "intake", memberUserIds: [] } as never);
  const version = "upload-1";
  await h.db.insert(figmaDesign).values({ projectId: id, url: "upload", fileKey: version, source: "upload", fileName: "design.pdf", importStatus: "done" });
  const runId = `design-read-${id}-1700000000000`;
  await saveRead(id, version, runId, BANDS);
  return { admin, id, version, runId };
}

const nameOf = async (userId: string) => (await h.db.select({ name: user.name }).from(user).where(eq(user.id, userId)))[0]!.name;
const runOf = async (projectId: string) => {
  const [row] = await h.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId));
  return row?.fileKey ? ((await loadSavedReadBands(projectId, row.fileKey))?.runId ?? "none") : "none";
};
const fixes = async (id: string, viewer: Awaited<ReturnType<typeof seedAdmin>>["viewer"]) => newReadCorrections(h.db as Database, id, (await newReadView(h.db as Database, viewer, id))!);

describe("correcting a band of the new read", () => {
  it("saves the correction as a new row, logs the band before and after, and shows the band corrected", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "  Hero with form  ", bottom: 650 } });

    const rows = await h.db.select().from(designReadCorrection).where(eq(designReadCorrection.projectId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version, page: 1, target: "band", anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form", bottom: 650 }, madeOnRun: runId, createdByUserId: admin.viewer.id });

    const [log] = await h.db.select().from(activityLog).where(and(eq(activityLog.action, "figma.new_read_band_corrected"), eq(activityLog.entityId, id)));
    expect(log!.valueBefore).toEqual({ band: { name: "Hero", role: "band", top: 120, bottom: 620 } });
    expect(log!.valueAfter).toMatchObject({ band: { name: "Hero with form", role: "band", top: 120, bottom: 650 }, read: runId, upload: version });
    // The neighbour whose edge moved is in the log too.
    expect((log!.valueAfter as { alsoMoved: unknown[] }).alsoMoved).toEqual([{ name: "Services", from: { top: 620, bottom: 1000 }, to: { top: 650, bottom: 1000 } }]);

    const shown = await fixes(id, admin.viewer);
    expect(shown!.bands.map((b) => [b.name, b.top, b.bottom])).toEqual([
      ["Header", 0, 120],
      ["Hero with form", 120, 650],
      ["Services", 650, 1000],
      ["Footer", 1000, 1200],
    ]);
    expect(shown!.bands[1]!.corrected!.by).toBe(await nameOf(admin.viewer.id));
    expect(shown!.bands[1]!.asRead).toEqual({ top: 120, bottom: 620 });
  });

  it("is for an admin only, on Lane 2, once there is a read", async () => {
    const { admin, id } = await lane2WithRead();
    const designer = await seedUser(h, admin.viewer, { email: "designer@example.com", roles: ["web_designer"] });
    await expect(correctReadBand(h.ctx, designer.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "X" } })).rejects.toThrow("Only an admin can correct the new design read");

    const other = await createProject(h.ctx, admin.viewer, { clientName: "Lane One", trade: "plumbing", tier: "growth", lane: "lane_1", conceptCount: 1, status: "intake", memberUserIds: [] } as never);
    await expect(correctReadBand(h.ctx, admin.viewer, other, { runId: await runOf(other), anchor: { top: 120, bottom: 620 }, change: { name: "X" } })).rejects.toThrow("The design read is for Lane 2");

    await r2.remove(`${projectStoragePrefix(id)}design-upload/upload-1/read-v2/page-1.json`);
    await expect(correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "X" } })).rejects.toThrow("Run the new read first");
    expect(await h.db.select().from(designReadCorrection)).toEqual([]);
  });

  it("refuses, saving nothing, a band that isn't in the read, a value that isn't a whole number (never read as 0), and no change at all", async () => {
    const { admin, id } = await lane2WithRead();
    const tries: [Omit<Parameters<typeof correctReadBand>[3], "runId">, string][] = [
      [{ anchor: { top: 118, bottom: 620 }, change: { name: "X" } }, "That band is no longer in the read"],
      [{ anchor: { top: null as never, bottom: 120 }, change: { name: "X" } }, "That band is no longer in the read"],
      [{ anchor: { top: 120, bottom: 620 }, change: { top: null as never } }, "whole number"],
      [{ anchor: { top: 120, bottom: 620 }, change: { bottom: "650" as never } }, "whole number"],
      [{ anchor: { top: 120, bottom: 620 }, change: {} }, "Nothing was changed."],
      [{ anchor: { top: 120, bottom: 620 }, change: { name: "Hero" } }, "Nothing was changed."],
      [{ anchor: { top: 120, bottom: 620 }, change: { colour: "red" } as never }, "Only a band's name, kind, top and bottom"],
    ];
    const runId = await runOf(id);
    for (const [input, message] of tries) await expect(correctReadBand(h.ctx, admin.viewer, id, { ...input, runId })).rejects.toThrow(message);
    expect(await h.db.select().from(designReadCorrection)).toEqual([]);
  });

  it("refuses an edge change that would squeeze a neighbour, saying why, and saves nothing", async () => {
    const { admin, id } = await lane2WithRead();
    await expect(correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { top: 3 } })).rejects.toThrow('Not saved: that would leave "Header" above it under 8 px.');
    expect(await h.db.select().from(designReadCorrection)).toEqual([]);
  });

  it("applies a new correction after the earlier ones, so it is not undone by them", async () => {
    const { admin, id } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { bottom: 700 } });
    // Services now starts at 700; moving its top back to 650 must stand, not be overridden by the earlier correction.
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 620, bottom: 1000 }, change: { top: 650 } });
    const shown = await fixes(id, admin.viewer);
    expect(shown!.bands.map((b) => [b.top, b.bottom])).toEqual([
      [0, 120],
      [120, 650],
      [650, 1000],
      [1000, 1200],
    ]);
  });

  it("judges a new correction against the band list as already corrected", async () => {
    const { admin, id } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 620, bottom: 1000 }, change: { top: 900 } });
    // The hero's bottom now sits at 900; moving it to 995 would leave Services 5 px.
    await expect(correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { bottom: 995 } })).rejects.toThrow('Not saved: that would leave "Services" below it under 8 px.');
    expect(await h.db.select().from(designReadCorrection)).toHaveLength(1);
  });

  // CodeRabbit's review of #97: the correction and its activity entry are saved together or not at all.
  it("saves no correction when its activity entry can't be written", async () => {
    const { admin, id } = await lane2WithRead();
    // In this test database only: the activity log refuses this one kind of entry.
    await h.db.execute(
      sql.raw(`create function refuse_band_log() returns trigger language plpgsql as $$
        begin
          if new.action = 'figma.new_read_band_corrected' then raise exception 'activity log down'; end if;
          return new;
        end $$`),
    );
    await h.db.execute(sql.raw("create trigger refuse_band_log before insert on activity_log for each row execute function refuse_band_log()"));
    await expect(correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" } })).rejects.toThrow('insert into "activity_log"');
    expect(await h.db.select().from(designReadCorrection)).toEqual([]);
  });

  // Fable's review: the panel refreshes while a read runs, so a form opened on one read can be saved after the next one lands.
  it("refuses a save from a form opened on an earlier read, saving nothing", async () => {
    const { admin, id, version, runId } = await lane2WithRead();
    await saveRead(id, version, `design-read-${id}-1700000100000`, BANDS);
    await expect(correctReadBand(h.ctx, admin.viewer, id, { runId, anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" } })).rejects.toThrow("The design was read again since this form was opened.");
    expect(await h.db.select().from(designReadCorrection)).toEqual([]);
  });
});

describe("after the design is read again (Jason, 14 November: corrections are kept)", () => {
  it("applies the correction to the band in the same place in the new read", async () => {
    const { admin, id, version } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" } });
    await saveRead(id, version, `design-read-${id}-1700000100000`, [
      { name: "Top", role: "header", top: 0, bottom: 116 },
      { name: "Main", role: "band", top: 116, bottom: 628 },
      { name: "What we do", role: "band", top: 628, bottom: 1004 },
      { name: "Bottom", role: "footer", top: 1004, bottom: 1200 },
    ]);
    const shown = await fixes(id, admin.viewer);
    expect(shown!.bands.map((b) => b.name)).toEqual(["Top", "Hero with form", "What we do", "Bottom"]);
    expect(shown!.unmatched).toEqual([]);
    // A new correction on the new read is anchored to the new read's own band.
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 116, bottom: 628 }, change: { role: "header" } });
    expect((await fixes(id, admin.viewer))!.bands[1]).toMatchObject({ name: "Hero with form", role: "header" });
  });

  it("lists a correction whose band is gone from the new read, and never drops it", async () => {
    const { admin, id, version } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" } });
    await saveRead(id, version, `design-read-${id}-1700000100000`, [
      { name: "Header", role: "header", top: 0, bottom: 120 },
      { name: "Hero top", role: "band", top: 120, bottom: 300 },
      { name: "Hero middle", role: "band", top: 300, bottom: 450 },
      { name: "Hero bottom", role: "band", top: 450, bottom: 620 },
      { name: "Services", role: "band", top: 620, bottom: 1000 },
      { name: "Footer", role: "footer", top: 1000, bottom: 1200 },
    ]);
    const shown = await fixes(id, admin.viewer);
    expect(shown!.unmatched).toEqual([{ anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" }, by: await nameOf(admin.viewer.id), at: expect.any(String), why: "gone" }]);
    expect(shown!.bands.some((b) => b.name === "Hero with form")).toBe(false);
    expect(await loadBandCorrections(h.db as Database, id, version)).toHaveLength(1);
  });

  it("does not carry corrections to a new upload (a new design)", async () => {
    const { admin, id } = await lane2WithRead();
    await correctReadBand(h.ctx, admin.viewer, id, { runId: await runOf(id), anchor: { top: 120, bottom: 620 }, change: { name: "Hero with form" } });
    await h.db.update(figmaDesign).set({ fileKey: "upload-2" }).where(eq(figmaDesign.projectId, id));
    await saveRead(id, "upload-2", `design-read-${id}-1700000200000`, BANDS);
    const shown = await fixes(id, admin.viewer);
    expect(shown!.bands[1]!.name).toBe("Hero");
    expect(shown!.bands.every((b) => b.corrected === null)).toBe(true);
    expect(shown!.unmatched).toEqual([]);
  });
});
