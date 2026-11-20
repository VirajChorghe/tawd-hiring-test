import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { pagePlanPage, siteBuild, wpPreview } from "@tawd/core/schema";
import { getStorage, projectStoragePrefix } from "./intake/storage";
import type { CommandOutput } from "./ssh-keys";
import { pagePath } from "./site/build";
import { themeSlug } from "./site/wordpress";
import type { WpPackageInput } from "./site/wp-package";

/*
  Build B, B2 (1 October 2026): a project's WordPress preview; on 20i since
  5 October 2026 (docs/plans/build-b-20i.md). The names, the pinned
  versions, the steps and every command the worker runs over SSH. Each
  command is built here from fixed text and values TAWD made itself (the
  preview's name, random passwords) or 20i answered and TAWD checked
  against a strict pattern, each quoted for the shell; a client's words
  never reach the server's shell (they travel inside the package, read by
  install.php). 20i's own calls are in apps/worker/src/twentyi.ts.
*/

/** The WordPress the package was tried on (WordPress Playground, 1 October 2026). */
export const WP_CORE_VERSION = "7.1.2";

/** The PHP every package is set to (WordPress 7.1.2 was tried on it). */
export const WP_PHP_VERSION = "8.3";

/** The plugins every Build B site gets, pinned (Jason's decisions, 28 September 2026). */
export const WP_PLUGINS = [
  { slug: "contact-form-7", version: "6.1.7", name: "Contact Form 7" },
  { slug: "seo-by-rank-math", version: "1.0.279", name: "Rank Math" },
  { slug: "malcare-security", version: "6.76", name: "MalCare" },
] as const;

/*
  Gravity Forms (the project's choice, 1 October 2026) isn't on WordPress.org:
  its official command-line add-on (which is) installs it with VML's licence
  key, from the worker's GRAVITY_FORMS_LICENSE_KEY.
*/
export const GF_CLI = { slug: "gravityformscli", version: "1.9.1", name: "Gravity Forms CLI" } as const;

/** The plugins a site gets, by its form plugin. */
export const pluginsFor = (formPlugin: string) => (formPlugin === "gravityforms" ? WP_PLUGINS.filter((p) => p.slug !== "contact-form-7") : [...WP_PLUGINS]);

/** The login every site had before 13 October 2026; a site installed with it keeps it (WordPress can't rename a login). */
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a login name, not a secret; each site's password is random
export const LEGACY_WP_ADMIN_USER = "tawd-vml";

/** Each new site's own WordPress login name (13 October 2026): random, so knowing one site's login says nothing about another's. */
export const makeAdminUser = () => `tawd-${randomBytes(6).toString("hex")}`;

/** A login name TAWD made: safe to put in a command (it is quoted too). */
export const isAdminUser = (user: string) => user === LEGACY_WP_ADMIN_USER || /^tawd-[0-9a-f]{12}$/.test(user);

/* ---------- 20i: settings, limits, names ---------- */

/*
  Decision D1 (plan, 3.4b): with WP_PREVIEW_DOMAIN set (web and worker), a
  preview is <name>.<that domain> on 20i's real servers with TAWD's own
  certificate, and the speed gate measures it. Without it, the preview is
  20i's staging address (slower servers, so the gate can't measure it).

  The package's main name. From 8 October 2026 the package was named after
  the client's own domain and the preview address added as an extra name;
  on 2 November 2026 20i said a subdomain under another domain's package
  "can cause issues" and must sit on its own package. Since 0.119.0 (option 1,
  docs/plans/previews-own-package-20i.md; 20i confirmed on 3 November that the
  Reseller API makes a package whose domain is <name>.<preview domain> while
  the preview domain's own placeholder package is in the account) a new
  preview's package is named after the preview address itself. The client's
  domain and www are added to that package at go-live, as before. Without the
  preview domain setting, the package is still named after the client's
  domain and the preview is 20i's staging address.
*/

const HOST = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The preview domain from the setting; null when it's unset (option A) or not a domain. */
export function previewDomainSetting(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.WP_PREVIEW_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") ?? "";
  return value && HOST.test(value) ? value : null;
}

/** The preview's address under the preview domain: <name>.<preview domain>. */
export function previewHostFor(name: string, previewDomain: string): string {
  if (!NAME.test(name)) throw new Error(`Not a preview name TAWD makes: "${name}"`);
  return `${name}.${previewDomain}`;
}

/**
  The package's main name: the first of the client's domains (the confirmed go-live domain, the intake's domain, the current
  site's address) that is a plain domain, without "www." and never under the preview domain. Null when there is none.
*/
export function packageDomainFrom(candidates: (string | null | undefined)[], previewDomain: string | null): string | null {
  for (const candidate of candidates) {
    const host = (candidate ?? "")
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/?#:].*$/, "")
      .replace(/\.+$/, "")
      .replace(/^www\./, "");
    if (!HOST.test(host) || isStagingHost(host)) continue;
    if (previewDomain && (host === previewDomain || host.endsWith(`.${previewDomain}`))) continue;
    return host;
  }
  return null;
}

/**
  The preview runs at its own address under the preview domain, not at 20i's: its own package's name (0.119.0), or an extra name
  on a package named after the client's domain (previews made before 0.119.0). A row from Bluehost has no package name.
*/
export const onPreviewDomain = (row: { host: string | null; packageDomain: string | null }) => Boolean(row.host && row.packageDomain && !isStagingHost(row.host));

