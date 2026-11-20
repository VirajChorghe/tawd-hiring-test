import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@tawd/core/db";
import { aiCall, goLive, pageApproval, pageFix, pageReviewComment, project, siteBuild } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { commentPartChanged, type ChecklistItem, type FixPartId, type PageFixCheck } from "@tawd/core/site";
import { costOf, formatCost, modelLabel } from "@tawd/core/mockups";
import { PAGE_FIX_JOB, pageFixJobId, type PageFixJobData } from "@tawd/core/queue";
import { stepModelConfig } from "@tawd/core/step-models";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { BuiltPage } from "@/lib/site-builds";

/*
  The page-by-page review (step 3a, Jason, 1 and 3 October 2026): every page
  of the latest build is opened in TAWD, commented on section by section and
  approved by a PM, the Web Designer, a founder or an admin. Go-live waits
  until every page is approved, unless a founder lets one build through.

  An approval carries over to a later build while the page's own source and
  the shared header and footer are unchanged (two hashes). When only the
  header or footer changed, "Approve all unchanged" approves those pages in
  one click.
*/

type Db = Database;
type Ctx = { db: Db; ipAddress: string | null; userAgent: string | null };

export class PageReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageReviewError";
  }
}

export interface PageState {
  pageId: string;
  name: string;
  path: string;
  /** Approved for this build (on this version or carried over), with who and on which version. */
  approved: { by: string; version: number; at: Date } | null;
  /** Approved before, and only the header or footer changed since. */
  partsChangedOnly: boolean;
  openComments: number;
}

export interface PageReviewView {
  version: number | null;
  pages: PageState[];
  approvedCount: number;
  /** A founder let this build go live before every page was approved. */
  overridden: boolean;
}

