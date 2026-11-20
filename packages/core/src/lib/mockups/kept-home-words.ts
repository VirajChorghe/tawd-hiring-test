import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../../db";
import { pageDraft, pagePlanPage, siteImport } from "../../db/schema";
import { keepSiteUrl, readIsStale, savedImportBotCheck, type KeptPlanNote, type PlanWork } from "../site/site-read";
import { homeWordsFromKeptPage, type HomeWords } from "./home-words";

/*
  Makeovers skip the Home words step (Jason, 6 October 2026). When the
  intake says "Keep all content as is" (Lane 1, a current website), the
  concepts use the Home page's latest words on Content, as they are: one
  source, so an edit on Content is what the concepts get.

  Since 0.96.0 (docs/plans/flow-a-one-read.md) the page plan makes itself
  when the read finishes, so Generate waits only while the site is being
  read, when the read failed, or when a plan with work needs the team's one
  decision on Content. Shared by the web app (the card, the gate) and the
  worker (the run).
*/

type Db = Database;

export type KeptHomeWordsState = "reading" | "failed" | "needs_decision" | "ready";

export interface KeptHomeWords {
  state: KeptHomeWordsState;
  /** Why the read failed (the Intake panel says the same). */
  failure: string | null;
  /** When the read finished (the failed card's date). */
  readAt: Date | null;
  words: HomeWords | null;
  /** The Home page's version on Content the words come from. */
  version: number | null;
  /** needs_decision: what replacing the plan would delete. */
  work: PlanWork | null;
}

export { savedImportBotCheck };

/* null: not a makeover (the Home words card works as before). */
export async function keptHomeWords(db: Db, projectId: string): Promise<KeptHomeWords | null> {
  if (!(await keepSiteUrl(db, projectId))) return null;
  const [read] = await db.select().from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const empty = { failure: null, readAt: null, words: null, version: null, work: null };
  if (!read) return { state: "failed", ...empty, failure: "TAWD hasn't read the current site yet. Read it on the intake's Website section." };
  if ((read.status === "queued" || read.status === "working") && !readIsStale(read)) return { state: "reading", ...empty };
  const readAt = read.finishedAt ?? read.homeReadAt ?? null;
  if (read.status === "needs_consent") return { state: "failed", ...empty, readAt, failure: `${read.failureReason ?? "The site blocks TAWD's server."} Reading it through a paid service costs about $${(read.consentEstimateUsd ?? 0).toFixed(2)}: give the go on the intake's Website section.` };
  if (read.status === "queued" || read.status === "working") return { state: "failed", ...empty, readAt, failure: "The read was cut off before it finished. Read again on the intake's Website section." };
  const blocked = savedImportBotCheck(read);
  if (read.status === "failed" || blocked) return { state: "failed", ...empty, readAt, failure: blocked ?? read.failureReason };
  const plan = read.keptPlan as KeptPlanNote | null;
  if (!read.usedAt) {
    if (plan?.status === "needs_decision") return { state: "needs_decision", ...empty, readAt, work: plan.decision };
    // Done but no plan could be made (Fable's review L6): say why, with the way forward on Intake.
    const pages = read.pages as { gap?: boolean }[];
    const failure = read.source === "home-only" || !pages.some((p) => !p.gap)
      ? "Only the home page was read, so there are no pages to keep yet. Read every page on the intake's Website section."
      : plan?.status === "missing"
        ? "The kept pages are missing from storage. Read the site again on the intake's Website section."
        : plan?.status === "failed"
          ? `TAWD couldn't make the page plan from the current site (${plan.message ?? "unknown"}). Read again on the intake's Website section.`
          : "TAWD is making the page plan from the current site. Look again in a moment.";
    return { state: plan?.status === "missing" || plan?.status === "failed" || failure.startsWith("Only") ? "failed" : "reading", ...empty, readAt, failure };
  }

  const [home] = await db.select({ id: pagePlanPage.id }).from(pagePlanPage).where(and(eq(pagePlanPage.projectId, projectId), eq(pagePlanPage.kind, "home"))).limit(1);
  const noHome = { state: "failed" as const, ...empty, readAt, failure: "The page plan has no Home page with words. Add the Home page back on Content." };
  if (!home) return noHome;
  // The newest words the team stands behind: the current site's, a hand edit, or an approved version. An improved version
  // (Design + content) waits for Content's approval before the concepts use it (Fable's review M6).
  const done = await db
    .select({ version: pageDraft.version, body: pageDraft.body, source: pageDraft.source, approvedAt: pageDraft.approvedAt })
    .from(pageDraft)
    .where(and(eq(pageDraft.pageId, home.id), eq(pageDraft.status, "done")))
    .orderBy(desc(pageDraft.version));
  const draft = done.find((d) => d.approvedAt || d.source === "kept" || d.source === "edit");
  if (!draft?.body?.trim()) return noHome;
  const words = homeWordsFromKeptPage(draft.body);
  if (!words.sections.length) return noHome;
  return { state: "ready", failure: null, readAt, words, version: draft.version, work: null };
}

/* Why Generate waits, for a makeover; null when the words are ready. */
export function keptHomeWordsBlocker(kept: KeptHomeWords): string | null {
  switch (kept.state) {
    case "ready":
      return null;
    case "reading":
      return "TAWD is still reading the current site (the intake's Website section): the concepts use its Home page.";
    case "needs_decision":
      return "The page plan has work that isn't from the current site: decide on Content whether to replace it with the current site's pages.";
    default:
      return "The current site couldn't be read: the intake's Website section says what to do.";
  }
}
