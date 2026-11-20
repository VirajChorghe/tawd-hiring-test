import { eq, gte } from "drizzle-orm";

import type { Database } from "../../db";
import { figmaDesign, figmaRead } from "../../db/schema";
import { prefillAfterDesignRead } from "./design-prefill";
import { actorFields, recordActivity } from "../activity";
import { getStorage, projectStoragePrefix } from "../intake/storage";
import { SYSTEM_ACTOR } from "../permissions";
import { postProjectSlack } from "../slack";
import { FigmaError, getFigma, type FigmaFile } from "./api";
import { checkReadiness, finalPageOf, type Readiness } from "./readiness";
import { designAssetNodes, type DesignAssetNode } from "./build-from-design";
import { cleanFrame, describeFrameProblems } from "./clean-frame";
import { findNode } from "./design-review";
import { frameRole } from "./pages";
import { syncDesignAddon } from "../addons";

/*
  The designer's Figma file, read and imported. Shared by the web app (the
  check, when the PM saves the link or presses Check again) and the worker
  (the import). No AI anywhere; every Figma read is counted.
*/

export type FigmaDesignRow = typeof figmaDesign.$inferSelect;

export interface ImportedFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  isHome: boolean;
  /** Null when Figma could not render it. */
  imageKey: string | null;
  scale: number;
}

/* The logo and icons rendered at import, for the faithful copy. */
export interface ImportedAsset extends DesignAssetNode {
  imageKey: string;
}

/* Figma's node ids ("12:345") as a safe file name. */
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]+/g, "-");

export async function recordFigmaRead(db: Database, projectId: string, endpoint: string, ok: boolean): Promise<void> {
  await db.insert(figmaRead).values({ projectId, endpoint, ok });
}

/* Figma API reads since the start of this calendar month (Pacific), for the limit. */
export async function figmaReadsThisMonth(db: Database, now: Date = new Date()): Promise<number> {
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" })
    .format(now)
    .split("-");
  // Midnight on the 1st in Los Angeles is 07:00 or 08:00 UTC; 08:00 errs toward counting a read.
  const start = new Date(`${year}-${month}-01T07:00:00Z`);
  const rows = await db.select({ id: figmaRead.id }).from(figmaRead).where(gte(figmaRead.createdAt, start));
  return rows.length;
}

/*
  Reads the file once, keeps the whole answer in R2, and stores what the
  readiness check found. A failure is stored too, in plain words, and
  never stops the project.
*/
export async function checkFigmaFile(db: Database, projectId: string): Promise<FigmaDesignRow> {
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row) throw new Error("No Figma link for this project.");

  let read: { file: FigmaFile; raw: string };
  try {
    read = await readFigmaFile(db, projectId, row.fileKey, row.chosenPageId);
  } catch (error) {
    const figmaError =
      error instanceof FigmaError ? error : new FigmaError("unavailable", "Figma didn't answer. Try again in a few minutes.");
    // A missing key never reached Figma, so it is not a read; a file too large was counted where it was found.
    if (figmaError.kind !== "not_configured" && figmaError.kind !== "too_large") await recordFigmaRead(db, projectId, "file", false);
    const [failed] = await db
      .update(figmaDesign)
      .set({
        checkStatus: "failed",
        checkedAt: new Date(),
        failureKind: figmaError.kind,
        failureMessage: figmaError.message,
      })
      .where(eq(figmaDesign.projectId, projectId))
      .returning();
    return failed!;
  }

  const fileJsonKey = `${projectStoragePrefix(projectId)}figma/file-${safe(read.file.version)}.json`;
  await getStorage().put(fileJsonKey, Buffer.from(read.raw, "utf8"), "application/json");
  const readiness = checkReadiness(read.file, { chosenPageId: row.chosenPageId });

  const [checked] = await db
    .update(figmaDesign)
    .set({
      checkStatus: readiness.warnings > 0 ? "warnings" : "ok",
      checkedAt: new Date(),
      failureKind: null,
      failureMessage: null,
      fileName: read.file.name,
      figmaVersion: read.file.version,
      readiness,
      fileJsonKey,
    })
    .where(eq(figmaDesign.projectId, projectId))
    .returning();
  return checked!;
}

/*
  The file, whole when it's under MAX_FIGMA_BYTES (one read, as before).
  Larger (13 October 2026, the whole-code review: a 100-300 MB design system
  could crash the 1 GB web app), TAWD reads its outline and then only the
  page the site is built from, in full: two more reads, counted.
*/
async function readFigmaFile(db: Database, projectId: string, fileKey: string, chosenPageId: string | null): Promise<{ file: FigmaFile; raw: string }> {
  try {
    const read = await getFigma().getFile(fileKey);
    await recordFigmaRead(db, projectId, "file", true);
    return read;
  } catch (error) {
    if (!(error instanceof FigmaError) || error.kind !== "too_large") throw error;
    await recordFigmaRead(db, projectId, "file", false);
  }
  let file: FigmaFile;
  try {
    file = await getFigma().getOutline(fileKey);
    await recordFigmaRead(db, projectId, "outline", true);
  } catch (error) {
    if (!(error instanceof FigmaError) || error.kind !== "too_large") throw error;
    await recordFigmaRead(db, projectId, "outline", false);
    // Even the list of pages is over the limit (CodeRabbit, PR #10): what the designer can do about it.
    throw new FigmaError(
      "too_large",
      "This Figma file is too large for TAWD to read, even as a list of its pages. Ask the designer for a copy of the file holding only the site's final page, share that, then check the link again.",
    );
  }
  file.tawdFullPages = [];
  const page = finalPageOf(file, chosenPageId);
  if (page) await readFullPage(db, projectId, fileKey, file, page.id);
  return { file, raw: JSON.stringify(file) };
}

