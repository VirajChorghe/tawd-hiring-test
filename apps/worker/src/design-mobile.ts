import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { designCopy, designPage, figmaDesign } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { DesignMobileJobData } from "@tawd/core/queue";
import { MOBILE_WIDTH, MobileCssError, buildMobileSystemPrompt, buildMobileUserText, insertMobileCss, readMobileCss } from "@tawd/core/figma";
import type { ImportedFrame } from "@tawd/core/figma/service";
import { CACHE_1H, embedAssets, htmlForReview, outlineBands, splitSections, styleSection } from "@tawd/core/mockups";

import type { WorkerConfig } from "./config";
import { loadDesignSource } from "./design-source";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { cropPicture } from "./render";
import { jpeg, usageOf } from "./review";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  Option A (28 September 2026): the phone version of one exactly copied
  page. One call for CSS only, under 768px, from the page's mobile frame
  when the design has one; the page is then drawn 390px wide, checked for
  sideways scrolling and photographed. The desktop page is unchanged.
*/

export async function runDesignMobileJob(job: DesignMobileJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, job.copyId)).limit(1);
  if (!copy || copy.mobileStatus !== "queued" || !copy.sourceKey) return;
  await db.update(designCopy).set({ mobileStatus: "working", mobileFailure: null }).where(eq(designCopy.id, copy.id));

  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, copy.projectId)).limit(1);
  const [page] = await db.select().from(designPage).where(and(eq(designPage.projectId, copy.projectId), eq(designPage.frameId, copy.frameId))).limit(1);
  const frames = (figma?.frames as ImportedFrame[] | null) ?? [];
  const mobileFrame = frames.find((f) => f.id === page?.mobileFrameId) ?? null;
  const source = (await storage.get(copy.sourceKey))?.toString("utf8");
  if (!source) throw new Error("The page's copy is missing from storage. Build the copy again.");

  const content: Anthropic.ContentBlockParam[] = [];
  if (mobileFrame?.imageKey) {
    const picture = await storage.get(mobileFrame.imageKey);
    if (picture) {
      const slices = await cropPicture(browser, picture, { top: 0, height: mobileFrame.height, sourceWidth: mobileFrame.width }, MOBILE_WIDTH, 1600);
      slices.forEach((slice, i) => {
        content.push({ type: "text", text: `The mobile frame "${mobileFrame.name}", part ${i + 1} of ${slices.length}.` });
        content.push(jpeg(slice));
      });
    }
  }
  const fromFrame = content.length > 0;
  content.push({ type: "text", text: buildMobileUserText({ fromFrame, outline: outlineBands(splitSections(source)), styles: styleSection(source)?.html ?? "", html: htmlForReview(source) }) });

  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildMobileSystemPrompt(), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content }];
  let css: string | null = null;
  for (let attempt = 1; attempt <= 2 && !css; attempt += 1) {
    const model = await stepModel(db, "design_mobile");
    const response = await client.messages.stream({ model, max_tokens: 16_000, system, messages, ...requestSettings(model, { effort: config.effort }) }).finalMessage();
    await recordCall(db, {
      projectId: copy.projectId,
      runId: copy.id,
      conceptId: null,
      startedByUserId: copy.startedByUserId,
      model,
      step: "design_mobile",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
      label: copy.frameName,
    });
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    try {
      css = readMobileCss(text);
    } catch (error) {
      if (!(error instanceof MobileCssError) || attempt === 2) throw new Error(`The phone version couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the @media CSS.` });
    }
  }
  if (!css) throw new Error("The phone version couldn't be made.");

  const updated = insertMobileCss(source, css);
  const design = await loadDesignSource(db, storage, browser, { projectId: copy.projectId, frameId: copy.frameId, frameName: copy.frameName, purpose: "make the phone version" });
  const embedded = embedAssets(updated, Object.fromEntries(design.assets.map((a) => [a.token, a.dataUri])));

  // At phone width: no sideways scrolling, and a picture of it.
  const context = await ownPageContext(browser, { viewport: { width: MOBILE_WIDTH, height: 844 }, deviceScaleFactor: 1 });
  const { overflow, shot } = await (async () => {
    try {
      const tab = await context.newPage();
      await tab.route("**/*", (route) => (/^(data|about|blob):|^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(route.request().url()) ? route.continue() : route.abort()));
      await loadHtml(tab, embedded);
      const wide = Boolean(await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1));
      return { overflow: wide, shot: await tab.screenshot({ type: "png", fullPage: true }) };
    } finally {
      await context.close();
    }
  })();

  const base = copy.sourceKey.replace(/source\.html$/, "");
  const pngKey = `${base}mobile.png`;
  await storage.put(copy.sourceKey, Buffer.from(updated, "utf8"), "text/html; charset=utf-8");
  if (copy.htmlKey) await storage.put(copy.htmlKey, Buffer.from(embedded, "utf8"), "text/html; charset=utf-8");
  await storage.put(pngKey, shot, "image/png");
  await db
    .update(designCopy)
    .set({
      mobileStatus: "done",
      mobileFrom: fromFrame ? "mobile frame" : "responsive",
      mobileFrameId: fromFrame ? mobileFrame!.id : null,
      mobilePngKey: pngKey,
      mobileOverflow: overflow,
      // A new phone version waits for the designer again.
      mobileDecision: null,
      mobileDecidedByUserId: null,
      mobileDecidedAt: null,
      mobileDecisionNote: null,
    })
    .where(eq(designCopy.id, copy.id));
  await recordActivity(db, {
    action: "design.mobile_made",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: page?.name ?? copy.frameName, from: fromFrame ? `the mobile frame "${mobileFrame!.name}"` : "a responsive version", overflow },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markDesignMobileFailed(copyId: string, message: string): Promise<void> {
  await getDb().update(designCopy).set({ mobileStatus: "failed", mobileFailure: message.slice(0, 1000) }).where(eq(designCopy.id, copyId));
}
