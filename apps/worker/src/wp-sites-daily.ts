import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { goLive, sshKey, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import { getCloudflareDns } from "@tawd/core/cloudflare-dns";
import { fetchDoh, snapshotDomain, type DohGet } from "@tawd/core/site";
import { TWENTYI_KEY_PURPOSE, WP_SITES_DAILY_SETTING, expiryWarningDue, onPreviewDomain, readCerts, renewalDue, type WpCert, type WpCerts } from "@tawd/core/wp-preview";
import type { WpSitesDailyJobData } from "@tawd/core/queue";

import { getTwentyi, isIpv4 } from "./twentyi";
import { explainAcme, probeTls } from "./wp-cert";
import { certFrom, certPathSetting, confirmIfServing, issueLetsEncrypt, keyReplacedSince, saveSetting, setting, Site, teamSlack, recoverPreviewHolder } from "./wp-preview";

/*
  The daily work for WordPress sites on 20i (5 October 2026; plan 3.6),
  queued by the web's hourly tick when the last run is older than 20 hours
  (a timer of 24 hours would restart on every deploy and never fire).

  For each site with a 20i package that isn't suspended or removed:
  - The IP watch: 20i can move a site to a new IPv4 without notice. TAWD
    reads the package's current IP, compares public DNS for the live domain
    (and the preview's own record), fixes the records itself where VML runs
    the DNS (Cloudflare), and otherwise tells the PM (Slack, once a day per
    site) what the client has to change.
  - Certificates: one still being installed is checked again; TAWD's own
    (Let's Encrypt) is renewed with a third of its life left; every kind
    warns at 14 and 7 days.
  The run's start and finish are stamped in app_setting wp_sites_daily, so
  System can say when it last ran. No AI, $0.
*/

let dohOverride: DohGet | null = null;

/** Tests answer the DNS questions themselves. */
export function setDailyDnsForTesting(get: DohGet | null): void {
  dohOverride = get;
}

interface Summary {
  sites: number;
  ipChanged: string[];
  fixed: string[];
  renewed: string[];
  warned: string[];
  problems: string[];
}

export async function runWpSitesDailyJob(job: WpSitesDailyJobData): Promise<string> {
  const db = getDb();
  const rows = await db
    .select()
    .from(wpPreview)
    .where(and(isNotNull(wpPreview.packageId), ne(wpPreview.state, "removed"), isNull(wpPreview.suspendedAt)));
  const summary: Summary = { sites: rows.length, ipChanged: [], fixed: [], renewed: [], warned: [], problems: [] };
  const [key] = await db.select({ createdAt: sshKey.createdAt }).from(sshKey).where(eq(sshKey.purpose, TWENTYI_KEY_PURPOSE)).limit(1);

  for (const row of rows) {
    const site = new Site(row);
    const name = row.liveDomain ?? row.host ?? row.name;
    // TAWD's key was replaced after this site's last deploy: its package doesn't have it, so a renewal (over SSH) would fail.
    // It's listed instead, and waits for Deploy again (Fable's code review, finding 13); the IP watch and warnings still run.
    const keyStale = Boolean(key && keyReplacedSince(key.createdAt, row.deployedAt));
    if (keyStale) summary.problems.push(`${name}: TAWD's 20i key was replaced after its last deploy; Deploy again adds it (renewals wait until then)`);
    try {
      await watchIp(site, summary);
      await certificates(site, summary, keyStale);
    } catch (error) {
      summary.problems.push(`${name}: ${error instanceof Error ? error.message : "it stopped"}`);
    } finally {
      site.close();
    }
  }

  // The preview domain's placeholder is never left off at 20i (12 October 2026; CodeRabbit, PR #2).
  const holder = await recoverPreviewHolder("daily");
  if (holder) summary.fixed.push(holder);

  const previous = (await setting<Record<string, unknown>>(WP_SITES_DAILY_SETTING)) ?? {};
  await saveSetting(WP_SITES_DAILY_SETTING, { ...previous, startedAt: job.at, finishedAt: new Date().toISOString(), summary: { ...summary } });
  if (summary.problems.length) await teamSlack(`:warning: WordPress sites, daily check: ${summary.problems.slice(0, 5).join("; ")}`);
  return `${summary.sites} site(s); IP changed ${summary.ipChanged.length}, fixed ${summary.fixed.length}; certificates renewed ${summary.renewed.length}, warned ${summary.warned.length}; problems ${summary.problems.length}.`;
}

const clean = (v: string) => v.toLowerCase().replace(/\.$/, "");

/* ---------- the IP watch ---------- */

async function watchIp(site: Site, summary: Summary): Promise<void> {
  const db = getDb();
  const row = site.row;
  const pkg = await getTwentyi().getPackage(row.packageId!);
  if (!pkg) {
    summary.problems.push(`${row.liveDomain ?? row.host}: 20i doesn't know package ${row.packageId} any more`);
    return;
  }
  const ip = pkg.ipv4;
  if (!ip || !isIpv4(ip)) return;
  if (ip !== row.packageIpv4) {
    await recordActivity(db, { action: "site.wp_ip_changed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { ip: row.packageIpv4 }, valueAfter: { ip, packageId: row.packageId } });
    summary.ipChanged.push(`${row.liveDomain ?? row.host}: ${row.packageIpv4 ?? "?"} → ${ip}`);
    await site.patch({ packageIpv4: ip });
  }

  // The preview's own record (D1 option B): VML runs that zone, so it's fixed here.
  if (row.host && onPreviewDomain(row)) {
    const cf = getCloudflareDns();
    const zone = await cf.zoneFor(row.host).catch(() => null);
    if (zone) {
      const records = await cf.aRecords(zone.id, row.host);
      if (records.length !== 1 || records[0]!.content !== ip) {
        await cf.setA(zone.id, row.host, ip);
        summary.fixed.push(`${row.host} (preview)`);
      }
    }
  }

  if (row.liveState !== "live" || !row.liveDomain) {
    await site.patch({ ipCheckedAt: new Date() });
    return;
  }
  const domain = row.liveDomain;
  const views = await snapshotDomain(domain, dohOverride ?? fetchDoh);
  const apex = [...new Set(views.flatMap((v) => v.snapshot.apexA))];
  const www = [...new Set(views.flatMap((v) => [...v.snapshot.wwwA, ...v.snapshot.wwwCname.map(clean)]))];
  const right = views.length > 0 && views.every((v) => v.snapshot.apexA.length === 1 && v.snapshot.apexA[0] === ip && (v.snapshot.wwwCname.some((c) => clean(c) === domain) || (v.snapshot.wwwA.length === 1 && v.snapshot.wwwA[0] === ip)));
  const note = (row.ipNote ?? {}) as { alertedAt?: string; fixedAt?: string };
  if (right || views.length === 0) {
    // Public DNS not answering says nothing either way: the last alert's time is kept, so a flaky day can't alert twice (finding 19).
    await site.patch({ ipCheckedAt: new Date(), ipNote: { apiIp: ip, apex, www, ok: right || null, alertedAt: right ? null : (note.alertedAt ?? null), fixedAt: note.fixedAt ?? null } });
    return;
  }

  const [gl] = await db.select().from(goLive).where(eq(goLive.projectId, row.projectId)).limit(1);
  if (gl?.connectPath === "vml_dns" && gl.cloudflareZoneId) {
    // VML runs the client's DNS: both names point at the package again, not proxied.
    const cf = getCloudflareDns();
    await cf.setA(gl.cloudflareZoneId, domain, ip);
    await cf.setA(gl.cloudflareZoneId, `www.${domain}`, ip);
    const fixedAt = new Date().toISOString();
    await site.patch({ ipCheckedAt: new Date(), ipNote: { apiIp: ip, apex, www, ok: false, alertedAt: null, fixedAt } });
    await recordActivity(db, { action: "site.wp_ip_fixed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { domain, ip } });
    await postProjectSlack(db, row.projectId, { kind: "golive_step", step: `20i moved the site to ${ip}; TAWD pointed ${domain} and www at it (VML's Cloudflare).` });
    summary.fixed.push(domain);
    return;
  }

  // The client's DNS: the PM hears once a day until it matches.
  const lastAlert = note.alertedAt ? Date.parse(note.alertedAt) : 0;
  const alertNow = Date.now() - lastAlert > 20 * 3_600_000;
  if (alertNow) {
    const text = `20i moved ${domain} to ${ip}, and the domain still points at ${apex.join(", ") || "nothing"}. The client changes the A record for ${domain} to ${ip} (Go live, Connect the domain shows it; Make a new client link sends them the steps again).`;
    await postProjectSlack(db, row.projectId, { kind: "golive_step", step: text });
    await teamSlack(`:warning: ${text}`);
  }
  await site.patch({ ipCheckedAt: new Date(), ipNote: { apiIp: ip, apex, www, ok: false, alertedAt: alertNow ? new Date().toISOString() : (note.alertedAt ?? null), fixedAt: null } });
}

/* ---------- certificates ---------- */

async function certificates(site: Site, summary: Summary, keyStale: boolean): Promise<void> {
  const db = getDb();
  const row = site.row;
  const path = await certPathSetting();
  for (const which of ["preview", "live"] as (keyof WpCerts)[]) {
    const cert = readCerts(site.row.certs)[which];
    if (!cert) continue;
    if (which === "live" && (row.liveState !== "live" || !row.liveDomain)) continue;

    // Still being installed (20i can take up to 30 minutes, or a hand install): look again.
    if (cert.state === "installing") {
      if (which === "live") await confirmIfServing(site, cert.host);
      else {
        const probe = await probeTls(cert.host);
        if (probe.ok) await site.setCert("preview", { ...cert, state: "ok", issuer: probe.issuer, expiresAt: probe.validTo?.toISOString() ?? cert.expiresAt, note: null });
      }
    }

    const now = readCerts(site.row.certs)[which]!;
    if (renewalDue(now) && path === "letsencrypt" && !keyStale) {
      const names = which === "live" ? [now.host, `www.${now.host}`] : [now.host];
      try {
        const issued = await issueLetsEncrypt(site, names);
        await site.setCert(which, certFrom(issued, now.host, "Renewed and installed at 20i; Check HTTPS confirms it."));
        await recordActivity(db, { action: "site.wp_cert_renewed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: now.host, expiresAt: issued.expiresAt.toISOString() } });
        summary.renewed.push(now.host);
        continue;
      } catch (error) {
        const reason = explainAcme(error);
        await site.setCert(which, { ...now, note: `Renewal failed: ${reason}` });
        await recordActivity(db, { action: "site.wp_cert_failed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { host: now.host, reason, renewal: true } });
        await postProjectSlack(db, row.projectId, { kind: "golive_step", step: `the HTTPS certificate for ${now.host} couldn't be renewed: ${reason}` });
        await teamSlack(`:warning: The HTTPS certificate for ${now.host} couldn't be renewed: ${reason}`);
      }
    }

    const latest: WpCert = readCerts(site.row.certs)[which]!;
    const warning = expiryWarningDue(latest);
    if (warning) {
      const text = `The HTTPS certificate for ${latest.host} runs out in ${warning} days or less (${latest.expiresAt?.slice(0, 10)}). ${latest.source === "letsencrypt" ? "TAWD's renewal hasn't worked: Get the certificate again on the Go live card." : latest.source === "twentyi_paid" ? "Check its renewal in My20i." : "Install a new one in My20i, then Check HTTPS."}`;
      await postProjectSlack(db, row.projectId, { kind: "golive_step", step: text });
      await teamSlack(`:warning: ${text}`);
      await site.setCert(which, { ...latest, warned: [...(latest.warned ?? []), warning] });
      summary.warned.push(latest.host);
    }
  }
}
