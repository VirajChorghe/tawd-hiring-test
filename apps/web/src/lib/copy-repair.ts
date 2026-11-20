import { and, desc, eq, inArray } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import { costOf, formatCost, modelLabel } from "@tawd/core/mockups";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { COPY_REPAIR_JOB, TEMPLATE_FILL_JOB, copyRepairJobId, templateFillJobId } from "@tawd/core/queue";
import { aiCall, designCopy, figmaDesign } from "@tawd/core/schema";
import { stepModelConfig } from "@tawd/core/step-models";
import { getQueue } from "@/lib/mockups";
import { currentStyleKit } from "@/lib/style-kit";
import type { ServiceContext } from "@/lib/users";

/*
  The kit repair, for the screens (Jason, 29 September 2026): every page's
  newest finished copy made right with the style kit by code, $0. What
  still needs a paid rebuild is listed by page and section, each with its
  price (a rebuild of that one section on the rebuild model), and nothing
  is rebuilt without a go.
*/

type Db = ServiceContext["db"];

export class CopyRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRepairError";
  }
}

/* A first guess for one section rebuilt on its own, until real ones are measured. */
export const SECTION_REBUILD_GUESS = { inputTokens: 14_000, outputTokens: 9_000 };

/* The price of rebuilding one section on its own, from the rebuilds so far (measured) or the first guess. */
export async function sectionRebuildCost(db: Db): Promise<{ cost: number; model: string; measured: boolean }> {
  const config = await stepModelConfig(db, "faithful_copy_retry");
  const calls = await db.select().from(aiCall).where(and(eq(aiCall.step, "faithful_copy"), eq(aiCall.round, 2)));
  if (calls.length > 0) {
    const cost = calls.reduce((n, c) => n + costOf(c, config), 0) / calls.length;
    return { cost, model: modelLabel(config.model), measured: true };
  }
  return { cost: costOf(SECTION_REBUILD_GUESS, config), model: modelLabel(config.model), measured: false };
}

/* Repairs every page's newest finished copy of the current design ($0). Returns how many were queued. */
export async function repairCopies(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) assertCan(actor, "project.edit");
  const kit = await currentStyleKit(ctx.db, projectId);
  if (!kit) throw new CopyRepairError("Build the style kit first (the Style kit card, $0); the repair uses it.");
  const [design] = await ctx.db.select({ version: figmaDesign.importedVersion }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const copies = await ctx.db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), eq(designCopy.figmaVersion, design?.version ?? "")))
    .orderBy(desc(designCopy.createdAt));
  if (copies.some((c) => c.status === "queued" || c.status === "working")) throw new CopyRepairError("Some copies are still being built or repaired; wait for them to finish.");
  // The newest finished copy of each page; one that is itself a repair is repaired from its original.
  const newest = new Map<string, (typeof copies)[number]>();
  for (const c of copies) if (!newest.has(c.frameId) && (c.status === "done" || c.status === "needs_cleanup") && c.sourceKey) newest.set(c.frameId, c);
  if (newest.size === 0) throw new CopyRepairError("There are no finished copies to repair yet.");
  const made: string[] = [];
  for (const c of newest.values()) {
    const [row] = await ctx.db
      .insert(designCopy)
      .values({ projectId, figmaVersion: c.figmaVersion, frameId: c.frameId, frameName: c.frameName, startedByUserId: actor.id, repairOf: c.repairOf ?? c.id })
      .returning({ id: designCopy.id });
    made.push(row!.id);
  }
  try {
    for (const id of made) await getQueue().add(COPY_REPAIR_JOB, { copyId: id, projectId }, { jobId: copyRepairJobId(id), attempts: 1 });
  } catch {
    await ctx.db.delete(designCopy).where(inArray(designCopy.id, made));
    throw new CopyRepairError("The repair couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.copy_repair_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: [...newest.values()].map((c) => c.frameName), cost: "$0 (no AI)" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return made.length;
}

/*
  Fills each page that shares a layout from the first page of its group
  ($0): the first page's newest finished copy, with the other page's words
  and photos put in by code. A fill is kept only if it matches its own
  design about as well as the page's current copy.
*/
export async function fillFromTemplates(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) assertCan(actor, "project.edit");
  const kit = await currentStyleKit(ctx.db, projectId);
  const groups = kit?.kit.sharedLayouts ?? [];
  if (!kit || groups.length === 0) throw new CopyRepairError("The style kit found no pages that share a layout.");
  const copies = await ctx.db.select().from(designCopy).where(eq(designCopy.projectId, projectId)).orderBy(desc(designCopy.createdAt));
  if (copies.some((c) => c.status === "queued" || c.status === "working")) throw new CopyRepairError("Some copies are still being built or repaired; wait for them to finish.");
  const newestDone = (frameId: string) => copies.find((c) => c.frameId === frameId && (c.status === "done" || c.status === "needs_cleanup") && c.sourceKey);
  const made: string[] = [];
  const names: string[] = [];
  for (const group of groups) {
    const template = newestDone(group.pages[0]!);
    if (!template) continue;
    for (const frameId of group.pages.slice(1)) {
      const page = copies.find((c) => c.frameId === frameId);
      const [design] = await ctx.db.select({ frames: figmaDesign.frames, version: figmaDesign.importedVersion }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
      const frame = ((design?.frames as { id: string; name: string }[] | null) ?? []).find((f) => f.id === frameId);
      if (!frame || !design?.version) continue;
      const [row] = await ctx.db
        .insert(designCopy)
        .values({ projectId, figmaVersion: design.version, frameId, frameName: page?.frameName ?? frame.name, startedByUserId: actor.id, filledFrom: template.id })
        .returning({ id: designCopy.id });
      made.push(row!.id);
      names.push(`${frame.name} from ${template.frameName}`);
    }
  }
  if (made.length === 0) throw new CopyRepairError("The first page of each shared layout needs a finished copy before the others can be filled from it.");
  try {
    for (const id of made) await getQueue().add(TEMPLATE_FILL_JOB, { copyId: id, projectId }, { jobId: templateFillJobId(id), attempts: 1 });
  } catch {
    await ctx.db.delete(designCopy).where(inArray(designCopy.id, made));
    throw new CopyRepairError("The fill couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.copy_fill_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: names, cost: "$0 (no AI)" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return made.length;
}

export async function hasFinishedCopies(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: designCopy.id })
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), inArray(designCopy.status, ["done", "needs_cleanup"])))
    .limit(1);
  return Boolean(row);
}

