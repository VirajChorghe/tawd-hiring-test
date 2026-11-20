import { and, desc, eq, isNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import {
  concept,
  conceptChangeRequest,
  conceptComment,
  conceptVersion,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import { failChangeRequest } from "@tawd/core/stuck-work";
import type { ChangesJobData } from "@tawd/core/queue";
import {
  bandAtPin,
  bandIndexAt,
  bandsOnImage,
  describeChangeRequest,
  pictureToPagePercent,
  matchOutcomeDetails,
  readPageBands,
  type BandOnImage,
  type ChangePin,
  type PageBand,
  type DirectionId,
  type SkillId,
  readRunNotes,
} from "@tawd/core/mockups";

import type { WorkerConfig } from "./config";
import { measureBands, pinnedBandPicture } from "./render";
import {
  SectionEditError,
  conceptContext,
  editBySections,
  loadProjectContext,
  withImages,
  type Db,
} from "./pipeline";
import {
  attachReview,
  checkFixAndStore,
  readSource,
  reviewEach,
  scoreLine,
  type Working,
} from "./review";

/*
  Request changes, for one concept.

  A fixed sequence, like the review: one builder turn on the notes and the
  included comments, the mechanical checks with their usual bounded fix
  rounds, then one Creative Director scoring pass on the new version. No
  improvement round and no rebuild: the team's notes are the improvement,
  and the team decides what happens next.
*/

export async function runChangesJob(
  job: ChangesJobData,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  const [request] = await db
    .select()
    .from(conceptChangeRequest)
    .where(eq(conceptChangeRequest.id, job.requestId))
    .limit(1);
  // The project was deleted while this waited its turn.
  if (!request || request.status !== "queued") return;

  const [row] = await db.select().from(concept).where(eq(concept.id, request.conceptId)).limit(1);
  if (!row) return;

  await progress(db, request.id, "working", "Making the changes");

  const project = await loadProjectContext(db, storage, browser, config, {
    projectId: request.projectId,
    runId: row.runId,
  });
  // The ledger credits whoever asked for the changes, not whoever started the run.
  project.startedByUserId = request.requestedByUserId;

  const ctx = await conceptContext(project, config, {
    conceptId: row.id,
    label: row.label,
    direction: row.direction as DirectionId,
    skillId: row.skillId as SkillId,
  });

  const [latest] = await db
    .select()
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, row.id))
    .orderBy(desc(conceptVersion.version))
    .limit(1);
  if (!latest?.htmlKey) throw new Error("This concept has no version to change.");

  const comments = await db
    .select()
    .from(conceptComment)
    .where(
      and(
        eq(conceptComment.changeRequestId, request.id),
        isNull(conceptComment.parentId),
      ),
    )
    .orderBy(conceptComment.createdAt);

  /*
    A comment sent a second time (a person asked for it after the Creative
    Director found it not done) says so, so the editor makes it plainly.
  */
  const asked = (comment: (typeof comments)[number]) =>
    comment.tries >= 2
      ? `${comment.body} (Asked before and not done${comment.outcomeVersion ? ` in v${comment.outcomeVersion}` : ""}: make sure this change is clearly visible this time.)`
      : comment.body;

  /*
    A pin is tied to its section (its splitSections number), and to where it
    sits on the latest render, for the picture:
    - on the latest version: the section kept when it was placed, or read
      from the bands measured with the render;
    - on an older version (a second try is always one): the section kept
      when it was placed, if both versions have the same sections, at the
      same place within it (Fable's check, 3 October 2026);
    - otherwise it is placed by measuring the page below, with no picture.
  */
  const measured = readPageBands(latest.checks);
  const onImage = bandsOnImage(measured.bands, measured.imageHeight);
  const versionRows = await db
    .select({ version: conceptVersion.version, checks: conceptVersion.checks })
    .from(conceptVersion)
    .where(eq(conceptVersion.conceptId, row.id));
  const olderChecks = new Map(versionRows.map((v) => [v.version, readPageBands(v.checks)]));
  const rawChecks = new Map(versionRows.map((v) => [v.version, v.checks]));
  /*
    Each comment by the number the screen gives it (its place among the
    concept's comments), so the notes and the pictures match what the team
    sees (Fable's A10, 3 October 2026).
  */
  const everyComment = await db
    .select({ id: conceptComment.id })
    .from(conceptComment)
    .where(and(eq(conceptComment.conceptId, row.id), isNull(conceptComment.parentId)))
    .orderBy(conceptComment.createdAt);
  const screenNumber = new Map(everyComment.map((c, i) => [c.id, i + 1]));
  const numberOf = (id: string, index: number) => screenNumber.get(id) ?? index + 1;
  const pins: PlacedPin[] = [];
  const general: string[] = [];
  for (const [index, comment] of comments.entries()) {
    if (comment.pinX !== null && comment.pinY !== null) {
      const at = placePin(
        { version: comment.version, band: comment.band, y: comment.pinY },
        { version: latest.version, ...measured },
        onImage,
        olderChecks.get(comment.version),
      );
      // For the fallback, where the pin sits down the whole page (a picture stops at 12,000 px).
      const pageY = pictureToPagePercent(comment.pinY, rawChecks.get(comment.version));
      pins.push({ number: numberOf(comment.id, index), body: asked(comment), x: comment.pinX, y: comment.pinY, pageY, ...at });
    } else {
      general.push(asked(comment));
    }
  }

  const html = await readSource(storage, latest.htmlKey);
  const working: Working = {
    ctx,
    version: latest.version,
    versionId: latest.id,
    html,
    outcome: null,
    runNotes: readRunNotes(latest.checks),
    checksSummary: "All passed",
    rebuilt: false,
    lastReview: null,
  };

  /*
    Only the parts of the page the request is about. A pinned comment is
    placed on its band by where it sits on the page; the written notes, the
    unpinned comments and any pin that could not be placed go to one small
    call that finds their parts.
  */
  const extents = pins.some((p) => p.band === null)
    ? await measureBands(browser, withImages(html, project.assets, project.stock))
    : [];
  const placedPins = pins.map((pin) => ({ pin, band: pin.band ?? bandAtPin(pin.pageY, extents) }));
  const unplacedPins = placedPins.filter((p) => p.band === null).map((p) => p.pin);
  const source = request.source === "client" ? "client" : "team";
  const pictures = await pinnedPictures(storage, browser, latest.pngKey, measured, pins);

  let newHtml: string;
  try {
    newHtml = (
      await editBySections(db, ctx, config, client, {
        step: "changes",
        html,
        request: describeChangeRequest({ source, notes: request.notes, pins, general }),
        known: placedPins.flatMap((p) => (p.band === null ? [] : [p.band])),
        unplaced:
          request.notes.trim() || general.length > 0 || unplacedPins.length > 0
            ? describeChangeRequest({ source, notes: request.notes, pins: unplacedPins, general })
            : "",
        pictures,
      })
    ).html;
  } catch (error) {
    if (error instanceof SectionEditError) {
      throw new Error(`The changes were not made: ${error.message}`, { cause: error });
    }
    throw error;
  }

  await progress(db, request.id, "working", "Running the checks");

  const resultVersion = latest.version + 1;
  const reviewer = {
    db,
    project,
    config,
    client,
    browser,
    creativeDirector: await readFile(
      path.resolve(config.skillsDir, "CREATIVE-DIRECTOR.md"),
      "utf8",
    ),
  };

  const checkedLine = await checkFixAndStore(db, storage, reviewer, working, {
    conversation: [
      { role: "user", content: ctx.opening() },
      { role: "assistant", content: newHtml },
    ],
    html: newHtml,
    stage: "changes",
    stepName: "changes",
  });

  // The comments that went in are now "Sent in vN", N being the version
  // the changes made (a fix round after it may add another).
  await db
    .update(conceptComment)
    .set({ sentInVersion: resultVersion })
    .where(eq(conceptComment.changeRequestId, request.id));

  await progress(db, request.id, "working", "Creative Director scoring");

  const requested = [
    ...(request.notes.trim() ? [{ question: "Requested", note: request.notes.trim() }] : []),
    ...comments.map((c, index) => ({ question: `Comment ${numberOf(c.id, index)}`, note: c.body })),
  ];
  /*
    How many concepts the RUN has, not how many this pass reviews (Jason's
    run, 10 November 2026). This pass scores one concept on its own, and
    passing it as the whole run made Direction fit come back "Not
    applicable: this run has only one concept to compare" - untrue, and one
    of the eleven questions lost on every polished concept.
  */
  const conceptsInRun = (await db.select({ id: concept.id }).from(concept).where(eq(concept.runId, row.runId))).length;
  const scores = await reviewEach(reviewer, "changes", 1, [working], [working], {
    earlierNotes: new Map([[row.label, requested]]),
    conceptsInRun,
  });
  const score = scores.results.get(row.label);
  if (!score) throw new Error(scores.failures.get(row.label) ?? "The review did not finish.");
  await attachReview(db, working.versionId, score);

  /*
    Done or Not done, per comment, from the Creative Director's answer on
    each requested change. The comment stays open either way: a person
    resolves it (Jason, 2 October 2026).
  */
  const outcomes = matchOutcomeDetails(requested, score.earlierNotes);
  const offset = requested.length - comments.length;
  let done = 0;
  let checked = 0;
  for (const [index, comment] of comments.entries()) {
    const outcome = outcomes[offset + index];
    if (!outcome) continue;
    checked += 1;
    if (outcome.addressed) done += 1;
    await db
      .update(conceptComment)
      .set({ outcome: outcome.addressed ? "done" : "not_done", outcomeVersion: working.version, outcomeReason: outcome.reason?.slice(0, 300) ?? null })
      .where(eq(conceptComment.id, comment.id));
  }
  const commentsLine = checked > 0 ? `; ${done} of ${checked} comment${checked === 1 ? "" : "s"} done` : "";

  await db
    .update(conceptChangeRequest)
    .set({
      status: "done",
      resultVersion,
      detail: `v${working.version}: ${checkedLine}; ${scoreLine(score).toLowerCase()}${commentsLine}`,
      finishedAt: new Date(),
    })
    .where(eq(conceptChangeRequest.id, request.id));

  await recordActivity(db, {
    action: "mockups.changes_finished",
    entityType: "project",
    entityId: request.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      concept: row.label,
      version: working.version,
      average: score.average,
      lowest: score.lowest,
      checksPassed: working.outcome?.passed ?? null,
    },
    ipAddress: null,
    userAgent: null,
  });

  await postProjectSlack(db, request.projectId, {
    kind: "changes_ready",
    conceptId: row.id,
    label: row.label,
    version: working.version,
  });
}

