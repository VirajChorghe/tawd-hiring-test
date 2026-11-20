import { and, eq, ne } from "drizzle-orm";
import { zipSync } from "fflate";

import { getDb } from "@tawd/core/db";
import { appSetting, formChannel, goLive, project, sshKey, wpPreview } from "@tawd/core/schema";
import { postProjectSlack, sendToWebhook } from "@tawd/core/slack";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { decryptSecret, encryptSecret } from "@tawd/core/secrets";
import { readPinnedHostKeys, SSH_HOST_KEYS_SETTING, type CommandOutput } from "@tawd/core/ssh-keys";
import { getCloudflareDns } from "@tawd/core/cloudflare-dns";
import { getStorage, getStreamFrom, putStreamTo } from "@tawd/core/intake/storage";
import { wordpressPackage } from "@tawd/core/site";
import {
  ACME_ACCOUNT_SETTING,
  BACKUPS_KEPT,
  GF_CLI,
  GOLIVE_STEPS,
  PACKAGE_LIMIT,
  PAID_CERT_PRICE,
  TWENTYI_PLAN,
  nextPlanWords,
  ROLLBACK_STEPS,
  UNDO_ROLLBACK_STEPS,
  TWENTYI_KEY_PURPOSE,
  TWENTYI_PACKAGE_TYPE_SETTING,
  WP_CERT_PATH_SETTING,
  WP_PHP_VERSION,
  backupKeys,
  backupStamp,
  briefly,
  commands,
  databaseNameFor,
  deploySteps,
  phpProbe,
  pickPhp,
  WP_CLI_MIN_PHP,
  type PhpChoice,
  onPreviewDomain as isOnPreviewDomain,
  packageOnPreviewName,
  isAdminUser,
  HOLDER_SWITCH_WAIT_MS,
  HOLDER_TEST_EVERY_MS,
  HOLDER_TEST_LOST_MS,
  HOLDER_WATCH_MS,
  isStagingHost,
  leftovers,
  looksLikeWordPress,
  CERT_SHOW_MS,
  MIN_SQL_BACKUP_BYTES,
  MOVE_CERT_TRIES,
  MOVE_CHECK_EVERY_MS,
  MOVE_CHECK_EXTRA_TRIES,
  MOVE_CHECK_TRIES,
  moveTarget,
  parseDbSearch,
  PREVIEW_HOLDER_LABEL,
  PREVIEW_HOLDER_SETTING,
  previewDomainSetting,
  type PreviewHolderState,
  DEFAULT_CERT_PATH,
  freshSteps,
  isCertPath,
  isWebRoot,
  loadPackageInput,
  pluginsFor,
  readCerts,
  recentlyInstalled,
  removeSteps,
  rollbackTarget,
  undoTarget,
  type CertPath,
  type PackageTypeChoice,
  type PreviewStep,
  type SiteBackup,
  type WpCert,
  type WpCerts,
  type WpTarget,
  writeCert,
} from "@tawd/core/wp-preview";
import type { WpPreviewJobData } from "@tawd/core/queue";

import { connectSsh, SshError, type SshSession } from "./ssh";
import { getTwentyi, isIpv4, sshAccessFor, stagingHostFor, TWENTYI_WEB_ROOT, TwentyiError, type TwentyiApi, type TwentyiPackageSummary } from "./twentyi";
import { explainAcme, getAcme, probeTls, recordsPointAt, type IssuedCertificate } from "./wp-cert";

/*
  Build B on 20i (5 October 2026; docs/plans/build-b-20i.md): a project's
  WordPress site in its own 20i hosting package. The package, its database
  and TAWD's SSH key are made through 20i's API (twentyi.ts); WordPress, the
  plugins and the site go on over SSH with the fixed commands in core
  wp-preview.ts, one step at a time, each step's result saved as it goes.
  Every step first looks at what is already there, so running it again
  carries on from where it stopped. Anything 20i does slowly (a new SSH
  key, a certificate) is recorded and confirmed later, never waited for
  inside the job. Backups stream to R2. No AI.
*/

class StepFailed extends Error {}

type Row = typeof wpPreview.$inferSelect;

const ok = (out: CommandOutput) => out.code === 0;

function need(out: CommandOutput, what: string): void {
  if (!ok(out)) throw new StepFailed(`${what}: ${briefly(out) || `it stopped with code ${out.code ?? "unknown"}`}`);
}

/** 20i's own words for an SSH key it hasn't set up yet (fail fast, Deploy again carries on). */
export const SSH_NOT_READY =
  "20i is still setting up TAWD's key on this package (it can take up to 30 minutes, 20i says). Deploy again in a few minutes; it carries on from here.";

/* ---------- the row, the settings, the connection ---------- */

export class Site {
  session: SshSession | null = null;
  /** The PHP WP-CLI runs on, found at sign-in (8 October 2026). */
  php: PhpChoice | null = null;
  constructor(public row: Row) {}

  async patch(values: Partial<Row>): Promise<void> {
    Object.assign(this.row, values);
    await getDb()
      .update(wpPreview)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(wpPreview.projectId, this.row.projectId));
  }

  target(): WpTarget {
    const dir = this.row.dir;
    if (!dir || !isWebRoot(dir)) throw new StepFailed("The site's folder at 20i isn't known yet: deploy the preview first.");
    return { name: this.row.name, dir, wp: this.php?.wp ?? null };
  }

  packageId(): string {
    if (!this.row.packageId) throw new StepFailed("There's no 20i package for this site yet: deploy the preview first.");
    return this.row.packageId;
  }

  async ssh(): Promise<SshSession> {
    if (!this.session) {
      this.session = await openSsh(this.row);
      this.php = pickPhp((await this.session.run(phpProbe())).output);
    }
    return this.session;
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }

  certs(): WpCerts {
    return readCerts(this.row.certs);
  }

  /* One certificate, written on its own: a PM's request made on the web meanwhile is never overwritten from this copy (finding 9). */
  async setCert(which: keyof WpCerts, cert: WpCert | null): Promise<void> {
    await writeCert(getDb(), this.row.projectId, which, cert);
    const [fresh] = await getDb().select({ certs: wpPreview.certs }).from(wpPreview).where(eq(wpPreview.projectId, this.row.projectId)).limit(1);
    this.row.certs = fresh?.certs ?? {};
  }
}

export async function setting<T>(key: string): Promise<T | null> {
  const [row] = await getDb().select().from(appSetting).where(eq(appSetting.key, key)).limit(1);
  return (row?.value as T | undefined) ?? null;
}

export async function saveSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await getDb()
    .insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date(), updatedByUserId: null } });
}

export async function certPathSetting(): Promise<CertPath> {
  const value = await setting<{ path?: unknown }>(WP_CERT_PATH_SETTING);
  return isCertPath(value?.path) ? value.path : DEFAULT_CERT_PATH;
}

/* Signs in to the package with TAWD's 20i key; the gateway's own key is remembered once and required after. */
async function openSsh(row: Row): Promise<SshSession> {
  const db = getDb();
  if (!row.sshHost || !row.sshUser) throw new StepFailed("The package's SSH details aren't known yet: deploy the preview first.");
  const [key] = await db.select().from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
  if (!key) throw new StepFailed("TAWD's 20i SSH key isn't made yet: Deploy again and TAWD makes it first.");
  const pins = readPinnedHostKeys(await setting(SSH_HOST_KEYS_SETTING));
  const expected = pins[row.sshHost]?.fingerprint ?? null;
  let session: SshSession;
  try {
    session = await connectSsh({ host: row.sshHost, port: 22, username: row.sshUser, privateKey: decryptSecret(key.privateKeyEncrypted), expectedHostKey: expected, readyTimeoutMs: 20_000 });
  } catch (error) {
    // Replace the key on System: each package gets the new one only at its next deploy, so say that rather than "refused" (finding 13).
    if (error instanceof SshError && error.kind === "refused" && keyReplacedSince(key.createdAt, row.deployedAt)) {
      throw new SshError(`TAWD's 20i key was replaced on ${key.createdAt.toISOString().slice(0, 10)}, after this site's last deploy: Deploy again (Hosting) adds the new key to its package, then try this again.`, "refused");
    }
    throw error;
  }
  if (!expected) {
    const entry = { fingerprint: session.hostKey, firstSeenAt: new Date().toISOString() };
    await saveSetting(SSH_HOST_KEYS_SETTING, { ...pins, [row.sshHost]: entry });
    await recordActivity(db, { action: "ssh.host_key_trusted", entityType: "setting", entityId: SSH_HOST_KEYS_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: row.sshHost, ...entry } });
  }
  return session;
}

/** TAWD's 20i key was made (replaced) after this site's last deploy: its package doesn't have the key yet. */
export const keyReplacedSince = (keyMadeAt: Date, deployedAt: Date | null): boolean => Boolean(deployedAt && keyMadeAt.getTime() > deployedAt.getTime());

/* The team's Slack channel (team_slack in app_setting), for what needs someone today. Never throws. */
export async function teamSlack(text: string): Promise<void> {
  try {
    const value = await setting<{ webhookEncrypted?: string }>("team_slack");
    if (value?.webhookEncrypted) await sendToWebhook(decryptSecret(value.webhookEncrypted), text);
  } catch {
    // A Slack post never stops the work.
  }
}

/* ---------- the job ---------- */

export async function runWpPreviewJob(job: WpPreviewJobData): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(wpPreview).where(eq(wpPreview.projectId, job.projectId)).limit(1);
  if (!row) return;
  // B3: the live site's jobs wait on their own state; the preview's on the preview's.
  const liveWanted: Record<string, string | null> = { attach: "attaching", golive: "going_live", rollback: "rolling_back", undo_rollback: "rolling_back" };
  if (job.action in liveWanted) {
    if (row.liveState !== liveWanted[job.action]) return;
  } else if (job.action === "deploy" || job.action === "remove") {
    if (row.state !== (job.action === "remove" ? "removing" : "deploying")) return;
  }

  // The preview domain's placeholder is never a project's site (12 October 2026): never suspended, restored or removed from here.
  if ((job.action === "suspend" || job.action === "restore" || job.action === "remove") && (await isHolderPackage(row.packageId)))
    throw new Error(`Package ${row.packageId} is TAWD's placeholder for the preview domain, not this project's site: TAWD never suspends or removes it.`);

  const site = new Site(row);
  try {
    switch (job.action) {
      case "deploy":
        return await deploy(site);
      case "remove":
        return await remove(site);
      case "https":
        return await checkPreviewHttps(site);
      case "attach":
        return await attach(site);
      case "cert":
        return await (job.target === "preview" ? previewCertAgain(site) : liveCert(site));
      case "https_live":
        return await checkLiveHttps(site);
      case "golive":
      case "rollback":
      case "undo_rollback":
        return await liveJob(site, job.action);
      case "suspend":
      case "restore":
        return await suspendOrRestore(site, job.action, job.by ?? null);
      case "purge":
        return await purge(site, job.by ?? null);
      case "move_check":
        return await moveCheck(site, job);
      case "holder_test":
        return await holderTest();
    }
  } finally {
    site.close();
  }
}

