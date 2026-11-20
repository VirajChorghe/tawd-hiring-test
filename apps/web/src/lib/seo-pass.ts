import { and, asc, eq } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { SEO_SUGGEST_JOB, seoSuggestJobId } from "@tawd/core/queue";
import { designPage, figmaDesign } from "@tawd/core/schema";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  The minimal SEO pass, for the screens (Jason, 29 September 2026): code's
  suggestions for every page ($0) and the team's approval of each page's
  title, description, H1 and alt text (changed as they like). The build
  uses what was approved.
*/

export class SeoPassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoPassError";
  }
}

export interface SeoValues {
  title: string;
  description: string;
  h1: string;
  alts: { src: string; alt: string }[];
}

interface StoredSeo {
  suggested?: SeoValues & { h1Now: string; headingNotes: string[] };
  approved?: SeoValues & { by: string; at: string };
}

function canSeo(actor: Viewer): boolean {
  return can(actor, "project.edit") || can(actor, "seo.signoff") || can(actor, "design.decide");
}

export async function startSeoSuggest(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  if (!canSeo(actor)) assertCan(actor, "project.edit");
  try {
    await getQueue().add(SEO_SUGGEST_JOB, { projectId }, { jobId: seoSuggestJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    throw new SeoPassError("The suggestions couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, { action: "design.seo_suggest_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { cost: "$0 (no AI)" }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function approveSeo(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, values: SeoValues): Promise<void> {
  if (!canSeo(actor)) assertCan(actor, "project.edit");
  const [page] = await ctx.db.select().from(designPage).where(and(eq(designPage.id, pageId), eq(designPage.projectId, projectId))).limit(1);
  if (!page) throw new SeoPassError("That page is no longer there.");
  const title = values.title.trim();
  const description = values.description.trim();
  const h1 = values.h1.trim();
  if (title.length < 5 || title.length > 70) throw new SeoPassError("Keep the title between 5 and 70 characters (about 60 shows in Google).");
  if (description.length < 20 || description.length > 170) throw new SeoPassError("Keep the description between 20 and 170 characters (about 155 shows in Google).");
  if (!h1) throw new SeoPassError("Give the page its H1.");
  const alts = values.alts.map((a) => ({ src: a.src, alt: a.alt.trim().slice(0, 125) })).filter((a) => a.src);
  const seo = (page.seo as StoredSeo | null) ?? {};
  const approved = { title, description, h1, alts, by: actor.id, at: new Date().toISOString() };
  await ctx.db.update(designPage).set({ seo: { ...seo, approved } }).where(eq(designPage.id, page.id));
  await recordActivity(ctx.db, {
    action: "design.seo_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: seo.approved ? { title: seo.approved.title, description: seo.approved.description, h1: seo.approved.h1 } : null,
    valueAfter: { page: page.name, title, description, h1, alts: alts.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface SeoPassView {
  pages: {
    id: string;
    name: string;
    path: string;
    suggested: (SeoValues & { h1Now: string; headingNotes: string[] }) | null;
    approved: (SeoValues & { at: string }) | null;
  }[];
  suggestedAny: boolean;
}

export async function loadSeoPass(db: ServiceContext["db"], projectId: string): Promise<SeoPassView | null> {
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!figma?.importedVersion) return null;
  const pages = await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, figma.importedVersion))).orderBy(asc(designPage.position));
  if (pages.length === 0) return null;
  const view: SeoPassView = { pages: [], suggestedAny: false };
  for (const p of pages) {
    const seo = (p.seo as StoredSeo | null) ?? {};
    if (seo.suggested) view.suggestedAny = true;
    view.pages.push({ id: p.id, name: p.name, path: p.isHome ? "/" : `/${p.slug}/`, suggested: seo.suggested ?? null, approved: seo.approved ?? null });
  }
  return view;
}
