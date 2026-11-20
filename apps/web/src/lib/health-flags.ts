import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { healthFlagConfirmation, siteBuild } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { ChecklistItem } from "@tawd/core/site";
import type { ServiceContext } from "@/lib/users";

/*
  Health and beauty rules before go-live (Jason, 26 September 2026): every
  flag on the newest build is either fixed (it's gone from a later build)
  or ticked "Confirmed with the client" by a PM, and the tick is logged.
  Go-live waits until each one is resolved.
*/

type Db = Database;

export class HealthFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthFlagError";
  }
}

type Flag = NonNullable<ChecklistItem["flags"]>[number];

async function newestDoneBuild(db: Db, projectId: string) {
  const [build] = await db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  return build ?? null;
}

const healthItemOf = (checks: unknown) => ((checks as ChecklistItem[] | null) ?? []).find((c) => c.key === "health") ?? null;

export async function confirmHealthFlag(ctx: ServiceContext, actor: Viewer, projectId: string, flagId: string, note: string): Promise<void> {
  assertCan(actor, "project.edit");
  const build = await newestDoneBuild(ctx.db, projectId);
  const flag = healthItemOf(build?.checks)?.flags?.find((f) => f.id === flagId);
  if (!build || !flag) throw new HealthFlagError("That flag isn't on the newest build any more: it may already be fixed.");
  const clean = note.trim().slice(0, 1000);
  const [existing] = await ctx.db
    .select({ id: healthFlagConfirmation.id })
    .from(healthFlagConfirmation)
    .where(and(eq(healthFlagConfirmation.projectId, projectId), eq(healthFlagConfirmation.flagId, flagId)))
    .limit(1);
  if (existing) throw new HealthFlagError("That flag is already confirmed with the client.");
  await ctx.db.insert(healthFlagConfirmation).values({ projectId, flagId, rule: flag.rule, found: flag.found, note: clean, buildVersion: build.version, confirmedByUserId: actor.id });
  await recordActivity(ctx.db, {
    action: "health.flag_confirmed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { rule: flag.rule, found: flag.found, version: build.version, note: clean },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface HealthFlagView extends Flag {
  confirmed: { by: string; at: Date; note: string } | null;
}

/* The newest build's flags, each with its confirmation if any. */
export async function loadHealthFlags(db: Db, projectId: string, names: Map<string, string>): Promise<{ version: number; flags: HealthFlagView[] } | null> {
  const build = await newestDoneBuild(db, projectId);
  const item = healthItemOf(build?.checks);
  if (!build || !item) return null;
  const confirmations = await db.select().from(healthFlagConfirmation).where(eq(healthFlagConfirmation.projectId, projectId));
  return {
    version: build.version,
    flags: (item.flags ?? []).map((flag) => {
      const c = confirmations.find((x) => x.flagId === flag.id);
      return { ...flag, confirmed: c ? { by: names.get(c.confirmedByUserId) ?? "A PM", at: c.createdAt, note: c.note } : null };
    }),
  };
}

/* The checklist line: done when every flag is fixed or confirmed with the client. */
export function healthChecklistItem(item: ChecklistItem, flags: HealthFlagView[]): ChecklistItem {
  const open = flags.filter((f) => !f.confirmed);
  const confirmed = flags.length - open.length;
  return {
    ...item,
    blocksGoLive: true,
    ok: open.length === 0,
    detail:
      flags.length === 0
        ? item.detail
        : open.length
          ? `${open.length} to fix or confirm with the client${confirmed ? ` (${confirmed} confirmed)` : ""}: see Health and beauty rules below`
          : `All ${confirmed} confirmed with the client`,
  };
}
