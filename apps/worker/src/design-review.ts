import { CACHE_5M } from "@tawd/core/mockups";
import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { designFinding, designReview, figmaDesign, intakePrefill } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import type { DesignReviewJobData } from "@tawd/core/queue";
import {
  DESIGN_REVIEW_JSON_SCHEMA,
  buildDesignReviewText,
  describeLayers,
  designLayers,
  factsForDesignReview,
  findNode,
  pinForLayer,
  visibleTree,
  readDesignReview,
  type FigmaFile,
} from "@tawd/core/figma";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { ReviewFormatError, buildReviewerSystemPrompt } from "@tawd/core/mockups";

import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { loadProjectContext, recordCall } from "./pipeline";
import { VIEWPORT, renderForReview } from "./render";
import { jpeg, usageOf } from "./review";

/*
  Lane 2, Option B, stop 4b: the Creative Director reviews the designer's
  homepage frame, from the imported picture and the saved Figma file. No
  Figma read. One AI call, saved before it is read; one retry, saying what
  was wrong, if the answer can't be used. The findings are pinned on the
  layers they name; Must-fix start ticked.
*/

export async function runDesignReviewJob(
  job: DesignReviewJobData,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  const [review] = await db.select().from(designReview).where(eq(designReview.id, job.reviewId)).limit(1);
  // The project was deleted, or this already ran.
  if (!review || review.status !== "queued") return;
  await db.update(designReview).set({ status: "working", startedAt: new Date() }).where(eq(designReview.id, review.id));

  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, review.projectId)).limit(1);
  const frame = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.id === review.frameId);
  if (!figma?.fileJsonKey || !frame?.imageKey) throw new Error("The imported design is missing. Import it again, then review it.");
  const [picture, saved] = await Promise.all([storage.get(frame.imageKey), storage.get(figma.fileJsonKey)]);
  if (!picture || !saved) throw new Error("The imported design is missing. Import it again, then review it.");
  const file = JSON.parse(saved.toString("utf8")) as FigmaFile;
  const node = findNode(file.document, review.frameId);
  if (!node) throw new Error(`The frame "${review.frameName}" is no longer in the saved file. Check and import the design again.`);

  // Only what a visitor would see: nothing hidden or parked outside the frame.
  const layers = designLayers(visibleTree(node));
  const project = await loadProjectContext(db, storage, browser, config, { projectId: review.projectId, runId: review.id });
  project.startedByUserId = review.startedByUserId;
  const creativeDirector = await readFile(path.resolve(config.skillsDir, "CREATIVE-DIRECTOR.md"), "utf8");

  // The frame drawn 1440 wide, photographed like a concept: first screen, then the page in parts.
  const shots = await renderForReview(
    browser,
    `<!doctype html><html><body style="margin:0"><img src="data:image/png;base64,${picture.toString("base64")}" style="display:block;width:${VIEWPORT.width}px;height:auto"></body></html>`,
  );
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: "The designer's homepage: first screen at 1440 by 900." },
    jpeg(shots.fold),
  ];
  shots.slices.forEach((slice, index) => {
    content.push({
      type: "text",
      text: `The designer's homepage: full page, part ${index + 1} of ${shots.slices.length}${
        shots.heightPx > 12_000 ? " (the page continues beyond this)" : ""
      }.`,
    });
    content.push(jpeg(slice));
  });
  // Facts filled from the design and not yet confirmed are told apart from the PM's own.
  const unconfirmed = await db
    .select({ fieldKey: intakePrefill.fieldKey })
    .from(intakePrefill)
    .where(and(eq(intakePrefill.projectId, review.projectId), eq(intakePrefill.status, "pending")));
  const facts = factsForDesignReview(project.intakeFacts, unconfirmed.map((u) => u.fieldKey));
  content.push({
    type: "text",
    text: buildDesignReviewText({
      clientName: project.clientName,
      tradeLabel: project.trade.replace(/_/g, " "),
      frameName: frame.name,
      frameWidth: frame.width,
      frameHeight: frame.height,
      layers: describeLayers(layers),
      factsConfirmed: facts.confirmed,
      factsUnconfirmed: facts.unconfirmed,
      factsMissing: facts.missing,
      designerNotes: project.intake.data.photos.notes,
    }),
  });

  const system: Anthropic.TextBlockParam[] = [
    // Five minutes: only a retry, moments later, reads it; a one-hour write costs twice the input price.
    { type: "text", text: buildReviewerSystemPrompt(creativeDirector, project.profileText), cache_control: CACHE_5M },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];

  let maxTokens = 32_000;
  let previousFailure: string | null = null;
  let result: ReturnType<typeof readDesignReview> | null = null;

  for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
    const model = await stepModel(db, "design_review");
    const stream = client.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      ...requestSettings(model, { effort: config.effort, adaptiveThinking: true, format: { type: "json_schema", schema: DESIGN_REVIEW_JSON_SCHEMA } }),
    });
    const response = await stream.finalMessage();
    await recordCall(db, {
      projectId: review.projectId,
      runId: review.id,
      conceptId: null,
      startedByUserId: review.startedByUserId,
      model,
      step: "design_review",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The reviewer declined to review this design.");

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    let failure: ReviewFormatError;
    try {
      result = readDesignReview(text, layers);
      break;
    } catch (error) {
      if (!(error instanceof ReviewFormatError)) throw error;
      failure =
        response.stop_reason === "max_tokens"
          ? new ReviewFormatError(
              "The review ran out of room before it finished.",
              "That answer ran out of room before it finished. Keep each reason and finding to one or two sentences, and reply with the complete JSON.",
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
  if (!result) throw new Error("The review could not be completed.");

  const findings = result.findings.map((f, index) => {
    const pin = f.layer ? pinForLayer(f.layer, frame) : null;
    return {
      reviewId: review.id,
      projectId: review.projectId,
      number: index + 1,
      grade: f.grade,
      category: f.category,
      title: f.title,
      problem: f.problem,
      change: f.change,
      why: f.why,
      layerId: f.layer?.id ?? null,
      layerName: f.layer?.name ?? null,
      pinX: pin?.x ?? null,
      pinY: pin?.y ?? null,
      /*
        Must-fix start ticked; the PM unticks what shouldn't go in. A house-rule
        one (something that looks fake) is for the client to confirm first, so
        it starts unticked: nothing is removed automatically.
      */
      ticked: f.grade === "must_fix" && f.category !== "house_rules",
    };
  });
  if (findings.length > 0) await db.insert(designFinding).values(findings);
  await db
    .update(designReview)
    .set({ status: "done", review: result.review, finishedAt: new Date() })
    .where(and(eq(designReview.id, review.id), eq(designReview.status, "working")));

  const counts = {
    mustFix: findings.filter((f) => f.grade === "must_fix").length,
    shouldFix: findings.filter((f) => f.grade === "should_fix").length,
    recommendations: findings.filter((f) => f.grade === "recommendation").length,
    confirmFacts: findings.filter((f) => f.grade === "confirm_fact").length,
  };
  await recordActivity(db, {
    action: "design.reviewed",
    entityType: "project",
    entityId: review.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { frame: frame.name, average: result.review.average, ...counts },
    ipAddress: null,
    userAgent: null,
  });
  await postProjectSlack(db, review.projectId, { kind: "design_review_ready", ...counts });
}

/* A review that did not finish: the reason, kept on the review and logged. */
export async function markDesignReviewFailed(reviewId: string, message: string): Promise<void> {
  const db = getDb();
  const [failed] = await db
    .update(designReview)
    .set({ status: "failed", failureReason: message, finishedAt: new Date() })
    .where(eq(designReview.id, reviewId))
    .returning({ projectId: designReview.projectId });
  if (!failed) return;
  await recordActivity(db, {
    action: "design.review_failed",
    entityType: "project",
    entityId: failed.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
