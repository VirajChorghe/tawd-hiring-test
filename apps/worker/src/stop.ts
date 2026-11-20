import { AsyncLocalStorage } from "node:async_hooks";
import { eq, inArray } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { stopRequest, user as userTable } from "@tawd/core/schema";
import { StoppedError, stopKeysFor } from "@tawd/core/stops";

/*
  The Stop button, in the worker (28 September 2026): each job runs with
  the stop keys it answers to and the time it was queued; before every AI
  call (in stepModel) the worker looks for a stop pressed after that time
  and ends the job there with StoppedError, so nothing more is spent and
  what was finished stays.
*/

const current = new AsyncLocalStorage<{ keys: string[]; queuedAt: number }>();

export function runJobWithStops<T>(job: { name: string; data: unknown; timestamp?: number }, fn: () => Promise<T>): Promise<T> {
  const keys = stopKeysFor(job.name, (job.data ?? {}) as Record<string, unknown>);
  return current.run({ keys, queuedAt: job.timestamp ?? Date.now() }, fn);
}

export async function checkStop(db: Database): Promise<void> {
  const job = current.getStore();
  if (!job || job.keys.length === 0) return;
  const stops = await db.select().from(stopRequest).where(inArray(stopRequest.key, job.keys));
  const hit = stops.find((s) => s.requestedAt.getTime() >= job.queuedAt);
  if (!hit) return;
  const [who] = hit.requestedByUserId ? await db.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, hit.requestedByUserId)).limit(1) : [];
  throw new StoppedError(who?.name ?? null);
}
