import { CACHE_1H } from "@tawd/core/mockups";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { clientDecision, concept, conceptVersion, pageDraft, pagePlanPage, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { loadIntake } from "@tawd/core/intake/service";
import { loadIntakeForBuilding } from "@tawd/core/intake/unconfirmed";
import { describeServiceArea } from "@tawd/core/intake";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import { describeFactsForPrompt, directionInfo, listIntakeFacts } from "@tawd/core/mockups";
import type { ContentDraftJobData } from "@tawd/core/queue";
import { DraftFormatError, IMPROVE_SOURCE, buildDraftSystemPrompt, buildDraftUserPrompt, buildImproveSystemPrompt, buildImproveUserPrompt, isHealthProject, readDraftReply } from "@tawd/core/content";
import { currentSiteSuggestions, pagePath, type ImportedPageSummary } from "@tawd/core/site";
import { siteImport } from "@tawd/core/schema";
import { approvedWireframeFor } from "./pipeline";

import type { WorkerConfig } from "./config";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import { recordCall, sourceKeyFor } from "./pipeline";
import { usageOf } from "./review";
import { readProfile } from "./skills";

/*
  Phase 7b: one page's copy, drafted by AI from the intake, the page plan,
  the approved mockup's words and the house rules. One call, saved before
  it is read; one retry, saying what was wrong, if the reply can't be used.
  Text only: no browser.
*/

/* The approved concept's visible words, for the voice the client already liked. */
async function approvedConceptWords(db: ReturnType<typeof getDb>, projectId: string) {
  const [decision] = await db
    .select()
    .from(clientDecision)
    .where(and(eq(clientDecision.projectId, projectId), eq(clientDecision.changesRequested, false)))
    .orderBy(desc(clientDecision.createdAt))
    .limit(1);
  if (!decision) return null;
  const [picked] = await db.select().from(concept).where(eq(concept.id, decision.conceptId)).limit(1);
  const [version] = await db
    .select()
    .from(conceptVersion)
    .where(and(eq(conceptVersion.conceptId, decision.conceptId), eq(conceptVersion.version, decision.version)))
    .limit(1);
  if (!picked || !version?.htmlKey) return null;
  const html = (await getStorage().get(sourceKeyFor(version.htmlKey))) ?? (await getStorage().get(version.htmlKey));
  if (!html) return null;
  const words = html
    .toString("utf8")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
  return { direction: directionInfo(picked.direction).label, words };
}

export async function runContentDraftJob(job: ContentDraftJobData, config: WorkerConfig, client: Anthropic): Promise<void> {
  const db = getDb();
  const [draft] = await db.select().from(pageDraft).where(eq(pageDraft.id, job.draftId)).limit(1);
  // The page or project was deleted, or this already ran.
  if (!draft || draft.status !== "queued") return;
  await db.update(pageDraft).set({ status: "working" }).where(eq(pageDraft.id, draft.id));

  const [page] = await db.select().from(pagePlanPage).where(eq(pagePlanPage.id, draft.pageId)).limit(1);
  const [row] = await db.select().from(project).where(eq(project.id, draft.projectId)).limit(1);
  // B3: an unconfirmed claim from the old site is not given to the writer as a fact.
  const intake = await loadIntakeForBuilding(db, SYSTEM_ACTOR, draft.projectId);
  if (!page || !row || !intake) throw new Error("The page, the project or its intake is gone.");
  // Design + content (0.100.0): the page's words improved from the current site's.
  if (draft.source === IMPROVE_SOURCE) return runImprove({ db, draft, page, row, intake, config, client });
  const others = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, draft.projectId)).orderBy(asc(pagePlanPage.position));
  const [previous] =
    draft.source === "redraft"
      ? await db
          .select()
          .from(pageDraft)
          .where(and(eq(pageDraft.pageId, page.id), eq(pageDraft.status, "done")))
          .orderBy(desc(pageDraft.version))
          .limit(1)
      : [];

  const facts = describeFactsForPrompt(listIntakeFacts(intake.data, intake.files, { trade: row.trade }));
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildDraftSystemPrompt(await readProfile(config.skillsDir)), cache_control: CACHE_1H },
  ];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildDraftUserPrompt({
        healthRules: isHealthProject(row.trade, intake.data),
        clientName: row.clientName,
        tradeLabel: row.trade.replace(/_/g, " "),
        page: {
          name: page.name,
          kind: page.kind,
          mainKeyword: page.mainKeyword,
          supportingKeywords: page.supportingKeywords,
          h1: page.h1,
          title: page.title,
        },
        otherPages: others.filter((o) => o.id !== page.id).map((o) => ({ name: o.name, slug: o.slug })),
        // The hub rule (28 September 2026): a hub's detailed pages, or a detailed page's hub (if the PM kept it).
        family:
          page.kind === "hub"
            ? { role: "hub" as const, pages: others.filter((o) => o.parentSlug === page.slug).map((o) => ({ name: o.name, slug: o.slug })) }
            : page.parentSlug && others.some((o) => o.slug === page.parentSlug && o.kind === "hub")
              ? { role: "member" as const, hub: { name: others.find((o) => o.slug === page.parentSlug)!.name, slug: page.parentSlug } }
              : null,
        facts,
        services: intake.data.services.items.map((s) => ({ name: s.name, description: s.description })),
        serviceArea: describeServiceArea(intake.data.serviceAreas),
        tone: intake.data.content.toneOfVoice,
        approvedConcept: await approvedConceptWords(db, draft.projectId),
        suppliedCopy: intake.data.content.mode === "manual" && intake.data.content.suppliedCopy.trim() ? intake.data.content.suppliedCopy : null,
        designerNotes: intake.data.photos.notes,
        redraftNote: draft.source === "redraft" ? draft.note : null,
        // A first draft's note is the team's direction for the batch (28 September 2026).
        direction: draft.source === "draft" ? draft.note : null,
        previousDraft: previous?.body ?? null,
      }),
    },
  ];

  let body: string | null = null;
  for (let attempt = 1; attempt <= 2 && !body; attempt += 1) {
    const model = await stepModel(db, "content_draft");
    const stream = client.messages.stream({
      model,
      max_tokens: 8_000,
      system,
      messages,
      ...requestSettings(model, { effort: "medium" }),
    });
    const response = await stream.finalMessage();
    await recordCall(db, {
      projectId: draft.projectId,
      runId: draft.id,
      conceptId: null,
      startedByUserId: draft.createdByUserId,
      model,
      step: "content_draft",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The writer declined to draft this page.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      body = readDraftReply(text);
    } catch (error) {
      if (!(error instanceof DraftFormatError) || attempt === 2) {
        throw new Error(`The draft could not be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply could not be used: ${error.message} Reply with the whole page as Markdown, starting with "# ".` });
    }
  }

  await db
    .update(pageDraft)
    .set({ status: "done", body, finishedAt: new Date() })
    .where(and(eq(pageDraft.id, draft.id), eq(pageDraft.status, "working")));
  await recordActivity(db, {
    action: "content.page_drafted",
    entityType: "project",
    entityId: draft.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: page.name, version: draft.version, source: draft.source },
    ipAddress: null,
    userAgent: null,
  });
  await notifyWhenBatchDone(db, draft.projectId, draft.id);
}

