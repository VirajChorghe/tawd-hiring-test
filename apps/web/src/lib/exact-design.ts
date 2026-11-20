import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, clientDecision, concept, conceptVersion, designCopy, designPage, figmaDesign, mockupRun, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { PermissionError, assertCan, can, type Viewer } from "@tawd/core/permissions";
import { DESIGN_MOBILE_JOB, FAITHFUL_COPY_JOB, designMobileJobId, faithfulCopyJobId } from "@tawd/core/queue";
import { MOBILE_GUESS, checkPages, frameRole, proposePages, stillOffAdvice } from "@tawd/core/figma";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { DESIGNER_CONCEPT, costOf, formatCost } from "@tawd/core/mockups";
import { CHANNELS } from "@/lib/concept-review";
import { makeClientDesignDoc } from "@/lib/client-design";
import { getStorage } from "@tawd/core/intake/storage";
import { DesignCopyError, estimateDesignCopy, type Fidelity } from "@/lib/design-copy";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Lane 2, Option A, "build it exactly" (28 September 2026). The client has
  approved the design, so nothing is redesigned: every desktop frame is a
  page of the site, copied exactly with its fidelity scored per section;
  the phone version comes from the page's mobile frame, or is a responsive
  version flagged for the designer's review (3b); then the approved design
  is built as the site (3c).
*/

type Db = Database;

export interface ExactPageView {
  id: string;
  frameId: string;
  frameName: string;
  name: string;
  slug: string;
  isHome: boolean;
  mobileFrameName: string | null;
  copy: {
    id: string;
    status: string;
    /** Waiting: its place in the queue, 1 for next (28 September 2026). */
    inLine: number | null;
    /** Being copied: what it is doing and how far it has got. */
    progress: { stage: "building" | "checking" | "rebuilding"; done: number; total: number } | null;
    overall: number | null;
    lowest: { name: string; score: number } | null;
    failureReason: string | null;
    /** Accepted as it is: "by Priya, Sep 28: the gallery gap is in the PDF too". */
    accepted: { by: string | null; at: Date; note: string } | null;
    /** problems: the phone check's findings, in words (a phone version made by code). */
    mobile: { status: string | null; from: string | null; overflow: boolean | null; decision: string | null; failure: string | null; pngUrl: string | null; problems: string[] };
  } | null;
}

export interface ExactDesignView {
  imported: boolean;
  /** A PDF or image design, not Figma: no "clean the frame in Figma" advice (28 September 2026). */
  upload?: boolean;
  figmaVersion: string | null;
  confirmed: boolean;
  pages: ExactPageView[];
  mobileFrames: number;
  toBuild: number;
  estimate: { cost: number; label: string };
  /** One page's copy, for the dialog's running estimate as pages are ticked (27 September 2026). */
  perPage: { cost: number; label: string };
  working: boolean;
  /** The phone versions (3b): how many pages still need one, and what they cost. */
  mobileToMake: number;
  mobileEstimate: { cost: number; label: string };
  mobileWorking: boolean;
  /** 3c: what still stops the approval being recorded, and the approval once it is. */
  approvalProblems: string[];
  approved: { channel: string; clientSaid: string; at: Date } | null;
}

