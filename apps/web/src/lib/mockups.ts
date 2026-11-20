import { recordStop } from "@/lib/stops";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { callCost, describeRunNotes, readRunNotes, SETTLED_STEPS } from "@tawd/core/mockups";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { loadStepModels } from "@tawd/core/step-models";
import { claimMockupRun } from "@tawd/core/paid-starts";
import {
  aiCall,
  concept,
  conceptStep,
  deletedProject,
  conceptVersion,
  designLogEntry,
  likedSiteShot,
  mockupRun,
  pipelineSteps,
  project,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { blockingLine } from "@tawd/core/intake";
import { homeWordsBlocked } from "@/lib/home-words";
import { keptHomeWords } from "@tawd/core/kept-home-words";
import { wireframeBlocked } from "@/lib/wireframe";
import { sweepStuckWork } from "@tawd/core/stuck-work";
import { getStorage } from "@tawd/core/intake/storage";
import {
  CONCEPT_JOB,
  QUEUES,
  queueFor,
  REFERENCE_STUDY_JOB,
  conceptJobId,
  referenceStudyJobId,
  type ConceptJobData,
} from "@tawd/core/queue";
import { estimateReferenceStudy } from "@/lib/mockup-inputs";
import { estimatePolish } from "@/lib/polish";
import { buildModelPremium, modelForStep, DESIGNER_CONCEPT, HTML_HOMEPAGE_CONCEPT, directions, checkDesignLog, paletteFamily, type DesignLogNeighbour, type DesignLogResult, type StoredReview, type ObservedPerConcept, estimateFromObserved, listIntakeFacts, estimateRun, getModelConfig, assignSkills, isCreativeBusiness, preselectDirections, describeMockupInputs, proposalInputsOf, tradeFromWords, type MockupInputs, type DirectionId, type PreselectedConcept, type SkillId } from "@tawd/core/mockups";
import type { Tier, Trade } from "@tawd/core/enums";
import type { ServiceContext } from "@/lib/users";
import { SpendError, assertWithinMonthlyLimit, getLimitState } from "@/lib/spend";
import { blockedMessage } from "@/lib/spend-report";

/*
  Starting and watching a run, from the web app's side.

  The web app never builds anything itself. It works out what to build,
  writes the rows, and puts jobs on the queue; the worker does the rest.
  That separation is what keeps a fifteen-minute job away from a request
  that has to answer in milliseconds.
*/

export class MockupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockupError";
  }
}

/*
  The one queue, as the web app uses it: add a job, find a queued one. Kept
  to those two calls so a test can stand in for Redis.
*/
export interface JobQueue {
  add(name: string, data: unknown, options?: { jobId?: string; attempts?: number; delay?: number }): Promise<unknown>;
  /** BullMQ's job, when the queue still holds it; getState says waiting, active, delayed, completed, failed... */
  getJob(id: string): Promise<{ remove(): Promise<unknown>; getState?(): Promise<string> } | undefined | null>;
  /** BullMQ's getJobs: with ["waiting"] and asc, the jobs waiting, next first; for "Nth in line" (28 September 2026). */
  getJobs?(types: string[], start?: number, end?: number, asc?: boolean): Promise<({ name: string; data: unknown } | undefined)[]>;
}

let queue: JobQueue | null = null;
let testQueue: JobQueue | null = null;

export function setQueueForTesting(q: JobQueue | null): void {
  testQueue = q;
}