/*
  Sections of the latest render with the pins drawn on them, at most four
  (the ones with the most pins), for the editor to see what was pointed at.
  Nothing when the version has no render or no measured bands.
*/
type PlacedPin = ChangePin & { band: number | null; yPx: number | null; pageY: number };

/* Where a pin goes on the latest version: its section number, and its height on the latest render. */
export function placePin(
  pin: { version: number; band: number | null; y: number },
  latest: { version: number; bands: PageBand[]; imageHeight: number },
  onImage: BandOnImage[],
  pinned: { bands: PageBand[]; imageHeight: number } | undefined,
): { band: number | null; yPx: number | null } {
  const hasHeight = (b: PageBand | undefined) => b !== undefined && b.bottom > b.top;
  if (pin.version === latest.version) {
    if (onImage.length === 0) return { band: null, yPx: null };
    const band = pin.band !== null && hasHeight(latest.bands[pin.band]) ? pin.band : bandIndexAt(pin.y, onImage);
    return { band, yPx: band === null ? null : (pin.y / 100) * latest.imageHeight };
  }
  if (pin.band === null || !pinned || pinned.imageHeight <= 0 || pinned.bands.length !== latest.bands.length) {
    return { band: null, yPx: null };
  }
  const was = pinned.bands[pin.band];
  const now = latest.bands[pin.band];
  if (!was || !now || !hasHeight(was) || !hasHeight(now)) return { band: null, yPx: null };
  const within = Math.min(1, Math.max(0, ((pin.y / 100) * pinned.imageHeight - was.top) / (was.bottom - was.top)));
  return { band: pin.band, yPx: now.top + within * (now.bottom - now.top) };
}

