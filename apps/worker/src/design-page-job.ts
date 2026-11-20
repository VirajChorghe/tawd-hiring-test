import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb, type Database } from "@tawd/core/db";
import { designReadCorrection, figmaDesign, project } from "@tawd/core/schema";
import { getStorage } from "@tawd/core/intake/storage";
import { mayWriteStatus, readAssetKeys, type AssetSheet } from "@tawd/core/figma/read-assets";
import { readPageKeys, type PageBuildStatus } from "@tawd/core/figma/read-page";
import { applyWordCorrections, type ItemCorrection, type WordChange } from "@tawd/core/figma/read-item-corrections";
import { applyBandCorrections, type BandChange, type BandCorrection } from "@tawd/core/figma/read-corrections";
import { buildPlan, type BuildPlan, type BuiltPage, type SheetEntry } from "@tawd/core/figma/build-spec";
import type { DesignPageJobData } from "@tawd/core/queue";

import type { WorkerConfig } from "./config";
import { buildDesignPage } from "./design-page-build";
import { designReadKeys, scaledPng } from "./design-read-job";
import { visionTier, wholeLookSize } from "./design-read";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";
import { loadPictureCorrections, readWithCorrectedPictures } from "./design-pictures-job";
import type { DesignRead } from "./design-read-types";
import { recordCall } from "./pipeline";
import { readProfile } from "./skills";
import { stepModel } from "./step-model";
import { modelForStep } from "@tawd/core/mockups";
import { loadStepModels } from "@tawd/core/step-models";
import { usageOf } from "./review";

/*
  Building one page from a finished read (E5a, Lane 2, 15 November 2026;
  spec 15 section 6 stage 4).

  One paid call. Everything that can be measured is measured first by code
  (build-spec.ts) and handed over as the plan, so the call is spent on
  turning a plan into HTML and nothing else. What comes back is checked by
  code before it is saved (design-page-build.ts), and the page is kept
  whatever those checks say, with the problems on it: a build that came
  back wrong is more useful to look at than one that was thrown away, and
  E5b's correction rounds start from it.

  The read is never touched. The page is written under that read's own
  folder, so it can always be traced to the read and the corrections it was
  built from, and a later read of the same upload cannot overwrite it.

  Only the latest attempt runs, the same rule as the read and the free
  prepare: the web app writes "queued" with the attempt's id before
  queueing, and this job stops unless the status it finds is that attempt,
  still queued.
*/

/** Every band correction made for an upload, oldest first. */
export async function loadBandCorrections(db: Database, projectId: string, version: string): Promise<BandCorrection[]> {
  const rows = await db
    .select()
    .from(designReadCorrection)
    .where(and(eq(designReadCorrection.projectId, projectId), eq(designReadCorrection.version, version), eq(designReadCorrection.target, "band")))
    .orderBy(asc(designReadCorrection.createdAt), asc(designReadCorrection.id));
  return rows.map((row) => ({
    id: row.id,
    anchor: row.anchor as BandCorrection["anchor"],
    change: row.change as BandChange,
    madeOnRun: row.madeOnRun,
    by: null,
    at: row.createdAt.toISOString(),
  }));
}

/** Every word correction made for an upload, oldest first. */
export async function loadWordCorrections(db: Database, projectId: string, version: string): Promise<ItemCorrection<WordChange>[]> {
  const rows = await db
    .select()
    .from(designReadCorrection)
    .where(and(eq(designReadCorrection.projectId, projectId), eq(designReadCorrection.version, version), eq(designReadCorrection.target, "word")))
    .orderBy(asc(designReadCorrection.createdAt), asc(designReadCorrection.id));
  return rows.map((row) => ({
    id: row.id,
    anchor: row.anchor as ItemCorrection<WordChange>["anchor"],
    change: row.change as WordChange,
    madeOnRun: row.madeOnRun,
    by: null,
    at: row.createdAt.toISOString(),
  }));
}

