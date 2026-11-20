import { lte } from "drizzle-orm";

import type { Database } from "../db";
import { scheduledRun } from "../db/schema";

/*
  D5 (audit F-042, 12 November 2026): scheduled work that runs once, and
  keeps its time across restarts.

  The web app's timers each ran on their own interval in their own process:
  a deploy restarted every one of them (the daily purge counted its day from
  the restart), and a second web server would have run each one twice.
  Now a tick does its work only after claiming its name: one statement that
  records "now" only when the last run is at least everyMs ago. Whoever's
  statement lands first does the work; every other tick, on any server,
  finds it taken and does nothing.
*/
export async function claimScheduledRun(db: Database, name: string, everyMs: number, now = new Date()): Promise<boolean> {
  const due = new Date(now.getTime() - everyMs);
  const rows = await db
    .insert(scheduledRun)
    .values({ name, lastRunAt: now })
    .onConflictDoUpdate({
      target: scheduledRun.name,
      set: { lastRunAt: now },
      // lte with the column on the left encodes the Date; a raw Date in sql`` throws on postgres-js (the fresh review of batch D).
      where: lte(scheduledRun.lastRunAt, due),
    })
    .returning({ name: scheduledRun.name });
  return rows.length > 0;
}