/* Runs the steps in order, saving each; a failed step stops the run and says why. */
async function runSteps(site: Site, steps: PreviewStep[], column: "steps" | "liveSteps", work: Record<string, () => Promise<{ detail: string; warn?: boolean }>>, onFail: Partial<Row>): Promise<boolean> {
  for (const step of steps) {
    step.state = "working";
    step.detail = null;
    await site.patch({ [column]: steps });
    try {
      const result = await work[step.key]!();
      step.state = result.warn ? "warn" : "done";
      step.detail = result.detail;
    } catch (error) {
      step.state = "failed";
      step.detail = error instanceof Error ? error.message : "It stopped.";
      await site.patch({ [column]: steps, ...onFail, ...(column === "steps" ? { failureReason: `${step.label}: ${step.detail}` } : {}) });
      return false;
    }
    await site.patch({ [column]: steps });
  }
  return true;
}

/* ---------- deploy ---------- */

async function deploy(site: Site): Promise<void> {
  const db = getDb();
  const row = site.row;
  const [proj] = await db.select({ clientName: project.clientName, formPlugin: project.formPlugin }).from(project).where(eq(project.id, row.projectId)).limit(1);
  if (!proj || !row.version) throw new Error("The project or its build is gone.");
  if (!row.packageDomain) throw new Error("The preview has no package name; deploy it again from the Build page.");
  const version = row.version;
  const dbPassword = decryptSecret(row.dbPasswordEncrypted);
  const adminPassword = decryptSecret(row.adminPasswordEncrypted);
  const formEmails = row.formEmails as { to?: string[]; copy?: string | null; relayUrl?: string | null };
  // A preview left on 20i's staging address moves to the preview domain on Deploy again (12 October 2026); if 20i won't take the
  // address, the hosting step puts it back on 20i's address, as for a new preview.
  const moveTo = moveTarget(row, previewDomainSetting());
  if (moveTo) await site.patch({ host: moveTo });
  // D1 option B: the preview is its own name under the preview domain: its own package's name since 0.119.0 (option 1).
  const onPreviewDomain = isOnPreviewDomain(row);
  // WordPress's own address moved this run (the wordpress step), for the check that the moved preview loads.
  let moved: { from: string; to: string; left: string } | null = null;
  const live = row.liveState === "live";
  const steps = deploySteps(proj.formPlugin, onPreviewDomain, live);
  const api = getTwentyi();

  const done = await runSteps(
    site,
    steps,
    "steps",
    {
      // B3: on the live site, a backup before anything changes (Roll back restores it; finding 5).
      backup: async () => {
        const b = await backup(site, "update");
        return { detail: `Saved in TAWD's storage (${megabytes(b.bytes)}). Roll back restores it.` };
      },
      hosting: async () => {
        const domain = row.packageDomain!;
        let id = row.packageId;
        let made = false;
        let all: TwentyiPackageSummary[] | null = null;
        // The preview domain's placeholder package first, before the client's (CodeRabbit, PR #2): a 25th client package must never take
        // the slot the placeholder needs. Looked for on every deploy, so a preview stuck on 20i's address gets it too.
        const previewDomain = onPreviewDomain ? previewDomainSetting() : null;
        let holderNote = "";
        if (previewDomain) {
          all = await api.listPackages();
          const holder = await ensurePreviewHolder(api, all, previewDomain, row.projectId, Boolean(row.limitConfirmedBy));
          if (holder === "setting_up") throw new StepFailed(`20i is still setting up ${previewDomain} (TAWD's placeholder package, which lets previews use ${previewDomain}). Deploy again in a few minutes; it carries on from here.`);
          if (holder === "full")
            holderNote = ` 20i takes preview addresses only once the account has a package for ${previewDomain} itself, and all ${PACKAGE_LIMIT} of ${TWENTYI_PLAN.name}'s packages are used, so the preview is at 20i's own address: slower servers, so the speed check can't measure it, and a founder lets it through at go-live.`;
        }
        // Option 1 (0.119.0): a new package named after the preview address can only be made once the placeholder is ready.
        const ownName = packageOnPreviewName(row, previewDomainSetting());
        if (!id && ownName && holderNote)
          throw new StepFailed(`20i makes a package named ${domain} only once the account has a package for ${previewDomainSetting()} itself (TAWD's placeholder), and all ${PACKAGE_LIMIT} of ${TWENTYI_PLAN.name}'s packages are used. Free a package in My20i, or an admin confirms the next plan (${nextPlanWords()}) on this page (Hosting), then Deploy again.`);
        if (!id) {
          // Looked up first, so a run that stopped after 20i made it never makes a second one.
          all ??= await api.listPackages();
          const found = all.find((p) => p.name === domain || p.names.includes(domain));
          if (found && (await isHolderPackage(found.id))) throw new StepFailed(`20i's package ${found.id} is TAWD's placeholder for the preview domain, never a site's own. Check this preview's name.`);
          if (found) {
            // Only a package this project made (a run that stopped after 20i made it): never another project's site.
            const [other] = await db.select({ projectId: wpPreview.projectId }).from(wpPreview).where(and(eq(wpPreview.packageId, found.id), ne(wpPreview.projectId, row.projectId))).limit(1);
            if (other) throw new StepFailed(`20i's package ${found.id} for ${domain} belongs to another project's site. Check the domain on this project's intake.`);
            id = found.id;
          }
          else {
            if (all.length >= PACKAGE_LIMIT && !row.limitConfirmedBy)
              throw new StepFailed(
                `This would be package ${all.length + 1} on 20i: ${TWENTYI_PLAN.name} holds ${PACKAGE_LIMIT}, so 20i moves VML to ${nextPlanWords()}. An admin confirms it on this page (Hosting), then Deploy again.`,
              );
            const type = await setting<PackageTypeChoice>(TWENTYI_PACKAGE_TYPE_SETTING);
            if (!type?.id) throw new StepFailed("Choose the package type TAWD uses first (System, 20i: Check the 20i account, then choose one).");
            try {
              id = await api.createPackage({ typeId: type.id, domain, label: `TAWD ${row.name}` });
            } catch (error) {
              // 20i confirmed this works (3 November 2026); if it ever refuses, the step stops in 20i's words and nothing is half made.
              if (ownName && error instanceof TwentyiError && ["refused", "not_found"].includes(error.kind))
                throw new StepFailed(`20i wouldn't make a package named ${domain} (${error.message}). Nothing was made. Check that the ${previewDomainSetting()} package is in My20i and switched on, then Deploy again.`);
              throw error;
            }
            made = true;
          }
          await site.patch({ packageId: id });
          if (made) await recordActivity(db, { action: "site.wp_package_created", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { packageId: id, domain } });
        }
        const pkg = await api.getPackage(id);
        if (!pkg) throw new StepFailed(`20i doesn't know package ${id} any more. If it was deleted in My20i, remove the preview here and deploy it again.`);
        // addWeb answers before the package is ready (20i.apib: setupComplete on the package's web).
        if (!pkg.setupComplete) throw new StepFailed("20i is still setting up the package. Deploy again in a few minutes; it carries on from here.");
        if (!pkg.ipv4 || !isIpv4(pkg.ipv4)) throw new StepFailed("20i hasn't given the package an IP address yet. Deploy again in a few minutes; it carries on from here.");
        const access = sshAccessFor(domain);
        const staging = pkg.stagingHost ?? stagingHostFor(domain);
        let php = "";
        try {
          await api.setPhpVersion(id, WP_PHP_VERSION);
        } catch (error) {
          php = ` PHP ${WP_PHP_VERSION} wasn't set by API (${error instanceof Error ? error.message : "no answer"}): set it in My20i.`;
        }
        // The preview address as an extra name on the package. If 20i won't take it, the preview goes on at 20i's own address and says why.
        let previewName = holderNote;
        let host = onPreviewDomain && !holderNote ? row.host : staging;
        if (onPreviewDomain && !holderNote && pkg.name !== row.host && !pkg.names.includes(row.host!)) {
          try {
            await api.addDomain(id, row.host!);
          } catch (error) {
            if (!(error instanceof TwentyiError) || !["refused", "not_found"].includes(error.kind)) throw error;
            host = staging;
            previewName = ` 20i wouldn't add ${row.host} to the package (${error.message}), so the preview is at 20i's own address: slower servers, so the speed check can't measure it, and a founder lets it through at go-live.`;
          }
        }
        if (moveTo && host !== moveTo)
          await recordActivity(db, { action: "site.wp_preview_move_refused", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { to: moveTo, reason: previewName.trim() } });
        await site.patch({ packageIpv4: pkg.ipv4, stagingHost: staging, sshHost: access.host, sshUser: access.user, dir: row.dir ?? TWENTYI_WEB_ROOT, host });
        return { detail: `${made ? "Made" : "Found"} package ${id} (${domain}) at ${pkg.ipv4}. 20i's own address: ${staging}.${php}${previewName}`, warn: Boolean(php || previewName) };
      },
      preview_record: async () => {
        if (!isOnPreviewDomain(site.row)) return { detail: "Not needed: the preview is at 20i's own address." };
        const cf = getCloudflareDns();
        const zone = await cf.zoneFor(row.host!);
        if (!zone) throw new StepFailed(`${row.host!.split(".").slice(1).join(".")} isn't on VML's client-zones Cloudflare account yet: Jason adds it there, then Deploy again.`);
        await cf.setA(zone.id, row.host!, row.packageIpv4!);
        return { detail: `${row.host} points at ${row.packageIpv4} (Cloudflare, DNS only).` };
      },
      database: async () => {
        const id = site.packageId();
        // Once 20i has answered with the database's names, it is never made again from here: a wrong or empty list (a 404 or a slow
        // answer) must not replace a live site's database with an empty one (Fable's code review, finding 5). Only a removed
        // preview starts with no names, and so gets a new database.
        if (row.dbName && row.dbUser && row.dbHost) {
          let listed: boolean | null;
          try {
            listed = (await api.listDatabases(id)).some((d) => d.name === row.dbName);
          } catch {
            listed = null;
          }
          if (listed) return { detail: `${row.dbName} on ${row.dbHost} (kept).` };
          return { detail: `${row.dbName} on ${row.dbHost} (kept). 20i's list ${listed === null ? "didn't answer" : "doesn't show it"}; if the site can't reach its database, remove the preview and deploy it again.`, warn: true };
        }
        const made = await api.createDatabase(id, { name: databaseNameFor(row.projectId), password: dbPassword });
        await site.patch({ dbName: made.name, dbUser: made.user, dbHost: made.host });
        return { detail: `${made.name} on ${made.host}, with its own user and a long random password (kept encrypted in TAWD).` };
      },
      ssh: async () => {
        const id = site.packageId();
        const [key] = await db.select().from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);
        if (!key) throw new StepFailed("TAWD's 20i SSH key isn't made yet: Deploy again and TAWD makes it first.");
        let note = "";
        try {
          // Per package (20i.apib, SSH Keys); a key the package already has isn't sent again (finding 18).
          await api.addSshKey(id, key.publicKey);
        } catch (error) {
          // If 20i refuses, TAWD still tries to sign in (the key may have been added in My20i), and says so.
          const message = error instanceof Error ? error.message : "no answer";
          if (!/already|exists|duplicate/i.test(message)) note = ` 20i didn't take the key by API (${message}); TAWD signed in with a key already on the package.`;
        }
        let session: SshSession;
        try {
          session = await site.ssh();
        } catch (error) {
          if (error instanceof SshError && error.kind === "refused") throw new StepFailed(SSH_NOT_READY);
          throw error;
        }
        if ((await session.run(commands.hasWebRoot(site.target()))).output.trim() !== "yes") {
          /*
            A new package may not have its website folder yet (8 October 2026, the first real deploy). When 20i says it serves the site from
            that folder, TAWD makes it; otherwise the step says which folder 20i names and what the home folder holds.
          */
          const roots = await api.documentRoots(id);
          const served = roots[row.packageDomain!] ?? Object.values(roots)[0] ?? null;
          if (served === row.dir) {
            if ((await session.run(commands.makeWebRoot(site.target()))).output.trim() !== "yes") throw new StepFailed(`TAWD couldn't make the package's website folder (~/${row.dir}).`);
            note += ` TAWD made the website folder (~/${row.dir}), where 20i serves the site from.`;
          } else {
            const home = (await session.run(commands.homeFolder())).output.trim().split("\n").filter(Boolean).join(", ");
            throw new StepFailed(`The package's website folder (~/${row.dir}) isn't there, and 20i serves ${row.packageDomain} from ${served ? `~/${served}` : "no folder it names"}. The home folder holds: ${home || "nothing"}. Check the package in My20i.`);
          }
        }
        const php = site.php?.chosen ? ` WordPress's tools run on PHP ${site.php.chosen.version}${site.php.wp ? ` (${site.php.chosen.path}, not the server's default)` : ""}.` : "";
        return { detail: `Signed in as ${row.sshUser} on ${row.sshHost}.${php}${note}`, warn: Boolean(note) };
      },
      cert: async () => (isOnPreviewDomain(site.row) ? previewCert(site) : { detail: "Not needed: 20i's own address has 20i's certificate." }),
      wordpress: async () => {
        const session = await site.ssh();
        if (!site.php?.chosen)
          throw new StepFailed(
            `TAWD's theme needs PHP ${WP_CLI_MIN_PHP} or newer on the command line, and 20i's SSH has ${site.php?.found.map((f) => `${f.version} (${f.path})`).join(", ") || "no PHP TAWD could find"}. The site itself runs PHP ${WP_PHP_VERSION}; ask 20i how to use it over SSH.`,
          );
        const t = site.target();
        const database = { dbName: row.dbName!, dbUser: row.dbUser!, dbHost: row.dbHost! };
        if ((await session.run(commands.hasWordPress(t))).output.trim() !== "yes") need(await session.run(commands.download(t), 300_000), "Downloading WordPress");
        if ((await session.run(commands.hasConfig(t))).output.trim() !== "yes") need(await session.run(commands.config(t, database, dbPassword)), "Writing wp-config.php");
        else for (const command of commands.dbSettings(t, database, dbPassword)) need(await session.run(command), "Setting the database in wp-config.php");
        for (const command of commands.hardening(t)) need(await session.run(command), "Setting wp-config.php");
        // F2: form messages through TAWD once Postmark is set up; otherwise the site emails the client itself.
        const [channel] = formEmails.relayUrl ? await db.select().from(formChannel).where(eq(formChannel.projectId, row.projectId)).limit(1) : [];
        if (formEmails.relayUrl && channel) {
          for (const command of commands.relayOn(t, formEmails.relayUrl, decryptSecret(channel.secretEncrypted))) need(await session.run(command), "Setting where form messages go");
        } else {
          for (const command of commands.relayOff(t)) await session.run(command);
        }
        if (!isAdminUser(row.adminUser)) throw new StepFailed(`The site's WordPress login name (${row.adminUser}) isn't one TAWD makes: remove the preview and deploy it again.`);
        const installed = (await session.run(commands.isInstalled(t))).output.trim().endsWith("yes");
        if (installed) {
          need(await session.run(commands.adminPassword(t, row.adminUser, adminPassword)), "Updating the WordPress login");
          need(await session.run(commands.adminPublicName(t, row.adminUser)), "Setting the login's public name");
          // The preview's address changed (moved to the preview domain, or put back on 20i's): WordPress's own address follows.
          const from = live ? null : hostOf((await session.run(commands.homeUrl(t))).output);
          if (from && from !== row.host && isPreviewAddress(from) && isPreviewAddress(row.host!)) {
            const left = await moveWordPress(session, t, from, row.host!);
            moved = { from, to: row.host!, left };
            return { detail: `Already installed; the login is TAWD's. WordPress's address moved from ${from} to ${row.host}. ${left}`, warn: !left.startsWith("Nothing") };
          }
        } else {
          const email = formEmails.copy || formEmails.to?.[0] || `wordpress@${row.host}`;
          need(await session.run(commands.install(t, `https://${row.host}`, proj.clientName, email, row.adminUser, adminPassword), 180_000), "Installing WordPress");
        }
        // Pages and author links show "Website team", never the login (13 October 2026).
        if (!installed) need(await session.run(commands.adminPublicName(t, row.adminUser)), "Setting the login's public name");
        return { detail: installed ? "Already installed; the login is TAWD's." : `Installed at https://${row.host}, with TAWD's own login.` };
      },
      plugins: async () => {
        const session = await site.ssh();
        const t = site.target();
        const formPlugin = proj.formPlugin === "gravityforms" ? "gravityforms" : "cf7";
        if (formPlugin === "gravityforms") {
          const key = process.env.GRAVITY_FORMS_LICENSE_KEY?.trim();
          if (!key) throw new StepFailed("Gravity Forms needs VML's licence key: an admin adds GRAVITY_FORMS_LICENSE_KEY to the worker (tawd-worker-new) in Coolify, then redeploys it.");
          const cli = await session.run(commands.pluginVersion(t, GF_CLI.slug));
          if (!ok(cli) || cli.output.trim() !== GF_CLI.version) need(await session.run(commands.installPlugin(t, GF_CLI.slug, GF_CLI.version), 300_000), `Installing ${GF_CLI.name} ${GF_CLI.version}`);
          const gf = await session.run(commands.pluginVersion(t, "gravityforms"));
          if (!ok(gf)) for (const command of commands.installGravityForms(t, key)) need(await session.run(command, 300_000), "Installing Gravity Forms with VML's licence");
          else need(await session.run(commands.activatePlugin(t, "gravityforms")), "Switching on Gravity Forms");
        }
        for (const plugin of pluginsFor(formPlugin)) {
          const current = await session.run(commands.pluginVersion(t, plugin.slug));
          if (ok(current) && current.output.trim() === plugin.version) need(await session.run(commands.activatePlugin(t, plugin.slug)), `Switching on ${plugin.name}`);
          else need(await session.run(commands.installPlugin(t, plugin.slug, plugin.version), 300_000), `Installing ${plugin.name} ${plugin.version}`);
        }
        // The other form plugin, if it's there from before, is switched off: its files slowed every page (1 October 2026).
        const unused = formPlugin === "gravityforms" ? "contact-form-7" : "gravityforms";
        if (ok(await session.run(commands.pluginVersion(t, unused)))) await session.run(commands.deactivatePlugin(t, unused));
        return { detail: [...(formPlugin === "gravityforms" ? ["Gravity Forms (VML's licence)"] : []), ...pluginsFor(formPlugin).map((p) => `${p.name} ${p.version}`)].join(", ") };
      },
      package: async () => {
        const session = await site.ssh();
        const t = site.target();
        const input = await loadPackageInput(db, row.projectId, version);
        if (!input) throw new StepFailed(`Build version ${version}'s files are missing.`);
        // B3: the live site stays open to search engines (its backup is the deploy's first step).
        const made = wordpressPackage({ clientName: proj.clientName, ...input, formEmails: { to: formEmails.to ?? [], copy: formEmails.copy ?? null }, mode: live ? "live" : "preview", formPlugin: proj.formPlugin === "gravityforms" ? "gravityforms" : "cf7" });
        const zip = zipSync(Object.fromEntries(made.files), { level: 6 });
        await session.upload(`tawd-packages/${t.name}-v${version}.zip`, zip);
        need(await session.run(commands.unpack(t, version), 180_000), "Unpacking the package");
        const ran = await session.run(commands.runInstaller(t, version), 600_000);
        // The installer says "Done: ..." at the very end, and nothing else does.
        if (!ok(ran) || !/Done: \d+ pages/.test(ran.output)) throw new StepFailed(`The installer stopped: ${briefly(ran)}`);
        await session.run(commands.cleanPackage(t, version));
        const notes = made.report.notes.length ? ` To check: ${made.report.notes.join(" ")}` : "";
        // The team's changes in WordPress are kept (1 October 2026); the installer says which.
        const kept = ran.output
          .split("\n")
          .filter((line) => /^(Kept \(edited in WordPress\)|Menu: kept)/.test(line.trim()))
          .map((line) => ` ${line.trim()}`)
          .join("");
        return { detail: `${made.report.pages} pages, ${made.report.forms} form${made.report.forms === 1 ? "" : "s"}, ${made.report.media} pictures and files.${kept}${notes}`, warn: made.report.notes.length > 0 };
      },
      cache: async () => purgeFor(site, [row.host, row.liveState === "live" ? row.liveDomain : null]),
    },
    { state: "failed" },
  );

  if (!done) return;
  const https = (await probeTls(row.host!)).ok;
  const deployedAt = new Date();
  await site.patch({ state: "ready", deployedVersion: version, deployedAt, https, failureReason: null, steps });
  await recordActivity(db, { action: "site.wp_preview_deployed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { version, host: row.host, https, packageId: row.packageId } });
  const movedOn = moved as { from: string; to: string; left: string } | null;
  if (movedOn && isStagingHost(movedOn.from)) {
    // Opened every few minutes for up to an hour (a new certificate can take 20i 30 minutes to show); moved back if it never loads.
    await recordActivity(db, { action: "site.wp_preview_moved", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { from: movedOn.from, to: movedOn.to, leftovers: movedOn.left } });
    await later({ projectId: row.projectId, action: "move_check", from: movedOn.from, to: movedOn.to, tries: 1 }, MOVE_CHECK_EVERY_MS, `wp-move-check-${row.projectId}-${deployedAt.getTime()}-1`);
  }
}

/* 20i's cache, cleared for the whole package (every address on it); a refusal warns, never stops. */
async function purgeFor(site: Site, hosts: (string | null)[]): Promise<{ detail: string; warn?: boolean }> {
  const named = hosts.filter((h): h is string => Boolean(h));
  try {
    await getTwentyi().purgeCache(site.packageId());
    return { detail: `Cleared for the whole site (${named.join(" and ")}).` };
  } catch (error) {
    return { detail: `20i didn't clear its cache (${error instanceof Error ? error.message : "no answer"}). Pages may show the old version for a while; Purge the cache on the card tries again.`, warn: true };
  }
}

/* ---------- previews on the preview domain (12 October 2026; docs/plans/tawdpreviews-in-20i.md) ---------- */

/*
  Follow-up jobs (the moved preview's check, the placeholder's switch-off check) are delayed jobs on the WordPress queue, so they
  survive a worker restart. The worker's start sets how they're queued (index.ts); tests set their own.
*/
type Later = (data: WpPreviewJobData, delayMs: number, jobId: string) => Promise<void>;
let laterFn: Later | null = null;

export function setWpLater(fn: Later | null): void {
  laterFn = fn;
}

async function later(data: WpPreviewJobData, delayMs: number, jobId: string): Promise<void> {
  if (!laterFn) {
    console.error(`WordPress preview ${data.projectId}: no queue for the follow-up ${data.action} (${jobId}).`);
    return;
  }
  await laterFn(data, delayMs, jobId);
}

/* A preview's home page as a visitor opens it (HTTPS, redirects followed). Never throws. */
type HomeFetch = (host: string) => Promise<{ ok: boolean; status: number | null; html: string; reason: string | null }>;
let homeFetchOverride: HomeFetch | null = null;

export function setHomeFetchForTesting(fn: HomeFetch | null): void {
  homeFetchOverride = fn;
}

async function openHome(host: string): ReturnType<HomeFetch> {
  if (homeFetchOverride) return homeFetchOverride(host);
  try {
    // TAWD's own preview addresses only (20i's, or the preview domain's): never a client's or a private address.
    const response = await fetch(`https://${host}/`, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "TAWD preview check (Velocity Media Lab)" } });
    // Only the preview's own address counts: another site it redirects to is never the preview loading (CodeRabbit, PR #3).
    const landed = response.url ? new URL(response.url).hostname.toLowerCase() : host.toLowerCase();
    if (landed !== host.toLowerCase()) return { ok: false, status: response.status, html: "", reason: `it redirected to ${landed}` };
    const html = (await response.text()).slice(0, 2_000_000);
    return { ok: response.ok, status: response.status, html, reason: response.ok ? null : `it answered ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return { ok: false, status: null, html: "", reason: cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : "no answer") };
  }
}

/** The host in WordPress's home address ("https://x.example.com" → "x.example.com"); null when it isn't one. */
function hostOf(output: string): string | null {
  const line = output.trim().split("\n").pop()?.trim() ?? "";
  try {
    return new URL(line).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** One of TAWD's preview addresses: 20i's staging address, or a name under the preview domain. */
function isPreviewAddress(host: string): boolean {
  const domain = previewDomainSetting();
  return isStagingHost(host) || Boolean(domain && host.endsWith(`.${domain}`));
}

/*
  WordPress's address moved from one preview address to another (Jason, 12 October 2026): WP-CLI's search-replace on the bare host
  name, so every form of the address (https, http, escaped in stored settings) follows; WP-CLI rewrites PHP's stored (serialized)
  data safely, and the guid column is left alone as WordPress advises. Then WordPress's home and site address, then a search of
  every table for the old address. Says what's left, in words.
*/
async function moveWordPress(session: SshSession, t: WpTarget, from: string, to: string): Promise<string> {
  need(await session.run(commands.searchReplace(t, from, to), 600_000), `Moving WordPress's address from ${from} to ${to}`);
  for (const command of commands.setUrls(t, `https://${to}`)) need(await session.run(command), "Setting WordPress's address");
  const search = await session.run(commands.dbSearch(t, from), 300_000);
  if (!ok(search)) return `TAWD couldn't check for links left to ${from} (${briefly(search) || "no answer"}).`;
  const left = leftovers(parseDbSearch(search.output));
  if (!left.length) return `Nothing in the database points at ${from} any more.`;
  return `Still pointing at ${from}: ${left.map((l) => `${l.table}.${l.column} (${l.count})`).join(", ")}.`;
}

/*
  The preview domain's placeholder package: found by name, or made (the package type chosen on System). "full" when the account has
  no slot for it (the preview then stays on 20i's address); "setting_up" while 20i finishes it.
*/
async function ensurePreviewHolder(api: TwentyiApi, all: TwentyiPackageSummary[], previewDomain: string, projectId: string, limitConfirmed = false): Promise<"ready" | "setting_up" | "full"> {
  const db = getDb();
  const state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
  let id = all.find((p) => p.name === previewDomain || p.names.includes(previewDomain))?.id ?? null;
  if (!id) {
    // Past the plan's limit only with an admin's confirm of the next plan (hand review of PR #24): never a dead end.
    if (all.length >= PACKAGE_LIMIT && !limitConfirmed) return "full";
    const type = await setting<PackageTypeChoice>(TWENTYI_PACKAGE_TYPE_SETTING);
    if (!type?.id) throw new StepFailed("Choose the package type TAWD uses first (System, 20i: Check the 20i account, then choose one).");
    id = await api.createPackage({ typeId: type.id, domain: previewDomain, label: PREVIEW_HOLDER_LABEL });
    all.push({ id, name: previewDomain, names: [previewDomain], typeRef: type.id, enabled: true });
    await recordActivity(db, { action: "site.wp_preview_holder_created", entityType: "setting", entityId: PREVIEW_HOLDER_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { packageId: id, domain: previewDomain, forProject: projectId } });
  }
  if (state.packageId !== id) await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, packageId: id });
  const pkg = await api.getPackage(id);
  return pkg?.setupComplete ? "ready" : "setting_up";
}

