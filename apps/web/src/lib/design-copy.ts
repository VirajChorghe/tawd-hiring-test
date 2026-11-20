import { stillOffAdvice } from "@tawd/core/figma";
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { aiCall, designCopy, figmaDesign, project, user as userTable } from "@tawd/core/schema";
import { callCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { ImportedAsset, ImportedFrame } from "@tawd/core/figma/service";
import { getStorage } from "@tawd/core/intake/storage";
import { describeMisses, type CheckResult } from "@tawd/core/style-kit/element-check";
import { costOf, formatCost, getModelConfig } from "@tawd/core/mockups";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { FAITHFUL_COPY_JOB, faithfulCopyJobId } from "@tawd/core/queue";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import { personLabel, type ServiceContext } from "@/lib/users";

/*
  Lane 2, Option B: the faithful copy. The designer's homepage frame
  rebuilt as a static HTML page, nothing changed, compared with the Figma
  frame for free. The build is the one paid step, and its estimate is
  shown before anything is spent.
*/

type Db = ServiceContext["db"];

export class DesignCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignCopyError";
  }
}

/*
  A first guess until a copy has been built the current way (section by
  section since 26 September 2026): a few calls, each with its sections'
  pictures and outline in and their HTML out (thinking included), a visual
  check of every section against the design, and one rebuild of the
  sections that differ.
*/
export const DESIGN_COPY_GUESS = { inputTokens: 80_000, outputTokens: 55_000 };

/* The steps a copy pays for: building its sections and the visual check. */
const COPY_STEPS = ["faithful_copy", "faithful_check"];

/* A copy under this match gets a warning and an offer to build it again. */
export const FIDELITY_WARNING = 80;

export async function estimateDesignCopy(db: Db): Promise<{ cost: number; label: string; measured: boolean }> {
  // The copy and its look check can run on different models: each call is priced at its step's model now.
  const config = await stepModelConfig(db, "faithful_copy");
  const check = await stepModelConfig(db, "faithful_check");
  // Sections rebuilt after a low score (round 2) run on the retry model (27 September 2026).
  const retry = await stepModelConfig(db, "faithful_copy_retry");
  const priced = (call: { step: string; round: number | null }) => (call.step === "faithful_check" ? check : (call.round ?? 1) > 1 ? retry : config);
  const models = `on ${modelLabel(config.model)}${retry.model !== config.model ? `, sections rebuilt after a low score on ${modelLabel(retry.model)}` : ""}, look check on ${modelLabel(check.model)}`;
  const calls = await db.select().from(aiCall).where(inArray(aiCall.step, COPY_STEPS));
  // Only copies built section by section: they have a visual check. The old one-call copies cost far less and would mislead.
  const current = new Set(calls.filter((c) => c.step === "faithful_check").map((c) => c.runId));
  const byCopy = new Map<string, number>();
  for (const call of calls) if (current.has(call.runId)) byCopy.set(call.runId, (byCopy.get(call.runId) ?? 0) + costOf(call, priced(call)));
  if (byCopy.size > 0) {
    const cost = [...byCopy.values()].reduce((a, b) => a + b, 0) / byCopy.size;
    return { cost, label: `About ${formatCost(cost)} of AI (${models}), from the copies so far`, measured: true };
  }
  const cost = costOf(DESIGN_COPY_GUESS, config);
  return { cost, label: `About ${formatCost(cost)} of AI (${models}; a first guess until a real copy has been built)`, measured: false };
}

