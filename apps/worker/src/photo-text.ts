import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { intakeFile, photoTextCheck } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { loadIntake } from "@tawd/core/intake/service";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { PhotoTextJobData } from "@tawd/core/queue";
import {
  CACHE_1H,
  PhotoTextError,
  buildPhotoTextSystemPrompt,
  comparePhotoText,
  readPhotoTextReply,
  type PhotoReading,
} from "@tawd/core/mockups";

import { imageBlock } from "./image-type";
import { MAX_PHOTOS, prepareAssets } from "./assets";
import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";

/*
  The photo text check (27 September 2026): the client's photos, shrunk in
  Chromium as for a mockup, go to one AI call that lists their visible
  text; the comparison with the intake is code (core photo-text.ts). The
  reply is saved before it is read, with one retry if it can't be used.
*/

export async function runPhotoTextJob(job: PhotoTextJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const [check] = await db.select().from(photoTextCheck).where(eq(photoTextCheck.id, job.checkId)).limit(1);
  if (!check || check.status !== "queued") return;
  await db.update(photoTextCheck).set({ status: "working" }).where(eq(photoTextCheck.id, check.id));

  const intake = await loadIntake(db, SYSTEM_ACTOR, job.projectId);
  if (!intake) throw new Error("The project or its intake is gone.");
  const rows = (
    await db
      .select()
      .from(intakeFile)
      .where(and(eq(intakeFile.projectId, job.projectId), eq(intakeFile.kind, "photo"), eq(intakeFile.status, "ready")))
      .orderBy(asc(intakeFile.createdAt))
  ).slice(0, MAX_PHOTOS);
  if (rows.length === 0) throw new Error("There are no photos to read.");

  const prepared = await prepareAssets(
    browser,
    getStorage(),
    rows.map((row, index) => ({ kind: "photo" as const, fileName: row.fileName, contentType: row.contentType, caption: row.caption, storageKey: row.storageKey, token: `photo-${index + 1}` })),
  );
  const sent = prepared.map((asset) => ({ asset, row: rows[Number(asset.token.replace("photo-", "")) - 1]! }));
  const content: Anthropic.ContentBlockParam[] = [];
  for (const [index, { asset }] of sent.entries()) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(asset.dataUri);
    if (!match) continue;
    content.push({ type: "text", text: `Photo ${index + 1}:` });
    content.push(imageBlock(Buffer.from(match[2]!, "base64")));
  }
  content.push({ type: "text", text: "List the readable text in each photo as JSON." });

  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildPhotoTextSystemPrompt(), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
  let texts: string[][] | null = null;
  for (let attempt = 1; attempt <= 2 && !texts; attempt += 1) {
    const model = await stepModel(db, "photo_text");
    const response = await client.messages
      .stream({ model, max_tokens: 4_000, system, messages, ...requestSettings(model, { effort: "low" }) })
      .finalMessage();
    await recordCall(db, {
      projectId: job.projectId,
      runId: check.id,
      conceptId: null,
      startedByUserId: check.startedByUserId,
      model,
      step: "photo_text",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("Reading the photos was declined.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      texts = readPhotoTextReply(text, sent.length);
    } catch (error) {
      if (!(error instanceof PhotoTextError) || attempt === 2) throw new Error(`The reading couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the JSON object.` });
    }
  }
  if (!texts) throw new Error("The photos couldn't be read.");

  const readings: PhotoReading[] = sent.map(({ row }, index) => ({ fileId: row.id, fileName: row.fileName, texts: texts![index] ?? [] }));
  const findings = comparePhotoText(readings, intake.data);
  await db.update(photoTextCheck).set({ status: "done", readings, findings, finishedAt: new Date() }).where(eq(photoTextCheck.id, check.id));
  await recordActivity(db, {
    action: "mockups.photo_text_checked",
    entityType: "project",
    entityId: job.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { photos: readings.length, findings: findings.length },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markPhotoTextFailed(checkId: string, message: string): Promise<void> {
  await getDb().update(photoTextCheck).set({ status: "failed", failureReason: message.slice(0, 300), finishedAt: new Date() }).where(eq(photoTextCheck.id, checkId));
}
