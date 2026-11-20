import { CACHE_1H, REVIEW_UNFINISHED, houseRuleHoldReason } from "@tawd/core/mockups";
import { and, asc, desc, eq, isNotNull, like } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { aiCall, concept, conceptStep, conceptVersion, mockupRun, polishPass } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import type { ReviewJobData } from "@tawd/core/queue";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import {
  ReviewFormatError,
  allNotes,
  bandsForNote,
  markBands,
  splitSections,
  buildReviewUserText,
  buildReviewerSystemPrompt,
  describeChecks,
  describeFactsForPrompt,
  holdReason,
  htmlForReview,
  meetsShowScore,
  SHOW_SCORE,
  isFixable,
  readReviewAnswer,
  reviewJsonSchemaFor,
  type CheckIssue,
  type DirectionId,
  type ReviewPass,
  type SkillId,
  type StoredReview,
  isGeneratedConcept,
  describeRepeatedPhotos,
  describeRichness,
  measureRichness,
  mergeRunNotes,
  readRunNotes,
  richnessMustFix,
  type CountedRunNote,
} from "@tawd/core/mockups";

import { imageBlock } from "./image-type";
import { callMs, type Usage } from "./claude";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import {
  CODE_FIXABLE,
  applyCodeFixes,
  SectionEditError,
  editBySections,
  checkEverything,
  conceptContext,
  describeFixes,
  finalizeRun,
  loadProjectContext,
  readSavedResponse,
  recordCall,
  runFixRounds,
  savedText,
  setStep,
  sourceKeyFor,
  storeVersion,
  withImages,
  type CheckResult,
  type ConceptContext,
  type Db,
  type ProjectContext,
  type Storage,
  type VersionReviewRecord,
  type VersionStage,
} from "./pipeline";
import { renderForReview, renderThumbnail } from "./render";
import { markPolishFailed, runPolishJob } from "./polish";

/*
  The Creative Director, once every concept in a run is built.

  skills/CREATIVE-DIRECTOR.md, followed as a fixed, bounded sequence:

    1. review:   one call scores every concept side by side
    2. improve:  one builder round per concept applies its notes, then the
                 mechanical checks (and their fix rounds) run again
    3. re-score: one call scores them all again
    4. any question still under 3: that concept is rebuilt once from
       scratch with the notes, and scored once more
    5. still under 3: stop, and flag it to the PM

  There is no loop anywhere in this file: each step runs once, and the
  rebuild runs at most once per concept.
*/

/*
  The job's shape and name live in the core package, shared with the web
  app's "Run the review again". With retry set: only the concepts whose
  review is missing, each from where it stopped, and never a rebuild from
  scratch; a concept still under 3 is flagged for the PM instead.
*/
export { REVIEW_JOB, reviewJobId } from "@tawd/core/queue";
export type ReviewJob = ReviewJobData;

/*
  Where each concept is in the review: waiting for its first score, for its
  improvement round, for its re-score, finished, or stopped by a failure.
*/
type ReviewStage = "first" | "improve" | "after" | "done" | "failed";

export interface Working {
  ctx: ConceptContext;
  /** The latest version: its number, row id, and page source. */
  version: number;
  versionId: string;
  html: string;
  outcome: CheckResult | null;
  checksSummary: string;
  /* What code changed on this version, from checks.runNotes: given to the reviewer so it never asks the builder to undo them. */
  runNotes: CountedRunNote[];
  rebuilt: boolean;
  lastReview: StoredReview | null;
  stage?: ReviewStage;
  /** The first score, kept for "(was 3.6)" and the notes it asked for. */
  firstReview?: StoredReview | null;
  failure?: string | null;
  /** False for versions stored before sources were kept: never re-checked or fixed. */
  fromSource?: boolean;
  /*
    A review read from an answer already paid for, on "Run the review
    again": used for its pass instead of a new call, and stored on the
    version it scored.
  */
  recovered?: { pass: ReviewPass; versionId: string; review: StoredReview } | null;
}

async function isStopped(db: Db, runId: string): Promise<boolean> {
  const [run] = await db
    .select({ status: mockupRun.status })
    .from(mockupRun)
    .where(eq(mockupRun.id, runId))
    .limit(1);
  return !run || run.status === "stopped";
}

/*
  Where a concept's review stands, from what is stored: every pass on every
  version, and the latest version's stage. Used by "Run the review again".
*/
function stageFromStored(
  versions: { version: number; review: unknown; checks: unknown }[],
): { stage: ReviewStage; first: StoredReview | null; last: StoredReview | null } {
  const ascending = [...versions].sort((a, b) => a.version - b.version);
  const passesOf = (v: (typeof ascending)[number]) => ((v.review ?? {}) as VersionReviewRecord).passes ?? [];
  const passes = ascending.flatMap(passesOf);
  const first = passes.find((p) => p.pass === "first") ?? null;
  const last = passes.at(-1) ?? null;
  if (!first) return { stage: "first", first: null, last: null };
  if (passes.some((p) => p.pass === "after" || p.pass === "rebuild")) return { stage: "done", first, last };
  /*
    Improved already (the notes went in), so only the re-score is missing.
    Any improved version after the first score counts, not just the
    newest: fix rounds, or a free code fix, may have followed it.
  */
  const firstVersion = ascending.find((v) => passesOf(v).some((p) => p.pass === "first"))!.version;
  const improved = ascending.some(
    (v) => v.version > firstVersion && ((v.checks ?? {}) as { stage?: string }).stage === "cd_improve",
  );
  return { stage: improved ? "after" : "improve", first, last };
}