async function requireOptionA(db: Db, projectId: string): Promise<void> {
  const [row] = await db.select({ lane: project.lane, laneOption: project.laneOption }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new DesignCopyError("That project no longer exists.");
  if (row.lane !== "lane_2" || row.laneOption !== "a") throw new DesignCopyError("Building the design exactly is for Lane 2, Option A (the client approved the design).");
}

/* The pages of the imported design: proposed from the frames the first time, kept after. */
export async function pagesFor(db: Db, projectId: string, figma: typeof figmaDesign.$inferSelect) {
  const version = figma.importedVersion!;
  const existing = await db.select().from(designPage).where(and(eq(designPage.projectId, projectId), eq(designPage.figmaVersion, version))).orderBy(asc(designPage.position));
  if (existing.length) return existing;
  const frames = (figma.frames as ImportedFrame[] | null) ?? [];
  const proposed = proposePages(frames);
  if (proposed.length === 0) return [];
  // A newer import starts the pages again.
  await db.delete(designPage).where(eq(designPage.projectId, projectId));
  return db.insert(designPage).values(proposed.map((p) => ({ projectId, figmaVersion: version, ...p }))).returning();
}

export async function loadExactDesign(db: Db, projectId: string): Promise<ExactDesignView> {
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  const empty = { imported: false, figmaVersion: null, confirmed: false, pages: [], mobileFrames: 0, toBuild: 0, estimate: { cost: 0, label: "" }, perPage: { cost: 0, label: "" }, working: false, mobileToMake: 0, mobileEstimate: { cost: 0, label: "" }, mobileWorking: false, approvalProblems: [], approved: null };
  if (!figma || figma.importStatus !== "done" || !figma.importedVersion) return empty;
  const frames = (figma.frames as ImportedFrame[] | null) ?? [];
  const rows = await pagesFor(db, projectId, figma);
  const copies = await db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.projectId, projectId), eq(designCopy.figmaVersion, figma.importedVersion)))
    .orderBy(desc(designCopy.createdAt));
  const positions = await queuePositions(db, copies.filter((c) => c.status === "queued").map((c) => ({ id: c.id, createdAt: c.createdAt })));
  const signed = new Map<string, string>();
  for (const c of copies) if (c.mobilePngKey) signed.set(c.id, await getStorage().signDownload(c.mobilePngKey, "phone.png"));
  const pages: ExactPageView[] = rows.map((r) => {
    const copy = copies.find((c) => c.frameId === r.frameId);
    const fidelity = (copy?.fidelity as Fidelity | null) ?? null;
    const lowest = fidelity?.sections.length ? [...fidelity.sections].sort((a, b) => a.score - b.score)[0]! : null;
    return {
      id: r.id,
      frameId: r.frameId,
      frameName: r.frameName,
      name: r.name,
      slug: r.slug,
      isHome: r.isHome,
      mobileFrameName: frames.find((f) => f.id === r.mobileFrameId)?.name ?? null,
      copy: copy
        ? {
            id: copy.id,
            status: copy.status,
            inLine: positions.get(copy.id) ?? null,
            progress: copy.status === "working" ? ((copy.progress as NonNullable<ExactPageView["copy"]>["progress"]) ?? null) : null,
            overall: fidelity?.overall ?? null,
            lowest: lowest ? { name: lowest.name, score: lowest.score } : null,
            failureReason: stillOffAdvice(figma.source, copy.failureReason),
            accepted: copy.acceptedAt ? { by: copy.acceptedByUserId, at: copy.acceptedAt, note: copy.acceptedNote ?? "" } : null,
            mobile: {
              status: copy.mobileStatus,
              from: copy.mobileFrom,
              overflow: copy.mobileOverflow,
              decision: copy.mobileDecision,
              failure: copy.mobileFailure,
              pngUrl: signed.get(copy.id) ?? null,
              problems: (((copy.checks as { phone?: { kind: string; detail: string }[] } | null)?.phone ?? []).map((p) => `${p.kind}: ${p.detail}`)),
            },
          }
        : null,
    };
  });
  const toBuild = pages.filter((p) => !p.copy || p.copy.status === "failed").length;
  const [decision] = await db
    .select()
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  const per = await estimateDesignCopy(db);
  const cost = per.cost * toBuild;
  const view: ExactDesignView = {
    imported: true,
    upload: figma.source === "upload",
    figmaVersion: figma.importedVersion,
    confirmed: rows.length > 0 && rows.every((r) => r.confirmedAt),
    pages,
    mobileFrames: frames.filter((f) => frameRole(f) === "mobile").length,
    toBuild,
    estimate: { cost, label: toBuild ? copiesLabel(per, toBuild) : "Every page is copied." },
    perPage: { cost: per.cost, label: per.label },
    working: copies.some((c) => c.status === "queued" || c.status === "working"),
    mobileToMake: mobileTodo(pages).length,
    mobileEstimate: await estimateMobile(db, mobileTodo(pages).length),
    mobileWorking: pages.some((p) => p.copy?.mobile.status === "queued" || p.copy?.mobile.status === "working"),
    approvalProblems: [],
    approved: decision ? { channel: decision.channel, clientSaid: decision.clientSaid, at: decision.createdAt } : null,
  };
  view.approvalProblems = approvalProblems(view);
  return view;
}