/** The placeholder's package: never a project's site, so Suspend, Restore, Purge and Remove refuse it. */
export async function isHolderPackage(packageId: string | null): Promise<boolean> {
  return Boolean(packageId && (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING))?.packageId === packageId);
}

/*
  The moved preview, opened every few minutes (Jason, 12 October 2026): once it serves the client's WordPress site over HTTPS, the
  move stands; if it still doesn't after an hour (20i can take 30 minutes to show a new certificate), TAWD moves it back by itself.
*/
async function moveCheck(site: Site, job: WpPreviewJobData): Promise<void> {
  const db = getDb();
  const row = site.row;
  const { from, to } = job;
  const tries = job.tries ?? 1;
  if (!from || !to || row.host !== to || row.state !== "ready" || row.liveState === "live") return;
  // The certificate failed at the deploy: got again by itself, a few times in the hour, before any move back.
  const cert = site.certs().preview;
  if (cert?.state === "failed" && cert.host === to && MOVE_CERT_TRIES.includes(tries)) {
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the worker's log only
    try {
      await certStep(site);
    } catch (error) {
      console.error(`The moved preview's certificate, try ${tries}: ${error instanceof Error ? error.message : "no answer"}`);
    }
  }
  const home = await openHome(to);
  if (home.ok && looksLikeWordPress(home.html)) {
    const oldLinks = home.html.split(from).length - 1;
    await recordActivity(db, { action: "site.wp_preview_move_confirmed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { from, to, tries, oldLinksOnHome: oldLinks } });
    await site.patch({ https: true });
    /*
      The placeholder's switch-off check is never started since 0.119.0: a preview's package is now a subdomain package of the preview
      domain, and 20i switches those off with their parent's package, so the check would take every preview down. The placeholder is
      simply kept on (the daily job switches it back on if it is ever found off).
    */
    return;
  }
  const reason = home.reason ?? (home.ok ? "it answered, but not with the WordPress site" : "no answer");
  // A certificate TAWD has just installed: 20i can take up to 30 minutes to show it, so the checks go on past the hour, but only
  // while it is still within that window of being installed (CodeRabbit, PR #12).
  const shown = site.certs().preview;
  const installedAt = shown?.installedAt ? Date.parse(shown.installedAt) : NaN;
  const showing = recentlyInstalled(shown) !== null && shown?.host === to && Number.isFinite(installedAt) && Date.now() - installedAt < CERT_SHOW_MS;
  if (tries < MOVE_CHECK_TRIES || (showing && tries < MOVE_CHECK_TRIES + MOVE_CHECK_EXTRA_TRIES)) {
    await later({ projectId: row.projectId, action: "move_check", from, to, tries: tries + 1 }, MOVE_CHECK_EVERY_MS, `wp-move-check-${row.projectId}-${row.deployedAt?.getTime() ?? 0}-${tries + 1}`);
    return;
  }
  await moveBack(site, from, to, `${to} didn't load over HTTPS within an hour (${reason})`);
}

/* Back to 20i's address, by itself: WordPress's address, the saved address, and the reason on the card. The extra name and the record stay, so the next try is quick. */
async function moveBack(site: Site, staging: string, to: string, reason: string): Promise<void> {
  const db = getDb();
  const row = site.row;
  let left: string;
  try {
    const session = await site.ssh();
    left = await moveWordPress(session, site.target(), to, staging);
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    await recordActivity(db, { action: "site.wp_preview_move_back_failed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { from: to, to: staging, reason, error: why } });
    await teamSlack(`TAWD couldn't move ${row.host}'s WordPress preview back to 20i's address (${why}). It was being moved back because ${reason}.`);
    return;
  }
  const steps = ((row.steps as PreviewStep[]) ?? []).map((s) => (s.key === "hosting" ? { ...s, state: "warn" as const, detail: `${s.detail ?? ""} Moved back to 20i's own address: ${reason}. Deploy again tries ${to} again.`.trim() } : s));
  await site.patch({ host: staging, https: (await probeTls(staging)).ok, steps });
  await recordActivity(db, { action: "site.wp_preview_moved_back", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { from: to, to: staging, reason, leftovers: left } });
}

/*
  The placeholder's switch-off check (plan step 5, 12 October 2026) no longer starts (0.119.0, above). A check a worker had already
  started still runs to its end here, so the placeholder is always switched back on.
*/
async function holderTest(): Promise<void> {
  const state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
  if (!state.packageId || !state.test) return;
  try {
    await holderStep(state as Required<Pick<PreviewHolderState, "packageId" | "test">> & PreviewHolderState);
  } catch (error) {
    // Never left off: whatever stopped this step, the placeholder is asked back on and the check carries on from there.
    const why = error instanceof Error ? error.message : "no answer";
    await switchBackOn(state as Required<Pick<PreviewHolderState, "packageId" | "test">> & PreviewHolderState, `the check stopped (${why})`);
  }
}

type RunningTest = Required<Pick<PreviewHolderState, "packageId" | "test">> & PreviewHolderState;

/** The saved state with the finished check taken out. */
function withoutTest(state: PreviewHolderState): PreviewHolderState {
  const rest = { ...state };
  delete rest.test;
  return rest;
}

async function nextHolderStep(state: RunningTest): Promise<void> {
  const test = { ...state.test, seq: state.test.seq + 1 };
  await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, test });
  await later({ projectId: test.projectId, action: "holder_test" }, HOLDER_TEST_EVERY_MS, `wp-holder-test-${test.seq}`);
}

async function switchBackOn(state: RunningTest, reason: string | null, dependsOn?: boolean): Promise<void> {
  const test = { ...state.test, phase: "switching_on" as const, phaseAt: new Date().toISOString(), reason: state.test.reason ?? reason, dependsOn: dependsOn ?? state.test.dependsOn };
  await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, test });
  try {
    await getTwentyi().setPackageEnabled(state.packageId, true);
  } catch {
    // Asked again at the next step.
  }
  await nextHolderStep({ ...state, test });
}

