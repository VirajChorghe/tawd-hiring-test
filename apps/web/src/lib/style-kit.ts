import { and, desc, eq, inArray } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { getStorage } from "@tawd/core/intake/storage";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { STYLE_KIT_JOB, styleKitJobId } from "@tawd/core/queue";
import { figmaDesign, styleKit } from "@tawd/core/schema";
import type { CheckResult } from "@tawd/core/style-kit/element-check";
import { describeMisses } from "@tawd/core/style-kit/element-check";
import type { FontRole } from "@tawd/core/style-kit/elements";
import { FONT_CANDIDATES } from "@tawd/core/style-kit/fonts";
import type { StyleKit } from "@tawd/core/style-kit/kit";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  The style kit, for the screens (Jason, 28 September 2026): built by code
  from the design's pages, $0, no AI; the copies use it. The PM, the
  designer or an admin builds it and can pick another font for a kind of
  lettering (the matched ones are offered), which builds it again.
*/

type Db = ServiceContext["db"];

export class StyleKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StyleKitError";
  }
}

const ROLE_WORDS: Record<FontRole, string> = { script: "Script lettering", display: "Display lettering", serif: "Serif lettering", sans: "Body and headings" };

function canBuild(actor: Viewer): boolean {
  return can(actor, "project.edit") || can(actor, "design.decide");
}