/*
  Where each waiting copy is in line (28 September 2026). Every kind of
  job waits in the one queue and the worker takes one at a time, so the
  queue's own waiting list says it best (1 is next); if the queue can't be
  asked, the copies waiting are counted in the order they were queued.
*/
async function queuePositions(db: Db, waiting: { id: string; createdAt: Date }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (waiting.length === 0) return out;
  try {
    const queue = getQueue();
    if (queue.getJobs) {
      const jobs = await queue.getJobs(["waiting"], 0, 999, true);
      jobs.forEach((job, i) => {
        const copyId = (job?.data as { copyId?: string } | undefined)?.copyId;
        if (copyId && job?.name === FAITHFUL_COPY_JOB && waiting.some((w) => w.id === copyId)) out.set(copyId, i + 1);
      });
      if (out.size > 0) return out;
    }
  } catch {
    // Redis unreachable: count from the database instead.
  }
  const all = await db.select({ id: designCopy.id }).from(designCopy).where(eq(designCopy.status, "queued")).orderBy(asc(designCopy.createdAt));
  all.forEach((row, i) => {
    if (waiting.some((w) => w.id === row.id)) out.set(row.id, i + 1);
  });
  return out;
}

/* Copied pages with no phone version yet (or whose phone version failed). */
function mobileTodo(pages: ExactPageView[]) {
  return pages.filter(
    (p) => p.copy && (p.copy.status === "done" || p.copy.status === "needs_cleanup") && p.copy.mobile.status !== "done" && p.copy.mobile.status !== "queued" && p.copy.mobile.status !== "working",
  );
}

