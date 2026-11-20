import { and, desc, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { activityLog, appSetting, goLive, project, serviceHeartbeat, siteBuild, sshKey, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, can, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { WP_PREVIEW_JOB, wpPreviewJobId, type WpPreviewAction } from "@tawd/core/queue";
import { decryptSecret, encryptSecret, hasEncryptionKey } from "@tawd/core/secrets";
import {
  PACKAGE_LIMIT,
  TWENTYI_NEXT_PLAN,
  TWENTYI_PLAN,
  nextPlanWords,
  TWENTYI_KEY_PURPOSE,
  TWENTYI_PACKAGE_TYPE_SETTING,
  makeAdminUser,
  deploySteps,
  isStagingHost,
  makePassword,
  onPreviewDomain,
  keepsLegacyPackage,
  needsFreshPackage,
  packageDomainFrom,
  previewDomainSetting,
  previewHostFor,
  previewName,
  readCerts,
  removeSteps,
  writeCert,
  type PreviewStep,
  type WpCerts,
} from "@tawd/core/wp-preview";
import { getQueue } from "@/lib/mockups";
import { loadHosting } from "@/lib/hosting";
import { ensureTwentyiKey, lastDoneCheck } from "@/lib/twentyi";
import { formEmailsFor } from "@/lib/wordpress-package";
import { channelSecret, postmarkSetup, relayUrls } from "@/lib/forms-relay";
import type { ServiceContext } from "@/lib/users";

/*
  Build B, B2 (1 October 2026): the project's WordPress preview; on 20i
  since 5 October 2026 (docs/plans/build-b-20i.md), one 20i hosting package
  per site. PMs and admins deploy it, deploy it again after a new build, or
  remove it; the worker does the work through 20i's API and over SSH (apps/
  worker/src/wp-preview.ts). The web app holds no 20i key: everything that
  touches 20i is a queued job. The WordPress login TAWD made is shown to
  admins only, and every showing is logged. Free, no AI.
*/

export class WpPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WpPreviewError";
  }
}

/*
  The queue answered with an error and couldn't say whether it took the job
  either (CodeRabbit, PR #15): the job may still run, so the busy mark stays
  and it clears by itself if nothing happens.
*/
export class WpQueueUnsureError extends WpPreviewError {
  constructor() {
    super("The job queue didn't confirm the job, so it may still run. Wait a few minutes before pressing it again.");
    this.name = "WpQueueUnsureError";
  }
}

/** A deploy still deploying after this long is taken as lost (the worker restarted). */
const LOST_AFTER_MS = 75 * 60 * 1000;

type Db = Database;

