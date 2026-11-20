import { eq } from "drizzle-orm";

import pkg from "../../../../package.json";
import { getCurrentUser } from "@/lib/session";
import { getDb } from "@tawd/core/db";
import { serviceHeartbeat } from "@tawd/core/schema";
import { envPresence, settingsCheck } from "@tawd/core/settings-check";

// Never prerendered or cached: a health check has to report the state of the
// running container at the moment it is asked, not at build time.
export const dynamic = "force-dynamic";

/*
  Public: only "ok", so the outside world can't tell which version runs
  (and so which fixes it has). Coolify's check sends no cookie and never
  touches the database. A signed-in team member opening it in the browser
  also sees the version, and the worker's (from its heartbeat), to confirm
  a deploy reached both, and every setting TAWD reads with whether each
  service has it (names and yes/no only, never a value).
*/
export async function GET(request?: Request): Promise<Response> {
  const hasSession = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request?.headers.get("cookie") ?? "");
  const current = hasSession ? await getCurrentUser().catch(() => null) : null;
  if (!current || current.isDisabled) return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  const worker = await workerHeartbeat();
  return Response.json(
    {
      status: "ok",
      version: pkg.version,
      worker: worker ? { version: worker.version, startedAt: worker.startedAt, lastSeen: worker.seenAt, sameVersion: worker.version === pkg.version } : null,
      settings: settings((worker?.env ?? null) as Record<string, boolean> | null),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/* The settings check (27 September 2026): the web app's own settings and the worker's report. */
function settings(workerEnv: Record<string, boolean> | null) {
  const workerReport = workerEnv && Object.keys(workerEnv).length ? workerEnv : null;
  const check = settingsCheck(envPresence("web"), workerReport);
  return {
    ok: check.missing.length === 0,
    missing: check.missing,
    workerReported: Boolean(workerReport),
    list: check.rows.map((r) => ({ name: r.name, purpose: r.purpose, need: r.need, web: label(r.web), worker: label(r.worker), ...(r.missing ? { missing: true } : {}) })),
  };
}

const label = (value: boolean | string) => (value === true ? "set" : value === false ? "not set" : value);

/* The worker's last heartbeat, or null when there is none or the database can't be asked. */
async function workerHeartbeat() {
  try {
    const [row] = await getDb().select().from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}
