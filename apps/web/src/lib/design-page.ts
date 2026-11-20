import { and, eq } from "drizzle-orm";
import { costOf, formatCost, modelLabel } from "@tawd/core/mockups";
import { stepModelConfig } from "@tawd/core/step-models";

import type { Database } from "@tawd/core/db";
import { aiCall, figmaDesign, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Viewer } from "@tawd/core/permissions";
import { getStorage } from "@tawd/core/intake/storage";
import { DESIGN_PAGE_JOB, designPageJobId } from "@tawd/core/queue";
import { isReadRunId } from "@tawd/core/figma/read-assets";
import { pageBuildStalled, readPageKeys, type PageBuildStatus } from "@tawd/core/figma/read-page";
import { MockupError, getQueue } from "@/lib/mockups";
import { SpendError, assertWithinMonthlyLimit } from "@/lib/spend";
import type { ServiceContext } from "@/lib/users";
import { loadSavedReadItems } from "@/lib/design-read-items";
import { loadAssetSheet } from "@/lib/design-read-assets";

/*
  Building one page from a finished read (E5a, Lane 2, 15 November 2026;
  spec 15 section 6 stage 4). Admin only, beside the current route, like
  the rest of the new route.

  One paid call, so the estimate (standing rules 2 and 9) is one call's
  worth: what the real builds of this step have averaged, or a first guess
  from the measured run of 15 November (spec 15 section 13) until one has
  run. The page is written under the read it was built from, so it can
  always be traced to that read and the corrections that were in place.

  Only the latest attempt runs: "queued" with the attempt's id is written
  before the job is queued, so a second press is refused from then on. A
  build with no news for PAGE_BUILD_STALE_MS has stopped (the worker
  restarted) and can be started again.
*/

type Db = Database;

/*
  The first guess, until a real build has run: the home page of the paid
  run of 15 November, from spec 15 section 13 (12,000 to 16,000 in,
  20,000 to 28,000 out). The top of each range, because an estimate that
  is low is worse than one that is high -- the run of 15 November was low
  by about half and that is finding P-6.
*/
export const PAGE_BUILD_GUESS = { inputTokens: 16_000, outputTokens: 28_000 };

export interface PageBuildEstimate {
  cost: number;
  model: string;
  measured: boolean;
  label: string;
}

export async function estimateDesignPage(db: Db): Promise<PageBuildEstimate> {
  const config = await stepModelConfig(db, "design_page");
  const calls = await db.select().from(aiCall).where(eq(aiCall.step, "design_page"));
  const measured = calls.length > 0;
  const cost = measured ? calls.reduce((n, c) => n + costOf(c, config), 0) / calls.length : costOf(PAGE_BUILD_GUESS, config);
  const model = modelLabel(config.model);
  return {
    cost,
    model,
    measured,
    label: `About ${formatCost(cost)} of AI on ${model}: one call that sees the whole design and writes the page${measured ? `, from the ${calls.length === 1 ? "one build" : `${calls.length} builds`} so far` : " (a first guess until a real build has run)"}.`,
  };
}

export interface PageBuildView {
  /** The upload the read belongs to, and the page of it. */
  version: string | null;
  page: number;
  /** The finished read a page would be built from. */
  runId: string | null;
  status: PageBuildStatus | null;
  stalled: boolean;
  /** Whether a built page is saved for this read. */
  built: boolean;
  estimate: PageBuildEstimate | null;
}

const EMPTY: PageBuildView = { version: null, page: 1, runId: null, status: null, stalled: false, built: false, estimate: null };

