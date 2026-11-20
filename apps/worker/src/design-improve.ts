import { CACHE_1H } from "@tawd/core/mockups";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { designChange, designCopy, designFinding, designImprovement, designReview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import type { DesignImproveJobData } from "@tawd/core/queue";
import {
  LOCATE_FIXES_JSON_SCHEMA,
  RESCORE_JSON_SCHEMA,
  buildImproveSectionText,
  buildImproveSystemPrompt,
  buildLocateFixesText,
  buildRescoreText,
  copySections,
  cssForSection,
  designTextsBySection,
  frameSections,
  placeFixes,
  readImproveReply,
  readLocatedFixes,
  readRescore,
  replaceCopySections,
  type FigmaNode,
  type FixToApply,
  type FrameSection,
  type StoredDesignReview,
} from "@tawd/core/figma";
import { ReviewFormatError, buildReviewerSystemPrompt, describeFactsForPrompt } from "@tawd/core/mockups";

import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { loadDesignSource } from "./design-source";
import { applyCodeFixes, checkEverything, loadProjectContext, recordCall, withImages, type Db } from "./pipeline";
import { VIEWPORT, cropPicture, imageHeight, measureBands, renderConcept, renderForReview } from "./render";
import { jpeg, usageOf } from "./review";

/*
  Lane 2, Option B, 4c: the improved design.

  The fixes the team ticked in the Creative Director's review are made on
  the faithful copy, one Figma section at a time (one AI call per section
  that has fixes; one small call first to place fixes that have no pin).
  Contrast still failing afterwards gets a darker shade of the same colour,
  by code, for free; a font the design used without a web licence is its
  own change. Every change is kept with the section's before and after
  (pictures and markup), so the designer can accept it or push back. Then
  one Creative Director re-score. Every AI answer is saved before it is read.
*/

interface TrackedChange {
  kind: "fix" | "contrast" | "font";
  sectionNumber: number;
  what: string;
  why: string;
  fixes: number[];
}

export async function runDesignImproveJob(
  job: DesignImproveJobData,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  const [improvement] = await db.select().from(designImprovement).where(eq(designImprovement.id, job.improvementId)).limit(1);
  // The project was deleted, or this already ran.
  if (!improvement || improvement.status !== "queued") return;
  await progress(db, improvement.id, "working", "Getting the copy and the review");

  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, improvement.copyId)).limit(1);
  const sourceBody = copy?.sourceKey ? await storage.get(copy.sourceKey) : null;
  if (!copy || !sourceBody) throw new Error("The faithful copy is missing. Build it again, then improve it.");
  const source = sourceBody.toString("utf8");
  const [review] = await db.select().from(designReview).where(eq(designReview.id, improvement.reviewId)).limit(1);
  const before = (review?.review as StoredDesignReview | null) ?? null;

  const design = await loadDesignSource(db, storage, browser, {
    projectId: improvement.projectId,
    frameId: copy.frameId,
    frameName: copy.frameName,
    purpose: "improve it",
  });
  const project = await loadProjectContext(db, storage, browser, config, { projectId: improvement.projectId, runId: improvement.id });
  project.startedByUserId = improvement.startedByUserId;
  const factsKnown = describeFactsForPrompt(project.intakeFacts).known;
  const tradeLabel = project.trade.replace(/_/g, " ");

  const sections: FrameSection[] = frameSections(design.home).map((s) => ({ number: s.index + 1, name: s.name, top: s.top, height: s.height }));
  const nameOf = (n: number) => sections.find((s) => s.number === n)?.name ?? `Section ${n}`;

  const findings = await db
    .select()
    .from(designFinding)
    .where(
      and(
        eq(designFinding.reviewId, improvement.reviewId),
        eq(designFinding.ticked, true),
        inArray(designFinding.grade, ["must_fix", "should_fix"]),
      ),
    )
    .orderBy(asc(designFinding.number));
  const fixes: FixToApply[] = findings.map((f) => ({
    number: f.number,
    grade: f.grade,
    category: f.category,
    title: f.title,
    problem: f.problem,
    change: f.change,
    why: f.why,
    pinY: f.pinY,
  }));
  const titleOf = (n: number) => fixes.find((f) => f.number === n)?.title ?? `Fix ${n}`;

  /* ---------- the copy as it is: its picture, and where each section sits ---------- */
  const beforePage = withImages(source, design.assets);
  const beforeShot = await renderConcept(browser, beforePage);
  const beforeBands = await measureBands(browser, beforePage);
  const beforeHeight = await imageHeight(browser, beforeShot.fullPage);
  const beforeParts = copySections(source);

  const call = async (input: {
    step: "design_improve" | "design_rescore";
    round: number;
    system?: Anthropic.TextBlockParam[];
    content: Anthropic.ContentBlockParam[];
    maxTokens: number;
    effort: WorkerConfig["effort"];
    schema?: Record<string, unknown>;
    scope?: "sections" | "locate" | "page";
  }): Promise<{ text: string; stopReason: string | null }> => {
    const model = await stepModel(db, input.step);
    const stream = client.messages.stream({
      model,
      max_tokens: input.maxTokens,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: input.content }],
      ...requestSettings(model, { effort: input.effort, adaptiveThinking: !input.schema, ...(input.schema ? { format: { type: "json_schema", schema: input.schema } } : {}) }),
    });
    const response = await stream.finalMessage();
    await recordCall(db, {
      projectId: improvement.projectId,
      runId: improvement.id,
      conceptId: null,
      startedByUserId: improvement.startedByUserId,
      model,
      step: input.step,
      round: input.round,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
      scope: input.scope ?? null,
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { text, stopReason: response.stop_reason };
  };

  /* ---------- 1. where each fix goes ---------- */
  const notApplied: { fix: number; title: string; reason: string }[] = [];
  const { placed, unplaced } = placeFixes(fixes, sections, design.frame.height);
  if (unplaced.length > 0) {
    await progress(db, improvement.id, "working", "Finding where each fix goes");
    const located = await call({
      step: "design_improve",
      round: 1,
      scope: "locate",
      maxTokens: 4_000,
      effort: "low",
      schema: LOCATE_FIXES_JSON_SCHEMA,
      content: [{ type: "text", text: buildLocateFixesText({ fixes: unplaced, sections: designTextsBySection(design.home) }) }],
    });
    const where = readLocatedFixes(located.text, unplaced.map((f) => f.number), sections.map((s) => s.number));
    for (const fix of unplaced) {
      const section = where.get(fix.number);
      if (section === undefined) {
        notApplied.push({ fix: fix.number, title: fix.title, reason: "TAWD couldn't tell which part of the page this fix is about." });
        continue;
      }
      placed.set(section, [...(placed.get(section) ?? []), fix]);
    }
  }
  for (const [number, list] of [...placed]) {
    if (beforeParts.some((p) => p.number === number)) continue;
    for (const fix of list) notApplied.push({ fix: fix.number, title: fix.title, reason: "That part of the design is missing from the faithful copy." });
    placed.delete(number);
  }

  /* ---------- 2. the fixes, one section at a time ---------- */
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildImproveSystemPrompt(), cache_control: CACHE_1H }];
  const replacements = new Map<number, string>();
  const changes: TrackedChange[] = [];
  const order = [...placed.keys()].sort((a, b) => a - b);
  for (const [i, number] of order.entries()) {
    await progress(db, improvement.id, "working", `Fixing section ${i + 1} of ${order.length}: ${nameOf(number)}`);
    const part = beforeParts.find((p) => p.number === number)!.part;
    const sectionFixes = placed.get(number)!;
    const crops = await cropBand(browser, beforeShot.fullPage, beforeHeight, beforeBands[part.index]);
    const content: Anthropic.ContentBlockParam[] = [];
    crops.forEach((crop, index) => {
      content.push({ type: "text", text: `Section ${number} as it looks now${crops.length > 1 ? `, part ${index + 1} of ${crops.length}` : ""}.` });
      content.push(jpeg(crop));
    });
    content.push({
      type: "text",
      text: buildImproveSectionText({
        clientName: project.clientName,
        tradeLabel,
        section: { number, name: nameOf(number) },
        totalSections: sections.length,
        html: part.html,
        css: cssForSection(source, part.html, number),
        fixes: sectionFixes,
        factsKnown,
        designerNotes: project.intake.data.photos.notes,
      }),
    });
    const answer = await call({ step: "design_improve", round: 1, scope: "sections", system, content, maxTokens: 32_000, effort: config.effort });
    if (answer.stopReason === "refusal") {
      for (const fix of sectionFixes) notApplied.push({ fix: fix.number, title: fix.title, reason: "The builder declined to make this fix." });
      continue;
    }
    const reply = readImproveReply(answer.text, number, sectionFixes);
    if (reply.html) replacements.set(number, reply.html);
    for (const change of reply.changes) changes.push({ kind: "fix", sectionNumber: number, what: change.what, why: change.why, fixes: change.fixes });
    for (const skipped of reply.skipped) notApplied.push({ fix: skipped.fix, title: titleOf(skipped.fix), reason: skipped.reason });
  }
  let improved = replaceCopySections(source, replacements);

  /* ---------- 3. contrast, by code: a darker shade of the same colour ---------- */
  await progress(db, improvement.id, "working", "Checking the improved page");
  let outcome = await checkEverything(browser, improved, { ...project.facts, assets: design.assets }, design.assets);
  if (outcome.issues.some((issue) => issue.id === "a11y.contrast")) {
    const partsBefore = new Map(copySections(improved).map((s) => [s.number, s.part.html]));
    const fixed = await applyCodeFixes(browser, improved, outcome, design.assets);
    if (fixed.fixed.includes("contrast")) {
      for (const s of copySections(fixed.html)) {
        if (partsBefore.get(s.number) === s.part.html) continue;
        changes.push({
          kind: "contrast",
          sectionNumber: s.number,
          what: "Some text now uses a darker (or lighter) shade of its own colour, so it can be read easily.",
          why: "Text under the contrast floor (4.5 to 1, or 3 to 1 for large text) is hard to read; the brand colour itself stays as it is.",
          fixes: [],
        });
      }
      improved = fixed.html;
      outcome = await checkEverything(browser, improved, { ...project.facts, assets: design.assets }, design.assets);
    }
  }

  /* ---------- 4. fonts without a web licence: their own change ---------- */
  const substitutedFonts = design.readiness.fonts.filter((f) => !f.usable);
  const copyNotes = (copy.notes as string[] | null) ?? [];
  for (const font of substitutedFonts) {
    const section = firstSectionWithFont(design.home, font.family);
    if (section === null) continue;
    const note = copyNotes.find((n) => n.toLowerCase().includes(font.family.toLowerCase()));
    changes.push({
      kind: "font",
      sectionNumber: section,
      what: note ?? `The designer's font ${font.family} has no web licence, so the closest free Google Font is used instead.`,
      why: "A font without a web licence can't be used on a live website; the closest free one keeps the look.",
      fixes: [],
    });
  }

  /* ---------- 5. the improved page, and each change's before and after ---------- */
  await progress(db, improvement.id, "working", "Taking the before and after pictures");
  const afterPage = withImages(improved, design.assets);
  const afterShot = await renderConcept(browser, afterPage);
  const afterBands = await measureBands(browser, afterPage);
  const afterHeight = await imageHeight(browser, afterShot.fullPage);
  const afterParts = copySections(improved);

  const base = `${projectStoragePrefix(improvement.projectId)}figma/improvements/${improvement.id}/`;
  await storage.put(`${base}source.html`, Buffer.from(improved, "utf8"), "text/html");
  await storage.put(`${base}page.html`, Buffer.from(afterPage, "utf8"), "text/html");
  await storage.put(`${base}full.png`, afterShot.fullPage, "image/png");

  // In page order; within a section, the fixes, then contrast, then the font.
  const kindOrder = { fix: 0, contrast: 1, font: 2 };
  changes.sort((a, b) => a.sectionNumber - b.sectionNumber || kindOrder[a.kind] - kindOrder[b.kind]);
  const rows: (typeof designChange.$inferInsert)[] = [];
  for (const [index, change] of changes.entries()) {
    const number = index + 1;
    const beforePart = beforeParts.find((p) => p.number === change.sectionNumber)?.part;
    const afterPart = afterParts.find((p) => p.number === change.sectionNumber)?.part;
    const frameSection = sections.find((s) => s.number === change.sectionNumber);
    // A font change is shown against the Figma design itself: the copy already had the stand-in.
    const [beforeImage] =
      change.kind === "font" && frameSection
        ? await cropPicture(browser, design.picture, { top: frameSection.top, height: frameSection.height, sourceWidth: design.frame.width }, 720, 1400)
        : await cropBand(browser, beforeShot.fullPage, beforeHeight, beforePart ? beforeBands[beforePart.index] : undefined, 720, 1400);
    const [afterImage] = await cropBand(browser, afterShot.fullPage, afterHeight, afterPart ? afterBands[afterPart.index] : undefined, 720, 1400);
    const key = (name: string) => `${base}changes/${number}-${name}`;
    if (beforeImage) await storage.put(key("before.jpg"), beforeImage, "image/jpeg");
    if (afterImage) await storage.put(key("after.jpg"), afterImage, "image/jpeg");
    if (beforePart) await storage.put(key("before.html"), Buffer.from(beforePart.html, "utf8"), "text/html");
    if (afterPart) await storage.put(key("after.html"), Buffer.from(afterPart.html, "utf8"), "text/html");
    rows.push({
      improvementId: improvement.id,
      projectId: improvement.projectId,
      number,
      kind: change.kind,
      sectionNumber: change.sectionNumber,
      sectionName: nameOf(change.sectionNumber),
      what: change.what,
      why: change.why,
      findingNumbers: change.fixes,
      beforeImageKey: beforeImage ? key("before.jpg") : null,
      afterImageKey: afterImage ? key("after.jpg") : null,
      beforeHtmlKey: beforePart ? key("before.html") : null,
      afterHtmlKey: afterPart ? key("after.html") : null,
    });
  }
  if (rows.length > 0) await db.insert(designChange).values(rows);

  /* ---------- 6. one Creative Director re-score ---------- */
  await progress(db, improvement.id, "working", "Creative Director scoring the improved design");
  let rescore: StoredDesignReview | null = null;
  let rescoreFailure: string | null = null;
  try {
    rescore = await rescoreImproved();
  } catch (error) {
    rescoreFailure = error instanceof Error ? error.message : "The re-score didn't finish.";
  }

  await db
    .update(designImprovement)
    .set({
      status: "done",
      detail: null,
      sourceKey: `${base}source.html`,
      htmlKey: `${base}page.html`,
      pngKey: `${base}full.png`,
      rescore,
      checks: { passed: outcome.passed, issues: outcome.issues, rescoreFailure },
      notApplied,
      finishedAt: new Date(),
    })
    .where(eq(designImprovement.id, improvement.id));

  await recordActivity(db, {
    action: "design.improved",
    entityType: "project",
    entityId: improvement.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      frame: copy.frameName,
      changes: rows.length,
      notApplied: notApplied.length,
      before: before?.average ?? null,
      after: rescore?.average ?? null,
    },
    ipAddress: null,
    userAgent: null,
  });
  await postProjectSlack(db, improvement.projectId, {
    kind: "design_improved",
    changes: rows.length,
    before: before?.average ?? null,
    after: rescore?.average ?? null,
  });

  async function rescoreImproved(): Promise<StoredDesignReview> {
    const creativeDirector = await readFile(path.resolve(config.skillsDir, "CREATIVE-DIRECTOR.md"), "utf8");
    const shots = await renderForReview(browser, afterPage);
    const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: "The improved homepage: first screen at 1440 by 900." }, jpeg(shots.fold)];
    shots.slices.forEach((slice, index) => {
      content.push({ type: "text", text: `The improved homepage: full page, part ${index + 1} of ${shots.slices.length}.` });
      content.push(jpeg(slice));
    });
    content.push({
      type: "text",
      text: buildRescoreText({
        clientName: project.clientName,
        tradeLabel,
        frameName: copy!.frameName,
        changes: changes.map((c) => `${nameOf(c.sectionNumber)}: ${c.what}`),
        notApplied: notApplied.map((n) => `${n.title}: ${n.reason}`),
        designerNotes: project.intake.data.photos.notes,
      }),
    });
    const reviewerSystem: Anthropic.TextBlockParam[] = [
      { type: "text", text: buildReviewerSystemPrompt(creativeDirector, project.profileText), cache_control: CACHE_1H },
    ];
    let failure: ReviewFormatError | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retry = failure ? [{ type: "text" as const, text: `Your last answer could not be used. ${failure.retryHint}` }] : [];
      const answer = await call({
        step: "design_rescore",
        round: attempt,
        system: reviewerSystem,
        content: [...content, ...retry],
        maxTokens: 16_000,
        effort: config.effort,
        schema: RESCORE_JSON_SCHEMA,
        scope: "page",
      });
      if (answer.stopReason === "refusal") throw new Error("The Creative Director declined to score the improved design.");
      try {
        return readRescore(answer.text);
      } catch (error) {
        if (!(error instanceof ReviewFormatError)) throw error;
        failure = error;
      }
    }
    throw new Error(`The re-score could not be used: ${failure?.message ?? "no answer"}`);
  }
}