/**
 * The read as a person has corrected it, in the shape the plan takes.
 *
 * All three kinds of correction, because a person who has put something
 * right must never be shown the build getting it wrong again. The band
 * corrections go FIRST: they change a band's name, what it is (header,
 * band or footer) and where it starts and ends, and everything after
 * depends on those -- which band a word lands in, and which band is the
 * header and therefore owns the menu.
 *
 * The words of a band are then corrected against that band's own list,
 * which is how they were made. The pictures are corrected across the whole
 * page and put back by position, which `readWithCorrectedPictures` does.
 */
export function correctedRead(
  read: DesignRead,
  bandFixes: BandCorrection[],
  words: ItemCorrection<WordChange>[],
  pictures: Parameters<typeof readWithCorrectedPictures>[1],
): DesignRead {
  const withPictures = readWithCorrectedPictures(read, pictures);

  let bands = withPictures.bands;
  if (bandFixes.length > 0) {
    const spans = applyBandCorrections(
      bands.map((b) => b.band),
      bandFixes,
      withPictures.height,
      withPictures.runId ?? null,
    ).bands;
    bands = bands.map((band, i) => {
      const span = spans[i];
      return span ? { ...band, band: { ...band.band, name: span.name, role: span.role, top: span.top, bottom: span.bottom } } : band;
    });
  }

  if (words.length > 0) {
    bands = bands.map((band) => ({ ...band, words: applyWordCorrections(band.words, words, withPictures.runId ?? null).items }));
  }

  return bands === withPictures.bands ? withPictures : { ...withPictures, bands };
}

/** The asset sheet in the shape the plan takes; an unreadable or failed sheet is no pictures at all. */
export function sheetEntries(sheet: AssetSheet | null): SheetEntry[] {
  if (!sheet || sheet.error) return [];
  return (sheet.assets ?? []).map((a) => ({ id: a.id, kind: a.kind, box: a.box, file: a.file, icon: a.icon, flags: a.flags ?? [] }));
}

/** What the plan is told will exist. E5a builds the home page alone (standing rule 8). */
export const PAGES_BUILT: BuiltPage[] = [{ name: "Home", slug: "" }];

