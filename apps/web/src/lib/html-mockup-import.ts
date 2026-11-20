import { and, desc, eq, gte } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { approvedMockupVersion } from "@tawd/core/approved";
import { HTML_HOMEPAGE_CONCEPT } from "@tawd/core/mockups";
import { intakeFile, concept, conceptVersion, jobFailure, pagePlanPage } from "@tawd/core/schema";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { HTML_MOCKUP_IMPORT_JOB, htmlMockupImportJobId } from "@tawd/core/queue";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  A homepage supplied as one finished HTML file (16 November 2026): this is
  the web app's side. The reading starts BY ITSELF when the upload is
  confirmed (confirmUploadAction): it is free (no AI, no network), so there
  is nothing to decide and nothing to press. The worker
  (apps/worker/src/html-mockup-import.ts) stores the page as a concept.
  Nothing here records the client's approval; the team does that on the
  concept board, exactly as for a generated concept.

  What the screen shows is worked out from what is stored, never from a
  second copy of the state: the file, the version the worker wrote for it
  (its checks name the file), the queue, and the failure log the worker
  writes when a job fails. So it can't drift from what happened.
*/

type Db = Database;

export class HtmlMockupImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlMockupImportError";
  }
}

export interface HomepageReadView {
  /** The file as saved (the only one: a second can't be uploaded until it is removed). Null when none. */
  file: { id: string; fileName: string } | null;
  /** none: no file. not_read: saved but nothing started. reading. done. failed. */
  state: "none" | "not_read" | "reading" | "done" | "failed";
  failure: string | null;
  done: {
    conceptId: string;
    version: number;
    /** What the cleaning took out, one sentence each, in full. */
    removed: string[];
    /** Pictures and fonts left out and the like, in full. */
    warnings: string[];
    /** The client approved an earlier version of this page: Build A still builds that one. */
    approvedOlder: { approved: number; latest: number } | null;
    /** The page plan has pages but none is a Home page, so the supplied page would be used nowhere. */
    planHasNoHome: boolean;
  } | null;
}

/*
  The rail badge for the intake's "Homepage file" item (Lane 1). It reads the
  same stored view the section shows, so the two cannot disagree: nothing
  uploaded is "Optional" (the file is never required), and the rest names
  exactly the state the section is in.
*/
export function homepageBadge(read: HomepageReadView): { text: string; kind: "done" | "missing" | "warning" | "info" } {
  switch (read.state) {
    case "none":
      return { text: "Optional", kind: "info" };
    case "reading":
      return { text: "Reading", kind: "info" };
    case "not_read":
      return { text: "Not read yet", kind: "warning" };
    case "failed":
      return { text: "Can't read", kind: "missing" };
    case "done":
      return { text: "On the board", kind: "done" };
  }
}

const IN_FLIGHT = ["waiting", "active", "delayed", "prioritized", "waiting-children"];

/* Is a read of this project's homepage on the queue or running? The queue not answering counts as no (the screen must load without Redis). */
async function isReading(projectId: string, fileId: string): Promise<boolean> {
  try {
    const queue = getQueue();
    for (const id of [htmlMockupImportJobId(projectId, fileId), htmlMockupImportJobId(projectId, fileId, Date.now())]) {
      const job = await queue.getJob(id);
      const state = job?.getState ? await job.getState() : null;
      if (state && IN_FLIGHT.includes(state)) return true;
    }
    if (queue.getJobs) {
      const jobs = await queue.getJobs(["waiting", "active", "delayed"], 0, 100);
      return jobs.some((j) => j?.name === HTML_MOCKUP_IMPORT_JOB && (j.data as { projectId?: string } | undefined)?.projectId === projectId);
    }
  } catch {
    return false;
  }
  return false;
}

