import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { getDb } from "@tawd/core/db";
import { rdapDomainUrl, rdapExpiry } from "@tawd/core/site";
import {
  daysUntil,
  DOMAIN_CHECK_EVERY_MS,
  DOMAIN_UNREAD_ALERT_MS,
  domainWarningDue,
  HOLDER_ASK_AGAIN_MS,
  HOLDER_TEST_MAX_MS,
  holderAlertDue,
  PREVIEW_HOLDER_SETTING,
  previewDomainSetting,
  TWENTYI_SILENT_ALERT_MS,
  type PreviewHolderState,
} from "@tawd/core/wp-preview";
import { getTwentyi } from "./twentyi";
import { saveSetting, setting, teamSlack } from "./wp-preview";

/*
  The preview domain's watch (0.122.0, Jason 3 November 2026), run every hour on the WordPress queue. Since 0.119.0 every WordPress
  preview, and every site that went live from one, is a subdomain package of the preview domain at 20i: if the placeholder package
  (the preview domain's own) is off or gone, or the domain's registration lapses, they all go down.

  1. The placeholder: found off at 20i, TAWD switches it back on (and waits an hour before asking again: 20i can take that long to
     show it). The team's Slack is told the first time it is found off or missing, and again once a day while it stays that way; once
     it is back, one line says so. A 20i API that doesn't answer, or answers with no packages at all, isn't "off": after 24 hours of
     that, the team is told once (a revoked key, or 20i's approved-address list after a server move).
  2. The domain: once a day, its expiry date from RDAP. The team is told 30, 14, 7, 3 and 1 days before, then every day from the day
     before and after it lapses. When RDAP doesn't answer, the date already known keeps the warnings going; three days without an
     answer is said once.

  A switch-off check still running from before 0.119.0 owns the placeholder: the watch leaves it alone, for at most HOLDER_TEST_MAX_MS
  from the check's start (it takes about 2.5 hours); after that the check has stopped and the watch takes the placeholder back.
  Never throws; says what it found.
*/

type RegistryFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
let registryFetch: RegistryFetch | null = null;

/** Tests pass a stand-in for RDAP. */
export function setHolderWatchRdapForTesting(stand: RegistryFetch | null): void {
  registryFetch = stand;
}

export async function runHolderWatch(now = new Date()): Promise<string> {
  const domain = previewDomainSetting();
  if (!domain) return "No preview domain set: nothing to watch.";
  const lines: string[] = [];
  lines.push(await watchPackage(domain, now));
  lines.push(await watchDomain(domain, now));
  return lines.filter(Boolean).join(" ");
}

type Watch = NonNullable<PreviewHolderState["watch"]>;
const at = (iso: string) => iso.slice(0, 16).replace("T", " ");