/*
  When the last draft of the project's batch finishes, Slack says how many
  are waiting for Content's review (28 September 2026). A redraft counts
  too; a failed draft doesn't.
*/
async function notifyWhenBatchDone(db: ReturnType<typeof getDb>, projectId: string, draftId: string): Promise<void> {
  const open = await db.select({ id: pageDraft.id }).from(pageDraft).where(and(eq(pageDraft.projectId, projectId), inArray(pageDraft.status, ["queued", "working"])));
  if (open.length > 0) return;
  const drafts = await db.select().from(pageDraft).where(eq(pageDraft.projectId, projectId));
  const latest = new Map<string, (typeof drafts)[number]>();
  for (const d of drafts) if (!latest.has(d.pageId) || latest.get(d.pageId)!.version < d.version) latest.set(d.pageId, d);
  const waiting = [...latest.values()].filter((d) => d.status === "done" && !d.approvedAt).length;
  // Drafts run several at once: only the last one to finish posts, so the channel gets one message.
  const lastDone = drafts.filter((d) => d.status === "done" && d.finishedAt).sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime() || b.id.localeCompare(a.id))[0];
  if (lastDone?.id !== draftId) return;
  if (waiting > 0) await postProjectSlack(db, projectId, { kind: "drafts_ready", count: waiting });
}

/* A draft that did not finish: the reason, kept on the draft. */
export async function markContentDraftFailed(draftId: string, message: string): Promise<void> {
  const db = getDb();
  await db.update(pageDraft).set({ status: "failed", failureReason: message, finishedAt: new Date() }).where(eq(pageDraft.id, draftId));
}

