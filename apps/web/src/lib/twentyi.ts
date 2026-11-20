import { desc, eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { appSetting, hostingAccountCheck, serviceHeartbeat, sshKey } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, SYSTEM_ACTOR, type Viewer } from "@tawd/core/permissions";
import { TWENTYI_CHECK_JOB, twentyiCheckJobId } from "@tawd/core/queue";
import { encryptSecret, hasEncryptionKey } from "@tawd/core/secrets";
import { makeSshKeyPair, readPinnedHostKeys, SSH_HOST_KEYS_SETTING, type PinnedHostKeys } from "@tawd/core/ssh-keys";
import {
  CERT_PATHS,
  DEFAULT_CERT_PATH,
  TWENTYI_KEY_PURPOSE,
  TWENTYI_PACKAGE_TYPE_SETTING,
  WP_CERT_PATH_SETTING,
  WP_SITES_DAILY_SETTING,
  isCertPath,
  previewDomainSetting,
  type AccountCheckResult,
  type CertPath,
  type PackageTypeChoice,
} from "@tawd/core/wp-preview";
import { getQueue } from "@/lib/mockups";
import { UNFINISHED_AFTER_MS } from "@/lib/wp-sites-daily";
import type { ServiceContext } from "@/lib/users";

/*
  Build B on 20i (5 October 2026; docs/plans/build-b-20i.md): System's 20i
  section. Admins only (settings.manage), each change logged. TAWD's own
  SSH key for 20i (made and encrypted here, read only by the worker; the
  page shows the public line and its fingerprint), "Check the 20i account"
  (a worker job: TWENTYI_API_KEY is on the worker only), the package type
  TAWD makes sites with, the HTTPS path for WordPress sites, the server
  keys TAWD has remembered, and when the daily work last ran.
*/

type Db = Database;

/** The worker's settings this section needs (names only; values never leave the container). */
const WORKER_SETTINGS = ["TWENTYI_API_KEY"] as const;
/** A check still queued or working after this long is taken as lost (the worker restarted). */
const LOST_AFTER_MS = 30 * 60 * 1000;
/** The daily work is late when it hasn't run for two days (amber on System). */
export const DAILY_LATE_MS = 2 * 86_400_000;

export class TwentyiSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwentyiSettingsError";
  }
}