export function getQueue(): JobQueue {
  if (testQueue) return testQueue;
  if (queue) return queue;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new MockupError(
      "REDIS_URL is not set, so there is no queue to put work on.",
    );
  }

  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const open = (name: string) =>
    new Queue<ConceptJobData>(name, {
      connection,
      defaultJobOptions: {
        // A concept that fails twice has a real problem; retrying a third
        // time just spends money. The design says so on the progress screen.
        attempts: 2,
        backoff: { type: "fixed", delay: 5_000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }) as unknown as Required<JobQueue>;
  /*
    Each job to its queue (28 September 2026): copies, drafts and concepts
    run several at once; everything else one at a time on MOCKUP_QUEUE.
  */
  const queues = new Map(QUEUES.map((name) => [name, open(name)] as const));
  queue = {
    add: (name, data, options) => queues.get(queueFor(name) as (typeof QUEUES)[number])!.add(name, data, options),
    getJob: async (id) => {
      for (const q of queues.values()) {
        const job = await q.getJob(id);
        if (job) return job;
      }
      return null;
    },
    getJobs: async (types, start, end, asc) => (await Promise.all([...queues.values()].map((q) => q.getJobs(types, start, end, asc)))).flat(),
  };
  return queue;
}

/** What the setup screen needs: the picks, why, and what it will cost. */
export async function planRun(
  viewer: Viewer,
  projectId: string,
  conceptCount: number,
) {
  assertCan(viewer, "project.view");

  const db = getDb();

  const [projectRow] = await db
    .select()
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  if (!projectRow) throw new MockupError("That project no longer exists.");

  const intake = await loadIntake(db, viewer, projectId);
  if (!intake) throw new MockupError("That project has no intake.");

  const city = intake.data.business.city.trim() || null;
  const neighbours = await getDesignLogNeighbours(projectRow.id, projectRow.trade, city);
  const palette = paletteFamily(intake.data.brand.colors[0]);

  const usedNearby = [
    ...new Set(neighbours.map((row) => row.direction as DirectionId)),
  ];

  const words = [
    intake.data.business.name,
    ...intake.data.services.items.flatMap((s) => [s.name, s.description]),
    ...intake.data.brand.moodWords,
  ];
  const inputs = await loadMockupInputs(db, projectId, intake);
  const closest = Object.fromEntries(
    (await db.select({ url: likedSiteShot.url, brief: likedSiteShot.brief }).from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId))).map((r) => [
      r.url,
      (r.brief as { closestDirection?: string | null } | null)?.closestDirection ?? null,
    ]),
  );

  /*
    The direction comes after the inputs (27 September 2026): proposed from
    the brand, the real photos and the studied reference sites as well as
    the trade; the PM's dropdown is an override shown after the proposal.
    Colours taken from the logo are the brand, but not a brand guide, so
    they don't make Brand-Led lead.
  */
  const plan = preselectDirections({
    trade: tradeFromWords(projectRow.trade as Trade, words),
    moodWords: intake.data.brand.moodWords,
    hasBrandGuide:
      (intake.data.brand.colors.length > 0 && !intake.data.brand.colorsFromLogo) || intake.data.brand.fonts.length > 0,
    hasFoundingYear: intake.data.business.yearFounded !== null,
    conceptCount,
    usedNearby,
    creative: isCreativeBusiness(words),
    inputs: proposalInputsOf(inputs, closest),
  });

  const config = getModelConfig();
  // The concept build's own model (Spend): Fable 5.1 costs more than the main model, Sonnet less.
  const buildModel = modelForStep("build", await loadStepModels(db), config);

  // Measured beats guessed, whenever there is anything measured.
  const observed = await getObservedPerConcept();
  const estimateFor = (count: number) => {
    const e = observed
      ? estimateFromObserved(count, config, observed, {
          addGuessedReview: !observed.includesMeasuredReview,
        })
      : estimateRun(count, config);
    const premium = buildModelPremium(count, buildModel, config);
    return { ...e, low: Math.max(0, e.low + premium), high: Math.max(0, e.high + premium) };
  };
  const estimate = estimateFor(conceptCount);
  const minutesPerConcept = await getObservedMinutesPerConcept(db);
  /*
    Part of every run since 27 September 2026: the reference study for any
    site not studied yet (once per site), and critique and polish once per
    concept after the review (the PM can skip it).
  */
  const unstudied = (await db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId))).filter(
    (r) => r.status === "done" && r.briefStatus !== "done",
  ).length;
  const referenceCost = unstudied > 0 ? (await estimateReferenceStudy(db, unstudied)).cost : 0;
  const polishPerConcept = (await estimatePolish(db)).cost;
  const label = (low: number, high: number) => `Around $${Math.max(1, Math.floor(low))} to $${Math.max(2, Math.ceil(high))}`;
  // For the setup screen, which updates as the count changes.
  const estimates = Object.fromEntries(
    [1, 2, 3].map((count) => {
      const e = estimateFor(count);
      const polish = polishPerConcept * count;
      return [
        count,
        {
          // Whole dollars: the range is wide, and cents would pretend otherwise.
          costLabel: label(e.low + referenceCost + polish, e.high + referenceCost + polish),
          costLabelNoPolish: label(e.low + referenceCost, e.high + referenceCost),
          middle: (e.low + e.high) / 2 + referenceCost + polish,
          minutes: estimateMinutes(count, minutesPerConcept) + (count * 3),
        },
      ];
    }),
  ) as Record<1 | 2 | 3, { costLabel: string; costLabelNoPolish: string; middle: number; minutes: number }>;

  return {
    project: {
      id: projectRow.id,
      clientName: projectRow.clientName,
      trade: projectRow.trade as Trade,
      tier: projectRow.tier as Tier,
      lane: projectRow.lane,
      status: projectRow.status,
    },
    plan,
    inputs,
    // Per concept: "No clash nearby", or which project it clashes with.
    designLog: Object.fromEntries(
      plan.concepts.map((pick) => [
        pick.label,
        checkDesignLog({ direction: pick.direction, paletteFamily: palette, city, neighbours }),
      ]),
    ) as Record<string, DesignLogResult>,
    // So the setup screen can re-check when a direction is changed.
    designLogInput: { city, paletteFamily: palette, neighbours },
    estimate,
    estimates,
    // What the estimate rests on, for the line under it.
    estimateBasis: observed
      ? `Based on ${observed.concepts} concept${observed.concepts === 1 ? "" : "s"} built so far.`
      : "A first guess until real runs exist.",
    moodWords: intake.data.brand.moodWords,
    // What the estimate includes beyond the concepts and their review.
    referenceSitesToStudy: unstudied,
    // The direction each studied reference site is closest to, for "none of them lean this way" on the cards (0.99.0).
    referenceLeans: Object.entries(closest).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] in directions).map(([url, direction]) => ({ url, direction: direction as DirectionId })),
    polishPerConcept,
    model: config.model,
    buildModel,
    intakeComplete: intake.completeness.isComplete,
    missing: intake.completeness.missing.map((m) => m.label),
    hasFoundingYear: intake.data.business.yearFounded !== null,
    // Set when this month's AI spend has reached the limit.
    limitBlocked: await getLimitState(db).then((state) =>
      state.blocked ? blockedMessage(state) : null,
    ),
    // Set while the current website isn't answered (30 September 2026): Generate waits for it.
    websiteBlocked: blockingLine(intake.completeness)?.line ?? null,
    websiteBlockedSection: blockingLine(intake.completeness)?.section ?? null,
    // Set until the Home page words are used (1 October 2026).
    wordsBlocked: await homeWordsBlocked(db, projectId),
    // Set until the wireframe is approved, when the project uses one (3 October 2026).
    wireframeBlocked: await wireframeBlocked(db, projectId),
  };
}

