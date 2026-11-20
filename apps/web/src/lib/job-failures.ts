import { desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { jobFailure, project } from "@tawd/core/schema";

export const FAILURE_LIMIT = 100;

export interface JobFailureRow {
  id: string;
  occurredAt: Date;
  queue: string;
  jobName: string;
  jobId: string;
  projectId: string | null;
  /** Null when the project was deleted since. */
  projectName: string | null;
  label: string;
  errorClass: string;
  message: string;
  stack: string;
  lastAiCallId: string | null;
}

/** The last 100 failed jobs, newest first (audit F-040). The worker writes them, scrubbed (apps/worker/src/failures.ts). */
export async function listJobFailures(db: Database): Promise<JobFailureRow[]> {
  return db
    .select({
      id: jobFailure.id,
      occurredAt: jobFailure.occurredAt,
      queue: jobFailure.queue,
      jobName: jobFailure.jobName,
      jobId: jobFailure.jobId,
      projectId: jobFailure.projectId,
      projectName: project.clientName,
      label: jobFailure.label,
      errorClass: jobFailure.errorClass,
      message: jobFailure.message,
      stack: jobFailure.stack,
      lastAiCallId: jobFailure.lastAiCallId,
    })
    .from(jobFailure)
    .leftJoin(project, eq(project.id, jobFailure.projectId))
    .orderBy(desc(jobFailure.occurredAt))
    .limit(FAILURE_LIMIT);
}
