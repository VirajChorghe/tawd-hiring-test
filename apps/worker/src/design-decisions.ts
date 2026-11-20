import { CACHE_1H } from "@tawd/core/mockups";
import { asc, eq, sql } from "drizzle-orm";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { designChange, designCopy, designImprovement } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import type { DesignDecisionsJobData } from "@tawd/core/queue";
import {
  buildUndoSectionText,
  buildUndoSystemPrompt,
  copySections,
  cssForSection,
  planDecisions,
  readUndoReply,
  replaceCopySections,
  type ChangeDecision,
  type DecidedChange,
} from "@tawd/core/figma";

import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { loadDesignSource } from "./design-source";
import { checkEverything, loadProjectContext, recordCall, withImages, type Db } from "./pipeline";
import { cropPicture, measureBands, renderConcept, imageHeight, VIEWPORT } from "./render";
import { jpeg, usageOf } from "./review";

/*
  Lane 2, Option B, 4c-2: the version with the designer's decisions.

  The improved design with the pushed-back changes taken out. A section
  where every change was pushed back gets the faithful copy's section back,
  for free. A section with some accepted and some pushed back gets one
  small AI edit (the section before any change as a picture, the section
  now, what to take out and what to keep), saved before it is read. A font
  swap pushed back stays: the designer's font has no web licence. Then the
  page is rendered and checked again. It is a new row (kind "decisions"),
  so the improved design it came from is kept as it was.
*/

