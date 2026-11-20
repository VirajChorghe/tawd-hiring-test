import { getDb } from "@tawd/core/db";
import { serviceHeartbeat } from "@tawd/core/schema";
import { envPresence } from "@tawd/core/settings-check";

/*
  The worker's version, for the signed-in /api/health check (26 September
  2026). The bundle carries the app's version (scripts/build.mjs); running
  from source it is "dev". Written at start and every five minutes, so it
  shows up even when the web app's database changes land after the worker
  started. A failure is only logged: it never stops the worker.
*/
declare const __TAWD_VERSION__: string | undefined;

export const WORKER_VERSION = typeof __TAWD_VERSION__ === "string" ? __TAWD_VERSION__ : "dev";

export async function recordHeartbeat(startedAt: Date, db = getDb()): Promise<void> {
  try {
    const now = new Date();
    await db
      .insert(serviceHeartbeat)
      // Which settings the worker has, names and yes/no only, for the health page.
      .values({ service: "worker", version: WORKER_VERSION, startedAt, seenAt: now, env: envPresence("worker") })
      .onConflictDoUpdate({ target: serviceHeartbeat.service, set: { version: WORKER_VERSION, startedAt, seenAt: now, env: envPresence("worker") } });
  } catch (error) {
    console.warn(`Couldn't record the worker's version: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export function startHeartbeat(): void {
  const startedAt = new Date();
  void recordHeartbeat(startedAt);
  setInterval(() => void recordHeartbeat(startedAt), 5 * 60_000).unref();
}