/** The package is named after the preview address itself (option 1, 0.119.0), not after the client's domain. */
export const packageOnPreviewName = (row: { name: string; packageDomain: string | null }, previewDomain: string | null): boolean => {
  if (!previewDomain || !row.packageDomain) return false;
  try {
    return row.packageDomain === previewHostFor(row.name, previewDomain);
  } catch {
    return false;
  }
};

/** 20i's own staging addresses (reduced-capacity servers; the speed gate can't measure them). */
export const isStagingHost = (host: string | null | undefined) => Boolean(host && /\.stackstaging\.com$/i.test(host));

/*
  Previews on the preview domain at 20i (12 October 2026; docs/plans/tawdpreviews-in-20i.md). 20i adds <name>.<preview domain> to a
  client's package only once the account holds a package for the preview domain itself ("first add and finish setting up its root
  domain"). TAWD makes that placeholder package the first time a preview needs it (one of the plan's slots; the domain's DNS stays
  on Cloudflare) and never suspends, removes or switches it off, bar the one check below.
*/
export const PREVIEW_HOLDER_LABEL = "TAWD preview domain: keep (never suspend or delete)";
/** app_setting: the placeholder's package id, the switch-off check in progress, and its result. */
export const PREVIEW_HOLDER_SETTING = "wp_preview_holder";

/** The switch-off check's steps, saved before each one so a restarted worker always switches the placeholder back on. */
export type HolderTestPhase = "switching_off" | "watching" | "switching_on";

export interface PreviewHolderState {
  packageId?: string;
  /** The check in progress. */
  test?: { phase: HolderTestPhase; projectId: string; host: string; startedAt: string; phaseAt: string; seq: number; dependsOn?: boolean; reason?: string | null };
  /** The check's answer: whether previews go down when the placeholder is off. */
  result?: { at: string; previewsDependOnIt: boolean | null; note: string };
  /**
    The hourly watch (0.122.0): since when the placeholder has been found off or missing, and the last alert about it; when TAWD last
    asked 20i to switch it on (20i can take up to an hour to show it); since when 20i hasn't answered, and whether that was said.
  */
  watch?: { offSince: string | null; lastAlertAt: string | null; askedOnAt?: string | null; unansweredSince?: string | null; unansweredAlerted?: boolean };
  /** The preview domain's registration, read once a day (0.122.0). */
  domain?: { checkedAt: string; expiresAt: string | null; alerted: number[]; lastDailyAlert?: string | null; unreadSince: string | null; unreadAlerted: boolean };
}

/*
  The preview domain's watch (0.122.0, Jason 3 November 2026). Previews and live WordPress sites made since 0.119.0 sit on subdomain
  packages of the preview domain, so the placeholder package and the domain itself must never lapse.
*/
/** While the placeholder stays off, the team is told again once a day. */
export const HOLDER_ALERT_EVERY_MS = 24 * 3_600_000;
/** The domain's registration is read at most this often. */
export const DOMAIN_CHECK_EVERY_MS = 20 * 3_600_000;
/** Days before the domain's expiry when the team is told (each once per expiry date); from the last one, every day. */
export const DOMAIN_WARN_DAYS = [30, 14, 7, 3, 1] as const;
/** RDAP not answering for this long is said once (it may be RDAP, or the domain may be gone). */
export const DOMAIN_UNREAD_ALERT_MS = 72 * 3_600_000;
/** 20i's API not answering the watch for this long is said once (a revoked key, or a stale approved-address list after a server move). */
export const TWENTYI_SILENT_ALERT_MS = 24 * 3_600_000;
/** After asking 20i to switch the placeholder on, the watch waits this long before asking again (20i can take up to an hour to show it). */
export const HOLDER_ASK_AGAIN_MS = 60 * 60_000;
/**
  The old switch-off check (before 0.119.0) takes about 2.5 hours at most (HOLDER_SWITCH_WAIT_MS twice and HOLDER_WATCH_MS). One that
  started longer ago than this has stopped: the hourly watch takes the placeholder back.
*/
export const HOLDER_TEST_MAX_MS = 4 * 3_600_000;

/** Whether the team is told now about a placeholder found off: the first time, then once a day while it stays off. */
export function holderAlertDue(watch: PreviewHolderState["watch"], now: Date): boolean {
  if (!watch?.offSince || !watch.lastAlertAt) return true;
  return now.getTime() - Date.parse(watch.lastAlertAt) >= HOLDER_ALERT_EVERY_MS;
}

/** Whole days until the domain's expiry (0 on the day, negative after). */
export const daysUntil = (expiresAt: Date, now: Date) => Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);

/** Which warning is due, if any: the smallest threshold reached and not yet said for this expiry date (from one day out, the caller says it daily). */
export function domainWarningDue(daysLeft: number, alerted: readonly number[]): number | null {
  const reached = DOMAIN_WARN_DAYS.filter((d) => daysLeft <= d);
  if (!reached.length) return null;
  const smallest = Math.min(...reached);
  return alerted.includes(smallest) ? null : smallest;
}

/** A gzipped database dump smaller than this is empty: gzip of nothing is about 20 bytes, and WordPress's smallest dump is kilobytes. */
export const MIN_SQL_BACKUP_BYTES = 200;

