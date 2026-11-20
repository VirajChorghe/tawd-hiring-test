import type { Page } from "playwright-core";

import type { FileStorage } from "@tawd/core/intake/storage";
import { readAssetKeys, type AssetSheet, type SheetAsset, type SheetPatch } from "@tawd/core/figma/read-assets";

import { prepareAsset, writePng, type PictureRequest } from "./design-assets";
import type { Box, Rgba } from "./design-pixels";
import { toPictureRequests } from "./design-read-code";
import type { DesignRead } from "./design-read-types";

/*
  The pictures of a finished design read, prepared and saved (E4b-1, Lane 2,
  14 November 2026; spec 15 section 6 stage 3). After the read is saved, every
  picture it named is cut from the design and treated by its kind with E3
  (design-assets.ts: backgrounds wiped under drawn-over boxes, logos and
  cut-outs made see-through, silhouettes faded into their band, icons matched
  to TAWD's set by the word beside them, in code). The paid icon pick is not
  used here: an icon with no match is flagged.

  Saved under the read's own start (runId), so a later read never mixes its
  pictures with an earlier one's; the layout and the file-name rule are in
  core figma/read-assets.ts, shared with the web app. File names are made here
  from numbers, never from anything the read or the model said. The sheet is
  written after every picture, so it never names a file that isn't there.
*/

/** What the sheet says when the pictures could not be prepared at all (the reason is in the worker's log). */
export const PICTURES_FAILED =
  "The pictures could not be prepared (the reason is in the worker's log). The read itself is kept. Press \u201CPrepare the pictures again\u201D to try again, which is free and does not read the design again.";

/** At most this many drawn-over boxes are wiped on one picture, together covering at most OVER_AREA times its own area: each patch keeps a copy of what it hid, and the boxes come from the AI. */
export const MAX_DRAWN_OVER = 10;
export const OVER_AREA = 2;
/** A storage write that has not finished in this long counts as failed (the client itself has no time limit). */
export const WRITE_MS = 60_000;
let writeMs = WRITE_MS;
/** Tests only: a shorter write limit (null puts WRITE_MS back). */
export function setAssetWriteMsForTesting(ms: number | null): void {
  writeMs = ms ?? WRITE_MS;
}

/* Keeps the drawn-over boxes within MAX_DRAWN_OVER and OVER_AREA, in the read's order; says how many were left out. */
export function boundDrawnOver(request: PictureRequest): { request: PictureRequest; left: number } {
  if (request.kind !== "background" || !request.drawnOver?.length) return { request, left: 0 };
  const room = OVER_AREA * request.box.w * request.box.h;
  const kept: Box[] = [];
  let area = 0;
  for (const over of request.drawnOver) {
    const w = Math.min(over.x + over.w, request.box.x + request.box.w) - Math.max(over.x, request.box.x);
    const h = Math.min(over.y + over.h, request.box.y + request.box.h) - Math.max(over.y, request.box.y);
    const covered = w > 0 && h > 0 ? w * h : 0;
    if (kept.length >= MAX_DRAWN_OVER || area + covered > room) break;
    kept.push(over);
    area += covered;
  }
  return { request: { ...request, drawnOver: kept }, left: request.drawnOver.length - kept.length };
}

export async function saveReadAssets(
  browserPage: Page,
  design: Rgba,
  read: DesignRead,
  storage: FileStorage,
  where: { projectId: string; version: string; page: number; runId: string },
  /** Called after each picture is written (the job saves its status, so the panel has news). */
  onPicture: () => Promise<unknown> = async () => undefined,
): Promise<AssetSheet> {
  const keys = readAssetKeys(where.projectId, where.version, where.page, where.runId);
  const base = { runId: where.runId, version: where.version, page: where.page };
  // A write that stalls fails into the "could not be prepared" sheet instead of holding the job (and the browser) forever.
  const put = (key: string, body: Buffer, type: string) => withinTime(storage.put(key, body, type), writeMs, `Saving ${key.slice(key.lastIndexOf("/") + 1)} took over ${writeMs / 1000} s.`);
  try {
    const assets: SheetAsset[] = [];
    // One picture at a time, written before the next is prepared: the number of pictures comes from the read, so holding them all could run the worker out of memory.
    for (const [n, asked] of toPictureRequests(read).entries()) {
      const { request, left } = boundDrawnOver(asked);
      const asset = prepareAsset(design, request);
      if (left > 0) asset.flags.push(`${asset.id}: only the first ${request.drawnOver!.length} of ${asked.drawnOver!.length} boxes drawn over it were wiped (TAWD wipes at most ${MAX_DRAWN_OVER}, covering at most ${OVER_AREA} times the picture); the rest still show, so upload the picture without them.`);
      let file: string | null = null;
      if (asset.picture) {
        file = `p${n + 1}.png`;
        await put(keys.file(file), Buffer.from(await writePng(browserPage, asset.picture), "base64"), "image/png");
      }
      const patches: SheetPatch[] = [];
      for (const [m, patch] of asset.patches.entries()) {
        const hid = `p${n + 1}-hid${m + 1}.png`;
        await put(keys.file(hid), Buffer.from(await writePng(browserPage, patch.underneath), "base64"), "image/png");
        patches.push({ box: patch.box, method: patch.method, feather: patch.feather, hid });
      }
      assets.push({
        id: asset.id,
        kind: asset.kind,
        box: asset.box,
        file,
        width: asset.picture?.width ?? null,
        height: asset.picture?.height ?? null,
        icon: asset.icon,
        patches,
        transparentOn: asset.transparentOn,
        fadedEdges: asset.fadedEdges,
        flags: asset.flags,
      });
      // News for the panel; a status that can't be saved never stops the pictures.
      await onPicture().catch(() => undefined);
    }
    const sheet: AssetSheet = { ...base, preparedAt: new Date().toISOString(), assets, error: null };
    await put(keys.list, Buffer.from(JSON.stringify(sheet), "utf8"), "application/json");
    return sheet;
  } catch (error) {
    // The read stands; the sheet says the pictures could not be prepared. The full error goes to the worker's log, not the screen.
    console.error(`The new read's pictures could not be prepared (${where.runId}):`, error);
    const sheet: AssetSheet = { ...base, preparedAt: new Date().toISOString(), assets: [], error: PICTURES_FAILED };
    await put(keys.list, Buffer.from(JSON.stringify(sheet), "utf8"), "application/json").catch(() => undefined);
    return sheet;
  }
}

function withinTime<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