async function holderStep(state: RunningTest): Promise<void> {
  const api = getTwentyi();
  const test = state.test;
  const since = Date.now() - Date.parse(test.phaseAt);
  const holder = (await api.listPackages()).find((p) => p.id === state.packageId);
  if (!holder) {
    await saveSetting(PREVIEW_HOLDER_SETTING, { ...withoutTest(state), packageId: undefined, result: { at: new Date().toISOString(), previewsDependOnIt: null, note: "The placeholder package is gone at 20i; the next deploy on the preview domain makes it again." } });
    return;
  }
  // Another preview on the preview domain while the placeholder is (going) off: the check stops at once (CodeRabbit, PR #3).
  if (test.phase !== "switching_on") {
    const domain = previewDomainSetting();
    const previews = await getDb().select({ host: wpPreview.host }).from(wpPreview).where(ne(wpPreview.state, "removed"));
    const onDomain = domain ? previews.filter((p) => p.host?.endsWith(`.${domain}`)).length : 0;
    if (onDomain > 1) return switchBackOn(state, `another preview went onto ${domain}, so the check was stopped`);
  }
  if (test.phase === "switching_off") {
    if (!holder.enabled) {
      await nextHolderStep({ ...state, test: { ...test, phase: "watching", phaseAt: new Date().toISOString() } });
      return;
    }
    if (since > HOLDER_SWITCH_WAIT_MS) return switchBackOn(state, "20i didn't switch the placeholder off within an hour, so the check couldn't run");
    return nextHolderStep(state);
  }
  if (test.phase === "watching") {
    const home = await openHome(test.host);
    if (!(home.ok && looksLikeWordPress(home.html))) return switchBackOn(state, `${test.host} stopped loading while the placeholder was off (${home.reason ?? "not the WordPress site"})`, true);
    if (since >= HOLDER_WATCH_MS) return switchBackOn(state, null, false);
    return nextHolderStep(state);
  }
  // switching_on: done once 20i says it's on again.
  if (holder.enabled) {
    const depends = test.dependsOn ?? null;
    const note =
      depends === true
        ? `Previews depend on the placeholder: ${test.reason ?? "a preview stopped loading while it was off"}. TAWD never switches it off; nobody should in My20i.`
        : depends === false
          ? "Previews kept loading for 30 minutes with the placeholder off: they don't depend on it. TAWD still never switches it off."
          : `The check didn't finish: ${test.reason ?? "it stopped"}. The placeholder is on again; TAWD never switches it off.`;
    await saveSetting(PREVIEW_HOLDER_SETTING, { ...withoutTest(state), result: { at: new Date().toISOString(), previewsDependOnIt: depends, note } });
    await recordActivity(getDb(), { action: "site.wp_preview_holder_test_done", entityType: "setting", entityId: PREVIEW_HOLDER_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { packageId: state.packageId, previewsDependOnIt: depends, note } });
    if (depends) await teamSlack(`TAWD's check: WordPress previews go down when the ${previewDomainSetting() ?? "preview domain"} placeholder package is switched off at 20i. Never suspend or delete package ${state.packageId} in My20i.`);
    return;
  }
  if (since > HOLDER_SWITCH_WAIT_MS) {
    await teamSlack(`20i hasn't switched TAWD's placeholder package ${state.packageId} back on after an hour. TAWD keeps asking; an admin can switch it on in My20i (Manage Hosting, Options, Enable).`);
    return switchBackOn({ ...state, test: { ...test, phaseAt: new Date().toISOString() } }, null);
  }
  return nextHolderStep(state);
}