export async function pageBuildView(db: Db, actor: Viewer, projectId: string, page = 1): Promise<PageBuildView> {
  if (!actor.isAdmin) return EMPTY;
  const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, projectId)).limit(1);
  if (!row || row.source !== "upload" || !row.fileKey) return EMPTY;
  const version = row.fileKey;

  const saved = await loadSavedReadItems(projectId, version, page);
  const runId = saved?.runId ?? null;
  if (!runId || !isReadRunId(projectId, runId)) return { ...EMPTY, version, page };

  const storage = getStorage();
  const keys = readPageKeys(projectId, version, page, runId);
  let status: PageBuildStatus | null = null;
  const bytes = await storage.get(keys.status);
  if (bytes) {
    try {
      status = JSON.parse(bytes.toString("utf8")) as PageBuildStatus;
    } catch {
      status = null;
    }
  }
  return {
    version,
    page,
    runId,
    status,
    stalled: pageBuildStalled(status),
    built: (await storage.get(keys.html)) !== null,
    estimate: await estimateDesignPage(db),
  };
}

export async function startDesignPageBuild(ctx: ServiceContext, actor: Viewer, projectId: string, page = 1): Promise<void> {
  if (!actor.isAdmin) throw new MockupError("Only an admin can build a page from the new read while it is being built.");
  const [proj] = await ctx.db.select({ lane: project.lane }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new MockupError("That project no longer exists.");
  if (proj.lane !== "lane_2") throw new MockupError("Building a page from the design is for Lane 2 (the client supplied a design).");

  const view = await pageBuildView(ctx.db, actor, projectId, page);
  if (!view.version || !view.runId || !view.estimate) throw new MockupError("Read the design with the new read first: the page is built from what that read found.");
  if ((view.status?.state === "working" || view.status?.state === "queued") && !view.stalled) {
    throw new MockupError("A page is already being built from this read.");
  }
  /*
    Standing rule 9: never spend when the result will not be usable and a
    free step would fix it. With no asset sheet, or one whose prepare
    failed, the build would be paid for and come back with every picture
    missing -- and "Prepare the pictures again" costs nothing and puts it
    right. So it is refused here rather than sold to someone as a build.
  */
  const sheet = await loadAssetSheet(projectId, view.version, view.runId);
  if (!sheet) {
    throw new MockupError("This read's pictures have not been prepared yet, so the page would be built with none of them. Press \u201cPrepare the pictures again\u201d first: it is free.");
  }
  if (sheet.error) {
    throw new MockupError("This read's pictures could not be prepared, so the page would be built with none of them. Press \u201cPrepare the pictures again\u201d first: it is free.");
  }

  try {
    await assertWithinMonthlyLimit(ctx.db, { projectId, estimate: view.estimate.cost });
  } catch (error) {
    if (error instanceof SpendError) throw new MockupError(error.message);
    throw error;
  }
  // The upload must still be the project's design when the job starts (the worker checks again).
  const [still] = await ctx.db
    .select({ fileKey: figmaDesign.fileKey })
    .from(figmaDesign)
    .where(and(eq(figmaDesign.projectId, projectId), eq(figmaDesign.fileKey, view.version)))
    .limit(1);
  if (!still) throw new MockupError("The design changed meanwhile; open the page again.");

  const storage = getStorage();
  const keys = readPageKeys(projectId, view.version, page, view.runId);
  const at = new Date().toISOString();
  const attempt = designPageJobId(projectId, Date.now());
  const queued: PageBuildStatus = {
    state: "queued",
    attempt,
    runId: view.runId,
    estimate: view.estimate.cost,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    flags: [],
    problems: [],
    error: null,
  };
  // "queued" before the job is queued: a second press is refused from now on.
  await storage.put(keys.status, Buffer.from(JSON.stringify(queued), "utf8"), "application/json");
  try {
    await getQueue().add(
      DESIGN_PAGE_JOB,
      { projectId, startedByUserId: actor.id, version: view.version, page, runId: view.runId, attempt, estimate: view.estimate.cost },
      { jobId: attempt, attempts: 1 },
    );
  } catch {
    const failed: PageBuildStatus = { ...queued, state: "failed", finishedAt: new Date().toISOString(), error: "The job queue wasn't answering, so the build never started. Nothing was spent." };
    await storage.put(keys.status, Buffer.from(JSON.stringify(failed), "utf8"), "application/json");
    throw new MockupError("The build couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, {
    action: "figma.new_page_build_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: view.version, page, runId: view.runId, estimate: view.estimate.cost, model: view.estimate.model },
  });
}