async function watchPackage(domain: string, now: Date): Promise<string> {
  try {
    let state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
    const packageId = state.packageId;
    if (!packageId) return "No placeholder package yet (the first preview makes it).";
    let tookOver = false;
    if (state.test) {
      const started = Date.parse(state.test.startedAt);
      if (Number.isFinite(started) && now.getTime() - started < HOLDER_TEST_MAX_MS) return "The old switch-off check is still running: left to it.";
      // Longer than the check can take: it stopped. Its leftover is taken out so nothing waits on it again.
      const rest = { ...state };
      delete rest.test;
      state = rest;
      tookOver = true;
      await recordActivity(getDb(), { action: "site.wp_preview_holder_test_abandoned", entityType: "setting", entityId: PREVIEW_HOLDER_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { packageId: packageId, startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null } });
    }
    const watch: Watch = state.watch ?? { offSince: null, lastAlertAt: null };
    const prefix = tookOver ? "The old switch-off check had stopped; the watch took the placeholder back. " : "";

    let packages: Awaited<ReturnType<ReturnType<typeof getTwentyi>["listPackages"]>> | null = null;
    let silentWhy = "";
    try {
      packages = await getTwentyi().listPackages();
      // The placeholder is in the account, so an empty list is 20i answering oddly, never "gone".
      if (packages.length === 0) {
        packages = null;
        silentWhy = "an empty package list";
      }
    } catch (error) {
      silentWhy = error instanceof Error ? error.message.slice(0, 120) : "no answer";
    }
    if (!packages) {
      // 20i not answering says nothing about the placeholder: the next hour looks again. A whole day of it is said once.
      const unansweredSince = watch.unansweredSince ?? now.toISOString();
      const sayIt = !watch.unansweredAlerted && now.getTime() - Date.parse(unansweredSince) >= TWENTYI_SILENT_ALERT_MS;
      await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, watch: { ...watch, unansweredSince, unansweredAlerted: Boolean(watch.unansweredAlerted || sayIt) } });
      if (sayIt) {
        await teamSlack(
          `:warning: TAWD hasn't been able to check its placeholder package for ${domain} at 20i since ${at(unansweredSince)} UTC (20i's API isn't answering: ${silentWhy}). If the placeholder goes off, TAWD can't see it or switch it back on. Check that 20i's Reseller API key is valid and that its approved-address list holds TAWD's server address.`,
        );
      }
      return `${prefix}20i didn't answer (${silentWhy}).`;
    }
    const answered: Watch = { ...watch, unansweredSince: null, unansweredAlerted: false };

    const holder = packages.find((p) => p.id === packageId);
    if (holder?.enabled) {
      if (watch.offSince) {
        await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, watch: { ...answered, offSince: null, lastAlertAt: null, askedOnAt: null } });
        await teamSlack(`:white_check_mark: TAWD's placeholder package for ${domain} (package ${packageId}) is on again at 20i. Previews and live WordPress sites on ${domain} can load.`);
        return `${prefix}The placeholder is on again.`;
      }
      if (tookOver || watch.unansweredSince || watch.askedOnAt) await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, watch: { ...answered, askedOnAt: null } });
      return `${prefix}The placeholder is on.`;
    }
    // Off: switched back on where 20i lets TAWD, once an hour at most (20i can take that long to show it).
    // Gone: only a person can sort it out (a new placeholder doesn't bring old packages back).
    let switchedOn = false;
    let askedAlready = false;
    let why = "";
    let askedOnAt = watch.askedOnAt ?? null;
    if (holder) {
      if (askedOnAt && now.getTime() - Date.parse(askedOnAt) < HOLDER_ASK_AGAIN_MS) {
        askedAlready = true;
      } else {
        try {
          await getTwentyi().setPackageEnabled(packageId, true);
          switchedOn = true;
          askedOnAt = now.toISOString();
          await recordActivity(getDb(), { action: "site.wp_preview_holder_switched_on", entityType: "setting", entityId: PREVIEW_HOLDER_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { packageId: packageId, when: "hourly" } });
        } catch (error) {
          why = error instanceof Error ? error.message.slice(0, 160) : "no answer";
        }
      }
    }
    const first = !watch.offSince;
    const alert = holderAlertDue(watch, now);
    const offSince = watch.offSince ?? now.toISOString();
    await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, watch: { ...answered, offSince, lastAlertAt: alert ? now.toISOString() : watch.lastAlertAt, askedOnAt: holder ? askedOnAt : null } });
    if (alert) {
      const what = !holder
        ? "gone from VML's 20i account"
        : switchedOn || askedAlready
          ? "switched off at 20i; TAWD asked 20i to switch it back on"
          : `switched off at 20i, and 20i wouldn't switch it back on (${why})`;
      const since = first ? "" : ` It has been like this since ${at(offSince)} UTC.`;
      await teamSlack(
        `:rotating_light: TAWD's placeholder package for ${domain} (package ${packageId}) is ${what}. Every WordPress preview and every live WordPress site on ${domain} depends on it.${since} Check it in My20i (Manage Hosting): never suspend, delete or let it lapse.`,
      );
    }
    if (!holder) return `${prefix}The placeholder is missing at 20i.`;
    return `${prefix}The placeholder was off${switchedOn ? ": asked back on" : askedAlready ? ": already asked back on, waiting for 20i" : ""}.`;
  } catch (error) {
    console.error(`The preview domain's watch, the package: ${error instanceof Error ? error.name : "not checked"}`);
    return "The placeholder wasn't checked.";
  }
}