/*
  The placeholder is never left off (CodeRabbit, PR #2). At the worker's start: a check in progress gets its next step queued again
  (a step still waiting keeps its place, as the job id is the same). In the daily job: a check silent for half an hour is taken as
  stopped and the placeholder switched back on. A placeholder found off with no check running is the hourly watch's (0.122.0,
  holder-watch.ts: switched back on, the team told the first time and once a day while it stays off). Never throws; says what it
  did, or null.
*/
export async function recoverPreviewHolder(when: "start" | "daily"): Promise<string | null> {
  try {
    const state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
    if (!state.packageId) return null;
    const running = state as RunningTest;
    if (state.test) {
      if (when === "start") {
        await later({ projectId: state.test.projectId, action: "holder_test" }, 0, `wp-holder-test-${state.test.seq}`);
        return "The placeholder's switch-off check carries on.";
      }
      const updatedAt = (await getDb().select({ updatedAt: appSetting.updatedAt }).from(appSetting).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING)).limit(1))[0]?.updatedAt;
      if (updatedAt && Date.now() - updatedAt.getTime() < HOLDER_TEST_LOST_MS) return null;
      await switchBackOn({ ...running, test: { ...running.test, seq: running.test.seq + 1 } }, "the check was interrupted");
      return "The placeholder's switch-off check had stopped: its placeholder is being switched back on.";
    }
    return null;
  } catch (error) {
    console.error(`The preview domain's placeholder: ${error instanceof Error ? error.message : "not checked"}`);
    return null;
  }
}

/* ---------- certificates (plan 3.4) ---------- */

/* Let's Encrypt for these names: the check files over SFTP into the web root, then the certificate to 20i. */
/*
  TAWD's one ACME account key (staging and production alike), made and saved (encrypted) before the first certificate is asked
  for, whatever happens to that first try: a key thrown away after a failure would register a new Let's Encrypt account on
  every try (10 new accounts per IP per 3 hours; Fable's code review, finding 11).
*/
export async function ensureAcmeAccountKey(): Promise<string> {
  const account = await setting<{ keyEncrypted?: string }>(ACME_ACCOUNT_SETTING);
  if (account?.keyEncrypted) return decryptSecret(account.keyEncrypted);
  const pem = await getAcme().createAccountKey();
  await saveSetting(ACME_ACCOUNT_SETTING, { keyEncrypted: encryptSecret(pem), createdAt: new Date().toISOString() });
  return pem;
}

export async function issueLetsEncrypt(site: Site, names: string[]): Promise<IssuedCertificate> {
  const session = await site.ssh();
  const t = site.target();
  const accountKeyPem = await ensureAcmeAccountKey();
  const issued = await getAcme().issue({
    names,
    staging: process.env.TWENTYI_ACME_STAGING?.trim() === "on",
    accountKeyPem,
    setChallenge: async (token, content) => session.upload(commands.challengePath(t, token), Buffer.from(content, "utf8")),
    clearChallenge: async (token) => {
      await session.run(commands.removeChallenge(t, token));
    },
  });
  // The private key goes to 20i and nowhere else: TAWD keeps only the dates and the issuer.
  await getTwentyi().installCertificate(site.packageId(), { names, certificate: issued.certificate, privateKey: issued.privateKey, caBundle: issued.caBundle });
  return issued;
}

export const certFrom = (issued: IssuedCertificate, host: string, note: string): WpCert => ({
  state: "installing",
  source: "letsencrypt",
  host,
  issuer: issued.issuer,
  issuedAt: issued.issuedAt.toISOString(),
  expiresAt: issued.expiresAt.toISOString(),
  note,
  warned: [],
  installedAt: new Date().toISOString(),
});

/* The preview's certificate (D1 option B), before WordPress goes on. Never stops the deploy: what's missing is said, and Check HTTPS confirms it later. */
async function previewCert(site: Site): Promise<{ detail: string; warn?: boolean }> {
  const host = site.row.host!;
  const now = await probeTls(host);
  if (now.ok) {
    await site.setCert("preview", { state: "ok", source: site.certs().preview?.source ?? "manual", host, issuer: now.issuer, issuedAt: now.validFrom?.toISOString() ?? null, expiresAt: now.validTo?.toISOString() ?? null, note: null, warned: [] });
    return { detail: `https://${host} already has a working certificate${now.validTo ? ` (until ${now.validTo.toISOString().slice(0, 10)})` : ""}.` };
  }
  const path = await certPathSetting();
  // Handed to 20i less than two hours ago: not issued again on every Deploy again (Let's Encrypt allows 5 duplicates a week; Fable's code review, finding 8).
  const before = site.certs().preview;
  const minutes = path === "letsencrypt" && before?.host === host ? recentlyInstalled(before) : null;
  if (minutes !== null && before) {
    const note = `TAWD installed this certificate ${minutes} minute${minutes === 1 ? "" : "s"} ago; 20i can take up to 30 minutes to show it. Check HTTPS on the card confirms it.`;
    await site.setCert("preview", { ...before, state: "installing", note });
    return { detail: `${note} WordPress goes on meanwhile.`, warn: true };
  }
  if (path !== "letsencrypt") {
    // 20i's paid certificate is never bought for a preview; one is installed by hand instead.
    const note = `Install a certificate for ${host} in My20i (Manage hosting, SSL/TLS), then Check HTTPS on the card.`;
    await site.setCert("preview", { state: "installing", source: "manual", host, issuer: null, issuedAt: null, expiresAt: null, note });
    return { detail: `${note} WordPress goes on meanwhile.`, warn: true };
  }
  try {
    const issued = await issueLetsEncrypt(site, [host]);
    const note = "Installed at 20i; it can take up to 30 minutes to show. Check HTTPS on the card confirms it.";
    await site.setCert("preview", certFrom(issued, host, note));
    await recordActivity(getDb(), { action: "site.wp_cert_issued", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host, issuer: issued.issuer, expiresAt: issued.expiresAt.toISOString(), preview: true } });
    return { detail: `Let's Encrypt issued it (until ${issued.expiresAt.toISOString().slice(0, 10)}). ${note}`, warn: true };
  } catch (error) {
    const note = error instanceof TwentyiError ? `20i didn't install it: ${error.message}` : explainAcme(error);
    await site.setCert("preview", { state: "failed", source: "letsencrypt", host, issuer: null, issuedAt: null, expiresAt: null, note });
    await recordActivity(getDb(), { action: "site.wp_cert_failed", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host, reason: note, preview: true } });
    return { detail: `${note} WordPress goes on meanwhile; Get the certificate again from the card.`, warn: true };
  }
}

