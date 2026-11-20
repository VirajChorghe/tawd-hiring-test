import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { appSetting, e2eCheck, serviceHeartbeat } from "@tawd/core/schema";
import { getAuth } from "./auth";
import { startE2eCheck } from "./e2e-check";
import { alertSiteCheckFailed } from "./site-check-alerts";
import type { ServiceContext } from "./users";

/*
  The Site check after each deploy (Jason, 29 September 2026), started by
  TAWD itself, once per version:

  1. A new web server starts (instrumentation.ts) and checks once a minute.
  2. When the worker reports the same version (its heartbeat), the check
     starts, as TAWD. The version is noted first, so a restart never runs
     it twice.
  3. If the worker isn't on the new version within 30 minutes, that is a
     failure of its own ("the worker didn't come up").

  $0 of AI (stand-in answers). Only a failure is announced: the admins'
  strip, an email to each admin and the team Slack channel. Switched off
  with TAWD_AUTO_SITE_CHECK=off on the web service.
*/

const KEY = "auto_site_check";
export const WORKER_WAIT_MS = 30 * 60_000;
export const TICK_MS = 60_000;

export type Tick = "off" | "done" | "waiting" | "started" | "worker_missing";

/* Who TAWD is when it starts the check itself. */
const TAWD = { ...SYSTEM_ACTOR, email: "system:site-check" };

async function claim(db: Database, version: string, state: string): Promise<boolean> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, KEY)).limit(1);
  if ((row?.value as { version?: string } | undefined)?.version === version) return false;
  const value = { version, state, at: new Date().toISOString() };
  await db.insert(appSetting).values({ key: KEY, value }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date() } });
  return true;
}

export async function autoSiteCheckTick(input: { db: Database; version: string; startedAt: Date; now?: Date; ctx?: ServiceContext }): Promise<Tick> {
  const { db, version } = input;
  if (process.env.TAWD_AUTO_SITE_CHECK?.trim().toLowerCase() === "off") return "off";
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, KEY)).limit(1);
  if ((row?.value as { version?: string } | undefined)?.version === version) return "done";

  const [worker] = await db.select({ version: serviceHeartbeat.version }).from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
  if (worker?.version === version) {
    if (!(await claim(db, version, "started"))) return "done";
    const ctx = input.ctx ?? { db, auth: getAuth(), ipAddress: null, userAgent: null };
    await startE2eCheck(ctx, TAWD, { automatic: { version } });
    return "started";
  }

  const waited = (input.now ?? new Date()).getTime() - input.startedAt.getTime();
  if (waited < WORKER_WAIT_MS) return "waiting";
  if (!(await claim(db, version, "worker_missing"))) return "done";
  const detail = worker
    ? `The worker is still on ${worker.version}, 30 minutes after the web app started on ${version}. Check the worker's deploy in Coolify (tawd-worker-new).`
    : `The worker hasn't reported at all, 30 minutes after the web app started on ${version}. Check the worker in Coolify (tawd-worker-new).`;
  await db.insert(e2eCheck).values({
    status: "failed",
    steps: [{ key: "clear", label: `Wait for the worker on ${version}`, status: "failed", detail }],
    finishedAt: new Date(),
  });
  await alertSiteCheckFailed(db, { version, step: `Wait for the worker on ${version}`, detail });
  return "worker_missing";
}

/* From instrumentation.ts: once a minute until this version's check has started (or can't). */
export function scheduleAutoSiteCheck(db: Database, version: string): void {
  const startedAt = new Date();
  const timer = setInterval(() => {
    autoSiteCheckTick({ db, version, startedAt })
      .then((tick) => {
        if (tick !== "waiting") clearInterval(timer);
        if (tick === "started") console.log(`TAWD: the Site check for ${version} started.`);
      })
      .catch((error: unknown) => console.error(`TAWD: the automatic Site check couldn't start: ${error instanceof Error ? error.message : "unknown"}`));
  }, TICK_MS);
  timer.unref();
}
