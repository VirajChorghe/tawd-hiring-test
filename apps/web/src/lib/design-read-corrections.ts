import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { designReadCorrection, figmaDesign, project, user } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Viewer } from "@tawd/core/permissions";
import { applyBandCorrections, changeProblem, type BandChange, type BandCorrection, type CorrectedBand, type UnmatchedCorrection } from "@tawd/core/figma/read-corrections";
import { lockDesignRead } from "@tawd/core/figma/read-lock";
import { MockupError } from "@/lib/mockups";
import { loadSavedReadBands, type NewReadView } from "@/lib/design-read-new";
import type { ServiceContext } from "@/lib/users";

/*
  Corrections to the new design read's band list, from the web side (E4b-2,
  Lane 2, 14 November 2026). Admins only while the new route is built (Jason,
  14 November). A correction is anchored to a band of the saved read as it
  was read (never as already corrected), stored as a new row (rows are only
  ever added), and recorded in the activity log with the band before and
  after. How corrections apply, also after a re-read, is in core
  figma/read-corrections.ts.
*/

const BAND_GONE = "That band is no longer in the read (it may have been read again). Reload the page and try again.";

/** Sorts after any real time, so a trial correction is applied last. */
const LAST = "9999-12-31T23:59:59.999Z";

/** Every band correction for an upload, oldest first, with who made it. */
export async function loadBandCorrections(db: Database, projectId: string, version: string): Promise<BandCorrection[]> {
  const rows = await db
    .select({ row: designReadCorrection, by: user.name })
    .from(designReadCorrection)
    .leftJoin(user, eq(user.id, designReadCorrection.createdByUserId))
    .where(and(eq(designReadCorrection.projectId, projectId), eq(designReadCorrection.version, version), eq(designReadCorrection.target, "band")))
    .orderBy(asc(designReadCorrection.createdAt), asc(designReadCorrection.id));
  return rows.map(({ row, by }) => ({
    id: row.id,
    anchor: row.anchor as BandCorrection["anchor"],
    change: row.change as BandChange,
    madeOnRun: row.madeOnRun,
    by: by ?? null,
    at: row.createdAt.toISOString(),
  }));
}

type SummaryBand = NonNullable<NewReadView["result"]>["bands"][number];

export interface NewReadCorrections {
  /** The band list as it is now: the saved read with every correction applied, each band marked if corrected. */
  bands: CorrectedBand<SummaryBand>[];
  /** Corrections no band of this read matches any more (the band list changed in a re-read). */
  unmatched: { anchor: { top: number; bottom: number }; change: BandChange; by: string | null; at: string; why: UnmatchedCorrection["why"] }[];
  /** Corrections that could not be applied in full, in plain words. */
  problems: string[];
}

/** The corrections for what the panel shows: null when there is no saved read. */
export async function newReadCorrections(db: Database, projectId: string, view: NewReadView): Promise<NewReadCorrections | null> {
  if (!view.version || !view.result) return null;
  const corrections = await loadBandCorrections(db, projectId, view.version);
  const applied = applyBandCorrections(view.result.bands, corrections, view.result.height, view.result.runId);
  return {
    bands: applied.bands,
    unmatched: applied.unmatched.map(({ correction: { anchor, change, by, at }, why }) => ({ anchor, change, by, at, why })),
    problems: applied.problems.map((p) => p.text),
  };
}

export async function correctReadBand(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { anchor: { top: number; bottom: number }; change: BandChange; /** The read the form was opened on. */ runId: string },
): Promise<void> {
  if (!actor.isAdmin) throw new MockupError("Only an admin can correct the new design read while it is being built.");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new MockupError("That project no longer exists.");
  if (proj.lane !== "lane_2") throw new MockupError("The design read is for Lane 2 (the client supplied a design).");

  // Only the fields given, as given (never converted: a null or a string is refused, not read as 0); a name is trimmed.
  const raw = (input.change ?? {}) as Record<string, unknown>;
  const change = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as BandChange;
  if (typeof change.name === "string") change.name = change.name.trim();
  const invalid = changeProblem(change);
  if (invalid) throw new MockupError(invalid);
  const anchor = { top: input.anchor?.top, bottom: input.anchor?.bottom };
  if (!Number.isInteger(anchor.top) || !Number.isInteger(anchor.bottom)) throw new MockupError(BAND_GONE);

  /*
    Everything that depends on the read as it is now runs under the project's design-read lock, in one
    transaction (CodeRabbit's review of #97): two saves never both pass on the same band list, a new read
    can't be published between the check and the insert (the worker takes the same lock to save one), and
    the correction and its activity entry are saved together or not at all.
  */
  await ctx.db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    await lockDesignRead(tx, projectId);
    const [row] = await tx.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
    if (!row || row.source !== "upload" || row.importStatus !== "done" || !row.fileKey) throw new MockupError("There is no read of the uploaded design to correct.");
    const saved = await loadSavedReadBands(projectId, row.fileKey);
    if (!saved || !saved.runId) throw new MockupError("Run the new read first: there is no band list to correct yet.");
    // A form opened on an earlier read would put its fields on whichever band is now in that row (Fable's review).
    if (input.runId !== saved.runId) throw new MockupError("The design was read again since this form was opened. Close it, and press Correct again on the band as it is now.");

    // Anchored to a band as the saved read found it, never to a corrected position.
    const index = saved.bands.findIndex((b) => b.top === anchor.top && b.bottom === anchor.bottom);
    if (index < 0) throw new MockupError(BAND_GONE);
    const at = { top: anchor.top as number, bottom: anchor.bottom as number };

    // Tried on the band list as it is now (every earlier correction applied), last of all, before it is saved.
    const existing = await loadBandCorrections(tx, projectId, row.fileKey);
    const before = applyBandCorrections(saved.bands, existing, saved.height, saved.runId);
    const trial: BandCorrection = { id: "trial", anchor: at, change, madeOnRun: saved.runId, by: null, at: LAST };
    const after = applyBandCorrections(saved.bands, [...existing, trial], saved.height, saved.runId);
    const refused = after.problems.find((p) => p.id === "trial");
    if (refused) throw new MockupError(`Not saved: ${refused.reason}`);

    const was = before.bands[index]!;
    const then = after.bands[index]!;
    if (was.name === then.name && was.role === then.role && was.top === then.top && was.bottom === then.bottom) throw new MockupError("Nothing was changed.");

    await tx.insert(designReadCorrection).values({ projectId, version: row.fileKey, page: 1, target: "band", anchor: at, change, madeOnRun: saved.runId, createdByUserId: actor.id });
    await recordActivity(tx, {
      ...actorFields(actor),
      action: "figma.new_read_band_corrected",
      entityType: "project",
      entityId: projectId,
      valueBefore: { band: { name: was.name, role: was.role, top: was.top, bottom: was.bottom } },
      valueAfter: {
        band: { name: then.name, role: then.role, top: then.top, bottom: then.bottom },
        // A neighbour whose edge moved with this one, so the log shows every band that changed.
        alsoMoved: after.bands
          .map((b, n) => ({ b, was: before.bands[n]! }))
          .filter(({ b, was: w }, n) => n !== index && (b.top !== w.top || b.bottom !== w.bottom))
          .map(({ b, was: w }) => ({ name: b.name, from: { top: w.top, bottom: w.bottom }, to: { top: b.top, bottom: b.bottom } })),
        read: saved.runId,
        upload: row.fileKey,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  });
}
