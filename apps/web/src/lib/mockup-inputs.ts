import { modelLabel } from "@tawd/core/mockups";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, intakeFile, likedSiteShot, photoTextCheck } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { PHOTO_TEXT_JOB, REFERENCE_STUDY_JOB, photoTextJobId, referenceStudyJobId } from "@tawd/core/queue";
import { PHOTO_TEXT_GUESS_PER_PHOTO, REFERENCE_STUDY_GUESS, costOf, formatCost, type PhotoTextFinding, type ReferenceBrief, type ReferenceOutline } from "@tawd/core/mockups";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Mockup inputs, the paid parts (27 September 2026). Each is one small AI
  call with the estimate shown first, and each is only a help: without it
  the mockups still use the screenshots, the outline and the photos.

  - The reference study: one call per reference site, turning its
    screenshot and outline into a brief of its structure and craft.
  - The photo text check: one call reads the visible text in the client's
    photos; code compares it with the intake.
*/

type Db = Database;

async function perUnitCost(db: Db, step: "reference_study" | "photo_text", units: (runIds: string[]) => Promise<number>, guess: { inputTokens: number; outputTokens: number }) {
  const config = await stepModelConfig(db, step);
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, step));
  if (calls.length === 0) return { per: costOf(guess, config), measured: false, model: config.model };
  const count = await units([...new Set(calls.map((c) => c.runId))]);
  return { per: count > 0 ? calls.reduce((n, c) => n + costOf(c, config), 0) / count : costOf(guess, config), measured: count > 0, model: config.model };
}

/* ---------- the reference study ---------- */

export async function estimateReferenceStudy(db: Db, sites: number): Promise<{ cost: number; label: string }> {
  // One call per site: each run id is a site.
  const { per, measured, model } = await perUnitCost(db, "reference_study", async (ids) => ids.length, REFERENCE_STUDY_GUESS);
  const cost = per * sites;
  return {
    cost,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(model)} for ${sites} site${sites === 1 ? "" : "s"}${measured ? ", from the studies so far" : " (a first guess until a real study has run)"}.`,
  };
}

export async function startReferenceStudy(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "intake.edit");
  const rows = await ctx.db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));
  if (rows.some((r) => r.briefStatus === "queued" || r.briefStatus === "working")) throw new MockupError("The reference sites are already being studied.");
  const ready = rows.filter((r) => r.status === "done");
  if (ready.length === 0) throw new MockupError("No reference site has its screenshot yet. Save the Website section and wait for the screenshots first.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateReferenceStudy(ctx.db, ready.filter((r) => r.briefStatus !== "done").length || ready.length)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  const estimate = await estimateReferenceStudy(ctx.db, ready.length);
  await ctx.db.update(likedSiteShot).set({ briefStatus: "queued", briefFailure: null }).where(inArray(likedSiteShot.id, ready.map((r) => r.id)));
  try {
    await getQueue().add(REFERENCE_STUDY_JOB, { projectId, startedByUserId: actor.id }, { jobId: referenceStudyJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(likedSiteShot).set({ briefStatus: null }).where(inArray(likedSiteShot.id, ready.map((r) => r.id)));
    throw new MockupError("The study couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "mockups.reference_study_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { sites: ready.length, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return ready.length;
}

export interface ReferenceStudyView {
  sites: { url: string; status: string; briefStatus: string | null; brief: ReferenceBrief | null; outline: ReferenceOutline | null; failure: string | null; pageImageUrl: string | null }[];
  ready: number;
  working: boolean;
  estimateLine: string;
}

export async function loadReferenceStudy(db: Db, projectId: string): Promise<ReferenceStudyView> {
  const rows = await db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));
  const ready = rows.filter((r) => r.status === "done").length;
  return {
    sites: await Promise.all(
      rows.map(async (r) => ({
        url: r.url,
        status: r.status,
        briefStatus: r.briefStatus,
        brief: (r.brief as ReferenceBrief | null) ?? null,
        outline: (r.outline as ReferenceOutline | null) ?? null,
        failure: r.briefFailure,
        pageImageUrl: r.pageImageKey ? await getStorage().signDownload(r.pageImageKey, "reference-page.jpg") : null,
      })),
    ),
    ready,
    working: rows.some((r) => r.briefStatus === "queued" || r.briefStatus === "working"),
    estimateLine: (await estimateReferenceStudy(db, Math.max(1, ready))).label,
  };
}

/* ---------- the photo text check ---------- */

export async function estimatePhotoText(db: Db, photos: number): Promise<{ cost: number; label: string }> {
  const { per, measured, model } = await perUnitCost(
    db,
    "photo_text",
    async (ids) => {
      const checks = ids.length ? await db.select({ readings: photoTextCheck.readings }).from(photoTextCheck).where(inArray(photoTextCheck.id, ids)) : [];
      return checks.reduce((n, c) => n + ((c.readings as unknown[] | null)?.length ?? 0), 0);
    },
    PHOTO_TEXT_GUESS_PER_PHOTO,
  );
  const count = Math.min(12, photos);
  const cost = per * count;
  return {
    cost,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(model)} for ${count} photo${count === 1 ? "" : "s"}${measured ? ", from the checks so far" : " (a first guess until a real check has run)"}.`,
  };
}

export async function startPhotoTextCheck(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "intake.edit");
  const photos = await ctx.db
    .select({ id: intakeFile.id })
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "photo"), eq(intakeFile.status, "ready")));
  if (photos.length === 0) throw new MockupError("There are no photos to read yet.");
  const [latest] = await ctx.db.select().from(photoTextCheck).where(eq(photoTextCheck.projectId, projectId)).orderBy(desc(photoTextCheck.createdAt)).limit(1);
  if (latest && (latest.status === "queued" || latest.status === "working")) throw new MockupError("The photos are already being read.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimatePhotoText(ctx.db, photos.length)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  const estimate = await estimatePhotoText(ctx.db, photos.length);
  const [check] = await ctx.db.insert(photoTextCheck).values({ projectId, startedByUserId: actor.id }).returning({ id: photoTextCheck.id });
  try {
    await getQueue().add(PHOTO_TEXT_JOB, { checkId: check!.id, projectId }, { jobId: photoTextJobId(check!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(photoTextCheck).where(eq(photoTextCheck.id, check!.id));
    throw new MockupError("The check couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "mockups.photo_text_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { photos: Math.min(12, photos.length), estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface PhotoTextView {
  status: "none" | "queued" | "working" | "done" | "failed";
  findings: PhotoTextFinding[];
  photosRead: number;
  failureReason: string | null;
  finishedAt: Date | null;
  estimateLine: string;
}

export async function loadPhotoTextCheck(db: Db, projectId: string, photoCount: number): Promise<PhotoTextView> {
  const [row] = await db.select().from(photoTextCheck).where(eq(photoTextCheck.projectId, projectId)).orderBy(desc(photoTextCheck.createdAt)).limit(1);
  return {
    status: (row?.status as PhotoTextView["status"]) ?? "none",
    findings: (row?.findings as PhotoTextFinding[] | null) ?? [],
    photosRead: (row?.readings as unknown[] | null)?.length ?? 0,
    failureReason: row?.failureReason ?? null,
    finishedAt: row?.finishedAt ?? null,
    estimateLine: (await estimatePhotoText(db, Math.max(1, photoCount))).label,
  };
}
