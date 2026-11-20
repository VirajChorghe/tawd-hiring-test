import { eq } from "drizzle-orm";
import { z } from "zod";

import { project, wireframe } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { hasCurrentWebsite, projectTypeOf } from "@tawd/core/intake";
import { siteReadHome } from "@tawd/core/site-read";
import {
  WIREFRAME_KINDS,
  checkWireframeSections,
  draftWireframeSections,
  listIntakeFacts,
  wireframeApplies,
  draftWireframeFromSite,
  type WireframeSection,
} from "@tawd/core/mockups";
import { MockupError } from "@/lib/mockups";
import { siteMapPreview } from "@/lib/seo-data";
import type { ServiceContext } from "@/lib/users";

/*
  The wireframe (Jason, 3 October 2026): before the concepts, on Growth and
  Pro, the site map and the home page's sections in order, as grey boxes,
  made by code from the intake (free). A PM, the Web Designer or an admin
  edits and approves it; Generate waits until then, and every concept
  builds its bands in that order. A PM can switch it on for Starter, or
  off. Any change after approval asks for approval again.
*/

type Db = ServiceContext["db"];

export interface WireframeView {
  /** Whether this project uses the wireframe (lane, tier and the PM's choice). */
  applies: boolean;
  lane: string;
  tier: string;
  /** The PM's choice, or null when it follows the tier. */
  enabled: boolean | null;
  sections: WireframeSection[];
  /** Not saved yet: the draft from the intake. */
  drafted: boolean;
  sitemap: { source: "plan" | "draft"; pages: { name: string; slug: string; parentSlug: string | null }[] };
  approved: { byUserId: string | null; at: Date } | null;
  /** Design only: no wireframe, whatever the tier or the PM's choice. */
  designOnly: boolean;
}

async function row(db: Db, projectId: string) {
  const [r] = await db.select().from(wireframe).where(eq(wireframe.projectId, projectId)).limit(1);
  return r ?? null;
}

async function projectFacts(db: Db, projectId: string) {
  const [p] = await db.select({ lane: project.lane, tier: project.tier, trade: project.trade }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!p) throw new MockupError("That project no longer exists.");
  // Design only has no wireframe (0.100.0).
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const designOnly = intake ? projectTypeOf({ lane: p.lane, mode: intake.data.content.mode, hasCurrentWebsite: hasCurrentWebsite(intake.data.website) }) === "design_only" : false;
  return { ...p, designOnly };
}

/* The draft from the intake's facts. */
async function draftFor(db: Db, projectId: string, trade: string): Promise<WireframeSection[]> {
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  if (!intake) throw new MockupError("That project has no intake yet.");
  const facts = listIntakeFacts(intake.data, intake.files, { trade });
  // Design + content (0.100.0): the current home page's own sections, in its order.
  if (intake.data.content.mode === "improve" && hasCurrentWebsite(intake.data.website)) {
    const home = await siteReadHome(db, projectId);
    if (home) return draftWireframeFromSite(home.sections, facts);
  }
  return draftWireframeSections(facts);
}

export async function loadWireframe(db: Db, projectId: string): Promise<WireframeView> {
  const p = await projectFacts(db, projectId);
  const r = await row(db, projectId);
  const applies = wireframeApplies({ lane: p.lane, tier: p.tier, enabled: r?.enabled ?? null, designOnly: p.designOnly });
  const saved = (r?.sections as WireframeSection[] | undefined) ?? [];
  const showSections = p.lane === "lane_1";
  return {
    applies,
    lane: p.lane,
    tier: p.tier,
    enabled: r?.enabled ?? null,
    sections: saved.length ? saved : showSections ? await draftFor(db, projectId, p.trade) : [],
    drafted: saved.length === 0,
    sitemap: showSections ? await siteMapPreview(db, projectId) : { source: "draft", pages: [] },
    approved: r?.approvedAt ? { byUserId: r.approvedByUserId, at: r.approvedAt } : null,
    designOnly: p.designOnly,
  };
}

/* Why Generate has to wait, or null: the wireframe applies and isn't approved. */
export async function wireframeBlocked(db: Db, projectId: string): Promise<string | null> {
  const p = await projectFacts(db, projectId);
  const r = await row(db, projectId);
  if (!wireframeApplies({ lane: p.lane, tier: p.tier, enabled: r?.enabled ?? null, designOnly: p.designOnly })) return null;
  return r?.approvedAt ? null : "Approve the wireframe first: every concept is built in its section order.";
}