/*
  Design + content (0.100.0, docs/plans/project-type.md section 4): one
  page's words improved from the current site's (its newest kept version),
  with TAWD's SEO suggestions for that page and, on Home, the approved
  wireframe's sections. Saved like a draft, as source "improved"; one
  retry, saying what was wrong, if the reply can't be used.
*/
async function runImprove(input: {
  db: ReturnType<typeof getDb>;
  draft: typeof pageDraft.$inferSelect;
  page: typeof pagePlanPage.$inferSelect;
  row: typeof project.$inferSelect;
  intake: NonNullable<Awaited<ReturnType<typeof loadIntake>>>;
  config: WorkerConfig;
  client: Anthropic;
}): Promise<void> {
  const { db, draft, page, row, intake, config, client } = input;
  const versions = await db.select().from(pageDraft).where(eq(pageDraft.pageId, page.id)).orderBy(desc(pageDraft.version));
  const kept = versions.find((v) => v.source === "kept" && v.body);
  if (!kept?.body) throw new Error("This page has no words from the current site to improve.");
  const previous = draft.note ? versions.find((v) => v.source === IMPROVE_SOURCE && v.status === "done" && v.version < draft.version) : undefined;

  // TAWD's SEO suggestions for this page, from the saved read (free).
  const [read] = await db.select().from(siteImport).where(eq(siteImport.projectId, draft.projectId)).limit(1);
  const summaries = ((read?.pages ?? []) as ImportedPageSummary[]).filter((p) => !p.gap);
  const path = pagePath(page.slug);
  const suggestions = summaries.length
    ? currentSiteSuggestions({
        pages: summaries,
        brokenLinks: (read?.brokenLinks ?? []) as never,
        notImported: read?.notImported ?? [],
        facts: {
          name: intake.data.business.name,
          phone: intake.data.business.phone,
          city: intake.data.business.city,
          cities: [...intake.data.serviceAreas.cities, ...intake.data.serviceAreas.counties],
          services: intake.data.services.items.map((s) => s.name),
        },
      }).flatMap((g) => g.items.filter((i) => i.page === path).map((i) => `${g.title}: ${i.found}`))
    : [];
  const wireframe = page.kind === "home" ? await approvedWireframeFor(db, { id: row.id, lane: row.lane, tier: row.tier }) : null;

  const facts = describeFactsForPrompt(listIntakeFacts(intake.data, intake.files, { trade: row.trade }));
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildImproveSystemPrompt(await readProfile(config.skillsDir)), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: buildImproveUserPrompt({
        clientName: row.clientName,
        tradeLabel: row.trade.replace(/_/g, " "),
        page: { name: page.name, kind: page.kind, mainKeyword: page.mainKeyword, supportingKeywords: page.supportingKeywords, h1: page.h1, title: page.title },
        facts,
        tone: intake.data.content.toneOfVoice,
        current: kept.body,
        suggestions: suggestions.slice(0, 12),
        wireframe: wireframe ? wireframe.filter((s) => s.kind !== "header" && s.kind !== "footer").map((s) => s.name) : null,
        note: draft.note,
        previous: previous?.body ?? null,
        healthRules: isHealthProject(row.trade, intake.data),
      }),
    },
  ];

  let body: string | null = null;
  for (let attempt = 1; attempt <= 2 && !body; attempt += 1) {
    const model = await stepModel(db, "content_improve");
    const response = await client.messages
      .stream({ model, max_tokens: 12_000, system, messages, ...requestSettings(model, { effort: "medium" }) })
      .finalMessage();
    await recordCall(db, {
      projectId: draft.projectId,
      runId: draft.id,
      conceptId: null,
      startedByUserId: draft.createdByUserId,
      model,
      step: "content_improve",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The writer declined to improve this page.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      body = readDraftReply(text);
    } catch (error) {
      if (!(error instanceof DraftFormatError) || attempt === 2) {
        throw new Error(`The improved words could not be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply could not be used: ${error.message} Reply with the whole improved page as Markdown, starting with "# ".` });
    }
  }

  await db
    .update(pageDraft)
    .set({ status: "done", body, finishedAt: new Date() })
    .where(and(eq(pageDraft.id, draft.id), eq(pageDraft.status, "working")));
  await recordActivity(db, {
    action: "content.page_drafted",
    entityType: "project",
    entityId: draft.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: page.name, version: draft.version, source: IMPROVE_SOURCE },
    ipAddress: null,
    userAgent: null,
  });
  await notifyWhenBatchDone(db, draft.projectId, draft.id);
}
