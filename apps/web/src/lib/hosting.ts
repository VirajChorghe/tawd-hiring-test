import { and, desc, eq } from "drizzle-orm";

import { activityLog, addonPrice, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { addProjectAddon, formatMoney, projectAddons, removeProjectAddon } from "@/lib/pricing";
import type { ServiceContext } from "@/lib/users";

/*
  Where the client's site lives (Build B, 4b, Jason, 27 September 2026):
  a static site on Netlify (Build A, the default) or WordPress on 20i (Bluehost until 5 October 2026)
  (Build B). PMs and admins change it, logged; it is locked once the site
  is live. Any tier can have WordPress; a project that isn't Pro gets the
  monthly "WordPress hosting" add-on with it (at the Pricing page's price,
  or unpriced until an admin sets one), and loses it on the way back.
*/

export type Hosting = "netlify" | "wordpress";

export const HOSTING_LABEL: Record<Hosting, string> = {
  netlify: "Static site on Netlify (Build A)",
  wordpress: "WordPress on 20i (Build B)",
};

export const WORDPRESS_ADDON = "wordpress_hosting";

type Db = ServiceContext["db"];

export class HostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostingError";
  }
}

export interface HostingView {
  hosting: Hosting;
  locked: boolean;
  isPro: boolean;
  /** The add-on's list price, "$20.00", or null while it has none. */
  addonPrice: string | null;
  /** The add-on as it is on this project, or null when it isn't. */
  addonOnProject: { priceCents: number | null } | null;
  /** The last change: when and by whom. */
  changed: { at: Date; userId: string | null } | null;
  /** WordPress sites (1 October 2026): Contact Form 7 (the default) or Gravity Forms (VML's licence). */
  formPlugin: FormPlugin;
}

export type FormPlugin = "cf7" | "gravityforms";

export async function loadHosting(db: Db, projectId: string): Promise<HostingView | null> {
  const [row] = await db.select({ hosting: project.hosting, tier: project.tier, status: project.status, liveAt: project.liveAt, formPlugin: project.formPlugin }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) return null;
  const [addon] = await db.select().from(addonPrice).where(eq(addonPrice.key, WORDPRESS_ADDON)).limit(1);
  const onProject = (await projectAddons(db, projectId)).find((a) => a.addonKey === WORDPRESS_ADDON);
  const [changed] = await db
    .select({ at: activityLog.occurredAt, userId: activityLog.actorUserId })
    .from(activityLog)
    .where(and(eq(activityLog.action, "project.hosting_changed"), eq(activityLog.entityType, "project"), eq(activityLog.entityId, projectId)))
    .orderBy(desc(activityLog.seq))
    .limit(1);
  return {
    hosting: row.hosting === "wordpress" ? "wordpress" : "netlify",
    locked: row.status === "live" || Boolean(row.liveAt),
    isPro: row.tier === "pro",
    addonPrice: addon?.priceCents != null ? formatMoney(addon.priceCents) : null,
    addonOnProject: onProject ? { priceCents: onProject.priceCents } : null,
    changed: changed ?? null,
    formPlugin: row.formPlugin === "gravityforms" ? "gravityforms" : "cf7",
  };
}

/* The WordPress site's form plugin: PMs and admins, logged, locked once live. It takes effect at the next deploy of the preview. */
export async function setFormPlugin(ctx: ServiceContext, actor: Viewer, projectId: string, formPlugin: FormPlugin): Promise<void> {
  assertCan(actor, "project.edit");
  if (formPlugin !== "cf7" && formPlugin !== "gravityforms") throw new HostingError("Choose Contact Form 7 or Gravity Forms.");
  const view = await loadHosting(ctx.db, projectId);
  if (!view) throw new HostingError("That project no longer exists.");
  if (view.locked) throw new HostingError("The site is live, so its form plugin can't change here any more.");
  if (view.formPlugin === formPlugin) return;
  await ctx.db.update(project).set({ formPlugin, updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.form_plugin_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { formPlugin: view.formPlugin },
    valueAfter: { formPlugin },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function setHosting(ctx: ServiceContext, actor: Viewer, projectId: string, hosting: Hosting): Promise<void> {
  assertCan(actor, "project.edit");
  if (hosting !== "netlify" && hosting !== "wordpress") throw new HostingError("Choose Netlify or WordPress.");
  const view = await loadHosting(ctx.db, projectId);
  if (!view) throw new HostingError("That project no longer exists.");
  if (view.locked) throw new HostingError("The site is live, so its hosting can't change here any more.");
  if (view.hosting === hosting) return;

  await ctx.db.update(project).set({ hosting, updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.hosting_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { hosting: view.hosting },
    valueAfter: { hosting },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  // The monthly add-on follows WordPress on any tier but Pro (each change logged by pricing).
  if (hosting === "wordpress" && !view.isPro) await addProjectAddon(ctx, actor, projectId, WORDPRESS_ADDON);
  if (hosting === "netlify") await removeProjectAddon(ctx, actor, projectId, WORDPRESS_ADDON);
}