/* One page of a big file, read in full into its outline. One read. */
async function readFullPage(db: Database, projectId: string, fileKey: string, file: FigmaFile, pageId: string): Promise<void> {
  let full;
  try {
    full = await getFigma().getPage(fileKey, pageId);
    await recordFigmaRead(db, projectId, "page", true);
  } catch (error) {
    if (!(error instanceof FigmaError) || error.kind !== "too_large") throw error;
    await recordFigmaRead(db, projectId, "page", false);
    const name = (file.document.children ?? []).find((p) => p.id === pageId)?.name ?? "the final page";
    throw new FigmaError(
      "too_large",
      `The page "${name}" is too large for TAWD to read (over 60 MB from Figma). Ask the designer to put the site's final frames on a page of their own, then check the link again.`,
    );
  }
  file.document.children = (file.document.children ?? []).map((p) => (p.id === pageId ? full : p));
  file.tawdFullPages = [...new Set([...(file.tawdFullPages ?? []), pageId])];
}

/* The file as last read, from R2. No Figma read. */
export async function savedFigmaFile(row: FigmaDesignRow): Promise<FigmaFile | null> {
  if (!row.fileJsonKey) return null;
  const body = await getStorage().get(row.fileJsonKey);
  return body ? (JSON.parse(body.toString("utf8")) as FigmaFile) : null;
}

/* The page the PM chose, applied to the saved file: no Figma read. */
export async function chooseFigmaPage(db: Database, projectId: string, pageId: string): Promise<FigmaDesignRow> {
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row) throw new Error("No Figma link for this project.");
  const file = await savedFigmaFile(row);
  if (!file) throw new Error("The file has not been read yet. Check it first.");
  if (!(file.document.children ?? []).some((p) => p.id === pageId)) throw new Error("That page is not in the file.");
  // A big file holds only its outline and the pages read so far: this page is read now (one Figma read).
  if (file.tawdFullPages && !file.tawdFullPages.includes(pageId) && row.fileJsonKey) {
    await readFullPage(db, projectId, row.fileKey, file, pageId);
    await getStorage().put(row.fileJsonKey, Buffer.from(JSON.stringify(file), "utf8"), "application/json");
  }

  const readiness = checkReadiness(file, { chosenPageId: pageId });
  const [updated] = await db
    .update(figmaDesign)
    .set({ chosenPageId: pageId, readiness, checkStatus: readiness.warnings > 0 ? "warnings" : "ok" })
    .where(eq(figmaDesign.projectId, projectId))
    .returning();
  return updated!;
}

/* A frame's pixel budget: Figma refuses very large renders, so tall pages are rendered smaller. */
const MAX_PIXELS = 25_000_000;

/* The format of a downloaded image, from its first bytes. */
function imageType(body: Buffer): { ext: string; type: string } {
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (body[0] === 0xff && body[1] === 0xd8) return { ext: "jpg", type: "image/jpeg" };
  if (body.subarray(0, 3).toString("ascii") === "GIF") return { ext: "gif", type: "image/gif" };
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return { ext: "webp", type: "image/webp" };
  }
  return { ext: "bin", type: "application/octet-stream" };
}

