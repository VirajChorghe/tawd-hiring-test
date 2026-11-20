import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { compareCopyText, designTextsBySection, frameSections, type FrameSection } from "@tawd/core/figma";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { TemplateFillJobData } from "@tawd/core/queue";
import { designCopy } from "@tawd/core/schema";
import { describeMisses, planSection, type CheckResult } from "@tawd/core/style-kit/element-check";
import { applyKit } from "@tawd/core/style-kit/kit";

import type { PaidSection } from "./copy-repair-job";
import { loadDesignSource } from "./design-source";
import { runElementCheck } from "./element-check";
import { compareWithDesign } from "./fidelity";
import { withImages } from "./pipeline";
import { measureBands, pageTextsBySection, renderConcept } from "./render";
import { loadKitForCopy, matchKitSections } from "./style-kit-job";
import { fillInBrowser, planFill } from "./template-fill";

/*
  The template fill job (Jason, 29 September 2026): a page that shares its
  layout with another is made from that page's copy by code, $0. It is kept
  only if it matches its own design at least as well as the page's current
  copy (within 2 points); otherwise the current copy stays and the fill is
  dropped (logged). What it can't fill is listed for a paid rebuild of that
  section only.
*/
export async function runTemplateFillJob(db: Database, browser: Browser, job: TemplateFillJobData): Promise<void> {
  const storage = getStorage();
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, job.copyId)).limit(1);
  if (!copy || copy.status !== "queued" || !copy.filledFrom) return;
  await db.update(designCopy).set({ status: "working", startedAt: new Date() }).where(eq(designCopy.id, copy.id));
  const [template] = await db.select().from(designCopy).where(eq(designCopy.id, copy.filledFrom)).limit(1);
  const saved = template?.sourceKey ? await storage.get(template.sourceKey) : null;
  if (!template || !saved) throw new Error("The template page's copy is missing. Copy or repair that page first.");

  const from = await loadDesignSource(db, storage, browser, { projectId: copy.projectId, frameId: template.frameId, frameName: template.frameName, purpose: "fill the page" });
  const to = await loadDesignSource(db, storage, browser, { projectId: copy.projectId, frameId: copy.frameId, frameName: copy.frameName, purpose: "fill the page" });
  const plan = planFill({ frame: from.home, byImageRef: from.byImageRef }, { frame: to.home, byImageRef: to.byImageRef });
  const filled = await fillInBrowser(browser, saved.toString("utf8"), plan);

  const sections: FrameSection[] = frameSections(to.home).map((s) => ({ number: s.index + 1, name: s.name, top: s.top, height: s.height }));
  const styled = await loadKitForCopy(db, { projectId: copy.projectId, designVersion: copy.figmaVersion, frameId: copy.frameId });
  const plans = styled
    ? [...matchKitSections(sections, styled.inventory).entries()]
        .map(([number, inv]) => ({ ...planSection(styled.kit, inv), number, name: sections[number - 1]!.name }))
        .map((p) => ({ ...p, items: p.items.filter((i) => !i.selector.startsWith(".kit-divider")) }))
    : [];
  // Its own pictures: the template's tokens were swapped for this page's.
  const page = styled ? applyKit(withImages(filled.html, to.assets), styled.kit, styled.css).html : withImages(filled.html, to.assets);
  const shot = await renderConcept(browser, page);
  const fidelity = await compareWithDesign(browser, {
    design: to.picture,
    copy: shot.fullPage,
    frameWidth: to.frame.width,
    sections: sections.map((s) => ({ name: s.name, top: s.top, height: s.height })),
    copyBands: await measureBands(browser, page),
  });
  const elements: CheckResult | null = plans.length ? await runElementCheck(browser, page, plans) : null;
  const text = compareCopyText(designTextsBySection(to.home), await pageTextsBySection(browser, page));

  // Kept only if it is at least about as good as the page's current copy.
  const [current] = await db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.projectId, copy.projectId), eq(designCopy.frameId, copy.frameId), ne(designCopy.id, copy.id), inArray(designCopy.status, ["done", "needs_cleanup"])))
    .orderBy(desc(designCopy.createdAt))
    .limit(1);
  const currentMatch = (current?.fidelity as { overall?: number } | null)?.overall ?? null;
  if (currentMatch !== null && fidelity.overall < currentMatch - 2) {
    await db.delete(designCopy).where(eq(designCopy.id, copy.id));
    await recordActivity(db, {
      action: "design.copy_fill_dropped",
      entityType: "project",
      entityId: copy.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { page: copy.frameName, template: template.frameName, filledMatch: fidelity.overall, currentMatch },
      ipAddress: null,
      userAgent: null,
    });
    return;
  }

  const paid: PaidSection[] = [];
  for (const s of sections) {
    const check = elements?.sections.find((x) => x.number === s.number);
    const reasons = check ? describeMisses({ sections: [check], passed: check.passed }).map((m) => m.replace(/^[^:]*: /, "")) : [];
    for (const m of text.find((x) => x.number === s.number)?.missing ?? []) reasons.push(`The text "${m}" is missing.`);
    if (reasons.length) paid.push({ number: s.number, name: s.name, reasons });
  }
  const base = `${projectStoragePrefix(copy.projectId)}figma/copies/${copy.id}/`;
  await storage.put(`${base}source.html`, Buffer.from(filled.html, "utf8"), "text/html");
  await storage.put(`${base}page.html`, Buffer.from(page, "utf8"), "text/html");
  await storage.put(`${base}full.png`, shot.fullPage, "image/png");
  await db
    .update(designCopy)
    .set({
      status: paid.length ? "needs_cleanup" : "done",
      failureReason: paid.length ? `Needs a paid rebuild of ${paid.length === 1 ? "one section" : `${paid.length} sections`}: ${paid.map((p) => `"${p.name}"`).join(", ")}.` : null,
      sourceKey: `${base}source.html`,
      htmlKey: `${base}page.html`,
      pngKey: `${base}full.png`,
      fidelity,
      checks: {
        text,
        elements,
        styleKitId: styled?.id ?? null,
        fill: { template: template.frameName, replaced: filled.replaced, notFound: filled.notFound, unmatched: plan.unmatched, photos: plan.photos.length, currentMatch, after: fidelity.overall, paid },
        stillOff: paid.map((p) => p.number),
      },
      notes: template.notes,
      finishedAt: new Date(),
    })
    .where(eq(designCopy.id, copy.id));
  await recordActivity(db, {
    action: "design.copy_filled",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: copy.frameName, template: template.frameName, words: filled.replaced, photos: plan.photos.length, match: fidelity.overall, currentMatch, paidSections: paid.map((p) => p.name) },
    ipAddress: null,
    userAgent: null,
  });
}

/* A fill that didn't finish is dropped (the page keeps its current copy) and the reason logged. */
export async function markTemplateFillFailed(db: Database, copyId: string, message: string): Promise<void> {
  const [copy] = await db.select().from(designCopy).where(eq(designCopy.id, copyId)).limit(1);
  if (!copy) return;
  await db.delete(designCopy).where(eq(designCopy.id, copyId));
  await recordActivity(db, {
    action: "design.copy_fill_dropped",
    entityType: "project",
    entityId: copy.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { page: copy.frameName, reason: message.slice(0, 500) },
    ipAddress: null,
    userAgent: null,
  });
}