/** How often a moved preview is opened, and for how long, before TAWD moves it back (20i can take up to 30 minutes to show a certificate). */
export const MOVE_CHECK_EVERY_MS = 5 * 60_000;
export const MOVE_CHECK_TRIES = 12;
/**
 * After a move whose certificate failed, the check gets it again by itself at these tries (minutes 5, 30 and 55): with the
 * deploy's own try, four in the hour, under Let's Encrypt's five failed checks an hour (14 October 2026, sacplumbingexperts.com's
 * move: a 401 right after 20i took the new name; CodeRabbit, PR #12, counted the deploy's). A certificate TAWD has just installed
 * gets up to this many more tries (30 minutes) to show, and only while it is within CERT_SHOW_MS of being installed.
 */
export const MOVE_CERT_TRIES = [1, 6, 11];
export const MOVE_CHECK_EXTRA_TRIES = 6;
/** How long 20i can take to show a certificate TAWD installed (it says up to 30 minutes), with a few minutes' margin. */
export const CERT_SHOW_MS = 35 * 60_000;
/** The switch-off check: how often it looks, how long 20i gets for each switch, and how long the preview is watched while off. */
export const HOLDER_TEST_EVERY_MS = 5 * 60_000;
export const HOLDER_SWITCH_WAIT_MS = 60 * 60_000;
export const HOLDER_WATCH_MS = 30 * 60_000;
/** A check in progress with nothing heard for this long was interrupted (a restart): the placeholder is switched back on. */
export const HOLDER_TEST_LOST_MS = 30 * 60_000;

/**
  Where a preview on 20i's staging address moves to on Deploy again: <name>.<preview domain>, once the preview domain is set. Never a
  live site (its WordPress address is the client's domain) and never a preview not yet made at 20i. Since 0.119.0 only a package
  named after that address moves (one that fell back to 20i's address): adding the address to a package named after the client's
  domain is what 20i said causes issues (2 November 2026), so such a preview stays where it is until it is removed and deployed again.
*/
export function moveTarget(row: { host: string | null; name: string; packageId: string | null; packageDomain: string | null; liveState: string | null }, previewDomain: string | null): string | null {
  if (!previewDomain || !row.packageId || row.liveState === "live" || !isStagingHost(row.host)) return null;
  if (!packageOnPreviewName(row, previewDomain)) return null;
  return row.packageDomain;
}

type LegacyRow = { host: string | null; name: string; packageId: string | null; packageDomain: string | null; liveState: string | null; domainOnHostAt?: Date | string | null };

const onLegacyStaging = (row: LegacyRow, previewDomain: string | null) => Boolean(previewDomain && row.packageId && isStagingHost(row.host) && !packageOnPreviewName(row, previewDomain));

/**
  A preview whose package is named after the client's domain, on 20i's address: it reaches the preview domain only by Remove, then
  Deploy again. Never once the client's domain is on the package (or the site is live): removing it would leave the client's records
  pointing at nothing (hand review of PR #24).
*/
export function needsFreshPackage(row: LegacyRow, previewDomain: string | null): boolean {
  return onLegacyStaging(row, previewDomain) && row.liveState == null && !row.domainOnHostAt;
}

/** The same kind of preview, but the client's domain is already on its package: it stays where it is (see needsFreshPackage). */
export function keepsLegacyPackage(row: LegacyRow, previewDomain: string | null): boolean {
  return onLegacyStaging(row, previewDomain) && !needsFreshPackage(row, previewDomain);
}

/** A page that is a WordPress site (its theme's or WordPress's own files), not a holding page. */
export const looksLikeWordPress = (html: string) => /\/wp-(content|includes)\/|\/wp-json\//i.test(html);

/** WP-CLI's db search output (--table_column_once --matches_only): each "table:column" with how many matches under it. */
export function parseDbSearch(output: string): { table: string; column: string; count: number }[] {
  const found: { table: string; column: string; count: number }[] = [];
  for (const line of output.split("\n").map((l) => l.trim())) {
    if (!line || /^(Success|Warning|Error):/i.test(line)) continue;
    const header = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(line);
    if (header) found.push({ table: header[1]!, column: header[2]!, count: 0 });
    else if (found.length) found[found.length - 1]!.count += 1;
  }
  return found.filter((f) => f.count > 0);
}

/** What's left pointing at an old address, the guid column aside (WordPress keeps a post's first address there on purpose). */
export const leftovers = (found: { table: string; column: string; count: number }[]) => found.filter((f) => f.column !== "guid");

import { TWENTYI_NEXT_PLAN, TWENTYI_PLAN } from "./twentyi-plan";
export { TWENTYI_NEXT_PLAN, TWENTYI_PLAN } from "./twentyi-plan";
export const PACKAGE_LIMIT = TWENTYI_PLAN.limit;
export const PACKAGE_WARN_AT = PACKAGE_LIMIT - 5;
/** "Reseller 50 ($39.99 a month)", for every screen and message that asks an admin to confirm. */
export const nextPlanWords = () => `${TWENTYI_NEXT_PLAN.name} ($${TWENTYI_NEXT_PLAN.monthly} a month)`;
/** 20i's own certificate, per site and year (20i's sales chat, 5 October 2026; check My20i). */
export const PAID_CERT_PRICE = 34.99;

/** app_setting keys. */
export const TWENTYI_PACKAGE_TYPE_SETTING = "twentyi_package_type";
export const WP_CERT_PATH_SETTING = "wp_cert_path";
export const ACME_ACCOUNT_SETTING = "acme_account";
export const WP_SITES_DAILY_SETTING = "wp_sites_daily";
export const TWENTYI_KEY_PURPOSE = "twentyi";

/** The package type TAWD makes sites with (20i's API has no data-centre choice: the account's own, the US). */
export interface PackageTypeChoice {
  id: string;
  label: string;
}

