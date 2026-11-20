import { and, eq } from "drizzle-orm";

import { figmaDesign, intakePrefill, project, user as userTable } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { PREFILL_LABELS, parseFigmaLink, type PrefillKey, type Readiness } from "@tawd/core/figma";
import {
  checkFigmaFile,
  chooseFigmaPage,
  figmaReadsThisMonth,
  type FigmaDesignRow,
  type ImportedFrame,
} from "@tawd/core/figma/service";
import { getStorage } from "@tawd/core/intake/storage";
import { DesignPrefillError, prefillText, runDesignPrefill, type DesignPrefillResult } from "@tawd/core/figma/design-prefill";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { FIGMA_IMPORT_JOB, figmaImportJobId } from "@tawd/core/queue";
import { getQueue } from "@/lib/mockups";
import { personLabel, type ServiceContext } from "@/lib/users";
import { formatActivityWhen } from "@/lib/project-overview";
import type { DesignReadProgress, FigmaSectionView } from "@/components/intake/figma-section";
import type { DesignerDesignProps } from "@/components/mockups/designer-design";

/*
  Lane 2, Option B, part 1: the designer's Figma file. The PM pastes the
  link in the intake; TAWD reads the file (free, no AI) and says in plain
  words what is missing, as warnings that never block; then imports the
  final frames as "Concept 1: Designer's design".
*/

type Db = ServiceContext["db"];

export class FigmaDesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaDesignError";
  }
}

/* Lane 2, either option (28 September 2026: Option A builds the client-approved design exactly). */
async function requireLane2(db: Db, projectId: string): Promise<void> {
  const [row] = await db
    .select({ lane: project.lane, laneOption: project.laneOption })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw new FigmaDesignError("That project no longer exists.");
  if (row.lane !== "lane_2") {
    throw new FigmaDesignError("A Figma design is only for Lane 2 (the client supplied a design).");
  }
}

