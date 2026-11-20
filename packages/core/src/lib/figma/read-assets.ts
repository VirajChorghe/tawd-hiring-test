import { projectStoragePrefix } from "../intake/storage";

/*
  Where the pictures of a new design read are kept, and what their sheet
  says (E4b-1, Lane 2, 14 November 2026). Shared by the worker, which writes
  them (design-read-assets.ts), and the web app, which shows them and serves
  the files (lib/design-read-assets.ts and its route), so both sides use one
  layout and one rule for file names.

    read-v2/assets/<runId>/page-<N>/list.json   the sheet (written last)
    read-v2/assets/<runId>/page-<N>/p<n>.png    each prepared picture
    read-v2/assets/<runId>/page-<N>/p<n>-hid<m>.png
                                                what patch m of picture n hid

  File names are made from numbers by the worker, never from anything the
  read or the model said. The web route serves a name only when it matches
  ASSET_FILE_NAME and the read's own sheet names it, for a runId that belongs
  to the project.
*/

/** The only file names a sheet can name. */
export const ASSET_FILE_NAME = /^p\d{1,4}(-hid\d{1,3})?\.png$/;

/** A runId of this project's new design read (designReadJobId: `design-read-<projectId>-<ms>`). */
export function isReadRunId(projectId: string, runId: unknown): runId is string {
  return typeof runId === "string" && runId.startsWith(`design-read-${projectId}-`) && /^\d{10,16}$/.test(runId.slice(`design-read-${projectId}-`.length));
}

/** Where the web app serves one of a sheet's files (projects/[id]/intake/design-read-assets/[runId]/[file]). */
export function assetUrl(projectId: string, runId: string, file: string): string {
  return `/projects/${encodeURIComponent(projectId)}/intake/design-read-assets/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`;
}

export function readAssetKeys(projectId: string, version: string, page: number, runId: string) {
  const prefix = `${projectStoragePrefix(projectId)}design-upload/${version}/read-v2/assets/${runId}/page-${page}/`;
  return { prefix, list: `${prefix}list.json`, status: `${prefix}preparing.json`, file: (name: string) => `${prefix}${name}` };
}

/*
  Preparing a saved read's pictures again, free (E4b-2b). Its own status,
  beside the sheet, so it never writes over the read's: the read is finished
  and must stay finished while its pictures are made again. Only the latest
  attempt runs, the same rule as the read's own start.
*/
export interface PrepareStatus {
  state: "queued" | "working" | "done" | "failed";
  /** The attempt this status belongs to (DesignPicturesJobData.attempt). */
  attempt: string;
  runId: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** How many pictures have been written so far, and how many the read named. */
  done: number;
  total: number | null;
  error: string | null;
}

/** A prepare with no news for this long has stopped (the worker restarted or was killed) and can be started again. */
export const PREPARE_STALE_MS = 10 * 60 * 1000;

export function preparedStalled(status: PrepareStatus | null, now = Date.now()): boolean {
  if (!status || (status.state !== "queued" && status.state !== "working")) return false;
  return now - new Date(status.updatedAt).getTime() > PREPARE_STALE_MS;
}

/*
  Whether an attempt may still write its own status.

  A job gone quiet for its stale limit counts as stopped, so a person may
  press again while this one is still alive (waiting for a free browser
  page, or on a slow write). That press writes its own attempt as "queued".
  This one must not write over it, or the newer attempt's job would find a
  status that is not its own and stop, leaving the work undone while the
  panel said done. An unreadable or missing status is this job's to replace.

  Shared by the free prepare (E4b-2b) and the page build (E5a): both run
  one attempt at a time under the same rule.
*/
export function mayWriteStatus(current: Buffer | null, attempt: string): boolean {
  if (!current) return true;
  try {
    const was = JSON.parse(current.toString("utf8")) as { attempt?: string };
    return was.attempt === undefined || was.attempt === attempt;
  } catch {
    return true;
  }
}

export type SheetKind = "photo" | "background" | "cutout" | "logo" | "silhouette" | "icon";

export interface SheetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetPatch {
  /** Relative to the prepared picture. */
  box: SheetBox;
  method: "blend" | "soft";
  feather: number;
  /** What the patch hid, as its own picture. */
  hid: string | null;
}

export interface SheetAsset {
  id: string;
  kind: SheetKind;
  /** On the whole design. */
  box: SheetBox;
  /** Null for icons and for pictures that could not be cut. */
  file: string | null;
  width: number | null;
  height: number | null;
  icon: { name: string; by: string } | null;
  patches: SheetPatch[];
  transparentOn: string | null;
  fadedEdges: ("left" | "right" | "top" | "bottom")[];
  flags: string[];
}

export interface AssetSheet {
  runId: string;
  version: string;
  page: number;
  preparedAt: string;
  assets: SheetAsset[];
  /** Set when the pictures could not be prepared at all; the read itself is kept. */
  error: string | null;
}

/** Every file a sheet names (pictures and what their patches hid), each checked against ASSET_FILE_NAME. */
export function sheetFiles(sheet: AssetSheet): Set<string> {
  const names = new Set<string>();
  for (const asset of sheet.assets ?? []) {
    if (typeof asset.file === "string" && ASSET_FILE_NAME.test(asset.file)) names.add(asset.file);
    for (const patch of asset.patches ?? []) if (typeof patch.hid === "string" && ASSET_FILE_NAME.test(patch.hid)) names.add(patch.hid);
  }
  return names;
}
