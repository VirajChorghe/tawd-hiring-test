import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { projectTracking } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { checkTrackingIds, consentModes, trackingKeys, type ConsentMode, type TrackingConfig } from "@tawd/core/site";
import type { ServiceContext } from "@/lib/users";

/*
  A project's tracking codes (Todd's request, 26 September 2026): the PM
  enters IDs only, each checked against its exact format; the builder writes
  the code into every page, behind the visitor's consent. Every change is
  logged.
*/

type Db = Database;

export class TrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingError";
  }
}

export const EMPTY_TRACKING: TrackingConfig = { ga4: "", gtm: "", metaPixel: "", googleAds: "", callRail: "", consentMode: "opt_in" };

export async function loadTracking(db: Db, projectId: string): Promise<TrackingConfig & { updatedAt: Date | null }> {
  const [row] = await db.select().from(projectTracking).where(eq(projectTracking.projectId, projectId)).limit(1);
  if (!row) return { ...EMPTY_TRACKING, updatedAt: null };
  return { ga4: row.ga4, gtm: row.gtm, metaPixel: row.metaPixel, googleAds: row.googleAds, callRail: row.callRail, consentMode: row.consentMode as ConsentMode, updatedAt: row.updatedAt };
}

export async function saveTracking(ctx: ServiceContext, actor: Viewer, projectId: string, input: TrackingConfig): Promise<void> {
  assertCan(actor, "project.edit");
  const clean: TrackingConfig = {
    ga4: input.ga4.trim().toUpperCase(),
    gtm: input.gtm.trim().toUpperCase(),
    metaPixel: input.metaPixel.trim(),
    googleAds: input.googleAds.trim().replace(/^aw-/i, "AW-"),
    // "?? ''": a form rendered before this deploy may still save without the field.
    callRail: (input.callRail ?? "").trim().toLowerCase(),
    consentMode: (consentModes as readonly string[]).includes(input.consentMode) ? input.consentMode : "opt_in",
  };
  const problems = checkTrackingIds(clean);
  if (problems.length) throw new TrackingError(problems.map((p) => p.message).join(" "));
  const before = await loadTracking(ctx.db, projectId);
  await ctx.db
    .insert(projectTracking)
    .values({ projectId, ...clean, updatedByUserId: actor.id, updatedAt: new Date() })
    .onConflictDoUpdate({ target: projectTracking.projectId, set: { ...clean, updatedByUserId: actor.id, updatedAt: new Date() } });
  const pick = (c: TrackingConfig) => Object.fromEntries([...trackingKeys, "consentMode"].map((k) => [k, c[k as keyof TrackingConfig]]));
  await recordActivity(ctx.db, {
    action: "tracking.saved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: pick(before),
    valueAfter: pick(clean),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