export async function runReviewJob(
  job: ReviewJob,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  if (await isStopped(db, job.runId)) return;

  const readyConcepts = await db
    .select()
    .from(concept)
    .where(eq(concept.runId, job.runId))
    .orderBy(asc(concept.label));
  // Concept 1 on an Option B project is the designer's design: it has its own review, never this pass.
  // A supplied homepage (HTML) is never reviewed or changed by AI either: no skill built it, and none could revise it.
  // "Run the review again" also takes a concept held because its review didn't finish (B4); stageFromStored skips any already reviewed.
  const concepts = readyConcepts.filter(
    (c) => (c.status === "ready" || (job.retry && c.status === "held" && (c.failureReason ?? "").startsWith(REVIEW_UNFINISHED))) && isGeneratedConcept(c.skillId),
  );
  if (concepts.length === 0) {
    await finalizeRun(job.runId);
    return;
  }

  const project = await loadProjectContext(db, storage, browser, config, job);
  const creativeDirector = await readFile(
    path.resolve(config.skillsDir, "CREATIVE-DIRECTOR.md"),
    "utf8",
  );

  const working: Working[] = [];
  for (const row of concepts) {
    const ctx = await conceptContext(project, config, {
      conceptId: row.id,
      label: row.label,
      direction: row.direction as DirectionId,
      skillId: row.skillId as SkillId,
    });
    const versions = await db
      .select()
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, row.id))
      .orderBy(desc(conceptVersion.version));
    const latest = versions[0];
    if (!latest?.htmlKey) continue;

    const stored = job.retry ? stageFromStored(versions) : { stage: "first" as ReviewStage, first: null, last: null };

    const checks = (latest.checks ?? {}) as {
      passed?: boolean;
      issues?: { severity: string; needsIntake?: boolean }[];
    };
    const fromSource = (await storage.get(sourceKeyFor(latest.htmlKey))) !== null;
    working.push({
      ctx,
      version: latest.version,
      versionId: latest.id,
      fromSource,
      html: await readSource(storage, latest.htmlKey),
      outcome: null,
      checksSummary:
        checks.passed === false
          ? `${(checks.issues ?? []).filter((i) => i.severity === "fail" && !i.needsIntake).length} still failing`
          : "All passed",
      runNotes: readRunNotes(latest.checks),
      rebuilt: false,
      lastReview: stored.last,
      firstReview: stored.first,
      stage: stored.stage,
      failure: null,
    });
  }
  if (working.length === 0) {
    await finalizeRun(job.runId);
    return;
  }

  const reviewer = { db, project, config, client, browser, creativeDirector };
  /*
    How many concepts the RUN has, counted as polish.ts and changes.ts
    count it (12 November 2026, CodeRabbit on PR #75). `working` leaves out
    an Option B run's designer concept and any that failed, so on a run of
    the designer's design and one alternative it held one concept, and the
    first and after passes marked Direction fit "Not applicable: this run
    has only one concept to compare" while polish and changes scored it.
  */
  const conceptsInRun = readyConcepts.length;

  if (job.retry) {
    /*
      "Run the review again", before any AI: first any answer already paid
      for is read again with today's reader; then the free checks run
      again with today's checker, and the free code fixes are applied.
    */
    for (const w of working) {
      if (w.stage === "first" || w.stage === "after") {
        w.recovered = await recoverSavedReview(db, job.runId, w, w.stage, conceptsInRun);
      }
    }
    await recheckAll(db, storage, reviewer, job.projectId, working);
  }

  /*
    Only the step that actually stopped is marked as not finished; the ones
    after it never started, so they read "Not run" in grey (Jason,
    9 November 2026: one problem used to paint three cells, which made a
    single stopped step look like a catastrophe).
  */
  const fail = async (w: Working, pass: ReviewPass, reason: string, step: string) => {
    w.stage = "failed";
    w.failure = reason;
    await markConceptReviewFailed(db, w.versionId, pass, reason);
    await setStep(db, w.ctx.conceptId, step, "failed", `Review didn't finish: ${reason}`);
    for (const later of ["improve", "final_checks"].slice(step === "review" ? 0 : 1)) {
      if (later !== step) {
        await setStepIfUnsettled(db, w.ctx.conceptId, later, `Not run: the ${step} step stopped first`, `Didn't finish: the ${step} step stopped while this was running`);
      }
    }
  };

  /* ---------- 1. the first score, one concept at a time ---------- */

  const firsts = working.filter((w) => w.stage === "first");
  for (const w of firsts) {
    await setStep(db, w.ctx.conceptId, "review", "working", "Reviewing");
  }
  const first = await reviewEach(reviewer, "first", 1, firsts, working, { conceptsInRun });
  for (const w of firsts) {
    const review = first.results.get(w.ctx.label);
    if (!review) {
      await fail(w, "first", first.failures.get(w.ctx.label) ?? "The review did not finish.", "review");
      continue;
    }
    w.lastReview = review;
    w.firstReview = review;
    await attachReview(db, scoredVersion(w, "first"), review);
    await setStep(db, w.ctx.conceptId, "review", "done", scoreLine(review));
    // At 4.5 or above on the first score, nothing to rewrite (8 October 2026): straight on.
    if (meetsShowScore(review)) {
      w.stage = "done";
      await setStep(db, w.ctx.conceptId, "improve", "skipped", `Scored ${formatAverage(review.average)}: ${SHOW_SCORE} or above, nothing to rewrite`);
      await setStep(db, w.ctx.conceptId, "final_checks", "done", scoreLine(review));
    } else {
      w.stage = "improve";
    }
  }

  if (await isStopped(db, job.runId)) return;

  /* ---------- 2. one improvement round on the notes ---------- */

  for (const w of working.filter((w) => w.stage === "improve")) {
    w.stage = "after";
    const notes = allNotes(w.lastReview!);
    if (notes.length === 0) {
      await setStep(db, w.ctx.conceptId, "improve", "skipped", "No notes to apply");
      continue;
    }

    await setStep(
      db,
      w.ctx.conceptId,
      "improve",
      "working",
      `Applying ${notes.length} note${notes.length === 1 ? "" : "s"}`,
    );

    /*
      Only the bands the notes are about. Each note names its band; one
      that does not (a review stored before bands were numbered) is placed
      by its section name, or else by one small call.
    */
    const sections = splitSections(w.html);
    const placed = notes.map((n) => ({ note: n, parts: bandsForNote(n, sections) }));
    let edited: { html: string; parts: number[] };
    try {
      edited = await editBySections(db, w.ctx, config, client, {
        step: "improve",
        html: w.html,
        request: `# Creative Director notes\n\n${notes.map((n) => `- **${n.question}** (band ${n.band ?? "?"}): ${n.note}`).join("\n")}`,
        known: placed.flatMap((p) => p.parts ?? []),
        unplaced: placed
          .filter((p) => p.parts === null)
          .map((p) => `- ${p.note.note}`)
          .join("\n"),
      });
    } catch (error) {
      if (!(error instanceof SectionEditError)) throw error;
      await setStep(db, w.ctx.conceptId, "improve", "failed", `The improvement was not made: ${error.message}`);
      continue;
    }

    const stored = await checkFixAndStore(db, storage, reviewer, w, {
      conversation: [
        { role: "user", content: w.ctx.opening() },
        { role: "assistant", content: edited.html },
      ],
      html: edited.html,
      stage: "cd_improve",
      stepName: "improve",
    });
    await setStep(db, w.ctx.conceptId, "improve", "done", stored);
  }

  if (await isStopped(db, job.runId)) return;

  /* ---------- 3. the re-score, one concept at a time ---------- */

  const afters = working.filter((w) => w.stage === "after");
  for (const w of afters) {
    await setStep(db, w.ctx.conceptId, "final_checks", "working", "Re-scoring");
  }
  const after = await reviewEach(reviewer, "after", 2, afters, working, {
    earlierNotes: new Map(afters.map((w) => [w.ctx.label, allNotes(w.firstReview ?? w.lastReview!)])),
    conceptsInRun,
  });
  for (const w of afters) {
    const review = after.results.get(w.ctx.label);
    if (!review) {
      await fail(w, "after", after.failures.get(w.ctx.label) ?? "The re-score did not finish.", "final_checks");
      continue;
    }
    w.lastReview = review;
    w.stage = "done";
    await attachReview(db, scoredVersion(w, "after"), review);
  }

  /*
    No rebuild, ever (Jason, 8 October 2026): one rewrite of the parts the
    notes are about and one re-score. Whether it is shown is decided after
    the polish, below.
  */
  for (const w of afters.filter((x) => x.stage === "done")) {
    await setStep(
      db,
      w.ctx.conceptId,
      "final_checks",
      "done",
      `${scoreLine(w.lastReview!)} (was ${formatAverage(w.firstReview?.average ?? null)})`,
    );
  }

  /* ---------- 6. critique then polish, once per concept (27 September 2026) ---------- */

  const [runRow] = await db
    .select({ polish: mockupRun.polish, startedByUserId: mockupRun.startedByUserId })
    .from(mockupRun)
    .where(eq(mockupRun.id, job.runId))
    .limit(1);
  // Not on "Run the review again", and not when the PM skipped it for this run.
  if (!job.retry && runRow?.polish) {
    for (const w of working.filter((x) => x.stage !== "failed" && x.lastReview)) {
      if (await isStopped(db, job.runId)) return;
      await polishInRun(db, config, client, browser, job.projectId, w, runRow.startedByUserId);
    }
  }

  /*
    The gate (Jason, 8 October 2026): "I want to see 4.5/5 or above". A
    concept whose newest score (after any polish) is under 4.5, or that has
    a must-fix, is held: it isn't shown to the PM or the client, and the
    step says why. An admin can Show it anyway.
  */
  /*
    B4 (audit F-017, 12 November 2026): the gate also holds a concept that
    still breaks a house rule (a phone number the client never gave was
    shown with a 5.0), and one whose review didn't finish, which used to
    stay "ready" with no score at all. "Run the review again" picks the
    second kind up (conceptsMissingReview), and once it is reviewed the
    hold is lifted here.
  */
  const held: Working[] = [];
  for (const w of working) {
    if (w.stage === "failed") {
      held.push(w);
      await db
        .update(concept)
        .set({ status: "held", failureReason: `${REVIEW_UNFINISHED} (${w.failure ?? "it stopped"}). Run the review again.` })
        .where(eq(concept.id, w.ctx.conceptId));
      continue;
    }
    const latest = (await latestReviewOf(db, w.ctx.conceptId)) ?? w.lastReview;
    const [newest] = await db
      .select({ checks: conceptVersion.checks })
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, w.ctx.conceptId))
      .orderBy(desc(conceptVersion.version))
      .limit(1);
    const houseRule = houseRuleHoldReason(((newest?.checks ?? {}) as { issues?: CheckIssue[] }).issues ?? []);
    const lowScore = latest && !meetsShowScore(latest) ? holdReason(latest) : null;
    if (!houseRule && !lowScore) {
      // Held only because its review hadn't finished, and now it has: shown again.
      await db
        .update(concept)
        .set({ status: "ready", failureReason: null })
        .where(and(eq(concept.id, w.ctx.conceptId), eq(concept.status, "held"), like(concept.failureReason, `${REVIEW_UNFINISHED}%`)));
      continue;
    }
    held.push(w);
    const reason = [houseRule, lowScore].filter(Boolean).join(" It also ");
    await db.update(concept).set({ status: "held", failureReason: reason }).where(eq(concept.id, w.ctx.conceptId));
    await setStep(db, w.ctx.conceptId, "final_checks", "failed", `Held: ${reason}`);
  }
  const flagged = held;
  const failed = working.filter((w) => w.stage === "failed");
  await recordActivity(db, {
    action: "mockups.review_finished",
    entityType: "project",
    entityId: job.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      concepts: working.map((w) => ({
        concept: w.ctx.label,
        average: w.lastReview?.average ?? null,
        lowest: w.lastReview?.lowest ?? null,
        rebuilt: w.rebuilt,
        ...(w.failure ? { failed: w.failure } : {}),
      })),
      held: flagged.map((w) => w.ctx.label),
      ...(job.retry ? { retry: true } : {}),
    },
    ipAddress: null,
    userAgent: null,
  });

  await finalizeRun(
    job.runId,
    failed.length > 0
      ? { reviewFailed: failed.map((w) => `Concept ${w.ctx.label}: ${w.failure}`).join(" ") }
      : {},
  );
}