async function logCheck(ctx: ServiceContext, actor: Viewer, projectId: string, row: FigmaDesignRow): Promise<void> {
  const readiness = row.readiness as Readiness | null;
  await recordActivity(ctx.db, {
    action: "figma.checked",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter:
      row.checkStatus === "failed"
        ? { status: "failed", reason: row.failureMessage }
        : {
            status: row.checkStatus,
            fileName: row.fileName,
            frames: readiness?.frames.map((f) => f.name) ?? [],
            warnings: readiness?.items.filter((i) => i.status === "warning").map((i) => i.title) ?? [],
          },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Saves the link and reads the file at once (one Figma read). */
export async function saveFigmaLink(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  link: string,
): Promise<FigmaDesignRow> {
  assertCan(actor, "intake.design");
  await requireLane2(ctx.db, projectId);

  const fileKey = parseFigmaLink(link);
  if (!fileKey) {
    throw new FigmaDesignError(
      "That isn't a Figma file link. Copy it from Figma's Share button or the address bar; it looks like https://www.figma.com/design/…",
    );
  }

  const [existing] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const url = link.trim();
  if (!existing) {
    await ctx.db.insert(figmaDesign).values({ projectId, url, fileKey, linkedByUserId: actor.id });
  } else if (existing.fileKey !== fileKey) {
    // A different file: nothing from the old one carries over.
    await ctx.db
      .update(figmaDesign)
      .set({
        url,
        fileKey,
        // A Figma link replacing an uploaded design is Figma from now on, and the upload's reading is gone (13 October 2026, the whole-code review).
        source: "figma",
        importProgress: null,
        pagesRead: null,
        importQueuedAt: null,
        linkedByUserId: actor.id,
        linkedAt: new Date(),
        checkStatus: null,
        checkedAt: null,
        failureKind: null,
        failureMessage: null,
        fileName: null,
        figmaVersion: null,
        readiness: null,
        fileJsonKey: null,
        chosenPageId: null,
        importStatus: null,
        importFailure: null,
        importedAt: null,
        importedByUserId: null,
        importedVersion: null,
        frames: null,
        imageFiles: null,
        importWarnings: null,
      })
      .where(eq(figmaDesign.projectId, projectId));
  } else if (existing.url !== url) {
    await ctx.db.update(figmaDesign).set({ url }).where(eq(figmaDesign.projectId, projectId));
  }

  if (!existing || existing.fileKey !== fileKey) {
    await recordActivity(ctx.db, {
      action: "figma.linked",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueBefore: existing ? { fileKey: existing.fileKey, fileName: existing.fileName } : null,
      valueAfter: { fileKey, url },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  const checked = await checkFigmaFile(ctx.db, projectId);
  await logCheck(ctx, actor, projectId, checked);
  return checked;
}

/* "Check again": one Figma read, only when asked. */
export async function recheckFigma(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<FigmaDesignRow> {
  assertCan(actor, "intake.design");
  await requireLane2(ctx.db, projectId);
  const [existing] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!existing) throw new FigmaDesignError("Paste the Figma link first.");
  if (existing.importStatus === "queued" || existing.importStatus === "working") {
    throw new FigmaDesignError("The design is being imported. Check again when it has finished.");
  }
  const checked = await checkFigmaFile(ctx.db, projectId);
  await logCheck(ctx, actor, projectId, checked);
  return checked;
}

/* The final page, when no page is named as final: from the saved file, no Figma read. */
export async function chooseFinalPage(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  pageId: string,
): Promise<FigmaDesignRow> {
  assertCan(actor, "intake.design");
  await requireLane2(ctx.db, projectId);
  let updated: FigmaDesignRow;
  try {
    updated = await chooseFigmaPage(ctx.db, projectId, pageId);
  } catch (error) {
    throw new FigmaDesignError(error instanceof Error ? error.message : "That page could not be chosen.");
  }
  const readiness = updated.readiness as Readiness;
  await recordActivity(ctx.db, {
    action: "figma.page_chosen",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: readiness.finalPage?.name ?? null, frames: readiness.frames.map((f) => f.name) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return updated;
}

/* Queues the import (the worker renders the frames: two Figma reads at most). */
export async function queueFigmaImport(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "intake.design");
  await requireLane2(ctx.db, projectId);
  const [row] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row) throw new FigmaDesignError("Paste the Figma link first.");
  if (row.checkStatus === "failed" || !row.readiness) {
    throw new FigmaDesignError("The file couldn't be read, so there is nothing to import. Fix what the check says, then check again.");
  }
  if ((row.readiness as Readiness).frames.length === 0) {
    throw new FigmaDesignError("There are no final frames to import. Choose the page that holds the final design first.");
  }
  if (row.importStatus === "queued" || row.importStatus === "working") {
    throw new FigmaDesignError("The design is already being imported.");
  }

  await ctx.db
    .update(figmaDesign)
    .set({ importStatus: "queued", importFailure: null, importedByUserId: actor.id, importQueuedAt: new Date() })
    .where(eq(figmaDesign.projectId, projectId));
  try {
    await getQueue().add(FIGMA_IMPORT_JOB, { projectId }, { jobId: figmaImportJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    await ctx.db
      .update(figmaDesign)
      .set({ importStatus: row.importStatus, importFailure: row.importFailure })
      .where(eq(figmaDesign.projectId, projectId));
    throw new FigmaDesignError("The import couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }

  await recordActivity(ctx.db, {
    action: "figma.import_queued",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { fileName: row.fileName, frames: (row.readiness as Readiness).frames.map((f) => f.name) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- what the screens read ---------- */

export interface FigmaDesignView {
  url: string;
  /** "figma" or "upload" (a PDF or images, 28 September 2026). */
  source: string;
  fileName: string | null;
  checkStatus: "ok" | "warnings" | "failed" | null;
  checkedAt: Date | null;
  failureMessage: string | null;
  readiness: Readiness | null;
  importStatus: "queued" | "working" | "done" | "failed" | null;
  importFailure: string | null;
  importProgress: DesignReadProgress | null;
  importedAt: Date | null;
  importedBy: string | null;
  /** The file changed in Figma since it was imported. */
  importOutOfDate: boolean;
  importWarnings: string[];
  frames: (ImportedFrame & { imageUrl: string | null })[];
  readsThisMonth: number;
  /** The last "Pre-fill the intake from the design". */
  prefill: PrefillResult | null;
}

export async function loadFigmaDesign(db: Db, projectId: string): Promise<FigmaDesignView | null> {
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row) return null;

  let importedBy: string | null = null;
  if (row.importedByUserId) {
    const [person] = await db
      .select({ name: userTable.name, deletedAt: userTable.deletedAt })
      .from(userTable)
      .where(eq(userTable.id, row.importedByUserId))
      .limit(1);
    importedBy = person ? personLabel(person.name, person.deletedAt) : null;
  }

  const storage = getStorage();
  const frames = await Promise.all(
    ((row.frames as ImportedFrame[] | null) ?? []).map(async (frame) => ({
      ...frame,
      imageUrl: frame.imageKey ? await storage.signDownload(frame.imageKey, `${frame.name}.png`) : null,
    })),
  );

  return {
    url: row.url,
    source: row.source,
    fileName: row.fileName,
    checkStatus: row.checkStatus as FigmaDesignView["checkStatus"],
    checkedAt: row.checkedAt,
    failureMessage: row.failureMessage,
    readiness: row.readiness as Readiness | null,
    importStatus: row.importStatus as FigmaDesignView["importStatus"],
    importFailure: row.importFailure,
    importProgress: (row.importProgress as DesignReadProgress | null) ?? null,
    importedAt: row.importedAt,
    importedBy,
    importOutOfDate: Boolean(row.importedVersion && row.figmaVersion && row.importedVersion !== row.figmaVersion),
    importWarnings: (row.importWarnings as string[] | null) ?? [],
    frames,
    readsThisMonth: await figmaReadsThisMonth(db),
    prefill: (row.prefillResult as PrefillResult | null) ?? null,
  };
}

/* The intake section's view: dates in words, only what the card shows. */
export function figmaSectionView(view: FigmaDesignView): FigmaSectionView {
  const frames = view.frames.length;
  return {
    url: designSourceOf(view) === "figma" ? view.url : "",
    source: designSourceOf(view) === "figma" ? "figma" : "upload",
    fileName: view.fileName,
    checkStatus: view.checkStatus,
    checkedAt: view.checkedAt ? whenInSentence(view.checkedAt) : null,
    failureMessage: view.failureMessage,
    items: view.readiness?.items ?? [],
    pages: view.readiness?.pages ?? [],
    finalPage: view.readiness?.finalPage ?? null,
    frameCount: view.readiness?.frames.length ?? 0,
    importStatus: view.importStatus,
    importFailure: view.importFailure,
    importProgress: view.importProgress,
    importedLine: view.importedAt
      ? `${frames} frame${frames === 1 ? "" : "s"}, ${whenInSentence(view.importedAt)}${view.importedBy ? ` by ${view.importedBy}` : ""}.`
      : null,
    importOutOfDate: view.importOutOfDate,
    importWarnings: view.importWarnings,
    prefill: view.prefill
      ? {
          ...view.prefill,
          when: whenInSentence(new Date(view.prefill.at)),
        }
      : null,
  };
}

/* The section's badge in the intake's section list. */
export function figmaBadge(view: FigmaDesignView | null): { text: string; kind: "done" | "missing" | "warning" | "info" } {
  if (!view) return { text: "Not linked", kind: "missing" };
  if (view.checkStatus === "failed") return { text: "Can't read", kind: "missing" };
  // An uploaded design: reading, or its read failed (27 September 2026: it said "Checked").
  const uploaded = designSourceOf(view) !== "figma";
  if (uploaded && (view.importStatus === "queued" || view.importStatus === "working")) return { text: "Reading", kind: "info" };
  if (uploaded && view.importStatus === "failed") return { text: "Can't read", kind: "missing" };
  const warnings = (view.readiness?.warnings ?? 0) + view.importWarnings.length;
  if (warnings > 0) return { text: `${warnings} warning${warnings === 1 ? "" : "s"}`, kind: "warning" };
  if (view.importStatus === "done") return { text: "Imported", kind: "done" };
  return { text: "Checked", kind: "info" };
}

/* The Mockups page's "Concept 1: Designer's design" card. */
export function designerDesignProps(projectId: string, view: FigmaDesignView | null): DesignerDesignProps {
  const status: DesignerDesignProps["status"] = !view
    ? "not_linked"
    : view.importStatus === "queued" || view.importStatus === "working"
      ? "importing"
      : view.importStatus === "done"
        ? "imported"
        : view.importStatus === "failed"
          ? "failed"
          : "not_imported";
  return {
    projectId,
    fileName: view?.fileName ?? null,
    // An uploaded design has no Figma file to open.
    figmaUrl: view && designSourceOf(view) === "figma" ? view.url : null,
    // Labelled by where it came from (Jason, 28 and 29 September 2026: the sample client's PDF said "From Figma").
    source: view ? designSourceOf(view) : "figma",
    status,
    importedLine: view?.importedAt
      ? `${whenInSentence(view.importedAt)}${view.importedBy ? ` by ${view.importedBy}` : ""}.`
      : null,
    failure: view?.importFailure ?? null,
    warnings: view ? (view.readiness?.warnings ?? 0) + view.importWarnings.length : 0,
    outOfDate: view?.importOutOfDate ?? false,
    frames: (view?.frames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      isHome: f.isHome,
      imageUrl: f.imageUrl,
      width: f.width,
      height: f.height,
    })),
  };
}

/* "today, 3:18 AM" inside a sentence, not "Today". */
function whenInSentence(value: Date): string {
  return formatActivityWhen(value).replace(/^(Today|Yesterday)\b/, (word) => word.toLowerCase());
}

/* ---------- pre-filling the intake from the design ---------- */

export type PrefillResult = DesignPrefillResult;

/*
  The "Pre-fill the intake" button: reads the design's text (from the file
  saved at import: no Figma read, no AI) and fills only the intake fields
  that are empty. Each one is marked "from the design" until the PM confirms
  or corrects it. The same work runs by itself at the end of every design
  read (core figma/design-prefill.ts, E0(c)).
*/
export async function prefillIntakeFromDesign(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
): Promise<PrefillResult> {
  assertCan(actor, "intake.edit");
  await requireLane2(ctx.db, projectId);
  const [person] = await ctx.db
    .select({ name: userTable.name, deletedAt: userTable.deletedAt })
    .from(userTable)
    .where(eq(userTable.id, actor.id))
    .limit(1);
  try {
    return await runDesignPrefill(ctx.db, projectId, {
      actor,
      by: person ? personLabel(person.name, person.deletedAt) : null,
      automatic: false,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  } catch (error) {
    if (error instanceof DesignPrefillError) throw new FigmaDesignError(error.message);
    throw error;
  }
}

export async function confirmPrefill(ctx: ServiceContext, actor: Viewer, projectId: string, fieldKey: string): Promise<void> {
  assertCan(actor, "intake.edit");
  const [row] = await ctx.db
    .select()
    .from(intakePrefill)
    .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, fieldKey)))
    .limit(1);
  if (!row) throw new FigmaDesignError("That field wasn't filled in by TAWD.");
  if (row.status !== "pending") return;
  await ctx.db
    .update(intakePrefill)
    .set({ status: "confirmed", resolvedByUserId: actor.id, resolvedAt: new Date() })
    .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.fieldKey, fieldKey)));
  await recordActivity(ctx.db, {
    action: "intake.prefill_confirmed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { field: PREFILL_LABELS[fieldKey as PrefillKey] ?? fieldKey, value: prefillText(row.value) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The fields still marked "From the design" or "From the current site" (0.96.0), with what each was read from. */
export async function pendingPrefills(db: Db, projectId: string): Promise<Record<string, { source: string; origin: "design" | "site" }>> {
  const rows = await db
    .select({ fieldKey: intakePrefill.fieldKey, source: intakePrefill.source, origin: intakePrefill.origin })
    .from(intakePrefill)
    .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.status, "pending")));
  return Object.fromEntries(rows.map((r) => [r.fieldKey, { source: r.source, origin: r.origin === "site" ? "site" : "design" }]));
}

/*
  Where a design really came from, by the evidence and not only the saved
  field (Jason, 29 September 2026: the sample client's PDF was still labelled "Figma";
  its row kept the column's "figma" default). A Figma address is Figma; a
  PDF file name or an upload is an upload.
*/
export function designSourceOf(row: { source?: string | null; url?: string | null; fileName?: string | null; fileKey?: string | null }): "figma" | "pdf" | "upload" {
  const pdf = /\.pdf$/i.test(row.fileName ?? "");
  const figmaLink = /figma\.com\//i.test(row.url ?? "");
  if (row.source === "upload" || row.url === "upload" || row.fileKey === "upload" || (pdf && !figmaLink)) return pdf ? "pdf" : "upload";
  return "figma";
}

/** The words for it: "Figma", "an uploaded PDF" or "uploaded images". */
export function designSourceWords(row: Parameters<typeof designSourceOf>[0]): string {
  const source = designSourceOf(row);
  return source === "figma" ? "Figma" : source === "pdf" ? "an uploaded PDF" : "uploaded images";
}
