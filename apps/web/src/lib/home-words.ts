import { and, eq } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import { loadIntake } from "@tawd/core/intake/service";
import { keptHomeWords, keptHomeWordsBlocker, type KeptHomeWords } from "@tawd/core/kept-home-words";
import {
  HOME_WORDS_GUESS,
  checkHomeWordsFacts,
  costOf,
  formatCost,
  modelLabel,
  wordsFromClientCopy,
  wordsFromCurrentSite,
  type CurrentSiteResult,
  type HomeWords,
  type HomeWordsSection,
  type HomeWordsSource,
  type HomeWordsTestimonial,
} from "@tawd/core/mockups";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { HOME_WORDS_JOB, homeWordsJobId } from "@tawd/core/queue";
import { aiCall, homeWords, project } from "@tawd/core/schema";
import { stepModelConfig } from "@tawd/core/step-models";
import { siteReadHome } from "@tawd/core/site-read";
import { ensureKeptPlan } from "@/lib/site-read";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";

/*
  Content first, part 2 (Jason, 30 September 2026; built 1 October,
  DESIGN.md "Content first, part 2"): the home page's words come before the
  concepts, in Lane 1. They start from the current site or the client's
  copy ($0), or one AI call writes them for a new site (estimate first).
  The team edits and uses them; Generate waits until they're used.
*/

type Db = Database;

/* Where this project's words come from, by the intake's content choice. */
export function sourceFor(mode: string | null, hasSite: boolean, hasCopy: boolean): HomeWordsSource | null {
  // Design only or Design + content with the website taken off the intake: Everything new (0.100.0), as the Content section shows.
  if (mode === "keep" || mode === "improve") return hasSite ? "current_site" : "tawd";
  if (mode === "manual") return hasCopy ? "client_copy" : hasSite ? "current_site" : null;
  return "tawd";
}

export async function estimateHomeWords(db: Db): Promise<{ cost: number; label: string }> {
  const config = await stepModelConfig(db, "home_words");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "home_words"));
  const runs = new Set(calls.map((c) => c.runId)).size;
  const cost = runs ? calls.reduce((n, c) => n + costOf(c, config), 0) / runs : costOf(HOME_WORDS_GUESS, config);
  return { cost, label: `About ${formatCost(cost)} of AI on ${modelLabel(config.model)}${runs ? ", from the runs so far" : " (a first guess until a real one has run)"}.` };
}

export interface HomeWordsView {
  source: HomeWordsSource;
  sections: (HomeWordsSection & { flag: string | null })[];
  testimonials: HomeWordsTestimonial[];
  writing: boolean;
  writeFailure: string | null;
  approved: { at: Date; byUserId: string | null } | null;
}

export interface HomeWordsPanel {
  /** Lane 1 only. */
  applies: boolean;
  /** Where they'd come from now; null when nothing is there to start from (TAWD can write them). */
  suggested: HomeWordsSource | null;
  words: HomeWordsView | null;
  estimate: { cost: number; label: string };
  /** A makeover (Keep all content as is): the Home page's words on Content, read only; null otherwise. */
  kept: (KeptHomeWords & { flags: (string | null)[] }) | null;
}

function siteResult(db: Db, projectId: string): Promise<CurrentSiteResult | null> {
  return siteReadHome(db, projectId);
}

export async function loadHomeWords(db: Db, projectId: string): Promise<HomeWordsPanel> {
  const [proj] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const site = await siteResult(db, projectId);
  const content = intake?.data.content;
  const suggested = sourceFor(content?.mode ?? null, Boolean(site), Boolean(content?.suppliedCopy.trim()));
  const [row] = await db.select().from(homeWords).where(eq(homeWords.projectId, projectId)).limit(1);
  const facts = { phone: intake?.data.business.phone ?? "", yearFounded: intake?.data.business.yearFounded ?? null };
  const flags = row ? checkHomeWordsFacts(row.sections, facts) : [];
  await ensureKeptPlan(db, projectId);
  const kept = await keptHomeWords(db, projectId);
  return {
    kept: kept ? { ...kept, flags: kept.words ? checkHomeWordsFacts(kept.words.sections, facts) : [] } : null,
    applies: proj?.lane !== "lane_2",
    suggested,
    estimate: await estimateHomeWords(db),
    words: row
      ? {
          source: row.source as HomeWordsSource,
          sections: row.sections.map((s, i) => ({ ...s, flag: flags[i] ?? null })),
          testimonials: row.testimonials,
          writing: row.writeStatus === "queued" || row.writeStatus === "working",
          writeFailure: row.writeStatus === "failed" ? row.writeFailure : null,
          approved: row.approvedAt ? { at: row.approvedAt, byUserId: row.approvedByUserId } : null,
        }
      : null,
  };
}

async function upsert(db: Db, projectId: string, words: HomeWords, extra: Partial<typeof homeWords.$inferInsert> = {}): Promise<void> {
  const values = { source: words.source, sections: words.sections, testimonials: words.testimonials, approvedAt: null, approvedByUserId: null, updatedAt: new Date(), ...extra };
  await db.insert(homeWords).values({ projectId, ...values }).onConflictDoUpdate({ target: homeWords.projectId, set: values });
}

