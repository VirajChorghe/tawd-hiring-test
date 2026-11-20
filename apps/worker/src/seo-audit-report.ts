import { and, asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { intakeFile, pagePlanPage, project, seoAudit } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SeoAuditJobData } from "@tawd/core/queue";
import { CACHE_1H } from "@tawd/core/mockups";
import {
  AUDIT_REPORT_JSON_SCHEMA,
  AuditFormatError,
  buildAuditSystemPrompt,
  buildAuditUserText,
  readAuditReport,
  type RankedPage,
  type RedirectRow,
} from "@tawd/core/site";

import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall } from "./pipeline";
import { usageOf } from "./review";

/*
  The full SEO audit's report (26 September 2026): the Senior SEO agent
  reads what was gathered (the crawl, PageSpeed, rankings and traffic, the
  redirect map, the page plan and any Screaming Frog export the team
  attached) and writes the problems, priorities, gaps and page
  suggestions. One call, saved before it is read; one retry.
*/
export async function runSeoAuditJob(job: SeoAuditJobData, config: WorkerConfig, client: Anthropic): Promise<void> {
  const db = getDb();
  const [audit] = await db.select().from(seoAudit).where(eq(seoAudit.id, job.auditId)).limit(1);
  if (!audit || audit.kind !== "full" || audit.report) return;
  const [row] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, audit.projectId)).limit(1);
  const plan = (await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, audit.projectId)).orderBy(asc(pagePlanPage.position))).map((p) => ({ name: p.name, slug: p.slug, mainKeyword: p.mainKeyword }));
  const [exported] = await db.select().from(intakeFile).where(and(eq(intakeFile.projectId, audit.projectId), eq(intakeFile.kind, "seo_crawl_export"))).limit(1);
  const exportText = exported ? ((await getStorage().get(exported.storageKey))?.toString("utf8").split("\n").slice(0, 60).join("\n") ?? null) : null;

  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildAuditSystemPrompt(), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildAuditUserText({
        clientName: row?.clientName ?? "The client",
        siteUrl: audit.siteUrl,
        pageCount: audit.pageCount,
        crawl: audit.crawl,
        pageSpeed: audit.pageSpeed,
        rankings: audit.rankings as RankedPage[],
        redirects: audit.redirects as RedirectRow[],
        plan,
        crawlExport: exportText,
      }),
    },
  ];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const model = await stepModel(db, "seo_audit_report");
    const response = await client.messages
      .stream({
        model,
        max_tokens: 16_000,
        system,
        messages,
        ...requestSettings(model, { effort: config.effort, format: { type: "json_schema", schema: AUDIT_REPORT_JSON_SCHEMA as unknown as Record<string, unknown> } }),
      })
      .finalMessage();
    await recordCall(db, {
      projectId: audit.projectId,
      runId: audit.id,
      conceptId: null,
      startedByUserId: audit.startedByUserId,
      model,
      step: "seo_audit_report",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The SEO agent declined to write this report.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      const report = readAuditReport(text);
      await db.update(seoAudit).set({ status: "done", step: null, report, finishedAt: new Date() }).where(eq(seoAudit.id, audit.id));
      await recordActivity(db, {
        action: "seo.audit_reported",
        entityType: "project",
        entityId: audit.projectId,
        ...actorFields(SYSTEM_ACTOR),
        valueAfter: { priorities: report.priorities.length, gaps: report.gaps.length, suggestions: report.planSuggestions.length },
        ipAddress: null,
        userAgent: null,
      });
      return;
    } catch (error) {
      if (!(error instanceof AuditFormatError) || attempt === 2) throw new Error(`The report couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply with the complete JSON.` });
    }
  }
}

export async function markSeoAuditFailed(auditId: string, message: string): Promise<void> {
  await getDb().update(seoAudit).set({ status: "failed", step: null, failureReason: message, finishedAt: new Date() }).where(eq(seoAudit.id, auditId));
}