async function pinnedPictures(
  storage: ReturnType<typeof getStorage>,
  browser: Browser,
  pngKey: string | null,
  measured: { bands: PageBand[]; imageHeight: number },
  pins: PlacedPin[],
): Promise<{ caption: string; jpeg: Buffer }[]> {
  const byBand = new Map<number, PlacedPin[]>();
  for (const pin of pins) {
    if (pin.band === null || pin.yPx === null || !measured.bands[pin.band]) continue;
    byBand.set(pin.band, [...(byBand.get(pin.band) ?? []), pin]);
  }
  if (!pngKey || byBand.size === 0 || measured.imageHeight <= 0) return [];
  const png = await storage.get(pngKey);
  if (!png) return [];

  const out: { caption: string; jpeg: Buffer }[] = [];
  const busiest = [...byBand.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]).slice(0, 4);
  for (const [band, onBand] of busiest.sort((a, b) => a[0] - b[0])) {
    const extent = measured.bands[band]!;
    const picture = await pinnedBandPicture(
      browser,
      png,
      { top: extent.top, bottom: Math.min(extent.bottom, measured.imageHeight) },
      onBand.map((p) => ({ number: p.number, x: p.x, yPx: p.yPx! })),
    );
    if (!picture) continue;
    const numbers = onBand.map((p) => p.number).join(", ");
    const beyond = picture.outside.length
      ? ` Comment${picture.outside.length === 1 ? "" : "s"} ${picture.outside.join(", ")} ${picture.outside.length === 1 ? "is" : "are"} further along this section than the picture shows (drawn at its edge).`
      : "";
    out.push({
      caption: `Section ${band} (<tawd-section id="${band}">), "${extent.label}": comment${onBand.length === 1 ? "" : "s"} ${numbers}.${beyond}`,
      jpeg: picture.jpeg,
    });
  }
  return out;
}

/*
  A request that could not finish. If no new version was made, its comments
  go back to "Not sent" so they are included next time, and the concept
  keeps its latest version.
*/
/* Shared with the web app's sweep of stuck work, so both fail a request the same way. */
export async function markChangesFailed(requestId: string, message: string): Promise<void> {
  await failChangeRequest(getDb(), requestId, message);
}

async function progress(db: Db, requestId: string, status: string, detail: string) {
  await db
    .update(conceptChangeRequest)
    .set({ status, detail })
    .where(eq(conceptChangeRequest.id, requestId));
}
