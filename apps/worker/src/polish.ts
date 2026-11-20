import { desc, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { concept, conceptVersion, polishPass } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { PolishJobData } from "@tawd/core/queue";
import {
  CACHE_1H,
  PolishCritiqueError,
  buildPolishCritiqueSystemPrompt,
  buildPolishCritiqueUserText,
  describePolishRequest,
  describeRichness,
  measureRichness,
  outlineBands,
  readPolishCritique,
  splitSections,
  type DirectionId,
  type PolishCritique,
  type SkillId,
  type StoredReview,
  readRunNotes,
} from "@tawd/core/mockups";

import { imageBlock } from "./image-type";
import { stepModel } from "./step-model";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { renderForReview } from "./render";
import { SectionEditError, conceptContext, editBySections, loadProjectContext, recordCall, withImages } from "./pipeline";
import { attachReview, checkFixAndStore, readSource, reviewEach, usageOf, type Working } from "./review";

/*
  Critique then polish (27 September 2026), one bounded pass on a concept:

  1. Impeccable's critique (one call): the page's screenshots, its band
     outline, what is measured (photos, stock, brand colour) and the
     Creative Director's summary; at most eight fixes in six areas.
  2. Impeccable's polish: only those fixes, only on their bands, through
     the usual section edits, then the checks with their bounded fix rounds.
  3. One Creative Director scoring pass on the polished version, so the
     before and after compare like with like.

  The polished page is a new version (stage "polish"); the pass keeps the
  critique and the before and after.
*/

interface Snapshot {
  version: number;
  average: number | null;
  lowest: number | null;
  richness: string;
  checksPassed: boolean | null;
}

function latestScore(review: unknown): { average: number | null; lowest: number | null; summary: string | null } {
  const passes = (review as { passes?: StoredReview[] } | null)?.passes ?? [];
  const last = passes[passes.length - 1];
  return { average: last?.average ?? null, lowest: last?.lowest ?? null, summary: last?.summary ?? null };
}

export async function runPolishJob(job: PolishJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [pass] = await db.select().from(polishPass).where(eq(polishPass.id, job.passId)).limit(1);
  if (!pass || pass.status !== "queued") return;
  await db.update(polishPass).set({ status: "working" }).where(eq(polishPass.id, pass.id));

  const [row] = await db.select().from(concept).where(eq(concept.id, pass.conceptId)).limit(1);
  if (!row) throw new Error("The concept is gone.");
  const [latest] = await db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, row.id)).orderBy(desc(conceptVersion.version)).limit(1);
  if (!latest?.htmlKey) throw new Error("This concept has no version to polish.");
  if (latest.version !== pass.fromVersion) throw new Error(`A newer version (v${latest.version}) was made after this was asked for. Start the polish again on it.`);

  const project = await loadProjectContext(db, storage, browser, config, { projectId: pass.projectId, runId: row.runId });
  project.startedByUserId = pass.requestedByUserId;
  const ctx = await conceptContext(project, config, {
    conceptId: row.id,
    label: row.label,
    direction: row.direction as DirectionId,
    skillId: row.skillId as SkillId,
  });

  const html = await readSource(storage, latest.htmlKey);
  const sections = splitSections(html);
  if (sections.length === 0) throw new Error("The page has no sections to polish.");
  const beforeScore = latestScore(latest.review);
  const beforeRichness = measureRichness(html, project.intake.data.brand.colors);
  const before: Snapshot = {
    version: latest.version,
    average: beforeScore.average,
    lowest: beforeScore.lowest,
    richness: describeRichness(beforeRichness),
    checksPassed: (latest.checks as { passed?: boolean } | null)?.passed ?? null,
  };
  await db.update(polishPass).set({ before }).where(eq(polishPass.id, pass.id));

  // 1. The critique.
  const skillDir = path.resolve(config.skillsDir, "impeccable-tawd", "reference");
  const [critiqueReference, polishReference] = await Promise.all([
    readFile(path.join(skillDir, "critique.md"), "utf8"),
    readFile(path.join(skillDir, "polish.md"), "utf8"),
  ]);
  const shots = await renderForReview(browser, withImages(html, project.assets, project.stock));
  // Labelled by their bytes: the review's renders are JPEGs (gap 10: labelled PNG, the API refused them).
  const images: Anthropic.ContentBlockParam[] = [shots.fold, ...shots.slices].map(imageBlock);
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildPolishCritiqueSystemPrompt(critiqueReference), cache_control: CACHE_1H }];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        ...images,
        { type: "text", text: buildPolishCritiqueUserText({ outline: outlineBands(sections), reviewSummary: beforeScore.summary, richness: beforeRichness }) },
      ],
    },
  ];
  let critique: PolishCritique | null = null;
  for (let attempt = 1; attempt <= 2 && !critique; attempt += 1) {
    const model = await stepModel(db, "polish_critique");
    const response = await client.messages
      .stream({ model, max_tokens: 8_000, system, messages, ...requestSettings(model, { effort: config.effort }) })
      .finalMessage();
    await recordCall(db, {
      projectId: pass.projectId,
      runId: pass.id,
      conceptId: row.id,
      startedByUserId: pass.requestedByUserId,
      model,
      step: "polish_critique",
      round: attempt,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      critique = readPolishCritique(text, sections.length);
    } catch (error) {
      if (!(error instanceof PolishCritiqueError) || attempt === 2) throw new Error(`The critique couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the JSON object.` });
    }
  }
  if (!critique) throw new Error("The critique didn't finish.");
  await db.update(polishPass).set({ critique: critique.fixes }).where(eq(polishPass.id, pass.id));
  if (critique.fixes.length === 0) {
    await db.update(polishPass).set({ status: "done", after: before, finishedAt: new Date() }).where(eq(polishPass.id, pass.id));
    return;
  }

  // 2. The polish: only the critique's bands.
  let polished: string;
  try {
    polished = (
      await editBySections(db, ctx, config, client, {
        step: "polish",
        html,
        request: describePolishRequest(critique, polishReference),
        known: [...new Set(critique.fixes.map((f) => f.band))],
        unplaced: "",
      })
    ).html;
  } catch (error) {
    if (error instanceof SectionEditError) throw new Error(`The polish was not made: ${error.message}`, { cause: error });
    throw error;
  }

  const working: Working = { ctx, version: latest.version, versionId: latest.id, html, outcome: null, checksSummary: "All passed", runNotes: readRunNotes(latest.checks), rebuilt: false, lastReview: null };
  const reviewer = {
    db,
    project,
    config,
    client,
    browser,
    creativeDirector: await readFile(path.resolve(config.skillsDir, "CREATIVE-DIRECTOR.md"), "utf8"),
  };
  await checkFixAndStore(db, storage, reviewer, working, {
    conversation: [
      { role: "user", content: ctx.opening() },
      { role: "assistant", content: polished },
    ],
    html: polished,
    stage: "polish",
    stepName: "polish",
  });

  // 3. One scoring pass on the polished version.
  /*
    How many concepts the RUN has, not how many this pass reviews (Jason's
    run, 10 November 2026). This pass scores one concept on its own, and
    passing it as the whole run made Direction fit come back "Not
    applicable: this run has only one concept to compare" - untrue, and one
    of the eleven questions lost on every polished concept.
  */
  const conceptsInRun = (await db.select({ id: concept.id }).from(concept).where(eq(concept.runId, row.runId))).length;
  const scores = await reviewEach(reviewer, "changes", 1, [working], [working], {
    earlierNotes: new Map([[row.label, critique.fixes.map((f) => ({ question: "Polish", note: `${f.area}: ${f.fix}` }))]]),
    conceptsInRun,
  });
  const score = scores.results.get(row.label) ?? null;
  if (score) await attachReview(db, working.versionId, score);

  const after: Snapshot = {
    version: working.version,
    average: score?.average ?? null,
    lowest: score?.lowest ?? null,
    richness: describeRichness(measureRichness(working.html, project.intake.data.brand.colors)),
    checksPassed: working.outcome?.passed ?? null,
  };
  await db.update(polishPass).set({ status: "done", toVersion: working.version, after, finishedAt: new Date() }).where(eq(polishPass.id, pass.id));
  await recordActivity(db, {
    action: "mockups.polished",
    entityType: "project",
    entityId: pass.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { concept: row.label, from: before.version, to: after.version, before: before.average, after: after.average, fixes: critique.fixes.length },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markPolishFailed(passId: string, reason: string): Promise<void> {
  await getDb().update(polishPass).set({ status: "failed", failureReason: reason.slice(0, 1000), finishedAt: new Date() }).where(eq(polishPass.id, passId));
}
