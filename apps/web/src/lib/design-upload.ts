import { and, asc, eq } from "drizzle-orm";
import { getDocumentProxy } from "unpdf";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";

import type { Database } from "@tawd/core/db";
import { aiCall, figmaDesign, intakeFile, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { DESIGN_UPLOAD_JOB, designUploadJobId } from "@tawd/core/queue";
import { DESIGN_READ_GUESS_PER_SLICE, designFilesKey, keptPages, visionSliceCount, visionSlices } from "@tawd/core/figma";
import { costOf, formatCost } from "@tawd/core/mockups";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Lane 2 without Figma (28 September 2026): the design uploaded as a PDF or
  as images, one per page. Before anything is read, TAWD counts the pages
  and which of them have a text layer (free); only pages without one (and
  every image) need a vision call, and the estimate says so. The worker then
  reads the pages into the same shape as a Figma import, so the review, the
  faithful copy and the rest follow as they do for Figma.
*/

type Db = Database;

export interface DesignUploadPlan {
  files: { id: string; name: string; kind: "pdf" | "image"; pages: number; textPages: number; slices: number }[];
  pages: number;
  visionPages: number;
  /** Vision calls: a long page is read in slices, one call each (27 September 2026). */
  slices: number;
  /** Pages read from the picture by an earlier read of these same files, kept (27 September 2026). */
  keptPages: number[];
  /** The default read: only the pages still missing. */
  estimate: { cost: number; label: string };
  /** Reading every page again. */
  estimateAll: { cost: number; label: string };
  /** Every page read from the picture, for the checkboxes (27 September 2026). */
  pageList: { number: number; slices: number; kept: boolean }[];
  /** One slice's cost on the step's model, for the dialog's live estimate. */
  perSlice: { cost: number; model: string; measured: boolean };
}

/* One slice's call on the step's model: the average of the slices read so far, else the guess. */
export async function perSliceCost(db: Db): Promise<{ cost: number; model: string; measured: boolean }> {
  const config = await stepModelConfig(db, "design_read");
  const calls = await db.select().from(aiCall).where(and(eq(aiCall.step, "design_read"), eq(aiCall.scope, "slice")));
  const cost = calls.length ? calls.reduce((n, c) => n + costOf(c, config), 0) / calls.length : costOf(DESIGN_READ_GUESS_PER_SLICE, config);
  return { cost, model: modelLabel(config.model), measured: calls.length > 0 };
}

/*
  One call per slice of each page read from the picture. Averaged over
  the slices read so far (the first, whole-page calls of 28 September are
  left out: they were a different size of call).
*/
export async function estimateDesignRead(db: Db, visionPages: number, slices = visionPages): Promise<{ cost: number; label: string }> {
  if (visionPages === 0) return { cost: 0, label: "Free: every page has a text layer." };
  const per = await perSliceCost(db);
  return { cost: per.cost * slices, label: readLabel(per, visionPages, slices) };
}

/* "About $0.05 of AI on Sonnet 5 for 1 page read from the picture in about 2 slices ...". The dialog builds the same line as boxes are ticked. */
export function readLabel(per: { cost: number; model: string; measured: boolean }, pages: number, slices: number): string {
  const parts = slices > pages ? ` in about ${slices} slices (a long page is read in parts)` : "";
  return `About ${formatCost(per.cost * slices)} of AI on ${per.model} for ${pages} page${pages === 1 ? "" : "s"} read from the picture${parts}${per.measured ? ", from the slices read so far" : " (a first guess until real pages have been read)"}.`;
}

/* An image's slices are only known once it is drawn: a typical long page is guessed. */
const IMAGE_SLICES_GUESS = 3;

/*
  The worker (design-upload.ts, readPdf) reads a PDF page that is one
  full-page picture at the picture's own pixel size when it can, not 1440
  wide (E1, 13 November 2026). Whether it does depends on the trim, which is
  only known once the picture is drawn, so the estimate can't know it. It
  can know how tall the file's pictures are, WITHOUT decoding any of them
  (this runs on every intake page render in a 1 GB container, and pdf.js's
  operator list decodes each image): the picture dictionaries are plain text
  in the PDF, so their /Height is read from the bytes. The tallest one is
  used for every page with no text: that can only over-estimate (a page
  with no picture, or a smaller one, is counted as the tallest), never
  under. The worker draws the picture at round(page height x scale), which
  the cover and shape tolerances can put up to about 4% above its pixel
  height, so 5% is added (Fable's re-read). Capped at the worker's 16000.
*/
export function ownPictureHeight(pdf: Uint8Array | Buffer): number | null {
  const text = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString("latin1");
  let tallest = 0;
  for (const image of text.matchAll(/\/Subtype\s*\/Image\b/g)) {
    // The dictionary is around the /Subtype: its /Height is within it, though an inline colour palette can push it a couple of thousand bytes away.
    const near = text.slice(Math.max(0, image.index - 4000), image.index + 4000);
    // A direct number only: "/Height 12 0 R" points at another object, it isn't 12 pixels.
    for (const h of near.matchAll(/\/Height\s+(\d{1,6})\b(?!\s+\d+\s+R\b)/g)) tallest = Math.max(tallest, Number(h[1]));
  }
  return tallest > 0 ? Math.min(16000, Math.ceil(tallest * 1.05)) : null;
}

export async function planDesignUpload(db: Db, projectId: string): Promise<DesignUploadPlan> {
  const rows = await db
    .select()
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "design_file"), eq(intakeFile.status, "ready")))
    .orderBy(asc(intakeFile.createdAt));
  const files: DesignUploadPlan["files"] = [];
  // Every page read from the picture, numbered as the worker numbers them (upload order, a PDF's pages in order).
  const visionList: { number: number; slices: number }[] = [];
  let pageNumber = 0;
  for (const row of rows) {
    if (row.contentType !== "application/pdf") {
      pageNumber += 1;
      visionList.push({ number: pageNumber, slices: IMAGE_SLICES_GUESS });
      files.push({ id: row.id, name: row.fileName, kind: "image", pages: 1, textPages: 0, slices: IMAGE_SLICES_GUESS });
      continue;
    }
    const body = await getStorage().get(row.storageKey);
    let pages = 0;
    let textPages = 0;
    let slices = 0;
    const first = pageNumber;
    const fileVision: { number: number; slices: number }[] = [];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(body ?? Buffer.alloc(0)));
      pages = Math.min(pdf.numPages, 30);
      const own = ownPictureHeight(body ?? Buffer.alloc(0));
      for (let n = 1; n <= pages; n += 1) {
        const pdfPage = await pdf.getPage(n);
        const content = await pdfPage.getTextContent();
        if (content.items.some((i) => "str" in i && i.str.trim())) textPages += 1;
        else {
          const { width, height } = pdfPage.getViewport({ scale: 1 });
          let count = visionSliceCount(width, height);
          // A picture-only page may be read at its own size: never estimate under that.
          if (own !== null) count = Math.max(count, visionSlices(own).length);
          slices += count;
          fileVision.push({ number: first + n, slices: count });
        }
      }
    } catch {
      pages = 0;
      slices = 0;
      fileVision.length = 0;
    }
    pageNumber = first + pages;
    visionList.push(...fileVision);
    files.push({ id: row.id, name: row.fileName, kind: "pdf", pages, textPages, slices });
  }
  const pages = files.reduce((n, f) => n + f.pages, 0);
  const visionPages = files.reduce((n, f) => n + (f.pages - f.textPages), 0);
  const slices = files.reduce((n, f) => n + f.slices, 0);

  const [design] = await db.select({ source: figmaDesign.source, pagesRead: figmaDesign.pagesRead }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const kept = design?.source === "upload" ? keptPages(design.pagesRead, designFilesKey(rows)).filter((n) => visionList.some((v) => v.number === n)) : [];
  const missing = visionList.filter((v) => !kept.includes(v.number));
  const missingSlices = missing.reduce((n, v) => n + v.slices, 0);
  const estimateAll = await estimateDesignRead(db, visionPages, slices);
  const estimate =
    kept.length === 0
      ? estimateAll
      : missing.length === 0
        ? { cost: 0, label: `Free: every page was read before and is kept (${kept.length} page${kept.length === 1 ? "" : "s"}); only the design is put together again.` }
        : await estimateDesignRead(db, missing.length, missingSlices);
  return {
    files,
    pages,
    visionPages,
    slices,
    keptPages: kept,
    estimate,
    estimateAll,
    pageList: visionList.map((v) => ({ ...v, kept: kept.includes(v.number) })),
    perSlice: await perSliceCost(db),
  };
}

