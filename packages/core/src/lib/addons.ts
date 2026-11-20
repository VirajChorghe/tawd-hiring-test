import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "../db";
import { addonPrice, project, projectAddon } from "../db/schema";
import { actorFields, recordActivity } from "./activity";
import { SYSTEM_ACTOR } from "./permissions";

/*
  The client-supplied design (Jason, 27 September 2026): an add-on priced
  per page, added by itself when a project's design is read from an
  uploaded PDF or images, or imported from Figma. The quantity is the
  design's page count and follows it when the design is read again; the
  price per page is the one on the Pricing page when it was added (or the
  first price set, if it had none). Logged by the system. Pro is exempt,
  as it is from WordPress hosting (Jason, 27 September 2026).
*/

export const CLIENT_DESIGN_ADDON = "client_design";

export async function syncDesignAddon(db: Database, projectId: string, pages: number): Promise<void> {
  if (!Number.isInteger(pages) || pages < 1) return;
  const [row] = await db.select({ tier: project.tier }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row || row.tier === "pro") return;
  const [price] = await db.select().from(addonPrice).where(eq(addonPrice.key, CLIENT_DESIGN_ADDON)).limit(1);
  if (!price) return;
  const [existing] = await db
    .select()
    .from(projectAddon)
    .where(and(eq(projectAddon.projectId, projectId), eq(projectAddon.addonKey, CLIENT_DESIGN_ADDON), isNull(projectAddon.removedAt)))
    .limit(1);
  if (existing) {
    if (existing.quantity === pages) return;
    await db.update(projectAddon).set({ quantity: pages }).where(eq(projectAddon.id, existing.id));
    await recordActivity(db, {
      action: "project.addon_quantity_changed",
      entityType: "project",
      entityId: projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueBefore: { addon: existing.name, quantity: existing.quantity },
      valueAfter: { addon: existing.name, quantity: pages, reason: "The design's page count changed." },
      ipAddress: null,
      userAgent: null,
    });
    return;
  }
  await db.insert(projectAddon).values({ projectId, addonKey: CLIENT_DESIGN_ADDON, name: price.name, priceCents: price.priceCents, monthly: false, quantity: pages, addedByUserId: null });
  await recordActivity(db, {
    action: "project.addon_added",
    entityType: "project",
    entityId: projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { addon: price.name, priceCents: price.priceCents, quantity: pages, reason: "The project's design was supplied by the client." },
    ipAddress: null,
    userAgent: null,
  });
}
