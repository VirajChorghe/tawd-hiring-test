import { getDb } from "@tawd/core/db";
import { latestAppliedMigration as readLatest } from "@tawd/core/schema-version";

/*
  The worker waits for the database it was built for (3 November 2026, PR #25 review).

  Only the web container applies migrations (docker-entrypoint.sh); the worker
  deploys from the same push, separately. A new worker that starts first would
  run its queries against the old schema: any `select().from(project)` asks for
  columns that don't exist yet ("column flow does not exist", 0.121.0), and the
  job fails. Error-handling.md's "deploy window" note recorded the same thing for
  one column; this closes it for all of them.

  So before it takes any job, the worker checks that the newest migration it was
  built with is in the database, the same test drizzle's migrator uses (the
  journal's `when`, stored as `created_at` in drizzle.__drizzle_migrations).
  Until then jobs wait in the queue (nothing is lost, nothing paid starts half
  way). It says so in the log every minute, and after 15 minutes posts once to
  the team's Slack: a web deploy that failed to migrate would otherwise leave the
  worker waiting with nobody told.
*/
declare const __TAWD_SCHEMA_WHEN__: number | undefined;

/** The newest migration this bundle was built with; null when running from source (no wait). */
export const EXPECTED_SCHEMA_WHEN: number | null =
  typeof __TAWD_SCHEMA_WHEN__ === "number" ? __TAWD_SCHEMA_WHEN__ : null;

/** The newest migration the database has applied (core schema-version.ts). */
export async function latestAppliedMigration(): Promise<number | null> {
  return readLatest(getDb());
}

export interface SchemaWait {
  expected: number | null;
  readLatest: () => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  alert?: (message: string) => Promise<void>;
  pollMs?: number;
  alertAfterMs?: number;
  now?: () => number;
}

/** Resolves once the database has the expected migration (at once if it already has, or if nothing is expected). */
export async function waitForSchema(options: SchemaWait): Promise<void> {
  const {
    expected,
    readLatest,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (message) => console.log(message),
    alert = async () => {},
    pollMs = 5_000,
    alertAfterMs = 15 * 60_000,
    now = () => Date.now(),
  } = options;
  if (expected === null) return;

  const startedAt = now();
  let lastLogAt = -Infinity;
  let alerted = false;
  for (;;) {
    const latest = await readLatest();
    if (latest !== null && latest >= expected) {
      if (lastLogAt !== -Infinity) log("The database is up to date. Taking jobs now.");
      return;
    }
    const waited = now() - startedAt;
    if (now() - lastLogAt >= 60_000) {
      log(`Waiting for the database update before taking jobs (the web app applies it as it starts). Waited ${Math.round(waited / 1000)} s so far; jobs stay in the queue.`);
      lastLogAt = now();
    }
    if (!alerted && waited >= alertAfterMs) {
      alerted = true;
      await alert(
        "TAWD's worker has waited 15 minutes for the database update and is not taking jobs. The web app's deploy probably didn't finish its migration: check the web app's deploy log in Coolify. Jobs are waiting in the queue, not lost.",
      );
    }
    await sleep(pollMs);
  }
}
