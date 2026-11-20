import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { figmaDesign } from "@tawd/core/schema";
import type { Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { ASSET_FILE_NAME, isReadRunId, readAssetKeys, sheetFiles, type AssetSheet } from "@tawd/core/figma/read-assets";

/*
  The asset sheet of a new design read, from the web side (E4b-1, Lane 2,
  14 November 2026): the pictures the worker cut from the design and treated
  by kind after the read (worker design-read-assets.ts), shown to admins in
  the "New design read" panel and served by
  projects/[id]/intake/design-read-assets/[runId]/[file].

  A file is served only to an admin, for a runId that belongs to this
  project, of the project's current upload, when the name matches
  ASSET_FILE_NAME and that read's own sheet names it. Nothing typed into the
  address is ever used as a storage path on its own.
*/

/** The page the new read reads (as in design-read-new.ts). */
const PAGE = 1;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadAssetSheet(projectId: string, version: string, runId: string): Promise<AssetSheet | null> {
  if (!isReadRunId(projectId, runId)) return null;
  const bytes = await getStorage().get(readAssetKeys(projectId, version, PAGE, runId).list);
  if (!bytes) return null;
  try {
    const sheet = JSON.parse(bytes.toString("utf8")) as AssetSheet;
    if (!sheet || sheet.runId !== runId || !Array.isArray(sheet.assets)) return null;
    return sheet;
  } catch {
    return null;
  }
}

/** The bytes of one prepared picture, or null for anything not allowed or not there. */
export async function assetFile(db: Database, viewer: Viewer, projectId: string, runId: string, file: string): Promise<Buffer | null> {
  if (!viewer.isAdmin) return null;
  // A project address that isn't an id is "not found", never an error from the database or storage.
  if (!PROJECT_ID.test(projectId)) return null;
  if (!isReadRunId(projectId, runId) || !ASSET_FILE_NAME.test(file)) return null;
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row || row.source !== "upload" || !row.fileKey) return null;
  const sheet = await loadAssetSheet(projectId, row.fileKey, runId);
  if (!sheet || !sheetFiles(sheet).has(file)) return null;
  return getStorage().get(readAssetKeys(projectId, row.fileKey, PAGE, runId).file(file));
}