/* ---------- HTTPS (plan, 3.4: three paths, decided on day one) ---------- */

export type CertPath = "letsencrypt" | "twentyi_paid" | "manual";

export const CERT_PATHS: { id: CertPath; label: string; detail: string }[] = [
  { id: "letsencrypt", label: "TAWD's own certificate (Let's Encrypt, free)", detail: "TAWD issues it, installs it at 20i by API (20i's external certificate install) and renews it. Recommended." },
  { id: "twentyi_paid", label: `20i's certificate ($${PAID_CERT_PRICE} a year per site)`, detail: "An admin confirms each one with its price; TAWD orders it by API (RapidSSL). 20i's API can't cancel it: an admin does that in My20i. Previews use one installed by hand." },
  { id: "manual", label: "Installed by hand in My20i", detail: "Jason installs a certificate in 20i's panel (SSL/TLS); TAWD's Check HTTPS confirms it." },
];

export const isCertPath = (value: unknown): value is CertPath => value === "letsencrypt" || value === "twentyi_paid" || value === "manual";

/** The path when nobody has chosen yet: by hand (nothing is called or bought). */
export const DEFAULT_CERT_PATH: CertPath = "manual";

export interface WpCert {
  /** requested: queued; installing: handed to 20i (or waiting for a hand install); ok: Check HTTPS saw it; failed: why in note. */
  state: "requested" | "installing" | "ok" | "failed";
  source: CertPath;
  host: string;
  issuer: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  /** 20i's paid certificate: its id, the price it answered and when it renews. */
  paidId?: string | null;
  paidPrice?: number | null;
  renewsAt?: string | null;
  /** The admin who confirmed buying 20i's certificate. */
  confirmedBy?: string | null;
  /** Expiry warnings already sent (14, 7). */
  warned?: number[];
  /** When it was asked for (state requested): a request older than CERT_REQUEST_LOST_MS is taken as lost. */
  requestedAt?: string | null;
  /** When TAWD handed its own (Let's Encrypt) certificate to 20i: no second one for the same names within CERT_REISSUE_AFTER_MS. */
  installedAt?: string | null;
}

export interface WpCerts {
  preview?: WpCert;
  live?: WpCert;
}

export const readCerts = (value: unknown): WpCerts => (value && typeof value === "object" ? (value as WpCerts) : {});

/*
  One certificate written on its own (Fable's code review, finding 9): the
  web (a PM's "Get the certificate") and the worker (a deploy, the daily
  work) can write the same row at once, so neither writes the whole certs
  object from a copy it read earlier. Null removes that one.
*/
export async function writeCert(db: Database, projectId: string, which: keyof WpCerts, cert: WpCert | null): Promise<void> {
  const value = cert ? sql`coalesce(${wpPreview.certs}, '{}'::jsonb) || jsonb_build_object(${which}::text, ${JSON.stringify(cert)}::jsonb)` : sql`coalesce(${wpPreview.certs}, '{}'::jsonb) - ${which}::text`;
  await db.update(wpPreview).set({ certs: value, updatedAt: new Date() }).where(eq(wpPreview.projectId, projectId));
}

/** A certificate job still "requested" after this long is taken as lost (the worker restarted mid-job): Try again shows (Fable's code review, finding 3). */
export const CERT_REQUEST_LOST_MS = 30 * 60_000;
/**
  TAWD's own certificate isn't issued again for the same names within this
  long of handing one to 20i (20i can take up to 30 minutes to serve it, and
  Let's Encrypt allows 5 duplicates a week; findings 8 and 14). After it,
  one still not served can be asked for again.
*/
export const CERT_REISSUE_AFTER_MS = 2 * 3_600_000;

const ageMs = (at: string | null | undefined, now: Date) => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? now.getTime() - t : null;
};

/** A request nobody finished: requested, and older than CERT_REQUEST_LOST_MS (or with no time at all). */
export function certRequestLost(cert: WpCert | undefined, now = new Date()): boolean {
  if (cert?.state !== "requested") return false;
  const age = ageMs(cert.requestedAt, now);
  return age === null || age > CERT_REQUEST_LOST_MS;
}

/** TAWD's own certificate went to 20i less than CERT_REISSUE_AFTER_MS ago: don't issue another yet. Answers the minutes since, or null. */
export function recentlyInstalled(cert: WpCert | undefined, now = new Date()): number | null {
  if (!cert || cert.source !== "letsencrypt") return null;
  const age = ageMs(cert.installedAt, now);
  return age !== null && age < CERT_REISSUE_AFTER_MS ? Math.max(0, Math.round(age / 60_000)) : null;
}

/** The card offers Try again / Get the certificate again: a lost request, or TAWD's own certificate still not served long after it was installed. */
export function certRetryDue(cert: WpCert | undefined, now = new Date()): boolean {
  if (certRequestLost(cert, now)) return true;
  if (cert?.state !== "installing" || cert.source !== "letsencrypt") return false;
  const age = ageMs(cert.installedAt ?? cert.issuedAt, now);
  return age !== null && age >= CERT_REISSUE_AFTER_MS;
}