export async function runDesignPageJob(job: DesignPageJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const keys = readPageKeys(job.projectId, job.version, job.page, job.runId);
  const readKeys = designReadKeys(job.projectId, job.version, job.page);
  const now = new Date().toISOString();

  const before = await storage.get(keys.status);
  let was: Partial<PageBuildStatus>;
  try {
    was = before ? (JSON.parse(before.toString("utf8")) as Partial<PageBuildStatus>) : {};
  } catch {
    was = {};
  }
  // A newer press replaced this one, or this job already began (the worker lost it and it was re-run).
  if (was.attempt !== job.attempt) return;
  if (was.state !== "queued") {
    if (was.state === "working") {
      const stopped: PageBuildStatus = {
        state: "failed",
        attempt: job.attempt,
        runId: job.runId,
        estimate: job.estimate,
        startedAt: was.startedAt ?? now,
        updatedAt: now,
        finishedAt: now,
        flags: [],
        problems: [],
        error: "The worker restarted while building the page. Nothing more was spent; press Build the page again to start a new one.",
      };
      await storage.put(keys.status, Buffer.from(JSON.stringify(stopped), "utf8"), "application/json");
    }
    return;
  }

  const status: PageBuildStatus = {
    state: "working",
    attempt: job.attempt,
    runId: job.runId,
    estimate: job.estimate,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    flags: [],
    problems: [],
    error: null,
  };
  const saveStatus = async () => {
    if (!mayWriteStatus(await storage.get(keys.status), job.attempt)) return;
    status.updatedAt = new Date().toISOString();
    await storage.put(keys.status, Buffer.from(JSON.stringify(status), "utf8"), "application/json");
  };
  await saveStatus();

  try {
    const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
    if (!row || row.source !== "upload" || row.fileKey !== job.version) throw new Error("That upload is no longer the project's design; read the design again first.");

    const saved = await storage.get(readKeys.result);
    if (!saved) throw new Error("That read is no longer saved; read the design again first.");
    const read = JSON.parse(saved.toString("utf8")) as DesignRead;
    if (read.runId !== job.runId) throw new Error("The design has been read again since this was started. Reload the page and build again.");

    const picture = await storage.get(readKeys.frame);
    if (!picture) throw new Error(`Page ${job.page} of that upload has no saved picture; read the design again first.`);

    const assetKeys = readAssetKeys(job.projectId, job.version, job.page, job.runId);
    const sheetBytes = await storage.get(assetKeys.list);
    let sheet: AssetSheet | null = null;
    if (sheetBytes) {
      try {
        sheet = JSON.parse(sheetBytes.toString("utf8")) as AssetSheet;
      } catch {
        sheet = null;
      }
    }

    const corrected = correctedRead(
      read,
      await loadBandCorrections(db, job.projectId, job.version),
      await loadWordCorrections(db, job.projectId, job.version),
      await loadPictureCorrections(db, job.projectId, job.version),
    );
    const plan: BuildPlan = buildPlan(corrected, sheetEntries(sheet), PAGES_BUILT);

    /*
      The picture is sized for the model that will look at it, the same way
      the read sizes every picture it sends (design-read.ts). A full design
      page is tall -- a long landing page can be several thousand pixels --
      and sending it at full size risks the call being refused for the
      picture's size alone, which would cost the person a failed step for no
      reason. The plan's positions stay in the DESIGN's own pixels whatever
      the picture is scaled to, because the builder is given them as numbers
      and never has to measure the picture.
    */
    const tier = visionTier(modelForStep("design_page", await loadStepModels(db)));
    const look = wholeLookSize(read.width, read.height, tier);
    let sized = picture;
    if (look.scale < 1) {
      const context = await ownPageContext(browser, { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
      try {
        const browserPage = await context.newPage();
        await browserPage.route("**/*", (route) => (/^(data|blob|about):/.test(route.request().url()) ? route.continue() : route.abort()));
        await loadHtml(browserPage, "<!doctype html><html><body></body></html>");
        sized = await scaledPng(browserPage, picture, look.width, look.height);
      } finally {
        await context.close();
      }
    }

    const [row2] = await db.select().from(project).where(eq(project.id, job.projectId)).limit(1);
    /*
      Standing rule 2 and 9: the estimate and the model are shown before
      this is started, and the build stops itself at twice its estimate.
      That stop is a pre-call check against what the run has already spent,
      so with the single call here there is nothing yet for it to count: one
      call is bounded by MAX_TOKENS instead. The stop becomes real with
      E5b's correction rounds, which is where several calls accumulate
      against one estimate. `estimate` is carried in the status so those
      rounds have it, and so the screen can show what was promised.
    */
    const model = await stepModel(db, "design_page");
    const built = await buildDesignPage({
      client,
      model,
      profileText: await readProfile(config.skillsDir),
      clientName: row2?.clientName ?? "the client",
      plan,
      picture: sized,
      onUsage: async (usage, stopReason, content) => {
        await recordCall(db, {
          projectId: job.projectId,
          runId: job.projectId,
          conceptId: null,
          startedByUserId: job.startedByUserId,
          model,
          step: "design_page",
          scope: "page",
          label: `Page ${job.page}`,
          usage: usageOf(usage),
          turns: [{ stopReason, content }],
        });
      },
    });

    /*
      The page is kept whatever the checks said: a build that came back
      wrong is what the correction rounds start from, and a person can see
      for themselves. The problems ride with it.

      Unless a newer attempt has taken over while this call was running. The
      status guard alone is not enough here: it would stop this job writing
      the STATUS and still let it write the PAGE, so the newer attempt's
      problems would end up describing this attempt's page. Checked again
      right before the write, as late as it can be.
    */
    if (!mayWriteStatus(await storage.get(keys.status), job.attempt)) return;
    await storage.put(keys.html, Buffer.from(built.html, "utf8"), "text/html; charset=utf-8");
    status.flags = plan.flags;
    status.problems = built.problems;
    status.state = "done";
    status.finishedAt = new Date().toISOString();
    await saveStatus();
  } catch (error) {
    status.state = "failed";
    status.finishedAt = new Date().toISOString();
    status.error = error instanceof Error ? error.message : "The page could not be built.";
    await saveStatus();
    /*
      The screen has its reason; the worker still needs to know. Swallowing
      it here left no job_failure record and a log line saying the build was
      done, so a build that failed for everyone would look fine to anyone
      looking at the worker rather than at the project.
    */
    throw error;
  }
}