/* The latest finished build. */
async function latestDone(db: Db, projectId: string) {
  const [done] = await db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  return done ?? null;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/* A page's source file: its own <main> as built, kept beside the site. */
export function pageSlug(path: string): string {
  return path.replace(/^\/+|\/+$/g, "") || "home";
}

/*
  Each page's two hashes on a build: its own content (the kept source of its
  <main>, or the built page when there is none) and the shared header and
  footer (parts.json; empty when there is none, so only the page counts).
*/
export async function pageHashes(projectId: string, version: number, pages: BuiltPage[]): Promise<Map<string, { pageHash: string; partsHash: string }>> {
  const storage = getStorage();
  const base = `${projectStoragePrefix(projectId)}site/v${version}/`;
  const parts = await storage.get(`${base}_source/parts.json`);
  const partsHash = parts ? sha(parts.toString("utf8")) : "";
  const out = new Map<string, { pageHash: string; partsHash: string }>();
  for (const page of pages) {
    const slug = pageSlug(page.path);
    const source =
      (await storage.get(`${base}_source/pages/${slug}.html`)) ??
      (await storage.get(`${base}${slug === "home" ? "index.html" : `${slug}/index.html`}`));
    out.set(page.pageId, { pageHash: source ? sha(source.toString("utf8")) : "", partsHash });
  }
  return out;
}

export async function loadPageReview(db: Db, projectId: string, people: Map<string, string>): Promise<PageReviewView> {
  const done = await latestDone(db, projectId);
  if (!done) return { version: null, pages: [], approvedCount: 0, overridden: false };
  const pages = (done.pages as BuiltPage[] | null) ?? [];
  const hashes = await pageHashes(projectId, done.version, pages);
  const approvals = await db
    .select()
    .from(pageApproval)
    .where(and(eq(pageApproval.projectId, projectId), isNull(pageApproval.withdrawnAt)))
    .orderBy(desc(pageApproval.approvedAt));
  const comments = await db
    .select({ pageId: pageReviewComment.pageId, resolvedAt: pageReviewComment.resolvedAt, parentId: pageReviewComment.parentId })
    .from(pageReviewComment)
    .where(eq(pageReviewComment.projectId, projectId));
  const [gl] = await db.select({ version: goLive.pagesOverrideVersion }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);

  const states = pages.map((page): PageState => {
    const now = hashes.get(page.pageId);
    const mine = approvals.filter((a) => a.pageId === page.pageId);
    const valid = now && now.pageHash ? mine.find((a) => a.pageHash === now.pageHash && a.partsHash === now.partsHash) : undefined;
    const partsOnly = !valid && Boolean(now?.pageHash) && mine.some((a) => a.pageHash === now!.pageHash);
    return {
      pageId: page.pageId,
      name: page.name,
      path: page.path,
      approved: valid ? { by: people.get(valid.approvedByUserId) ?? "A team member", version: valid.buildVersion, at: valid.approvedAt } : null,
      partsChangedOnly: partsOnly,
      openComments: comments.filter((c) => c.pageId === page.pageId && !c.parentId && !c.resolvedAt).length,
    };
  });
  return {
    version: done.version,
    pages: states,
    approvedCount: states.filter((s) => s.approved).length,
    overridden: gl?.version === done.version,
  };
}

/* The go-live checklist's line: every page approved, or a founder's decision for this build. */
export function pagesChecklistItem(view: PageReviewView): ChecklistItem | null {
  if (view.version === null || view.pages.length === 0) return null;
  const all = view.approvedCount === view.pages.length;
  return {
    key: "pages-approved",
    label: "Every page reviewed and approved",
    ok: all || view.overridden,
    detail: all
      ? `All ${view.pages.length} pages approved`
      : view.overridden
        ? `${view.approvedCount} of ${view.pages.length} approved; a founder let this version go live`
        : `${view.approvedCount} of ${view.pages.length} approved: review the rest (Check, Review pages)`,
    blocksGoLive: true,
  };
}

async function currentPage(db: Db, projectId: string, pageId: string) {
  const done = await latestDone(db, projectId);
  if (!done) throw new PageReviewError("There is no finished build to review yet.");
  const page = ((done.pages as BuiltPage[] | null) ?? []).find((p) => p.pageId === pageId);
  if (!page) throw new PageReviewError("That page isn't in the latest build.");
  return { done, page };
}

export async function approveReviewedPage(ctx: Ctx, actor: Viewer, projectId: string, pageId: string): Promise<void> {
  assertCan(actor, "site.review_pages");
  const { done, page } = await currentPage(ctx.db, projectId, pageId);
  const hash = (await pageHashes(projectId, done.version, [page])).get(page.pageId)!;
  if (!hash.pageHash) throw new PageReviewError("This page's files weren't found in the build. Build again, then review it.");
  const [already] = await ctx.db
    .select({ id: pageApproval.id })
    .from(pageApproval)
    .where(
      and(
        eq(pageApproval.projectId, projectId),
        eq(pageApproval.pageId, pageId),
        eq(pageApproval.pageHash, hash.pageHash),
        eq(pageApproval.partsHash, hash.partsHash),
        isNull(pageApproval.withdrawnAt),
      ),
    )
    .limit(1);
  if (already) throw new PageReviewError("This page is already approved.");
  await ctx.db.insert(pageApproval).values({ projectId, buildVersion: done.version, pageId, pageHash: hash.pageHash, partsHash: hash.partsHash, approvedByUserId: actor.id });
  await recordActivity(ctx.db, { action: "site.page_approved", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { page: page.name, version: done.version }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* Pages approved before whose own content is the same, after a header or footer change: approved again in one click. */
export async function approveUnchanged(ctx: Ctx, actor: Viewer, projectId: string, people: Map<string, string>): Promise<number> {
  assertCan(actor, "site.review_pages");
  const view = await loadPageReview(ctx.db, projectId, people);
  const done = await latestDone(ctx.db, projectId);
  const todo = view.pages.filter((p) => p.partsChangedOnly);
  if (!done || todo.length === 0) throw new PageReviewError("No page is waiting only on a header or footer change.");
  const hashes = await pageHashes(projectId, done.version, ((done.pages as BuiltPage[] | null) ?? []).filter((p) => todo.some((t) => t.pageId === p.pageId)));
  for (const page of todo) {
    const hash = hashes.get(page.pageId)!;
    await ctx.db.insert(pageApproval).values({ projectId, buildVersion: done.version, pageId: page.pageId, pageHash: hash.pageHash, partsHash: hash.partsHash, approvedByUserId: actor.id });
  }
  await recordActivity(ctx.db, { action: "site.pages_approved_unchanged", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { pages: todo.map((p) => p.name), version: done.version }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return todo.length;
}

/* Taking an approval back (a mistake): kept for the record, no longer counted. */
export async function withdrawApproval(ctx: Ctx, actor: Viewer, projectId: string, pageId: string): Promise<void> {
  assertCan(actor, "site.review_pages");
  const { page } = await currentPage(ctx.db, projectId, pageId);
  const taken = await ctx.db
    .update(pageApproval)
    .set({ withdrawnAt: new Date() })
    .where(and(eq(pageApproval.projectId, projectId), eq(pageApproval.pageId, pageId), isNull(pageApproval.withdrawnAt)))
    .returning({ id: pageApproval.id });
  if (taken.length === 0) throw new PageReviewError("This page isn't approved.");
  await recordActivity(ctx.db, { action: "site.page_approval_withdrawn", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { page: page.name }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* A founder (or an admin) lets this build go live before every page is approved; logged, this build only. */
export async function overridePageReview(ctx: Ctx, actor: Viewer, projectId: string, people: Map<string, string>): Promise<void> {
  assertCan(actor, "site.golive");
  const view = await loadPageReview(ctx.db, projectId, people);
  if (view.version === null) throw new PageReviewError("There is no finished build yet.");
  if (view.approvedCount === view.pages.length) throw new PageReviewError("Every page is already approved.");
  const now = new Date();
  await ctx.db
    .insert(goLive)
    .values({ projectId, pagesOverrideVersion: view.version, pagesOverrideAt: now, pagesOverrideBy: actor.id })
    .onConflictDoUpdate({ target: goLive.projectId, set: { pagesOverrideVersion: view.version, pagesOverrideAt: now, pagesOverrideBy: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, {
    action: "site.pages_overridden",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: view.version, approved: view.approvedCount, pages: view.pages.length, notApproved: view.pages.filter((p) => !p.approved).map((p) => p.name) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* ---------- comments ---------- */

const commentSchema = z.object({
  body: z.string().trim().min(1, "Write the comment first.").max(2000, "Keep a comment under 2,000 characters."),
  area: z.enum(["header", "footer", "main"]).nullable(),
  section: z.number().int().min(0).max(200).nullable(),
  sectionLabel: z.string().trim().max(80).nullable(),
  pinX: z.number().min(0).max(100).nullable(),
  pinY: z.number().min(0).max(100).nullable(),
});

export async function addReviewComment(
  ctx: Ctx,
  actor: Viewer,
  input: {
    projectId: string;
    pageId: string;
    body: string;
    area?: "header" | "footer" | "main" | null;
    section?: number | null;
    sectionLabel?: string | null;
    pinX?: number | null;
    pinY?: number | null;
    parentId?: string | null;
  },
): Promise<string> {
  assertCan(actor, "project.view");
  const parsed = commentSchema.safeParse({
    body: input.body,
    area: input.area ?? null,
    section: input.area === "main" ? (input.section ?? null) : null,
    sectionLabel: input.area ? (input.sectionLabel ?? null) : null,
    pinX: input.area ? (input.pinX ?? null) : null,
    pinY: input.area ? (input.pinY ?? null) : null,
  });
  if (!parsed.success) throw new PageReviewError(parsed.error.issues[0]!.message);
  const { done, page } = await currentPage(ctx.db, input.projectId, input.pageId);

  let parentId: string | null = null;
  if (input.parentId) {
    const [parent] = await ctx.db.select().from(pageReviewComment).where(eq(pageReviewComment.id, input.parentId)).limit(1);
    if (!parent || parent.projectId !== input.projectId || parent.pageId !== page.pageId) throw new PageReviewError("That comment no longer exists.");
    parentId = parent.parentId ?? parent.id;
  }
  const data = parsed.data;
  const [row] = await ctx.db
    .insert(pageReviewComment)
    .values({
      projectId: input.projectId,
      buildVersion: done.version,
      pageId: page.pageId,
      parentId,
      authorUserId: actor.id,
      body: data.body,
      // A reply belongs to its thread, never pinned.
      area: parentId ? null : data.area,
      section: parentId ? null : data.section,
      sectionLabel: parentId ? null : data.sectionLabel,
      pinX: parentId ? null : data.pinX,
      pinY: parentId ? null : data.pinY,
    })
    .returning({ id: pageReviewComment.id });
  return row!.id;
}

export async function setReviewCommentResolved(ctx: Ctx, actor: Viewer, projectId: string, commentId: string, resolved: boolean): Promise<void> {
  assertCan(actor, "project.view");
  const [row] = await ctx.db.select().from(pageReviewComment).where(eq(pageReviewComment.id, commentId)).limit(1);
  if (!row || row.projectId !== projectId) throw new PageReviewError("That comment no longer exists.");
  if (row.parentId) throw new PageReviewError("Resolve the comment the reply belongs to.");
  await ctx.db
    .update(pageReviewComment)
    .set(resolved ? { resolvedAt: new Date(), resolvedByUserId: actor.id } : { resolvedAt: null, resolvedByUserId: null })
    .where(eq(pageReviewComment.id, commentId));
}

export interface PageComment {
  id: string;
  /** Not sent, being fixed, or sent in version N. */
  tag: { kind: "not_sent" | "sending" | "sent"; version: number | null };
  number: number;
  version: number;
  author: string;
  body: string;
  area: "header" | "footer" | "main" | null;
  section: number | null;
  sectionLabel: string | null;
  pinX: number | null;
  pinY: number | null;
  resolved: boolean;
  createdAt: Date;
  replies: { id: string; author: string; body: string; createdAt: Date }[];
  /** After its fix (3c): whether its part changed in the version the fix made, by code. */
  change: "changed" | "unchanged" | null;
  /** The reviewer's Done or Not done, and on which version. */
  outcome: { kind: "done" | "not_done"; version: number } | null;
  /** Not done twice: say "Ask the Web Designer" (it doesn't block). */
  askDesigner: boolean;
}

export async function loadPageComments(db: Db, projectId: string, pageId: string, people: Map<string, string>): Promise<PageComment[]> {
  const rows = await db
    .select()
    .from(pageReviewComment)
    .where(and(eq(pageReviewComment.projectId, projectId), eq(pageReviewComment.pageId, pageId)))
    .orderBy(asc(pageReviewComment.createdAt));
  const name = (id: string) => (people.get(id) ?? "A team member").split(" ")[0]!;
  const fixIds = [...new Set(rows.map((r) => r.fixId).filter((id): id is string => Boolean(id)))];
  const fixes = fixIds.length
    ? await db
        .select({ id: pageFix.id, status: pageFix.status, createdAt: pageFix.createdAt, changed: pageFix.changed, resultVersion: pageFix.resultVersion })
        .from(pageFix)
        .where(inArray(pageFix.id, fixIds))
    : [];
  const running = new Set(fixes.filter((f) => isFixRunning(f)).map((f) => f.id));
  return rows
    .filter((r) => !r.parentId)
    .map((r, index) => {
      const fix = r.fixId && r.sentInVersion !== null ? fixes.find((f) => f.id === r.fixId && f.status === "done" && f.resultVersion === r.sentInVersion) : undefined;
      const part: FixPartId | null = r.area === "header" ? "header" : r.area === "footer" ? "footer" : r.area === "main" && r.section !== null ? r.section : null;
      return {
        id: r.id,
        number: index + 1,
        version: r.buildVersion,
        author: name(r.authorUserId),
        body: r.body,
        area: (r.area as PageComment["area"]) ?? null,
        section: r.section,
        sectionLabel: r.sectionLabel,
        pinX: r.pinX,
        pinY: r.pinY,
        resolved: r.resolvedAt !== null,
        tag:
          r.fixId && running.has(r.fixId)
            ? { kind: "sending" as const, version: null }
            : r.sentInVersion !== null
              ? { kind: "sent" as const, version: r.sentInVersion }
              : { kind: "not_sent" as const, version: null },
        createdAt: r.createdAt,
        replies: rows.filter((c) => c.parentId === r.id).map((c) => ({ id: c.id, author: name(c.authorUserId), body: c.body, createdAt: c.createdAt })),
        change: fix ? (commentPartChanged(part, (fix.changed as FixPartId[] | null) ?? []) ? ("changed" as const) : ("unchanged" as const)) : null,
        outcome: (r.outcome === "done" || r.outcome === "not_done") && r.outcomeVersion !== null ? { kind: r.outcome, version: r.outcomeVersion } : null,
        askDesigner: r.outcome === "not_done" && r.tries >= 2 && r.fixId === null && r.resolvedAt === null,
      };
    });
}

/*
  3c (5 October 2026): after a fix, the reviewer says whether each sent
  comment was done, one click each, no AI. Done resolves it. Not done opens
  it again as Not sent, so it goes with the next Fix these; a comment found
  not done twice says "Ask the Web Designer", so nobody keeps paying for the
  same failed fix. Both are logged (who, which comment, which version).
*/
export async function markReviewComment(ctx: Ctx, actor: Viewer, projectId: string, commentId: string, outcome: "done" | "not_done"): Promise<void> {
  assertCan(actor, "site.review_pages");
  const [row] = await ctx.db.select().from(pageReviewComment).where(eq(pageReviewComment.id, commentId)).limit(1);
  if (!row || row.projectId !== projectId) throw new PageReviewError("That comment no longer exists.");
  if (row.parentId) throw new PageReviewError("Mark the comment the reply belongs to.");
  if (row.resolvedAt) throw new PageReviewError("This comment is already resolved.");
  if (row.sentInVersion === null || row.fixId === null) throw new PageReviewError("This comment hasn't been through Fix these yet: there is nothing to check.");
  const version = row.sentInVersion;
  const now = new Date();
  await ctx.db
    .update(pageReviewComment)
    .set(
      outcome === "done"
        ? { outcome, outcomeVersion: version, resolvedAt: now, resolvedByUserId: actor.id }
        : { outcome, outcomeVersion: version, fixId: null, sentInVersion: null },
    )
    .where(eq(pageReviewComment.id, commentId));
  const [build] = await ctx.db
    .select({ pages: siteBuild.pages })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.version, version)))
    .limit(1);
  const page = ((build?.pages as BuiltPage[] | null) ?? []).find((p) => p.pageId === row.pageId);
  await recordActivity(ctx.db, {
    action: outcome === "done" ? "site.page_comment_done" : "site.page_comment_not_done",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page?.name ?? row.pageId, commentId, comment: row.body.slice(0, 200), version, tries: row.tries },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* Everything the review screen of one page needs. */
export async function loadPageForReview(db: Db, projectId: string, pageId: string, people: Map<string, string>) {
  const view = await loadPageReview(db, projectId, people);
  const index = view.pages.findIndex((p) => p.pageId === pageId);
  if (view.version === null || index === -1) return null;
  const page = view.pages[index]!;
  const next = [...view.pages.slice(index + 1), ...view.pages.slice(0, index)].find((p) => !p.approved) ?? null;
  return {
    version: view.version,
    page,
    position: { index: index + 1, of: view.pages.length },
    approvedCount: view.approvedCount,
    next: next ? { pageId: next.pageId, name: next.name } : null,
    pages: view.pages.map((p) => ({ pageId: p.pageId, name: p.name, approved: Boolean(p.approved) })),
    comments: await loadPageComments(db, projectId, pageId, people),
    fix: await latestFix(db, projectId, pageId),
    fixEstimate: await estimatePageFix(db),
  };
}

/* ---------- Fix these (step 3b, 3 October 2026) ---------- */

/* A fix the worker never finished (it restarted) stops blocking after this long. */
const FIX_LOST_AFTER_MS = 30 * 60_000;

function isFixRunning(fix: { status: string; createdAt: Date }): boolean {
  return ["queued", "fixing", "building"].includes(fix.status) && fix.createdAt.getTime() > Date.now() - FIX_LOST_AFTER_MS;
}

export const PAGE_FIX_GUESS = { inputTokens: 14_000, outputTokens: 5_000 };

/*
  What one Fix these costs: measured from the fixes so far (the edit call;
  the rebuild after it is free), else a first guess. On Sonnet 5 unless an
  admin changes the step on Spend.
*/
export async function estimatePageFix(db: Db): Promise<{ cost: number; high: number; upTo: number; label: string }> {
  const config = await stepModelConfig(db, "site_page_fix");
  const model = modelLabel(config.model);
  /*
    Measured from the finished fixes (3c, 5 October 2026): a fix that tried
    once more after TAWD's check made two calls, so the spend is shared out
    per call (fixes plus retries), not per fix; a retry never makes the
    usual fix look dearer than it is.
  */
  const [done] = await db
    .select({ n: sql<number>`count(*)::int`, retries: sql<number>`count(*) filter (where ${pageFix.retried})::int` })
    .from(pageFix)
    .where(eq(pageFix.status, "done"));
  const n = Number(done?.n ?? 0);
  const calls = n + Number(done?.retries ?? 0);
  const [spent] = n
    ? await db
        .select({
          inputTokens: sql<number>`coalesce(sum(${aiCall.inputTokens}), 0)::float8`,
          outputTokens: sql<number>`coalesce(sum(${aiCall.outputTokens}), 0)::float8`,
          cacheReadTokens: sql<number>`coalesce(sum(${aiCall.cacheReadTokens}), 0)::float8`,
          cacheWriteTokens: sql<number>`coalesce(sum(${aiCall.cacheWriteTokens}), 0)::float8`,
          cacheWrite1hTokens: sql<number>`coalesce(sum(${aiCall.cacheWrite1hTokens}), 0)::float8`,
        })
        .from(aiCall)
        .where(and(eq(aiCall.step, "site_page_fix"), inArray(aiCall.runId, db.select({ id: pageFix.id }).from(pageFix).where(eq(pageFix.status, "done")))))
    : [];
  const measured = spent ? costOf(spent, config) : 0;
  const retryLine = (cost: number) => `; up to ${formatCost(cost * 2)} if TAWD's check finds a problem and it tries once more`;
  if (n > 0 && measured > 0) {
    const cost = measured / calls;
    return { cost, high: cost * 2, upTo: cost * 2, label: `About ${formatCost(cost)} of AI on ${model}, from the ${n} fix${n === 1 ? "" : "es"} so far; the rebuild after it is free${retryLine(cost)}` };
  }
  const cost = costOf(PAGE_FIX_GUESS, config);
  return { cost, high: cost * 2, upTo: cost * 2, label: `About ${formatCost(cost)} of AI on ${model} (a first guess until a fix has run); the rebuild after it is free${retryLine(cost)}` };
}

export interface FixView {
  status: "queued" | "fixing" | "building" | "done" | "failed";
  detail: string | null;
  failureReason: string | null;
  resultVersion: number | null;
  changed: string[];
  /** TAWD's check after the fix (3c), when it ran. */
  check: PageFixCheck | null;
  retried: boolean;
}

async function latestFix(db: Db, projectId: string, pageId: string): Promise<FixView | null> {
  const [fix] = await db
    .select()
    .from(pageFix)
    .where(and(eq(pageFix.projectId, projectId), eq(pageFix.pageId, pageId)))
    .orderBy(desc(pageFix.createdAt))
    .limit(1);
  if (!fix) return null;
  const lost = ["queued", "fixing", "building"].includes(fix.status) && !isFixRunning(fix);
  return {
    status: lost ? "failed" : (fix.status as FixView["status"]),
    detail: fix.detail,
    failureReason: lost ? "It didn't finish (the worker may have restarted). Its comments can be sent again." : fix.failureReason,
    resultVersion: fix.resultVersion,
    changed: ((fix.changed as (string | number)[] | null) ?? []).map((c) => (c === "header" ? "the header" : c === "footer" ? "the footer" : `part ${Number(c) + 1}`)),
    check: (fix.checkFindings as PageFixCheck | null) ?? null,
    retried: fix.retried,
  };
}

/*
  Fix these: the page's open comments that haven't been sent go to the AI,
  then a new version is built from the saved sources. PMs, the Web
  Designer, founders and admins; Lane 1 builds; the estimate is shown
  first and the monthly limit is checked.
*/
export async function startPageFix(ctx: Ctx, actor: Viewer, projectId: string, pageId: string): Promise<string> {
  assertCan(actor, "site.review_pages");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (proj?.lane === "lane_2") throw new PageReviewError("Fix these is for sites TAWD designed (Lane 1). For a site built from the client's design, use the design's feedback on Design.");
  const { done, page } = await currentPage(ctx.db, projectId, pageId);

  const fixes = await ctx.db.select({ id: pageFix.id, status: pageFix.status, createdAt: pageFix.createdAt }).from(pageFix).where(eq(pageFix.projectId, projectId));
  if (fixes.some(isFixRunning)) throw new PageReviewError("A fix is already being made on this site. Wait for it to finish.");
  // A fix the worker lost gives its comments back, so they can be sent again.
  for (const lost of fixes.filter((f) => ["queued", "fixing", "building"].includes(f.status))) {
    await ctx.db.update(pageFix).set({ status: "failed", failureReason: "It didn't finish (the worker may have restarted).", finishedAt: new Date() }).where(eq(pageFix.id, lost.id));
    await ctx.db
      .update(pageReviewComment)
      .set({ fixId: null, tries: sql`greatest(${pageReviewComment.tries} - 1, 0)` })
      .where(and(eq(pageReviewComment.fixId, lost.id), isNull(pageReviewComment.sentInVersion)));
  }
  const [building] = await ctx.db
    .select({ id: siteBuild.id })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), inArray(siteBuild.status, ["queued", "working"])))
    .limit(1);
  if (building) throw new PageReviewError("The site is being built. Wait for it to finish.");

  const comments = await ctx.db
    .select()
    .from(pageReviewComment)
    .where(
      and(
        eq(pageReviewComment.projectId, projectId),
        eq(pageReviewComment.pageId, pageId),
        isNull(pageReviewComment.parentId),
        isNull(pageReviewComment.resolvedAt),
        isNull(pageReviewComment.fixId),
      ),
    );
  if (comments.length === 0) throw new PageReviewError("There are no open comments on this page to fix.");

  const estimate = await estimatePageFix(ctx.db);
  try {
    // The most it can spend: the fix and its one retry (both are checked here; the worker never starts a third call).
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: Math.max(estimate.high, estimate.upTo) });
  } catch (error) {
    if (error instanceof SpendError) throw new PageReviewError(error.message);
    throw error;
  }

  const [fix] = await ctx.db
    .insert(pageFix)
    .values({
      projectId,
      pageId,
      pageName: page.name,
      slug: pageSlug(page.path),
      baseBuildId: done.id,
      baseVersion: done.version,
      estimate: estimate.label,
      estimateCost: estimate.cost,
      requestedByUserId: actor.id,
      detail: "Waiting its turn",
    })
    .returning({ id: pageFix.id });
  const fixId = fix!.id;
  await ctx.db
    .update(pageReviewComment)
    .set({ fixId, tries: sql`${pageReviewComment.tries} + 1` })
    .where(inArray(pageReviewComment.id, comments.map((c) => c.id)));
  await recordActivity(ctx.db, {
    action: "site.page_fix_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version: done.version, comments: comments.length, estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  try {
    await getQueue().add(PAGE_FIX_JOB, { fixId, projectId } satisfies PageFixJobData, { jobId: pageFixJobId(fixId), attempts: 1 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "the queue refused the job";
    await ctx.db.update(pageFix).set({ status: "failed", failureReason: reason, finishedAt: new Date() }).where(eq(pageFix.id, fixId));
    await ctx.db
      .update(pageReviewComment)
      .set({ fixId: null, tries: sql`greatest(${pageReviewComment.tries} - 1, 0)` })
      .where(eq(pageReviewComment.fixId, fixId));
    throw new PageReviewError(`The fix could not be queued, so nothing has started: ${reason}.`);
  }
  return fixId;
}