async function watchDomain(domain: string, now: Date): Promise<string> {
  try {
    const state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
    const was = state.domain;
    if (was?.checkedAt && now.getTime() - Date.parse(was.checkedAt) < DOMAIN_CHECK_EVERY_MS) return "";
    let read: Date | null = null;
    try {
      // The domain's own registry (IANA's list), not rdap.org, which answers TAWD's server with a 403 page (0.122.1).
      const get = registryFetch ?? ((url: string) => fetch(url, { headers: { accept: "application/rdap+json, application/json" }, signal: AbortSignal.timeout(15_000) }));
      const response = await get(await rdapDomainUrl(domain, get));
      if (response.ok) read = rdapExpiry(await response.json());
    } catch {
      read = null;
    }

    // RDAP silent: the date already known keeps the warnings going; three days of silence is said once.
    let unreadSince: string | null = null;
    let unreadAlerted = false;
    let sayUnread = false;
    if (!read) {
      unreadSince = was?.unreadSince ?? now.toISOString();
      sayUnread = !was?.unreadAlerted && now.getTime() - Date.parse(unreadSince) >= DOMAIN_UNREAD_ALERT_MS;
      unreadAlerted = Boolean(was?.unreadAlerted || sayUnread);
    }
    const knownAt = was?.expiresAt ? new Date(was.expiresAt) : null;
    const expiresAt = read ?? (knownAt && Number.isFinite(knownAt.getTime()) ? knownAt : null);

    let alerted = was?.alerted ?? [];
    let lastDailyAlert = was?.lastDailyAlert ?? null;
    let said = false;
    let left: number | null = null;
    const iso = expiresAt?.toISOString() ?? null;
    if (expiresAt && iso) {
      // A new expiry date (renewed): the warnings start again.
      const same = was?.expiresAt === iso;
      alerted = same ? [...(was?.alerted ?? [])] : [];
      lastDailyAlert = same ? (was?.lastDailyAlert ?? null) : null;
      left = daysUntil(expiresAt, now);
      const today = now.toISOString().slice(0, 10);
      const expired = expiresAt.getTime() <= now.getTime();
      const note = read ? "" : ` (the last date TAWD read; the registry isn't answering right now)`;
      if (expired || left <= 1) {
        // From the day before, and after it lapses: every day.
        if (lastDailyAlert !== today) {
          lastDailyAlert = today;
          said = true;
          const hours = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000));
          await teamSlack(
            expired
              ? `:rotating_light: ${domain} expired on ${iso.slice(0, 10)}${note}. Every WordPress preview and live WordPress site on ${domain} depends on it: renew it at the registrar now.`
              : `:rotating_light: ${domain} expires in about ${hours} hour${hours === 1 ? "" : "s"} (${iso.slice(0, 16).replace("T", " ")} UTC)${note}. Every WordPress preview and live WordPress site on ${domain} depends on it: renew it at the registrar now.`,
          );
        }
      } else {
        const due = domainWarningDue(left, alerted);
        if (due !== null) {
          alerted.push(due);
          said = true;
          await teamSlack(`:warning: ${domain} expires in ${left} days (${iso.slice(0, 10)})${note}. Every WordPress preview and live WordPress site on ${domain} depends on it: make sure it renews at the registrar.`);
        }
      }
    }
    await saveSetting(PREVIEW_HOLDER_SETTING, { ...state, domain: { checkedAt: now.toISOString(), expiresAt: iso, alerted, lastDailyAlert, unreadSince, unreadAlerted } });
    if (sayUnread) await teamSlack(`:warning: TAWD hasn't been able to read ${domain}'s registration (its expiry date) for three days. Check in the registrar that ${domain} is still registered and set to renew: every WordPress preview and live WordPress site on it depends on it.`);
    if (!read) return `${domain}'s expiry date couldn't be read${iso ? ` (last known ${iso.slice(0, 10)})` : ""}${said ? "; the team was told" : ""}.`;
    return `${domain} expires ${iso!.slice(0, 10)} (${left} days)${said ? "; the team was told" : ""}.`;
  } catch (error) {
    console.error(`The preview domain's watch, the domain: ${error instanceof Error ? error.name : "not checked"}`);
    return "The domain wasn't checked.";
  }
}