/** A Let's Encrypt certificate is renewed with a third of its life left (64 days from 2027, 45 from 2028). */
export function renewalDue(cert: WpCert | undefined, now = new Date()): boolean {
  if (!cert || cert.source !== "letsencrypt" || !cert.issuedAt || !cert.expiresAt) return false;
  if (cert.state !== "ok" && cert.state !== "installing") return false;
  const issued = Date.parse(cert.issuedAt);
  const expires = Date.parse(cert.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return false;
  return expires - now.getTime() < (expires - issued) / 3;
}

/** The warning due now (14 or 7 days left) that hasn't been sent; null when none. */
export function expiryWarningDue(cert: WpCert | undefined, now = new Date()): 14 | 7 | null {
  if (!cert?.expiresAt) return null;
  const days = (Date.parse(cert.expiresAt) - now.getTime()) / 86_400_000;
  if (!Number.isFinite(days)) return null;
  const sent = cert.warned ?? [];
  if (days <= 7 && !sent.includes(7)) return 7;
  if (days <= 14 && days > 7 && !sent.includes(14)) return 14;
  return null;
}

/* ---------- the steps ---------- */

export type PreviewStepKey = "hosting" | "preview_record" | "database" | "ssh" | "cert" | "wordpress" | "plugins" | "package" | "cache";
export type RemoveStepKey = "remove_certificate" | "remove_record" | "remove_package";
export type LiveStepKey = "https" | "backup" | "address" | "search" | "cache" | "check" | "restore";
export type StepState = "waiting" | "working" | "done" | "failed" | "warn";

export interface PreviewStep {
  key: PreviewStepKey | RemoveStepKey | LiveStepKey;
  label: string;
  state: StepState;
  detail: string | null;
}

export const DEPLOY_STEPS: { key: PreviewStepKey; label: string }[] = [
  { key: "hosting", label: "The hosting package at 20i" },
  { key: "preview_record", label: "The preview address (DNS)" },
  { key: "database", label: "The database" },
  { key: "ssh", label: "TAWD's access (SSH)" },
  { key: "cert", label: "HTTPS for the preview address" },
  { key: "wordpress", label: `WordPress ${WP_CORE_VERSION}` },
  { key: "plugins", label: "Contact Form 7, Rank Math and MalCare" },
  { key: "package", label: "The site: theme, pages, forms and pictures" },
  { key: "cache", label: "20i's cache cleared" },
];

export const REMOVE_STEPS: { key: RemoveStepKey; label: string }[] = [
  { key: "remove_certificate", label: "20i's certificate (cancelled in My20i)" },
  { key: "remove_record", label: "The preview address (DNS)" },
  { key: "remove_package", label: "The hosting package (files and database)" },
];

export const freshSteps = (steps: { key: PreviewStep["key"]; label: string }[]): PreviewStep[] => steps.map((s) => ({ ...s, state: "waiting", detail: null }));

/*
  The deploy's steps: the preview domain's record and certificate only with
  one (D1, option B); the plugins step named for the site's form plugin.
*/
export const deploySteps = (formPlugin: string, onPreviewDomain: boolean, live = false): PreviewStep[] =>
  freshSteps([
    // The live site is backed up before anything on it changes, so any later step can be rolled back (Fable's code review, finding 5).
    ...(live ? [DEPLOY_BACKUP_STEP] : []),
    ...DEPLOY_STEPS.filter((s) => onPreviewDomain || (s.key !== "preview_record" && s.key !== "cert")),
  ]).map((s) => (s.key === "plugins" && formPlugin === "gravityforms" ? { ...s, label: "Gravity Forms, Rank Math and MalCare" } : s));

/** The first step of a deploy to the live site. */
export const DEPLOY_BACKUP_STEP: { key: LiveStepKey; label: string } = { key: "backup", label: "A backup of the live site (kept in TAWD's storage)" };

/* The removal's steps: a paid certificate and a preview record only when there is one. */
export const removeSteps = (opts: { paidCertificate: boolean; previewRecord: boolean }): PreviewStep[] =>
  freshSteps(REMOVE_STEPS.filter((s) => (s.key !== "remove_certificate" || opts.paidCertificate) && (s.key !== "remove_record" || opts.previewRecord)));

/* "Sample Husky Site" → "sample-husky-site"; a project id's start when the name has no letters. */
export function previewName(clientName: string, projectId: string): string {
  const name = themeSlug(clientName).replace(/^tawd-/, "").slice(0, 30).replace(/-+$/, "");
  return name && name !== "client" ? name : `site-${projectId.slice(0, 8).toLowerCase()}`;
}

/** The database name TAWD asks 20i for ("tawd" and 8 characters of the project id); 20i may add to it. */
export function databaseNameFor(projectId: string): string {
  const id = projectId.replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("Not a project id.");
  return `tawd${id}`;
}

/** A random password with no character the shell reads specially. */
export const makePassword = (bytes = 18) => randomBytes(bytes).toString("base64url");

/* A value as one shell word: inside single quotes, a quote closed, escaped and reopened. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where WordPress is on a package: the preview's name and its web root (from the package's home folder). */
export interface WpTarget {
  name: string;
  dir: string;
  /** How WP-CLI is started when the server's plain `php` is too old (from `pickPhp`); "wp" otherwise. */
  wp?: string | null;
}

/*
  PHP on the command line (8 October 2026, the first real deploy): 20i's
  SSH runs an older PHP than the site's own (set to WP_PHP_VERSION by API),
  and WordPress refused to switch to TAWD's theme ("Current PHP version does
  not meet minimum requirements"). TAWD lists the PHP versions the server
  has and starts WP-CLI with the newest one that meets the theme's need.
*/
export const WP_CLI_MIN_PHP = "8.1";

const PHP_CANDIDATES = [
  "php",
  "php8.4", "php84", "php8.3", "php83", "php8.2", "php82", "php8.1", "php81",
  "/usr/bin/php8.4", "/usr/bin/php8.3", "/usr/bin/php8.2", "/usr/bin/php8.1",
  "/usr/local/bin/php84", "/usr/local/bin/php83", "/usr/local/bin/php82", "/usr/local/bin/php81",
  "/usr/local/php*/bin/php", "/opt/php*/bin/php", "/opt/alt/php*/usr/bin/php", "/opt/cpanel/ea-php*/root/usr/bin/php",
];

/** Lists "php <path> <version>" for each PHP found, then "wp <path> <first line>". Reads only. */
export const phpProbe = () =>
  `for b in ${PHP_CANDIDATES.join(" ")}; do p=$(command -v "$b" 2>/dev/null) || continue; v=$("$p" -r 'echo PHP_VERSION;' 2>/dev/null) || continue; echo "php $p $v"; done; w=$(command -v wp 2>/dev/null) && echo "wp $w $(head -n 1 "$w" | tr -d '\\r')"`;

const versionParts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
const atLeast = (v: string, min: string) => {
  const [a = 0, b = 0] = versionParts(v);
  const [x = 0, y = 0] = versionParts(min);
  return a > x || (a === x && b >= y);
};

export interface PhpChoice {
  /** The WP-CLI start to use: null for plain `wp` (the default PHP is new enough). */
  wp: string | null;
  /** The PHP WP-CLI will run on, or null when none is new enough. */
  chosen: { path: string; version: string } | null;
  found: { path: string; version: string }[];
}

/** The newest PHP at or over the minimum; plain `wp` when the default `php` is already new enough. */
export function pickPhp(output: string, min = WP_CLI_MIN_PHP): PhpChoice {
  const found: { path: string; version: string }[] = [];
  let wpLine: { path: string; first: string } | null = null;
  for (const line of output.split("\n").map((l) => l.trim())) {
    const php = /^php (\S+) (\d+\.\d+\.\d+\S*)$/.exec(line);
    if (php && !found.some((f) => f.path === php[1])) found.push({ path: php[1]!, version: php[2]! });
    const wp = /^wp (\S+) ?(.*)$/.exec(line);
    if (wp) wpLine = { path: wp[1]!, first: wp[2] ?? "" };
  }
  const plain = found[0];
  if (plain && atLeast(plain.version, min)) return { wp: null, chosen: plain, found };
  const best = found.filter((f) => atLeast(f.version, min)).sort((a, b) => (atLeast(a.version, b.version) ? -1 : 1))[0];
  if (!best) return { wp: null, chosen: null, found };
  // A phar (its first line names php) runs under any PHP; a shell launcher reads WP_CLI_PHP.
  const wp = wpLine && /php/.test(wpLine.first) ? `${shq(best.path)} ${shq(wpLine.path)}` : `WP_CLI_PHP=${shq(best.path)} wp`;
  return { wp, chosen: best, found };
}

/** The web root as 20i answers or TAWD finds it: a plain folder path under the home folder. */
export const isWebRoot = (dir: string) => /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(dir) && !dir.split("/").some((part) => part === ".." || part === ".");

/** The database settings wp-config.php gets (20i's names and host). */
export interface WpDatabase {
  dbName: string;
  dbUser: string;
  dbHost: string;
}

/* WP-CLI on the site's own WordPress ("$HOME" left for the shell, the folder quoted). */
const wpArgs = (t: WpTarget, args: string) => `${t.wp ?? "wp"} ${args} --path="$HOME"/${shq(t.dir)}`;
const wp = (t: WpTarget, args: string) => `${wpArgs(t, args)} 2>&1`;

/* Every command, by name. */
export const commands = {
  hasWebRoot: (t: WpTarget) => `test -d "$HOME"/${shq(t.dir)} && echo yes || echo no`,
  makeWebRoot: (t: WpTarget) => `mkdir -p "$HOME"/${shq(t.dir)} && echo yes || echo no`,
  homeFolder: () => `ls -1A "$HOME" 2>&1 | head -30`,
  hasWordPress: (t: WpTarget) => `test -f "$HOME"/${shq(t.dir)}/wp-load.php && echo yes || echo no`,
  download: (t: WpTarget) => wp(t, `core download --version=${WP_CORE_VERSION} --skip-content --locale=en_US --force`),
  hasConfig: (t: WpTarget) => `test -f "$HOME"/${shq(t.dir)}/wp-config.php && echo yes || echo no`,
  config: (t: WpTarget, d: WpDatabase, password: string) =>
    wp(t, `config create --dbname=${shq(d.dbName)} --dbuser=${shq(d.dbUser)} --dbpass=${shq(password)} --dbhost=${shq(d.dbHost)} --skip-check --force`),
  // An existing wp-config.php gets 20i's database names and host (a redeploy after the database was made again).
  dbSettings: (t: WpTarget, d: WpDatabase, password: string) => [
    wp(t, `config set DB_NAME ${shq(d.dbName)}`),
    wp(t, `config set DB_USER ${shq(d.dbUser)}`),
    wp(t, `config set DB_PASSWORD ${shq(password)}`),
    wp(t, `config set DB_HOST ${shq(d.dbHost)}`),
  ],
  // Nobody edits theme or plugin files from WordPress's own screens (VML edits in TAWD); security updates stay automatic.
  hardening: (t: WpTarget) => [wp(t, "config set DISALLOW_FILE_EDIT true --raw"), wp(t, "config set WP_AUTO_UPDATE_CORE minor")],
  isInstalled: (t: WpTarget) => `${wp(t, "core is-installed")} && echo yes || echo no`,
  install: (t: WpTarget, url: string, title: string, adminEmail: string, user: string, password: string) =>
    wp(t, `core install --url=${shq(url)} --title=${shq(title)} --admin_user=${shq(user)} --admin_password=${shq(password)} --admin_email=${shq(adminEmail)} --skip-email`),
  adminPassword: (t: WpTarget, user: string, password: string) => wp(t, `user update ${shq(user)} --user_pass=${shq(password)} --skip-email`),
  // The name shown on pages and in author links is never the login (13 October 2026).
  adminPublicName: (t: WpTarget, user: string) => wp(t, `user update ${shq(user)} --display_name='Website team' --user_nicename='website-team' --skip-email`),
  pluginVersion: (t: WpTarget, slug: string) => wp(t, `plugin get ${shq(slug)} --field=version`),
  installPlugin: (t: WpTarget, slug: string, version: string) => wp(t, `plugin install ${shq(slug)} --version=${shq(version)} --force --activate`),
  activatePlugin: (t: WpTarget, slug: string) => wp(t, `plugin activate ${shq(slug)}`),
  // The form plugin a site doesn't use is switched off (its files loaded on every page), never removed.
  deactivatePlugin: (t: WpTarget, slug: string) => wp(t, `plugin deactivate ${shq(slug)}`),
  // Gravity Forms with VML's licence, through its command-line add-on; the key also set for its updates.
  installGravityForms: (t: WpTarget, key: string) => [wp(t, `gf install --key=${shq(key)} --activate --force`), wp(t, `config set GF_LICENSE_KEY ${shq(key)}`)],
  packageDir: (t: WpTarget, version: number) => `tawd-packages/${t.name}-v${version}`,
  /* Unpacks the uploaded zip into its own folder (outside the web root), with unzip or, where there's none, PHP's own. */
  unpack: (t: WpTarget, version: number) => {
    const dir = commands.packageDir(t, version);
    return `cd "$HOME" && rm -rf ${shq(dir)} && mkdir -p ${shq(dir)} && cd ${shq(dir)} && { (command -v unzip >/dev/null && unzip -oq ../${shq(`${t.name}-v${version}.zip`)}) || php -r '$z=new ZipArchive; if ($z->open($argv[1]) !== true) { exit(1); } $z->extractTo("."); $z->close();' ../${shq(`${t.name}-v${version}.zip`)}; } 2>&1`;
  },
  runInstaller: (t: WpTarget, version: number) => {
    const dir = commands.packageDir(t, version);
    return `cd "$HOME"/${shq(dir)} && ${wp(t, `--exec=${shq(`define('TAWD_PACKAGE_DIR', getenv('HOME') . '/${dir}');`)} eval-file install.php`)}`;
  },
  cleanPackage: (t: WpTarget, version: number) => `cd "$HOME" && rm -rf ${shq(commands.packageDir(t, version))} ${shq(`tawd-packages/${t.name}-v${version}.zip`)} 2>&1`,

  /* ---------- B3: the live site (1 October 2026) ---------- */
  searchReplace: (t: WpTarget, from: string, to: string) => wp(t, `search-replace ${shq(from)} ${shq(to)} --all-tables --skip-columns=guid --precise`),
  setUrls: (t: WpTarget, url: string) => [wp(t, `option update home ${shq(url)}`), wp(t, `option update siteurl ${shq(url)}`)],
  homeUrl: (t: WpTarget) => wp(t, "option get home"),
  // 12 October 2026: what still holds an old address after a move (the check after search-replace).
  dbSearch: (t: WpTarget, text: string) => wp(t, `db search ${shq(text)} --all-tables --table_column_once --matches_only`),
  searchEngines: (t: WpTarget, allowed: boolean) => wp(t, `option update blog_public ${allowed ? 1 : 0}`),
  liveFormId: (t: WpTarget) => wp(t, `post list --post_type=wpcf7_contact_form --title=${shq("TAWD: contact")} --field=ID --posts_per_page=1`),
  // F2: where the theme sends form messages, and the project's key to sign them (wp-config.php, never in the package).
  relayOn: (t: WpTarget, url: string, secret: string) => [wp(t, `config set TAWD_FORMS_URL ${shq(url)}`), wp(t, `config set TAWD_FORMS_SECRET ${shq(secret)}`)],
  relayOff: (t: WpTarget) => [wp(t, "config delete TAWD_FORMS_URL"), wp(t, "config delete TAWD_FORMS_SECRET")],

  /* ---------- Backups to R2 (20i, 5 October 2026): streamed, never kept on the hosting ---------- */
  // stdout is the stream (gzip's), so nothing else may write to it; WP-CLI's messages go to stderr.
  dumpDatabase: (t: WpTarget) => `set -o pipefail; ${wpArgs(t, "db export -")} | gzip -c`,
  archiveFiles: (t: WpTarget) => `tar czf - -C "$HOME"/${shq(t.dir)} .`,
  /* Unpacks the files from stdin into a new folder, then swaps it in whole (the old folder kept until the new one is in place). */
  restoreFiles: (t: WpTarget) => {
    const d = shq(t.dir);
    const restoring = shq(`${t.dir}.restoring`);
    const old = shq(`${t.dir}.old`);
    return `cd "$HOME" && rm -rf ${restoring} ${old} && mkdir ${restoring} && tar xzf - -C ${restoring} && mv ${d} ${old} && mv ${restoring} ${d} && rm -rf ${old}`;
  },
  restoreDatabase: (t: WpTarget) => `set -o pipefail; gunzip -c | ${wpArgs(t, "db import -")}`,

  /* ---------- HTTPS: Let's Encrypt's challenge files (HTTP-01), in the web root ---------- */
  challengePath: (t: WpTarget, token: string) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("Not an ACME token.");
    return `${t.dir}/.well-known/acme-challenge/${token}`;
  },
  removeChallenge: (t: WpTarget, token: string) => `rm -f "$HOME"/${shq(commands.challengePath(t, token))} 2>&1`,
};

