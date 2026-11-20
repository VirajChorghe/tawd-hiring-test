import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { designReadCorrection, figmaDesign, project, user } from "@tawd/core/schema";
import { actorFields, recordActivity, type ActivityAction } from "@tawd/core/activity";
import type { Viewer } from "@tawd/core/permissions";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import {
  applyPictureCorrections,
  applyWordCorrections,
  pictureChangeProblem,
  wordChangeProblem,
  type Box,
  type Corrected,
  type CorrectablePicture,
  type CorrectableWord,
  type ItemCorrection,
  type PictureChange,
  type WordChange,
} from "@tawd/core/figma/read-item-corrections";
import { lockDesignRead } from "@tawd/core/figma/read-lock";
import { readAssetKeys, preparedStalled, type PrepareStatus } from "@tawd/core/figma/read-assets";
import { DESIGN_PICTURES_JOB, designPicturesJobId } from "@tawd/core/queue";
import { MockupError, getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  Corrections to the words and pictures the new design read found (E4b-2b,
  Lane 2, 15 November 2026). The band list's own module is
  design-read-corrections.ts; this is the same shape for the two other kinds
  of thing a read gets wrong, and the rules are the same:

  - Admins only, while the new route is built (Jason, 14 November).
  - A correction is anchored to the item as the read found it, never as
    already corrected, stored as a new row (rows are only ever added), and
    recorded in the activity log with the item before and after.
  - Everything that depends on the read as it is now runs under the
    project's design-read lock, in one transaction, so two saves never both
    pass on the same list and a new read cannot be published in between.

  How corrections apply, also after a re-read, is in core
  figma/read-item-corrections.ts.
*/

const GONE = {
  word: "That text is no longer in the read (it may have been read again). Reload the page and try again.",
  picture: "That picture is no longer in the read (it may have been read again). Reload the page and try again.",
};

/** Sorts after any real time, so a trial correction is applied last. */
const LAST = "9999-12-31T23:59:59.999Z";

function readKey(projectId: string, version: string, page: number): string {
  return `${projectStoragePrefix(projectId)}design-upload/${version}/read-v2/page-${page}.json`;
}

interface SavedBand {
  band: { name: string; role: string; top: number; bottom: number };
  words: CorrectableWord[];
  pictures: { id: string; kind: CorrectablePicture["kind"]; box: Box }[];
}

export interface SavedReadItems {
  runId: string | null;
  width: number;
  height: number;
  /** Every word of the page, in band order, each with the band it was found in. */
  words: (CorrectableWord & { band: string })[];
  pictures: (CorrectablePicture & { band: string })[];
}

/** The words and pictures of the saved new read (page 1) of an upload, as read. Null when there is none. */
export async function loadSavedReadItems(projectId: string, version: string, page = 1): Promise<SavedReadItems | null> {
  const bytes = await getStorage().get(readKey(projectId, version, page));
  if (!bytes) return null;
  try {
    const read = JSON.parse(bytes.toString("utf8")) as { runId?: unknown; width: number; height: number; bands: SavedBand[] };
    const words: SavedReadItems["words"] = [];
    const pictures: SavedReadItems["pictures"] = [];
    for (const band of read.bands ?? []) {
      for (const word of band.words ?? []) words.push({ text: word.text, role: word.role, box: word.box, ...(word.unsure ? { unsure: true } : {}), band: band.band.name });
      for (const picture of band.pictures ?? []) pictures.push({ id: picture.id, kind: picture.kind, box: picture.box, band: band.band.name });
    }
    return { runId: typeof read.runId === "string" ? read.runId : null, width: read.width, height: read.height, words, pictures };
  } catch {
    return null;
  }
}

async function loadCorrections<C extends WordChange | PictureChange>(db: Database, projectId: string, version: string, target: "word" | "picture"): Promise<ItemCorrection<C>[]> {
  const rows = await db
    .select({ row: designReadCorrection, by: user.name })
    .from(designReadCorrection)
    .leftJoin(user, eq(user.id, designReadCorrection.createdByUserId))
    .where(and(eq(designReadCorrection.projectId, projectId), eq(designReadCorrection.version, version), eq(designReadCorrection.target, target)))
    .orderBy(asc(designReadCorrection.createdAt), asc(designReadCorrection.id));
  return rows.map(({ row, by }) => ({ id: row.id, anchor: row.anchor as Box, change: row.change as C, madeOnRun: row.madeOnRun, by: by ?? null, at: row.createdAt.toISOString() }));
}

export const loadWordCorrections = (db: Database, projectId: string, version: string) => loadCorrections<WordChange>(db, projectId, version, "word");
export const loadPictureCorrections = (db: Database, projectId: string, version: string) => loadCorrections<PictureChange>(db, projectId, version, "picture");

export interface NewReadItems {
  words: Corrected<CorrectableWord & { band: string }>[];
  pictures: Corrected<CorrectablePicture & { band: string }>[];
  /** Corrections no item of this read matches any more (the read changed). */
  unmatched: { what: "word" | "picture"; anchor: Box; by: string | null; at: string; why: "gone" | "tied" }[];
  /** Corrections that could not be applied in full, in plain words. */
  problems: string[];
}

/** The words and pictures as they are now: the saved read with every correction applied. Null when there is no saved read. */
export async function newReadItems(db: Database, projectId: string, version: string | null): Promise<NewReadItems | null> {
  if (!version) return null;
  const saved = await loadSavedReadItems(projectId, version);
  if (!saved) return null;
  const [wordFixes, pictureFixes] = await Promise.all([loadWordCorrections(db, projectId, version), loadPictureCorrections(db, projectId, version)]);
  const words = applyWordCorrections(saved.words, wordFixes, saved.runId);
  const pictures = applyPictureCorrections(saved.pictures, pictureFixes, saved.runId, { width: saved.width, height: saved.height });
  return {
    words: words.items as NewReadItems["words"],
    pictures: pictures.items as NewReadItems["pictures"],
    unmatched: [
      ...words.unmatched.map(({ correction: { anchor, by, at }, why }) => ({ what: "word" as const, anchor, by, at, why })),
      ...pictures.unmatched.map(({ correction: { anchor, by, at }, why }) => ({ what: "picture" as const, anchor, by, at, why })),
    ],
    problems: [...words.problems, ...pictures.problems].map((p) => p.text),
  };
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function wholeBox(value: unknown): Box | null {
  if (typeof value !== "object" || value === null) return null;
  const b = value as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((k) => Number.isInteger(b[k])) ? { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number } : null;
}

/*
  The shared save: check who is asking, take the lock, find the item as the
  saved read found it, try the correction on the list as it is now, and store
  it with its activity entry in the one transaction.
*/
async function correctItem<C extends WordChange | PictureChange, T extends { asRead: Box }>(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  target: "word" | "picture",
  input: { anchor: unknown; change: C; runId: string },
  invalidOf: (change: C) => string | null,
  listOf: (saved: SavedReadItems) => { box: Box }[],
  applyAll: (saved: SavedReadItems, corrections: ItemCorrection<C>[]) => { items: T[]; problems: { id: string; reason: string }[]; unmatched: { correction: { id: string } }[] },
  describe: (item: T) => Record<string, unknown>,
  action: ActivityAction,
): Promise<void> {
  if (!actor.isAdmin) throw new MockupError("Only an admin can correct the new design read while it is being built.");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new MockupError("That project no longer exists.");
  if (proj.lane !== "lane_2") throw new MockupError("The design read is for Lane 2 (the client supplied a design).");

  // Only the fields given, as given (never converted): a null or a string is refused, not read as 0.
  const raw = (input.change ?? {}) as Record<string, unknown>;
  const change = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as unknown as C;
  if (typeof (change as WordChange).text === "string") (change as WordChange).text = ((change as WordChange).text as string).trim();
  const invalid = invalidOf(change);
  if (invalid) throw new MockupError(invalid);
  const anchor = wholeBox(input.anchor);
  if (!anchor) throw new MockupError(GONE[target]);

  await ctx.db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    await lockDesignRead(tx, projectId);
    const [row] = await tx.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
    if (!row || row.source !== "upload" || row.importStatus !== "done" || !row.fileKey) throw new MockupError("There is no read of the uploaded design to correct.");
    const saved = await loadSavedReadItems(projectId, row.fileKey);
    if (!saved || !saved.runId) throw new MockupError("Run the new read first: there is nothing to correct yet.");
    // A form opened on an earlier read would put its fields on whichever item is now in that place.
    if (input.runId !== saved.runId) throw new MockupError("The design was read again since this form was opened. Close it, and press Correct again on the item as it is now.");

    const list = listOf(saved);
    const index = list.findIndex((item) => sameBox(item.box, anchor));
    if (index < 0) throw new MockupError(GONE[target]);

    const existing = await loadCorrections<C>(tx, projectId, row.fileKey, target);
    const before = applyAll(saved, existing);
    const trial = { id: "trial", anchor, change, madeOnRun: saved.runId, by: null, at: LAST } as ItemCorrection<C>;
    const after = applyAll(saved, [...existing, trial]);
    const refused = after.problems.find((p) => p.id === "trial");
    if (refused) throw new MockupError(`Not saved: ${refused.reason}`);
    /*
      Two things of one read can share a box exactly (a background and the photo
      drawn over the same region). Neither is "the" one the correction belongs to,
      so it would be stored and never applied. Saying so beats the "Nothing was
      changed" the comparison below would otherwise give, which is untrue.
    */
    if (after.unmatched.some((u) => u.correction.id === "trial")) {
      throw new MockupError("Two things of this read sit in exactly the same place, so TAWD can't tell which one you mean. Correct the band first, or upload the picture.");
    }

    const was = describe(before.items[index]!);
    const then = describe(after.items[index]!);
    if (JSON.stringify(was) === JSON.stringify(then)) throw new MockupError("Nothing was changed.");

    await tx.insert(designReadCorrection).values({ projectId, version: row.fileKey, page: 1, target, anchor, change, madeOnRun: saved.runId, createdByUserId: actor.id });
    await recordActivity(tx, {
      ...actorFields(actor),
      action,
      entityType: "project",
      entityId: projectId,
      valueBefore: { [target]: was },
      valueAfter: { [target]: then, read: saved.runId, upload: row.fileKey },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  });
}

export async function correctReadWord(ctx: ServiceContext, actor: Viewer, projectId: string, input: { anchor: unknown; change: WordChange; runId: string }): Promise<void> {
  await correctItem<WordChange, Corrected<CorrectableWord & { band: string }>>(
    ctx,
    actor,
    projectId,
    "word",
    input,
    wordChangeProblem,
    (saved) => saved.words,
    (saved, corrections) =>
      applyWordCorrections(saved.words, corrections, saved.runId) as unknown as {
        items: Corrected<CorrectableWord & { band: string }>[];
        problems: { id: string; reason: string }[];
        unmatched: { correction: { id: string } }[];
      },
    (word) => ({ text: word.text, role: word.role, band: word.band, at: word.asRead }),
    "figma.new_read_word_corrected",
  );
}

export async function correctReadPicture(ctx: ServiceContext, actor: Viewer, projectId: string, input: { anchor: unknown; change: PictureChange; runId: string }): Promise<void> {
  await correctItem<PictureChange, Corrected<CorrectablePicture & { band: string }>>(
    ctx,
    actor,
    projectId,
    "picture",
    input,
    pictureChangeProblem,
    (saved) => saved.pictures,
    (saved, corrections) =>
      applyPictureCorrections(saved.pictures, corrections, saved.runId, { width: saved.width, height: saved.height }) as unknown as {
        items: Corrected<CorrectablePicture & { band: string }>[];
        problems: { id: string; reason: string }[];
        unmatched: { correction: { id: string } }[];
      },
    (picture) => ({ kind: picture.kind, box: picture.box, band: picture.band, at: picture.asRead }),
    "figma.new_read_picture_corrected",
  );
}

/** The pictures' own status for a read, with whether it has stopped. Null when none was ever written. */
export async function loadPrepareStatus(projectId: string, version: string, runId: string, page = 1): Promise<{ status: PrepareStatus; stalled: boolean } | null> {
  const bytes = await getStorage().get(readAssetKeys(projectId, version, page, runId).status);
  if (!bytes) return null;
  try {
    const status = JSON.parse(bytes.toString("utf8")) as PrepareStatus;
    return { status, stalled: preparedStalled(status) };
  } catch {
    return null;
  }
}

/*
  Prepare a finished read's pictures again, free (E4b-2b). No AI call is
  made, so there is no estimate and no spend check: it cuts and treats the
  pictures of the read that is already saved, with a person's corrections
  applied. It never touches the read itself, so a finished read stays
  finished whatever happens here.

  "queued" is written before the job is queued, so a second press is refused
  from now on; a prepare with no news for PREPARE_STALE_MS has stopped and
  can be started again.
*/
export async function preparePicturesAgain(ctx: ServiceContext, actor: Viewer, projectId: string, version: string, runId: string, page = 1): Promise<void> {
  if (!actor.isAdmin) throw new MockupError("Only an admin can prepare the new read's pictures while it is being built.");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new MockupError("That project no longer exists.");
  if (proj.lane !== "lane_2") throw new MockupError("The design read is for Lane 2 (the client supplied a design).");

  // The upload must still be the project's design, and the read must still be the one whose pictures these are.
  const [row] = await ctx.db.select({ fileKey: figmaDesign.fileKey, source: figmaDesign.source }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row || row.source !== "upload" || row.fileKey !== version) throw new MockupError("The design changed meanwhile; open the page again.");
  const saved = await loadSavedReadItems(projectId, version, page);
  if (!saved?.runId) throw new MockupError("Run the new read first: there are no pictures to prepare yet.");
  if (saved.runId !== runId) throw new MockupError("The design was read again since this page was opened. Reload it, and press Prepare the pictures again.");

  const running = await loadPrepareStatus(projectId, version, runId, page);
  if (running && (running.status.state === "queued" || running.status.state === "working") && !running.stalled) {
    throw new MockupError("The pictures are already being prepared for this read.");
  }

  const storage = getStorage();
  const statusKey = readAssetKeys(projectId, version, page, runId).status;
  const at = new Date().toISOString();
  const attempt = designPicturesJobId(projectId, Date.now());
  const queued: PrepareStatus = { state: "queued", attempt, runId, startedAt: at, updatedAt: at, finishedAt: null, done: 0, total: null, error: null };
  await storage.put(statusKey, Buffer.from(JSON.stringify(queued), "utf8"), "application/json");
  try {
    await getQueue().add(DESIGN_PICTURES_JOB, { projectId, startedByUserId: actor.id, version, page, runId, attempt }, { jobId: attempt, attempts: 1 });
  } catch {
    const failed: PrepareStatus = { ...queued, state: "failed", finishedAt: new Date().toISOString(), error: "The job queue wasn't answering, so the pictures were never prepared." };
    await storage.put(statusKey, Buffer.from(JSON.stringify(failed), "utf8"), "application/json");
    throw new MockupError("The pictures couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    ...actorFields(actor),
    action: "figma.new_read_pictures_prepared",
    entityType: "project",
    entityId: projectId,
    valueAfter: { version, page, read: runId, pictures: saved.pictures.length },
  });
}
