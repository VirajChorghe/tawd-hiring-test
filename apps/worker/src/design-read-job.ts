import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser, Page } from "playwright-core";

import { getDb, type Database } from "@tawd/core/db";
import { lockDesignRead } from "@tawd/core/figma/read-lock";
import { figmaDesign } from "@tawd/core/schema";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import type { DesignReadJobData } from "@tawd/core/queue";
import { CACHE_1H, requestSettings } from "@tawd/core/mockups";

import type { WorkerConfig } from "./config";
import { crop, type Rgba } from "./design-pixels";
import { readPixels, writePng } from "./design-assets";
import { saveReadAssets } from "./design-read-assets";
import { BAND_LIST_SYSTEM, BAND_SYSTEM, bandPartPlan, bandParts, jsonOf, keepOwn, ownStretch, parseBandReply, scaleBandsUp, visionTier, wholeLookSize } from "./design-read";
import { tidySpacedCapitals } from "@tawd/core/figma/text-tidy";
import { checkCoverage, measureColours, parseBandList, snapEdges, tidyWords } from "./design-read-code";
import type { BandRead, DesignRead, ReadBand } from "./design-read-types";
import { imageBlock } from "./image-type";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";
import { recordCall, type CallScope } from "./pipeline";
import { usageOf } from "./review";
import { stepModel } from "./step-model";
import { modelForStep } from "@tawd/core/mockups";
import { loadStepModels } from "@tawd/core/step-models";

/*
  The new design read, run (E4, Lane 2, 14 November 2026). Admin only while
  the new route is built beside the current one (see design-read.ts for what
  each look asks and design-read-code.ts for what code checks).

  It reads the page picture the upload read already saved (the trimmed design,
  `frames/page-N.png` of that read), so nothing is drawn again and the read
  sees exactly what the rest of the route sees.

  Calls, in order: the whole-page look for the band list (asked once more,
  with the problems named, when code finds the list does not cover the page;
  whatever problems are left are kept as notes for a person), then one look
  per band part. Each call is in the spend ledger under "design_read" with
  its scope ("band_list" or "band"), so the estimate learns from real runs.
  The worker's Stop check runs before every call (stops.ts, "design_read").

  Written to storage, next to the upload read:
  - `read-v2/page-N.json`: the DesignRead;
  - `read-v2/assets/<runId>/page-N/`: its pictures, prepared by kind, and their sheet (design-read-assets.ts);
  - `read-v2/status.json`: working, done or failed, with when and the token
    totals, for the admin screen.
  Nothing else changes: the project's design, intake and pages are untouched.
*/

const MAX_TOKENS = 16_000;
/** A read with no news for this long has stopped (the worker restarted or was killed): it can be started again. */
export const STALE_MS = 30 * 60 * 1000;

export function designReadKeys(projectId: string, version: string, page: number) {
  const prefix = `${projectStoragePrefix(projectId)}design-upload/${version}/`;
  return { frame: `${prefix}frames/page-${page}.png`, result: `${prefix}read-v2/page-${page}.json`, status: `${prefix}read-v2/status.json` };
}

/** When the worker restarted after the read was saved, while its pictures were being prepared: the read is complete and kept. */
export const RESTARTED_IN_PICTURES =
  "The worker restarted while preparing the read's pictures. The read itself is complete and kept; press \u201CPrepare the pictures again\u201D to finish them, which is free and does not read the design again.";

export interface DesignReadStatus {
  /** "queued" is written by the web app when it queues the job, so a second start is refused at once. */
  state: "queued" | "working" | "done" | "failed";
  /** The start this status belongs to (DesignReadJobData.runId). */
  runId?: string;
  version: string;
  page: number;
  startedAt: string;
  /** Every save: a "working" read with no news for STALE_MS counts as stopped (a queued one is waiting its turn). */
  updatedAt: string;
  finishedAt: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  bands: number | null;
  error: string | null;
  /** Set once the read is saved and its pictures are being prepared (no AI, no more calls). */
  phase?: "pictures";
}

/** A picture scaled to width x height, as PNG bytes (the browser draws it smoothly). */
export async function scaledPng(page: Page, png: Buffer, width: number, height: number): Promise<Buffer> {
  const out = await page.evaluate(
    async ({ b64, w, h }) => {
      const im = new Image();
      im.src = `data:image/png;base64,${b64}`;
      await im.decode();
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(im, 0, 0, w, h);
      return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    },
    { b64: png.toString("base64"), w: width, h: height },
  );
  return Buffer.from(out, "base64");
}