/*
  One concept's critique and polish inside the run. A polish that fails
  never fails the run: the concept keeps its reviewed version, and the
  step's note says what happened.
*/
async function polishInRun(
  db: Db,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
  projectId: string,
  w: Working,
  startedByUserId: string | null,
): Promise<void> {
  const [step] = await db
    .select({ status: conceptStep.status, detail: conceptStep.detail })
    .from(conceptStep)
    .where(and(eq(conceptStep.conceptId, w.ctx.conceptId), eq(conceptStep.step, "final_checks")))
    .limit(1);
  const [latest] = await db.select({ version: conceptVersion.version }).from(conceptVersion).where(eq(conceptVersion.conceptId, w.ctx.conceptId)).orderBy(desc(conceptVersion.version)).limit(1);
  if (!latest) return;
  const [pass] = await db
    .insert(polishPass)
    .values({ projectId, conceptId: w.ctx.conceptId, fromVersion: latest.version, estimate: "Part of the run", requestedByUserId: startedByUserId })
    .returning({ id: polishPass.id });
  const status = step?.status ?? "done";
  const detail = step?.detail ?? "";
  await setStep(db, w.ctx.conceptId, "final_checks", "working", `${detail ? `${detail}; ` : ""}critique and polish`);
  let note: string;
  try {
    await runPolishJob({ passId: pass!.id, projectId, conceptId: w.ctx.conceptId }, config, client, browser);
    const [done] = await db.select().from(polishPass).where(eq(polishPass.id, pass!.id)).limit(1);
    const before = (done?.before as { average?: number | null } | null)?.average ?? null;
    const after = (done?.after as { average?: number | null; version?: number } | null) ?? null;
    note = done?.toVersion ? `polished in v${done.toVersion} (${formatAverage(before)} to ${formatAverage(after?.average ?? null)})` : "polish found nothing to change";
  } catch (error) {
    const message = error instanceof Error ? error.message : "The critique and polish did not finish.";
    await markPolishFailed(pass!.id, message);
    note = `polish didn't finish: ${message}`;
  }
  await setStep(db, w.ctx.conceptId, "final_checks", status, `${detail ? `${detail}; ` : ""}${note}`);
}

