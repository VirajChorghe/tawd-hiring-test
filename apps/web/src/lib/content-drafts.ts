import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { aiCall, contentDecision, pageComment, pageDraft, pagePlanPage, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { CONTENT_DRAFT_JOB, contentDraftJobId } from "@tawd/core/queue";
import { costOf, formatCost } from "@tawd/core/mockups";
import { PLACEHOLDER_RE, analyzeDraft, draftBlockText, healthContextFrom, isHealthProject, parseDraft, type DraftBlock } from "@tawd/core/content";
import { loadIntake } from "@tawd/core/intake/service";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { getQueue } from "@/lib/mockups";
import { getProject, updateProject } from "@/lib/projects";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";
import { KEPT_SOURCE, projectTypeFor, usesSuppliedHome } from "@tawd/core/site-read";
import { ImproveError, improveCompare, startImprove } from "@/lib/content-improve";

/*
  Page drafts and the content review (Phase 7b, 26 September 2026).

  Drafting is paid AI (one call per page, in the worker): the estimate
  shows first, the monthly AI limit is checked, and every answer is saved
  before it is read. Editing, comments and approval are free. Content
  approves each page (one version: a newer version needs approving
  again); then the PM sends the client the copy pack and records the
  client's decision, as with the mockups. The AI-writing score from
  Originality.ai is information for the team, never a gate.
*/

type Db = Database;

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentError";
  }
}

/** A first guess for one page, until real drafts have run. */
export const DRAFT_GUESS = { inputTokens: 7_000, outputTokens: 2_500 };
export const AI_FLAG_PERCENT = 30;

export async function estimateDraft(db: Db): Promise<{ perPage: number; measured: boolean; model: string }> {
  const config = await stepModelConfig(db, "content_draft");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "content_draft"));
  const byDraft = new Map<string, number>();
  for (const call of calls) byDraft.set(call.runId, (byDraft.get(call.runId) ?? 0) + costOf(call, config));
  if (byDraft.size > 0) return { perPage: [...byDraft.values()].reduce((a, b) => a + b, 0) / byDraft.size, measured: true, model: config.model };
  return { perPage: costOf(DRAFT_GUESS, config), measured: false, model: config.model };
}

export function estimateLabel(estimate: { perPage: number; measured: boolean; model?: string }, pages: number): string {
  return `About ${formatCost(estimate.perPage * pages)} of AI${estimate.model ? ` on ${modelLabel(estimate.model)}` : ""} for ${pages} page${pages === 1 ? "" : "s"}${estimate.measured ? ", from the drafts so far" : " (a first guess until a real draft has run)"}.`;
}

async function withinLimit(db: Db, cap: { projectId: string; estimate: number }): Promise<void> {
  try {
    await assertWithinMonthlyLimit(db, cap);
  } catch (error) {
    if (error instanceof SpendError) throw new ContentError(error.message);
    throw error;
  }
}

async function latestVersions(db: Db, pageIds: string[]) {
  if (pageIds.length === 0) return new Map<string, typeof pageDraft.$inferSelect>();
  const rows = await db.select().from(pageDraft).where(inArray(pageDraft.pageId, pageIds)).orderBy(desc(pageDraft.version));
  const latest = new Map<string, typeof pageDraft.$inferSelect>();
  for (const row of rows) if (!latest.has(row.pageId)) latest.set(row.pageId, row);
  return latest;
}

