import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { SITE_TIDY_JOB, siteTidyJobId } from "@tawd/core/queue";
import { designCopy, designPage, figmaDesign } from "@tawd/core/schema";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  Words and links, for the screens (Jason, 29 September 2026): the $0 tidy
  of every page's copy, what it changed, and the links whose words don't say
  where they go, grouped by their words with the team's choice for each
  (leave, remove, or a page).
*/

type Db = ServiceContext["db"];

export class SiteTidyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteTidyError";
  }
}

function canTidy(actor: Viewer): boolean {
  return can(actor, "project.edit") || can(actor, "design.decide");
}

export async function startSiteTidy(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!canTidy(actor)) assertCan(actor, "project.edit");
  const [copy] = await ctx.db.select({ id: designCopy.id }).from(designCopy).where(and(eq(designCopy.projectId, projectId), inArray(designCopy.status, ["done", "needs_cleanup"]))).limit(1);
  if (!copy) throw new SiteTidyError("Copy the pages first; the words and links are fixed on the copies.");
  try {
    await getQueue().add(SITE_TIDY_JOB, { projectId }, { jobId: siteTidyJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    throw new SiteTidyError("The fix couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, { action: "design.site_tidy_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { cost: "$0 (no AI)" }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* The team's choice for links with the same words: a page's address, "remove", or "" to leave them. Then the tidy runs again. */
export async function saveLinkRules(ctx: ServiceContext, actor: Viewer, projectId: string, choices: { words: string; to: string }[]): Promise<void> {
  if (!canTidy(actor)) assertCan(actor, "project.edit");
  const [figma] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma) throw new SiteTidyError("The design is missing.");
  const pages = await ctx.db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, figma.importedVersion ?? "")));
  const allowed = new Set(["remove", "/", ...pages.map((p) => `/${p.slug}/`)]);
  const rules = { ...((figma.linkRules as Record<string, string> | null) ?? {}) };
  for (const c of choices) {
    const key = c.words.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) continue;
    if (!c.to) delete rules[key];
    else if (allowed.has(c.to)) rules[key] = c.to;
    else throw new SiteTidyError(`"${c.to}" isn't one of the site's pages.`);
  }
  await ctx.db.update(figmaDesign).set({ linkRules: rules }).where(eq(figmaDesign.projectId, projectId));
  await recordActivity(ctx.db, { action: "design.link_rules_saved", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { rules }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  await startSiteTidy(ctx, actor, projectId);
}

export interface TidyView {
  ran: boolean;
  pages: { name: string; changes: string[] }[];
  /** Links still without a place, by their words, with how many and a page they could go to. */
  unresolved: { words: string; count: number; pages: string[]; suggestion: string | null; chosen: string }[];
  options: { label: string; value: string }[];
}

export async function loadTidy(db: Db, projectId: string): Promise<TidyView | null> {
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma?.importedVersion) return null;
  const pages = await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, figma.importedVersion))).orderBy(asc(designPage.position));
  if (pages.length === 0) return null;
  const copies = await db.select().from(designCopy).where(and(eq(designCopy.projectId, projectId), inArray(designCopy.status, ["done", "needs_cleanup"]))).orderBy(desc(designCopy.createdAt));
  const rules = (figma.linkRules as Record<string, string> | null) ?? {};
  const view: TidyView = { ran: false, pages: [], unresolved: [], options: [{ label: "Leave it", value: "" }, { label: "Remove the link", value: "remove" }, ...pages.map((p) => ({ label: `${p.name} (${p.isHome ? "/" : `/${p.slug}/`})`, value: p.isHome ? "/" : `/${p.slug}/` }))] };
  const groups = new Map<string, TidyView["unresolved"][number]>();
  for (const page of pages) {
    const copy = copies.find((c) => c.frameId === page.frameId);
    const tidy = copy?.tidy as { changes?: string[]; unresolved?: { text: string; suggestion: string | null }[] } | null;
    if (!tidy) continue;
    view.ran = true;
    view.pages.push({ name: page.name, changes: [...new Set(tidy.changes ?? [])] });
    for (const u of tidy.unresolved ?? []) {
      const key = u.text.replace(/[→←]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const g = groups.get(key) ?? { words: u.text.replace(/\s+/g, " ").trim(), count: 0, pages: [], suggestion: u.suggestion, chosen: rules[key] ?? "" };
      g.count += 1;
      if (!g.pages.includes(page.name)) g.pages.push(page.name);
      groups.set(key, g);
    }
  }
  view.unresolved = [...groups.values()].sort((a, b) => b.count - a.count);
  return view;
}
