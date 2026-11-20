import { and, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { aiCall, pageDraft, pagePlanPage } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, SYSTEM_ACTOR, type Viewer } from "@tawd/core/permissions";
import { CONTENT_DRAFT_JOB, contentDraftJobId } from "@tawd/core/queue";
import { costOf, formatCost, listIntakeFacts, modelLabel, type TokenUsage } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";
import { IMPROVE_SOURCE, changedShare, factsCheckLine, improveFactsCheck, wordDiff, type DiffPart } from "@tawd/core/content";
import { loadIntakeForBuilding } from "@tawd/core/intake/unconfirmed";
import type { IntakeData } from "@tawd/core/intake";
import { KEPT_SOURCE, isKeptLineage, projectTypeFor, usesSuppliedHome } from "@tawd/core/site-read";
import { getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Design + content (Jason, 6 October 2026; built in 0.100.0,
  docs/plans/project-type.md section 4): improving each page's words from
  the current site's. Paid (one call a page, on the step content_improve,
  Sonnet 5 unless changed on Spend): the model and the estimate show
  first, the monthly limit is checked, and the Home page goes first (rule
  8): the rest unlock once its improved words are approved, or it's put
  back to the current site's words. Comparing, the facts check, putting a
  page back and approving are free.
*/

type Db = Database;

export class ImproveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImproveError";
  }
}

/** Below this many words a page isn't ticked by default: too little to improve. */
export const IMPROVE_MIN_WORDS = 50;

/* A first guess for one page by its length, until real improvements have run: the instructions and intake, the page in, the page out. */
export function improveGuess(words: number): TokenUsage {
  return { inputTokens: 5_000 + Math.round(words * 1.4), outputTokens: 300 + Math.round(words * 1.5) };
}

const wordsOf = (text: string | null | undefined) => (text ?? "").split(/\s+/).filter(Boolean).length;

