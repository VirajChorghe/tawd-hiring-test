import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { NetlifyError, deleteNetlifySite } from "@/lib/netlify";
import { wpPreviewStillOnHost } from "@/lib/wp-preview";

import {
  aiCall,
  seoDataCall,
  siteReadCall,
  aiUsageArchive,
  concept,
  conceptChangeRequest,
  conceptVersion,
  currentSiteRead,
  designCopy,
  designImprovement,
  designReview,
  figmaDesign,
  homeWords,
  likedSiteShot,
  logoDesign,
  logoSwap,
  pageDraft,
  pageFix,
  photoTextCheck,
  polishPass,
  seoAudit,
  seoGoLiveCheck,
  siteBuild,
  siteImport,
  speedCheck,
  styleKit,
  deletedProject,
  intakeFile,
  mockupRun,
  project,
} from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { conceptSpend } from "@tawd/core/mockups";
import { isRunActive } from "@tawd/core/queue";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { ServiceContext } from "@/lib/users";

/*
  Deleting a project, for good.

  Admins only, never a live project, and only after the admin has typed the
  project's name exactly and given a reason. There is no archive: the
  project, its intake, its concepts and every file in R2 go.

  What stays, on purpose:
  - The activity log. It is append-only, and the database refuses to
    change it. Its entries keep pointing at the old project id, and the
    deleted_project row lets them name it: "(deleted project) Pat Rivera".
  - The AI spend. Token counts are copied to ai_usage_archive first, one row
    per concept, so the cost of the work stays on the books.

  The order matters. Files go first and are checked gone before a single
  database row is touched: if R2 fails half-way, the project is still there
  to retry from, rather than rows gone and files orphaned with nothing left
  that knows where they are.
*/

export const MIN_DELETE_REASON_LENGTH = 10;

export class ProjectDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDeleteError";
  }
}

export interface DeleteProjectInput {
  /** What the admin typed. Must match the project name exactly. */
  confirmName: string;
  reason: string;
}

export interface DeleteProjectResult {
  clientName: string;
  filesRemoved: number;
  conceptsArchived: number;
}

/** Why this project cannot be deleted right now, or null if it can. */
export function deleteBlocker(status: string, liveAt: Date | null): string | null {
  if (status === "live") {
    return "Live projects cannot be deleted. The site is running for a paying client.";
  }
  // Jason, 13 October 2026 (the whole-code review): once a project has gone
  // live it is never deleted, paused or not, since deleting would take the
  // client's site down and its billing record with it.
  if (liveAt) {
    return "This project has gone live, so it cannot be deleted. Its site and billing record are kept.";
  }
  return null;
}

/*
  The worker's jobs that can still be running for a project (13 October
  2026, the whole-code review). A row counts only while it is younger than
  RUNNING_WORK_HOURS: a job left "working" by a worker that died never
  blocks deletion for good.
*/
export const RUNNING_WORK_HOURS = 3;

const IN_PROGRESS = ["queued", "working", "crawling", "fixing", "building"];

