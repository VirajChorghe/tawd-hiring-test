import { CACHE_1H } from "@tawd/core/mockups";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { designCopy, figmaDesign } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import type { FaithfulCopyJobData } from "@tawd/core/queue";
import {
  VISUAL_CHECK_JSON_SCHEMA,
  assembleFaithfulPage,
  buildFaithfulSectionText,
  buildFaithfulSystemPrompt,
  buildVisualCheckText,
  CLEAN_FRAME_MESSAGE,
  stillOffAdvice,
  compareCopyText,
  describeFrameForBuild,
  designTextsBySection,
  frameSections,
  groupSections,
  readVisualCheck,
  type FrameSection,
  type VisualCheck,
} from "@tawd/core/figma";
import { parseSectionReplies } from "@tawd/core/mockups";

import { stepModel } from "./step-model";
import { eachAtOnce, sectionCallsAtOnce } from "./at-once";
import { requestSettings } from "@tawd/core/mockups";
import type { WorkerConfig } from "./config";
import { loadDesignSource } from "./design-source";
import { compareWithDesign } from "./fidelity";
import { checkEverything, loadProjectContext, recordCall, withImages } from "./pipeline";
import { VIEWPORT, cropPicture, imageHeight, measureBands, pageTextsBySection, renderConcept } from "./render";
import { jpeg, usageOf } from "./review";
import { describeMisses, planSection, type CheckResult, type SectionPlan } from "@tawd/core/style-kit/element-check";
import { applyKit, describeKit, describeSectionForKit } from "@tawd/core/style-kit/kit";
import type { SectionInventory } from "@tawd/core/style-kit/elements";
import { runElementCheck } from "./element-check";
import { loadKitForCopy, matchKitSections } from "./style-kit-job";

/*
  Lane 2, Option B: the faithful copy. The designer's homepage frame
  rebuilt as a static HTML page with nothing changed (one full-page AI
  call, saved before it is read), rendered, checked for information only,
  and compared with the Figma frame for free.
*/