export interface RepairSummary {
  /** Pages repaired, still repairing, and failed. */
  repaired: { page: string; copyId: string; before: number; after: number; placed: number; keptAsBefore: string[]; filledFrom: string | null }[];
  working: number;
  failed: { page: string; reason: string }[];
  /** Sections that still need a paid rebuild, each priced. */
  paid: { page: string; copyId: string; section: string; reasons: string[]; cost: number }[];
  total: number;
  perSection: { label: string; model: string; measured: boolean };
}

interface StoredFill {
  template?: string;
  replaced?: number;
  currentMatch?: number | null;
  after?: number;
  paid?: { number: number; name: string; reasons: string[] }[];
}

interface StoredRepair {
  report?: { placed: unknown[] };
  keptAsBefore?: string[];
  before?: number;
  after?: number;
  paid?: { number: number; name: string; reasons: string[] }[];
}

/* The newest repair of each page, and what still needs paying for. Null when nothing has been repaired. */
export async function loadRepairSummary(db: Db, projectId: string): Promise<RepairSummary | null> {
  const rows = await db.select().from(designCopy).where(eq(designCopy.projectId, projectId)).orderBy(desc(designCopy.createdAt));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!newest.has(r.frameId)) newest.set(r.frameId, r);
  const repairs = [...newest.values()].filter((r) => r.repairOf || r.filledFrom);
  if (repairs.length === 0) return null;
  const price = await sectionRebuildCost(db);
  const summary: RepairSummary = { repaired: [], working: 0, failed: [], paid: [], total: 0, perSection: { label: formatCost(price.cost), model: price.model, measured: price.measured } };
  for (const r of repairs) {
    if (r.status === "queued" || r.status === "working") {
      summary.working += 1;
      continue;
    }
    if (r.status === "failed") {
      summary.failed.push({ page: r.frameName, reason: r.failureReason ?? "The repair didn't finish." });
      continue;
    }
    const checks = (r.checks as { repair?: StoredRepair; fill?: StoredFill } | null) ?? {};
    if (checks.fill) {
      const fill = checks.fill;
      summary.repaired.push({ page: r.frameName, copyId: r.id, before: fill.currentMatch ?? 0, after: fill.after ?? 0, placed: fill.replaced ?? 0, keptAsBefore: [], filledFrom: fill.template ?? null });
      for (const p of fill.paid ?? []) summary.paid.push({ page: r.frameName, copyId: r.id, section: p.name, reasons: p.reasons, cost: price.cost });
      continue;
    }
    const repair = checks.repair ?? {};
    summary.repaired.push({ page: r.frameName, copyId: r.id, before: repair.before ?? 0, after: repair.after ?? 0, placed: repair.report?.placed.length ?? 0, keptAsBefore: repair.keptAsBefore ?? [], filledFrom: null });
    for (const p of repair.paid ?? []) summary.paid.push({ page: r.frameName, copyId: r.id, section: p.name, reasons: p.reasons, cost: price.cost });
  }
  summary.total = summary.paid.reduce((n, p) => n + p.cost, 0);
  return summary;
}
