import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { compareCopyText, designTextsBySection, frameSections, type FrameSection } from "@tawd/core/figma";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { CopyRepairJobData } from "@tawd/core/queue";
import { designCopy } from "@tawd/core/schema";
import { replaceAssetTokens } from "@tawd/core/site";
import { describeMisses, planSection, type CheckResult, type SectionPlan } from "@tawd/core/style-kit/element-check";
import { applyKit } from "@tawd/core/style-kit/kit";

import { REPAIR_ASSET_HOST, keepSectionsFrom, repairInBrowser, repairPlan, type RepairReport } from "./copy-repair";
import { loadDesignSource } from "./design-source";
import { runElementCheck } from "./element-check";
import { compareWithDesign, type FidelityResult } from "./fidelity";
import { withImages } from "./pipeline";
import { measureBands, pageTextsBySection, renderConcept } from "./render";
import { loadKitForCopy, matchKitSections } from "./style-kit-job";

/*
  The kit repair job (Jason, 29 September 2026): a finished copy made right
  with the style kit by code, $0. The copy is drawn and measured as it is,
  repaired, drawn and measured again; a section that came out worse is put
  back as it was. What the element check still finds in a section (an item
  that couldn't be placed, text lying over other text) is listed for a paid
  rebuild of that section only, by name. The repair is a new copy of the
  page (repair_of names the one repaired), which stays in the history.
*/

export interface PaidSection {
  number: number;
  name: string;
  /** What is still wrong, in plain words. */
  reasons: string[];
}

export interface RepairOutcome {
  report: RepairReport;
  /** Sections put back as they were because the repair made them worse. */
  keptAsBefore: string[];
  before: number;
  after: number;
  paid: PaidSection[];
}

/* Dividers are left out of the repair and of what counts against a section. */
function withoutDividers(plans: SectionPlan[]): SectionPlan[] {
  return plans.map((p) => ({ ...p, items: p.items.filter((i) => !i.selector.startsWith(".kit-divider")) }));
}

