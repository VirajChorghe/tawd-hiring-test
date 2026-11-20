import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { callCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, devTime, editPage, editRequest, pagePlanPage, project, siteBuild, updateQuote } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { SITE_EDIT_JOB, siteEditJobId } from "@tawd/core/queue";
import { costOf, formatCost, getModelConfig } from "@tawd/core/mockups";
import { hoursStanding, trackedChanges, type RequestKind } from "@tawd/core/site";
import { getStorage } from "@tawd/core/intake/storage";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import { SiteError, startSiteBuild } from "@/lib/site-builds";
import { pacificToday } from "@/lib/spend-report";
import { includedHoursFor } from "@/lib/updates";
import type { ServiceContext } from "@/lib/users";

/*
  Build A, 8c (26 September 2026): the monthly edits and the 8 dev hours.

  A request is logged with the client's words and when they asked, as an
  edit (TAWD makes it) or a quote (a new page or a redesign, priced
  separately). An edit is made page by page by AI on the live build's own
  source (estimate first, AI limit checked), shown as tracked changes,
  then rebuilt into the site with no AI, previewed and approved as usual.
  The team logs its time against the request; the month's hours show
  against the 8 the plan includes, with each request's AI cost.
*/

type Db = Database;

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

/** A first guess per page until real edits have run: the design system is cached, the page itself is sent and returned. */
export const SITE_EDIT_GUESS = { inputTokens: 9_000, outputTokens: 7_000, cacheReadTokens: 25_000 };

