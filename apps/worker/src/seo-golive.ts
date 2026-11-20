import { asc, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { pagePlanPage, project, seoGoLiveCheck, siteBuild, siteDeploy } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { loadIntake } from "@tawd/core/intake/service";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SeoGoLiveJobData } from "@tawd/core/queue";
import { CACHE_1H } from "@tawd/core/mockups";
import {
  GOLIVE_JSON_SCHEMA,
  buildGoLiveSystemPrompt,
  buildGoLiveUserText,
  pagePath,
  programChecks,
  readGoLiveReply,
  summarizePage,
  type SeoFinding,
} from "@tawd/core/site";

import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";

type Fetch = typeof fetch;
let pageSpeedFetch: Fetch | null = null;

/** Tests pass a stand-in for Google PageSpeed. */
export function setGoLivePageSpeedForTesting(stand: Fetch | null): void {
  pageSpeedFetch = stand;
}

/* Google PageSpeed on the preview's home page (free), or null without a preview. */
async function previewSpeed(url: string | null): Promise<unknown> {
  if (!url) return null;
  const query = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  const key = process.env.PAGESPEED_API_KEY?.trim();
  if (key) query.set("key", key);
  try {
    const response = await (pageSpeedFetch ?? fetch)(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query.toString()}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) return { url, error: `PageSpeed answered ${response.status}` };
    const body = (await response.json()) as { lighthouseResult?: { categories?: { performance?: { score?: number } } } };
    return { url, performance: body.lighthouseResult?.categories?.performance?.score ?? null };
  } catch {
    return { url, error: "PageSpeed didn't answer" };
  }
}

/*
  The Senior SEO Manager's check (26 September 2026): the built pages are
  read from R2 (no crawl needed: TAWD has the files), the program's checks
  run first, then one AI call adds what needs judgement. Saved before it
  is read; one retry.
*/
export async function runSeoGoLiveJob(job: SeoGoLiveJobData, config: WorkerConfig, client: Anthropic): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [check] = await db.select().from(seoGoLiveCheck).where(eq(seoGoLiveCheck.id, job.checkId)).limit(1);
  if (!check || check.status !== "queued") return;
  await db.update(seoGoLiveCheck).set({ status: "working" }).where(eq(seoGoLiveCheck.id, check.id));
  const [build] = await db.select().from(siteBuild).where(eq(siteBuild.id, check.buildId)).limit(1);
  const [row] = await db.select().from(project).where(eq(project.id, check.projectId)).limit(1);
  const intake = await loadIntake(db, SYSTEM_ACTOR, check.projectId);
  if (!build || !row || !intake) throw new Error("The build, the project or its intake is gone.");

  const plan = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, check.projectId)).orderBy(asc(pagePlanPage.position));
  const prefix = `${projectStoragePrefix(check.projectId)}site/v${build.version}/`;
  const summaries = [];
  for (const page of plan) {
    const path = pagePath(page.slug);
    const html = await storage.get(`${prefix}${page.slug ? `${page.slug}/index.html` : "index.html"}`);
    if (html) summaries.push(summarizePage(html.toString("utf8"), { path, name: page.name, mainKeyword: page.mainKeyword }));
  }
  const sitePaths = new Set(summaries.map((s) => s.path).concat(["/thank-you/"]));
  const found = programChecks(summaries, { name: intake.data.business.name, phone: intake.data.business.phone, city: intake.data.business.city }, sitePaths);
  const [deploy] = await db.select().from(siteDeploy).where(eq(siteDeploy.projectId, check.projectId)).orderBy(desc(siteDeploy.createdAt)).limit(1);
  const speed = await previewSpeed(deploy?.state === "ready" ? deploy.url : null);

  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildGoLiveSystemPrompt(), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildGoLiveUserText({ clientName: row.clientName, pages: summaries, found, speed }) }];
  let judged: ReturnType<typeof readGoLiveReply> | null = null;
  for (let attempt = 1; attempt <= 2 && !judged; attempt += 1) {
    const model = await stepModel(db, "seo_golive_check");
    const response = await client.messages
      .stream({ model, max_tokens: 12_000, system, messages, ...requestSettings(model, { effort: config.effort, format: { type: "json_schema", schema: GOLIVE_JSON_SCHEMA as unknown as Record<string, unknown> } }) })
      .finalMessage();
    await recordCall(db, {
      projectId: check.projectId,
      runId: check.id,
      conceptId: null,
      startedByUserId: check.startedByUserId,
      model,
      step: "seo_golive_check",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The SEO agent declined to check this site.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      judged = readGoLiveReply(text);
    } catch (error) {
      if (attempt === 2) throw new Error(`The check couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error instanceof Error ? error.message : ""} Reply with the complete JSON.` });
    }
  }
  if (!judged) throw new Error("The check couldn't be completed.");
  const findings: SeoFinding[] = [
    ...found,
    ...judged.findings.map((f, i) => ({ key: `agent:${i}`, page: f.page, problem: f.problem, fix: f.fix, safe: f.safe, via: f.safe ? ("edit" as const) : null })),
  ];
  await db.update(seoGoLiveCheck).set({ status: "done", findings, summary: judged.summary, finishedAt: new Date() }).where(eq(seoGoLiveCheck.id, check.id));
  await recordActivity(db, {
    action: "seo.golive_checked",
    entityType: "project",
    entityId: check.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { version: build.version, findings: findings.length, safe: findings.filter((f) => f.safe).length },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markSeoGoLiveFailed(checkId: string, message: string): Promise<void> {
  await getDb().update(seoGoLiveCheck).set({ status: "failed", failureReason: message, finishedAt: new Date() }).where(eq(seoGoLiveCheck.id, checkId));
}
