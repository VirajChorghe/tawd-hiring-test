import type { Job } from "bullmq";
import { and, desc, eq, gt } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { aiCall, jobFailure } from "@tawd/core/schema";

/*
  Every failed job leaves one row in job_failure (audit F-040, 12 November
  2026): queue, job, project, the handler's own words, the error's class,
  message and stack, and the newest AI call for the same project in the hour
  before. The container logs go with a redeploy; this row does not. Admins
  read the last hundred on System, Failed jobs.
*/

const MESSAGE_CAP = 2000;
const STACK_CAP = 8000;
const HOUR_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strips what must never be stored: query strings, key/token/password values, and Bearer tokens. */
export function scrubSecrets(text: string): string {
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key, ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- these patterns REMOVE keys and passwords from error text before it is stored; no secret is written here
  return text
    .replace(/(https?:\/\/[^\s?#"'<>)]+)\?[^\s"'<>)]*/gi, "$1")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [removed]")
    .replace(
      /\b((?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi,
      "$1[removed]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[removed]")
    // The batch D review: a JSON key in quotes ("password":"x"), a password in an address (postgres://user:pass@host), and Basic or Token headers.
    .replace(/("(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd|auth|key)"\s*:\s*)("[^"]*"|[^\s,}]+)/gi, '$1"[removed]"')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1[removed]@")
    .replace(/\b(Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [removed]");
}

/**
 * Writes the failure row. Never throws: a failure to record is itself only logged,
 * so it can never change what a handler does next.
 */
export async function recordFailure(job: Job | undefined, error: unknown, label: string): Promise<void> {
  try {
    const err = error instanceof Error ? error : null;
    const message = scrubSecrets(err ? err.message : String(error ?? "unknown")).slice(0, MESSAGE_CAP);
    const stack = scrubSecrets(err?.stack ?? "").slice(0, STACK_CAP);
    const data = (job?.data ?? {}) as { projectId?: unknown; runId?: unknown };
    const projectId = typeof data.projectId === "string" && UUID.test(data.projectId) ? data.projectId : null;
    const runId = typeof data.runId === "string" && UUID.test(data.runId) ? data.runId : null;
    const db = getDb();

    let lastAiCallId: string | null = null;
    if (projectId || runId) {
      const [call] = await db
        .select({ id: aiCall.id })
        .from(aiCall)
        .where(
          and(
            runId ? eq(aiCall.runId, runId) : eq(aiCall.projectId, projectId!),
            gt(aiCall.createdAt, new Date(Date.now() - HOUR_MS)),
          ),
        )
        .orderBy(desc(aiCall.createdAt))
        .limit(1);
      lastAiCallId = call?.id ?? null;
    }

    await db.insert(jobFailure).values({
      queue: job?.queueName ?? "unknown",
      jobName: job?.name ?? "unknown",
      jobId: job?.id ? String(job.id) : "",
      projectId,
      label: scrubSecrets(label).slice(0, 300),
      errorClass: (err?.name || "Error").slice(0, 100),
      message,
      stack,
      lastAiCallId,
    });
  } catch (recordError) {
    console.error(`Could not record the failure of "${label}":`, recordError instanceof Error ? recordError.message : "unknown");
  }
}