export async function runDesignReadJob(job: DesignReadJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  void config;
  const db = getDb();
  const storage = getStorage();
  const keys = designReadKeys(job.projectId, job.version, job.page);
  const now = new Date().toISOString();
  /*
    A job reads only when it is the latest start and has not begun before (Fable's reviews of E4a): the
    web app writes "queued" with the start's runId before queueing it, and the job checks that status
    first, before any call.
    - Another runId: a newer start replaced this one (it waited so long in the queue that the screen
      offered a new start). This job stops and leaves the status to the newer start.
    - This runId, already "working" (or finished): a re-run of a job the worker lost (a restart re-runs a
      stalled job), however late. It stops rather than pay for the read again without anyone asking,
      and says so.
    Only "queued" with this runId goes ahead.
  */
  const before = await storage.get(keys.status);
  let was: Partial<DesignReadStatus>;
  try {
    was = before ? (JSON.parse(before.toString("utf8")) as Partial<DesignReadStatus>) : {};
  } catch {
    was = {};
  }
  if (was.runId !== job.runId) return;
  if (was.state !== "queued") {
    if (was.state === "working") {
      const stopped: DesignReadStatus = { state: "failed", runId: job.runId, version: job.version, page: job.page, startedAt: was.startedAt ?? now, updatedAt: now, finishedAt: now, calls: was.calls ?? 0, inputTokens: was.inputTokens ?? 0, outputTokens: was.outputTokens ?? 0, bands: was.bands ?? null, error: was.phase === "pictures" ? RESTARTED_IN_PICTURES : "The worker restarted during the read, so it stopped rather than pay for the read again. Start it again to read the design.", ...(was.phase ? { phase: was.phase } : {}) };
      await storage.put(keys.status, Buffer.from(JSON.stringify(stopped), "utf8"), "application/json");
    }
    return;
  }
  const status: DesignReadStatus = { state: "working", runId: job.runId, version: job.version, page: job.page, startedAt: now, updatedAt: now, finishedAt: null, calls: 0, inputTokens: 0, outputTokens: 0, bands: null, error: null };
  const saveStatus = () => {
    status.updatedAt = new Date().toISOString();
    return storage.put(keys.status, Buffer.from(JSON.stringify(status), "utf8"), "application/json");
  };
  await saveStatus();

  try {
    const [row] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
    if (!row || row.source !== "upload" || row.fileKey !== job.version) throw new Error("That upload is no longer the project's design; read the design again first.");
    const frame = await storage.get(keys.frame);
    if (!frame) throw new Error(`Page ${job.page} of that upload has no saved picture; read the design again first.`);

    const context = await ownPageContext(browser, { viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.route("**/*", (route) => (/^(data|blob|about):/.test(route.request().url()) ? route.continue() : route.abort()));
      await loadHtml(page, "<!doctype html><html><body></body></html>");
      const design: Rgba = await readPixels(page, frame.toString("base64"), "image/png");

      const ask = async (system: string, messages: Anthropic.MessageParam[], scope: CallScope, label: string): Promise<{ json: unknown; response: Anthropic.Message }> => {
        const model = await stepModel(db, "design_read");
        const response = await client.messages
          .stream({ model, max_tokens: MAX_TOKENS, system: [{ type: "text", text: system, cache_control: CACHE_1H }], messages, ...requestSettings(model, { effort: "low" }) })
          .finalMessage();
        const usage = usageOf(response.usage);
        await recordCall(db, { projectId: job.projectId, runId: job.projectId, conceptId: null, startedByUserId: job.startedByUserId, model, step: "design_read", scope, label, usage, turns: [{ stopReason: response.stop_reason, content: response.content }] });
        status.calls += 1;
        status.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
        status.outputTokens += response.usage.output_tokens;
        await saveStatus();
        const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
        return { json: jsonOf(text), response };
      };

      // Every picture is sized for the model the read runs on (see design-read.ts).
      // The model is looked up without counting as a call (stepModel notes a call for replays and checks Stop).
      const tier = visionTier(modelForStep("design_read", await loadStepModels(db)));

      // 1. The band list, from the whole page, small. Checked in the small picture's own pixels, so a problem named back is in the pixels the AI sees.
      const look = wholeLookSize(design.width, design.height, tier);
      const small = await scaledPng(page, frame, look.width, look.height);
      const listMessages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: [
            { type: "text", text: `The whole page. This picture is ${look.width} by ${look.height} pixels; give every position in its own pixels.` },
            imageBlock(small),
            { type: "text", text: "Reply with the JSON." },
          ],
        },
      ];
      const notes: string[] = [];
      let first = await ask(BAND_LIST_SYSTEM, listMessages, "band_list", "Band list");
      let parsed = parseBandList(first.json, look.height);
      let covered = checkCoverage(parsed.bands, look.height);
      let problems = [...parsed.problems, ...covered.problems];
      if (problems.length > 0) {
        // Once more, with what was wrong, in this picture's own pixels.
        const said = first.response.content.filter((b) => b.type === "text");
        listMessages.push({ role: "assistant", content: said.length > 0 ? said : "(no answer)" });
        listMessages.push({ role: "user", content: `That band list has problems: ${problems.join(" ")} The bands must run from 0 to ${look.height} in this picture's own pixels, with no gaps or overlaps, the header first and the footer last. Reply again with only the corrected JSON.` });
        first = await ask(BAND_LIST_SYSTEM, listMessages, "band_list", "Band list, again");
        parsed = parseBandList(first.json, look.height);
        covered = checkCoverage(parsed.bands, look.height);
        problems = [...parsed.problems, ...covered.problems];
        for (const p of problems) notes.push(`Band list (in a picture ${look.width} by ${look.height} px, ${look.scale === 1 ? "the design's own size" : `the design scaled by ${look.scale.toFixed(3)}`}): ${p}`);
      }
      if (covered.bands.length === 0) throw new Error("The read found no bands on the page.");
      const bands: ReadBand[] = snapEdges(design, scaleBandsUp(covered.bands, look.scale, design.height));
      status.bands = bands.length;

      // 2. Each band as large as the model reads it, in parts when tall.
      const plan = bandPartPlan(design.width, tier);
      const reads: BandRead[] = [];
      for (const [index, band] of bands.entries()) {
        const merged: BandRead = { band, words: [], points: [], fonts: [], pictures: [], notes: [] };
        const parts = bandParts(band, plan.maxHeight);
        for (const [n, part] of parts.entries()) {
          const box = { x: 0, y: part.top, w: design.width, h: part.bottom - part.top };
          const full = Buffer.from(await writePng(page, crop(design, box)), "base64");
          const sent = { width: Math.max(1, Math.round(box.w * plan.scale)), height: Math.max(1, Math.round(box.h * plan.scale)) };
          const png = plan.scale === 1 ? full : await scaledPng(page, full, sent.width, sent.height);
          const where = parts.length > 1 ? `, part ${n + 1} of ${parts.length}` : "";
          const { json } = await ask(
            BAND_SYSTEM,
            [
              {
                role: "user",
                content: [
                  { type: "text", text: `Band "${band.name}"${where}. This picture is ${sent.width} by ${sent.height} pixels; give every position in its own pixels.` },
                  imageBlock(png),
                  { type: "text", text: "Reply with the JSON." },
                ],
              },
            ],
            "band",
            `Band ${index + 1} of ${bands.length}: ${band.name}${where}`,
          );
          const read = keepOwn(parseBandReply(json, band, { top: part.top, width: sent.width, height: sent.height, scale: plan.scale }, index), ownStretch(parts, n), part, band);
          merged.words.push(...read.words);
          merged.points.push(...read.points);
          merged.fonts.push(...read.fonts);
          merged.pictures.push(...read.pictures);
          merged.notes.push(...read.notes);
        }
        // Every rejoined text is said, so a person can check it (a word list places the spaces).
        for (const w of merged.words) {
          const tidied = tidySpacedCapitals(w.text);
          if (tidied !== w.text) merged.notes.push(`Read the spaced capitals "${w.text}" as "${tidied}"; check the spacing.`);
        }
        merged.words = tidyWords(merged.words);
        reads.push(merged);
      }

      // 3. Colours measured by code at the points the read named.
      const measured = measureColours(design, reads.flatMap((r) => r.points));
      notes.push(...measured.problems);

      const result: DesignRead = { runId: job.runId, width: design.width, height: design.height, bands: reads, colours: measured.colours, notes };
      // Saved under the project's design-read lock, so a correction save never checks one read while this one is published (E4b-2a).
      await db.transaction(async (txn) => {
        await lockDesignRead(txn as unknown as Database, job.projectId);
        await storage.put(keys.result, Buffer.from(JSON.stringify(result), "utf8"), "application/json");
      });

      // 4. The pictures, cut and treated by kind (code, free). A failure here is written on the sheet and never fails the read.
      // Said in the status first, so the panel shows "preparing the pictures" rather than a read with no pictures.
      status.phase = "pictures";
      // Best effort, as after each picture: a status that can't be saved never stops the pictures (the read is already saved).
      await saveStatus().catch(() => undefined);
      // News after every picture, so a long picture step is never taken for a stopped one (STALE_MS).
      await saveReadAssets(page, design, result, storage, { projectId: job.projectId, version: job.version, page: job.page, runId: job.runId }, saveStatus);
      status.state = "done";
    } finally {
      await context.close();
    }
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : "The read failed.";
    throw error;
  } finally {
    status.finishedAt = new Date().toISOString();
    await saveStatus();
  }
}