async function queueDraft(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, version: number, source: "draft" | "redraft", note: string | null) {
  const [draft] = await ctx.db
    .insert(pageDraft)
    .values({ projectId, pageId, version, source, status: "queued", note, createdByUserId: actor.id })
    .returning({ id: pageDraft.id });
  try {
    await getQueue().add(CONTENT_DRAFT_JOB, { draftId: draft!.id, projectId }, { jobId: contentDraftJobId(draft!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(pageDraft).where(eq(pageDraft.id, draft!.id));
    throw new ContentError("The drafts couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  return draft!.id;
}

/* Drafts every page in the plan that has no draft yet (or whose last draft failed). Paid: the estimate was shown first. */
/*
  Since 28 September 2026 the team chooses which pages to draft now (the
  home page first, say) and can give the writer a direction for the batch;
  Slack says when they are ready for Content's review (the worker).
*/
export async function startDrafts(ctx: ServiceContext, actor: Viewer, projectId: string, options: { pageIds?: string[]; direction?: string } = {}): Promise<number> {
  assertCan(actor, "content.plan");
  const pages = await ctx.db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  if (pages.length === 0) throw new ContentError("Make the page plan first: drafts are written page by page from it.");
  const latest = await latestVersions(ctx.db, pages.map((p) => p.id));
  // A page with the current site's words is never drafted from the intake (0.100.0): it's improved, or kept.
  const keptPages = new Set((await ctx.db.select({ pageId: pageDraft.pageId }).from(pageDraft).where(and(inArray(pageDraft.pageId, pages.map((p) => p.id)), eq(pageDraft.source, KEPT_SOURCE)))).map((d) => d.pageId));
  // A supplied homepage keeps its own words: its home page is never drafted (the words would be paid for and thrown away).
  const suppliedHome = await usesSuppliedHome(ctx.db, projectId);
  const waiting = pages.filter((p) => {
    const last = latest.get(p.id);
    return !(suppliedHome && p.kind === "home") && !keptPages.has(p.id) && (!last || (last.status === "failed" && !last.body));
  });
  if (waiting.length === 0) throw new ContentError("Every page already has a draft. Use Request a redraft on a page to write it again.");
  const todo = options.pageIds ? waiting.filter((p) => options.pageIds!.includes(p.id)) : waiting;
  if (todo.length === 0) throw new ContentError("Choose at least one page to draft.");
  const direction = options.direction?.trim().slice(0, 1000) || null;
  const estimate = await estimateDraft(ctx.db);
  await withinLimit(ctx.db, { projectId, estimate: estimate.perPage * todo.length });
  for (const page of todo) await queueDraft(ctx, actor, projectId, page.id, (latest.get(page.id)?.version ?? 0) + 1, "draft", direction);
  await recordActivity(ctx.db, {
    action: "content.drafts_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: todo.map((p) => p.name), estimate: estimateLabel(estimate, todo.length), ...(direction ? { direction } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return todo.length;
}

async function pageOf(db: Db, projectId: string, pageId: string) {
  const [page] = await db.select().from(pagePlanPage).where(and(eq(pagePlanPage.id, pageId), eq(pagePlanPage.projectId, projectId))).limit(1);
  if (!page) throw new ContentError("That page is no longer in the plan.");
  return page;
}

/* Re-runs one page with the team's note. Paid: the estimate was shown first. */
export async function requestRedraft(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, note: string): Promise<void> {
  assertCan(actor, "content.plan");
  const page = await pageOf(ctx.db, projectId, pageId);
  const text = note.trim();
  if (text.length < 5) throw new ContentError("Say what the new draft should change (a few words).");
  const last = (await latestVersions(ctx.db, [pageId])).get(pageId);
  if (last && (last.status === "queued" || last.status === "working")) throw new ContentError("This page is already being drafted.");
  // Design + content (0.100.0): a page from the current site is improved again with the note, never redrafted from the intake.
  if ((await projectTypeFor(ctx.db, projectId)) === "design_content") {
    const [kept] = await ctx.db.select({ id: pageDraft.id }).from(pageDraft).where(and(eq(pageDraft.pageId, pageId), eq(pageDraft.source, KEPT_SOURCE))).limit(1);
    if (kept) {
      try {
        await startImprove(ctx, actor, projectId, { pageIds: [pageId], note: text });
      } catch (error) {
        if (error instanceof ImproveError) throw new ContentError(error.message);
        throw error;
      }
      return;
    }
  }
  const estimate = await estimateDraft(ctx.db);
  await withinLimit(ctx.db, { projectId, estimate: estimate.perPage });
  const version = (last?.version ?? 0) + 1;
  await queueDraft(ctx, actor, projectId, pageId, version, "redraft", text.slice(0, 2000));
  await recordActivity(ctx.db, {
    action: "content.redraft_requested",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version, note: text.slice(0, 2000), estimate: estimateLabel(estimate, 1) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* An editor's change in place: a new version, free, needing approval again. */
export async function saveDraftEdit(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, body: string): Promise<number> {
  assertCan(actor, "content.plan");
  const page = await pageOf(ctx.db, projectId, pageId);
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!/^# \S/m.test(text)) throw new ContentError("Keep the H1: a line starting with \"# \".");
  const last = (await latestVersions(ctx.db, [pageId])).get(pageId);
  if (last && (last.status === "queued" || last.status === "working")) throw new ContentError("Wait for the draft that is being written, then edit it.");
  if (last?.body?.trim() === text) return last.version;
  const version = (last?.version ?? 0) + 1;
  await ctx.db.insert(pageDraft).values({ projectId, pageId, version, source: "edit", status: "done", body: `${text}\n`, createdByUserId: actor.id, finishedAt: new Date() });
  await recordActivity(ctx.db, {
    action: "content.page_edited",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return version;
}

/* Content approves the latest version of one page. Logged with the version. */
export async function approvePage(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string): Promise<void> {
  assertCan(actor, "content.approve");
  const page = await pageOf(ctx.db, projectId, pageId);
  const last = (await latestVersions(ctx.db, [pageId])).get(pageId);
  if (!last || last.status !== "done" || !last.body) throw new ContentError("There is no finished draft of this page to approve.");
  if (last.approvedAt) return;
  await ctx.db.update(pageDraft).set({ approvedByUserId: actor.id, approvedAt: new Date() }).where(eq(pageDraft.id, last.id));
  await recordActivity(ctx.db, {
    action: "content.page_approved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version: last.version, placeholders: (last.body.match(PLACEHOLDER_RE) ?? []).length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function addPageComment(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string, body: string): Promise<void> {
  assertCan(actor, "content.plan");
  const page = await pageOf(ctx.db, projectId, pageId);
  const text = body.trim();
  if (!text) throw new ContentError("Write the comment first.");
  const last = (await latestVersions(ctx.db, [pageId])).get(pageId);
  await ctx.db.insert(pageComment).values({ projectId, pageId, version: last?.version ?? 0, authorUserId: actor.id, body: text.slice(0, 4000) });
  await recordActivity(ctx.db, {
    action: "content.comment_added",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version: last?.version ?? 0, comment: text.slice(0, 500) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export async function resolvePageComment(ctx: ServiceContext, actor: Viewer, projectId: string, commentId: string): Promise<void> {
  assertCan(actor, "content.plan");
  const [comment] = await ctx.db.select().from(pageComment).where(and(eq(pageComment.id, commentId), eq(pageComment.projectId, projectId))).limit(1);
  if (!comment || comment.resolvedAt) return;
  await ctx.db.update(pageComment).set({ resolvedByUserId: actor.id, resolvedAt: new Date() }).where(eq(pageComment.id, commentId));
  await recordActivity(ctx.db, {
    action: "content.comment_resolved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { comment: comment.body.slice(0, 200) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- the AI-writing check (Originality.ai) ---------- */

type Fetch = typeof fetch;
let originalityFetch: Fetch | null = null;

/** Tests pass a stand-in; nothing in the tests reaches Originality.ai. */
export function setOriginalityFetchForTesting(stand: Fetch | null): void {
  originalityFetch = stand;
}

export function originalitySetup(): { configured: boolean } {
  return { configured: Boolean(process.env.ORIGINALITY_API_KEY?.trim()) };
}

/* Originality.ai charges about one credit per 100 words. */
export function originalityCredits(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 100));
}

/*
  Scores the latest version for how machine-written it reads. Information
  only: a score over 30% is flagged for the editor, never blocks approval.
  The key is sent to Originality.ai only; the page text goes with it.
*/
export async function checkAiWriting(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string): Promise<number> {
  assertCan(actor, "content.plan");
  const page = await pageOf(ctx.db, projectId, pageId);
  if (!originalitySetup().configured) throw new ContentError("The AI-writing check isn't set up yet: an admin adds ORIGINALITY_API_KEY in Coolify.");
  const last = (await latestVersions(ctx.db, [pageId])).get(pageId);
  if (!last?.body || last.status !== "done") throw new ContentError("There is no finished draft of this page to check.");
  const plain = parseDraft(last.body).map(draftBlockText).join("\n\n");
  let score: number;
  try {
    const response = await (originalityFetch ?? fetch)("https://api.originality.ai/api/v1/scan/ai", {
      method: "POST",
      headers: { "X-OAI-API-KEY": process.env.ORIGINALITY_API_KEY!.trim(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ content: plain, title: page.name, aiModelVersion: "1", storeScan: "false" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401 || response.status === 403) throw new ContentError("Originality.ai refused the key. Check ORIGINALITY_API_KEY in Coolify.");
    if (!response.ok) throw new ContentError(`Originality.ai answered ${response.status}.`);
    const answer = (await response.json()) as { score?: { ai?: number } };
    if (typeof answer.score?.ai !== "number") throw new ContentError("Originality.ai's answer had no score.");
    score = Math.round(answer.score.ai * 1000) / 10;
  } catch (error) {
    const reason = error instanceof ContentError ? error.message : "The AI-writing check didn't answer. Try again later.";
    await ctx.db.update(pageDraft).set({ aiScoreError: reason, aiScoreCheckedAt: new Date() }).where(eq(pageDraft.id, last.id));
    throw new ContentError(reason);
  }
  await ctx.db.update(pageDraft).set({ aiScore: score, aiScoreError: null, aiScoreCheckedAt: new Date() }).where(eq(pageDraft.id, last.id));
  await recordActivity(ctx.db, {
    action: "content.ai_checked",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version: last.version, aiPercent: score, flagged: score > AI_FLAG_PERCENT },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return score;
}

/* ---------- what the screens show ---------- */

export type PageState = "not_drafted" | "drafting" | "failed" | "ready" | "approved";

export async function loadDraftsOverview(db: Db, projectId: string) {
  /*
    A supplied homepage (the client approved the HTML file the team supplied)
    keeps its own words as the home page (Build A, site-build.ts), so the home
    page is not part of Content's work: not drafted, not approved, not in the
    copy pack. `suppliedHome` tells the screen to say so.
  */
  const suppliedHome = await usesSuppliedHome(db, projectId);
  const planned = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  const pages = planned.filter((p) => !(suppliedHome && p.kind === "home"));
  const latest = await latestVersions(db, pages.map((p) => p.id));
  const comments = pages.length ? await db.select().from(pageComment).where(and(inArray(pageComment.pageId, pages.map((p) => p.id)), isNull(pageComment.resolvedAt))) : [];
  const rows = pages.map((page) => {
    const last = latest.get(page.id) ?? null;
    const state: PageState = !last
      ? "not_drafted"
      : last.status === "queued" || last.status === "working"
        ? "drafting"
        : last.status === "failed"
          ? "failed"
          : last.approvedAt
            ? "approved"
            : "ready";
    return {
      page,
      last,
      state,
      openComments: comments.filter((c) => c.pageId === page.id).length,
      placeholders: last?.body ? [...new Set(last.body.match(PLACEHOLDER_RE) ?? [])].length : 0,
    };
  });
  const [decision] = await db.select().from(contentDecision).where(eq(contentDecision.projectId, projectId)).orderBy(desc(contentDecision.createdAt)).limit(1);
  const undrafted = rows.filter((r) => r.state === "not_drafted" || (r.state === "failed" && !r.last?.body)).length;
  return {
    rows,
    suppliedHome,
    undrafted,
    approved: rows.filter((r) => r.state === "approved").length,
    drafting: rows.some((r) => r.state === "drafting"),
    allApproved: rows.length > 0 && rows.every((r) => r.state === "approved"),
    /*
      A plan whose only page is the supplied home page: that page is not drafted, so there are no rows, and with none "every
      page approved" could never become true (no copy pack, no decision, Build locked for good). There is simply no copy for
      the client to approve: they approved the page itself when they approved the concept. So Content has nothing left to do.
    */
    nothingToApprove: suppliedHome && rows.length === 0 && planned.length > 0,
    estimate: await estimateDraft(db),
    decision: decision ?? null,
  };
}

/* A health, beauty or medical project's rules for the draft checks, or null for any other project. */
async function healthFor(db: Db, projectId: string) {
  const [row] = await db.select({ trade: project.trade }).from(project).where(eq(project.id, projectId)).limit(1);
  const intake = await loadIntake(db as Database, SYSTEM_ACTOR, projectId);
  return row && intake && isHealthProject(row.trade, intake.data) ? healthContextFrom(intake.data) : null;
}

export async function loadPageReview(db: Db, projectId: string, pageId: string) {
  const [page] = await db.select().from(pagePlanPage).where(and(eq(pagePlanPage.id, pageId), eq(pagePlanPage.projectId, projectId))).limit(1);
  if (!page) return null;
  const versions = await db.select().from(pageDraft).where(eq(pageDraft.pageId, pageId)).orderBy(desc(pageDraft.version));
  const current = versions[0] ?? null;
  const lastBody = versions.find((v) => v.body) ?? null;
  const comments = await db.select().from(pageComment).where(eq(pageComment.pageId, pageId)).orderBy(asc(pageComment.createdAt));
  return {
    page,
    versions,
    current,
    shown: lastBody,
    // Design + content (0.100.0): the shown version against the current site's words, with the facts check.
    compare: await improveCompare(db, projectId, versions, lastBody),
    analysis: lastBody?.body ? analyzeDraft(lastBody.body, page, await healthFor(db, projectId)) : null,
    comments,
    estimate: await estimateDraft(db),
    originality: originalitySetup(),
  };
}

/* ---------- the copy pack and the client's decision ---------- */

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* A draft as HTML, placeholders highlighted, for the review screen and the copy pack. */
export function draftHtml(blocks: DraftBlock[]): string {
  // Links in kept pages ([text](/path/)) show as their words, underlined, with the path on hover; never followed from here.
  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/\[PLACEHOLDER:[^\]]*\]/gi, (m) => `<mark class="placeholder">${m}</mark>`)
      .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, words: string, href: string) => `<span class="draft-link" title="${href}">${words}</span>`);
  return blocks
    .map((b) => {
      if (b.type === "ul" || b.type === "ol") return `<${b.type}>${(b.items ?? []).map((i) => `<li>${inline(i)}</li>`).join("")}</${b.type}>`;
      if (b.type === "table") return `<table class="draft-table">${(b.rows ?? []).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table>`;
      if (b.type === "quote") return `<blockquote>${inline(b.text)}</blockquote>`;
      return `<${b.type}>${inline(b.text)}</${b.type}>`;
    })
    .join("\n");
}

/* The approved pages, one after another, as a document the PM sends the client. */
export async function buildCopyPack(db: Db, projectId: string): Promise<{ html: string; fileName: string }> {
  const overview = await loadDraftsOverview(db, projectId);
  if (overview.nothingToApprove) throw new ContentError("There is no copy pack for this site: its only page is the homepage the client already approved, and that page keeps its own words.");
  if (!overview.allApproved) throw new ContentError("Every page needs Content's approval before the copy pack can go to the client.");
  const [row] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  const name = row?.clientName ?? "Client";
  const pages = overview.rows.map(
    (r) => `<section class="page"><p class="page-label">Page ${overview.rows.indexOf(r) + 1}: ${escapeHtml(r.page.name)} <span>/${escapeHtml(r.page.slug)}</span></p>
<p class="seo"><strong>Title:</strong> ${escapeHtml(r.page.title)}<br><strong>Description:</strong> ${escapeHtml(r.page.metaDescription)}</p>
${draftHtml(parseDraft(r.last!.body!))}</section>`,
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escapeHtml(name)}: website copy for approval</title>
<style>body{font:16px/1.6 Georgia,serif;color:#18212B;max-width:760px;margin:40px auto;padding:0 24px}h1{font-size:30px;line-height:1.2}h2{font-size:22px;margin-top:28px}h3{font-size:18px}.cover{border-bottom:2px solid #205AF2;padding-bottom:16px;margin-bottom:24px;font-family:system-ui,sans-serif}.page{border-top:1px solid #DDE1E4;padding-top:24px;margin-top:40px}.page-label{font:600 13px system-ui,sans-serif;color:#5B6570;text-transform:uppercase;letter-spacing:.04em}.page-label span{text-transform:none;font-weight:400}.seo{font:13px/1.5 system-ui,sans-serif;background:#F6F8FC;border:1px solid #DDE1E4;border-radius:8px;padding:10px 12px}mark.placeholder{background:#FFF4DD;color:#6B3A00;padding:0 3px;border-radius:3px}</style></head><body>
<div class="cover"><h1>${escapeHtml(name)}</h1><p>The words for your new website, page by page, for your approval. Anything highlighted like <mark class="placeholder">[PLACEHOLDER: this]</mark> is information we still need from you. Prepared by Velocity Media Lab.</p></div>
${pages.join("\n")}
</body></html>`;
  return { html, fileName: `${name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client"}-website-copy.html` };
}

export const CHANNELS = ["phone call", "email", "meeting"] as const;

/* The PM records what the client said about the copy pack. Logged, with each page's version. */
export async function recordCopyDecision(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { outcome: "approved" | "changes_requested"; channel: string; clientSaid: string },
): Promise<void> {
  assertCan(actor, "project.edit");
  if (!(CHANNELS as readonly string[]).includes(input.channel)) throw new ContentError("Choose how the client's answer came in.");
  const said = input.clientSaid.trim();
  if (said.length < 3) throw new ContentError("Write down what the client said.");
  const overview = await loadDraftsOverview(ctx.db, projectId);
  if (overview.nothingToApprove) throw new ContentError("There is no copy for the client to decide on: the only page is the homepage they already approved. Move to Build instead.");
  if (!overview.allApproved) throw new ContentError("Every page needs Content's approval before recording the client's decision.");
  const pages = overview.rows.map((r) => ({ pageId: r.page.id, name: r.page.name, version: r.last!.version }));
  await ctx.db.insert(contentDecision).values({ projectId, outcome: input.outcome, channel: input.channel, clientSaid: said.slice(0, 4000), pages, recordedByUserId: actor.id });
  await recordActivity(ctx.db, {
    action: "content.client_decision",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { outcome: input.outcome, channel: input.channel, clientSaid: said.slice(0, 1000), pages: pages.map((p) => `${p.name} v${p.version}`) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  "Move to Build" (Jason, 26 September 2026): once the client has approved
  the copy, the project moves from Content to Build. Through updateProject,
  so the stage change is checked and logged like any other.
*/
export async function moveToBuild(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  const current = await getProject(ctx.db, actor, projectId);
  if (!current) throw new ContentError("That project no longer exists.");
  if (current.status !== "content") throw new ContentError("Only a project at Content moves to Build this way.");
  const overview = await loadDraftsOverview(ctx.db, projectId);
  const [decision] = await ctx.db.select().from(contentDecision).where(eq(contentDecision.projectId, projectId)).orderBy(desc(contentDecision.createdAt)).limit(1);
  // A Home-only plan has no copy to approve (see loadDraftsOverview): the client's approval of the homepage was the approval.
  if (!overview.nothingToApprove && decision?.outcome !== "approved") throw new ContentError("The client hasn't approved the copy yet.");
  // The copy the client approved must still be the copy (13 October 2026, the whole-code review): a page added, removed or
  // redrafted since means the client hasn't seen what would be built. A Home-only plan has none to compare.
  if (!overview.nothingToApprove) {
    const approved = new Map(((decision!.pages as { pageId: string; name: string; version: number }[]) ?? []).map((p) => [p.pageId, p.version]));
    const changed = overview.rows.filter((r) => approved.get(r.page.id) !== r.last?.version).map((r) => r.page.name);
    if (changed.length || approved.size !== overview.rows.length) {
      throw new ContentError(
        `The copy changed after the client approved it${changed.length ? ` (${changed.join(", ")})` : ""}. Record the client's decision on the current copy, then move to Build.`,
      );
    }
  }
  await updateProject(ctx, actor, projectId, {
    clientName: current.clientName,
    trade: current.trade,
    tier: current.tier,
    lane: current.lane,
    laneOption: current.laneOption,
    conceptCount: current.conceptCount,
    status: "build",
    memberUserIds: current.members.map((m) => m.id),
  });
}