/* ---------- the reviewer's call ---------- */

export interface Reviewer {
  db: Db;
  project: ProjectContext;
  config: WorkerConfig;
  client: Anthropic;
  browser: Browser;
  creativeDirector: string;
}

/*
  Each concept in its own call (Jason, 25 September 2026): one combined
  call once came back without Concept A and the whole review was lost.
  Now each concept's review is kept the moment it arrives, and only a
  concept whose call failed is retried, once. The other concepts in the
  run come along as small first-screen images, so question 2 ("does it
  read differently from the others?") can still be answered.
*/
export async function reviewEach(
  reviewer: Reviewer,
  pass: ReviewPass,
  round: number,
  targets: Working[],
  all: Working[],
  /*
    conceptsInRun: how many concepts the RUN has, which is not always how
    many this pass reviews (Jason's run, 10 November 2026). A polish pass
    and a changes pass each review one concept on its own, and passing
    `all` as the measure made question 2 - Direction fit - come back "Not
    applicable: this run has only one concept to compare" on a two-concept
    run, throwing one of the eleven questions away and saying something
    untrue on the concept screen.
  */
  options: { earlierNotes?: Map<string, { question: string; note: string }[]>; conceptsInRun?: number } = {},
): Promise<{ results: Map<string, StoredReview>; failures: Map<string, string> }> {
  const results = new Map<string, StoredReview>();
  const failures = new Map<string, string>();
  if (targets.length === 0) return { results, failures };

  // Thumbnails of every concept in the run, made once per pass.
  const thumbnails = new Map<string, Buffer>();
  // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- compares review pass numbers, not secrets
  const calling = targets.some((t) => t.recovered?.pass !== pass);
  if (all.length > 1 && calling) {
    for (const w of all) {
      const shots = await renderForReview(reviewer.browser, withImages(w.html, reviewer.project.assets, reviewer.project.stock));
      thumbnails.set(w.ctx.label, await renderThumbnail(reviewer.browser, shots.fold));
    }
  }

  for (const target of targets) {
    // Already read from a saved answer: no new call.
    // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- compares review pass numbers, not secrets
    if (target.recovered?.pass === pass) {
      results.set(target.ctx.label, target.recovered.review);
      continue;
    }
    try {
      const review = await reviewOne(reviewer, pass, round, target, all, thumbnails, options.earlierNotes?.get(target.ctx.label), options.conceptsInRun ?? all.length);
      results.set(target.ctx.label, review);
    } catch (error) {
      failures.set(target.ctx.label, error instanceof Error ? error.message : "The review did not finish.");
    }
  }
  return { results, failures };
}