export async function runCopyRepairJob(db: Database, browser: Browser, job: CopyRepairJobData): Promise<void> {
  const storage = getStorage();
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, job.copyId)).limit(1);
  if (!copy || copy.status !== "queued" || !copy.repairOf) return;
  await db.update(designCopy).set({ status: "working", startedAt: new Date() }).where(eq(designCopy.id, copy.id));
  const [original] = await db.select().from(designCopy).where(eq(designCopy.id, copy.repairOf)).limit(1);
  if (!original?.sourceKey) throw new Error("The copy to repair has no saved page. Build it again first.");
  const saved = await storage.get(original.sourceKey);
  if (!saved) throw new Error("The copy to repair is missing from storage. Build it again first.");
  const styled = await loadKitForCopy(db, { projectId: copy.projectId, designVersion: original.figmaVersion, frameId: original.frameId });
  if (!styled) throw new Error("There is no style kit for this design yet. Build the style kit first (Mockups, $0).");

  const { frame, picture, home, assets } = await loadDesignSource(db, storage, browser, { projectId: copy.projectId, frameId: original.frameId, frameName: original.frameName, purpose: "repair the copy" });
  const sections: FrameSection[] = frameSections(home).map((s) => ({ number: s.index + 1, name: s.name, top: s.top, height: s.height }));
  const kitSections = matchKitSections(sections, styled.inventory);
  const plans = withoutDividers([...kitSections.entries()].map(([number, inv]) => ({ ...planSection(styled.kit, inv), number, name: sections[number - 1]!.name })));
  const plan = repairPlan(styled.kit, [...kitSections.entries()].map(([number, inventory]) => ({ number, name: sections[number - 1]!.name, inventory })), frame.width);
  const designTexts = designTextsBySection(home);

  const source = saved.toString("utf8");
  const render = (src: string) => applyKit(withImages(src, assets), styled.kit, styled.css).html;
  const measure = async (src: string) => {
    const page = render(src);
    const shot = await renderConcept(browser, page);
    const fidelity: FidelityResult = await compareWithDesign(browser, {
      design: picture,
      copy: shot.fullPage,
      frameWidth: frame.width,
      sections: sections.map((s) => ({ name: s.name, top: s.top, height: s.height })),
      copyBands: await measureBands(browser, page),
    });
    const elements: CheckResult = await runElementCheck(browser, page, plans);
    const text = compareCopyText(designTexts, await pageTextsBySection(browser, page));
    return { page, shot, fidelity, elements, text };
  };
  const before = await measure(source);

  // Repaired on the page as drawn (the kit's fonts loaded; pictures served by address), then turned back into the source.
  const files = new Map<string, { body: Buffer; contentType: string }>();
  let addressed = source;
  assets.forEach((asset, i) => {
    const url = `${REPAIR_ASSET_HOST}${i}`;
    const [, type, data] = /^data:([^;]+);base64,([\s\S]*)$/.exec(asset.dataUri) ?? [];
    if (!type || !data) return;
    files.set(url, { body: Buffer.from(data, "base64"), contentType: type });
    addressed = replaceAssetTokens(addressed, new Map([[asset.token, url]]));
  });
  const repaired = await repairInBrowser(browser, applyKit(addressed, styled.kit, styled.css).html, plan, files);
  let repairedSource = repaired.html;
  assets.forEach((asset, i) => {
    repairedSource = repairedSource.split(`${REPAIR_ASSET_HOST}${i}`).join(asset.token);
  });
  let after = await measure(repairedSource);

  /*
    A section the repair made worse goes back as it was: one that measures
    more than 8 points lower and whose kit misses didn't go down. (Rows that
    shift a little when ribbons and icons go in cost a few points of the
    colour-block score while the section looks far closer to the design.)
  */
  const score = (f: FidelityResult, n: number) => (f.method === "sections" ? (f.sections[n - 1]?.score ?? 100) : f.overall);
  const missCount = (c: CheckResult, n: number) => c.sections.find((x) => x.number === n)?.misses.length ?? 0;
  const worse = sections.filter((s) => score(after.fidelity, s.number) < score(before.fidelity, s.number) - 8 && missCount(after.elements, s.number) >= missCount(before.elements, s.number));
  if (worse.length) {
    repairedSource = await keepSectionsFrom(browser, repairedSource, source, worse.map((s) => s.number));
    after = await measure(repairedSource);
  }

  // What is still wrong: kit items, text cut off or overlapping, words missing. Each such section needs a paid rebuild.
  const paid: PaidSection[] = [];
  for (const s of sections) {
    const check = after.elements.sections.find((x) => x.number === s.number);
    const reasons = check ? describeMisses({ sections: [check], passed: check.passed }).map((m) => m.replace(/^[^:]*: /, "")) : [];
    const t = after.text.find((x) => x.number === s.number);
    for (const m of t?.missing ?? []) reasons.push(`The text "${m}" is missing.`);
    if (!after.elements.sections.some((x) => x.number === s.number) && score(after.fidelity, s.number) < 75) reasons.push(`It matches the design only ${score(after.fidelity, s.number)}%.`);
    if (reasons.length) paid.push({ number: s.number, name: s.name, reasons });
  }

  const base = `${projectStoragePrefix(copy.projectId)}figma/copies/${copy.id}/`;
  await storage.put(`${base}source.html`, Buffer.from(repairedSource, "utf8"), "text/html");
  await storage.put(`${base}page.html`, Buffer.from(after.page, "utf8"), "text/html");
  await storage.put(`${base}full.png`, after.shot.fullPage, "image/png");
  const outcome: RepairOutcome = { report: repaired.report, keptAsBefore: worse.map((s) => s.name), before: before.fidelity.overall, after: after.fidelity.overall, paid };
  const oldChecks = (original.checks as Record<string, unknown> | null) ?? {};
  await db
    .update(designCopy)
    .set({
      status: paid.length ? "needs_cleanup" : "done",
      failureReason: paid.length ? `Needs a paid rebuild of ${paid.length === 1 ? "one section" : `${paid.length} sections`}: ${paid.map((p) => `"${p.name}"`).join(", ")}.` : null,
      sourceKey: `${base}source.html`,
      htmlKey: `${base}page.html`,
      pngKey: `${base}full.png`,
      fidelity: after.fidelity,
      checks: { ...oldChecks, text: after.text, elements: after.elements, styleKitId: styled.id, repair: outcome, stillOff: paid.map((p) => p.number) },
      notes: original.notes,
      finishedAt: new Date(),
    })
    .where(eq(designCopy.id, copy.id));
  await recordActivity(db, {
    action: "design.copy_repaired",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: copy.frameName, from: original.id, match: `${before.fidelity.overall}% to ${after.fidelity.overall}%`, placed: repaired.report.placed.length, notPlaced: repaired.report.notPlaced.length, keptAsBefore: outcome.keptAsBefore, paidSections: paid.map((p) => p.name) },
    ipAddress: null,
    userAgent: null,
  });
}

export async function markCopyRepairFailed(db: Database, copyId: string, message: string): Promise<void> {
  await db.update(designCopy).set({ status: "failed", failureReason: message.slice(0, 1000), finishedAt: new Date() }).where(eq(designCopy.id, copyId));
}