async function estimateMobile(db: Db, pages: number): Promise<{ cost: number; label: string }> {
  if (pages === 0) return { cost: 0, label: "Every copied page has its phone version." };
  const config = await stepModelConfig(db, "design_mobile");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "design_mobile"));
  const per = calls.length ? calls.reduce((n, c) => n + costOf(c, config), 0) / new Set(calls.map((c) => c.runId)).size : costOf(MOBILE_GUESS, config);
  const cost = per * pages;
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${pages} page${pages === 1 ? "" : "s"}${calls.length ? ", from the phone versions so far" : " (a first guess until a real phone version has been made)"}.` };
}

export async function startMobileVersions(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "project.edit");
  await requireOptionA(ctx.db, projectId);
  const view = await loadExactDesign(ctx.db, projectId);
  if (view.mobileWorking) throw new DesignCopyError("The phone versions are already being made.");
  const todo = mobileTodo(view.pages);
  if (todo.length === 0) throw new DesignCopyError("Every copied page already has its phone version. Copy the pages first if none are copied.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: view.mobileEstimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new DesignCopyError(error.message);
    throw error;
  }
  const ids = todo.map((p) => p.copy!.id);
  await ctx.db.update(designCopy).set({ mobileStatus: "queued", mobileFailure: null }).where(inArray(designCopy.id, ids));
  try {
    for (const id of ids) await getQueue().add(DESIGN_MOBILE_JOB, { copyId: id, projectId }, { jobId: designMobileJobId(id, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(designCopy).set({ mobileStatus: null }).where(inArray(designCopy.id, ids));
    throw new DesignCopyError("The phone versions couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.mobile_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: todo.map((p) => p.name), estimate: view.mobileEstimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return ids.length;
}

/*
  Every copied page's phone version made by code (Jason, 29 September 2026),
  $0: the phone rules from the page's own layout, the shared phone header
  and footer from the home page, the phone check. Replaces any made before.
  The home page goes first (the others use its header and footer).
*/
export async function startPhonesByCode(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<number> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) assertCan(actor, "project.edit");
  await requireOptionA(ctx.db, projectId);
  const view = await loadExactDesign(ctx.db, projectId);
  if (view.mobileWorking) throw new DesignCopyError("The phone versions are already being made.");
  const pages = view.pages.filter((p) => p.copy && (p.copy.status === "done" || p.copy.status === "needs_cleanup"));
  if (!pages.some((p) => p.isHome)) throw new DesignCopyError("Copy the home page first: the phone header and footer are made from it.");
  const ids = [...pages].sort((a, b) => Number(b.isHome) - Number(a.isHome)).map((p) => p.copy!.id);
  await ctx.db.update(designCopy).set({ mobileStatus: "queued", mobileFailure: null }).where(inArray(designCopy.id, ids));
  try {
    for (const id of ids) await getQueue().add(DESIGN_MOBILE_JOB, { copyId: id, projectId, byCode: true }, { jobId: designMobileJobId(id, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(designCopy).set({ mobileStatus: null }).where(inArray(designCopy.id, ids));
    throw new DesignCopyError("The phone versions couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.mobile_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: pages.map((p) => p.name), estimate: "$0 (by code, no AI)" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return ids.length;
}

/* The designer's decision on a responsive phone version (one made without a mobile frame). */
export async function decideMobile(ctx: ServiceContext, actor: Viewer, projectId: string, copyId: string, input: { decision: "accepted" | "pushed_back"; note: string }): Promise<void> {
  assertCan(actor, "design.decide");
  const [copy] = await ctx.db.select().from(designCopy).where(and(eq(designCopy.id, copyId), eq(designCopy.projectId, projectId))).limit(1);
  if (!copy || copy.mobileStatus !== "done") throw new DesignCopyError("That page has no phone version to decide on yet.");
  if (copy.mobileFrom !== "responsive" && copy.mobileFrom !== "code") throw new DesignCopyError("This phone version follows the design's own mobile frame, so there is nothing to decide.");
  const note = input.note.trim();
  if (input.decision === "pushed_back" && note.length < 3) throw new DesignCopyError("Say what should change, so the next version gets it right.");
  await ctx.db
    .update(designCopy)
    .set({ mobileDecision: input.decision, mobileDecidedByUserId: actor.id, mobileDecidedAt: new Date(), mobileDecisionNote: note || null })
    .where(eq(designCopy.id, copy.id));
  await recordActivity(ctx.db, {
    action: "design.mobile_decided",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: copy.frameName, decision: input.decision === "accepted" ? "accepted" : "pushed back", note: note || null },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}


export async function confirmDesignPages(ctx: ServiceContext, actor: Viewer, projectId: string, input: { id: string; name: string; slug: string }[]): Promise<void> {
  assertCan(actor, "project.edit");
  await requireOptionA(ctx.db, projectId);
  const rows = await ctx.db.select().from(designPage).where(eq(designPage.projectId, projectId));
  const merged = rows.map((r) => {
    const change = input.find((i) => i.id === r.id);
    return { ...r, name: (change?.name ?? r.name).trim(), slug: r.isHome ? "" : (change?.slug ?? r.slug).trim().toLowerCase() };
  });
  const problem = checkPages(merged);
  if (problem) throw new DesignCopyError(problem);
  for (const page of merged) {
    await ctx.db.update(designPage).set({ name: page.name, slug: page.slug, confirmedByUserId: actor.id, confirmedAt: new Date() }).where(eq(designPage.id, page.id));
  }
  await recordActivity(ctx.db, {
    action: "design.pages_confirmed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: merged.map((p) => `${p.name} (/${p.slug})`) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  Page names and addresses changed after the pages were confirmed (Jason,
  29 September 2026: "editable before go-live, logged, no re-copy"). Only
  what changed is logged, before and after; the copies stay as they are.
*/
export async function renameDesignPages(ctx: ServiceContext, actor: Viewer, projectId: string, input: { id: string; name: string; slug: string }[]): Promise<number> {
  assertCan(actor, "project.edit");
  // Any design the site is built from (Lane 2, 29 September 2026), not only Option A.
  const [lane] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (lane?.lane !== "lane_2") throw new DesignCopyError("Page names come from the client's design (Lane 2).");
  const rows = await ctx.db.select().from(designPage).where(eq(designPage.projectId, projectId));
  const merged = rows.map((r) => {
    const change = input.find((i) => i.id === r.id);
    return { ...r, name: (change?.name ?? r.name).trim(), slug: r.isHome ? "" : (change?.slug ?? r.slug).trim().toLowerCase() };
  });
  const problem = checkPages(merged);
  if (problem) throw new DesignCopyError(problem);
  const changed = merged.filter((m) => {
    const was = rows.find((r) => r.id === m.id)!;
    return was.name !== m.name || was.slug !== m.slug;
  });
  for (const page of changed) await ctx.db.update(designPage).set({ name: page.name, slug: page.slug }).where(eq(designPage.id, page.id));
  if (changed.length) {
    await recordActivity(ctx.db, {
      action: "design.pages_renamed",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueBefore: { pages: changed.map((m) => {
        const was = rows.find((r) => r.id === m.id)!;
        return `${was.name} (/${was.slug})`;
      }) },
      valueAfter: { pages: changed.map((p) => `${p.name} (/${p.slug})`) },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
  return changed.length;
}

/* Every page not copied yet (or whose copy failed): one faithful copy each, queued one after another. */
/* "About $1.40 of AI for 3 pages (on Sonnet 5, sections rebuilt after a low score on Opus 5.5, ...)". */
export function copiesLabel(per: { cost: number; label: string }, pages: number): string {
  const detail = /\((.*)\)/.exec(per.label)?.[1] ?? "";
  return `About ${formatCost(per.cost * pages)} of AI for ${pages} page${pages === 1 ? "" : "s"}${detail ? ` (${detail})` : ""}.`;
}

/*
  Accept a copy as it is (Jason, 28 September 2026): a copy that still
  differs in places after its rebuild can be accepted by the PM, the
  designer or an admin, with an optional note of why; logged. It then counts as done
  (the approval and the build go ahead).
*/
export async function acceptCopy(ctx: ServiceContext, actor: Viewer, projectId: string, copyId: string, note: string): Promise<void> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) throw new PermissionError("design.decide");
  // The note is optional (Jason, 28 September 2026).
  const why = note.trim();
  const [copy] = await ctx.db.select().from(designCopy).where(and(eq(designCopy.id, copyId), eq(designCopy.projectId, projectId))).limit(1);
  if (!copy) throw new DesignCopyError("That copy is no longer there.");
  if (copy.status !== "needs_cleanup" && copy.status !== "done") throw new DesignCopyError("Only a finished copy can be accepted.");
  await ctx.db
    .update(designCopy)
    .set({ status: "done", acceptedByUserId: actor.id, acceptedAt: new Date(), acceptedNote: why ? why.slice(0, 1000) : null })
    .where(eq(designCopy.id, copyId));
  await recordActivity(ctx.db, {
    action: "design.copy_accepted",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { page: copy.frameName, status: copy.status, reason: copy.failureReason },
    valueAfter: { page: copy.frameName, status: "done", ...(why ? { note: why } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function startExactCopies(ctx: ServiceContext, actor: Viewer, projectId: string, frameIds?: string[]): Promise<number> {
  assertCan(actor, "project.edit");
  await requireOptionA(ctx.db, projectId);
  const view = await loadExactDesign(ctx.db, projectId);
  if (!view.imported) throw new DesignCopyError("Import or upload the design first.");
  if (!view.confirmed) throw new DesignCopyError("Confirm the pages first: their names and addresses become the site's.");
  if (view.working) throw new DesignCopyError("The pages are already being copied.");
  const waiting = view.pages.filter((p) => !p.copy || p.copy.status === "failed");
  if (waiting.length === 0) throw new DesignCopyError("Every page is already copied.");
  // The pages the PM ticked (27 September 2026: the home page first, then the rest).
  const todo = frameIds ? waiting.filter((p) => frameIds.includes(p.frameId)) : waiting;
  if (todo.length === 0) throw new DesignCopyError("Choose at least one page to copy.");
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: view.perPage.cost * todo.length });
  } catch (error) {
    if (error instanceof SpendError) throw new DesignCopyError(error.message);
    throw error;
  }
  const ids: string[] = [];
  for (const page of todo) {
    const [copy] = await ctx.db.insert(designCopy).values({ projectId, figmaVersion: view.figmaVersion!, frameId: page.frameId, frameName: page.frameName, startedByUserId: actor.id }).returning({ id: designCopy.id });
    ids.push(copy!.id);
  }
  try {
    for (const id of ids) await getQueue().add(FAITHFUL_COPY_JOB, { copyId: id, projectId }, { jobId: faithfulCopyJobId(id), attempts: 1 });
  } catch {
    await ctx.db.delete(designCopy).where(inArray(designCopy.id, ids));
    throw new DesignCopyError("The copies couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "design.exact_copies_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: todo.map((p) => p.name), estimate: copiesLabel(view.perPage, todo.length) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return ids.length;
}

/*
  3c: the approved design, recorded. The client approved this design before
  TAWD had it (that is Option A), so the PM records how that approval came
  in, the way a mockup decision is recorded. Its homepage copy becomes the
  approved concept (the design system the extra pages and the client's
  DESIGN.md are made from); the site is then built from the copies exactly.
*/
export function approvalProblems(view: ExactDesignView): string[] {
  const problems: string[] = [];
  if (!view.imported) return ["Import or upload the design first."];
  if (!view.confirmed) problems.push("Confirm the pages.");
  for (const page of view.pages) {
    const copy = page.copy;
    if (!copy || copy.status === "queued" || copy.status === "working") problems.push(`${page.name}: not copied yet.`);
    else if (copy.status === "failed") problems.push(`${page.name}: the copy failed; copy it again.`);
    else if (copy.status === "needs_cleanup")
      problems.push(
        view.upload
          ? `${page.name}: some sections still differ from the design; compare them, then accept the copy as it is or copy it again.`
          : `${page.name}: the copy still differs from the design; clean the frame in Figma, then import again, or accept the copy as it is.`,
      );
    else if (copy.mobile.status !== "done") problems.push(`${page.name}: no phone version yet.`);
    else if (copy.mobile.from === "responsive" && copy.mobile.decision !== "accepted") problems.push(`${page.name}: the designer hasn't accepted the responsive phone version.`);
    // Pushed back, whoever made it (by code too): it waits for a new phone version (13 October 2026, the whole-code review).
    else if (copy.mobile.decision === "pushed_back") problems.push(`${page.name}: the designer pushed back the phone version; make a new one first.`);
  }
  return problems;
}