async function reviewOne(
  reviewer: Reviewer,
  pass: ReviewPass,
  round: number,
  target: Working,
  all: Working[],
  thumbnails: Map<string, Buffer>,
  earlierNotes: { question: string; note: string }[] | undefined,
  /* The run's own concept count: see reviewEach. Not always all.length. */
  conceptsInRun: number,
): Promise<StoredReview> {
  const { db, project, config, client, browser } = reviewer;
  const label = target.ctx.label;
  const others = all.filter((w) => w.ctx.label !== label);

  // The client's reference sites first (the bar to meet), then this concept at full size, then the others small, each labeled.
  const content: Anthropic.ContentBlockParam[] = [];
  project.likedSites.forEach((site, index) => {
    content.push({ type: "text", text: `Reference site ${index + 1} (${site.url}): its first screen, for comparison only.` });
    /*
      The reference screens are the same pictures in every Creative
      Director call of a run - every concept, every pass - and they are the
      largest block in the message, so the last of them closes a cached
      prefix (Jason's spend screen, 10 November 2026: this step was 42% of
      the run's cost at an 11% cache rate, while its system prompt, which
      was already cached, read far higher).

      Only this prefix. The eleven questions and the intake facts are
      stable too, but they are written after the concept's own screenshots,
      and moving them in front of the pictures to make them cacheable would
      change what the reviewer reads first: a change to how TAWD judges a
      design, made for a billing reason. The pictures are the saving worth
      having; the rest waits for a measurement.
    */
    const lastReference = index === project.likedSites.length - 1;
    content.push(lastReference ? { ...jpeg(site.image), cache_control: CACHE_1H } : jpeg(site.image));
  });
  const shots = await renderForReview(browser, withImages(target.html, project.assets, project.stock));
  content.push({ type: "text", text: `Concept ${label}: first screen at 1440 by 900.` });
  content.push(jpeg(shots.fold));
  shots.slices.forEach((slice, index) => {
    content.push({
      type: "text",
      text: `Concept ${label}: full page, part ${index + 1} of ${shots.slices.length}${
        shots.heightPx > 12_000 ? " (the page continues beyond this)" : ""
      }.`,
    });
    content.push(jpeg(slice));
  });
  for (const other of others) {
    const thumb = thumbnails.get(other.ctx.label);
    if (!thumb) continue;
    content.push({ type: "text", text: `Concept ${other.ctx.label} (for comparison only): its first screen, small.` });
    content.push(jpeg(thumb));
  }

  const facts = describeFactsForPrompt(project.intakeFacts);
  const richness = measureRichness(target.html, project.intake.data.brand.colors, project.stock?.filled(target.html));
  const mustFix = richnessMustFix(richness);
  content.push({
    type: "text",
    text: buildReviewUserText({
      pass,
      designerNotes: project.intake.data.photos.notes,
      factsKnown: facts.known,
      // Split, so the reviewer knows which gaps get a placeholder and which are left out (8 October 2026).
      factsMissing: `Required (a designed placeholder is right):\n${facts.required}\n\nOptional (left out: a placeholder, card or section for one is a fault):\n${facts.detail}`,
      concepts: [
        {
          label,
          direction: target.ctx.direction,
          checksSummary: target.checksSummary,
          html: htmlForReview(markBands(target.html)),
          earlierNotes,
          /*
            The forced repeat is said in the same breath (11 November
            2026): with nothing of the client's unused, code leaves a
            repeated photograph where it is, and the reviewer was marking
            the concept down for a choice nobody made.
          */
          measured: {
            line: [describeRichness(richness), describeRepeatedPhotos(target.html, project.assets.filter((a) => a.kind === "photo").map((a) => a.token))]
              .filter(Boolean)
              .join("; "),
            mustFix,
          },
          runNotes: target.runNotes,
        },
      ],
      references: project.likedSites.map((s) => s.url),
      referenceNotes: Object.fromEntries(project.references.map((r) => [r.url, r.liked ?? ""])),
      others: others.map((o) => ({ label: o.ctx.label, direction: o.ctx.direction })),
      conceptsInRun,
    }),
  });

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildReviewerSystemPrompt(reviewer.creativeDirector, project.profileText),
      cache_control: CACHE_1H,
    },
  ];

  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];

  /*
    Every answer is saved (recordCall) before anything reads it. Reading
    tries the plain JSON first, then recovers it from the saved text with
    no new call. Only if both fail is there one retry, and it never asks
    the same thing again: it says exactly what was wrong and what is
    expected, and an answer that ran out of room gets twice the room. The
    same failure twice, or a refusal, is never retried.
  */
  // The label is pinned to this concept's letter.
  const schema = reviewJsonSchemaFor([label]);
  // One concept: eight questions with notes fit with a wide margin, thinking included.
  let maxTokens = 32_000;
  let previousFailure: string | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const model = await stepModel(db, "review");
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      ...requestSettings(model, { effort: config.effort, adaptiveThinking: true, format: { type: "json_schema", schema } }),
    });
    const response = await stream.finalMessage();

    await recordCall(db, {
      projectId: project.projectId,
      runId: project.runId,
      // Charged to the concept it reviewed.
      conceptId: target.ctx.conceptId,
      startedByUserId: project.startedByUserId,
      model,
      step: "review",
      round,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
      versionId: target.versionId,
      label,
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`The reviewer declined (${response.stop_details?.category ?? "no category"}).`);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let failure: ReviewFormatError;
    try {
      // Marks question 2 "not applicable" for a one-concept run.
      const read = readReviewAnswer(text, label, pass, conceptsInRun);
      return mustFix.length > 0 ? { ...read, mustFix } : read;
    } catch (error) {
      if (!(error instanceof ReviewFormatError)) throw error;
      failure =
        response.stop_reason === "max_tokens"
          ? new ReviewFormatError(
              "The review ran out of room before it finished.",
              "That answer ran out of room before it finished. Keep each reason to one sentence and each note short, and reply with the complete JSON.",
            )
          : error;
    }

    if (attempt === 2 || failure.message === previousFailure) {
      throw new Error(`The review could not be used: ${failure.message}`, { cause: failure });
    }
    previousFailure = failure.message;
    if (response.stop_reason === "max_tokens") maxTokens = 64_000;
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: `That answer could not be used. ${failure.retryHint}` });
  }

  throw new Error("The review could not be completed.");
}