async function queueKit(ctx: ServiceContext, actor: Viewer, projectId: string, fontOverrides: Partial<Record<FontRole, string>>): Promise<string> {
  const [design] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const frames = (design?.frames as ImportedFrame[] | null) ?? [];
  if (!design || design.importStatus !== "done" || !design.importedVersion || frames.length === 0) {
    throw new StyleKitError("Upload and read the design first; the style kit is built from its pages.");
  }
  const [running] = await ctx.db
    .select({ id: styleKit.id })
    .from(styleKit)
    .where(and(eq(styleKit.projectId, projectId), inArray(styleKit.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new StyleKitError("The style kit is already being built.");
  const [row] = await ctx.db
    .insert(styleKit)
    .values({ projectId, designVersion: design.importedVersion, fontOverrides, startedByUserId: actor.id })
    .returning({ id: styleKit.id });
  try {
    await getQueue().add(STYLE_KIT_JOB, { kitId: row!.id, projectId }, { jobId: styleKitJobId(row!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(styleKit).where(eq(styleKit.id, row!.id));
    throw new StyleKitError("The style kit couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  return row!.id;
}

/* Builds the kit ($0): the fonts the designer picked before are kept. */
export async function startStyleKit(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  if (!canBuild(actor)) assertCan(actor, "project.edit");
  const [last] = await ctx.db.select({ fontOverrides: styleKit.fontOverrides }).from(styleKit).where(eq(styleKit.projectId, projectId)).orderBy(desc(styleKit.createdAt)).limit(1);
  const id = await queueKit(ctx, actor, projectId, (last?.fontOverrides as Partial<Record<FontRole, string>> | null) ?? {});
  await recordActivity(ctx.db, {
    action: "design.style_kit_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { cost: "$0 (no AI)" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return id;
}

/* The designer picks another font for one kind of lettering; the kit is built again with it. */
export async function setKitFont(ctx: ServiceContext, actor: Viewer, projectId: string, role: FontRole, family: string): Promise<string> {
  if (!canBuild(actor)) assertCan(actor, "project.edit");
  if (!FONT_CANDIDATES[role]?.includes(family)) throw new StyleKitError(`${family} isn't one of the fonts TAWD offers for ${ROLE_WORDS[role]?.toLowerCase() ?? "that lettering"}.`);
  const [last] = await ctx.db.select().from(styleKit).where(eq(styleKit.projectId, projectId)).orderBy(desc(styleKit.createdAt)).limit(1);
  const before = (last?.kit as StyleKit | null)?.fonts.find((f) => f.role === role)?.family ?? null;
  const overrides = { ...((last?.fontOverrides as Partial<Record<FontRole, string>> | null) ?? {}), [role]: family };
  const id = await queueKit(ctx, actor, projectId, overrides);
  await recordActivity(ctx.db, {
    action: "design.style_kit_font_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { role, family: before },
    valueAfter: { role, family },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return id;
}

export interface StyleKitView {
  id: string;
  /** "none": no kit has been built yet. */
  status: "none" | "queued" | "working" | "done" | "failed";
  failureReason: string | null;
  /** The design was imported again after this kit: build it again. */
  outOfDate: boolean;
  colors: { hex: string; uses: string[] }[];
  fonts: { role: FontRole; label: string; family: string; match: number; alternatives: string[]; chosenByDesigner: boolean; fetched: boolean }[];
  parts: { kind: string; count: number }[];
  icons: { traced: number; matched: number; brands: string[] };
  notes: string[];
  previewMatch: number | null;
  previewMisses: string[];
  sheetUrl: string | null;
  previewUrl: string | null;
  designUrl: string | null;
  /** Pages that share a layout, by name, with the saving of building each layout once (Jason's templates). */
  sharedLayouts: { pages: string[]; agreement: number }[];
  canBuild: boolean;
  /** A kit can only be built from a design that has been read. */
  designReady: boolean;
}

export async function loadStyleKit(db: Db, projectId: string, viewer: Viewer): Promise<StyleKitView | null> {
  const [design] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const designReady = Boolean(design && design.importStatus === "done" && design.importedVersion);
  const [row] = await db.select().from(styleKit).where(eq(styleKit.projectId, projectId)).orderBy(desc(styleKit.createdAt)).limit(1);
  if (!row) return designReady ? emptyView(canBuild(viewer)) : null;
  const kit = row.kit as StyleKit | null;
  const overrides = (row.fontOverrides as Partial<Record<FontRole, string>> | null) ?? {};
  const storage = getStorage();
  const home = ((design?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome);
  const partKinds = ["panel", "card", "box", "button", "ribbon", "divider"];
  const brands = (kit?.icons ?? []).filter((i) => i.label !== "icon from the design" && i.label !== "play button" && !/^player-play$/.test(i.label));
  return {
    id: row.id,
    status: row.status as StyleKitView["status"],
    failureReason: row.failureReason,
    outOfDate: Boolean(design?.importedVersion && design.importedVersion !== row.designVersion),
    colors: (kit?.colors ?? []).map((c) => ({ hex: c.hex, uses: c.uses })),
    fonts: (kit?.fonts ?? []).map((f) => ({
      role: f.role,
      label: ROLE_WORDS[f.role],
      family: f.family,
      match: Math.round(f.score * 100),
      alternatives: f.alternatives.map((a) => a.family),
      chosenByDesigner: overrides[f.role] === f.family,
      fetched: f.files.length > 0,
    })),
    parts: partKinds.map((kind) => ({ kind, count: (kit?.parts ?? []).filter((p) => p.kind === kind).length })).filter((p) => p.count > 0),
    icons: { traced: (kit?.icons ?? []).filter((i) => i.label === "icon from the design").length, matched: brands.length, brands: [...new Set(brands.map((b) => b.label))] },
    notes: kit?.notes ?? [],
    previewMatch: row.previewFidelity,
    previewMisses: row.previewCheck ? describeMisses(row.previewCheck as CheckResult) : [],
    sheetUrl: row.sheetKey ? await storage.signDownload(row.sheetKey, "style-kit.png") : null,
    previewUrl: row.previewKey ? await storage.signDownload(row.previewKey, "home-from-kit.png") : null,
    designUrl: home?.imageKey ? await storage.signDownload(home.imageKey, `${home.name}.png`) : null,
    sharedLayouts: (kit?.sharedLayouts ?? []).map((g) => ({
      pages: g.pages.map((id) => ((design?.frames as ImportedFrame[] | null) ?? []).find((f) => f.id === id)?.name ?? id),
      agreement: g.agreement,
    })),
    canBuild: canBuild(viewer),
    designReady,
  };
}

function emptyView(build: boolean): StyleKitView {
  return {
    id: "",
    status: "none",
    failureReason: null,
    outOfDate: false,
    colors: [],
    fonts: [],
    parts: [],
    icons: { traced: 0, matched: 0, brands: [] },
    notes: [],
    previewMatch: null,
    previewMisses: [],
    sheetUrl: null,
    previewUrl: null,
    designUrl: null,
    sharedLayouts: [],
    canBuild: build,
    designReady: true,
  };
}

/* The newest finished kit for the project's current design, for the copies (null if there's none). */
export async function currentStyleKit(db: Db, projectId: string): Promise<{ id: string; kit: StyleKit } | null> {
  const [design] = await db.select({ version: figmaDesign.importedVersion }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!design?.version) return null;
  const [row] = await db
    .select({ id: styleKit.id, kit: styleKit.kit })
    .from(styleKit)
    .where(and(eq(styleKit.projectId, projectId), eq(styleKit.status, "done"), eq(styleKit.designVersion, design.version)))
    .orderBy(desc(styleKit.createdAt))
    .limit(1);
  return row?.kit ? { id: row.id, kit: row.kit as StyleKit } : null;
}