/* A command's output, shortened for a step's line. */
export const briefly = (out: CommandOutput) =>
  out.output
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .slice(0, 300);

/* ---------- the package's input, for the download and the deploy ---------- */

/*
  A finished build's files as Netlify serves them (TAWD's own pictures and
  sources stay behind) and the site plan's names, order and keywords.
  Null when the build isn't finished or its files are gone.
*/
export async function loadPackageInput(
  db: Database,
  projectId: string,
  version: number,
): Promise<Pick<WpPackageInput, "buildVersion" | "files" | "plan"> | null> {
  const [build] = await db
    .select({ status: siteBuild.status })
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.version, version)))
    .limit(1);
  if (!build || build.status !== "done") return null;
  const storage = getStorage();
  const prefix = `${projectStoragePrefix(projectId)}site/v${version}/`;
  const keys = (await storage.list(prefix)).filter((key) => !/\/(_shots|_source)\//.test(key.slice(prefix.length - 1)));
  if (keys.length === 0) return null;
  const files = new Map<string, Uint8Array>();
  for (const key of keys) {
    const body = await storage.get(key);
    if (body) files.set(key.slice(prefix.length), new Uint8Array(body));
  }
  const plan = await db.select().from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)).orderBy(asc(pagePlanPage.position));
  return { buildVersion: version, files, plan: plan.map((p) => ({ path: pagePath(p.slug), name: p.name, order: p.position, mainKeyword: p.mainKeyword })) };
}