export async function loadHomepageRead(db: Db, projectId: string): Promise<HomepageReadView> {
  const [file] = await db
    .select({ id: intakeFile.id, fileName: intakeFile.fileName, createdAt: intakeFile.createdAt })
    .from(intakeFile)
    .where(and(eq(intakeFile.projectId, projectId), eq(intakeFile.kind, "homepage_html"), eq(intakeFile.status, "ready")))
    .orderBy(desc(intakeFile.createdAt))
    .limit(1);
  if (!file) return { file: null, state: "none", failure: null, done: null };
  const base = { file: { id: file.id, fileName: file.fileName } };

  // Done: the version the worker wrote for THIS file (its checks name the file), the newest first.
  const versions = await db
    .select({ conceptId: conceptVersion.conceptId, version: conceptVersion.version, checks: conceptVersion.checks })
    .from(conceptVersion)
    .innerJoin(concept, eq(concept.id, conceptVersion.conceptId))
    .where(and(eq(concept.projectId, projectId), eq(concept.skillId, HTML_HOMEPAGE_CONCEPT)))
    .orderBy(desc(conceptVersion.version));
  const mine = versions.find((v) => (v.checks as { fileId?: string } | null)?.fileId === file.id);
  if (mine) {
    const checks = mine.checks as { removed?: string[]; warnings?: string[] };
    const approved = await approvedMockupVersion(db, projectId);
    const plan = await db.select({ kind: pagePlanPage.kind }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId));
    return {
      ...base,
      state: "done",
      failure: null,
      done: {
        conceptId: mine.conceptId,
        version: mine.version,
        removed: checks.removed ?? [],
        warnings: checks.warnings ?? [],
        approvedOlder: approved && approved.concept.id === mine.conceptId && approved.version.version < mine.version ? { approved: approved.version.version, latest: mine.version } : null,
        planHasNoHome: plan.length > 0 && !plan.some((p) => p.kind === "home"),
      },
    };
  }

  if (await isReading(projectId, file.id)) return { ...base, state: "reading", failure: null, done: null };

  const [failed] = await db
    .select({ message: jobFailure.message })
    .from(jobFailure)
    .where(and(eq(jobFailure.jobName, HTML_MOCKUP_IMPORT_JOB), eq(jobFailure.projectId, projectId), gte(jobFailure.occurredAt, file.createdAt)))
    .orderBy(desc(jobFailure.occurredAt))
    .limit(1);
  if (failed) return { ...base, state: "failed", failure: failed.message, done: null };
  return { ...base, state: "not_read", failure: null, done: null };
}

/*
  Starts the reading. Safe to call twice: an exact repeat (a double click, a
  second confirm) is "already reading" or "already read", never a second
  Chromium render. `again` is "Read it again": it reads a file that was read
  or failed before.
*/
export async function queueHtmlMockupImport(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  options: { again?: boolean } = {},
): Promise<"queued" | "already_reading" | "already_read"> {
  // The file's own rule decides who may add it; reading it is open to whoever may change the intake or the design.
  if (!can(actor, "intake.design")) assertCan(actor, "intake.edit");
  const view = await loadHomepageRead(ctx.db, projectId);
  if (!view.file) throw new HtmlMockupImportError("Upload the homepage's HTML file first: there is nothing to read yet.");
  if (view.state === "reading") return "already_reading";
  if (view.state === "done" && !options.again) return "already_read";
  const again = options.again === true || view.state === "failed";
  try {
    await getQueue().add(
      HTML_MOCKUP_IMPORT_JOB,
      { projectId, startedByUserId: actor.id, ...(again ? { again: true } : {}) },
      { jobId: htmlMockupImportJobId(projectId, view.file.id, again ? Date.now() : undefined), attempts: 1 },
    );
  } catch {
    throw new HtmlMockupImportError("The homepage couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  return "queued";
}

/*
  Called when an upload is confirmed (confirmUploadAction). Starts the reading
  for a homepage file and for nothing else. It never fails the upload: the
  file is saved either way, and if the queue did not answer the screen says
  "not read yet" with a button.
*/
export async function readHomepageAfterUpload(ctx: ServiceContext, actor: Viewer, fileId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ projectId: intakeFile.projectId, kind: intakeFile.kind, status: intakeFile.status })
    .from(intakeFile)
    .where(eq(intakeFile.id, fileId))
    .limit(1);
  if (!row || row.kind !== "homepage_html" || row.status !== "ready") return;
  try {
    await queueHtmlMockupImport(ctx, actor, row.projectId);
  } catch {
    // Left for the screen: "not read yet", with a button.
  }
}