/* ---------- before "Run the review again" pays for anything ---------- */

/** The version a pass's review belongs on: the one it scored. */
function scoredVersion(w: Working, pass: ReviewPass): string {
  return w.recovered?.pass === pass ? w.recovered.versionId : w.versionId;
}

/*
  The newest saved answer for this concept's missing pass that can now be
  read, if any. Only an answer about this exact version is used, so a
  score is never moved onto a page it did not see.
*/
export async function recoverSavedReview(
  db: Db,
  runId: string,
  w: Working,
  pass: "first" | "after",
  conceptsInRun: number,
): Promise<Working["recovered"]> {
  const rows = await db
    .select({ responseKey: aiCall.responseKey })
    .from(aiCall)
    .where(
      and(
        eq(aiCall.runId, runId),
        eq(aiCall.conceptId, w.ctx.conceptId),
        eq(aiCall.step, "review"),
        eq(aiCall.round, pass === "first" ? 1 : 2),
        isNotNull(aiCall.responseKey),
      ),
    )
    .orderBy(desc(aiCall.createdAt));

  for (const row of rows) {
    const saved = await readSavedResponse(row.responseKey!);
    if (!saved || saved.versionId !== w.versionId) continue;
    try {
      // Read as saved: a Direction fit left null when this pass counted one concept is kept as not scored.
      const review = readReviewAnswer(savedText(saved), w.ctx.label, pass, conceptsInRun, new Date(saved.savedAt), true);
      return {
        pass,
        versionId: w.versionId,
        review: { ...review, readAs: [...(review.readAs ?? []), "read again from the saved answer, with no new call"] },
      };
    } catch {
      // Still unreadable: try an older one, then pay for a new call.
    }
  }
  return null;
}

