import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Browser } from "playwright-core";

import type { Database } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { embedAssets } from "@tawd/core/mockups";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { SiteTidyJobData } from "@tawd/core/queue";
import { designCopy, designPage, figmaDesign } from "@tawd/core/schema";
import { COOKIE_POLICY_PATH, PRIVACY_POLICY_PATH } from "@tawd/core/site";
import { applyKit } from "@tawd/core/style-kit/kit";

import { loadDesignSource } from "./design-source";
import { tidyPage } from "./site-tidy";
import { loadKitForCopy } from "./style-kit-job";

/*
  The words and links tidy (Jason, 29 September 2026), $0: every page's
  newest copy, its source changed in place (garbled button names, the
  footer's legal links, Contact out, links pointed at their pages, the
  team's choices for the rest), its page drawn again. What changed and the
  links still unplaced are kept on the copy.
*/
export async function runSiteTidyJob(db: Database, browser: Browser, job: SiteTidyJobData): Promise<void> {
  const storage = getStorage();
  const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, job.projectId)).limit(1);
  if (!figma?.importedVersion) return;
  const pages = await db
    .select()
    .from(designPage)
    .where(and(eq(designPage.projectId, job.projectId), eq(designPage.figmaVersion, figma.importedVersion)))
    .orderBy(asc(designPage.position));
  const copies = await db
    .select()
    .from(designCopy)
    .where(and(eq(designCopy.projectId, job.projectId), inArray(designCopy.status, ["done", "needs_cleanup"])))
    .orderBy(desc(designCopy.createdAt));
  const rules = Object.entries((figma.linkRules as Record<string, string> | null) ?? {}).map(([match, path]) => ({ match, path }));
  const sitePages = pages.map((p) => ({ name: p.name, path: p.isHome ? "/" : `/${p.slug}/` }));
  const summary: { page: string; changes: number; unresolved: number }[] = [];
  for (const page of pages) {
    const copy = copies.find((c) => c.frameId === page.frameId);
    const saved = copy?.sourceKey ? (await storage.get(copy.sourceKey))?.toString("utf8") : null;
    if (!copy || !saved) continue;
    const { html, report } = await tidyPage(browser, saved, { pages: sitePages, names: [], privacyPath: PRIVACY_POLICY_PATH, cookiePath: COOKIE_POLICY_PATH, extraLinks: rules });
    await storage.put(copy.sourceKey!, Buffer.from(html, "utf8"), "text/html; charset=utf-8");
    if (copy.htmlKey) {
      const design = await loadDesignSource(db, storage, browser, { projectId: job.projectId, frameId: copy.frameId, frameName: copy.frameName, purpose: "tidy the words and links" });
      const styled = await loadKitForCopy(db, { projectId: job.projectId, designVersion: copy.figmaVersion, frameId: copy.frameId });
      const embedded = embedAssets(html, Object.fromEntries(design.assets.map((a) => [a.token, a.dataUri])));
      await storage.put(copy.htmlKey, Buffer.from(styled ? applyKit(embedded, styled.kit, styled.css).html : embedded, "utf8"), "text/html; charset=utf-8");
    }
    // What changed adds up over runs; the links left are this run's.
    const before = (copy.tidy as { changes?: string[] } | null)?.changes ?? [];
    await db
      .update(designCopy)
      .set({ tidy: { changes: [...before, ...report.changes], unresolved: report.unresolved, at: new Date().toISOString() } })
      .where(eq(designCopy.id, copy.id));
    summary.push({ page: page.name, changes: report.changes.length, unresolved: report.unresolved.length });
  }
  await recordActivity(db, {
    action: "design.site_tidied",
    entityType: "project",
    entityId: job.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { pages: summary },
    ipAddress: null,
    userAgent: null,
  });
}