export async function approveExactDesign(ctx: ServiceContext, actor: Viewer, projectId: string, input: { channel: string; clientSaid: string }): Promise<void> {
  assertCan(actor, "project.edit");
  assertCan(actor, "project.change_status");
  await requireOptionA(ctx.db, projectId);
  if (!(CHANNELS as readonly string[]).includes(input.channel)) throw new DesignCopyError("Choose how the client's approval came in.");
  const said = input.clientSaid.trim();
  if (said.length < 3) throw new DesignCopyError("Write down what the client said when they approved the design.");
  const view = await loadExactDesign(ctx.db, projectId);
  const problems = approvalProblems(view);
  if (problems.length) throw new DesignCopyError(`Not ready yet: ${problems.join(" ")}`);
  const home = view.pages.find((p) => p.isHome)!;
  const [homeCopy] = await ctx.db.select().from(designCopy).where(eq(designCopy.id, home.copy!.id)).limit(1);
  if (!homeCopy?.htmlKey) throw new DesignCopyError("The homepage's copy is missing. Copy it again.");

  const [run] = await ctx.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 1, status: "succeeded", startedByUserId: actor.id, model: DESIGNER_CONCEPT, finishedAt: new Date() })
    .returning({ id: mockupRun.id });
  const [picked] = await ctx.db
    .insert(concept)
    .values({ runId: run!.id, projectId, label: "1", direction: DESIGNER_CONCEPT, skillId: DESIGNER_CONCEPT, status: "ready" })
    .returning({ id: concept.id });
  await ctx.db.insert(conceptVersion).values({
    conceptId: picked!.id,
    version: 1,
    htmlKey: homeCopy.htmlKey,
    pngKey: homeCopy.pngKey,
    checks: { ...((homeCopy.checks as Record<string, unknown> | null) ?? {}), stage: "exact" },
    summary: "The client-approved design, built exactly",
  });
  await ctx.db.insert(clientDecision).values({
    projectId,
    conceptId: picked!.id,
    version: 1,
    channel: input.channel,
    changesRequested: false,
    clientSaid: said.slice(0, 4000),
    recordedByUserId: actor.id,
  });
  const [before] = await ctx.db.select({ status: project.status }).from(project).where(eq(project.id, projectId)).limit(1);
  // The design's words are the approved copy, so the project goes straight to Build.
  await ctx.db.update(project).set({ status: "build", updatedAt: new Date() }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "design.exact_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: view.pages.map((p) => p.name), channel: input.channel, clientSaid: said.slice(0, 1000) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  await recordActivity(ctx.db, {
    action: "project.status_changed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { status: before?.status ?? null },
    valueAfter: { status: "build", reason: "The client-approved design, copied exactly" },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  // The client's DESIGN.md, from the approved homepage. A failure never undoes the approval.
  try {
    await makeClientDesignDoc(ctx, actor, projectId);
  } catch (error) {
    await recordActivity(ctx.db, {
      action: "design_md.failed",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueAfter: { reason: error instanceof Error ? error.message : "unknown" },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
}