/* Queues the copy of the imported homepage. Paid: the estimate was shown first. */
export async function startDesignCopy(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db
    .select({ lane: project.lane, laneOption: project.laneOption })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!row) throw new DesignCopyError("That project no longer exists.");
  if (row.lane !== "lane_2") {
    throw new DesignCopyError("A faithful copy is only for Lane 2 (the client supplied a design).");
  }
  const [figma] = await ctx.db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const home = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome);
  if (!figma || figma.importStatus !== "done" || !home?.imageKey || !figma.importedVersion) {
    throw new DesignCopyError("Import the designer's design first; the copy is built from the imported homepage.");
  }
  const [running] = await ctx.db
    .select({ id: designCopy.id })
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), inArray(designCopy.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new DesignCopyError("The copy is already being built.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (await estimateDesignCopy(ctx.db)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new DesignCopyError(error.message);
    throw error;
  }

  const estimate = await estimateDesignCopy(ctx.db);
  const [copy] = await ctx.db
    .insert(designCopy)
    .values({ projectId, figmaVersion: figma.importedVersion, frameId: home.id, frameName: home.name, startedByUserId: actor.id })
    .returning({ id: designCopy.id });
  try {
    await getQueue().add(FAITHFUL_COPY_JOB, { copyId: copy!.id, projectId }, { jobId: faithfulCopyJobId(copy!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(designCopy).where(eq(designCopy.id, copy!.id));
    throw new DesignCopyError("The copy couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.copy_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { frame: home.name, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return copy!.id;
}

/*
  Replay (Jason, 28 September 2026): the copy built again from an earlier
  copy's saved AI answers, with today's code, for $0, so a fix is tested on
  a client's real data before anything is paid for. Admins only; nothing is
  sent to Anthropic, and the new copy says it is a replay. A replay of a
  replay uses the first copy's answers.
*/
export async function replayCopy(ctx: ServiceContext, actor: Viewer, projectId: string, copyId: string): Promise<string> {
  assertCan(actor, "money.manage");
  const [source] = await ctx.db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.id, copyId), eq(designCopy.projectId, projectId)))
    .limit(1);
  if (!source) throw new DesignCopyError("That copy is no longer there.");
  if (source.status === "queued" || source.status === "working") throw new DesignCopyError("That copy is still being built; replay it once it's finished.");
  const answersFrom = source.replayOf ?? source.id;
  const [saved] = await ctx.db
    .select({ n: count() })
    .from(aiCall)
    .where(and(eq(aiCall.runId, answersFrom), isNotNull(aiCall.responseKey)));
  if (!saved || saved.n === 0) throw new DesignCopyError("This copy has no saved AI answers to replay (copies built before answers were saved can't be replayed).");
  const [running] = await ctx.db
    .select({ id: designCopy.id })
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), eq(designCopy.frameId, source.frameId), inArray(designCopy.status, ["queued", "working"])))
    .limit(1);
  if (running) throw new DesignCopyError("This page is already being copied.");
  const [copy] = await ctx.db
    .insert(designCopy)
    .values({ projectId, figmaVersion: source.figmaVersion, frameId: source.frameId, frameName: source.frameName, startedByUserId: actor.id, replayOf: answersFrom })
    .returning({ id: designCopy.id });
  try {
    await getQueue().add(FAITHFUL_COPY_JOB, { copyId: copy!.id, projectId, replay: { fromRunIds: [answersFrom] } }, { jobId: faithfulCopyJobId(copy!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(designCopy).where(eq(designCopy.id, copy!.id));
    throw new DesignCopyError("The replay couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.copy_replayed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: source.frameName, from: answersFrom, answers: saved.n },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return copy!.id;
}

/* ---------- what the screens read ---------- */

export interface Fidelity {
  overall: number;
  sections: { name: string; score: number }[];
  method: "sections" | "page";
  designHeight: number;
  copyHeight: number;
}

export interface DesignCopyView {
  id: string;
  /** needs_cleanup: built, but a section still differs after its rebuild: the design file needs cleaning (27 September 2026). */
  status: "queued" | "working" | "done" | "failed" | "needs_cleanup";
  failureReason: string | null;
  frameName: string;
  createdAt: Date;
  finishedAt: Date | null;
  startedBy: string | null;
  fidelity: Fidelity | null;
  issues: { id: string; severity: string; message: string }[];
  /** The builder's notes: plain words for the PM, and any technical detail behind "Details". */
  notes: { text: string; details: string | null }[];
  /** One plain sentence: how close the copy is, and where it differs most. */
  summary: string;
  /** Each Figma section, when the copy's sections lined up with the design's: the match, the eye check, whether it was rebuilt. */
  sections: {
    number: number;
    name: string;
    score: number;
    verdict: "close" | "off" | null;
    differences: string[];
    rebuilt: boolean;
  }[];
  /** Text on the page that doesn't match the design's text layers, section by section. */
  textProblems: { name: string; missing: string[]; extra: string[]; repeated: string[]; outOfOrder: boolean }[];
  /** The match of the first build, when some sections were rebuilt after the look. */
  firstMatch: number | null;
  rebuiltCount: number;
  /** Accepted as it is (28 September 2026). */
  accepted: { byUserId: string | null; at: Date; note: string } | null;
  /** The style kit check (28 September 2026): built with the kit, and each miss by name ("Meet the pack: the ribbon "Mia" is missing."). */
  kitCheck: { misses: string[]; checked: number } | null;
  /** Made right with the style kit by code ($0, 29 September 2026): the copy repaired, its match before and after, the items put in. */
  repairOf: { id: string; at: Date; before: number; after: number; placed: number } | null;
  /** Filled by code from the copy of a page that shares its layout ($0): that page and how many words were put in. */
  filledFrom: { page: string; words: number } | null;
  /** Built from an earlier copy's saved answers (replay, $0): that copy's id and when it was made. */
  replayOf: { id: string; at: Date } | null;
  firstModel: string;
  rebuiltModel: string | null;
  cost: number;
  outOfDate: boolean;
  copyImageUrl: string | null;
  designImageUrl: string | null;
  designWidth: number;
  designHeight: number;
}

export async function loadDesignCopy(db: Db, projectId: string, copyId?: string | null): Promise<DesignCopyView | null> {
  // The homepage's copy by default; Option A's other pages by their copy's id (28 September 2026).
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const homeId = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome)?.id;
  const [row] = await db
    .select()
    .from(designCopy)
    .where(
      copyId && UUID.test(copyId)
        ? and(eq(designCopy.projectId, projectId), eq(designCopy.id, copyId))
        : homeId
          ? and(eq(designCopy.projectId, projectId), eq(designCopy.frameId, homeId))
          : eq(designCopy.projectId, projectId),
    )
    .orderBy(desc(designCopy.createdAt))
    .limit(1);
  if (!row) return null;
  const frame = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.id === row.frameId);
  const storage = getStorage();
  const config = getModelConfig();
  const calls = await db.select().from(aiCall).where(eq(aiCall.runId, row.id));

  let startedBy: string | null = null;
  if (row.startedByUserId) {
    const [person] = await db
      .select({ name: userTable.name, deletedAt: userTable.deletedAt })
      .from(userTable)
      .where(eq(userTable.id, row.startedByUserId))
      .limit(1);
    startedBy = person ? personLabel(person.name, person.deletedAt) : null;
  }

  const [filledFromRow] = row.filledFrom ? await db.select({ frameName: designCopy.frameName }).from(designCopy).where(eq(designCopy.id, row.filledFrom)).limit(1) : [];
  const [repairedFrom] = row.repairOf ? await db.select({ id: designCopy.id, createdAt: designCopy.createdAt }).from(designCopy).where(eq(designCopy.id, row.repairOf)).limit(1) : [];
  const [replayedFrom] = row.replayOf ? await db.select({ id: designCopy.id, createdAt: designCopy.createdAt }).from(designCopy).where(eq(designCopy.id, row.replayOf)).limit(1) : [];
  const fidelity = row.fidelity as Fidelity | null;
  const checks = (row.checks as StoredChecks | null) ?? {};
  const rebuilt = new Set(checks.rebuilt ?? []);
  const sections =
    fidelity && fidelity.method === "sections"
      ? fidelity.sections.map((section, index) => {
          const seen = checks.visual?.sections.find((v) => v.section === index + 1);
          return {
            number: index + 1,
            name: section.name,
            score: section.score,
            verdict: seen?.verdict ?? null,
            differences: seen?.differences ?? [],
            rebuilt: rebuilt.has(index + 1),
          };
        })
      : [];

  return {
    id: row.id,
    status: row.status as DesignCopyView["status"],
    failureReason: stillOffAdvice(figma?.source ?? null, row.failureReason),
    accepted: row.acceptedAt ? { byUserId: row.acceptedByUserId, at: row.acceptedAt, note: row.acceptedNote ?? "" } : null,
    replayOf: replayedFrom ? { id: replayedFrom.id, at: replayedFrom.createdAt } : null,
    filledFrom: filledFromRow ? { page: filledFromRow.frameName, words: (checks as { fill?: { replaced?: number } }).fill?.replaced ?? 0 } : null,
    repairOf: repairedFrom
      ? {
          id: repairedFrom.id,
          at: repairedFrom.createdAt,
          before: (checks as { repair?: { before?: number } }).repair?.before ?? 0,
          after: (checks as { repair?: { after?: number } }).repair?.after ?? 0,
          placed: (checks as { repair?: { report?: { placed?: unknown[] } } }).repair?.report?.placed?.length ?? 0,
        }
      : null,
    kitCheck: checks.elements ? { misses: describeMisses(checks.elements), checked: checks.elements.sections.reduce((n, x) => n + x.checked, 0) } : null,
    frameName: row.frameName,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    startedBy,
    fidelity,
    // A copy has only what the designer drew: no form of its own, and the design's photos, not the uploads.
    issues: (checks.issues ?? []).filter((i) => i.severity === "fail" && !NOT_FOR_A_COPY.has(i.id)),
    notes: ((row.notes as string[] | null) ?? []).map(splitNote),
    summary: fidelity ? copySummary(fidelity.overall, sections) : "",
    sections,
    textProblems: (checks.text ?? [])
      .filter((t) => t.missing.length + t.extra.length + t.repeated.length > 0 || t.outOfOrder)
      .map((t) => ({ name: t.name, missing: t.missing, extra: t.extra, repeated: t.repeated, outOfOrder: t.outOfOrder })),
    firstMatch: rebuilt.size > 0 ? (checks.firstMatch ?? null) : null,
    rebuiltCount: rebuilt.size,
    // Which model built the page first and which rebuilt its weak sections (Sonnet first, Opus for the rebuilds since 27 September 2026).
    firstModel: modelLabel(calls.find((c) => c.step === "faithful_copy" && (c.round ?? 1) === 1)?.model ?? config.model),
    rebuiltModel: calls.find((c) => c.step === "faithful_copy" && (c.round ?? 1) > 1) ? modelLabel(calls.find((c) => c.step === "faithful_copy" && (c.round ?? 1) > 1)!.model) : null,
    cost: calls.reduce((n, c) => n + callCost(c, config), 0),
    outOfDate: Boolean(figma?.importedVersion && figma.importedVersion !== row.figmaVersion),
    copyImageUrl: row.pngKey ? await storage.signDownload(row.pngKey, "faithful-copy.png") : null,
    designImageUrl: frame?.imageKey ? await storage.signDownload(frame.imageKey, `${frame.name}.png`) : null,
    designWidth: frame?.width ?? 1440,
    designHeight: frame?.height ?? 900,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOR_A_COPY = new Set(["conversion.form.missing", "images.photos.unused"]);

/* What the worker keeps in design_copy.checks. */
interface StoredChecks {
  passed?: boolean;
  issues?: DesignCopyView["issues"];
  text?: { number: number; name: string; missing: string[]; extra: string[]; repeated: string[]; outOfOrder: boolean }[];
  visual?: { sections: { section: number; verdict: "close" | "off"; differences: string[] }[]; summary: string } | null;
  rebuilt?: number[];
  firstMatch?: number;
  /** The style kit's element check (28 September 2026). */
  elements?: CheckResult | null;
}

/*
  A builder's note in plain words, with anything technical (layer names,
  pixel sizes, positions) moved behind "Details": after a "Details:" marker,
  or in brackets that hold numbers.
*/
export function splitNote(note: string): { text: string; details: string | null } {
  const marked = /\s*Details:\s*/i.exec(note);
  if (marked) {
    return { text: note.slice(0, marked.index).trim(), details: note.slice(marked.index + marked[0].length).trim() || null };
  }
  const technical = [...note.matchAll(/\s*\(([^()]*\d[^()]*)\)/g)];
  if (technical.length === 0) return { text: note, details: null };
  return {
    text: technical.reduce((t, m) => t.replace(m[0], ""), note).trim(),
    details: technical.map((m) => m[1]!.trim()).join("; "),
  };
}

/* "Close to the design; the biggest difference is in “Reviews” (72%)." */
export function copySummary(overall: number, sections: { name: string; score: number }[]): string {
  const level =
    overall >= 90
      ? "Very close to the design"
      : overall >= FIDELITY_WARNING
        ? "Close to the design, with small differences"
        : overall >= 60
          ? "Recognisably the design, with clear differences"
          : "Far from the design";
  const weakest = [...sections].sort((a, b) => a.score - b.score)[0];
  return weakest && weakest.score < 90
    ? `${level}; the biggest difference is in “${weakest.name}” (${weakest.score}%).`
    : `${level}.`;
}

/* The copy as a page, for "Open the page": the newest finished one. */
/*
  A finished copy's page: the one asked for, else the homepage's newest.
  (Before 28 September 2026 this took the project's newest copy of any
  page, so on Option A "Open the page" could show another page.)
*/
export async function designCopyPage(db: Db, projectId: string, copyId?: string | null): Promise<string | null> {
  const [figma] = await db.select({ frames: figmaDesign.frames }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const homeId = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome)?.id;
  const which = copyId && UUID.test(copyId) ? eq(designCopy.id, copyId) : homeId ? eq(designCopy.frameId, homeId) : undefined;
  const [row] = await db
    .select({ htmlKey: designCopy.htmlKey })
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), inArray(designCopy.status, ["done", "needs_cleanup"]), ...(which ? [which] : [])))
    .orderBy(desc(designCopy.createdAt))
    .limit(1);
  if (!row?.htmlKey) return null;
  const body = await getStorage().get(row.htmlKey);
  return body ? body.toString("utf8") : null;
}

/* Whether the import brought in the logo and icons (imports before they were kept did not). */
export async function importedDrawings(db: Db, projectId: string): Promise<{ logos: number; icons: number } | null> {
  const [figma] = await db.select({ designAssets: figmaDesign.designAssets }).from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const assets = figma?.designAssets as ImportedAsset[] | null | undefined;
  if (!assets) return null;
  return { logos: assets.filter((a) => a.kind === "logo").length, icons: assets.filter((a) => a.kind === "icon").length };
}