/*
  The mechanical checks again, with today's checker, on each concept's
  newest version: free, so old false alarms clear without any AI. The
  results replace that version's stored checks. Then the free code fixes
  (contrast, title and description length, logo treatment) - never an AI
  fix round. A fix changes the page, so it is stored as a new version.
*/
export async function recheckAll(
  db: Db,
  storage: Storage,
  reviewer: Reviewer,
  projectId: string,
  working: Working[],
): Promise<void> {
  const { browser, project } = reviewer;
  const results: { concept: string; before: number; after: number; codeFixes: string[] }[] = [];

  for (const w of working) {
    // Old versions without a kept source: the images are gone from the
    // text, so checking or fixing it would judge a broken page.
    if (w.fromSource === false) continue;

    const [row] = await db
      .select({ checks: conceptVersion.checks })
      .from(conceptVersion)
      .where(eq(conceptVersion.id, w.versionId))
      .limit(1);
    const stored = (row?.checks ?? {}) as Record<string, unknown> & { issues?: CheckIssue[] };
    const failingBefore = (stored.issues ?? []).filter(isFixable).length;

    let outcome = await checkEverything(browser, w.html, project.facts, project.assets, project.stock, w.ctx.direction);
    await db
      .update(conceptVersion)
      .set({
        checks: {
          ...stored,
          passed: outcome.passed,
          issues: outcome.issues,
          needsIntake: outcome.needsIntake,
          recheckedAt: new Date().toISOString(),
        },
        placeholderCount: outcome.placeholderCount,
      })
      .where(eq(conceptVersion.id, w.versionId));

    let codeFixes: string[] = [];
    if (outcome.issues.some((issue) => CODE_FIXABLE.has(issue.id))) {
      const coded = await applyCodeFixes(browser, w.html, outcome, project.assets, project.facts);
      if (coded.html !== w.html) {
        outcome = await checkEverything(browser, coded.html, project.facts, project.assets, project.stock, w.ctx.direction);
        w.version += 1;
        w.versionId = await storeVersion(db, storage, {
          stock: project.stock,
          conceptId: w.ctx.conceptId,
          projectId,
          version: w.version,
          html: coded.html,
          assets: project.assets,
          browser,
          outcome,
          stage: "fix",
          codeFixes: coded.fixed,
          runNotes: coded.notes,
        });
        w.html = coded.html;
        w.runNotes = mergeRunNotes(w.runNotes, coded.notes);
        codeFixes = coded.fixed;
      }
    }

    w.outcome = outcome;
    w.checksSummary = describeChecks(outcome);
    // "needs_fixes": the step finished with fixes outstanding, which is not a failure (see checks.ts).
    await setStep(
      db,
      w.ctx.conceptId,
      "checks",
      outcome.passed ? "done" : "needs_fixes",
      `Checked again: ${describeFixes(outcome, 0, codeFixes)}`,
    );
    results.push({
      concept: w.ctx.label,
      before: failingBefore,
      after: outcome.issues.filter(isFixable).length,
      codeFixes,
    });
  }

  if (results.length > 0) {
    await recordActivity(db, {
      action: "mockups.checks_rerun",
      entityType: "project",
      entityId: projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { concepts: results },
      ipAddress: null,
      userAgent: null,
    });
  }
}

/* ---------- improving and rebuilding ---------- */

export async function checkFixAndStore(
  db: Db,
  storage: Storage,
  reviewer: Reviewer,
  w: Working,
  input: {
    conversation: Anthropic.MessageParam[];
    html: string;
    stage: VersionStage;
    stepName: string;
  },
): Promise<string> {
  const { config, client, browser, project } = reviewer;

  const outcome = await checkEverything(browser, input.html, project.facts, project.assets, project.stock, w.ctx.direction);
  w.version += 1;
  w.versionId = await storeVersion(db, storage, {
    stock: project.stock,
    conceptId: w.ctx.conceptId,
    projectId: project.projectId,
    version: w.version,
    html: input.html,
    assets: project.assets,
    browser,
    outcome,
    stage: input.stage,
  });

  // The mechanical checks still rule: the same bounded fix rounds as a build.
  const fixed = await runFixRounds(db, storage, w.ctx, config, client, browser, {
    conversation: input.conversation,
    html: input.html,
    outcome,
    version: w.version,
    stepName: input.stepName,
  });

  if (fixed.version !== w.version) {
    const [latest] = await db
      .select({ id: conceptVersion.id })
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, w.ctx.conceptId))
      .orderBy(desc(conceptVersion.version))
      .limit(1);
    w.versionId = latest!.id;
  }

  w.version = fixed.version;
  w.html = fixed.html;
  w.outcome = fixed.outcome;
  w.checksSummary = describeChecks(fixed.outcome);

  const byCode = fixed.codeFixed.length > 0 ? `; fixed by code: ${fixed.codeFixed.join(", ")}` : "";
  return fixed.rounds > 0
    ? `Notes applied${byCode}; ${fixed.rounds} fix round${fixed.rounds === 1 ? "" : "s"}; ${w.checksSummary.toLowerCase()}`
    : `Notes applied${byCode}; ${w.checksSummary.toLowerCase()}`;
}