/* The logo, the real photos and the reference sites, with a note for each one missing. */
export async function loadMockupInputs(
  db: ReturnType<typeof getDb>,
  projectId: string,
  intake: NonNullable<Awaited<ReturnType<typeof loadIntake>>>,
): Promise<MockupInputs> {
  const shots = await db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));
  const urls = intake.data.website.likedWebsites.map((u) => u.trim()).filter(Boolean);
  return describeMockupInputs({
    logos: intake.files.filter((f) => f.kind === "logo").length,
    colors: intake.data.brand.colors,
    colorsFromLogo: intake.data.brand.colorsFromLogo,
    photos: intake.files.filter((f) => f.kind === "photo").map((f) => ({ caption: f.caption, fileName: f.fileName })),
    references: urls.map((url) => {
      const shot = shots.find((r) => r.url === url);
      return { url, status: shot?.status ?? "queued", briefStatus: shot?.briefStatus ?? null };
    }),
  });
}

/*
  How long a run takes, from real runs when there are any: the average
  minutes per concept over the last ten finished runs. Concepts render one
  at a time, so the time grows with the count; the review adds a little on
  top. Rounded to five minutes, because anything finer would be pretend.
*/
export async function getObservedMinutesPerConcept(db: ReturnType<typeof getDb>): Promise<number | null> {
  const runs = await db
    .select({
      createdAt: mockupRun.createdAt,
      finishedAt: mockupRun.finishedAt,
      conceptCount: mockupRun.conceptCount,
    })
    .from(mockupRun)
    .where(inArray(mockupRun.status, ["succeeded", "needs_pm_review", "checks_failed", "needs_intake"]))
    .orderBy(desc(mockupRun.createdAt))
    .limit(10);
  const perConcept = runs
    .filter((r) => r.finishedAt && r.conceptCount > 0)
    .map((r) => (r.finishedAt!.getTime() - r.createdAt.getTime()) / 60_000 / r.conceptCount)
    /*
      A run's finish time moves when its review is run again (or a stuck run
      is settled), hours or days later; that is not how long a concept takes
      to build. A concept takes minutes, so anything over 45 minutes a
      concept is left out (it showed "About 445 minutes", 25 September 2026).
    */
    .filter((minutes) => minutes > 0 && minutes <= MAX_MINUTES_PER_CONCEPT)
    .sort((a, b) => a - b);
  if (perConcept.length === 0) return null;
  // The middle run, so one slow run does not move the estimate.
  const middle = Math.floor(perConcept.length / 2);
  return perConcept.length % 2 === 1 ? perConcept[middle]! : (perConcept[middle - 1]! + perConcept[middle]!) / 2;
}

const MAX_MINUTES_PER_CONCEPT = 45;

export function estimateMinutes(count: number, observedPerConcept: number | null): number {
  // Until there is a real run: about five minutes a concept plus the review.
  const total = observedPerConcept === null ? count * 5 + 5 : count * observedPerConcept;
  return Math.max(5, Math.round(total / 5) * 5);
}

export interface StartRunInput {
  projectId: string;
  concepts: PreselectedConcept[];
  /** TAWD's own picks, so any change the team made is logged. */
  suggested?: PreselectedConcept[];
  /** Lane 2, Option B: alternatives to the designer's design (4c-2b), the only run such a project has. */
  alternatives?: boolean;
  /** Critique and polish each concept after the review (default on; the PM can skip it). */
  polish?: boolean;
}

/*
  The concepts to build: TAWD's picks, with any direction the team changed.

  Unchanged picks keep TAWD's skills exactly. Once anything changes, the
  whole set is re-checked against the DIRECTIONS.md rules and a broken rule
  stops the run with the sentence the setup screen already showed.
*/
export function resolvePicks(
  plan: Awaited<ReturnType<typeof planRun>>,
  picks?: { label: "A" | "B" | "C"; direction: DirectionId }[],
): PreselectedConcept[] {
  const suggested = plan.plan.concepts;
  if (!picks || picks.length === 0) return suggested;

  const changed = picks.some(
    (pick) =>
      suggested.find((s) => s.label === pick.label)?.direction !== pick.direction,
  );
  if (!changed && picks.length === suggested.length) return suggested;

  const checked = assignSkills(picks, {
    trade: plan.project.trade,
    hasFoundingYear: plan.hasFoundingYear,
  });
  if (checked.problems.length > 0) {
    throw new MockupError(checked.problems.join(" "));
  }

  // Warnings (the emergency-trade rule) never block; startRun logs them.
  return checked.concepts.map((concept) => {
    const original = suggested.find((s) => s.label === concept.label);
    return {
      ...concept,
      reason:
        original?.direction === concept.direction
          ? original.reason
          : "Chosen by the team",
    };
  });
}

