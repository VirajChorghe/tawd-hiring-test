import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { goLive, siteBuild, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { WpPreviewAction } from "@tawd/core/queue";
import { GOLIVE_STEPS, PAID_CERT_PRICE, ROLLBACK_STEPS, UNDO_ROLLBACK_STEPS, certRequestLost, freshSteps, readCerts, rollbackTarget, undoTarget, writeCert, type CertPath, type PreviewStep, type SiteBackup, type WpCert } from "@tawd/core/wp-preview";
import { GoLiveError, loadGoLive } from "@/lib/golive";
import { certPathOf } from "@/lib/twentyi";
import { queueWp, suspendJobOf, WpPreviewError, WpQueueUnsureError } from "@/lib/wp-preview";
import type { ServiceContext } from "@/lib/users";

/*
  Build B, B3 (1 October 2026): a WordPress site's go-live; on 20i since
  5 October 2026 (docs/plans/build-b-20i.md). The client's domain is added
  to the site's own 20i package by TAWD; two records point it there (F3),
  or VML runs its DNS; the HTTPS certificate comes the way an admin chose
  on System (TAWD's Let's Encrypt one, 20i's paid one with an admin's
  confirm, or one installed by hand), and Check HTTPS confirms it. Then Go
  live backs the site up to R2, moves it to the domain and lets search
  engines in. Roll back restores the newest backup. The worker does the
  work (apps/worker/src/wp-preview.ts); the web app only queues it.
*/

type Db = Database;
const LOST_MS = 75 * 60_000;

async function rowOf(db: Db, projectId: string) {
  const [row] = await db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  return row ?? null;
}

async function queue(projectId: string, action: WpPreviewAction, extra: { target?: "preview" | "live"; by?: string } = {}): Promise<void> {
  try {
    await queueWp(projectId, action, extra);
  } catch (error) {
    if (error instanceof WpQueueUnsureError) throw error;
    throw new GoLiveError("The job queue isn't answering. Try again in a minute.");
  }
}

type WpRow = NonNullable<Awaited<ReturnType<typeof rowOf>>>;

/*
  Marks the live site busy, then queues the job; when the queue doesn't
  answer, the mark is taken back, so the buttons (and project deletion)
  aren't blocked for 75 minutes (13 October 2026, the whole-code review).
*/
async function markAndQueue(db: Db, row: WpRow, mark: Partial<typeof wpPreview.$inferInsert>, action: WpPreviewAction): Promise<void> {
  // Only over the state this click read: of two clicks together, the second finds it marked (CodeRabbit, PR #7).
  const markedAt = new Date();
  const [marked] = await db
    .update(wpPreview)
    .set({ ...mark, updatedAt: markedAt })
    .where(and(eq(wpPreview.projectId, row.projectId), sql`${wpPreview.liveState} is not distinct from ${row.liveState}`))
    .returning({ id: wpPreview.projectId });
  if (!marked) throw new GoLiveError("TAWD is already working on the live site.");
  try {
    await queue(row.projectId, action);
  } catch (error) {
    // Unsure whether the queue took the job: the mark stays (CodeRabbit, PR #15).
    if (error instanceof WpQueueUnsureError) throw error;
    // Taken back only while the mark is still this click's own.
    await db
      .update(wpPreview)
      .set({ liveState: row.liveState, liveSteps: row.liveSteps, startedByUserId: row.startedByUserId, updatedAt: row.updatedAt })
      .where(and(eq(wpPreview.projectId, row.projectId), eq(wpPreview.updatedAt, markedAt)))
      // The queue's message is the one shown, even if taking the mark back fails too (CodeRabbit, PR #7).
      .catch(() => undefined);
    throw error;
  }
}

const busy = (row: WpRow) => (row.liveState === "attaching" || row.liveState === "going_live" || row.liveState === "rolling_back") && row.updatedAt.getTime() > Date.now() - LOST_MS;

/* Put the domain on 20i (or Try again). */
export async function attachWpDomain(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const row = await rowOf(ctx.db, projectId);
  const [gl] = await ctx.db.select().from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  if (!gl?.domainConfirmedAt || !gl.domain) throw new GoLiveError("Confirm the domain first.");
  if (!row || !row.deployedVersion || row.state === "removed" || !row.packageId) throw new GoLiveError("Deploy the WordPress preview first: the domain is added to its 20i package.");
  if (busy(row)) throw new GoLiveError("TAWD is already working on the live site.");
  await markAndQueue(ctx.db, row, { liveState: "attaching" }, "attach");
}

/*
  The client's domain's certificate, by the HTTPS path on System. TAWD's own
  (Let's Encrypt) is free and queued at once; 20i's paid one needs an
  admin's confirm (confirmPaidCertificate); by hand, the card says where.
  Also queued by itself when the records first point at the site (connect.ts).
*/
export async function requestWpCertificate(ctx: Pick<ServiceContext, "db" | "ipAddress" | "userAgent">, actor: Viewer, projectId: string, by: "pm" | "auto" = "pm"): Promise<void> {
  if (by === "pm") assertCan(actor, "project.edit");
  const row = await rowOf(ctx.db, projectId);
  if (!row?.domainOnHostAt || !row.liveDomain) throw new GoLiveError("Put the domain on 20i first.");
  const path = await certPathOf(ctx.db);
  if (path === "twentyi_paid") throw new GoLiveError(`20i's certificate costs $${PAID_CERT_PRICE} a year: an admin confirms buying it (Buy 20i's certificate).`);
  const certs = readCerts(row.certs);
  // Already on its way, unless that request is over half an hour old: then it's taken as lost and asked for again (Fable's code review, finding 3).
  if (certs.live?.state === "requested" && !certRequestLost(certs.live)) return;
  const cert: WpCert = {
    state: path === "manual" ? "installing" : "requested",
    source: path,
    host: row.liveDomain,
    issuer: certs.live?.issuer ?? null,
    issuedAt: certs.live?.issuedAt ?? null,
    expiresAt: certs.live?.expiresAt ?? null,
    note: null,
    warned: certs.live?.warned ?? [],
    requestedAt: new Date().toISOString(),
    installedAt: certs.live?.installedAt ?? null,
  };
  if (path === "manual") cert.note = `Install a certificate for ${row.liveDomain} and www.${row.liveDomain} in My20i (Manage hosting, SSL/TLS), then Check HTTPS.`;
  await writeCert(ctx.db, projectId, "live", cert);
  if (path !== "manual") await queue(projectId, "cert", { target: "live" });
  await recordActivity(ctx.db, { action: "site.wp_cert_requested", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { host: row.liveDomain, path, by }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* 20i's paid certificate: an admin confirms the price (rule 9), then TAWD orders it. Never automatic. */
export async function confirmPaidCertificate(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const row = await rowOf(ctx.db, projectId);
  if (!row?.domainOnHostAt || !row.liveDomain) throw new GoLiveError("Put the domain on 20i first.");
  const path: CertPath = await certPathOf(ctx.db);
  if (path !== "twentyi_paid") throw new GoLiveError("WordPress sites don't use 20i's paid certificate (System, 20i: HTTPS).");
  const certs = readCerts(row.certs);
  if (certs.live?.source === "twentyi_paid" && certs.live.paidId) throw new GoLiveError("20i's certificate is already bought for this site.");
  if (certs.live?.source === "twentyi_paid" && certs.live.state === "requested" && !certRequestLost(certs.live)) throw new GoLiveError("20i's certificate is already being ordered.");
  const cert: WpCert = { state: "requested", source: "twentyi_paid", host: row.liveDomain, issuer: null, issuedAt: null, expiresAt: null, note: null, confirmedBy: actor.id, warned: [], requestedAt: new Date().toISOString() };
  await writeCert(ctx.db, projectId, "live", cert);
  await queue(projectId, "cert", { target: "live" });
  await recordActivity(ctx.db, { action: "site.wp_paid_cert_confirmed", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { host: row.liveDomain, price: PAID_CERT_PRICE, yearly: true }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* Check HTTPS on the client's domain: the worker opens it as a browser would and reads the certificate. */
export async function checkWpHttps(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const row = await rowOf(ctx.db, projectId);
  if (!row?.domainOnHostAt) throw new GoLiveError("Put the domain on 20i first.");
  await queue(projectId, "https_live");
}

export async function wpGoLive(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "site.golive");
  const view = await loadGoLive(ctx.db, projectId);
  if (!view.gate.ready) throw new GoLiveError(`Not ready to go live: ${view.gate.blockers.join(" ")}`);
  const row = await rowOf(ctx.db, projectId);
  if (!row) throw new GoLiveError("Deploy the WordPress preview first.");
  if (row.suspendedAt) throw new GoLiveError("This site is suspended at 20i: an admin restores it first (Hosting).");
  if (busy(row)) throw new GoLiveError("TAWD is already working on the live site.");
  await markAndQueue(ctx.db, row, { liveState: "going_live", liveSteps: freshSteps(GOLIVE_STEPS), startedByUserId: actor.id }, "golive");
  await recordActivity(ctx.db, { action: "site.wp_golive_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { domain: view.row.domain, version: row.deployedVersion }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function wpRollback(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "site.golive");
  const row = await rowOf(ctx.db, projectId);
  // The newest backup that isn't a Roll back's own (those are for Undo the roll back).
  const target = rollbackTarget((row?.backups as SiteBackup[] | null) ?? []);
  if (!row || !target) throw new GoLiveError("There's no backup to restore.");
  if (!target.sqlKey) throw new GoLiveError("The newest backup was made on Bluehost and can't be restored on 20i.");
  if (busy(row)) throw new GoLiveError("TAWD is already working on the live site.");
  await markAndQueue(ctx.db, row, { liveState: "rolling_back", liveSteps: freshSteps(ROLLBACK_STEPS) }, "rollback");
  await recordActivity(ctx.db, { action: "site.wp_rollback_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { backup: target.stamp, kind: target.kind }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* Undo the roll back (Fable's code review, finding 10): the site as it was just before the last Roll back, from the backup taken then. */
export async function wpUndoRollback(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "site.golive");
  const row = await rowOf(ctx.db, projectId);
  const target = undoTarget((row?.backups as SiteBackup[] | null) ?? []);
  if (!row || !target) throw new GoLiveError("There's no Roll back to undo (a deploy since then replaced it).");
  if (busy(row)) throw new GoLiveError("TAWD is already working on the live site.");
  await markAndQueue(ctx.db, row, { liveState: "rolling_back", liveSteps: freshSteps(UNDO_ROLLBACK_STEPS) }, "undo_rollback");
  await recordActivity(ctx.db, { action: "site.wp_rollback_started", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { backup: target.stamp, kind: target.kind, undo: true }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* ---------- Suspend, Restore, Purge the cache (admins; 20i, 5 October 2026) ---------- */

/* Suspend (a client who stopped paying) or Restore: 20i's package switched off or on; the worker records the outcome. */
export async function setWpSuspended(ctx: ServiceContext, actor: Viewer, projectId: string, suspend: boolean): Promise<void> {
  assertCan(actor, "settings.manage");
  const row = await rowOf(ctx.db, projectId);
  if (!row?.packageId || row.state === "removed") throw new WpPreviewError("There's no 20i package for this site.");
  if (suspend && row.suspendedAt) throw new WpPreviewError("This site is already suspended.");
  if (!suspend && !row.suspendedAt) throw new WpPreviewError("This site isn't suspended.");
  const job = await suspendJobOf(ctx.db, projectId);
  if (job && "pending" in job) throw new WpPreviewError(`TAWD is already asking 20i to ${job.pending} this site.`);
  await queueWp(projectId, suspend ? "suspend" : "restore", { by: actor.id });
  // The request is logged here, so the card shows it at once (the worker logs 20i's answer; finding 15).
  await recordActivity(ctx.db, { action: "site.wp_suspend_requested", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { suspend }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* Purge 20i's cache (after a change made in WordPress itself); TAWD clears it after every deploy and go-live anyway. */
export async function purgeWpCache(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const row = await rowOf(ctx.db, projectId);
  if (!row?.packageId || row.state === "removed") throw new WpPreviewError("There's no 20i package for this site.");
  await queueWp(projectId, "purge", { by: actor.id });
}

export interface WpLiveView {
  folder: string | null;
  previewHost: string | null;
  domain: string | null;
  onHost: boolean;
  onHostAt: Date | null;
  /** 20i's reason when it didn't add the domain. */
  note: string | null;
  liveState: string | null;
  liveSteps: PreviewStep[];
  backups: SiteBackup[];
  /** What Roll back restores (null: nothing). */
  rollbackTo: SiteBackup | null;
  /** The backup Undo the roll back restores (null: nothing to undo). */
  undoTo: SiteBackup | null;
  previewCurrent: boolean;
  latestBuild: number | null;
  /** The IPv4 the client's A record points at. */
  ipv4: string | null;
  cert: WpCert | null;
  certPath: CertPath;
  /** The daily IP watch's last finding: the DNS doesn't match 20i's IP (null: fine or not checked). */
  ipProblem: { apiIp: string; apex: string[]; fixedAt: string | null } | null;
  suspended: boolean;
}

/* For the gate and the Go live card; null when the project has no WordPress preview. */
export async function loadWpLive(db: Db, projectId: string): Promise<WpLiveView | null> {
  const row = await rowOf(db, projectId);
  if (!row) return null;
  const [done] = await db.select({ version: siteBuild.version }).from(siteBuild).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done"))).orderBy(desc(siteBuild.version)).limit(1);
  const [gl] = await db.select({ domain: goLive.domain }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  const ip = (row.ipNote ?? null) as { apiIp?: string; apex?: string[]; ok?: boolean | null; fixedAt?: string | null } | null;
  return {
    folder: row.dir,
    previewHost: row.host,
    domain: row.liveDomain ?? gl?.domain ?? null,
    onHost: Boolean(row.domainOnHostAt),
    onHostAt: row.domainOnHostAt,
    note: row.domainOnHostNote,
    liveState: row.liveState,
    liveSteps: (row.liveSteps as PreviewStep[]) ?? [],
    backups: (row.backups as SiteBackup[]) ?? [],
    rollbackTo: rollbackTarget((row.backups as SiteBackup[]) ?? []),
    undoTo: undoTarget((row.backups as SiteBackup[]) ?? []),
    previewCurrent: (row.state === "ready" || row.liveState === "live") && row.deployedVersion !== null && row.deployedVersion === (done?.version ?? null),
    latestBuild: done?.version ?? null,
    ipv4: row.packageIpv4,
    cert: readCerts(row.certs).live ?? null,
    certPath: await certPathOf(db),
    ipProblem: ip && ip.ok === false && ip.apiIp ? { apiIp: ip.apiIp, apex: ip.apex ?? [], fixedAt: ip.fixedAt ?? null } : null,
    suspended: Boolean(row.suspendedAt),
  };
}