export async function startDesignUpload(ctx: ServiceContext, actor: Viewer, projectId: string, options: { all?: boolean; pages?: number[] } = {}): Promise<void> {
  assertCan(actor, "intake.design");
  const [row] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new MockupError("That project no longer exists.");
  if (row.lane !== "lane_2") throw new MockupError("An uploaded design is for Lane 2 (the client supplied a design).");
  const [existing] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (existing?.importStatus === "queued" || existing?.importStatus === "working") throw new MockupError("The design is already being read.");
  const plan = await planDesignUpload(ctx.db, projectId);
  if (plan.pages === 0) throw new MockupError("Upload the design first: a PDF, or one image per page.");
  const all = Boolean(options.all);
  // The pages the PM ticked (27 September 2026); only pages read from the picture can be chosen.
  const chosen = options.pages ? [...new Set(options.pages)].filter((n) => plan.pageList.some((p) => p.number === n)).sort((a, b) => a - b) : null;
  if (options.pages && chosen!.length === 0 && plan.pages - plan.visionPages === 0) throw new MockupError("Choose at least one page to read.");
  const toRead = chosen ? chosen.length : all ? plan.visionPages : plan.visionPages - plan.keptPages.length;
  if (toRead > 0) {
    try {
      await assertWithinMonthlyLimit(ctx.db, {
        projectId,
        estimate: chosen ? plan.perSlice.cost * plan.pageList.filter((p) => chosen.includes(p.number)).reduce((n, p) => n + p.slices, 0) : (all ? plan.estimateAll : plan.estimate).cost,
      });
    } catch (error) {
      if (error instanceof SpendError) throw new MockupError(error.message);
      throw error;
    }
  }
  const version = `upload-${Date.now()}`;
  const fileName = plan.files.length === 1 ? plan.files[0]!.name : `${plan.files.length} design files`;
  const values = {
    url: "upload",
    fileKey: version,
    source: "upload",
    linkedByUserId: actor.id,
    fileName,
    importStatus: "queued",
    importFailure: null,
    importQueuedAt: new Date(),
    importedByUserId: actor.id,
  };
  if (existing) await ctx.db.update(figmaDesign).set(values).where(eq(figmaDesign.projectId, projectId));
  else await ctx.db.insert(figmaDesign).values({ projectId, ...values });
  try {
    await getQueue().add(DESIGN_UPLOAD_JOB, { projectId, startedByUserId: actor.id, version, all, ...(chosen ? { pages: chosen } : {}) }, { jobId: designUploadJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(figmaDesign).set({ importStatus: "failed", importFailure: "The job queue isn't answering. Try again in a minute." }).where(eq(figmaDesign.projectId, projectId));
    throw new MockupError("The design couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "figma.upload_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: {
      files: plan.files.map((f) => f.name),
      pages: plan.pages,
      byVision: plan.visionPages,
      read: chosen ? `pages ${chosen.join(", ") || "none (text layers only)"}` : all ? "every page" : "only the pages still missing",
      kept: all ? 0 : plan.keptPages.filter((n) => !chosen?.includes(n)).length,
      estimate: chosen ? readLabel(plan.perSlice, chosen.length, plan.pageList.filter((p) => chosen.includes(p.number)).reduce((n, p) => n + p.slices, 0)) : (all ? plan.estimateAll : plan.estimate).label,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
