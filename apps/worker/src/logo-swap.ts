import { desc, eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import { conceptVersion, logoSwap } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { approvedMockupVersion, sourceKeyOf, writeClientDesignDoc } from "@tawd/core/approved";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { LogoSwapJobData } from "@tawd/core/queue";

import type { WorkerConfig } from "./config";
import { loadProjectContext, storeVersion, type CheckResult } from "./pipeline";

/*
  The logo after approval (27 September 2026): the approved concept's own
  page, with the intake's current logo in the logo's place and nothing else
  changed. No AI: the page is re-rendered with the new image and stored as
  a new version, which becomes the approved one. The client DESIGN.md is
  written again from it.
*/
export async function runLogoSwapJob(job: LogoSwapJobData, config: WorkerConfig, browser: Browser): Promise<void> {
  const db = getDb();
  const storage = getStorage();
  const [swap] = await db.select().from(logoSwap).where(eq(logoSwap.id, job.swapId)).limit(1);
  if (!swap || swap.status !== "queued") return;
  await db.update(logoSwap).set({ status: "working" }).where(eq(logoSwap.id, swap.id));

  const approved = await approvedMockupVersion(db, swap.projectId);
  if (!approved?.version.htmlKey) throw new Error("The approved concept's page is missing.");
  const source = (await storage.get(sourceKeyOf(approved.version.htmlKey)))?.toString("utf8");
  if (!source) throw new Error("The approved concept's page is missing from storage.");
  if (!source.includes("tawd-asset:logo")) throw new Error("The approved concept has no logo spot to put the new logo in.");

  const context = await loadProjectContext(db, storage, browser, config, { projectId: swap.projectId, runId: swap.id });
  if (!context.assets.some((a) => a.token === "tawd-asset:logo")) throw new Error("The intake has no logo to put in.");

  const [latest] = await db.select({ version: conceptVersion.version }).from(conceptVersion).where(eq(conceptVersion.conceptId, approved.concept.id)).orderBy(desc(conceptVersion.version)).limit(1);
  const next = (latest?.version ?? approved.version.version) + 1;
  const previous = (approved.version.checks ?? {}) as { passed?: boolean; issues?: unknown[]; needsIntake?: unknown[] };
  await storeVersion(db, storage, {
    conceptId: approved.concept.id,
    projectId: swap.projectId,
    version: next,
    html: source,
    assets: context.assets,
    browser,
    // Only the logo changed: the checks stand as they were.
    outcome: { passed: previous.passed ?? true, issues: previous.issues ?? [], needsIntake: previous.needsIntake ?? [], placeholderCount: approved.version.placeholderCount ?? 0 } as unknown as CheckResult,
    stage: "logo_swap",
  });
  await db.update(logoSwap).set({ status: "done", toVersion: next, finishedAt: new Date() }).where(eq(logoSwap.id, swap.id));
  await recordActivity(db, {
    action: "mockups.logo_swapped",
    entityType: "project",
    entityId: swap.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { concept: approved.concept.label, from: approved.version.version, to: next },
    ipAddress: null,
    userAgent: null,
  });

  // The client DESIGN.md, from the version with the new logo.
  try {
    const written = await writeClientDesignDoc(db, storage, swap.projectId, swap.requestedByUserId);
    await recordActivity(db, { action: "design_md.created", entityType: "project", entityId: swap.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: written, ipAddress: null, userAgent: null });
  } catch (error) {
    await recordActivity(db, {
      action: "design_md.failed",
      entityType: "project",
      entityId: swap.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { reason: error instanceof Error ? error.message : "unknown" },
      ipAddress: null,
      userAgent: null,
    });
  }
}

export async function markLogoSwapFailed(swapId: string, reason: string): Promise<void> {
  await getDb().update(logoSwap).set({ status: "failed", failureReason: reason.slice(0, 1000), finishedAt: new Date() }).where(eq(logoSwap.id, swapId));
}