export async function startRun(
  ctx: ServiceContext,
  actor: Viewer,
  input: StartRunInput,
): Promise<string> {
  assertCan(actor, "project.edit");

  const db = ctx.db;

  if (input.concepts.length < 1 || input.concepts.length > 3) {
    throw new MockupError("A run builds one, two or three concepts.");
  }

  const [projectRow] = await db
    .select()
    .from(project)
    .where(eq(project.id, input.projectId))
    .limit(1);
  if (!projectRow) throw new MockupError("That project no longer exists.");

  /*
    Lane 2, Option B starts from the designer's design. Its own concepts
    (the improved Concept 1 and any alternatives) come in stop 4c; until
    then nothing here may spend money on the Lane 1 run by accident.
  */
  if (projectRow.lane === "lane_2" && projectRow.laneOption === "b" && !input.alternatives) {
    throw new MockupError(
      "This project works from the designer's Figma design (Lane 2, Option B), so the usual concepts aren't generated here.",
    );
  }

  // The intake gate has already been passed to reach Mockups, but a run
  // started from a stale page should not sneak round it.
  const intake = await loadIntake(db, actor, input.projectId);
  // No paid concept run until the current website is answered, at any stage (Jason, 30 September 2026).
  const blocking = intake ? blockingLine(intake.completeness) : null;
  if (blocking) throw new MockupError(blocking.line);
  // Lane 1 (1 October 2026): the concepts are built with the home page's words the team used.
  if (!input.alternatives) {
    // Growth and Pro (3 October 2026): the concepts follow the approved wireframe.
    const frame = await wireframeBlocked(db, input.projectId);
    if (frame) throw new MockupError(frame);
    const words = await homeWordsBlocked(db, input.projectId);
    if (words) throw new MockupError(words);
  }
  if (!intake?.completeness.isComplete && projectRow.status === "intake") {
    throw new MockupError(
      "The intake is not complete, so this project has not left Intake yet.",
    );
  }

  // At 100% of the monthly AI limit, nothing new starts.
  try {
    await assertWithinMonthlyLimit(db, { projectId: input.projectId, estimate: estimateRun(input.concepts.length, getModelConfig()).high });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }

  const config = getModelConfig();
  const estimate = estimateRun(input.concepts.length, config);

  // A run already queued or running stops this one, two clicks together included (13 October 2026).
  const run = await claimMockupRun(db, input.projectId, {
    conceptCount: input.concepts.length,
    polish: input.polish ?? true,
    startedByUserId: actor.id,
    estimatedInputTokens: estimate.inputTokens,
    estimatedOutputTokens: estimate.outputTokens,
    model: config.model,
  });
  if (!run) {
    throw new MockupError("This project already has concepts generating.");
  }

  const runId = run.id;

  // Option B: the designer's Concept 1 moves to the new run, so it stays on the board beside the new alternatives.
  if (input.alternatives) {
    await db
      .update(concept)
      .set({ runId })
      .where(and(eq(concept.projectId, input.projectId), eq(concept.skillId, DESIGNER_CONCEPT)));
  }
  // A homepage the team supplied (HTML) stays on the board beside whatever is generated: the board shows only the latest run, so it moves with it, on every new run.
  await db
    .update(concept)
    .set({ runId })
    .where(and(eq(concept.projectId, input.projectId), eq(concept.skillId, HTML_HOMEPAGE_CONCEPT)));
  const jobs: ConceptJobData[] = [];

  for (const pick of input.concepts) {
    const [row] = await db
      .insert(concept)
      .values({
        runId,
        projectId: input.projectId,
        label: pick.label,
        direction: pick.direction,
        skillId: pick.skillId,
        status: "queued",
      })
      .returning({ id: concept.id });

    const conceptId = row!.id;

    // Every step exists from the start, so the progress screen has a full
    // table to show rather than rows appearing one at a time.
    await db.insert(conceptStep).values(
      pipelineSteps.map((step) => ({
        conceptId,
        step,
        status: "waiting" as const,
      })),
    );

    jobs.push({
      runId,
      conceptId,
      projectId: input.projectId,
      label: pick.label,
      direction: pick.direction,
      skillId: pick.skillId,
    });
  }

  // A makeover's concepts use the Home page on Content: the log says which version (6 October 2026).
  const kept = !input.alternatives ? await keptHomeWords(db, input.projectId) : null;
  await recordActivity(db, {
    action: "mockups.run_started",
    entityType: "project",
    entityId: input.projectId,
    ...actorFields(actor),
    valueAfter: {
      concepts: input.concepts.map((c) => ({
        label: c.label,
        direction: c.direction,
        skill: c.skillId,
      })),
      model: config.model,
      estimate: estimate.label,
      polish: input.polish ?? true,
      ...(kept?.state === "ready" ? { homeWords: `Kept from the current site: the Home page, version ${kept.version} on Content` } : {}),
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  const overrides = input.concepts
    .map((chosen) => ({
      label: chosen.label,
      suggested: input.suggested?.find((s) => s.label === chosen.label)
        ?.direction,
      chosen: chosen.direction,
      skill: chosen.skillId,
    }))
    .filter((o) => input.suggested && o.suggested !== o.chosen);

  // Advice the PM chose to overrule, such as Bold Emergency for an
  // emergency trade, is recorded with the overrides.
  const waived = assignSkills(
    input.concepts.map((c) => ({ label: c.label as "A" | "B" | "C", direction: c.direction })),
    { trade: projectRow.trade as Trade, hasFoundingYear: intake?.data.business.yearFounded != null },
  ).warnings;

  if (overrides.length > 0 || waived.length > 0) {
    await recordActivity(db, {
      action: "mockups.directions_overridden",
      entityType: "project",
      entityId: input.projectId,
      ...actorFields(actor),
      valueBefore: overrides.map((o) => ({
        concept: o.label,
        direction: o.suggested ?? null,
      })),
      valueAfter: {
        concepts: overrides.map((o) => ({
          concept: o.label,
          direction: o.chosen,
          skill: o.skill,
        })),
        ...(waived.length > 0 ? { rulesWaived: waived } : {}),
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  /*
    Queued last, once every row exists. A worker is fast enough to pick up a
    job before the rows that job needs would otherwise have been written.

    If queueing fails, the rows are already there and nothing will ever come
    to collect them, so the run is marked failed rather than left sitting at
    "queued" forever with no worker on its way.
  */
  // Reference sites not studied yet are studied first (the queue runs in order), so the builder gets their briefs.
  const toStudy = (await db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, input.projectId))).filter(
    (r) => r.status === "done" && r.briefStatus !== "done" && r.briefStatus !== "queued" && r.briefStatus !== "working",
  );
  try {
    const q = getQueue();
    if (toStudy.length > 0) {
      await db.update(likedSiteShot).set({ briefStatus: "queued", briefFailure: null }).where(inArray(likedSiteShot.id, toStudy.map((r) => r.id)));
      await q.add(REFERENCE_STUDY_JOB, { projectId: input.projectId, startedByUserId: actor.id }, { jobId: referenceStudyJobId(input.projectId, Date.now()), attempts: 1 });
    }
    for (const job of jobs) {
      await q.add(CONCEPT_JOB, job, { jobId: conceptJobId(job.conceptId) });
    }
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "the queue refused the job";

    console.error("Queueing the concepts failed:", error);

    await db
      .update(mockupRun)
      .set({
        status: "failed",
        failureReason: reason,
        finishedAt: new Date(),
      })
      .where(eq(mockupRun.id, runId));

    await db
      .update(concept)
      .set({ status: "failed", failureReason: reason })
      // Only the concepts this run generates: the designer's design and a supplied homepage moved into it are not failed by a queue that refused the others.
      .where(and(eq(concept.runId, runId), ne(concept.skillId, DESIGNER_CONCEPT), ne(concept.skillId, HTML_HOMEPAGE_CONCEPT)));

    throw new MockupError(
      `The concepts could not be queued, so nothing has started: ${reason}. Check that Redis is running and REDIS_URL is set.`,
    );
  }

  return runId;
}

export async function stopRun(
  ctx: ServiceContext,
  actor: Viewer,
  runId: string,
): Promise<void> {
  assertCan(actor, "project.edit");

  const db = ctx.db;

  const [run] = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.id, runId))
    .limit(1);
  if (!run) throw new MockupError("That run no longer exists.");

  await db
    .update(mockupRun)
    .set({ status: "stopped", finishedAt: new Date() })
    .where(eq(mockupRun.id, runId));
  // Since 28 September 2026 a concept being built ends too, before its next AI call (no further spending).
  await recordStop(db, actor.id, run.projectId, "mockups");

  // Anything not yet started is dropped from the queue. A concept already
  // being built is left to finish: killing it mid-render wastes what it
  // has already cost.
  const conceptRows = await db
    .select({ id: concept.id, status: concept.status })
    .from(concept)
    .where(eq(concept.runId, runId));

  const q = getQueue();
  for (const row of conceptRows) {
    if (row.status !== "queued") continue;
    const job = await q.getJob(conceptJobId(row.id));
    await job?.remove().catch(() => undefined);
    await db
      .update(concept)
      .set({ status: "stopped" })
      .where(eq(concept.id, row.id));
  }

  await recordActivity(db, {
    action: "mockups.run_stopped",
    entityType: "project",
    entityId: run.projectId,
    ...actorFields(actor),
    valueAfter: { runId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

export interface ConceptCheckIssue {
  id: string;
  severity: string;
  message: string;
  /** Only the intake can fix it; never sent to a fix round. */
  needsIntake?: boolean;
}

export interface ConceptVersionSummary {
  version: number;
  hasPng: boolean;
  hasHtml: boolean;
  checksPassed: boolean | null;
  placeholderCount: number | null;
  issues: ConceptCheckIssue[];
  /* What TAWD's own code changed on this version, so the team can see it rather than wonder (stage 1 of docs/plans/self-check.md). */
  runNotes: string[];
  /** Required fields this version still shows a placeholder for. */
  needsIntake: { key: string; label: string }[];
  /** Which automatic fix round made this version; null for the first build. */
  fixRound: number | null;
  /** How this version came about. */
  stage: "build" | "fix" | "cd_improve" | "rebuild" | "changes" | "logo_swap";
  /** Creative Director passes that scored this version, in order. */
  reviews: StoredReview[];
}

export interface ConceptProgress {
  id: string;
  label: string;
  direction: DirectionId;
  skillId: SkillId;
  status: string;
  failureReason: string | null;
  steps: { step: string; status: string; detail: string | null }[];
  latestVersion: number | null;
  placeholderCount: number | null;
  checksPassed: boolean | null;
  costSoFar: number;
  /** Newest first, so the team can see what the fix round changed. */
  versions: ConceptVersionSummary[];
  /** Every Creative Director pass for this concept, oldest first. */
  reviews: StoredReview[];
  /** Still under 3 after its one rebuild: the PM decides. */
  needsPmReview: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunProgress {
  id: string;
  status: string;
  /** Why the run, or its review, stopped, exactly as stored. */
  failureReason: string | null;
  model: string;
  conceptCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  concepts: ConceptProgress[];
  stepsDone: number;
  stepsTotal: number;
  totalCost: number;
}

/** Everything the generating screen and the concepts screen read. */
export async function getLatestRun(
  viewer: Viewer,
  projectId: string,
): Promise<RunProgress | null> {
  assertCan(viewer, "project.view");

  const db = getDb();

  // A run the worker will never finish is settled before it is shown.
  await sweepStuckWork(db);

  const [run] = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.projectId, projectId))
    .orderBy(desc(mockupRun.createdAt))
    .limit(1);
  if (!run) return null;

  const conceptRows = await db
    .select()
    .from(concept)
    .where(eq(concept.runId, run.id))
    .orderBy(asc(concept.label));

  const config = getModelConfig();
  const concepts: ConceptProgress[] = [];
  let stepsDone = 0;
  let stepsTotal = 0;

  const costs = (await runCosts([run.id], config)).get(run.id);
  const totalCost = costs?.total ?? 0;

  for (const row of conceptRows) {
    const steps = await db
      .select()
      .from(conceptStep)
      .where(eq(conceptStep.conceptId, row.id));

    const versions = await db
      .select()
      .from(conceptVersion)
      .where(eq(conceptVersion.conceptId, row.id))
      .orderBy(desc(conceptVersion.version));

    const latest = versions[0];

    // From the ledger: this concept's own calls plus an equal share of the
    // reviews, which cover every concept at once.
    const spend = costs?.perConcept.get(row.id) ?? emptySpend();
    const cost = spend.cost;

    // A skipped step, or one that never ran, still counts as settled for the progress bar.
    stepsTotal += steps.length;
    stepsDone += steps.filter((s) => (SETTLED_STEPS as readonly string[]).includes(s.status)).length;

    const readReview = (value: unknown) =>
      (value ?? { passes: [] }) as { passes?: StoredReview[]; needsPmReview?: boolean };

    const readChecks = (value: unknown) =>
      (value ?? {}) as {
        passed?: boolean;
        issues?: ConceptCheckIssue[];
        needsIntake?: { key: string; label: string }[];
        fixRound?: number | null;
        stage?: ConceptVersionSummary["stage"];
      };

    concepts.push({
      id: row.id,
      label: row.label,
      direction: row.direction as DirectionId,
      skillId: row.skillId as SkillId,
      status: row.status,
      failureReason: row.failureReason,
      steps: steps.map((s) => ({
        step: s.step,
        status: s.status,
        detail: s.detail,
      })),
      latestVersion: latest?.version ?? null,
      placeholderCount: latest?.placeholderCount ?? null,
      checksPassed: latest ? (readChecks(latest.checks).passed ?? null) : null,
      costSoFar: cost,
      versions: versions.map((version) => ({
        version: version.version,
        hasPng: Boolean(version.pngKey),
        hasHtml: Boolean(version.htmlKey),
        checksPassed: readChecks(version.checks).passed ?? null,
        placeholderCount: version.placeholderCount,
        issues: readChecks(version.checks).issues ?? [],
        runNotes: describeRunNotes(readRunNotes(version.checks)),
        needsIntake: readChecks(version.checks).needsIntake ?? [],
        // Rows stored before fix rounds were numbered: v2 was the one round.
        fixRound:
          readChecks(version.checks).fixRound ??
          (version.version > 1 && !readChecks(version.checks).stage
            ? version.version - 1
            : null),
        stage:
          readChecks(version.checks).stage ??
          (version.version === 1 ? "build" : "fix"),
        reviews: readReview(version.review).passes ?? [],
      })),
      reviews: [...versions]
        .reverse()
        .flatMap((version) => readReview(version.review).passes ?? []),
      needsPmReview: versions.some(
        (version) => readReview(version.review).needsPmReview === true,
      ),
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      cacheReadTokens: spend.cacheReadTokens,
      cacheWriteTokens: spend.cacheWriteTokens,
    });
  }

  return {
    id: run.id,
    status: run.status,
    failureReason: run.failureReason,
    model: run.model,
    conceptCount: run.conceptCount,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    concepts,
    stepsDone,
    stepsTotal,
    totalCost,
  };
}

/*
  A link to a concept's rendered page or its source, good for five minutes.

  Same shape as the intake's file links: the object stays private in R2 and
  TAWD hands out a short-lived signed URL to somebody who is signed in and
  allowed to see the project.
*/
export async function getConceptAssetUrl(
  viewer: Viewer,
  conceptId: string,
  kind: "png" | "html",
  version?: number,
): Promise<string | null> {
  assertCan(viewer, "project.view");

  const db = getDb();

  const [row] = await db
    .select()
    .from(concept)
    .where(eq(concept.id, conceptId))
    .limit(1);
  if (!row) return null;

  const versions = await db
    .select()
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, conceptId))
    .orderBy(desc(conceptVersion.version));

  const wanted =
    version === undefined
      ? versions[0]
      : versions.find((v) => v.version === version);
  if (!wanted) return null;

  const key = kind === "png" ? wanted.pngKey : wanted.htmlKey;
  if (!key) return null;

  const fileName = `concept-${row.label.toLowerCase()}-v${wanted.version}.${
    kind === "png" ? "png" : "html"
  }`;

  return getStorage().signDownload(key, fileName);
}

export interface PastRun {
  id: string;
  status: string;
  conceptCount: number;
  model: string;
  createdAt: Date;
  finishedAt: Date | null;
  cost: number;
  conceptLabels: string[];
}

/** Everything before the current one, so a run is never silently replaced. */
export async function listPastRuns(
  viewer: Viewer,
  projectId: string,
  excludeRunId?: string,
): Promise<PastRun[]> {
  assertCan(viewer, "project.view");

  const db = getDb();
  const config = getModelConfig();

  const runs = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.projectId, projectId))
    .orderBy(desc(mockupRun.createdAt))
    .limit(20);

  const costs = await runCosts(
    runs.map((r) => r.id),
    config,
  );
  const out: PastRun[] = [];

  for (const run of runs) {
    if (run.id === excludeRunId) continue;

    const conceptRows = await db
      .select({ id: concept.id, label: concept.label })
      .from(concept)
      .where(eq(concept.runId, run.id))
      .orderBy(asc(concept.label));

    const cost = costs.get(run.id)?.total ?? 0;

    out.push({
      id: run.id,
      status: run.status,
      conceptCount: run.conceptCount,
      model: run.model,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      cost,
      conceptLabels: conceptRows.map((c) => c.label),
    });
  }

  return out;
}

/*
  What a concept has actually cost, averaged over recent runs, from the
  ledger: every call in a run, divided by the concepts it built. That
  includes the fix rounds and the Creative Director's share, so the
  estimate is for the whole pipeline, measured.

  Runs from before the review existed have no review calls. Until some run
  has, the estimate adds the guessed review figures to the measured build,
  and says so.
*/
export async function getObservedPerConcept(): Promise<
  | (ObservedPerConcept & { includesMeasuredReview: boolean })
  | null
> {
  const db = getDb();

  const recentRuns = await db
    .select({ id: mockupRun.id })
    .from(mockupRun)
    .orderBy(desc(mockupRun.createdAt))
    .limit(30);
  if (recentRuns.length === 0) return null;
  const runIds = recentRuns.map((r) => r.id);

  const built = await db
    .select({ runId: concept.runId, count: sql<number>`count(*)::int` })
    .from(concept)
    .where(and(inArray(concept.runId, runIds), eq(concept.status, "ready")))
    .groupBy(concept.runId);
  const builtByRun = new Map(built.map((b) => [b.runId, Number(b.count)]));
  if (builtByRun.size === 0) return null;

  // Polish is estimated and added on its own, and the client's change requests aren't part of making a
  // concept, though both are recorded under the run: left out here so polish isn't counted twice (30 September 2026).
  const calls = (await db
    .select()
    .from(aiCall)
    .where(inArray(aiCall.runId, [...builtByRun.keys()]))).filter((c) => !["polish", "polish_critique", "changes"].includes(c.step));
  if (calls.length === 0) return null;

  const concepts = [...builtByRun.values()].reduce((a, b) => a + b, 0);
  if (concepts === 0) return null;

  const sum = (pick: (c: (typeof calls)[number]) => number) =>
    Math.round(calls.reduce((total, c) => total + pick(c), 0) / concepts);

  return {
    concepts,
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    cacheReadTokens: sum((c) => c.cacheReadTokens),
    cacheWriteTokens: sum((c) => c.cacheWriteTokens),
    includesMeasuredReview: calls.some((c) => c.step === "review"),
  };
}

/* ---------- the ledger, for this screen ---------- */

export interface ConceptSpend {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

function emptySpend(): ConceptSpend {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

/*
  What each run, and each concept in it, has cost. Review calls cover every
  concept at once, so each concept carries an equal share of them.
*/
export async function runCosts(
  runIds: string[],
  config: ReturnType<typeof getModelConfig>,
): Promise<Map<string, { total: number; perConcept: Map<string, ConceptSpend> }>> {
  const out = new Map<string, { total: number; perConcept: Map<string, ConceptSpend> }>();
  if (runIds.length === 0) return out;

  const db = getDb();
  const calls = await db.select().from(aiCall).where(inArray(aiCall.runId, runIds));
  const conceptRows = await db
    .select({ id: concept.id, runId: concept.runId, status: concept.status })
    .from(concept)
    .where(inArray(concept.runId, runIds));

  for (const runId of runIds) {
    const mine = calls.filter((c) => c.runId === runId);
    const perConcept = new Map<string, ConceptSpend>();
    const shareWith = conceptRows.filter((c) => c.runId === runId && c.status === "ready");

    const add = (target: ConceptSpend, call: (typeof calls)[number], share: number) => {
      target.inputTokens += call.inputTokens * share;
      target.outputTokens += call.outputTokens * share;
      target.cacheReadTokens += call.cacheReadTokens * share;
      target.cacheWriteTokens += call.cacheWriteTokens * share;
      target.cost += callCost(call, config) * share;
    };

    let total = 0;
    for (const call of mine) {
      total += callCost(call, config);
      if (call.conceptId) {
        const target = perConcept.get(call.conceptId) ?? emptySpend();
        add(target, call, 1);
        perConcept.set(call.conceptId, target);
      } else if (shareWith.length > 0) {
        for (const c of shareWith) {
          const target = perConcept.get(c.id) ?? emptySpend();
          add(target, call, 1 / shareWith.length);
          perConcept.set(c.id, target);
        }
      }
    }

    for (const spend of perConcept.values()) {
      spend.inputTokens = Math.round(spend.inputTokens);
      spend.outputTokens = Math.round(spend.outputTokens);
      spend.cacheReadTokens = Math.round(spend.cacheReadTokens);
      spend.cacheWriteTokens = Math.round(spend.cacheWriteTokens);
    }

    out.set(runId, { total, perConcept });
  }

  return out;
}

/* ---------- the design log ---------- */

/** Each concept's design-log result, for the results screen. */
export async function designLogForConcepts(
  viewer: Viewer,
  projectId: string,
  concepts: { label: string; direction: DirectionId }[],
): Promise<Record<string, DesignLogResult>> {
  assertCan(viewer, "project.view");
  const db = getDb();

  const [projectRow] = await db
    .select({ trade: project.trade })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  const intake = await loadIntake(db, viewer, projectId);
  if (!projectRow || !intake) return {};

  const city = intake.data.business.city.trim() || null;
  const palette = paletteFamily(intake.data.brand.colors[0]);
  const neighbours = await getDesignLogNeighbours(projectId, projectRow.trade, city);

  return Object.fromEntries(
    concepts.map((c) => [
      c.label,
      checkDesignLog({ direction: c.direction, paletteFamily: palette, city, neighbours }),
    ]),
  );
}

/*
  Design-log entries for other projects in the same trade and city.
  Excludes this project: running it again must not count its own earlier
  concepts as a competitor's. Cities compare without case or spaces.
*/
export async function getDesignLogNeighbours(
  projectId: string,
  trade: string,
  city: string | null,
): Promise<DesignLogNeighbour[]> {
  if (!city) return [];
  const db = getDb();

  const rows = await db
    .select({
      projectId: designLogEntry.projectId,
      direction: designLogEntry.direction,
      paletteFamily: designLogEntry.paletteFamily,
      projectName: project.clientName,
      deletedName: deletedProject.clientName,
    })
    .from(designLogEntry)
    .leftJoin(project, eq(project.id, designLogEntry.projectId))
    .leftJoin(deletedProject, eq(deletedProject.id, designLogEntry.projectId))
    .where(
      and(
        eq(designLogEntry.trade, trade),
        sql`lower(trim(${designLogEntry.city})) = ${city.trim().toLowerCase()}`,
        ne(designLogEntry.projectId, projectId),
        /*
          Only looks a client picked, on real projects (8 October 2026: the
          official run's Bold Emergency was moved down for "ABC Plumbers
          nearby", a test whose concepts nobody chose).
        */
        sql`coalesce(${project.isTest}, false) = false`,
        sql`exists (select 1 from client_decision cd where cd.concept_id = ${designLogEntry.conceptId})`,
      ),
    );

  return rows.map((row) => ({
    projectId: row.projectId,
    projectName: row.projectName ?? row.deletedName ?? null,
    direction: row.direction,
    paletteFamily: row.paletteFamily,
  }));
}

export interface IntakeGaps {
  /** Fields the intake gate requires, which are empty. */
  required: string[];
  /** Everything else a homepage could state, which is empty. */
  optional: string[];
}

/*
  What the intake does not have, right now.

  Shown on the Design screen so the team can tell at a glance how many of
  a concept's placeholders are genuinely missing information - to be asked
  of the client - and how many would be a bug in the build.
*/
export async function getIntakeGaps(
  viewer: Viewer,
  projectId: string,
): Promise<IntakeGaps | null> {
  assertCan(viewer, "project.view");

  const intake = await loadIntake(getDb(), viewer, projectId);
  if (!intake) return null;

  const [projectRow] = await getDb()
    .select({ trade: project.trade })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  const empty = listIntakeFacts(intake.data, intake.files, { trade: projectRow?.trade ?? null }).filter(
    (fact) => fact.value === null,
  );

  return {
    required: empty.filter((f) => f.requirementKey).map((f) => f.label),
    optional: empty.filter((f) => !f.requirementKey).map((f) => f.label),
  };
}

/*
  Lane 2, Option B (4c-2b): one or two alternatives to the designer's
  design, built by the usual engine in TAWD's own direction picks, with the
  designer's brand and words (the worker adds them). Paid: the estimate is
  shown first.
*/
export async function startAlternatives(ctx: ServiceContext, actor: Viewer, projectId: string, count: number): Promise<string> {
  assertCan(actor, "project.edit");
  if (count !== 1 && count !== 2) throw new MockupError("Choose one or two alternatives.");
  const [row] = await ctx.db.select({ lane: project.lane, laneOption: project.laneOption }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new MockupError("That project no longer exists.");
  if (row.lane !== "lane_2" || row.laneOption !== "b") throw new MockupError("Alternatives are for Lane 2, Option B projects.");
  const plan = await planRun(actor, projectId, count);
  return startRun(ctx, actor, { projectId, concepts: plan.plan.concepts.slice(0, count), alternatives: true });
}
