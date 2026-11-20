import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { intakeFile, project, projectIntake } from "@tawd/core/schema";
import type { Tier } from "@tawd/core/enums";
import { SYSTEM_ACTOR_ID, actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import {
  assessCompleteness,
  type CompletenessResult,
} from "./completeness";
import { heicToJpeg } from "../images/heic";
import { HEAD_BYTES, matchesDeclaredDocument, sniffImage, svgProblem } from "./sniff";
import { phoneProblem } from "../phone";
import { checkTier, type TierWarning } from "./tier";
import { checkTawdFit, type FitWarning } from "./fit";
import { StaleIntakeError, answersFilledSince, latestPrefillStamp, settlePrefillsAfterSave } from "./prefill";

export { StaleIntakeError } from "./prefill";
import { checkUpload, effectiveContentType, fileRules, type FileKind } from "./files";
import {
  buildStorageKey,
  getStorage,
  readRange,
  readyKeyOf,
} from "./storage";
import {
  emptyIntake,
  parseIntake,
  sectionSchemas,
  type IntakeData,
  type IntakeSectionKey,
} from "./schema";

/*
  What a piece of work needs to record itself: the database, and who the
  request came from. The web app extends this with its auth instance; the
  worker has no auth and does not need one.
*/
export interface ServiceContext {
  db: Database;
  ipAddress: string | null;
  userAgent: string | null;
}

export class IntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeError";
  }
}

export interface IntakeFileRecord {
  id: string;
  kind: FileKind;
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  caption: string | null;
  status: string;
  createdAt: Date;
}

export interface LoadedIntake {
  projectId: string;
  data: IntakeData;
  files: IntakeFileRecord[];
  completeness: CompletenessResult;
  tierWarning: TierWarning | null;
  /** "Better as a custom VML build": a warning, never a block. */
  fitWarning: FitWarning | null;
  updatedAt: Date | null;
}

export async function loadIntake(
  db: Database,
  viewer: Viewer,
  projectId: string,
): Promise<LoadedIntake | null> {
  assertCan(viewer, "intake.view");

  const [projectRow] = await db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!projectRow) return null;

  const [intakeRow] = await db
    .select()
    .from(projectIntake)
    .where(eq(projectIntake.projectId, projectId))
    .limit(1);

  const data = intakeRow ? parseIntake(intakeRow.data) : emptyIntake();

  // Pending rows are uploads that never finished, so they are not shown and
  // do not count towards a requirement being met.
  const files = (
    await db
      .select()
      .from(intakeFile)
      .where(eq(intakeFile.projectId, projectId))
      .orderBy(asc(intakeFile.createdAt))
  )
    .filter((row) => row.status === "ready")
    .map((row) => ({
      id: row.id,
      kind: row.kind as FileKind,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      caption: row.caption,
      status: row.status,
      createdAt: row.createdAt,
    }));

  return {
    projectId,
    data,
    files,
    completeness: assessCompleteness({
      projectTrade: projectRow.trade,
      projectLane: projectRow.lane,
      intake: data,
      files,
    }),
    tierWarning: checkTier(projectRow.tier as Tier, data),
    fitWarning: checkTawdFit(data),
    updatedAt: intakeRow?.updatedAt ?? null,
  };
}

/*
  Flattens a section into dot-separated paths so a save can record exactly
  which answers changed rather than dumping the whole section into the log.
  Lists are compared whole: "cities changed from these three to those four"
  reads better than four separate entries about array positions.
*/
function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return { [prefix]: value ?? null };
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, flatten(child, path));
  }
  return out;
}

export interface FieldChange {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changedPaths: string[];
}

export function diffSection(before: unknown, after: unknown): FieldChange {
  const flatBefore = flatten(before);
  const flatAfter = flatten(after);

  const paths = new Set([...Object.keys(flatBefore), ...Object.keys(flatAfter)]);
  const changed: string[] = [];
  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};

  for (const path of paths) {
    if (JSON.stringify(flatBefore[path]) === JSON.stringify(flatAfter[path])) {
      continue;
    }
    changed.push(path);
    beforeOut[path] = flatBefore[path] ?? null;
    afterOut[path] = flatAfter[path] ?? null;
  }

  changed.sort();
  return { before: beforeOut, after: afterOut, changedPaths: changed };
}