export async function estimateImprove(db: Db, pageWords: number[]): Promise<{ cost: number; label: string; measured: boolean; model: string }> {
  const config = await stepModelConfig(db, "content_improve");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "content_improve"));
  const byPage = new Map<string, number>();
  for (const call of calls) byPage.set(call.runId, (byPage.get(call.runId) ?? 0) + costOf(call, config));
  const measured = byPage.size > 0;
  const cost = measured ? ([...byPage.values()].reduce((a, b) => a + b, 0) / byPage.size) * pageWords.length : pageWords.reduce((sum, w) => sum + costOf(improveGuess(w), config), 0);
  const n = pageWords.length;
  return {
    cost,
    measured,
    model: config.model,
    label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)} for ${n} page${n === 1 ? "" : "s"}${measured ? ", from the improved pages so far" : " (a first guess by each page's length until a real one has run)"}.`,
  };
}

type Version = typeof pageDraft.$inferSelect;

export type ImproveState = "current" | "improving" | "improved" | "approved" | "failed" | "kept_back";

export interface ImproveRow {
  pageId: string;
  name: string;
  kind: string;
  words: number;
  state: ImproveState;
  /** Ticked by default: has words to improve, isn't a blog article, and isn't too short. */
  suggested: boolean;
  /** Why it isn't ticked by default, in words. */
  why: string | null;
  failure: string | null;
  /** This page's estimate in dollars. */
  cost: number;
}

/* Where each page stands, from its versions (newest first). */
function stateOf(versions: Version[]): ImproveState {
  const latest = versions[0];
  if (!latest) return "current";
  if (latest.status === "queued" || latest.status === "working") return "improving";
  if (latest.status === "failed" && versions.some((v) => v.source === IMPROVE_SOURCE)) return "failed";
  if (isKeptLineage(versions)) return versions.some((v) => v.source === IMPROVE_SOURCE) ? "kept_back" : "current";
  return latest.approvedAt ? "approved" : "improved";
}

/* The Home page is checked: its improved words approved, or put back to the current site's. */
const homeChecked = (state: ImproveState | undefined) => state === "approved" || state === "kept_back";

export interface ImproveView {
  rows: ImproveRow[];
  /** The estimates are from improved pages so far (else a first guess by length). */
  measured: boolean;
  /** The Home page's state, and whether the rest are unlocked. */
  homeState: ImproveState | null;
  restUnlocked: boolean;
  estimateAll: { cost: number; label: string };
  estimateHome: { cost: number; label: string } | null;
  model: string;
}

export async function loadImproveView(db: Db, projectId: string): Promise<ImproveView | null> {
  if ((await projectTypeFor(db, projectId)) !== "design_content") return null;
  // A supplied homepage keeps its own words, so improving the home page's words would be paid for and thrown away.
  const suppliedHome = await usesSuppliedHome(db, projectId);
  const pages = (await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(pagePlanPage.position)).filter((p) => !(suppliedHome && p.kind === "home"));
  const drafts = pages.length ? await db.select().from(pageDraft).where(inArray(pageDraft.pageId, pages.map((p) => p.id))).orderBy(desc(pageDraft.version)) : [];
  // One page's estimate: the measured average, or a first guess by its length.
  const config = await stepModelConfig(db, "content_improve");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "content_improve"));
  const byPage = new Map<string, number>();
  for (const call of calls) byPage.set(call.runId, (byPage.get(call.runId) ?? 0) + costOf(call, config));
  const measuredAverage = byPage.size ? [...byPage.values()].reduce((a, b) => a + b, 0) / byPage.size : null;
  const costFor = (words: number) => measuredAverage ?? costOf(improveGuess(words), config);
  const rows: ImproveRow[] = pages.flatMap((page) => {
    const versions = drafts.filter((d) => d.pageId === page.id);
    const kept = versions.find((v) => v.source === KEPT_SOURCE && v.body);
    if (!kept) return [];
    const words = wordsOf(kept.body);
    const why = page.kind === "article" ? "Blog articles stay as they are unless you tick them." : words < IMPROVE_MIN_WORDS && page.kind !== "home" ? `Only ${words} words: too little to improve.` : null;
    const latest = versions[0];
    return [{ pageId: page.id, name: page.name, kind: page.kind, words, state: stateOf(versions), suggested: why === null, why, failure: latest?.status === "failed" ? latest.failureReason : null, cost: costFor(words) }];
  });
  const home = rows.find((r) => r.kind === "home") ?? null;
  const todo = rows.filter((r) => r.suggested && (r.state === "current" || r.state === "failed"));
  const all = await estimateImprove(db, todo.map((r) => r.words));
  return {
    rows,
    measured: measuredAverage !== null,
    homeState: home?.state ?? null,
    restUnlocked: !home || homeChecked(home.state),
    estimateAll: { cost: all.cost, label: all.label },
    estimateHome: home && (home.state === "current" || home.state === "failed") ? await estimateImprove(db, [home.words]).then((e) => ({ cost: e.cost, label: e.label })) : null,
    model: all.model,
  };
}

/* Queue the improvement of these pages (paid). Home first: the rest wait until its improved words are checked. */
export async function startImprove(ctx: ServiceContext, actor: Viewer, projectId: string, input: { pageIds: string[]; note?: string | null }): Promise<number> {
  assertCan(actor, "content.plan");
  const view = await loadImproveView(ctx.db as Db, projectId);
  if (!view) throw new ImproveError("Only a Design + content project improves the current site's words.");
  const picked = view.rows.filter((r) => input.pageIds.includes(r.pageId));
  if (picked.length === 0) throw new ImproveError("Choose at least one page to improve.");
  const busy = picked.find((r) => r.state === "improving");
  if (busy) throw new ImproveError(`${busy.name} is being improved now.`);
  const note = input.note?.trim().slice(0, 2000) || null;
  const done = picked.find((r) => (r.state === "improved" || r.state === "approved") && !note);
  if (done) throw new ImproveError(`${done.name} is already improved: use Improve it again on its page, with a note.`);
  const others = picked.filter((r) => r.kind !== "home");
  if (others.length && !view.restUnlocked) throw new ImproveError("Improve the Home page first: the other pages unlock once its improved words are approved (or it's put back to the current site's words).");
  const estimate = await estimateImprove(ctx.db as Db, picked.map((r) => r.words));
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new ImproveError(error.message);
    throw error;
  }
  for (const row of picked) {
    const [last] = await ctx.db.select({ version: pageDraft.version }).from(pageDraft).where(eq(pageDraft.pageId, row.pageId)).orderBy(desc(pageDraft.version)).limit(1);
    const [draft] = await ctx.db
      .insert(pageDraft)
      .values({ projectId, pageId: row.pageId, version: (last?.version ?? 0) + 1, source: IMPROVE_SOURCE, status: "queued", note, createdByUserId: actor.id })
      .returning({ id: pageDraft.id });
    try {
      await getQueue().add(CONTENT_DRAFT_JOB, { draftId: draft!.id, projectId }, { jobId: contentDraftJobId(draft!.id), attempts: 1 });
    } catch {
      await ctx.db.delete(pageDraft).where(eq(pageDraft.id, draft!.id));
      throw new ImproveError("The pages couldn't be queued: the job queue isn't answering. Try again in a minute.");
    }
  }
  await recordActivity(ctx.db, {
    action: "content.improve_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { pages: picked.map((r) => r.name), estimate: estimate.label, ...(note ? { note } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return picked.length;
}

/* Put a page back to the current site's words (free): a new version copying the kept words, which counts as kept again. */
export async function revertToKept(ctx: ServiceContext, actor: Viewer, projectId: string, pageId: string): Promise<number> {
  assertCan(actor, "content.plan");
  const [page] = await ctx.db.select().from(pagePlanPage).where(and(eq(pagePlanPage.id, pageId), eq(pagePlanPage.projectId, projectId))).limit(1);
  if (!page) throw new ImproveError("That page is no longer in the plan.");
  const versions = await ctx.db.select().from(pageDraft).where(eq(pageDraft.pageId, pageId)).orderBy(desc(pageDraft.version));
  const kept = [...versions].sort((a, b) => b.version - a.version).find((v) => v.source === KEPT_SOURCE && v.body);
  if (!kept) throw new ImproveError("This page has no words from the current site.");
  const latest = versions[0]!;
  if (latest.status === "queued" || latest.status === "working") throw new ImproveError("Wait for the page that is being improved, then put it back.");
  if (isKeptLineage(versions)) return latest.version;
  const version = latest.version + 1;
  await ctx.db.insert(pageDraft).values({ projectId, pageId, version, source: KEPT_SOURCE, status: "done", body: kept.body, note: "Put back to the current site's words", createdByUserId: actor.id, finishedAt: new Date() });
  await recordActivity(ctx.db, {
    action: "content.page_reverted_to_kept",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { page: page.name, version },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return version;
}

/*
  The names the improved words must keep word for word (9 November 2026):
  the business, the city it works from, every service area and every
  service. A city written "Carson City, NV" is checked as "Carson City":
  what follows the comma is not something the page has to repeat. Only
  names the current page already used are checked (see
  improveFactsCheck), so nothing is demanded that the client never wrote.
*/
export function namesThatMustSurvive(data: IntakeData | undefined): string[] {
  if (!data) return [];
  /*
    A place is checked by the part before its first comma. "Carson City,
    NV" and "Carson City, Nevada" are both the city "Carson City", and the
    page is not expected to repeat the state; the same cut handles whatever
    else someone types after a comma ("Lake Tahoe, CA and NV"). Erring
    towards checking less is deliberate: this line nags the team, so it
    must never nag about a name that was never lost.
  */
  const place = (text: string | undefined) => (text ?? "").split(",")[0]!.trim();
  const names = [
    data.business.name,
    place(data.business.city),
    ...data.serviceAreas.cities.map(place),
    ...data.serviceAreas.counties.map(place),
    ...data.services.items.map((s) => s.name),
  ];
  // Two words or more: a one-word name ("Reno", "Glass") turns up inside other words too often to be worth a warning.
  return [...new Set(names.map((n) => (n ?? "").trim()).filter((n) => n.split(/\s+/).filter(Boolean).length >= 2))];
}

export interface ImproveCompare {
  parts: DiffPart[];
  /** The share of the shown version's words that are new. */
  changed: number;
  /** New or missing numbers, phones, prices and years, in words; null when none. */
  factsLine: string | null;
}

/* The shown version against the current site's words: word by word, with the facts check. Null when the page has no kept words or shows them. */
export async function improveCompare(db: Db, projectId: string, versions: Version[], shown: Version | null): Promise<ImproveCompare | null> {
  const kept = [...versions].sort((a, b) => b.version - a.version).find((v) => v.source === KEPT_SOURCE && v.body);
  if (!kept?.body || !shown?.body || shown.source === KEPT_SOURCE || !versions.some((v) => v.source === IMPROVE_SOURCE)) return null;
  // B3: an old-site claim nobody confirmed is not intake (review L4).
  const intake = await loadIntakeForBuilding(db as never, SYSTEM_ACTOR, projectId);
  const intakeText = intake ? listIntakeFacts(intake.data, intake.files).map((f) => f.value ?? "").join("\n") : "";
  const parts = wordDiff(kept.body, shown.body);
  return { parts, changed: changedShare(parts), factsLine: factsCheckLine(improveFactsCheck(kept.body, shown.body, intakeText, namesThatMustSurvive(intake?.data))) };
}
