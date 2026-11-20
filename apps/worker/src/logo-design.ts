import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { logoDesign, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { loadIntake } from "@tawd/core/intake/service";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { LogoJobData } from "@tawd/core/queue";
import { CACHE_1H, LogoFormatError, buildLogoSystemPrompt, buildLogoUserPrompt, readLogoReply } from "@tawd/core/mockups";

import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";
import { ownPageContext } from "./locked-context";
import { loadHtml } from "./page-load";

/*
  Add-on (26 September 2026): TAWD designs a logo for a client with none.
  One AI call for all the options, saved before it is read; one retry if
  the reply can't be used. Each option is kept as a checked SVG and a PNG
  drawn from it (transparent background), under the project's folder.
*/

/* A PNG of an SVG, 1200 wide, on a transparent background. */
async function pngOf(browser: Browser, svg: string): Promise<Buffer> {
  const context = await ownPageContext(browser, { viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await loadHtml(
      page,
      `<!doctype html><html><body style="margin:0;background:transparent"><div id="logo" style="width:1200px;display:flex;align-items:center;justify-content:center;padding:40px;box-sizing:border-box">${svg.replace(/<svg\b/i, '<svg style="width:100%;height:auto;display:block"')}</div></body></html>`,
    );
    return await page.screenshot({ type: "png", omitBackground: true, fullPage: true });
  } finally {
    await context.close();
  }
}

export async function runLogoJob(job: LogoJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [design] = await db.select().from(logoDesign).where(eq(logoDesign.id, job.designId)).limit(1);
  if (!design || design.status !== "queued") return;
  await db.update(logoDesign).set({ status: "working" }).where(eq(logoDesign.id, design.id));

  const [row] = await db.select().from(project).where(eq(project.id, design.projectId)).limit(1);
  const intake = await loadIntake(db, SYSTEM_ACTOR, design.projectId);
  if (!row || !intake) throw new Error("The project or its intake is gone.");
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildLogoSystemPrompt(), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildLogoUserPrompt({
        businessName: intake.data.business.name,
        trade: row.trade.replace(/_/g, " "),
        colors: intake.data.brand.colors,
        moodWords: intake.data.brand.moodWords,
        notes: intake.data.photos.notes,
        options: design.optionCount,
      }),
    },
  ];

  let svgs: string[] | null = null;
  for (let attempt = 1; attempt <= 2 && !svgs; attempt += 1) {
    const model = await stepModel(db, "logo_design");
    const response = await client.messages
      .stream({ model, max_tokens: 16_000, system, messages, ...requestSettings(model, { effort: config.effort }) })
      .finalMessage();
    await recordCall(db, {
      projectId: design.projectId,
      runId: design.id,
      conceptId: null,
      startedByUserId: design.startedByUserId,
      model,
      step: "logo_design",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The designer declined to design this logo.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      svgs = readLogoReply(text, design.optionCount);
    } catch (error) {
      if (!(error instanceof LogoFormatError) || attempt === 2) {
        throw new Error(`The logo couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the <svg> element${design.optionCount === 1 ? "" : "s"}.` });
    }
  }
  if (!svgs) throw new Error("The logo couldn't be designed.");

  const prefix = `${projectStoragePrefix(design.projectId)}logo-design/${design.id}/`;
  const options: { svgKey: string; pngKey: string; name: string }[] = [];
  for (const [index, svg] of svgs.entries()) {
    const svgKey = `${prefix}option-${index + 1}.svg`;
    const pngKey = `${prefix}option-${index + 1}.png`;
    await storage.put(svgKey, Buffer.from(svg, "utf8"), "image/svg+xml");
    await storage.put(pngKey, await pngOf(browser, svg), "image/png");
    options.push({ svgKey, pngKey, name: `Option ${index + 1}` });
  }
  await db.update(logoDesign).set({ status: "done", options, finishedAt: new Date() }).where(eq(logoDesign.id, design.id));
  await recordActivity(db, {
    action: "logo.designed",
    entityType: "project",
    entityId: design.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { options: options.length },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markLogoFailed(designId: string, message: string): Promise<void> {
  await getDb().update(logoDesign).set({ status: "failed", failureReason: message, finishedAt: new Date() }).where(eq(logoDesign.id, designId));
}