/* ---------- B3: going live, and back ---------- */

export const GOLIVE_STEPS: { key: LiveStepKey; label: string }[] = [
  // Checked again first, before anything changes (Jason, 3 November 2026): WordPress moved to a domain without a working certificate would break the site.
  { key: "https", label: "An active HTTPS certificate on the client's domain (checked before anything changes)" },
  { key: "backup", label: "A backup of the site (database and files, kept in TAWD's storage)" },
  { key: "address", label: "The address" },
  { key: "search", label: "Search engines let in" },
  { key: "cache", label: "20i's cache cleared" },
  { key: "check", label: "The live site answers over HTTPS" },
];

export const ROLLBACK_STEPS: { key: LiveStepKey; label: string }[] = [
  // The site as it is now, first, so a Roll back can itself be undone (Fable's code review, finding 10).
  { key: "backup", label: "A backup of the site as it is now (Undo the roll back restores it)" },
  { key: "restore", label: "The site as it was before (database and files)" },
];

export const UNDO_ROLLBACK_STEPS: { key: LiveStepKey; label: string }[] = [{ key: "restore", label: "The site as it was before the Roll back (database and files)" }];

export interface SiteBackup {
  at: string;
  /** "golive" (before going live), "update" (before a later deploy to the live site) or "rollback" (before a Roll back, for Undo). */
  kind: "golive" | "update" | "rollback";
  version: number | null;
  stamp: string;
  /** R2 keys (20i, 5 October 2026); absent on Bluehost's old backups, which can't be restored any more. */
  sqlKey?: string;
  filesKey?: string;
  bytes?: number;
}

