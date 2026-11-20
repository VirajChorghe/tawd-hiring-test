import { and, asc, eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { getDb, type Database } from "@tawd/core/db";
import { designReadCorrection, figmaDesign } from "@tawd/core/schema";
import { getStorage } from "@tawd/core/intake/storage";
import { mayWriteStatus, readAssetKeys, sheetFiles, type AssetSheet, type PrepareStatus } from "@tawd/core/figma/read-assets";
import { applyPictureCorrections, type ItemCorrection, type PictureChange } from "@tawd/core/figma/read-item-corrections";
import type { DesignPicturesJobData } from "@tawd/core/queue";

import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";
import type { Rgba } from "./design-pixels";
import { readPixels } from "./design-assets";
import { designReadKeys } from "./design-read-job";
import { saveReadAssets } from "./design-read-assets";
import type { DesignRead } from "./design-read-types";

/*
  Preparing a finished read's pictures again, free (E4b-2b, Lane 2,
  15 November 2026).

  E4b-1 prepared a read's pictures once, at the end of the read. If a kind
  was read wrong, or the worker restarted part-way, the only way back was to
  run the read again and pay for it. This job does that part on its own: it
  takes the read that is already saved, applies a person's corrections to
  the pictures' kinds and boxes (E4b-2b), and cuts and treats them again.
  No AI call is made, so it is free.

  The read itself is never touched: it is finished, and this writes only
  under its own `read-v2/assets/<runId>/page-N/` folder. The pictures' status
  lives there too, beside the sheet, so the read's own status stays as it is
  and the panel can tell the two apart.

  Only the latest attempt runs, the same rule the read uses: the web app
  writes "queued" with the attempt's id before queueing, and this job stops
  unless the status it finds is that attempt, still queued. So a second press
  (another tab, a double click) never has two jobs writing the same files.
*/

/** Every picture correction made for an upload, oldest first. */
export async function loadPictureCorrections(db: Database, projectId: string, version: string): Promise<ItemCorrection<PictureChange>[]> {
  const rows = await db
    .select()
    .from(designReadCorrection)
    .where(and(eq(designReadCorrection.projectId, projectId), eq(designReadCorrection.version, version), eq(designReadCorrection.target, "picture")))
    .orderBy(asc(designReadCorrection.createdAt), asc(designReadCorrection.id));
  return rows.map((row) => ({
    id: row.id,
    anchor: row.anchor as ItemCorrection<PictureChange>["anchor"],
    change: row.change as PictureChange,
    madeOnRun: row.madeOnRun,
    by: null,
    at: row.createdAt.toISOString(),
  }));
}

/*
  The read with a person's corrections to its pictures applied, ready to be
  prepared. Corrections are matched against the pictures as read, across the
  whole page, so a picture keeps its correction even if the band it sits in
  was renamed or re-cut.

  The corrected pictures are put back BY POSITION, never by id: a picture's id
  is only unique within one call to the read, and a tall band is read in parts,
  one call per part, all under the same band number. So two pictures of one
  band can carry the same id (toPictureRequests makes them unique later, for
  file names). Keying on the id would give every picture sharing one the last
  one's kind and box: one picture cut twice, another never cut, and a sheet
  that looks right. The flat list below is built by walking the bands in order,
  and is read back by walking them in the same order.
*/
export function readWithCorrectedPictures(read: DesignRead, corrections: ItemCorrection<PictureChange>[]): DesignRead {
  if (corrections.length === 0) return read;
  // Flattened in band order, which is the order toPictureRequests walks them in.
  const flat = read.bands.flatMap((band) => band.pictures.map((picture) => ({ id: picture.id, kind: picture.kind, box: picture.box })));
  const applied = applyPictureCorrections(flat, corrections, read.runId ?? null, { width: read.width, height: read.height });
  let next = 0;
  return {
    ...read,
    bands: read.bands.map((band) => ({
      ...band,
      pictures: band.pictures.map((picture) => {
        const corrected = applied.items[next];
        next += 1;
        return corrected ? { ...picture, kind: corrected.kind, box: corrected.box } : picture;
      }),
    })),
  };
}

/*
  The files of the last attempt that this one should clear: those the last
  sheet named and the new one does not.

  Nothing at all when the new sheet carries an error. A prepare that failed
  part-way comes back with an empty list, and clearing every file it does not
  name would throw away the good pictures of the last attempt as well as this
  one's. A failed retry must never leave the read worse off than before it was
  pressed.
*/
export function filesToClear(wasNamed: Set<string>, sheet: AssetSheet): string[] {
  if (sheet.error) return [];
  const named = sheetFiles(sheet);
  return [...wasNamed].filter((file) => !named.has(file));
}

export async function runDesignPicturesJob(job: DesignPicturesJobData, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const keys = readAssetKeys(job.projectId, job.version, job.page, job.runId);
  const readKeys = designReadKeys(job.projectId, job.version, job.page);
  const now = new Date().toISOString();

  const before = await storage.get(keys.status);
  let was: Partial<PrepareStatus>;
  try {
    was = before ? (JSON.parse(before.toString("utf8")) as Partial<PrepareStatus>) : {};
  } catch {
    was = {};
  }
  // A newer press replaced this one, or this job already began (the worker lost it and it was re-run).
  if (was.attempt !== job.attempt) return;
  if (was.state !== "queued") {
    if (was.state === "working") {
      const stopped: PrepareStatus = {
        state: "failed",
        attempt: job.attempt,
        runId: job.runId,
        startedAt: was.startedAt ?? now,
        updatedAt: now,
        finishedAt: now,
        done: was.done ?? 0,
        total: was.total ?? null,
        error: "The worker restarted while preparing the pictures. Press \u201CPrepare the pictures again\u201D to finish them; it is free.",
      };
      await storage.put(keys.status, Buffer.from(JSON.stringify(stopped), "utf8"), "application/json");
    }
    return;
  }

  const status: PrepareStatus = { state: "working", attempt: job.attempt, runId: job.runId, startedAt: now, updatedAt: now, finishedAt: null, done: 0, total: null, error: null };
  /*
    A job that has gone quiet for PREPARE_STALE_MS counts as stopped, so a
    person may press again while this one is still alive (waiting for a free
    browser page, or on a slow write). That press writes its own attempt as
    "queued". This job must not write over it: every save checks the status
    still names this attempt, and does nothing once it does not. The newer
    attempt then runs and its work replaces this one's.
  */
  const saveStatus = async () => {
    if (!mayWriteStatus(await storage.get(keys.status), job.attempt)) return;
    status.updatedAt = new Date().toISOString();
    await storage.put(keys.status, Buffer.from(JSON.stringify(status), "utf8"), "application/json");
  };
  await saveStatus();

  try {
    const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
    if (!row || row.source !== "upload" || row.fileKey !== job.version) throw new Error("That upload is no longer the project's design; read the design again first.");

    const saved = await storage.get(readKeys.result);
    if (!saved) throw new Error("That read is no longer saved; read the design again first.");
    const read = JSON.parse(saved.toString("utf8")) as DesignRead;
    // The pictures belong to one read: preparing them under another read's start would mix two reads' files.
    if (read.runId !== job.runId) throw new Error("The design has been read again since this was started. Reload the page and press Prepare the pictures again.");

    const frame = await storage.get(readKeys.frame);
    if (!frame) throw new Error(`Page ${job.page} of that upload has no saved picture; read the design again first.`);

    // What the last sheet named, so files this one no longer names can be cleared instead of left behind.
    const old = await storage.get(keys.list);
    let wasNamed = new Set<string>();
    if (old) {
      try {
        wasNamed = sheetFiles(JSON.parse(old.toString("utf8")) as AssetSheet);
      } catch {
        wasNamed = new Set<string>();
      }
    }

    const corrections = await loadPictureCorrections(db, job.projectId, job.version);
    const corrected = readWithCorrectedPictures(read, corrections);
    status.total = corrected.bands.reduce((n, band) => n + band.pictures.length, 0);
    await saveStatus();

    const context = await ownPageContext(browser, { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    let sheet: AssetSheet;
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) => (/^(data|blob|about):/.test(route.request().url()) ? route.continue() : route.abort()));
      await loadHtml(page, "<!doctype html><html><body></body></html>");
      const design: Rgba = await readPixels(page, frame.toString("base64"), "image/png");
      sheet = await saveReadAssets(page, design, corrected, storage, { projectId: job.projectId, version: job.version, page: job.page, runId: job.runId }, async () => {
        status.done += 1;
        // A status that can't be saved never stops the pictures.
        await saveStatus().catch(() => undefined);
      });
    } finally {
      await context.close();
    }

    /*
      Files the last sheet named and this one does not (the read now has fewer
      pictures, or a kind that no longer cuts one) are removed, so the folder
      holds only what the sheet names. Best effort: a file left behind is never
      served (the web route serves only names the sheet names) and must never
      fail a prepare that worked.

      Only ever after a prepare that WORKED. A prepare that failed part-way
      comes back with an empty list and an error on the sheet, and clearing
      every file it does not name would throw away the good pictures of the
      last attempt as well as this one's. A failed retry must never leave the
      read worse off than before it was pressed.
    */
    for (const file of filesToClear(wasNamed, sheet)) {
      await storage.remove(keys.file(file)).catch(() => undefined);
    }

    // A sheet with an error is a prepare that did not finish, whatever reached storage.
    status.state = sheet.error ? "failed" : "done";
    status.error = sheet.error;
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : "The pictures could not be prepared.";
    throw error;
  } finally {
    status.finishedAt = new Date().toISOString();
    await saveStatus().catch(() => undefined);
  }
}