export async function runFaithfulCopyJob(
  job: FaithfulCopyJobData,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<void> {
  const db = getDb();
  const storage = getStorage();

  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, job.copyId)).limit(1);
  if (!copy || copy.status !== "queued") return;
  await db.update(designCopy).set({ status: "working", startedAt: new Date() }).where(eq(designCopy.id, copy.id));

  const { frame, readiness, picture, home, byImageRef, byNodeId, assets, frameProblems } = await loadDesignSource(db, storage, browser, {
    projectId: copy.projectId,
    frameId: copy.frameId,
    frameName: copy.frameName,
    purpose: "build the copy",
  });

  const project = await loadProjectContext(db, storage, browser, config, { projectId: copy.projectId, runId: copy.id });
  const sections: FrameSection[] = frameSections(home).map((s) => ({ number: s.index + 1, name: s.name, top: s.top, height: s.height }));
  if (sections.length === 0) throw new Error(`The frame "${copy.frameName}" has nothing in it to copy.`);
  const assetList = assets.map((a) => ({
    token: a.token,
    label: a.token.includes("logo") ? "the designer's logo" : a.token.includes("icon") ? `a drawing ("${a.caption ?? ""}")` : "a photo from the design",
    width: a.width,
    height: a.height,
  }));
  /*
    The style kit (28 September 2026): when the design has one, the builder
    uses its classes and icon markers, code fills them in, and every
    section is checked item by item against the design's inventory.
  */
  const styled = await loadKitForCopy(db, { projectId: copy.projectId, designVersion: copy.figmaVersion, frameId: copy.frameId });
  const kitSections = styled ? matchKitSections(sections, styled.inventory) : new Map<number, SectionInventory>();
  const plans: SectionPlan[] = styled ? [...kitSections.entries()].map(([number, inv]) => ({ ...planSection(styled.kit, inv), number, name: sections[number - 1]!.name })) : [];
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildFaithfulSystemPrompt(), cache_control: CACHE_1H },
    ...(styled ? [{ type: "text" as const, text: describeKit(styled.kit), cache_control: CACHE_1H }] : []),
  ];

  /* ---------- one call per group of sections, in Figma order ---------- */
  const built = new Map<number, string>();
  /*
    Parallel copying (28 September 2026): each call's pictures are cut
    first, in the one browser, one after another (quick); then the calls go
    out together, up to sectionCallsAtOnce(), since they only wait on the
    network. A page takes about as long as its slowest group instead of the
    sum of them.
  */
  type Retry = { differences: string[]; copyPng: Buffer | null; bands: { top: number; bottom: number }[] } | null;
  const prepare = async (group: FrameSection[], retry: Retry): Promise<Anthropic.ContentBlockParam[]> => {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const section of group) {
      const crops = await cropPicture(browser, picture, { top: section.top, height: section.height, sourceWidth: frame.width });
      crops.forEach((crop, i) => {
        content.push({ type: "text", text: `The design, section ${section.number} "${section.name}"${crops.length > 1 ? `, part ${i + 1} of ${crops.length}` : ""}.` });
        content.push(jpeg(crop));
      });
    }
    if (retry?.copyPng) {
      for (const section of group) {
        const band = retry.bands[section.number - 1];
        if (!band) continue;
        const copyHeight = await imageHeight(browser, retry.copyPng);
        const crops = await cropPicture(browser, retry.copyPng, {
          top: (band.top / 100) * copyHeight,
          height: ((band.bottom - band.top) / 100) * copyHeight,
          sourceWidth: VIEWPORT.width,
        });
        crops.forEach((crop) => {
          content.push({ type: "text", text: `Your first build of section ${section.number}.` });
          content.push(jpeg(crop));
        });
      }
    }
    content.push({
      type: "text",
      text: buildFaithfulSectionText({
        clientName: project.clientName,
        frameName: frame.name,
        frameWidth: frame.width,
        totalSections: sections.length,
        sections: group,
        outline: describeFrameForBuild(home, { byImageRef, byNodeId }, group.map((s) => s.number - 1)),
        assets: assetList,
        fonts: readiness.fonts,
        retry: retry ? { differences: retry.differences } : null,
      }),
    });
    if (styled) {
      const kitText = group.map((s) => (kitSections.has(s.number) ? describeSectionForKit(styled.kit, { ...kitSections.get(s.number)!, number: s.number }) : "")).filter(Boolean);
      if (kitText.length) content.push({ type: "text", text: `${kitText.join("\n\n")}\n\nPositions are in the design's pixels, from the top of the section.` });
    }
    return content;
  };
  const ask = async (content: Anthropic.ContentBlockParam[], group: FrameSection[], round: number) => {
    // Sonnet first; a section rebuilt after a low score or a bad look goes to the retry model, Opus (Jason, 27 September 2026).
    const model = await stepModel(db, round > 1 ? "faithful_copy_retry" : "faithful_copy");
    const stream = client.messages.stream({
      model,
      max_tokens: 32_000,
      system,
      messages: [{ role: "user", content }],
      ...requestSettings(model, { effort: config.effort, adaptiveThinking: true }),
    });
    const response = await stream.finalMessage();
    await recordCall(db, {
      projectId: copy.projectId,
      runId: copy.id,
      conceptId: null,
      startedByUserId: copy.startedByUserId,
      model,
      step: "faithful_copy",
      round,
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    if (response.stop_reason === "refusal") throw new Error("The builder declined to copy this design.");
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const replies = parseSectionReplies(text, group.map((s) => s.number));
    for (const [number, html] of replies) {
      if (/data-figma-section/.test(html)) built.set(number, html);
    }
  };

  // Progress for the copies list (28 September 2026): sections built, the look, the rebuilds.
  const progress = (stage: "building" | "checking" | "rebuilding", done: number, total: number) =>
    db.update(designCopy).set({ progress: { stage, done, total } }).where(eq(designCopy.id, copy.id));
  await progress("building", 0, sections.length);
  const firstCalls: { group: FrameSection[]; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const group of groupSections(sections)) firstCalls.push({ group, content: await prepare(group, null) });
  await eachAtOnce(firstCalls, sectionCallsAtOnce(), async ({ group, content }) => {
    await ask(content, group, 1);
    await progress("building", built.size, sections.length);
  });
  // A section that didn't come back gets one more try on its own (together, too).
  const missed: { group: FrameSection[]; content: Anthropic.ContentBlockParam[] }[] = [];
  for (const section of sections.filter((s) => !built.has(s.number))) missed.push({ group: [section], content: await prepare([section], null) });
  await eachAtOnce(missed, sectionCallsAtOnce(), ({ group, content }) => ask(content, group, 1));
  if (built.size === 0) throw new Error("No section of the copy came back. Build the copy again.");

  /* ---------- put it together, render, compare, read its text ---------- */
  const title = `${project.clientName}: ${frame.name}`;
  const designTexts = designTextsBySection(home);
  const measure = async () => {
    const assembled = assembleFaithfulPage({
      title,
      sections: sections.map((s) => ({ number: s.number, name: s.name, html: built.get(s.number) ?? null })),
    });
    const page = styled ? applyKit(withImages(assembled.html, assets), styled.kit, styled.css).html : withImages(assembled.html, assets);
    const shot = await renderConcept(browser, page);
    const bands = await measureBands(browser, page);
    const fidelity = await compareWithDesign(browser, {
      design: picture,
      copy: shot.fullPage,
      frameWidth: frame.width,
      sections: sections.map((s) => ({ name: s.name, top: s.top, height: s.height })),
      copyBands: bands,
    });
    const text = compareCopyText(designTexts, await pageTextsBySection(browser, page));
    const elements: CheckResult | null = styled && plans.length ? await runElementCheck(browser, page, plans) : null;
    return { assembled, page, shot, bands, fidelity, text, elements };
  };
  const first = await measure();

  /* ---------- a look with eyes, then one rebuild of the sections that are off ---------- */
  await progress("checking", sections.length, sections.length);
  const visual = await lookAtCopy(first.shot.fullPage, first.bands);
  const textTrouble = (n: number) => {
    const t = first.text.find((s) => s.number === n);
    // Order alone is shown but never worth a paid rebuild: layouts can read in more than one fair order.
    return t ? t.missing.length + t.extra.length + t.repeated.length > 0 : false;
  };
  // The element check (28 September 2026): any miss fails the section.
  const elementMisses = (result: CheckResult | null, n: number) => {
    const section = result?.sections.find((x) => x.number === n);
    return section ? describeMisses({ sections: [section], passed: section.passed }) : [];
  };
  const toRebuild = sections.filter((s) => {
    const seen = visual?.sections.find((v) => v.section === s.number);
    const score = first.fidelity.method === "sections" ? first.fidelity.sections[s.number - 1]?.score ?? 100 : 100;
    return seen?.verdict === "off" || textTrouble(s.number) || score < 75 || !built.has(s.number) || elementMisses(first.elements, s.number).length > 0;
  });
  const rebuilds: { group: FrameSection[]; content: Anthropic.ContentBlockParam[] }[] = [];
  await progress("rebuilding", 0, toRebuild.length);
  for (const section of toRebuild) {
    const seen = visual?.sections.find((v) => v.section === section.number)?.differences ?? [];
    const t = first.text.find((s) => s.number === section.number);
    const differences = [
      ...seen,
      ...(t?.missing ?? []).map((m) => `This text from the design is missing: "${m}"`),
      ...(t?.extra ?? []).map((e) => `This text is not in the design and must go: "${e}"`),
      ...(t?.repeated ?? []).map((r) => `This text appears more often than in the design: "${r}"`),
      ...(t?.outOfOrder ? ["Put the text in the design's order."] : []),
      ...elementMisses(first.elements, section.number).map((m) => `From the style kit check: ${m.replace(/^[^:]*: /, "")} Use the kit's class or icon marker for it.`),
    ];
    rebuilds.push({
      group: [section],
      content: await prepare([section], {
        differences: differences.length > 0 ? differences : ["It does not match the design closely enough; compare it with the design again."],
        copyPng: built.has(section.number) ? first.shot.fullPage : null,
        bands: first.bands,
      }),
    });
  }
  let rebuilt = 0;
  await eachAtOnce(rebuilds, sectionCallsAtOnce(), async ({ group, content }) => {
    await ask(content, group, 2);
    rebuilt += 1;
    await progress("rebuilding", rebuilt, toRebuild.length);
  });
  const final = toRebuild.length > 0 ? await measure() : first;

  /*
    A section that still doesn't match after its one rebuild isn't called
    done (27 September 2026): the design file usually has overlapping or
    leftover content, which only cleaning the frame in Figma fixes.
  */
  const stillOff = toRebuild.filter((s) => {
    const t = final.text.find((x) => x.number === s.number);
    const score = final.fidelity.method === "sections" ? final.fidelity.sections[s.number - 1]?.score ?? 100 : 100;
    return score < 75 || (t ? t.missing.length + t.extra.length + t.repeated.length > 0 : false) || elementMisses(final.elements, s.number).length > 0;
  });

  /* ---------- keep it ---------- */
  const [design] = await db.select({ source: figmaDesign.source }).from(figmaDesign).where(eq(figmaDesign.projectId, copy.projectId)).limit(1);
  const source = design?.source ?? null;
  const base = `${projectStoragePrefix(copy.projectId)}figma/copies/${copy.id}/`;
  await storage.put(`${base}source.html`, Buffer.from(final.assembled.html, "utf8"), "text/html");
  await storage.put(`${base}page.html`, Buffer.from(final.page, "utf8"), "text/html");
  await storage.put(`${base}full.png`, final.shot.fullPage, "image/png");
  const outcome = await checkEverything(browser, final.assembled.html, { ...project.facts, assets }, assets);
  const notes = [
    ...final.assembled.notes,
    ...final.assembled.missing.map((n) => `Section ${n} ("${sections[n - 1]?.name ?? ""}") could not be built; it is left empty.`),
  ];

  await db
    .update(designCopy)
    .set({
      status: stillOff.length > 0 ? "needs_cleanup" : "done",
      failureReason: stillOff.length > 0 ? stillOffAdvice(source, `${CLEAN_FRAME_MESSAGE} Still different after a rebuild: ${stillOff.map((s) => `"${s.name}"`).join(", ")}.`) : null,
      sourceKey: `${base}source.html`,
      htmlKey: `${base}page.html`,
      pngKey: `${base}full.png`,
      fidelity: final.fidelity,
      checks: {
        passed: outcome.passed,
        issues: outcome.issues,
        text: final.text,
        visual,
        rebuilt: toRebuild.map((s) => s.number),
        firstMatch: first.fidelity.overall,
        stillOff: stillOff.map((s) => s.number),
        frameProblems,
        // The style kit it was built with, and its element check (misses by name).
        styleKitId: styled?.id ?? null,
        elements: final.elements,
      },
      notes,
      finishedAt: new Date(),
    })
    .where(eq(designCopy.id, copy.id));

  await recordActivity(db, {
    action: "design.copy_built",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      frame: frame.name,
      match: final.fidelity.overall,
      firstMatch: first.fidelity.overall,
      sections: sections.length,
      rebuilt: toRebuild.map((s) => s.name),
      stillOff: stillOff.map((s) => s.name),
      notes,
    },
    ipAddress: null,
    userAgent: null,
  });
  await postProjectSlack(db, copy.projectId, { kind: "design_copy_ready", match: final.fidelity.overall });

  /* The cheap look: each section of the design next to the copy's, small, in one call. */
  async function lookAtCopy(copyPng: Buffer, bands: { top: number; bottom: number }[]): Promise<VisualCheck | null> {
    const content: Anthropic.ContentBlockParam[] = [];
    const copyHeight = await imageHeight(browser, copyPng);
    for (const section of sections) {
      const band = bands[section.number - 1];
      const [design] = await cropPicture(browser, picture!, { top: section.top, height: section.height, sourceWidth: frame!.width }, 480, 1200);
      const [copied] = band
        ? await cropPicture(
            browser,
            copyPng,
            { top: (band.top / 100) * copyHeight, height: ((band.bottom - band.top) / 100) * copyHeight, sourceWidth: VIEWPORT.width },
            480,
            1200,
          )
        : [];
      content.push({ type: "text", text: `Section ${section.number} "${section.name}": the design.` });
      if (design) content.push(jpeg(design));
      content.push({ type: "text", text: `Section ${section.number}: the copy.` });
      if (copied) content.push(jpeg(copied));
      else content.push({ type: "text", text: "(The copy has no such section.)" });
    }
    content.push({ type: "text", text: buildVisualCheckText(sections) });
    const model = await stepModel(db, "faithful_check");
    const stream = client.messages.stream({
      model,
      max_tokens: 8_000,
      messages: [{ role: "user", content }],
      ...requestSettings(model, { effort: "low", format: { type: "json_schema", schema: VISUAL_CHECK_JSON_SCHEMA } }),
    });
    const response = await stream.finalMessage();
    await recordCall(db, {
      projectId: copy!.projectId,
      runId: copy!.id,
      conceptId: null,
      startedByUserId: copy!.startedByUserId,
      model,
      step: "faithful_check",
      usage: usageOf(response.usage),
      turns: [{ stopReason: response.stop_reason, content: response.content }],
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return readVisualCheck(text, sections.map((s) => s.number));
  }
}

/* A copy that did not finish: the reason, kept and logged. */
export async function markDesignCopyFailed(copyId: string, message: string): Promise<void> {
  const db = getDb();
  const [failed] = await db
    .update(designCopy)
    .set({ status: "failed", failureReason: message, finishedAt: new Date() })
    .where(eq(designCopy.id, copyId))
    .returning({ projectId: designCopy.projectId });
  if (!failed) return;
  await recordActivity(db, {
    action: "design.copy_failed",
    entityType: "project",
    entityId: failed.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { reason: message },
    ipAddress: null,
    userAgent: null,
  });
}
