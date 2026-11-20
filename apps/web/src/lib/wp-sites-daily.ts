import { eq, sql } from "drizzle-orm";
import { claimScheduledRun } from "@tawd/core/scheduled-run";

import type { Database } from "@tawd/core/db";
import { appSetting } from "@tawd/core/schema";
import { WP_HOLDER_WATCH_JOB, WP_SITES_DAILY_JOB, wpHolderWatchJobId, wpSitesDailyJobId } from "@tawd/core/queue";
import { previewDomainSetting, WP_SITES_DAILY_SETTING } from "@tawd/core/wp-preview";
import { getQueue } from "@/lib/mockups";

/*
  The daily work for WordPress sites on 20i (5 October 2026; Fable's review,
  finding 5): the IP watch, certificate renewals and expiry warnings run on
  the worker (it holds 20i's key). A 24-hour timer here would restart on
  every web deploy and never fire, so an hourly tick reads when the work
  last started (app_setting wp_sites_daily) and queues it when that is
  more than 20 hours ago. The worker stamps the finish; System shows it.
*/

type Db = Database;

/** How often the daily work runs at most. */
export const DAILY_EVERY_MS = 20 * 3_600_000;
/** A run started this long ago with no finish is taken as lost (System says so; the next tick starts it again). */
export const UNFINISHED_AFTER_MS = 2 * 3_600_000;

/*
  The preview domain's watch (0.122.0): every tick, so every hour, when a preview domain is set. Its job id is the clock hour, so a
  second tick in the same hour adds nothing. Never throws.
*/
export async function holderWatchTick(now = new Date()): Promise<boolean> {
  if (!previewDomainSetting()) return false;
  try {
    const at = now.toISOString();
    await getQueue().add(WP_HOLDER_WATCH_JOB, { at }, { jobId: wpHolderWatchJobId(at), attempts: 1 });
    return true;
  } catch (error) {
    console.error(`The preview domain's watch: ${error instanceof Error ? error.name : "not queued"}`);
    return false;
  }
}

/* Queues the daily work when it's due; true when it did. Never throws. */
export async function wpSitesTick(db: Db, now = new Date()): Promise<boolean> {
  await holderWatchTick(now);
  try {
    const [row] = await db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING)).limit(1);
    const value = (row?.value ?? {}) as { startedAt?: string; finishedAt?: string };
    const last = value.startedAt ? Date.parse(value.startedAt) : NaN;
    const finished = value.finishedAt ? Date.parse(value.finishedAt) : NaN;
    // A run that started over two hours ago and never finished (the worker restarted mid-run) is due again now.
    const lost = Number.isFinite(last) && now.getTime() - last > UNFINISHED_AFTER_MS && (!Number.isFinite(finished) || finished < last);
    if (Number.isFinite(last) && now.getTime() - last < DAILY_EVERY_MS && !lost) return false;
    const at = now.toISOString();
    // Queued first, stamped after: a queue that doesn't answer costs an hour, not a day (Fable's code review, finding 6). The stamp
    // sets startedAt alone, so a worker that already finished keeps its finishedAt and summary. (One web server today: two racing
    // between the read and the add would both queue, which is harmless; the job's id is the time.)
    await getQueue().add(WP_SITES_DAILY_JOB, { at }, { jobId: wpSitesDailyJobId(at), attempts: 1 });
    await db
      .insert(appSetting)
      .values({ key: WP_SITES_DAILY_SETTING, value: { startedAt: at } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: sql`coalesce(${appSetting.value}, '{}'::jsonb) || jsonb_build_object('startedAt', ${at}::text)`, updatedAt: now } });
    return true;
  } catch (error) {
    console.error(`WordPress sites daily tick: ${error instanceof Error ? error.message : "not queued"}`);
    return false;
  }
}

/** The first look after the web server starts: a few minutes, so a day of many deploys can't keep pushing the hourly tick off (finding 6). */
export const FIRST_TICK_MS = 3 * 60_000;

/* Started with the web server (instrumentation.ts): once a few minutes after start, then once an hour. */
export function scheduleWpSitesDaily(db: Db): void {
  // D5: one tick per hour across every web server and restart (scheduled-run.ts); the tick itself decides what is due.
  const tick = () =>
    void (async () => {
      if (await claimScheduledRun(db as never, "wp-sites-daily", 60 * 60_000 * 0.9)) await wpSitesTick(db);
    })().catch(() => undefined);
  setTimeout(tick, FIRST_TICK_MS).unref();
  const timer = setInterval(tick, 60 * 60_000);
  timer.unref();
}