export interface SaveResult {
  changedPaths: string[];
  /** Only on a save that sent a stamp: the newest fill time now, for the form's next save. */
  prefillStamp?: string | null;
}

/*
  `prefillStamp` is what the form was loaded with (latestPrefillStamp; null
  when nothing had been filled). Left out, the save is not checked: TAWD's
  own fills and other server code save without a form. Sent, the save runs
  in one transaction holding lockIntakeForFills (as both fills hold it), and
  is refused with StaleIntakeError, writing nothing, when TAWD filled
  answers in this section since the form loaded and the save would change
  them.
*/
export async function saveIntakeSection(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  section: IntakeSectionKey,
  rawValues: unknown,
  options: { prefillStamp?: string | null } = {},
): Promise<SaveResult> {
  if (options.prefillStamp === undefined) return saveSectionUnchecked(ctx, actor, projectId, section, rawValues, undefined);
  assertCan(actor, "intake.edit");
  return ctx.db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    await lockIntakeForFills(tx, projectId);
    return saveSectionUnchecked({ ...ctx, db: tx }, actor, projectId, section, rawValues, options.prefillStamp);
  });
}

/*
  The one lock a checked save and both fills (the design's, the current
  site's) take, inside their transaction, so they run one after another.
  It is the project's row, not the intake's: the intake row only exists
  after the first save, and locking a row that isn't there locks nothing
  (Fable's review of #93). FOR NO KEY UPDATE, not FOR UPDATE, so writes that
  only point at the project (activity entries and the like) are never held
  up or deadlocked by it. Throws when the project is gone.
*/
export async function lockIntakeForFills(tx: Database, projectId: string): Promise<void> {
  const [locked] = await tx.select({ id: project.id }).from(project).where(eq(project.id, projectId)).for("no key update");
  if (!locked) throw new IntakeError("This project no longer exists.");
}