export async function runningWork(db: ServiceContext["db"], projectId: string): Promise<string[]> {
  const since = new Date(Date.now() - RUNNING_WORK_HOURS * 3_600_000);
  const checks: [string, PgTable, PgColumn, PgColumn, PgColumn][] = [
    ["a change request", conceptChangeRequest, conceptChangeRequest.status, conceptChangeRequest.projectId, conceptChangeRequest.createdAt],
    ["a design import", figmaDesign, figmaDesign.importStatus, figmaDesign.projectId, figmaDesign.importQueuedAt],
    ["a design review", designReview, designReview.status, designReview.projectId, designReview.createdAt],
    ["a design copy", designCopy, designCopy.status, designCopy.projectId, designCopy.createdAt],
    ["a phone version", designCopy, designCopy.mobileStatus, designCopy.projectId, designCopy.createdAt],
    ["a style kit", styleKit, styleKit.status, styleKit.projectId, styleKit.createdAt],
    ["a design improvement", designImprovement, designImprovement.status, designImprovement.projectId, designImprovement.createdAt],
    ["a read of the current site", currentSiteRead, currentSiteRead.status, currentSiteRead.projectId, currentSiteRead.createdAt],
    ["a site import", siteImport, siteImport.status, siteImport.projectId, siteImport.createdAt],
    ["the home page words", homeWords, homeWords.writeStatus, homeWords.projectId, homeWords.updatedAt],
    ["a liked site", likedSiteShot, likedSiteShot.status, likedSiteShot.projectId, likedSiteShot.createdAt],
    ["a liked site's brief", likedSiteShot, likedSiteShot.briefStatus, likedSiteShot.projectId, likedSiteShot.createdAt],
    ["a page draft", pageDraft, pageDraft.status, pageDraft.projectId, pageDraft.createdAt],
    ["a site build", siteBuild, siteBuild.status, siteBuild.projectId, siteBuild.createdAt],
    ["a logo", logoDesign, logoDesign.status, logoDesign.projectId, logoDesign.createdAt],
    ["a logo swap", logoSwap, logoSwap.status, logoSwap.projectId, logoSwap.createdAt],
    ["an SEO audit", seoAudit, seoAudit.status, seoAudit.projectId, seoAudit.createdAt],
    ["the SEO check", seoGoLiveCheck, seoGoLiveCheck.status, seoGoLiveCheck.projectId, seoGoLiveCheck.createdAt],
    ["a photo text check", photoTextCheck, photoTextCheck.status, photoTextCheck.projectId, photoTextCheck.createdAt],
    ["a polish pass", polishPass, polishPass.status, polishPass.projectId, polishPass.createdAt],
    ["a page fix", pageFix, pageFix.status, pageFix.projectId, pageFix.createdAt],
    ["a Speed check", speedCheck, speedCheck.status, speedCheck.projectId, speedCheck.createdAt],
  ];
  const busy: string[] = [];
  for (const [label, table, status, owner, at] of checks) {
    const [hit] = await db
      .select({ one: sql<number>`1` })
      .from(table)
      .where(and(eq(owner, projectId), inArray(status, IN_PROGRESS), gte(at, since)))
      .limit(1);
    if (hit && !busy.includes(label)) busy.push(label);
  }
  return busy;
}