export async function estimateEdit(db: Db, pages: number): Promise<{ cost: number; label: string }> {
  const config = await stepModelConfig(db, "site_edit");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "site_edit"));
  const firsts = calls.filter((c) => (c.round ?? 1) === 1).length;
  const perPage = firsts ? calls.reduce((sum, c) => sum + costOf(c, config), 0) / firsts : costOf({ ...SITE_EDIT_GUESS, cacheWriteTokens: 0 }, config);
  const cost = perPage * pages;
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${pages} page${pages === 1 ? "" : "s"}${firsts ? ", from the edits so far" : " (a first guess until a real edit has run)"}.` };
}

export async function createEditRequest(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { kind: RequestKind; clientWords: string; teamNote: string; requestedOn: string; pageIds: string[] },
): Promise<string> {
  assertCan(actor, "project.edit");
  const words = input.clientWords.trim();
  if (words.length < 5) throw new EditError("Write down what the client asked for, in their words.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedOn)) throw new EditError("Give the day the client asked.");
  const pages = await ctx.db.select({ id: pagePlanPage.id }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
  const pageIds = input.pageIds.filter((id) => pages.some((p) => p.id === id));
  if (input.kind === "edit" && pageIds.length === 0) throw new EditError("Choose the page or pages the edit is on.");
  const [row] = await ctx.db
    .insert(editRequest)
    .values({
      projectId,
      kind: input.kind,
      clientWords: words.slice(0, 4000),
      teamNote: input.teamNote.trim().slice(0, 2000),
      requestedOn: input.requestedOn,
      pageIds,
      status: input.kind === "quote" ? "quoted" : "open",
      createdByUserId: actor.id,
    })
    .returning({ id: editRequest.id });
  await recordActivity(ctx.db, {
    action: "site.edit_requested",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { kind: input.kind, request: words.slice(0, 500), requestedOn: input.requestedOn, pages: pageIds.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return row!.id;
}

async function requestOf(db: Db, projectId: string, requestId: string) {
  const [row] = await db.select().from(editRequest).where(and(eq(editRequest.id, requestId), eq(editRequest.projectId, projectId))).limit(1);
  if (!row) throw new EditError("That request is no longer here.");
  return row;
}

/* Makes the edit with AI, page by page, on the latest finished build. Paid: the estimate was shown first. */
export async function startEdit(ctx: ServiceContext, actor: Viewer, projectId: string, requestId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const request = await requestOf(ctx.db, projectId, requestId);
  const [waiting] = await ctx.db.select({ id: updateQuote.id }).from(updateQuote).where(and(eq(updateQuote.requestId, request.id), eq(updateQuote.status, "waiting"))).limit(1);
  if (waiting) throw new EditError("Waiting on the client's approval of the quote.");
  if (request.kind !== "edit") throw new EditError("This request is a quote: new pages and redesigns are priced separately.");
  // Sites built from the client's design (Lane 2) are updated by hand for now: the AI edit hasn't been checked on them (1 October 2026).
  const [row] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (row?.lane === "lane_2") throw new EditError("Sites built from the client's design are updated by hand for now: make the change, log the time, then mark it done.");
  if (!["open", "failed", "edited"].includes(request.status)) throw new EditError("This edit is already under way or done.");
  const [base] = await ctx.db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  if (!base) throw new EditError("There is no built site to edit yet.");
  // The spend check uses the same estimate the person was shown: the request's pages, not the pages edited so far (13 October
  // 2026, the whole-code review: it counted one page).
  const estimate = await estimateEdit(ctx.db, request.pageIds.length);
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: (request.pageIds.length ? estimate : await estimateEdit(ctx.db, 1)).cost });
  } catch (error) {
    if (error instanceof SpendError) throw new EditError(error.message);
    throw error;
  }
  // Only from a state an edit can start in, in one step: a second click finds it queued (13 October 2026, the whole-code review).
  const [claimed] = await ctx.db
    .update(editRequest)
    .set({ status: "queued", baseBuildId: base.id, failureReason: null })
    .where(and(eq(editRequest.id, request.id), inArray(editRequest.status, ["open", "failed", "edited"])))
    .returning({ id: editRequest.id });
  if (!claimed) throw new EditError("This edit is already under way or done.");
  try {
    await getQueue().add(SITE_EDIT_JOB, { requestId: request.id, projectId }, { jobId: `${siteEditJobId(request.id)}-${Date.now()}`, attempts: 1 });
  } catch {
    await ctx.db.update(editRequest).set({ status: request.status }).where(eq(editRequest.id, request.id));
    throw new EditError("The edit couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "site.edit_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { request: request.clientWords.slice(0, 300), pages: request.pageIds.length, baseVersion: base.version, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Puts a made edit into a new build of the site: the saved pages with the edited ones swapped in. Free. */
export async function rebuildWithEdit(ctx: ServiceContext, actor: Viewer, projectId: string, requestId: string): Promise<void> {
  const request = await requestOf(ctx.db, projectId, requestId);
  if (request.status !== "edited") throw new EditError("Make the edit first, then put it into the site.");
  try {
    await startSiteBuild(ctx, actor, projectId, { editRequestId: request.id });
  } catch (error) {
    if (error instanceof SiteError) throw new EditError(error.message);
    throw error;
  }
}

export async function closeEditRequest(ctx: ServiceContext, actor: Viewer, projectId: string, requestId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const request = await requestOf(ctx.db, projectId, requestId);
  if (request.status === "done") return;
  await ctx.db.update(editRequest).set({ status: "done", closedAt: new Date() }).where(eq(editRequest.id, request.id));
  await recordActivity(ctx.db, {
    action: "site.edit_closed",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { request: request.clientWords.slice(0, 300), kind: request.kind },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The team's time, against a request or the month in general. Logged. */
export async function logDevTime(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { requestId: string | null; minutes: number; note: string; workedOn: string },
): Promise<void> {
  assertCan(actor, "project.edit");
  const minutes = Math.round(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) throw new EditError("Log between 1 minute and 10 hours at a time.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workedOn)) throw new EditError("Give the day the work was done.");
  if (input.requestId) await requestOf(ctx.db, projectId, input.requestId);
  await ctx.db.insert(devTime).values({ projectId, requestId: input.requestId, minutes, note: input.note.trim().slice(0, 500), workedOn: input.workedOn, userId: actor.id });
  await recordActivity(ctx.db, {
    action: "site.time_logged",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { minutes, workedOn: input.workedOn, note: input.note.trim().slice(0, 200), requestId: input.requestId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- the hours ---------- */

function monthRange(now: Date): { from: string; to: string } {
  const today = pacificToday(now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

/* Minutes logged this month (Pacific), per project. */
export async function monthMinutesByProject(db: Db, now = new Date()): Promise<Map<string, number>> {
  const { from, to } = monthRange(now);
  const rows = await db
    .select({ projectId: devTime.projectId, minutes: sql<number>`sum(${devTime.minutes})` })
    .from(devTime)
    .where(and(gte(devTime.workedOn, from), lte(devTime.workedOn, to)))
    .groupBy(devTime.projectId);
  return new Map(rows.map((r) => [r.projectId, Number(r.minutes)]));
}

export async function projectHours(db: Db, projectId: string, now = new Date()) {
  return hoursStanding((await monthMinutesByProject(db, now)).get(projectId) ?? 0, await includedHoursFor(db, projectId));
}

export async function loadEdits(db: Db, projectId: string, now = new Date()) {
  const requests = await db.select().from(editRequest).where(eq(editRequest.projectId, projectId)).orderBy(desc(editRequest.createdAt));
  const ids = requests.map((r) => r.id);
  const pages = ids.length ? await db.select().from(editPage).where(inArray(editPage.requestId, ids)).orderBy(asc(editPage.createdAt)) : [];
  const times = ids.length ? await db.select().from(devTime).where(inArray(devTime.requestId, ids)) : [];
  const calls = ids.length ? await db.select().from(aiCall).where(inArray(aiCall.runId, ids)) : [];
  const config = getModelConfig();
  const storage = getStorage();
  const withChanges = await Promise.all(
    pages.map(async (p) => {
      const [before, after] = await Promise.all([storage.get(p.beforeKey), storage.get(p.afterKey)]);
      return { ...p, changes: before && after ? trackedChanges(before.toString("utf8"), after.toString("utf8")) : { removed: [], added: [] } };
    }),
  );
  return {
    hours: await projectHours(db, projectId, now),
    requests: requests.map((r) => ({
      ...r,
      pages: withChanges.filter((p) => p.requestId === r.id),
      minutes: times.filter((t) => t.requestId === r.id).reduce((sum, t) => sum + t.minutes, 0),
      aiCost: calls.filter((c) => c.runId === r.id).reduce((sum, c) => sum + callCost(c, config), 0),
    })),
    estimate: (pages: number) => estimateEdit(db, pages),
  };
}