/* The strip of a full-page picture one band covers (percent down the page), cut to size. */
async function cropBand(
  browser: Browser,
  png: Buffer,
  height: number,
  band: { top: number; bottom: number } | undefined,
  width = VIEWPORT.width,
  maxHeight = 2000,
): Promise<Buffer[]> {
  if (!band) return [];
  return cropPicture(
    browser,
    png,
    { top: (band.top / 100) * height, height: ((band.bottom - band.top) / 100) * height, sourceWidth: VIEWPORT.width },
    width,
    maxHeight,
  );
}

/* The number of the first top-level section with text in this font, or null. */
function firstSectionWithFont(frame: FigmaNode, family: string): number | null {
  const uses = (n: FigmaNode): boolean =>
    (n.type === "TEXT" &&
      (n.style?.fontFamily === family ||
        Object.values(n.styleOverrideTable ?? {}).some((o) => (o as { fontFamily?: string }).fontFamily === family))) ||
    (n.children ?? []).some(uses);
  const index = (frame.children ?? []).findIndex(uses);
  return index === -1 ? null : index + 1;
}

async function progress(db: Db, id: string, status: string, detail: string) {
  // The first progress is when the worker started it (13 October 2026): the stuck-work check reads it.
  await db.update(designImprovement).set({ status, detail, startedAt: sql`coalesce(${designImprovement.startedAt}, now())` }).where(eq(designImprovement.id, id));
}

/* An improvement that did not finish: the reason, kept and logged. */
export async function markDesignImprovementFailed(improvementId: string, message: string): Promise<void> {
  const db = getDb();
  const [failed] = await db
    .update(designImprovement)
    .set({ status: "failed", detail: null, failureReason: message, finishedAt: new Date() })
    .where(eq(designImprovement.id, improvementId))
    .returning({ projectId: designImprovement.projectId });
  if (!failed) return;
  await recordActivity(db, {
    action: "design.improve_failed",
    entityType: "project",
    entityId: failed.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