export async function deleteProject(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: DeleteProjectInput,
): Promise<DeleteProjectResult> {
  assertCan(actor, "project.delete");

  const db = ctx.db;
  const storage = getStorage();

  /*
    The whole deletion runs in one transaction that first locks the
    project's row (13 October 2026, CodeRabbit on the review's fourth batch).
    A new job row points at the project, and Postgres makes its insert wait
    for that lock: a job started during the deletion either finished
    inserting before the lock (and the running-work check below sees it) or
    waits and then fails because the project is gone, before anything is
    queued.
  */
  const { row, reason, present, archive, netlifyUrl } = await db.transaction(async (outer) => {
    const locked = outer as unknown as typeof db;
    const [row] = await locked
      .select()
      .from(project)
      .where(eq(project.id, projectId))
      .limit(1)
      .for("update");
    if (!row) throw new ProjectDeleteError("That project no longer exists.");

    const blocker = deleteBlocker(row.status, row.liveAt);
    if (blocker) throw new ProjectDeleteError(blocker);

    if (input.confirmName.trim() !== row.clientName) {
      throw new ProjectDeleteError(
        `The name you typed does not match. Type "${row.clientName}" exactly to confirm.`,
      );
    }

    const reason = input.reason.trim();
    if (reason.length < MIN_DELETE_REASON_LENGTH) {
      throw new ProjectDeleteError(
        `Give a reason of at least ${MIN_DELETE_REASON_LENGTH} characters. It is recorded in the activity log.`,
      );
    }

    const runs = await locked
      .select()
      .from(mockupRun)
      .where(eq(mockupRun.projectId, projectId));

    // A worker mid-build would write to rows that no longer exist.
    if (runs.some((run) => isRunActive(run.status))) {
      throw new ProjectDeleteError(
        "Concepts are still generating for this project. Stop the run on the Design screen, then delete.",
      );
    }

    // Other work still running would keep paying for AI and write files after they are removed.
    const busy = await runningWork(locked, projectId);
    if (busy.length > 0) {
      throw new ProjectDeleteError(
        `Work is still running for this project (${busy.join(", ")}). Wait for it to finish, then delete.`,
      );
    }

    // A WordPress site has its own 20i package: it is removed there first (Build page), by the worker, which holds 20i's key.
    if (await wpPreviewStillOnHost(locked, projectId)) {
      throw new ProjectDeleteError("This project has a WordPress site at 20i. Remove it first (Build page, Hosting: Remove the preview), then delete.");
    }

    // The client's Netlify site goes first: if Netlify can't delete it, nothing is deleted here either.
    let netlifyUrl: string | null;
    try {
      netlifyUrl = await deleteNetlifySite(locked, projectId);
    } catch (error) {
      if (error instanceof NetlifyError) throw new ProjectDeleteError(error.message);
      throw error;
    }

    const concepts = await locked
      .select()
      .from(concept)
      .where(eq(concept.projectId, projectId));

    const versions =
      concepts.length === 0
        ? []
        : await locked
            .select()
            .from(conceptVersion)
            .where(
              inArray(
                conceptVersion.conceptId,
                concepts.map((c) => c.id),
              ),
            );

    const files = await locked
      .select({ storageKey: intakeFile.storageKey })
      .from(intakeFile)
      .where(eq(intakeFile.projectId, projectId));

    /* ---------- 1. files, and proof they are gone ---------- */

    const prefix = projectStoragePrefix(projectId);

    // Everything under the project's prefix, plus every key a row names, in
    // case one was ever written somewhere else.
    const keys = new Set<string>(await storage.list(prefix));
    for (const file of files) keys.add(file.storageKey);
    for (const version of versions) {
      for (const key of [version.htmlKey, version.pngKey, version.foldPngKey]) {
        if (key) keys.add(key);
      }
    }

    const present: string[] = [];
    for (const key of keys) {
      // A row can name a file whose upload never finished.
      if (key.startsWith(prefix) || (await storage.head(key))) present.push(key);
    }

    for (const key of present) {
      await storage.remove(key);
    }

    const leftUnderPrefix = await storage.list(prefix);
    const leftByName: string[] = [];
    for (const key of keys) {
      if (await storage.head(key)) leftByName.push(key);
    }
    const left = [...new Set([...leftUnderPrefix, ...leftByName])];
    if (left.length > 0) {
      throw new ProjectDeleteError(
        `${left.length} file${left.length === 1 ? " is" : "s are"} still in storage after deleting, so the project has been kept. Try again; if it keeps happening, check R2.`,
      );
    }

    /* ---------- 2. keep the AI spend, then remove the rows ---------- */

    const runById = new Map(runs.map((run) => [run.id, run]));
    const archive = concepts
      .map((c) => {
        const mine = versions.filter((v) => v.conceptId === c.id);
        if (mine.length === 0) return null;
        const spend = conceptSpend(mine);
        return {
          projectId,
          clientName: row.clientName,
          runId: c.runId,
          conceptId: c.id,
          conceptLabel: c.label,
          direction: c.direction,
          skillId: c.skillId,
          model: runById.get(c.runId)?.model ?? "unknown",
          versions: mine.length,
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          cacheReadTokens: spend.cacheReadTokens,
          cacheWriteTokens: spend.cacheWriteTokens,
          builtAt: mine.reduce(
            (latest, v) => (v.createdAt > latest ? v.createdAt : latest),
            mine[0]!.createdAt,
          ),
        };
      })
      .filter((entry) => entry !== null);

    await locked.transaction(async (tx) => {
      if (archive.length > 0) {
        await tx.insert(aiUsageArchive).values(archive);
      }

      await tx.insert(deletedProject).values({
        id: projectId,
        clientName: row.clientName,
        trade: row.trade,
        statusAtDeletion: row.status,
        reason,
        filesRemoved: present.length,
        deletedByUserId: actorFields(actor).actorUserId,
        deletedByEmail: actor.email,
      });

      // The spend rows stay; the saved answers they pointed to were removed
      // with the project's files.
      await tx.update(aiCall).set({ responseKey: null }).where(eq(aiCall.projectId, projectId));
      await tx.update(seoDataCall).set({ responseKey: null }).where(eq(seoDataCall.projectId, projectId));
      // A blocked site's paid reads stay counted; the client's addresses go.
      await tx.update(siteReadCall).set({ url: "" }).where(eq(siteReadCall.projectId, projectId));

      // Intake, files, members, runs, concepts, versions, steps and design-log
      // entries all cascade from the project row.
      await tx.delete(project).where(eq(project.id, projectId));
    });

    return { row, reason, present, archive, netlifyUrl };
  });

  await recordActivity(db, {
    action: "project.deleted",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: {
      clientName: row.clientName,
      trade: row.trade,
      status: row.status,
    },
    valueAfter: {
      reason,
      filesRemoved: present.length,
      conceptsArchived: archive.length,
      ...(netlifyUrl ? { netlifySiteDeleted: netlifyUrl } : {}),
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return {
    clientName: row.clientName,
    filesRemoved: present.length,
    conceptsArchived: archive.length,
  };
}

/** The AI spend kept from deleted projects, newest first. */
export async function listArchivedAiUsage(
  ctx: Pick<ServiceContext, "db">,
  actor: Viewer,
  projectId?: string,
) {
  assertCan(actor, "activity.view_all");
  const query = ctx.db.select().from(aiUsageArchive);
  const rows = projectId
    ? await query.where(eq(aiUsageArchive.projectId, projectId))
    : await query;
  return rows.sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());
}