/* "Get the certificate again" for the preview, outside a deploy. */
async function previewCertAgain(site: Site): Promise<void> {
  if (site.certs().preview?.state !== "requested" || !site.row.host) return;
  await certStep(site);
}

/* The preview's certificate, and its line on the card. */
async function certStep(site: Site): Promise<void> {
  const result = await previewCert(site);
  const steps = ((site.row.steps as PreviewStep[]) ?? []).map((s) => (s.key === "cert" ? { ...s, state: result.warn ? ("warn" as const) : ("done" as const), detail: result.detail } : s));
  await site.patch({ steps });
}

/* The client's domain's certificate, by the path chosen on System; installed, never waited for. */
async function liveCert(site: Site): Promise<void> {
  const db = getDb();
  const row = site.row;
  const current = site.certs().live;
  if (current?.state !== "requested") return;
  const domain = row.liveDomain;
  const fail = async (note: string) => {
    await site.setCert("live", { ...current, state: "failed", note });
    await recordActivity(db, { action: "site.wp_cert_failed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: current.host, reason: note } });
    await postProjectSlack(db, row.projectId, { kind: "golive_step", step: `the HTTPS certificate for ${current.host} wasn't issued: ${note}` });
  };
  // Anything that throws below (a database write, public DNS) still ends the request: never left "requested" (Fable's code review, finding 3).
  try {
    if (!domain || !row.domainOnHostAt) return await fail("Put the domain on 20i first.");
    if (current.source === "letsencrypt") {
      // One handed to 20i less than two hours ago isn't issued again (Let's Encrypt's weekly duplicate limit; finding 8).
      const minutes = recentlyInstalled(current);
      if (minutes !== null) {
        await site.setCert("live", { ...current, state: "installing", note: `TAWD installed this certificate ${minutes} minute${minutes === 1 ? "" : "s"} ago; 20i can take up to 30 minutes to show it. Check HTTPS confirms it.` });
        return;
      }
      const why = await recordsPointAt(domain, row.packageIpv4 ?? "");
      if (why) return await fail(why);
      let issued: IssuedCertificate;
      try {
        issued = await issueLetsEncrypt(site, [domain, `www.${domain}`]);
      } catch (error) {
        return await fail(error instanceof TwentyiError ? `20i didn't install it: ${error.message}` : explainAcme(error));
      }
      const renewed = Boolean(current.issuedAt);
      await site.setCert("live", certFrom(issued, domain, "Installed at 20i; it can take up to 30 minutes to show. Check HTTPS confirms it."));
      await recordActivity(db, { action: renewed ? "site.wp_cert_renewed" : "site.wp_cert_issued", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: domain, issuer: issued.issuer, expiresAt: issued.expiresAt.toISOString() } });
      await confirmIfServing(site, domain);
      return;
    }
    if (current.source === "twentyi_paid") {
      if (!current.confirmedBy) return await fail("An admin confirms buying 20i's certificate first (its price is on the button).");
      let order: Awaited<ReturnType<ReturnType<typeof getTwentyi>["orderCertificate"]>>;
      try {
        order = await getTwentyi().orderCertificate({ packageId: site.packageId(), domain, periodMonths: 12 });
      } catch (error) {
        return await fail(`20i didn't take the order: ${error instanceof Error ? error.message : "no answer"}`);
      }
      await site.setCert("live", { ...current, state: "installing", paidId: order.id, paidPrice: order.price ?? PAID_CERT_PRICE, renewsAt: order.renewsAt, note: "Ordered from 20i; 20i checks the domain and installs it. Check HTTPS confirms it." });
      await recordActivity(db, { action: "site.wp_cert_issued", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: domain, paid: true, price: order.price ?? PAID_CERT_PRICE, confirmedBy: current.confirmedBy } });
      return;
    }
    await site.setCert("live", { ...current, state: "installing", note: `Install a certificate for ${domain} and www.${domain} in My20i (Manage hosting, SSL/TLS), then Check HTTPS.` });
  } catch (error) {
    await fail(`It stopped: ${error instanceof Error ? error.message : "no answer"}. Try again.`);
  }
}