/* Makes TAWD's key pair for 20i, or replaces it (each package gets the new key at its next deploy). */
export async function makeTwentyiKey(ctx: ServiceContext, actor: Viewer, replace: boolean): Promise<void> {
  assertCan(actor, "settings.manage");
  if (!hasEncryptionKey()) throw new TwentyiSettingsError("TAWD_ENCRYPTION_KEY isn't set on the web app, so the key can't be stored safely.");
  const [existing] = await ctx.db.select().from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
  if (existing && !replace) throw new TwentyiSettingsError("TAWD already has a 20i key. Use Replace the key to make a new one.");
  const pair = makeSshKeyPair("tawd-20i@velocitymedialab.com");
  const row = { publicKey: pair.publicKey, privateKeyEncrypted: encryptSecret(pair.privateKey), fingerprint: pair.fingerprint, createdByUserId: actor.id, createdAt: new Date() };
  await ctx.db.insert(sshKey).values({ purpose: TWENTYI_KEY_PURPOSE, ...row }).onConflictDoUpdate({ target: sshKey.purpose, set: row });
  await recordActivity(ctx.db, {
    action: "twentyi.key_made",
    entityType: "setting",
    entityId: TWENTYI_KEY_PURPOSE,
    ...actorFields(actor),
    // The fingerprints only: never a key.
    valueBefore: existing ? { fingerprint: existing.fingerprint } : undefined,
    valueAfter: { fingerprint: pair.fingerprint, replaced: Boolean(existing) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}

/*
  TAWD makes its own 20i key when there's none (Jason, 8 October 2026: the
  first WordPress deploy stopped on "an admin makes it on System"; no
  person needed). Logged as TAWD's own action. Returns whether it made one.
*/
export async function ensureTwentyiKey(db: Db): Promise<boolean> {
  if (!hasEncryptionKey()) return false;
  const [existing] = await db.select({ purpose: sshKey.purpose }).from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
  if (existing) return false;
  const pair = makeSshKeyPair("tawd-20i@velocitymedialab.com");
  const made = await db
    .insert(sshKey)
    .values({ purpose: TWENTYI_KEY_PURPOSE, publicKey: pair.publicKey, privateKeyEncrypted: encryptSecret(pair.privateKey), fingerprint: pair.fingerprint, createdByUserId: null, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ purpose: sshKey.purpose });
  if (made.length === 0) return false;
  await recordActivity(db, {
    action: "twentyi.key_made",
    entityType: "setting",
    entityId: TWENTYI_KEY_PURPOSE,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { fingerprint: pair.fingerprint, replaced: false, automatic: true },
    ipAddress: null,
    userAgent: null,
  });
  return true;
}

export async function startTwentyiCheck(ctx: ServiceContext, actor: Viewer): Promise<void> {
  assertCan(actor, "settings.manage");
  const [last] = await ctx.db.select().from(hostingAccountCheck).orderBy(desc(hostingAccountCheck.createdAt)).limit(1);
  if (last && (last.status === "queued" || last.status === "working") && Date.now() - last.createdAt.getTime() < LOST_AFTER_MS) throw new TwentyiSettingsError("The check is already running.");
  if (last && (last.status === "queued" || last.status === "working")) {
    await ctx.db.update(hostingAccountCheck).set({ status: "failed", failureReason: "The worker didn't finish this check (it may have restarted).", finishedAt: new Date() }).where(eq(hostingAccountCheck.id, last.id));
  }
  const [check] = await ctx.db.insert(hostingAccountCheck).values({ status: "queued", startedByUserId: actor.id }).returning({ id: hostingAccountCheck.id });
  try {
    await getQueue().add(TWENTYI_CHECK_JOB, { checkId: check!.id }, { jobId: twentyiCheckJobId(check!.id), attempts: 1 });
  } catch {
    await ctx.db.delete(hostingAccountCheck).where(eq(hostingAccountCheck.id, check!.id));
    throw new TwentyiSettingsError("The check couldn't be queued: the job queue isn't answering. Try again in a minute.");
  }
  await recordActivity(ctx.db, { action: "twentyi.check_started", entityType: "setting", entityId: "twentyi", ...actorFields(actor), ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

async function lastCheck(db: Db) {
  const [check] = await db.select().from(hostingAccountCheck).orderBy(desc(hostingAccountCheck.createdAt)).limit(1);
  return check ?? null;
}

/** The last finished check's results (what the deploy's blockers and the type list read). */
export async function lastDoneCheck(db: Db): Promise<AccountCheckResult | null> {
  const [check] = await db.select().from(hostingAccountCheck).where(eq(hostingAccountCheck.status, "done")).orderBy(desc(hostingAccountCheck.createdAt)).limit(1);
  return (check?.results as AccountCheckResult | null) ?? null;
}

/* The package type TAWD makes sites with: one the last check listed. */
export async function choosePackageType(ctx: ServiceContext, actor: Viewer, typeId: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const check = await lastDoneCheck(ctx.db);
  const type = check?.types.find((t) => t.id === typeId);
  if (!type) throw new TwentyiSettingsError("Choose one of the package types the last 20i check listed (check the account again if it's new).");
  const [before] = await ctx.db.select().from(appSetting).where(eq(appSetting.key, TWENTYI_PACKAGE_TYPE_SETTING)).limit(1);
  const value: PackageTypeChoice & { chosenAt: string } = { id: type.id, label: type.label, chosenAt: new Date().toISOString() };
  await ctx.db.insert(appSetting).values({ key: TWENTYI_PACKAGE_TYPE_SETTING, value, updatedByUserId: actor.id }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByUserId: actor.id, updatedAt: new Date() } });
  await recordActivity(ctx.db, { action: "twentyi.package_type_chosen", entityType: "setting", entityId: TWENTYI_PACKAGE_TYPE_SETTING, ...actorFields(actor), valueBefore: (before?.value as Record<string, unknown> | undefined) ?? undefined, valueAfter: value, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function certPathOf(db: Db): Promise<CertPath> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, WP_CERT_PATH_SETTING)).limit(1);
  const path = (row?.value as { path?: unknown } | undefined)?.path;
  return isCertPath(path) ? path : DEFAULT_CERT_PATH;
}

/* How WordPress sites get HTTPS (plan 3.4; decided on day one). */
export async function chooseCertPath(ctx: ServiceContext, actor: Viewer, path: string): Promise<void> {
  assertCan(actor, "settings.manage");
  if (!isCertPath(path)) throw new TwentyiSettingsError("Choose one of the three ways.");
  const before = await certPathOf(ctx.db);
  if (before === path) return;
  const value = { path, chosenAt: new Date().toISOString() };
  await ctx.db.insert(appSetting).values({ key: WP_CERT_PATH_SETTING, value, updatedByUserId: actor.id }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByUserId: actor.id, updatedAt: new Date() } });
  await recordActivity(ctx.db, { action: "twentyi.cert_path_chosen", entityType: "setting", entityId: WP_CERT_PATH_SETTING, ...actorFields(actor), valueBefore: { path: before }, valueAfter: { path }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* After a server really changed its key (20i says so): the next connection remembers the new one. */
export async function forgetServerKey(ctx: ServiceContext, actor: Viewer, host: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const [row] = await ctx.db.select().from(appSetting).where(eq(appSetting.key, SSH_HOST_KEYS_SETTING)).limit(1);
  const pins = readPinnedHostKeys(row?.value);
  const pin = pins[host];
  if (!pin) throw new TwentyiSettingsError("TAWD hasn't remembered a key for that server.");
  const rest: PinnedHostKeys = { ...pins };
  delete rest[host];
  await ctx.db.update(appSetting).set({ value: rest, updatedByUserId: actor.id, updatedAt: new Date() }).where(eq(appSetting.key, SSH_HOST_KEYS_SETTING));
  await recordActivity(ctx.db, { action: "ssh.host_key_forgotten", entityType: "setting", entityId: SSH_HOST_KEYS_SETTING, ...actorFields(actor), valueBefore: { host, ...pin }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export interface DailyRun {
  startedAt: string | null;
  finishedAt: string | null;
  summary: { sites?: number; ipChanged?: string[]; fixed?: string[]; renewed?: string[]; warned?: string[]; problems?: string[] } | null;
  late: boolean;
  /** The last run started over two hours ago and never finished (the worker stopped mid-run). */
  unfinished: boolean;
}

export async function loadDailyRun(db: Db, now = new Date()): Promise<DailyRun> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, WP_SITES_DAILY_SETTING)).limit(1);
  const v = (row?.value ?? {}) as { startedAt?: string; finishedAt?: string; summary?: DailyRun["summary"] };
  const last = v.finishedAt ? Date.parse(v.finishedAt) : NaN;
  const started = v.startedAt ? Date.parse(v.startedAt) : NaN;
  // Started over two hours ago with no finish after it: the last run didn't finish (Fable's code review, finding 6).
  const unfinished = Number.isFinite(started) && now.getTime() - started > UNFINISHED_AFTER_MS && (!Number.isFinite(last) || last < started);
  return { startedAt: v.startedAt ?? null, finishedAt: v.finishedAt ?? null, summary: v.summary ?? null, late: unfinished || !Number.isFinite(last) || now.getTime() - last > DAILY_LATE_MS, unfinished };
}

export async function loadTwentyi(db: Db) {
  const [key] = await db.select().from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
  const check = await lastCheck(db);
  const [type] = await db.select().from(appSetting).where(eq(appSetting.key, TWENTYI_PACKAGE_TYPE_SETTING)).limit(1);
  const [pins] = await db.select().from(appSetting).where(eq(appSetting.key, SSH_HOST_KEYS_SETTING)).limit(1);
  const [worker] = await db.select().from(serviceHeartbeat).where(eq(serviceHeartbeat.service, "worker")).limit(1);
  const env = (worker?.env ?? {}) as Record<string, boolean>;
  return {
    key: key ? { publicKey: key.publicKey, fingerprint: key.fingerprint, createdAt: key.createdAt, createdBy: key.createdByUserId } : null,
    check: check
      ? {
          id: check.id,
          status: check.status as "queued" | "working" | "done" | "failed",
          results: (check.results as AccountCheckResult | null) ?? null,
          failureReason: check.failureReason,
          createdAt: check.createdAt,
          finishedAt: check.finishedAt,
          startedBy: check.startedByUserId,
        }
      : null,
    packageType: (type?.value as (PackageTypeChoice & { chosenAt?: string }) | undefined) ?? null,
    certPath: await certPathOf(db),
    certPaths: CERT_PATHS,
    serverKeys: Object.entries(readPinnedHostKeys(pins?.value)).map(([host, pin]) => ({ host, ...pin })),
    previewDomain: previewDomainSetting(),
    daily: await loadDailyRun(db),
    /** The worker's settings as it last reported them (names only); null when the worker hasn't reported. */
    workerSettings: worker
      ? {
          missing: WORKER_SETTINGS.filter((name) => !env[name]),
          previewDomain: Boolean(env.WP_PREVIEW_DOMAIN),
          cloudflare: Boolean(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
          acmeStaging: Boolean(env.TWENTYI_ACME_STAGING),
        }
      : null,
  };
}

export type TwentyiView = Awaited<ReturnType<typeof loadTwentyi>>;