/*
  The import (the worker runs it): the final frames rendered to images,
  and every image the design uses, into R2. Two Figma reads at most: one
  to render, one for the image links. The file itself is not read again.
*/
export async function importFigmaDesign(db: Database, projectId: string): Promise<void> {
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row || row.importStatus !== "queued") return;

  await db.update(figmaDesign).set({ importStatus: "working" }).where(eq(figmaDesign.projectId, projectId));

  try {
    const readiness = row.readiness as Readiness | null;
    if (!readiness || readiness.frames.length === 0) {
      throw new FigmaError("bad_answer", "There are no final frames to import. Check the file and choose the final page first.");
    }
    const figma = getFigma();
    const storage = getStorage();
    const prefix = `${projectStoragePrefix(projectId)}figma/${safe(readiness.version)}/`;
    const warnings: string[] = [];

    /*
      The frames, and in the same request the logo and the icons (drawn
      shapes Figma does not hand over as files), for the faithful copy.
    */
    const file = await savedFigmaFile(row);
    const drawn = file ? designAssetNodes(file, readiness.frames) : [];
    // Stacked or covered content in the homepage frame: warned about here, left out of everything built from it.
    const homeFrame = readiness.frames.find((f) => f.isHome);
    const homeNode = file && homeFrame ? findNode(file.document, homeFrame.id) : null;
    const leftovers = homeNode && homeFrame ? describeFrameProblems(homeFrame.name, cleanFrame(homeNode).problems) : null;
    if (leftovers) warnings.push(leftovers);
    const largest = Math.max(...readiness.frames.map((f) => f.width * f.height));
    const scale = Math.min(1, Math.floor(Math.sqrt(MAX_PIXELS / Math.max(1, largest)) * 100) / 100);
    let links: Record<string, string | null>;
    try {
      links = await figma.renderFrames(row.fileKey, [...readiness.frames.map((f) => f.id), ...drawn.map((d) => d.id)], scale);
      await recordFigmaRead(db, projectId, "images", true);
    } catch (error) {
      await recordFigmaRead(db, projectId, "images", false);
      throw error;
    }

    const frames: ImportedFrame[] = [];
    for (const frame of readiness.frames) {
      const link = links[frame.id];
      let imageKey: string | null = null;
      if (link) {
        imageKey = `${prefix}frames/${safe(frame.id)}.png`;
        await storage.put(imageKey, await figma.download(link), "image/png");
      } else {
        warnings.push(`Figma could not render "${frame.name}", so it has no picture here. Try importing again, or check the frame in Figma.`);
      }
      frames.push({ id: frame.id, name: frame.name, width: frame.width, height: frame.height, isHome: frame.isHome, imageKey, scale });
    }

    const designAssets: ImportedAsset[] = [];
    for (const asset of drawn) {
      const link = links[asset.id];
      if (!link) continue;
      const imageKey = `${prefix}drawn/${safe(asset.id)}.png`;
      await storage.put(imageKey, await figma.download(link), "image/png");
      designAssets.push({ ...asset, imageKey });
    }

    /* ---------- the design's own images ---------- */
    const imageFiles: Record<string, string | null> = {};
    if (readiness.imageRefs.length > 0) {
      let fills: Record<string, string | null>;
      try {
        fills = await figma.imageFills(row.fileKey);
        await recordFigmaRead(db, projectId, "image_fills", true);
      } catch (error) {
        await recordFigmaRead(db, projectId, "image_fills", false);
        throw error;
      }
      for (const ref of readiness.imageRefs) {
        const link = fills[ref];
        if (!link) {
          imageFiles[ref] = null;
          continue;
        }
        const body = await figma.download(link);
        const { ext, type } = imageType(body);
        const key = `${prefix}images/${safe(ref)}.${ext}`;
        await storage.put(key, body, type);
        imageFiles[ref] = key;
      }
      const missing = Object.values(imageFiles).filter((k) => k === null).length;
      if (missing > 0) {
        warnings.push(
          `${missing} image${missing === 1 ? " is" : "s are"} missing from the Figma file (placed in the design, but Figma has no file for ${missing === 1 ? "it" : "them"}). Ask the designer to re-place ${missing === 1 ? "it" : "them"}.`,
        );
      }
    }

    await db
      .update(figmaDesign)
      .set({
        importStatus: "done",
        importFailure: null,
        importedAt: new Date(),
        importedVersion: readiness.version,
        frames,
        imageFiles,
        designAssets,
        importWarnings: warnings,
      })
      .where(eq(figmaDesign.projectId, projectId));

    // The client-supplied design add-on, one per desktop page (27 September 2026).
    await syncDesignAddon(db, projectId, frames.filter((f) => frameRole(f) === "desktop").length);
    // E0(c): the design's facts go into the intake's empty answers, by code (never throws; a failure is logged). Straight after the read is done, so a failed log or Slack post can't skip it.
    await prefillAfterDesignRead(db, projectId);

    await recordActivity(db, {
      action: "figma.imported",
      entityType: "project",
      entityId: projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: {
        fileName: readiness.fileName,
        frames: frames.map((f) => f.name),
        images: Object.values(imageFiles).filter(Boolean).length,
        logos: designAssets.filter((a) => a.kind === "logo").length,
        icons: designAssets.filter((a) => a.kind === "icon").length,
        warnings,
      },
      ipAddress: null,
      userAgent: null,
    });
    await postProjectSlack(db, projectId, {
      kind: "design_imported",
      frames: frames.length,
      warnings: readiness.warnings + warnings.length,
    });
  } catch (error) {
    await markFigmaImportFailed(
      db,
      projectId,
      error instanceof Error ? error.message : "The import did not finish.",
    );
  }
}

export async function markFigmaImportFailed(db: Database, projectId: string, message: string): Promise<void> {
  const [updated] = await db
    .update(figmaDesign)
    .set({ importStatus: "failed", importFailure: message })
    .where(eq(figmaDesign.projectId, projectId))
    .returning({ projectId: figmaDesign.projectId });
  if (!updated) return;
  await recordActivity(db, {
    action: "figma.import_failed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