/* Why a deploy can't start now, in the order to fix them; empty when it can. */
export async function wpPreviewBlockers(db: Db, projectId: string): Promise<string[]> {
  const out: string[] = [];
  const hosting = await loadHosting(db, projectId);
  if (hosting?.hosting !== "wordpress") out.push("Hosting isn't WordPress.");
  const [done] = await db
    .select({ version: siteBuild.version })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  if (!done) out.push("Build the site first: the preview is made from the finished build.");
  const [worker] = await db.select().from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
  const env = (worker?.env ?? {}) as Record<string, boolean>;
  if (worker && !env.TWENTYI_API_KEY) out.push("The worker's 20i key is missing: an admin adds TWENTYI_API_KEY in Coolify on tawd-worker-new only, then redeploys the worker (System, 20i).");
  const [key] = await db.select({ purpose: sshKey.purpose }).from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
  // TAWD makes the key itself at the first deploy (ensureTwentyiKey); only a missing encryption key stops that.
  if (!key && !hasEncryptionKey()) out.push("TAWD can't make its 20i SSH key: TAWD_ENCRYPTION_KEY isn't set on the web app (Coolify, tawd-web-new).");
  const check = await lastDoneCheck(db);
  if (!check?.keyWorks) out.push("20i isn't checked yet: an admin runs Check the 20i account on System.");
  const [type] = await db.select({ key: appSetting.key }).from(appSetting).where(eq(appSetting.key, TWENTYI_PACKAGE_TYPE_SETTING)).limit(1);
  if (!type) out.push("The package type TAWD uses isn't chosen yet (System, 20i).");
  if (previewDomainSetting() && worker && (!env.WP_PREVIEW_DOMAIN || !env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID))
    out.push("The preview domain needs WP_PREVIEW_DOMAIN, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on the worker too (tawd-worker-new in Coolify).");
  if (!hasEncryptionKey()) out.push("TAWD_ENCRYPTION_KEY isn't set, so the passwords can't be stored safely.");
  const [row] = await db.select({ packageId: wpPreview.packageId, state: wpPreview.state }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  // With the preview domain set, a new package is named after the preview address (0.119.0); only without it is the client's domain needed.
  if ((!row?.packageId || row.state === "removed") && !previewDomainSetting() && !(await clientDomainFor(db, projectId)))
    out.push(NO_DOMAIN);
  return out;
}

export interface WpPreviewView {
  state: "none" | "deploying" | "ready" | "failed" | "removing" | "removed";
  /** The address the team opens (null until the package exists, without a preview domain). */
  host: string | null;
  /** 20i's own address: a fallback link, and the preview itself without a preview domain. */
  stagingHost: string | null;
  /** On 20i's address with a package named after the client's domain: only Remove, then Deploy again, reaches the preview domain (0.119.0). */
  needsFreshPackage: boolean;
  /** The same, but the client's domain is already on the package: it stays on 20i's address (never removed for this). */
  keepsLegacyPackage: boolean;
  /** The preview is on 20i's staging address (slower servers: the speed gate can't measure it). */
  onStaging: boolean;
  /** The preview domain the next deploy uses (WP_PREVIEW_DOMAIN), or null. */
  previewDomain: string | null;
  version: number | null;
  deployedVersion: number | null;
  latestBuild: number | null;
  https: boolean;
  steps: PreviewStep[];
  failureReason: string | null;
  removing: boolean;
  startedBy: string | null;
  startedAt: Date | null;
  deployedAt: Date | null;
  blockers: string[];
  packageId: string | null;
  ipv4: string | null;
  suspendedAt: Date | null;
  certs: WpCerts;
  /** The last check counted this many packages on VML's 20i account (null: not checked). */
  packagesUsed: number | null;
  /** A new package now would go past VML's 20i plan: an admin confirms first. */
  needsLimitConfirm: boolean;
  /** VML's 20i plan, for the confirm's words: its name, its limit and the plan past it with its price. */
  plan: { name: string; limit: number; next: string };
  limitConfirmedBy: string | null;
  /** A preview left from Bluehost (5 October 2026): removing it only marks it removed. */
  fromBluehost: boolean;
  /** Suspend or Restore: asked for and not done yet, or 20i's refusal of the last one (Fable's code review, finding 15). */
  suspendJob: SuspendJob;
  /** The last move between 20i's address and the preview domain (12 October 2026). */
  move: PreviewMove;
}

/**
  The last move between 20i's staging address and the preview domain (12 October 2026), read from the activity log: being checked
  (moved, not confirmed yet), loading, moved back by TAWD (and why), refused by 20i, or a move back that failed.
*/
export type PreviewMove = { state: "checking" | "loads" | "moved_back" | "refused" | "move_back_failed"; to: string | null; reason: string | null; at: Date } | null;

const MOVE_ACTIONS = {
  "site.wp_preview_moved": "checking",
  "site.wp_preview_move_confirmed": "loads",
  "site.wp_preview_moved_back": "moved_back",
  "site.wp_preview_move_refused": "refused",
  "site.wp_preview_move_back_failed": "move_back_failed",
} as const;

export async function previewMoveOf(db: Db, projectId: string): Promise<PreviewMove> {
  const [last] = await db
    .select({ action: activityLog.action, valueAfter: activityLog.valueAfter, at: activityLog.occurredAt })
    .from(activityLog)
    .where(and(eq(activityLog.entityId, projectId), inArray(activityLog.action, Object.keys(MOVE_ACTIONS) as (keyof typeof MOVE_ACTIONS)[])))
    .orderBy(desc(activityLog.seq))
    .limit(1);
  if (!last) return null;
  const v = (last.valueAfter ?? {}) as { to?: string; from?: string; reason?: string; error?: string };
  const state = MOVE_ACTIONS[last.action as keyof typeof MOVE_ACTIONS];
  // A move back names the preview domain's address it left (from); the others the one it went to (to).
  const to = state === "moved_back" || state === "move_back_failed" ? (v.from ?? null) : (v.to ?? null);
  const reason = state === "move_back_failed" ? `${v.error ?? "no answer"} (moving back because ${v.reason ?? "it didn't load"})` : (v.reason ?? null);
  return { state, to, reason, at: last.at };
}

export type SuspendJob = { pending: "suspend" | "restore" } | { refused: "suspend" | "restore"; reason: string; at: Date } | null;

/** A Suspend or Restore asked for this long ago with no answer is taken as lost (the buttons come back). */
const SUSPEND_LOST_MS = 30 * 60_000;

/*
  Suspend and Restore run on the worker (it holds 20i's key); the card reads where the last one is from the activity log (the
  request, then the worker's outcome), so a click shows at once, a second click is refused, and 20i's refusal is on the card.
*/
export async function suspendJobOf(db: Db, projectId: string, now = new Date()): Promise<SuspendJob> {
  const [last] = await db
    .select({ action: activityLog.action, valueAfter: activityLog.valueAfter, at: activityLog.occurredAt })
    .from(activityLog)
    .where(and(eq(activityLog.entityId, projectId), inArray(activityLog.action, ["site.wp_suspend_requested", "site.wp_suspended", "site.wp_restored"])))
    .orderBy(desc(activityLog.seq))
    .limit(1);
  if (!last) return null;
  const v = (last.valueAfter ?? {}) as { suspend?: boolean; ok?: boolean; reason?: string };
  if (last.action === "site.wp_suspend_requested") return now.getTime() - last.at.getTime() < SUSPEND_LOST_MS ? { pending: v.suspend ? "suspend" : "restore" } : null;
  if (v.ok === false) return { refused: last.action === "site.wp_suspended" ? "suspend" : "restore", reason: v.reason ?? "no answer", at: last.at };
  return null;
}

export async function loadWpPreview(db: Db, projectId: string): Promise<WpPreviewView | null> {
  const hosting = await loadHosting(db, projectId);
  if (hosting?.hosting !== "wordpress") return null;
  const [row] = await db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  const [proj] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  const [done] = await db
    .select({ version: siteBuild.version })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  const steps = (row?.steps ?? []) as PreviewStep[];
  const previewDomain = previewDomainSetting();
  const fresh = !row || row.state === "removed";
  // Before the first deploy: the name the deploy will really use (a -2 when another project has it; Fable's code review, finding 17).
  const host = row && !fresh && row.packageId ? row.host : previewDomain ? previewHostFor(row?.name ?? (await freeName(db, projectId, previewName(proj?.clientName ?? "", projectId))), previewDomain) : null;
  const check = await lastDoneCheck(db);
  const packagesUsed = check?.packages ?? null;
  return {
    state: (row?.state as WpPreviewView["state"] | undefined) ?? "none",
    host,
    stagingHost: row?.stagingHost ?? null,
    onStaging: isStagingHost(host),
    needsFreshPackage: Boolean(row && !fresh && needsFreshPackage(row, previewDomain)),
    keepsLegacyPackage: Boolean(row && !fresh && keepsLegacyPackage(row, previewDomain)),
    previewDomain,
    version: row?.version ?? null,
    deployedVersion: row?.deployedVersion ?? null,
    latestBuild: done?.version ?? null,
    https: row?.https ?? false,
    steps,
    failureReason: row?.failureReason ?? null,
    removing: steps[0]?.key.startsWith("remove") ?? false,
    startedBy: row?.startedByUserId ?? null,
    startedAt: row?.startedAt ?? null,
    deployedAt: row?.deployedAt ?? null,
    blockers: await wpPreviewBlockers(db, projectId),
    packageId: row?.packageId ?? null,
    ipv4: row?.packageIpv4 ?? null,
    suspendedAt: row?.suspendedAt ?? null,
    certs: readCerts(row?.certs),
    packagesUsed,
    needsLimitConfirm: !row?.packageId && packagesUsed !== null && packagesUsed >= PACKAGE_LIMIT,
    limitConfirmedBy: row?.limitConfirmedBy ?? null,
    plan: { name: TWENTYI_PLAN.name, limit: PACKAGE_LIMIT, next: nextPlanWords() },
    fromBluehost: Boolean(row && row.state !== "removed" && !row.packageId && !row.packageDomain && row.host),
    suspendJob: row?.packageId ? await suspendJobOf(db, projectId) : null,
    move: row?.packageId ? await previewMoveOf(db, projectId) : null,
  };
}

function busy(row: typeof wpPreview.$inferSelect | undefined): boolean {
  return Boolean(row && (row.state === "deploying" || row.state === "removing") && row.updatedAt.getTime() > Date.now() - LOST_AFTER_MS);
}

export async function queueWp(projectId: string, action: WpPreviewAction, extra: { target?: "preview" | "live"; by?: string } = {}): Promise<void> {
  const jobId = wpPreviewJobId(projectId, Date.now());
  try {
    await getQueue().add(WP_PREVIEW_JOB, { projectId, action, ...extra }, { jobId, attempts: 1 });
  } catch {
    // The queue can take a job and still answer with an error (a dropped reply). If the job is there it runs, so the click
    // stands and the caller keeps its busy mark: never a second job for the same site (13 October 2026; CodeRabbit, PR #7).
    let there: unknown;
    try {
      there = await getQueue().getJob(jobId);
    } catch {
      throw new WpQueueUnsureError();
    }
    if (there) return;
    throw new WpPreviewError("The job queue isn't answering. Try again in a minute.");
  }
}

/* A name no other project's preview has: "sample-husky-site", else "sample-husky-site-2". */
async function freeName(db: Db, projectId: string, base: string): Promise<string> {
  const taken = new Set((await db.select({ name: wpPreview.name }).from(wpPreview).where(ne(wpPreview.projectId, projectId))).map((r) => r.name));
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base.slice(0, 27)}-${n}`;
  return name;
}

const NO_DOMAIN = "Without a preview domain, 20i names each site's package after the client's own domain: add it on the intake's Website section (Domain name), then deploy. Nothing changes at the domain itself.";

/* The client's domain for the package's main name (8 October 2026): the confirmed go-live domain, else the intake's, else the current site's address. */
async function clientDomainFor(db: Db, projectId: string): Promise<string | null> {
  const [gl] = await db.select({ domain: goLive.domain }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  const intake = await loadIntake(db as Database, SYSTEM_ACTOR, projectId);
  const website = intake?.data.website;
  return packageDomainFrom([gl?.domain, website?.domainName, website?.currentWebsiteUrl], previewDomainSetting());
}

export async function startWpPreview(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  await ensureTwentyiKey(ctx.db);
  const blockers = await wpPreviewBlockers(ctx.db, projectId);
  if (blockers.length) throw new WpPreviewError(blockers[0]!);
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (busy(row)) throw new WpPreviewError("The WordPress preview is already being worked on.");
  if (row?.suspendedAt) throw new WpPreviewError("This site is suspended at 20i: an admin restores it first (Hosting).");
  const [proj] = await ctx.db.select({ clientName: project.clientName, formPlugin: project.formPlugin }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!proj) throw new WpPreviewError("That project no longer exists.");
  const [done] = await ctx.db
    .select({ version: siteBuild.version })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  // A new package beyond the plan's limit: an admin confirms the price first (rule 9); the worker counts again before making it.
  const check = await lastDoneCheck(ctx.db);
  if (!row?.packageId && check?.packages != null && check.packages >= PACKAGE_LIMIT && !row?.limitConfirmedBy)
    throw new WpPreviewError(`This would be site ${check.packages + 1} on 20i: ${TWENTYI_PLAN.name} holds ${PACKAGE_LIMIT}, so VML moves to ${nextPlanWords()}. An admin confirms it first (Hosting).`);
  if (postmarkSetup().configured) await channelSecret(ctx.db, projectId);
  // A preview that was removed, left from Bluehost, or never made at 20i starts again under today's settings (and today's naming).
  const fresh = !row || row.state === "removed" || !row.packageId;
  const name = row?.name ?? (await freeName(ctx.db, projectId, previewName(proj.clientName, projectId)));
  const previewDomain = previewDomainSetting();
  const host = fresh ? (previewDomain ? previewHostFor(name, previewDomain) : null) : row!.host;
  // Option 1 (0.119.0): a new package is named after the preview address; without the preview domain, after the client's domain.
  const packageDomain = fresh ? (host ?? (await clientDomainFor(ctx.db, projectId))) : row!.packageDomain;
  if (!packageDomain) throw new WpPreviewError(NO_DOMAIN);
  // One package per domain: another project's site there would be overwritten.
  if (fresh) {
    const [other] = await ctx.db
      .select({ clientName: project.clientName })
      .from(wpPreview)
      .innerJoin(project, eq(project.id, wpPreview.projectId))
      .where(and(eq(wpPreview.packageDomain, packageDomain), ne(wpPreview.projectId, projectId), ne(wpPreview.state, "removed")))
      .limit(1);
    if (other) throw new WpPreviewError(`${other.clientName}'s WordPress site already has the 20i package for ${packageDomain}. Remove that preview first (its Build page, Hosting), or check the domain on this project's intake.`);
  }
  const usePreviewDomain = onPreviewDomain({ host, packageDomain });
  const values = {
    name,
    packageDomain,
    host,
    // Made once and kept: running again reuses them.
    dbPasswordEncrypted: row?.dbPasswordEncrypted ?? encryptSecret(makePassword()),
    // Its own login name (13 October 2026), made with the site; a site already installed keeps the one WordPress has.
    adminUser: fresh || !row ? makeAdminUser() : row.adminUser,
    adminPasswordEncrypted: row?.adminPasswordEncrypted ?? encryptSecret(makePassword()),
    state: "deploying",
    version: done!.version,
    steps: deploySteps(proj.formPlugin, usePreviewDomain, !fresh && row?.liveState === "live"),
    // F2: with Postmark set up, the theme sends each message to TAWD (signed with the project's key).
    formEmails: { ...(await formEmailsFor(ctx.db, actor, projectId)), relayUrl: postmarkSetup().configured ? `${relayUrls().wordpress}?project=${projectId}` : null },
    failureReason: null,
    startedByUserId: actor.id,
    startedAt: new Date(),
    updatedAt: new Date(),
    ...(fresh ? { dir: null, dbName: null, dbUser: null, dbHost: null, stagingHost: null, packageIpv4: null, sshHost: null, sshUser: null, certs: {} } : {}),
  };
  await ctx.db.insert(wpPreview).values({ projectId, ...values }).onConflictDoUpdate({ target: wpPreview.projectId, set: values });
  try {
    await queueWp(projectId, "deploy");
  } catch (error) {
    // Unsure whether the queue took it: left deploying (it clears by itself if no job runs).
    if (!(error instanceof WpQueueUnsureError)) await ctx.db.update(wpPreview).set({ state: "failed", failureReason: "The deploy couldn't be queued." }).where(eq(wpPreview.projectId, projectId));
    throw error;
  }
  await recordActivity(ctx.db, {
    action: "site.wp_preview_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: done!.version, host, packageDomain },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* A package past the plan's limit: an admin confirms the new price once for this site. */
export async function confirmPackageLimit(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const name = (await ctx.db.select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1))[0];
  if (!name) throw new WpPreviewError("That project no longer exists.");
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (row) await ctx.db.update(wpPreview).set({ limitConfirmedBy: actor.id, updatedAt: new Date() }).where(eq(wpPreview.projectId, projectId));
  else
    await ctx.db.insert(wpPreview).values({
      projectId,
      name: await freeName(ctx.db, projectId, previewName(name.clientName, projectId)),
      dbPasswordEncrypted: encryptSecret(makePassword()),
      adminUser: makeAdminUser(),
      adminPasswordEncrypted: encryptSecret(makePassword()),
      state: "removed",
      limitConfirmedBy: actor.id,
    });
  await recordActivity(ctx.db, { action: "site.wp_limit_confirmed", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { limit: PACKAGE_LIMIT, plan: TWENTYI_NEXT_PLAN.name, monthly: TWENTYI_NEXT_PLAN.monthly }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function removeWpPreview(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (!row || row.state === "removed") throw new WpPreviewError("There's no WordPress preview to remove.");
  // B3: the same package is the live site: only an admin takes it down (a client who left; project deletion needs it gone first).
  if (row.liveState === "live" && !can(actor, "settings.manage")) throw new WpPreviewError("This WordPress site is live on the client's domain: only an admin can take it down (Hosting, Remove the site).");
  if (busy(row)) throw new WpPreviewError("The WordPress preview is already being worked on.");
  const certs = readCerts(row.certs);
  const steps = removeSteps({
    paidCertificate: [certs.live, certs.preview].some((c) => c?.source === "twentyi_paid" && c.paidId),
    previewRecord: Boolean(row.packageId && onPreviewDomain(row)),
  });
  // Only over the state this click read: of two clicks together, the second finds it removing (CodeRabbit, PR #7).
  const markedAt = new Date();
  const [marked] = await ctx.db
    .update(wpPreview)
    .set({ state: "removing", steps, failureReason: null, startedByUserId: actor.id, startedAt: markedAt, updatedAt: markedAt })
    .where(and(eq(wpPreview.projectId, projectId), eq(wpPreview.state, row.state)))
    .returning({ id: wpPreview.projectId });
  if (!marked) throw new WpPreviewError("The WordPress preview is already being worked on.");
  try {
    await queueWp(projectId, "remove");
  } catch (error) {
    if (error instanceof WpQueueUnsureError) throw error;
    // The queue didn't answer: the preview as it was, so Remove (and project deletion) aren't blocked for 75 minutes (13 October 2026); only while the mark is still this click's own.
    // The queue's message is the one shown, even if taking the mark back fails too (CodeRabbit, PR #7).
    await ctx.db
      .update(wpPreview)
      .set({ state: row.state, steps: row.steps, failureReason: row.failureReason, startedByUserId: row.startedByUserId, startedAt: row.startedAt, updatedAt: row.updatedAt })
      .where(and(eq(wpPreview.projectId, projectId), eq(wpPreview.updatedAt, markedAt)))
      .catch(() => undefined);
    throw error;
  }
  await recordActivity(ctx.db, {
    action: "site.wp_preview_remove_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueBefore: { host: row.host, packageId: row.packageId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/* "Check HTTPS" on the preview: the worker opens it as a browser would. */
export async function checkWpPreviewHttps(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (!row || row.state !== "ready") throw new WpPreviewError("Deploy the WordPress preview first.");
  await queueWp(projectId, "https");
}

/* "Get the certificate again" for the preview address (D1 option B). */
export async function requestPreviewCertificate(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (!row || row.state !== "ready" || !row.host || !onPreviewDomain(row)) throw new WpPreviewError("Only a preview on VML's preview domain has its own certificate.");
  const current = readCerts(row.certs).preview;
  // Only this certificate is written (the worker may be writing the live one meanwhile; Fable's code review, finding 9).
  await writeCert(ctx.db, projectId, "preview", { ...(current ?? { source: "letsencrypt", issuer: null, issuedAt: null, expiresAt: null }), host: row.host, state: "requested", note: null, requestedAt: new Date().toISOString() });
  await queueWp(projectId, "cert", { target: "preview" });
  await recordActivity(ctx.db, { action: "site.wp_cert_requested", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { host: row.host, preview: true }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* The WordPress login TAWD made: admins only, and every showing is logged. */
export async function showWpLogin(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ url: string; user: string; password: string }> {
  assertCan(actor, "settings.manage");
  const [row] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (!row || row.state === "removed" || !row.deployedVersion || !row.host) throw new WpPreviewError("There's no WordPress preview yet.");
  const host = row.liveState === "live" && row.liveDomain ? row.liveDomain : row.host;
  await recordActivity(ctx.db, {
    action: "site.wp_login_shown",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { host, user: row.adminUser },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { url: `https://${host}/wp-admin/`, user: row.adminUser, password: decryptSecret(row.adminPasswordEncrypted) };
}

/* Project deletion: a WordPress site still at its host is removed there first (Build page, Hosting). */
export async function wpPreviewStillOnHost(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db.select({ state: wpPreview.state }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  return Boolean(row && row.state !== "removed");
}