/* Start from the current site or the client's copy: code only, $0. */
/* A makeover's words are the Home page on Content: nothing to start, write or use here. */
async function refuseIfKept(db: Db, projectId: string): Promise<void> {
  if (await keptHomeWords(db, projectId)) throw new MockupError("This site keeps its current words: the concepts use the Home page on Content. Edit it there.");
}

export async function startHomeWords(ctx: ServiceContext, actor: Viewer, projectId: string, source: "current_site" | "client_copy"): Promise<void> {
  assertCan(actor, "project.edit");
  await refuseIfKept(ctx.db, projectId);
  if (source === "current_site") {
    const site = await siteResult(ctx.db, projectId);
    if (!site) throw new MockupError("TAWD hasn't read the current website yet: add it in the intake's Website section.");
    await upsert(ctx.db, projectId, wordsFromCurrentSite(site));
  } else {
    const intake = await loadIntake(ctx.db, actor, projectId);
    const copy = intake?.data.content.suppliedCopy ?? "";
    if (!copy.trim()) throw new MockupError("There's no copy from the client in the intake's Content section yet.");
    await upsert(ctx.db, projectId, wordsFromClientCopy(copy));
  }
}

/* New site: one AI call writes them, after the estimate. */
export async function writeHomeWords(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  await refuseIfKept(ctx.db, projectId);
  const [row] = await ctx.db.select().from(homeWords).where(eq(homeWords.projectId, projectId)).limit(1);
  if (row && (row.writeStatus === "queued" || row.writeStatus === "working")) throw new MockupError("The words are already being written.");
  const estimate = await estimateHomeWords(ctx.db);
  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: estimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  await ctx.db
    .insert(homeWords)
    .values({ projectId, source: "tawd", writeStatus: "queued", writeFailure: null })
    .onConflictDoUpdate({ target: homeWords.projectId, set: { writeStatus: "queued", writeFailure: null, updatedAt: new Date() } });
  try {
    await getQueue().add(HOME_WORDS_JOB, { projectId, startedByUserId: actor.id }, { jobId: homeWordsJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    await ctx.db.update(homeWords).set({ writeStatus: "failed", writeFailure: "The job queue isn't answering. Try again in a minute." }).where(eq(homeWords.projectId, projectId));
    throw new MockupError("The words couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "mockups.home_words_writing",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { estimate: estimate.label },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* "Use these words": saved as edited, approved, logged. */
export async function approveHomeWords(ctx: ServiceContext, actor: Viewer, projectId: string, input: { sections: HomeWordsSection[]; testimonials: HomeWordsTestimonial[] }): Promise<void> {
  assertCan(actor, "project.edit");
  await refuseIfKept(ctx.db, projectId);
  const [row] = await ctx.db.select().from(homeWords).where(eq(homeWords.projectId, projectId)).limit(1);
  if (!row) throw new MockupError("Start the words first.");
  const sections = input.sections
    .map((s) => ({ name: String(s.name ?? "").trim().slice(0, 80), words: String(s.words ?? "").trim().slice(0, 4000) }))
    .filter((s) => s.name && s.words)
    .slice(0, 20);
  if (!sections.length) throw new MockupError("Keep at least one section with words.");
  const testimonials = input.testimonials.slice(0, 10).map((t) => ({ text: String(t.text ?? "").trim().slice(0, 500), confirmed: t.confirmed === true })).filter((t) => t.text);
  const at = new Date();
  await ctx.db.update(homeWords).set({ sections, testimonials, approvedAt: at, approvedByUserId: actor.id, updatedAt: at }).where(eq(homeWords.id, row.id));
  await recordActivity(ctx.db, {
    action: "mockups.home_words_used",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { source: row.source, sections: sections.map((s) => s.name), testimonialsConfirmed: testimonials.filter((t) => t.confirmed).length, testimonialsWaiting: testimonials.filter((t) => !t.confirmed).length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* The approved words for a concept run, or null. */
export async function approvedHomeWords(db: Db, projectId: string): Promise<HomeWords | null> {
  const kept = await keptHomeWords(db, projectId);
  if (kept) return kept.words;
  const [row] = await db.select().from(homeWords).where(and(eq(homeWords.projectId, projectId))).limit(1);
  if (!row?.approvedAt) return null;
  return { source: row.source as HomeWordsSource, sections: row.sections, testimonials: row.testimonials };
}

/* Why Generate waits for the words (Lane 1), or null. */
export async function homeWordsBlocked(db: Db, projectId: string): Promise<string | null> {
  const [proj] = await db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (proj?.lane === "lane_2") return null;
  await ensureKeptPlan(db, projectId);
  const kept = await keptHomeWords(db, projectId);
  if (kept) return keptHomeWordsBlocker(kept);
  return (await approvedHomeWords(db, projectId)) ? null : "Use the Home page words first: the concepts are built with them, section by section.";
}