async function saveSectionUnchecked(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  section: IntakeSectionKey,
  rawValues: unknown,
  checkStamp: string | null | undefined,
): Promise<SaveResult> {
  assertCan(actor, "intake.edit");

  const parsed = sectionSchemas[section].safeParse(rawValues);
  if (!parsed.success) {
    throw new IntakeError(
      parsed.error.issues[0]?.message ?? "That section could not be saved.",
    );
  }

  const [existing] = await ctx.db
    .select()
    .from(projectIntake)
    .where(eq(projectIntake.projectId, projectId))
    .limit(1);

  const current = existing ? parseIntake(existing.data) : emptyIntake();

  /*
    A phone number must be one a person can dial (F-035). Checked here on save,
    not in the schema: the schema also reads stored rows, and a bad value saved
    before this rule must still load (it shows as missing in the completeness
    check instead). A number unchanged from what is stored passes, so an old
    bad value never stops the rest of the section being saved.
  */
  if (section === "business") {
    const business = parsed.data as IntakeData["business"];
    const before = new Set([current.business.phone, ...current.business.locations.map((l) => l.phone)]);
    for (const phone of [business.phone, ...business.locations.map((l) => l.phone)]) {
      const problem = before.has(phone) ? null : phoneProblem(phone);
      if (problem) throw new IntakeError(problem);
    }
  }

  // Only this section is written: the others stay exactly as stored, so a
  // stored value a later rule refuses is never overwritten with its blank.
  const stored = existing?.data && typeof existing.data === "object" && !Array.isArray(existing.data) ? (existing.data as Record<string, unknown>) : current;
  const next = { ...stored, [section]: parsed.data } as IntakeData;

  const change = diffSection(current[section], parsed.data);

  // A form opened before TAWD filled answers: refused before anything is written (the caller holds lockIntakeForFills).
  let stampOut: { prefillStamp: string | null } | Record<string, never> = {};
  if (checkStamp !== undefined) {
    const count = await answersFilledSince(ctx.db, projectId, section, next, checkStamp);
    if (count > 0) throw new StaleIntakeError(count);
    stampOut = { prefillStamp: await latestPrefillStamp(ctx.db, projectId) };
  }

  // Nothing moved, so nothing is written and the log stays honest.
  if (change.changedPaths.length === 0) {
    return { changedPaths: [], ...stampOut };
  }

  /*
    D2 (audit F-012): only this section is written, in one statement. The
    whole intake used to be written back from what this save had read, so
    two saves of different sections at the same moment put each other's
    section back as it was (one silently lost, both logged as saved), and on
    a project with no intake yet the second insert failed with a raw
    database error. Now a new row is inserted whole, and an existing row has
    only this section replaced inside the stored JSON (jsonb_set), so a
    section saved meanwhile by someone else is never touched.
  */
  // TAWD itself (filling answers from the current site) is no user.
  const updatedByUserId = actor.id === SYSTEM_ACTOR_ID ? null : actor.id;
  await ctx.db
    .insert(projectIntake)
    .values({ projectId, data: next, updatedByUserId })
    .onConflictDoUpdate({
      target: projectIntake.projectId,
      set: {
        // A stored intake that isn't a JSON object (only a raw write could make one) is replaced whole, as the old save did; jsonb_set would fail on it (the batch D review).
        data: sql`case when jsonb_typeof(${projectIntake.data}) = 'object' then jsonb_set(${projectIntake.data}, ${`{${section}}`}::text[], ${JSON.stringify(parsed.data)}::jsonb, true) else excluded.data end`,
        updatedByUserId,
        updatedAt: new Date(),
      },
    });

  await recordActivity(ctx.db, {
    action: "intake.updated",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { section, ...change.before },
    valueAfter: { section, ...change.after },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  // A field filled from the design and now saved differently was corrected: its mark comes off.
  await settlePrefillsAfterSave(ctx.db, actor, projectId, section, next, ctx);

  return { changedPaths: change.changedPaths, ...stampOut };
}

/* ---------- files ---------- */

async function countReadyFiles(
  db: Database,
  projectId: string,
  kind: FileKind,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(intakeFile)
    .where(
      and(
        eq(intakeFile.projectId, projectId),
        eq(intakeFile.kind, kind),
        eq(intakeFile.status, "ready"),
      ),
    );
  return row?.count ?? 0;
}

export interface UploadTicket {
  fileId: string;
  uploadUrl: string;
}

/**
 * Checks the rules, reserves a row, and hands back a short-lived permission
 * slip for the browser to upload straight to Cloudflare.
 */
/*
  The client's design files belong to the intake's Design section, which
  web designers may change as well as PMs (29 September 2026). Every other
  file stays with whoever edits the intake.
*/
export function canChangeFile(actor: Viewer, kind: FileKind): boolean {
  return can(actor, kind === "design_file" ? "intake.design" : "intake.edit");
}

function assertCanFile(actor: Viewer, kind: FileKind): void {
  assertCan(actor, kind === "design_file" ? "intake.design" : "intake.edit");
}

/* Before the file is read: someone who may change some kind of file. */
function assertCanAnyFile(actor: Viewer): void {
  if (!can(actor, "intake.design")) assertCan(actor, "intake.edit");
}

export async function requestUpload(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  kind: FileKind,
  fileName: string,
  contentType: string,
  declaredSizeBytes: number,
): Promise<UploadTicket> {
  assertCanFile(actor, kind);

  const existingCount = await countReadyFiles(ctx.db, projectId, kind);
  /*
    The file's name is given too, for a browser that reports no type at all
    (a .HEIC on Windows: see files.ts). The type the row keeps is the same
    one that was judged, so nothing downstream is left with an empty type.
  */
  const verdict = checkUpload(kind, contentType, declaredSizeBytes, existingCount, fileName);
  if (!verdict.ok) throw new IntakeError(verdict.message);
  const judgedType = effectiveContentType(contentType, fileName);

  const [created] = await ctx.db
    .insert(intakeFile)
    .values({
      projectId,
      kind,
      // Replaced immediately below; the row id is needed to build the key.
      storageKey: `pending-${crypto.randomUUID()}`,
      fileName: fileName.slice(0, 200),
      contentType: judgedType,
      status: "pending",
      uploadedByUserId: actor.id,
    })
    .returning({ id: intakeFile.id });

  const fileId = created!.id;
  const storageKey = buildStorageKey(projectId, kind, fileId, fileName);

  await ctx.db
    .update(intakeFile)
    .set({ storageKey })
    .where(eq(intakeFile.id, fileId));

  return {
    fileId,
    uploadUrl: await getStorage().signUpload(storageKey, contentType),
  };
}

/**
 * Called once the browser says the upload finished.
 *
 * The size is checked against Cloudflare rather than trusted from the
 * browser. A permission slip cannot cap the size by itself, so without this
 * the limits would be a suggestion: anything over is deleted and refused.
 */
export async function confirmUpload(
  ctx: ServiceContext,
  actor: Viewer,
  fileId: string,
): Promise<void> {
  assertCanAnyFile(actor);

  const [row] = await ctx.db
    .select()
    .from(intakeFile)
    .where(eq(intakeFile.id, fileId))
    .limit(1);
  if (!row) throw new IntakeError("That upload is no longer waiting.");
  assertCanFile(actor, row.kind as FileKind);
  // Already checked and kept (a second confirm of the same upload): nothing to do, and nothing to undo.
  if (row.status !== "pending") return;

  const storage = getStorage();
  // Storage didn't answer: the upload may well be there, so its record stays (13 October 2026, the whole-code review).
  const retry = () => new IntakeError("File storage didn't answer. Try again in a minute; the upload is kept.");
  const headOf = async (key: string) => {
    try {
      return await storage.head(key);
    } catch {
      throw retry();
    }
  };
  const rules = fileRules[row.kind as FileKind];
  const uploadKey = row.storageKey;
  const readyKey = readyKeyOf(uploadKey);
  /*
    CodeRabbit #81 (second review): two confirms of one upload can run side
    by side. Every delete here is limited to the row still waiting (status
    "pending"), so a confirm that lags behind can never delete the row
    another confirm has already made ready. A confirm that doesn't own the
    ready key (below) also deletes only a row still naming its upload key,
    so it can't delete the row another confirm claimed and is still checking
    (Fable's re-review of #81).
  */
  const dropPending = () =>
    ctx.db
      .delete(intakeFile)
      .where(
        ownsReady
          ? and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending"))
          : and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending"), eq(intakeFile.storageKey, uploadKey)),
      );
  /*
    Fable's review of #81: the ready copy is removed only by a confirm that
    owns it (it claimed the row, or the row already named the ready key when
    read). A confirm still on the upload key that lost the claim must not
    remove the copy another confirm made ready.
  */
  let ownsReady = uploadKey === readyKey;
  const refuse = async (message: string): Promise<never> => {
    for (const key of new Set(ownsReady ? [uploadKey, readyKey] : [uploadKey])) await storage.remove(key);
    await dropPending();
    throw new IntakeError(`${message} The upload was removed.`);
  };
  const checkSize = async (found: { sizeBytes: number }) => {
    // Nothing to read in an empty object (a ranged read of it is a 416), and nothing a person could use.
    if (found.sizeBytes === 0) await refuse("That file is empty (0 bytes).");
    if (found.sizeBytes > rules.maxBytes) await refuse(`${rules.label} must be smaller than that.`);
  };

  /*
    CodeRabbit #81: the permission slip that wrote the upload key stays good
    for five minutes and can be used again, so a file checked at its upload
    key could be swapped afterwards. The first confirm copies the object to a
    ready key no slip was signed for (a copy on R2's side, a snapshot),
    points the row at it and removes the upload key; every check below reads
    the copy. So the order is: size from head() (nothing over its limit is
    copied), claim the row, copy, then judge the copy. Whatever is swapped into the upload
    key after the copy is never read by anything.

    Only one confirm copies (CodeRabbit #81, second review): the row is
    claimed first by moving it to the ready key in one conditional update,
    and a confirm that finds it already moved stops there. Otherwise a
    second confirm's copy could land on the ready key after the first had
    judged it, putting bytes nobody checked behind a ready row.
  */
  if (uploadKey !== readyKey) {
    const first = await headOf(uploadKey);
    if (!first) {
      const [dropped] = await ctx.db
        .delete(intakeFile)
        .where(and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending"), eq(intakeFile.storageKey, uploadKey)))
        .returning({ id: intakeFile.id });
      // Nothing dropped: another confirm already moved it to the ready key, so it did arrive.
      if (!dropped) return;
      throw new IntakeError("That upload did not arrive. Try again.");
    }
    await checkSize(first);
    const [claimed] = await ctx.db
      .update(intakeFile)
      .set({ storageKey: readyKey })
      .where(and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending"), eq(intakeFile.storageKey, uploadKey)))
      .returning({ id: intakeFile.id });
    // Another confirm of this upload has it; that one finishes the job.
    if (!claimed) return;
    ownsReady = true;
    try {
      await storage.copy(uploadKey, readyKey);
    } catch {
      // Hand the row back so a retry starts from the upload key again.
      await ctx.db
        .update(intakeFile)
        .set({ storageKey: uploadKey })
        .where(and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending"), eq(intakeFile.storageKey, readyKey)));
      throw retry();
    }
    // The row no longer names it, so a failed delete only leaves an unused object (removed with the project).
    await storage.remove(uploadKey).catch(() => undefined);
  }

  const object = await headOf(readyKey);
  if (!object) {
    if (uploadKey !== readyKey) {
      // This confirm just copied it, so it is there unless storage lost it.
      await dropPending();
      throw new IntakeError("That upload did not arrive. Try again.");
    }
    /*
      The row names the ready key but the copy isn't there: another confirm
      claimed the row and is copying it now (or was stopped mid-copy). Not
      ours to delete; the waiting row is never shown, so at worst it is left
      unused until the project is removed.
    */
    throw new IntakeError("That upload is still being checked. Wait a minute; if it doesn't appear, upload it again.");
  }
  await checkSize(object);

  let readyContentType = row.contentType;
  let readySize = object.sizeBytes;
  let readyFileName = row.fileName;
  // HEIC/HEIF (the iPhone default) can't be shown in a browser or sent to the
  // AI, so it's converted to JPEG at ingress (gap 11). Detected by the file's
  // bytes, never its content type or name: iPhone photos often arrive as ".jpg"
  // or labelled "image/jpeg" while the bytes are still HEIC. The original is kept.
  /*
    F-041 (batch C6, 12 November 2026): EVERY file's first bytes are checked
    against its declared type, not only a file let in by its name. A ".png"
    that is really HTML used to be accepted, and the whole file (up to 40 MB)
    was downloaded into this container to look at it. Now only the first
    HEAD_BYTES are read (a ranged read), after the size is checked from
    head() above; a HEIC to convert or an SVG to scan is read whole (its size
    is already known to be within the kind's limit). A mismatch removes the
    object and the record.
  */
  const readWhole = async (): Promise<Buffer> => {
    let whole: Buffer | null;
    try {
      whole = await storage.get(readyKey);
    } catch {
      throw retry();
    }
    if (!whole) throw retry();
    return whole;
  };
  let head: Buffer | null;
  try {
    head = await readRange(storage, readyKey, HEAD_BYTES);
  } catch {
    throw retry();
  }
  if (!head) throw retry();

  let bytes: Buffer | null = null;
  const declared = row.contentType.trim().toLowerCase();
  if (declared.startsWith("image/")) {
    const shown = sniffImage(head);
    if (!shown || !rules.contentTypes.includes(shown)) {
      await refuse(`That file isn't the image its name says. ${rules.label} must be one of: ${rules.accept.replace(/\./g, "").replace(/,/g, ", ")}.`);
    } else if (shown === "image/heic") {
      bytes = await readWhole();
      /*
        Fable's re-review of #81: a second confirm of the same photo (a second
        click is enough) can read the file after the first has already written
        its JPEG over it. Those bytes are no longer HEIC, so converting them
        would fail and the failure path would delete the first one's file. The
        first confirm is finishing the job, so this one stops here.
      */
      if (sniffImage(bytes.subarray(0, HEAD_BYTES)) !== "image/heic") return;
    } else {
      if (shown === "image/svg+xml") {
        const problem = svgProblem((await readWhole()).toString("utf8"));
        if (problem) await refuse(`That SVG can't be used: ${problem}. Export a plain SVG (no scripts, nothing loaded from another website) and upload it again.`);
      }
      readyContentType = shown;
    }
  } else if (!matchesDeclaredDocument(declared, head)) {
    await refuse(`That file isn't the kind of file its name says. ${rules.label} must be one of: ${rules.accept.replace(/\./g, "").replace(/,/g, ", ")}.`);
  }
  if (bytes) {
    try {
      await storage.put(`${readyKey}.heic-original`, bytes, "image/heic");
      const jpeg = await heicToJpeg(bytes);
      await storage.put(readyKey, jpeg, "image/jpeg");
      readyContentType = "image/jpeg";
      readySize = jpeg.length;
      readyFileName = `${row.fileName.replace(/\.(heic|heif|jpe?g|png|webp)$/i, "")}.jpg`;
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      await storage.remove(readyKey);
      await storage.remove(`${readyKey}.heic-original`).catch(() => undefined);
      await dropPending();
      throw new IntakeError(
        "That photo is a HEIC/HEIF (iPhone) image TAWD couldn't convert. Re-save it as JPEG and upload again.",
      );
    }
  }

  const [madeReady] = await ctx.db
    .update(intakeFile)
    .set({ status: "ready", sizeBytes: readySize, contentType: readyContentType, fileName: readyFileName })
    .where(and(eq(intakeFile.id, fileId), eq(intakeFile.status, "pending")))
    .returning({ id: intakeFile.id });
  // Another confirm got there first and logged it: one upload, one entry.
  if (!madeReady) return;

  await recordActivity(ctx.db, {
    action: "intake.file_added",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueAfter: {
      kind: row.kind,
      fileName: readyFileName,
      sizeBytes: readySize,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setFileCaption(
  ctx: ServiceContext,
  actor: Viewer,
  fileId: string,
  caption: string,
): Promise<void> {
  assertCanAnyFile(actor);

  const [row] = await ctx.db
    .select()
    .from(intakeFile)
    .where(eq(intakeFile.id, fileId))
    .limit(1);
  if (!row) throw new IntakeError("That file no longer exists.");
  assertCanFile(actor, row.kind as FileKind);

  const next = caption.trim().slice(0, 300);
  if ((row.caption ?? "") === next) return;

  await ctx.db
    .update(intakeFile)
    .set({ caption: next })
    .where(eq(intakeFile.id, fileId));

  await recordActivity(ctx.db, {
    action: "intake.file_captioned",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    valueBefore: { fileName: row.fileName, caption: row.caption ?? "" },
    valueAfter: { fileName: row.fileName, caption: next },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function removeFile(
  ctx: ServiceContext,
  actor: Viewer,
  fileId: string,
): Promise<void> {
  assertCanAnyFile(actor);

  const [row] = await ctx.db
    .select()
    .from(intakeFile)
    .where(eq(intakeFile.id, fileId))
    .limit(1);
  if (!row) return;
  assertCanFile(actor, row.kind as FileKind);

  await getStorage().remove(row.storageKey);
  await ctx.db.delete(intakeFile).where(eq(intakeFile.id, fileId));

  await recordActivity(ctx.db, {
    action: "intake.file_removed",
    entityType: "project",
    entityId: row.projectId,
    ...actorFields(actor),
    // The row is gone, so the log is the only remaining record of it.
    valueBefore: {
      kind: row.kind,
      fileName: row.fileName,
      caption: row.caption ?? "",
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/** A link that works for five minutes, for a signed-in viewer. */
export async function getFileViewUrl(
  db: Database,
  viewer: Viewer,
  fileId: string,
): Promise<string | null> {
  assertCan(viewer, "intake.view");

  const [row] = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.id, fileId), eq(intakeFile.status, "ready")))
    .limit(1);
  if (!row) return null;

  return getStorage().signDownload(row.storageKey, row.fileName);
}