export async function runDesignDecisionsJob(
  job: DesignDecisionsJobData,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  const [version] = await db.select().from(designImprovement).where(eq(designImprovement.id, job.improvementId)).limit(1);
  if (!version || version.status !== "queued" || version.kind !== "decisions" || !version.parentId) return;
  await progress(db, version.id, "working", "Reading the designer's decisions");

  const [parent] = await db.select().from(designImprovement).where(eq(designImprovement.id, version.parentId)).limit(1);
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, version.copyId)).limit(1);
  const parentSource = parent?.sourceKey ? await storage.get(parent.sourceKey) : null;
  if (!parent || !copy || !parentSource) throw new Error("The improved design is missing. Build it again, then make this version.");
  let page = parentSource.toString("utf8");

  const rows = await db.select().from(designChange).where(eq(designChange.improvementId, parent.id)).orderBy(asc(designChange.number));
  const changes: DecidedChange[] = rows.map((r) => ({
    number: r.number,
    kind: r.kind as DecidedChange["kind"],
    sectionNumber: r.sectionNumber,
    what: r.what,
    why: r.why,
    decision: (r.decision as ChangeDecision | null) ?? null,
  }));
  const plan = planDecisions(changes);
  if (plan.undecided.length > 0) throw new Error("Some changes still need the designer's decision.");
  const nameOf = (n: number) => rows.find((r) => r.sectionNumber === n)?.sectionName ?? `Section ${n}`;

  // The design's images, to render the new version (and the copy, for the edits).
  const design = await loadDesignSource(db, storage, browser, {
    projectId: version.projectId,
    frameId: copy.frameId,
    frameName: copy.frameName,
    purpose: "make this version",
  });
  const project = await loadProjectContext(db, storage, browser, config, { projectId: version.projectId, runId: version.id });
  project.startedByUserId = version.startedByUserId;

  /* ---------- 1. whole sections back as they were, free ---------- */
  const replacements = new Map<number, string>();
  for (const section of plan.revert) {
    const row = rows.find((r) => r.sectionNumber === section && r.beforeHtmlKey);
    const before = row?.beforeHtmlKey ? await storage.get(row.beforeHtmlKey) : null;
    if (before) replacements.set(section, before.toString("utf8"));
  }
  page = replaceCopySections(page, replacements);

  /* ---------- 2. one small edit per section with a mix ---------- */
  const edited: number[] = [];
  const notEdited: { section: number; reason: string }[] = [];
  if (plan.edit.length > 0) {
    // The copy's picture, to show each section as it was before any change.
    const copySource = copy.sourceKey ? (await storage.get(copy.sourceKey))?.toString("utf8") ?? null : null;
    const copyPage = copySource ? withImages(copySource, design.assets) : null;
    const copyShot = copyPage ? await renderConcept(browser, copyPage) : null;
    const copyBands = copyPage ? await measureBands(browser, copyPage) : [];
    const copyHeight = copyShot ? await imageHeight(browser, copyShot.fullPage) : 1;
    const copyParts = copySource ? copySections(copySource) : [];
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildUndoSystemPrompt(), cache_control: CACHE_1H }];

    for (const [i, item] of plan.edit.entries()) {
      await progress(db, version.id, "working", `Putting back section ${i + 1} of ${plan.edit.length}: ${nameOf(item.section)}`);
      const part = copySections(page).find((s) => s.number === item.section)?.part;
      if (!part) {
        notEdited.push({ section: item.section, reason: "The section is missing from the improved design." });
        continue;
      }
      const content: Anthropic.ContentBlockParam[] = [];
      const copyPart = copyParts.find((s) => s.number === item.section)?.part;
      const band = copyPart ? copyBands[copyPart.index] : undefined;
      if (copyShot && band) {
        const [crop] = await cropPicture(
          browser,
          copyShot.fullPage,
          { top: (band.top / 100) * copyHeight, height: ((band.bottom - band.top) / 100) * copyHeight, sourceWidth: VIEWPORT.width },
          VIEWPORT.width,
          2000,
        );
        if (crop) {
          content.push({ type: "text", text: `Section ${item.section} before any change.` });
          content.push(jpeg(crop));
        }
      }
      const notes = new Map(rows.map((r) => [r.number, r.decisionNote]));
      content.push({
        type: "text",
        text: `${buildUndoSectionText({
          section: { number: item.section, name: nameOf(item.section) },
          html: part.html,
          undo: item.undo.map((c) => ({ what: c.what, why: c.why, note: notes.get(c.number) ?? null })),
          keep: item.keep.map((c) => ({ what: c.what })),
          designerNotes: project.intake.data.photos.notes,
        })}\n\n# The page's styles that touch this section (for reference)\n\n${cssForSection(page, part.html, item.section) || "(none)"}`,
      });
      const model = await stepModel(db, "design_decisions");
      const stream = client.messages.stream({
        model,
        max_tokens: 16_000,
        system,
        messages: [{ role: "user", content }],
        ...requestSettings(model, { effort: config.effort, adaptiveThinking: true }),
      });
      const response = await stream.finalMessage();
      await recordCall(db, {
        projectId: version.projectId,
        runId: version.id,
        conceptId: null,
        startedByUserId: version.startedByUserId,
        model,
        step: "design_decisions",
        round: 1,
        usage: usageOf(response.usage),
        turns: [{ stopReason: response.stop_reason, content: response.content }],
        scope: "sections",
      });
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const html = response.stop_reason === "refusal" ? null : readUndoReply(text, item.section);
      if (!html) {
        notEdited.push({ section: item.section, reason: "The edit didn't come back; the section keeps every change." });
        continue;
      }
      page = replaceCopySections(page, new Map([[item.section, html]]));
      edited.push(item.section);
    }
  }

  /* ---------- 3. the new version: rendered, checked, kept ---------- */
  await progress(db, version.id, "working", "Checking the new version");
  const assets = design.assets;
  const withPictures = withImages(page, assets);
  const shot = await renderConcept(browser, withPictures);
  const outcome = await checkEverything(browser, page, { ...project.facts, assets }, assets);
  const base = `${projectStoragePrefix(version.projectId)}figma/improvements/${version.id}/`;
  await storage.put(`${base}source.html`, Buffer.from(page, "utf8"), "text/html");
  await storage.put(`${base}page.html`, Buffer.from(withPictures, "utf8"), "text/html");
  await storage.put(`${base}full.png`, shot.fullPage, "image/png");

  const pushedBack = changes.filter((c) => c.decision === "pushed_back").length;
  const accepted = changes.filter((c) => c.decision === "accepted").length;
  await db
    .update(designImprovement)
    .set({
      status: "done",
      detail: null,
      sourceKey: `${base}source.html`,
      htmlKey: `${base}page.html`,
      pngKey: `${base}full.png`,
      checks: {
        passed: outcome.passed,
        issues: outcome.issues,
        reverted: plan.revert,
        edited,
        notEdited,
        fontsKept: plan.fontsKept,
        accepted,
        pushedBack,
      },
      finishedAt: new Date(),
    })
    .where(eq(designImprovement.id, version.id));

  await recordActivity(db, {
    action: "design.decisions_version_built",
    entityType: "project",
    entityId: version.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { accepted, pushedBack, sectionsPutBack: plan.revert.length, sectionsEdited: edited.length, notEdited: notEdited.length },
    ipAddress: null,
    userAgent: null,
  });
  await postProjectSlack(db, version.projectId, { kind: "design_decisions_version_ready", accepted, pushedBack });
}

async function progress(db: Db, id: string, status: string, detail: string) {
  // The first progress is when the worker started it (13 October 2026): the stuck-work check reads it.
  await db.update(designImprovement).set({ status, detail, startedAt: sql`coalesce(${designImprovement.startedAt}, now())` }).where(eq(designImprovement.id, id));
}

/* A version that did not finish: the reason, kept and logged. */
export async function markDesignDecisionsFailed(improvementId: string, message: string): Promise<void> {
  const db = getDb();
  const [failed] = await db
    .update(designImprovement)
    .set({ status: "failed", detail: null, failureReason: message, finishedAt: new Date() })
    .where(eq(designImprovement.id, improvementId))
    .returning({ projectId: designImprovement.projectId });
  if (!failed) return;
  await recordActivity(db, {
    action: "design.decisions_version_failed",
    entityType: "project",
    entityId: failed.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