/** The backup Roll back restores: the newest one that isn't a Roll back's own (those are for Undo the roll back). */
export const rollbackTarget = (backups: SiteBackup[]): SiteBackup | null => backups.find((b) => b.kind !== "rollback") ?? null;

/** Undo the roll back: offered while the newest backup is the one taken just before a Roll back (nothing deployed since). */
export const undoTarget = (backups: SiteBackup[]): SiteBackup | null => (backups[0]?.kind === "rollback" ? backups[0] : null);

/** How many backups a site keeps (older ones are deleted from R2). */
export const BACKUPS_KEPT = 10;

/* A backup's name: the time, in letters and digits only ("20261001-153000"). */
export const backupStamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Where a backup's two files go in R2: under the project's own prefix, so project deletion removes them. */
export function backupKeys(projectId: string, stamp: string): { sqlKey: string; filesKey: string } {
  if (!/^\d{8}-\d{6}$/.test(stamp)) throw new Error("Not a backup stamp.");
  const base = `${projectStoragePrefix(projectId)}wp-backups/${stamp}/`;
  return { sqlKey: `${base}db.sql.gz`, filesKey: `${base}files.tgz` };
}

/* ---------- System: Check the 20i account ---------- */

export interface AccountCheckItem {
  key: string;
  label: string;
  /** yes: fine; no: missing or refused; warn: works but needs a look. */
  state: "yes" | "no" | "warn";
  detail: string;
}

export interface AccountCheckResult {
  items: AccountCheckItem[];
  keyWorks: boolean;
  /** 20i's own count of packages on the account (TAWD's and any others). */
  packages: number | null;
  types: { id: string; label: string }[];
}