/* Check HTTPS: the certificate the domain really serves, read as a browser would. */
export async function confirmIfServing(site: Site, domain: string): Promise<boolean> {
  const db = getDb();
  const [gl] = await db.select().from(goLive).where(eq(goLive.projectId, site.row.projectId)).limit(1);
  const notYet = async (text: string) => {
    if (gl) await db.update(goLive).set({ lastError: text.trim(), updatedAt: new Date() }).where(eq(goLive.projectId, site.row.projectId));
    return false;
  };
  // Until the records point at the package, https://<domain> is whatever answers there now (often the client's old site, with a valid
  // certificate of its own): that must never confirm this site's HTTPS (Fable's code review, finding 2).
  const why = await recordsPointAt(domain, site.row.packageIpv4 ?? "");
  if (why) return notYet(`Check HTTPS can't confirm yet: ${why}`);
  const probe = await probeTls(domain);
  const live = site.certs().live;
  if (!probe.ok) {
    const hint = live?.state === "installing" ? (live.note ?? "") : "Get the certificate first.";
    return notYet(`HTTPS isn't ready on ${domain} yet (${probe.reason ?? "no answer"}). ${hint}`);
  }
  // TAWD's own certificate: the one served has to be the one TAWD installed (its end date within a day), not an older one still answering.
  if (live?.source === "letsencrypt" && live.state !== "ok" && live.expiresAt && probe.validTo && Math.abs(probe.validTo.getTime() - Date.parse(live.expiresAt)) > 86_400_000) {
    return notYet(`${domain} still serves another certificate (${probe.issuer ?? "unknown issuer"}, until ${probe.validTo.toISOString().slice(0, 10)}), not the one TAWD installed (until ${live.expiresAt.slice(0, 10)}). 20i can take up to 30 minutes; Check HTTPS again later.`);
  }
  await site.setCert("live", {
    ...(live ?? { source: "manual" as CertPath, host: domain, note: null }),
    state: "ok",
    host: domain,
    issuer: probe.issuer,
    issuedAt: live?.issuedAt ?? probe.validFrom?.toISOString() ?? null,
    expiresAt: probe.validTo?.toISOString() ?? live?.expiresAt ?? null,
    note: null,
    warned: live?.expiresAt === (probe.validTo?.toISOString() ?? null) ? (live?.warned ?? []) : [],
  });
  if (gl && !gl.httpsConfirmedAt) {
    await db.update(goLive).set({ httpsConfirmedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(goLive.projectId, site.row.projectId));
    await recordActivity(db, { action: "golive.https_confirmed", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { domain, issuer: probe.issuer, expiresAt: probe.validTo?.toISOString() ?? null } });
    await postProjectSlack(db, site.row.projectId, { kind: "golive_step", step: `HTTPS works on https://${domain}.` });
  } else if (gl) {
    await db.update(goLive).set({ lastError: null, updatedAt: new Date() }).where(eq(goLive.projectId, site.row.projectId));
  }
  return true;
}

async function checkLiveHttps(site: Site): Promise<void> {
  if (!site.row.liveDomain || !site.row.domainOnHostAt) return;
  await confirmIfServing(site, site.row.liveDomain);
}

/* Check HTTPS on the preview's address. */
async function checkPreviewHttps(site: Site): Promise<void> {
  const host = site.row.host;
  if (!host || site.row.state !== "ready") return;
  const probe = await probeTls(host);
  const preview = site.certs().preview;
  if (probe.ok) {
    await site.setCert("preview", { ...(preview ?? { source: "manual" as CertPath, note: null }), state: "ok", host, issuer: probe.issuer, issuedAt: preview?.issuedAt ?? probe.validFrom?.toISOString() ?? null, expiresAt: probe.validTo?.toISOString() ?? null, note: null });
  }
  // The deploy's HTTPS step follows too, so the list doesn't keep saying "install" once it works.
  const steps = ((site.row.steps as PreviewStep[]) ?? []).map((s) => (s.key === "cert" && probe.ok ? { ...s, state: "done" as const, detail: `https://${host} works.` } : s));
  await site.patch({ https: probe.ok, steps });
}

/* ---------- remove ---------- */

async function remove(site: Site): Promise<void> {
  const db = getDb();
  const row = site.row;
  const certs = site.certs();
  const paid = [certs.preview, certs.live].filter((c): c is WpCert => Boolean(c && c.source === "twentyi_paid" && c.paidId));
  const previewRecord = Boolean(row.packageId && isOnPreviewDomain(row));
  const steps = removeSteps({ paidCertificate: paid.length > 0, previewRecord });
  const api = getTwentyi();

  if (!row.packageId) {
    // Nothing at 20i: a deploy that stopped before the package, or a preview left from Bluehost (5 October 2026).
    const fromBluehost = Boolean(row.host && !row.packageDomain);
    for (const step of steps) {
      step.state = "done";
      step.detail = step.key === "remove_package" ? (fromBluehost ? `This preview was on Bluehost (${row.host}). TAWD no longer signs in there: if its folder and database are still in cPanel, remove them by hand.` : "Nothing was made at 20i.") : "Nothing to do.";
    }
    await site.patch({ state: "removed", https: false, failureReason: null, steps });
    await recordActivity(db, { action: "site.wp_preview_removed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: row.host, bluehost: fromBluehost } });
    return;
  }

  const done = await runSteps(
    site,
    steps,
    "steps",
    {
      // 20i's API has no call to cancel a certificate (20i.apib, SSL/TLS Certificates): an admin does it in My20i, and the step says so.
      remove_certificate: async () => ({
        detail: `20i's certificate for ${paid.map((c) => `${c.host} (${c.paidId})`).join(", ")} can't be cancelled through 20i's API: an admin cancels it in My20i (Manage Reseller, SSL certificates) so it isn't renewed.`,
        warn: true,
      }),
      remove_record: async () => {
        const cf = getCloudflareDns();
        const zone = await cf.zoneFor(row.host!);
        if (zone) await cf.removeA(zone.id, row.host!);
        return { detail: zone ? `${row.host} removed from Cloudflare.` : "It wasn't there." };
      },
      remove_package: async () => {
        try {
          await api.deletePackage(row.packageId!);
        } catch (error) {
          if (error instanceof TwentyiError && error.kind === "not_found") return { detail: `Package ${row.packageId} wasn't there any more.` };
          throw error;
        }
        await recordActivity(db, { action: "site.wp_package_deleted", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { packageId: row.packageId, domain: row.packageDomain } });
        return { detail: `Package ${row.packageId} deleted at 20i, with its files, database and SSH access.` };
      },
    },
    { state: "failed" },
  );
  if (!done) return;
  // A live site taken down by an admin leaves Live everywhere (its backups stay in R2 until the project is deleted); the domain it
  // no longer serves is cleared too, so nothing offers to open it (Fable's code review, findings 7 and 23).
  const wasLive = row.liveState === "live";
  const liveDomain = row.liveDomain;
  await site.patch({ state: "removed", https: false, failureReason: null, steps, packageId: null, packageIpv4: null, dbName: null, dbUser: null, dbHost: null, certs: {}, suspendedAt: null, liveState: null, domainOnHostAt: null, liveDomain: null, liveAt: null, liveFormId: null });
  await recordActivity(db, { action: "site.wp_preview_removed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: row.host, liveDomain: wasLive ? liveDomain : null } });
  if (wasLive) {
    const now = new Date();
    await db.update(goLive).set({ liveUrl: null, liveVersion: null, httpsConfirmedAt: null, updatedAt: now }).where(eq(goLive.projectId, row.projectId));
    const [before] = await db.select({ status: project.status }).from(project).where(eq(project.id, row.projectId)).limit(1);
    if (before?.status === "live") {
      // Paused: no longer Live, so the project can be deleted next if the client has left.
      await db.update(project).set({ status: "paused", updatedAt: now }).where(eq(project.id, row.projectId));
      await recordActivity(db, { action: "project.status_changed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { status: "live" }, valueAfter: { status: "paused", reason: `The WordPress site on ${liveDomain ?? "its domain"} was taken down (Remove the site).` } });
    }
  }
}

/* Something before the steps went wrong (the settings, the connection): the card says why. */
export async function markWpPreviewFailed(projectId: string, message: string, job?: Pick<WpPreviewJobData, "action" | "target">): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
  if (!row) return;
  // A certificate job that stopped: its certificate says why instead of "on its way" for ever (Fable's code review, finding 3).
  if (job?.action === "cert") {
    const which = job.target === "preview" ? "preview" : "live";
    const cert = readCerts(row.certs)[which];
    if (cert?.state === "requested") await new Site(row).setCert(which, { ...cert, state: "failed", note: message.slice(0, 500) });
    return;
  }
  // B3: a live-site job that stopped before its steps (the connection, the settings).
  if (row.liveState === "attaching" || row.liveState === "going_live" || row.liveState === "rolling_back") {
    await db
      .update(wpPreview)
      .set({ liveState: row.liveState === "attaching" ? null : "failed", domainOnHostNote: row.liveState === "attaching" ? message.slice(0, 500) : row.domainOnHostNote, updatedAt: new Date() })
      .where(eq(wpPreview.projectId, projectId));
    return;
  }
  if (row.state !== "deploying" && row.state !== "removing") return;
  const steps = (row.steps as PreviewStep[]).map((s) => (s.state === "working" ? { ...s, state: "failed" as const, detail: message.slice(0, 500) } : s));
  await db.update(wpPreview).set({ state: "failed", failureReason: message.slice(0, 1000), steps, updatedAt: new Date() }).where(eq(wpPreview.projectId, projectId));
}

/* ---------- B3: the live site ---------- */

/* Put the domain on 20i: the client's domain (and www) added to the site's own package. */
async function attach(site: Site): Promise<void> {
  const db = getDb();
  const row = site.row;
  const [gl] = await db.select().from(goLive).where(eq(goLive.projectId, row.projectId)).limit(1);
  const domain = gl?.domain;
  if (!domain) throw new Error("The domain isn't confirmed yet.");
  const id = site.packageId();
  try {
    const pkg = await getTwentyi().getPackage(id);
    if (!pkg?.names.includes(domain)) await getTwentyi().addDomain(id, domain);
    if (!pkg?.names.includes(`www.${domain}`)) await getTwentyi().addDomain(id, `www.${domain}`);
  } catch (error) {
    await site.patch({ liveState: null, domainOnHostNote: `20i didn't add ${domain}: ${error instanceof Error ? error.message : "no answer"}` });
    return;
  }
  await site.patch({ liveState: null, liveDomain: domain, domainOnHostAt: new Date(), domainOnHostNote: null });
  await recordActivity(db, { action: "site.wp_domain_on_host", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { domain, packageId: id } });
  // The records already pointed before the domain was on 20i: TAWD's own certificate is asked for now, as it would have been when
  // they first passed, so the order of the two clicks doesn't matter (Fable's code review, finding 12).
  const current = site.certs().live;
  if (gl.recordsOkAt && (await certPathSetting()) === "letsencrypt" && (!current || current.state === "failed")) {
    await site.setCert("live", { state: "requested", source: "letsencrypt", host: domain, issuer: null, issuedAt: null, expiresAt: null, note: null, warned: [], requestedAt: new Date().toISOString(), installedAt: current?.installedAt ?? null });
    await recordActivity(db, { action: "site.wp_cert_requested", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: domain, path: "letsencrypt", by: "auto" } });
    await liveCert(site);
  }
}

/*
  Go live found no working certificate on the client's domain (its first step, Jason 3 November 2026). Nothing has changed: WordPress
  is still on the preview's address and search engines are still kept out. The gate asks for HTTPS again, TAWD's own certificate is
  asked for again where that is the path (never one 20i may still be showing), and the team is told. Returns the step's words.
*/
async function httpsNotReady(site: Site, domain: string): Promise<string> {
  const db = getDb();
  const row = site.row;
  const [gl] = await db.select({ lastError: goLive.lastError }).from(goLive).where(eq(goLive.projectId, row.projectId)).limit(1);
  const why = gl?.lastError ?? `HTTPS isn't ready on ${domain}.`;
  await db.update(goLive).set({ httpsConfirmedAt: null, updatedAt: new Date() }).where(eq(goLive.projectId, row.projectId));
  let next = "When Check HTTPS passes, press Go live again.";
  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the worker's log only
  try {
    const current = site.certs().live;
    /*
      Asked for again only when it can work and can't waste anything (hand review of PR #24): TAWD's own path, the records already
      pointing at the package (otherwise Let's Encrypt can't check, and the request would fail with a second Slack message), and no
      certificate of TAWD's in place (none, or one that failed). One that is "ok" but not answering is left to Check HTTPS and the
      Go live page's own button, so a passing network blip never spends Let's Encrypt's weekly limit; a paid or hand-installed one
      is never replaced.
    */
    const ownOrNone = !current || current.source === "letsencrypt";
    if (
      row.domainOnHostAt &&
      (await certPathSetting()) === "letsencrypt" &&
      ownOrNone &&
      (!current || current.state === "failed") &&
      recentlyInstalled(current) === null &&
      !(await recordsPointAt(domain, row.packageIpv4 ?? ""))
    ) {
      await site.setCert("live", { state: "requested", source: "letsencrypt", host: domain, issuer: null, issuedAt: null, expiresAt: null, note: null, warned: current?.warned ?? [], requestedAt: new Date().toISOString(), installedAt: current?.installedAt ?? null });
      await recordActivity(db, { action: "site.wp_cert_requested", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: domain, path: "letsencrypt", by: "go live" } });
      await liveCert(site);
      next = `TAWD asked for the certificate again (now: ${site.certs().live?.state ?? "unknown"}). When Check HTTPS passes, press Go live again.`;
    }
  } catch (error) {
    // The stop stands either way; the certificate can still be asked for on the Go live page.
    console.error(`Go live's certificate request again: ${error instanceof Error ? error.message : "no answer"}`);
  }
  await recordActivity(db, { action: "golive.https_not_ready", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { domain, reason: why.slice(0, 300), stillAt: row.host } });
  await postProjectSlack(db, row.projectId, { kind: "golive_step", step: `Go live stopped before changing anything: https://${domain} has no working certificate yet. The site is still on its preview.` });
  // An earlier Go live that stopped part way may already have moved WordPress: then this stop changed nothing more, but the site isn't simply "on its preview".
  const earlier = ((row.backups as SiteBackup[]) ?? []).some((b) => b.kind === "golive");
  const where = earlier ? `An earlier Go live got further, so check the site at ${row.host} and https://${domain} before trying again.` : `The site is still on its preview at ${row.host}, and search engines are still kept out.`;
  return `Stopped before changing anything: ${why.trim()} ${where} ${next}`;
}

/* A backup of the database and the files, streamed straight to R2 (never kept on the hosting, never whole in memory). */
async function backup(site: Site, kind: SiteBackup["kind"]): Promise<SiteBackup> {
  const session = await site.ssh();
  const t = site.target();
  const storage = getStorage();
  // The stamp names the backup's R2 files: never one a kept backup already has (two in the same second would share files).
  const taken = new Set(((site.row.backups as SiteBackup[]) ?? []).map((b) => b.stamp));
  let at = new Date();
  while (taken.has(backupStamp(at))) at = new Date(at.getTime() + 1000);
  const stamp = backupStamp(at);
  const keys = backupKeys(site.row.projectId, stamp);
  let sqlBytes = 0;
  let fileBytes = 0;
  const dumped = await session.runStreamOut(
    commands.dumpDatabase(t),
    async (out) => {
      sqlBytes = await putStreamTo(storage, keys.sqlKey, out, "application/gzip");
    },
    900_000,
  );
  // An empty dump can't be a WordPress database: refused like a failed one (Fable's code review, finding 1). Measured gzipped, so
  // "empty" is under MIN_SQL_BACKUP_BYTES: gzip of nothing is about 20 bytes (13 October 2026, the whole-code review).
  if (!ok(dumped) || sqlBytes < MIN_SQL_BACKUP_BYTES) {
    await storage.remove(keys.sqlKey).catch(() => undefined);
    throw new StepFailed(`The database backup stopped: ${!ok(dumped) ? briefly(dumped) || `code ${dumped.code ?? "unknown"}` : `it was empty (${sqlBytes} bytes compressed)`}`);
  }
  const archived = await session.runStreamOut(
    commands.archiveFiles(t),
    async (out) => {
      fileBytes = await putStreamTo(storage, keys.filesKey, out, "application/gzip");
    },
    1_800_000,
  );
  if (!ok(archived) || fileBytes === 0) {
    await storage.remove(keys.sqlKey).catch(() => undefined);
    await storage.remove(keys.filesKey).catch(() => undefined);
    throw new StepFailed(`The files backup stopped: ${!ok(archived) ? briefly(archived) || `code ${archived.code ?? "unknown"}` : "it was empty (0 bytes)"}`);
  }
  const entry: SiteBackup = { at: new Date().toISOString(), kind, version: site.row.deployedVersion, stamp, ...keys, bytes: sqlBytes + fileBytes };
  const all = [entry, ...((site.row.backups as SiteBackup[]) ?? [])];
  for (const old of all.slice(BACKUPS_KEPT)) {
    for (const key of [old.sqlKey, old.filesKey]) if (key) await storage.remove(key).catch(() => undefined);
  }
  await site.patch({ backups: all.slice(0, BACKUPS_KEPT) });
  return entry;
}

const megabytes = (bytes: number | undefined) => `${((bytes ?? 0) / 1_048_576).toFixed(1)} MB`;

async function liveJob(site: Site, action: "golive" | "rollback" | "undo_rollback"): Promise<void> {
  const db = getDb();
  const row = site.row;
  const [gl] = await db.select().from(goLive).where(eq(goLive.projectId, row.projectId)).limit(1);
  const domain = gl?.domain;
  if (!gl || !domain) throw new Error("The domain isn't confirmed yet.");
  const steps = freshSteps(action === "golive" ? GOLIVE_STEPS : action === "rollback" ? ROLLBACK_STEPS : UNDO_ROLLBACK_STEPS);

  if (action === "golive") {
    const live = `https://${domain}`;
    let formId: number | null = null;
    const done = await runSteps(
      site,
      steps,
      "liveSteps",
      {
        https: async () => {
          if (await confirmIfServing(site, domain)) {
            const cert = site.certs().live;
            return { detail: `${live} serves an active certificate${cert?.issuer ? ` from ${cert.issuer}` : ""}${cert?.expiresAt ? `, valid until ${cert.expiresAt.slice(0, 10)}` : ""}.` };
          }
          throw new StepFailed(await httpsNotReady(site, domain));
        },
        backup: async () => {
          const b = await backup(site, "golive");
          return { detail: `Saved in TAWD's storage (${megabytes(b.bytes)}). Roll back restores it.` };
        },
        address: async () => {
          const session = await site.ssh();
          const t = site.target();
          // Every link and picture, from the preview's address to the client's own.
          for (const from of [`https://${row.host}`, `http://${row.host}`]) need(await session.run(commands.searchReplace(t, from, live), 600_000), "Moving the site to its address");
          for (const command of commands.setUrls(t, live)) need(await session.run(command), "Setting the site's address");
          return { detail: `${row.host} became ${domain}.` };
        },
        search: async () => {
          const session = await site.ssh();
          const t = site.target();
          need(await session.run(commands.searchEngines(t, true)), "Letting search engines in");
          const id = Number((await session.run(commands.liveFormId(t))).output.trim().split(/\s+/)[0]);
          formId = Number.isInteger(id) && id > 0 ? id : null;
          return { detail: "Search engines may index the site now (Rank Math writes its sitemap)." };
        },
        cache: async () => purgeFor(site, [domain, `www.${domain}`]),
        check: async () => {
          const probe = await probeTls(domain);
          return probe.ok ? { detail: `${live} answers over HTTPS.` } : { detail: `${live} doesn't answer over HTTPS yet (${probe.reason ?? "no answer"}). The site is live; Check HTTPS again in a few minutes.`, warn: true };
        },
      },
      { liveState: "failed" },
    );
    if (!done) return;
    const now = new Date();
    await site.patch({ liveSteps: steps, liveState: "live", liveAt: row.liveAt ?? now, liveDomain: domain, liveFormId: formId });
    await db.update(goLive).set({ liveVersion: row.deployedVersion, liveUrl: `${live}/`, wentLiveAt: gl.wentLiveAt ?? now, lastError: null, updatedAt: now }).where(eq(goLive.projectId, row.projectId));
    const [before] = await db.select({ status: project.status, liveAt: project.liveAt }).from(project).where(eq(project.id, row.projectId)).limit(1);
    await db.update(project).set({ status: "live", updatedAt: now, ...(before?.liveAt ? {} : { liveAt: now }) }).where(eq(project.id, row.projectId));
    await recordActivity(db, { action: "golive.went_live", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { url: `${live}/`, version: row.deployedVersion, wordpress: true, startedBy: row.startedByUserId } });
    if (before?.status !== "live") await recordActivity(db, { action: "project.status_changed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { status: before?.status ?? null }, valueAfter: { status: "live", reason: `Went live at ${live}/` } });
    await postProjectSlack(db, row.projectId, { kind: "went_live", url: `${live}/`, version: row.deployedVersion ?? 0 });
    return;
  }

  /*
    Roll back: the newest backup that isn't a Roll back's own, whole (database
    and files), streamed back from R2. The site as it is now is backed up
    first (kind "rollback"), so Undo the roll back can put it back (Fable's
    code review, finding 10). Undo the roll back restores that one.
  */
  const undo = action === "undo_rollback";
  const storage = getStorage();
  const target = undo ? undoTarget((row.backups as SiteBackup[]) ?? []) : rollbackTarget((row.backups as SiteBackup[]) ?? []);
  if (!target) {
    steps.at(-1)!.state = "failed";
    steps.at(-1)!.detail = undo ? "There's no Roll back to undo." : "There's no backup to restore.";
    await site.patch({ liveSteps: steps, liveState: "failed" });
    return;
  }
  const wasLive = Boolean(gl.liveUrl);
  /*
    This same Roll back delivered again (audit F-051, 12 November 2026): the
    web app resets the steps when a Roll back starts, so a backup step
    already done means an earlier delivery took the backup and the worker
    stopped after it, perhaps mid-restore. Backing up again would save a
    half-restored site for Undo the roll back to put back.
  */
  const earlierBackup = ((row.liveSteps as PreviewStep[] | null) ?? []).find((s) => s.key === "backup" && s.state === "done");
  const done = await runSteps(
    site,
    steps,
    "liveSteps",
    {
      backup: async () => {
        if (earlierBackup) return { detail: `${earlierBackup.detail ?? "Saved."} Kept from before the worker restarted; not taken again over a site that may be half restored.` };
        // Only a site that is live has a state worth coming back to (a failed go-live is rolled back, not undone).
        if (!wasLive) return { detail: "Not needed: the site isn't live." };
        const b = await backup(site, "rollback");
        return { detail: `Saved in TAWD's storage (${megabytes(b.bytes)}). Undo the roll back restores it.` };
      },
      restore: async () => {
        if (!target.sqlKey || !target.filesKey) throw new StepFailed("This backup was made on Bluehost and can't be restored on 20i.");
        const session = await site.ssh();
        const t = site.target();
        const files = await readBackup(storage, target.filesKey, "files");
        need(await session.runStreamIn(commands.restoreFiles(t), files, 1_800_000), "Restoring the files");
        const sql = await readBackup(storage, target.sqlKey, "database");
        need(await session.runStreamIn(commands.restoreDatabase(t), sql, 900_000), "Restoring the database");
        const purged = await purgeFor(site, [domain, row.host]);
        return { detail: `Restored the backup from ${target.at.slice(0, 16).replace("T", " ")} UTC.${purged.warn ? ` ${purged.detail}` : ""}`, warn: purged.warn };
      },
    },
    { liveState: "failed" },
  );
  if (!done) return;
  // The restored backup is used up: its entry and its two files in R2 both go (nothing left orphaned until project deletion).
  const rest = ((site.row.backups as SiteBackup[]) ?? []).filter((b) => b.stamp !== target.stamp);
  for (const key of [target.sqlKey, target.filesKey]) if (key) await storage.remove(key).catch(() => undefined);
  const now = new Date();
  if (target.kind === "golive") {
    // Back to before go-live: the preview address, hidden from search engines; the project leaves Live.
    await site.patch({ liveSteps: steps, liveState: "rolled_back", backups: rest });
    await db.update(goLive).set({ liveUrl: null, liveVersion: null, updatedAt: now }).where(eq(goLive.projectId, row.projectId));
    await db.update(project).set({ status: "build", updatedAt: now }).where(eq(project.id, row.projectId));
    await recordActivity(db, { action: "project.status_changed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { status: "live" }, valueAfter: { status: "build", reason: "The WordPress site was rolled back to before go-live." } });
  } else {
    // A live site again (an update undone, or a Roll back undone): on its domain, the project Live.
    await site.patch({ liveSteps: steps, liveState: "live", liveDomain: domain, backups: rest, deployedVersion: target.version });
    await db.update(goLive).set({ liveVersion: target.version, liveUrl: `https://${domain}/`, updatedAt: now }).where(eq(goLive.projectId, row.projectId));
    const [before] = await db.select({ status: project.status }).from(project).where(eq(project.id, row.projectId)).limit(1);
    if (before && before.status !== "live") {
      await db.update(project).set({ status: "live", updatedAt: now }).where(eq(project.id, row.projectId));
      await recordActivity(db, { action: "project.status_changed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { status: before.status }, valueAfter: { status: "live", reason: "The WordPress site's Roll back was undone." } });
    }
  }
  await recordActivity(db, { action: "golive.rolled_back", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { wordpress: true, backup: target.stamp, kind: target.kind, undo } });
  await postProjectSlack(db, row.projectId, { kind: "rolled_back", url: gl.liveUrl ?? `https://${domain}/`, version: target.version ?? 0 });
}

/* A backup's file from R2 for a restore: "gone" only when R2 says so; any other answer is said as it is, with Try again (finding 16). */
async function readBackup(storage: ReturnType<typeof getStorage>, key: string, what: "files" | "database") {
  let stream: Awaited<ReturnType<typeof getStreamFrom>>;
  try {
    stream = await getStreamFrom(storage, key);
  } catch (error) {
    throw new StepFailed(`The backup's ${what} couldn't be read from TAWD's storage (R2 answered: ${error instanceof Error ? error.message : "nothing"}). Try again.`);
  }
  if (!stream) throw new StepFailed(`The backup's ${what} ${what === "files" ? "are" : "is"} gone from TAWD's storage.`);
  return stream;
}

/* ---------- Suspend, Restore, Purge (admins; 20i, 5 October 2026) ---------- */

async function suspendOrRestore(site: Site, action: "suspend" | "restore", by: string | null): Promise<void> {
  const db = getDb();
  const enabled = action === "restore";
  const what = action === "suspend" ? "suspend" : "restore";
  try {
    await getTwentyi().setPackageEnabled(site.packageId(), enabled);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "no answer";
    await recordActivity(db, { action: enabled ? "site.wp_restored" : "site.wp_suspended", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { ok: false, reason, requestedBy: by } });
    await teamSlack(`:warning: 20i didn't ${what} the WordPress site ${site.row.liveDomain ?? site.row.host ?? site.row.name}: ${reason}`);
    return;
  }
  await site.patch({ suspendedAt: enabled ? null : new Date() });
  await recordActivity(db, { action: enabled ? "site.wp_restored" : "site.wp_suspended", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { ok: true, packageId: site.row.packageId, requestedBy: by } });
}

async function purge(site: Site, by: string | null): Promise<void> {
  const result = await purgeFor(site, [site.row.host, site.row.liveState === "live" ? site.row.liveDomain : null]);
  await recordActivity(getDb(), { action: "site.wp_cache_purged", entityType: "project", entityId: site.row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { ok: !result.warn, detail: result.detail, requestedBy: by } });
}