/* The newest score a concept has: its newest version's last pass (after any polish). */
async function latestReviewOf(db: Db, conceptId: string): Promise<StoredReview | null> {
  const [row] = await db
    .select({ review: conceptVersion.review })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  const passes = (row?.review as { passes?: StoredReview[] } | null)?.passes ?? [];
  return passes.at(-1) ?? null;
}

/* ---------- small pieces ---------- */

/*
  Reviews are stored on the version they scored, as a list of passes, so a
  version scored before and after (no notes to apply) keeps both.
*/
export async function attachReview(
  db: Db,
  versionId: string,
  review: StoredReview,
  needsPmReview = false,
  options: { replace?: boolean } = {},
): Promise<void> {
  const [row] = await db
    .select({ review: conceptVersion.review })
    .from(conceptVersion)
    .where(eq(conceptVersion.id, versionId))
    .limit(1);

  const existing = (row?.review ?? { passes: [] }) as VersionReviewRecord;
  // "replace": the pass is already stored; only the flag is being set.
  const passes = options.replace ? existing.passes ?? [] : [...(existing.passes ?? []), review];
  // A pass that succeeded clears an earlier failure.
  const next: VersionReviewRecord = {
    passes,
    ...(needsPmReview || existing.needsPmReview ? { needsPmReview: true } : {}),
  };

  await db
    .update(conceptVersion)
    .set({ review: next, summary: review.summary })
    .where(eq(conceptVersion.id, versionId));
}

export /* A pass that did not finish for one concept: kept, so it can be run again. */
async function markConceptReviewFailed(db: Db, versionId: string, pass: ReviewPass, reason: string): Promise<void> {
  const [row] = await db
    .select({ review: conceptVersion.review })
    .from(conceptVersion)
    .where(eq(conceptVersion.id, versionId))
    .limit(1);
  const existing = (row?.review ?? { passes: [] }) as VersionReviewRecord;
  const next: VersionReviewRecord = {
    ...existing,
    passes: existing.passes ?? [],
    failed: { pass, reason, at: new Date().toISOString() },
  };
  await db.update(conceptVersion).set({ review: next }).where(eq(conceptVersion.id, versionId));
}

export async function readSource(storage: Storage, htmlKey: string): Promise<string> {
  const source = await storage.get(sourceKeyFor(htmlKey));
  if (source) return source.toString("utf8");
  // Versions stored before sources were kept: the rendered page, images
  // removed so the reviewer reads text rather than megabytes.
  const page = await storage.get(htmlKey);
  if (!page) throw new Error("A concept's page is missing from storage.");
  return htmlForReview(page.toString("utf8"));
}

export function jpeg(data: Buffer): Anthropic.ImageBlockParam {
  return imageBlock(data);
}

function oneHourWrites(usage: Anthropic.Usage): number {
  return (usage as { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation?.ephemeral_1h_input_tokens ?? 0;
}

export function usageOf(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: (usage.cache_creation_input_tokens ?? 0) - oneHourWrites(usage),
    cacheWrite1hTokens: oneHourWrites(usage),
    ...(callMs(usage) !== undefined ? { ms: callMs(usage) } : {}),
  };
}

function formatAverage(value: number | null): string {
  return value === null ? "no score" : value.toFixed(1);
}

export function scoreLine(review: StoredReview): string {
  return `Average ${formatAverage(review.average)}, lowest ${review.lowest ?? "none"}`;
}

export async function markReviewFailed(runId: string, message: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: concept.id })
    .from(concept)
    .where(eq(concept.runId, runId));
  for (const row of rows) {
    // The step that was running stopped; the ones still waiting never started (9 November 2026).
    await setStepIfUnsettled(db, row.id, "review", message);
    for (const step of ["improve", "final_checks"]) {
      await setStepIfUnsettled(db, row.id, step, "Not run: the review stopped first", `Didn't finish: ${message}`);
    }
  }
  await finalizeRun(runId, { reviewFailed: message });
}

/*
  A step that hasn't settled, when something stops the run (9 November
  2026). What it becomes depends on how far it had got: one that was
  running didn't finish, while one still waiting never started and is shown
  in grey as "Not run" — nothing went wrong there, and painting it as a
  failure made one stopped step look like three.
*/
async function setStepIfUnsettled(
  db: Db,
  conceptId: string,
  step: string,
  message: string,
  /* What to say if the step was already running: it did start, so "Not run" would contradict its own state (CodeRabbit, PR #59). */
  stoppedMessage = message,
): Promise<void> {
  const [row] = await db
    .select({ status: conceptStep.status })
    .from(conceptStep)
    .where(and(eq(conceptStep.conceptId, conceptId), eq(conceptStep.step, step)))
    .limit(1);
  if (!row || (row.status !== "waiting" && row.status !== "working")) return;
  const running = row.status === "working";
  await setStep(db, conceptId, step, running ? "failed" : "not_run", running ? stoppedMessage : message);
}