/* Whether an approved wireframe sets the home page's section order (so the reference sites' order doesn't). */
export async function wireframeSetsOrder(db: Db, projectId: string): Promise<boolean> {
  const p = await projectFacts(db, projectId);
  const r = await row(db, projectId);
  return wireframeApplies({ lane: p.lane, tier: p.tier, enabled: r?.enabled ?? null, designOnly: p.designOnly }) && Boolean(r?.approvedAt);
}

const sectionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  kind: z.enum(WIREFRAME_KINDS),
  name: z.string().trim().min(1, "Give every section a name.").max(60, "Keep a section's name under 60 characters."),
  lines: z.array(z.string().max(300)).max(10),
  note: z.string().max(500, "Keep a note under 500 characters."),
});

function readSections(input: unknown): WireframeSection[] {
  const parsed = z.array(sectionSchema).safeParse(input);
  if (!parsed.success) throw new MockupError(parsed.error.issues[0]!.message);
  const sections = parsed.data.map((s) => ({ ...s, name: s.name.trim(), note: s.note.trim() }));
  const problem = checkWireframeSections(sections);
  if (problem) throw new MockupError(problem);
  return sections;
}

async function assertEditable(db: Db, actor: Viewer, projectId: string) {
  assertCan(actor, "intake.design");
  const p = await projectFacts(db, projectId);
  if (p.lane !== "lane_1") throw new MockupError("The wireframe is for Lane 1 projects; Lane 2 follows the client's design.");
  return p;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* Keeps the team's version. A change after approval asks for approval again. */
export async function saveWireframe(ctx: ServiceContext, actor: Viewer, projectId: string, input: unknown): Promise<void> {
  await assertEditable(ctx.db, actor, projectId);
  const sections = readSections(input);
  const r = await row(ctx.db, projectId);
  if (r && same(r.sections, sections)) return;
  const now = new Date();
  await ctx.db
    .insert(wireframe)
    .values({ projectId, sections, updatedByUserId: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: wireframe.projectId, set: { sections, approvedAt: null, approvedByUserId: null, updatedByUserId: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, {
    action: "mockups.wireframe_saved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: r ? { sections: (r.sections as WireframeSection[]).map((s) => s.name), approved: Boolean(r.approvedAt) } : null,
    valueAfter: { sections: sections.map((s) => s.name) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Saves what's on the screen and approves it, with the site map as it stands. */
export async function approveWireframe(ctx: ServiceContext, actor: Viewer, projectId: string, input: unknown): Promise<void> {
  await assertEditable(ctx.db, actor, projectId);
  const sections = readSections(input);
  const sitemap = await siteMapPreview(ctx.db, projectId);
  const now = new Date();
  await ctx.db
    .insert(wireframe)
    .values({ projectId, sections, sitemap: sitemap.pages, approvedAt: now, approvedByUserId: actor.id, updatedByUserId: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: wireframe.projectId, set: { sections, sitemap: sitemap.pages, approvedAt: now, approvedByUserId: actor.id, updatedByUserId: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, {
    action: "mockups.wireframe_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { sections: sections.map((s) => s.name), pages: sitemap.pages.map((p) => p.name) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Back to the draft from the intake (after the intake changed, say). */
export async function resetWireframe(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  await assertEditable(ctx.db, actor, projectId);
  const r = await row(ctx.db, projectId);
  if (!r || (r.sections as unknown[]).length === 0) return;
  await ctx.db.update(wireframe).set({ sections: [], approvedAt: null, approvedByUserId: null, updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(wireframe.id, r.id));
  await recordActivity(ctx.db, { action: "mockups.wireframe_reset", entityType: "project", entityId: projectId, ...actorFields(actor), ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* A PM switches it on (Starter) or off (Growth, Pro). */
export async function setWireframeEnabled(ctx: ServiceContext, actor: Viewer, projectId: string, enabled: boolean): Promise<void> {
  assertCan(actor, "project.edit");
  const p = await projectFacts(ctx.db, projectId);
  if (p.lane !== "lane_1") throw new MockupError("The wireframe is for Lane 1 projects.");
  const now = new Date();
  await ctx.db
    .insert(wireframe)
    .values({ projectId, enabled, updatedByUserId: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: wireframe.projectId, set: { enabled, updatedByUserId: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, { action: "mockups.wireframe_switched", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { on: enabled, tier: p.tier }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}
