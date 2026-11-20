import { and, eq } from "drizzle-orm";
import { costOf, formatCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";

import type { Database } from "@tawd/core/db";
import { aiCall, figmaDesign, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Viewer } from "@tawd/core/permissions";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { DESIGN_READ_JOB, designReadJobId } from "@tawd/core/queue";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";
import { assetUrl, isReadRunId, type AssetSheet } from "@tawd/core/figma/read-assets";
import type { CorrectableBand } from "@tawd/core/figma/read-corrections";
import { loadAssetSheet } from "@/lib/design-read-assets";

/*
  The new design read (E4, Lane 2, 14 November 2026), from the web side.
  Admin only while the new route is built beside the current one: it reads
  the page picture the last upload read saved, and writes its own result
  next to it (worker design-read-job.ts). Nothing else on the project
  changes, so the PM's design, intake and pages are never touched by it.

  The estimate (standing rules 2 and 9) counts up to two whole-page calls for
  the band list (it is asked once more when it doesn't cover the page) and
  one call per band; the number of bands is guessed from the page's height
  (one band per BAND_HEIGHT_GUESS px, at least 4) until the read has run. Each
  call's cost is the average of the real calls of its kind so far, else a
  first guess, on the step's model ("design_read").

  Starting writes the read's status as "queued" before the job is queued,
  with a new runId, so a second start (another tab, a double click) is
  refused at once. A read "working" with no news for STALE_MS has stopped
  (the worker restarted or was killed) and can be started again; the screen
  says so. A "queued" one is waiting its turn behind other work and is not
  called stopped for waiting, however long; it is stopped when the queue no
  longer holds its job waiting or running (lost from the queue, or failed
  before it began), so a person is never left unable to start again. A
  newer start that replaces one is safe: the older job finds another runId
  in the status and stops before any call (Fable's reviews of E4a).
*/

/** A read with no news for this long has stopped: the same limit as the worker's (design-read-job.ts). */
export const STALE_MS = 30 * 60 * 1000;

type Db = Database;

/** First guesses until real calls exist: the whole-page look, and one band. */
export const NEW_READ_GUESS = {
  bandList: { inputTokens: 2_500, outputTokens: 800 },
  band: { inputTokens: 2_500, outputTokens: 2_500 },
};
export const BAND_HEIGHT_GUESS = 370;

export function bandsGuess(height: number): number {
  return Math.max(4, Math.round(height / BAND_HEIGHT_GUESS));
}

/** A PNG's size from its header (bytes 16 to 23), without decoding it. Null when it isn't a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export interface NewReadEstimate {
  cost: number;
  bands: number;
  model: string;
  measured: boolean;
  label: string;
}

export async function estimateNewRead(db: Db, height: number): Promise<NewReadEstimate> {
  const config = await stepModelConfig(db, "design_read");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "design_read"));
  const average = (scope: string, guess: { inputTokens: number; outputTokens: number }) => {
    const of = calls.filter((c) => c.scope === scope);
    return { cost: of.length ? of.reduce((n, c) => n + costOf(c, config), 0) / of.length : costOf(guess, config), measured: of.length > 0 };
  };
  const list = average("band_list", NEW_READ_GUESS.bandList);
  const band = average("band", NEW_READ_GUESS.band);
  const bands = bandsGuess(height);
  const cost = list.cost * 2 + band.cost * bands;
  const model = modelLabel(config.model);
  const measured = list.measured && band.measured;
  return {
    cost,
    bands,
    model,
    measured,
    label: `About ${formatCost(cost)} of AI on ${model}: a look at the whole page for its bands (a second one if its band list doesn't cover the page), then one look at each band (about ${bands} for a page ${height}px tall)${measured ? ", from the reads so far" : " (a first guess until a real read has run)"}.`,
  };
}

function keys(projectId: string, version: string, page: number) {
  const prefix = `${projectStoragePrefix(projectId)}design-upload/${version}/`;
  return { frame: `${prefix}frames/page-${page}.png`, result: `${prefix}read-v2/page-${page}.json`, status: `${prefix}read-v2/status.json` };
}

/** The band list of the saved new read (page 1) of an upload, as read: what corrections apply to. Null when there is none. */
export async function loadSavedReadBands(projectId: string, version: string): Promise<{ runId: string | null; height: number; bands: CorrectableBand[] } | null> {
  const bytes = await getStorage().get(keys(projectId, version, 1).result);
  if (!bytes) return null;
  try {
    const read = JSON.parse(bytes.toString("utf8")) as { runId?: unknown; height: number; bands: { band: CorrectableBand }[] };
    return { runId: typeof read.runId === "string" ? read.runId : null, height: read.height, bands: read.bands.map((b) => ({ name: b.band.name, role: b.band.role, top: b.band.top, bottom: b.band.bottom })) };
  } catch {
    return null;
  }
}

export interface NewReadStatus {
  state: "queued" | "working" | "done" | "failed";
  runId?: string;
  version: string;
  page: number;
  startedAt: string;
  updatedAt?: string;
  finishedAt: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  bands: number | null;
  error: string | null;
  /** The worker's: set once the read is saved and its pictures are being prepared. */
  phase?: "pictures";
}

export interface NewReadView {
  /** The upload read this would read (null: no finished upload read, so nothing to read). */
  version: string | null;
  page: number;
  height: number | null;
  estimate: NewReadEstimate | null;
  status: NewReadStatus | null;
  /** The status says queued or working, but there has been no news for STALE_MS: it stopped, and can be started again. */
  stalled: boolean;
  /** A short summary of the last finished read of this upload. */
  result: { /** The start that made this read (null for reads saved before E4b-1). */ runId: string | null; height: number; bands: { name: string; role: CorrectableBand["role"]; top: number; bottom: number; words: number; pictures: number; notes: string[] }[]; colours: number; notes: string[] } | null;
  /**
   * The pictures of that same read, prepared by kind (E4b-1): loaded for the read's own runId, never the
   * latest start's, so a read in progress or one that failed never shows another read's pictures. Null when
   * the read was saved before E4b-1 (no runId); `sheet` is null when the read has its runId but no sheet
   * was found (the worker stopped before writing it).
   */
  assets: { runId: string; sheet: AssetSheet | null; /** Where its files are served; a sheet's file name goes on the end. */ base: string; /** The sheet could not be read just now (storage trouble): the pictures may well be there. */ loadFailed?: true } | null;
}

/** Page 1 of the project's last finished upload read. Admin only: anyone else gets null. */
export async function newReadView(db: Db, viewer: Viewer, projectId: string): Promise<NewReadView | null> {
  if (!viewer.isAdmin) return null;
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const page = 1;
  if (!row || row.source !== "upload" || row.importStatus !== "done" || !row.fileKey) return { version: null, page, height: null, estimate: null, status: null, stalled: false, result: null, assets: null };
  const storage = getStorage();
  const k = keys(projectId, row.fileKey, page);
  const frame = await storage.get(k.frame);
  const size = frame ? pngSize(frame) : null;
  const statusBytes = await storage.get(k.status);
  let status: NewReadStatus | null = null;
  try {
    const parsed = statusBytes ? (JSON.parse(statusBytes.toString("utf8")) as NewReadStatus) : null;
    status = parsed && parsed.version === row.fileKey ? parsed : null;
  } catch {
    status = null;
  }
  let result: NewReadView["result"] = null;
  let assets: NewReadView["assets"] = null;
  const resultBytes = await storage.get(k.result);
  if (resultBytes) {
    try {
      const read = JSON.parse(resultBytes.toString("utf8")) as {
        runId?: unknown;
        height: number;
        bands: { band: { name: string; role: CorrectableBand["role"]; top: number; bottom: number }; words: unknown[]; pictures: unknown[]; notes: string[] }[];
        colours: unknown[];
        notes: string[];
      };
      result = {
        runId: typeof read.runId === "string" ? read.runId : null,
        height: read.height,
        bands: read.bands.map((b) => ({ ...b.band, words: b.words.length, pictures: b.pictures.length, notes: b.notes })),
        colours: read.colours.length,
        notes: read.notes,
      };
      if (isReadRunId(projectId, read.runId)) assets = { runId: read.runId, sheet: null, base: assetUrl(projectId, read.runId, "") };
    } catch {
      result = null;
      assets = null;
    }
  }
  // Loaded on its own: trouble reading the pictures' sheet never hides the read.
  if (assets) {
    try {
      assets.sheet = await loadAssetSheet(projectId, row.fileKey, assets.runId);
    } catch {
      assets.loadFailed = true;
    }
  }
  // A working read stalls when its news stops; a queued one only when its job is no longer in the queue to run.
  const lastNews = Date.parse(status?.updatedAt ?? status?.startedAt ?? "");
  let stalled = status?.state === "working" && (!Number.isFinite(lastNews) || Date.now() - lastNews > STALE_MS);
  if (status?.state === "queued") stalled = !(await stillQueued(status.runId));
  return { version: row.fileKey, page, height: size?.height ?? null, estimate: size ? await estimateNewRead(db, size.height) : null, status, stalled, result, assets };
}

/*
  Whether the queue still holds this start's job waiting or running. Unsure (the queue not answering, or
  not answering within QUEUE_ASK_MS: the connection retries without end, so a down queue can hang rather
  than fail) counts as yes: never offer a second start on a guess, and never hold the intake page up.
*/
const LIVE_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
export const QUEUE_ASK_MS = 3000;
async function stillQueued(runId: string | undefined): Promise<boolean> {
  if (!runId) return false;
  const ask = (async () => {
    const job = await getQueue().getJob(runId);
    if (!job) return false;
    const state = job.getState ? await job.getState() : "waiting";
    return LIVE_STATES.has(state);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), QUEUE_ASK_MS);
  });
  try {
    return await Promise.race([ask, late]);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export async function startNewDesignRead(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!actor.isAdmin) throw new MockupError("Only an admin can run the new design read while it is being built.");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new MockupError("That project no longer exists.");
  if (proj.lane !== "lane_2") throw new MockupError("The design read is for Lane 2 (the client supplied a design).");
  const view = await newReadView(ctx.db, actor, projectId);
  if (!view?.version || !view.estimate) throw new MockupError("Read the uploaded design first: the new read starts from the page picture that read saves.");
  if ((view.status?.state === "working" || view.status?.state === "queued") && !view.stalled) throw new MockupError("The new read is already running for this design.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: view.estimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  // The upload read must still be the project's design when the job starts (the worker checks again).
  const [still] = await ctx.db.select({ fileKey: figmaDesign.fileKey }).from(figmaDesign).where(and(eq(figmaDesign.projectId, projectId), eq(figmaDesign.fileKey, view.version))).limit(1);
  if (!still) throw new MockupError("The design changed meanwhile; open the page again.");
  // "queued" before the job is queued: a second start is refused from now on.
  const storage = getStorage();
  const statusKey = keys(projectId, view.version, view.page).status;
  const at = new Date().toISOString();
  const runId = designReadJobId(projectId, Date.now());
  const queued: NewReadStatus = { state: "queued", runId, version: view.version, page: view.page, startedAt: at, updatedAt: at, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null };
  await storage.put(statusKey, Buffer.from(JSON.stringify(queued), "utf8"), "application/json");
  try {
    await getQueue().add(DESIGN_READ_JOB, { projectId, startedByUserId: actor.id, version: view.version, page: view.page, runId }, { jobId: runId, attempts: 1 });
  } catch {
    const failed: NewReadStatus = { ...queued, state: "failed", finishedAt: new Date().toISOString(), error: "The job queue wasn't answering, so the read never started." };
    await storage.put(statusKey, Buffer.from(JSON.stringify(failed), "utf8"), "application/json");
    throw new MockupError("The new read couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "figma.new_read_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: view.version, page: view.page, estimate: view.estimate.cost, model: view.estimate.model },
  });
}
