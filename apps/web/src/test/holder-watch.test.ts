import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, appSetting } from "@tawd/core/schema";
import { encryptSecret, setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { setSlackFetchForTesting } from "@tawd/core/slack";
import { rdapExpiry, resetRdapBootstrapForTesting, RDAP_BOOTSTRAP_URL } from "@tawd/core/site";
import { WP_HOLDER_WATCH_JOB, wpHolderWatchJobId } from "@tawd/core/queue";
import { domainWarningDue, holderAlertDue, PREVIEW_HOLDER_SETTING, type PreviewHolderState } from "@tawd/core/wp-preview";
import { setQueueForTesting } from "@/lib/mockups";
import { holderWatchTick } from "@/lib/wp-sites-daily";
import { runHolderWatch, setHolderWatchRdapForTesting } from "../../../worker/src/holder-watch";
import { setTwentyiForTesting } from "../../../worker/src/twentyi";
import { FakeTwentyi } from "../../../worker/src/twentyi-fake";
import { TwentyiError } from "../../../worker/src/twentyi";
import { createHarness, type Harness } from "./harness";

/*
  The preview domain's watch (0.122.0, Jason 3 November 2026): every hour, the placeholder package at 20i; once a day, the preview
  domain's expiry date. Live WordPress sites depend on both since 0.119.0.
*/

let h: Harness;
let twentyi: FakeTwentyi;
let posts: string[];
let rdap: { expires: string | null; fails: boolean; asked: number; urls: string[] };
let holderId: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-03T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const state = async () => ((await h.db.select().from(appSetting).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING)))[0]?.value ?? {}) as PreviewHolderState;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  vi.stubEnv("WP_PREVIEW_DOMAIN", "tawdpreviews.com");
  twentyi = new FakeTwentyi();
  setTwentyiForTesting(twentyi);
  holderId = await twentyi.createPackage({ typeId: "tawd-wp", domain: "tawdpreviews.com", label: "placeholder" });
  await h.db.insert(appSetting).values({ key: PREVIEW_HOLDER_SETTING, value: { packageId: holderId } });
  await h.db.insert(appSetting).values({ key: "team_slack", value: { webhookEncrypted: encryptSecret("https://hooks.slack.com/services/T/B/x"), hint: "xxxx" } });
  posts = [];
  setSlackFetchForTesting((async (_url: string, init?: RequestInit) => {
    posts.push((JSON.parse(String(init!.body)) as { text: string }).text);
    return new Response("ok");
  }) as never);
  rdap = { expires: "2027-11-01T00:00:00Z", fails: false, asked: 0, urls: [] };
  resetRdapBootstrapForTesting();
  setHolderWatchRdapForTesting(async (url: string) => {
    // IANA's list says which registry to ask (0.122.1); only the registry's answers are counted.
    if (url === RDAP_BOOTSTRAP_URL) return { ok: true, status: 200, json: async () => ({ services: [[["com"], ["https://rdap.verisign.com/com/v1/"]]] }) };
    rdap.asked += 1;
    rdap.urls.push(url);
    if (rdap.fails) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ events: rdap.expires ? [{ eventAction: "registration", eventDate: "2026-09-01T00:00:00Z" }, { eventAction: "expiration", eventDate: rdap.expires }] : [] }) };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  setHolderWatchRdapForTesting(null);
  setSlackFetchForTesting(null);
  setTwentyiForTesting(null);
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

describe("the placeholder package, every hour", () => {
  it("says nothing while it's on", async () => {
    expect(await runHolderWatch(T0)).toContain("The placeholder is on.");
    expect(posts.filter((p) => p.includes("placeholder"))).toEqual([]);
  });

  it("switches it back on and tells the team the first time it's found off, then once a day while it stays off, then that it's back", async () => {
    twentyi.packages.get(holderId)!.enabled = false;
    // 20i won't switch it back on (a billing hold, say): it stays off.
    twentyi.refuse.setPackageEnabled = new TwentyiError("20i said no (403): account on hold", "refused", 403);
    await runHolderWatch(T0);
    const alerts = () => posts.filter((p) => p.includes("placeholder package for tawdpreviews.com"));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain("is switched off at 20i, and 20i wouldn't switch it back on (20i said no (403): account on hold)");
    expect(alerts()[0]).toContain("Every WordPress preview and every live WordPress site on tawdpreviews.com depends on it.");
    expect((await state()).watch).toMatchObject({ offSince: T0.toISOString(), lastAlertAt: T0.toISOString() });
    // The next hours: tried again quietly.
    for (const hours of [1, 2, 12, 23]) await runHolderWatch(at(hours * HOUR));
    expect(alerts()).toHaveLength(1);
    // A day on: told again, with since when.
    await runHolderWatch(at(DAY));
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]).toContain("It has been like this since 2026-11-03 12:00 UTC.");
    // Back on: one line says so, and the watch starts afresh.
    twentyi.refuse = {};
    twentyi.packages.get(holderId)!.enabled = true;
    expect(await runHolderWatch(at(DAY + HOUR))).toContain("The placeholder is on again.");
    expect(posts.at(-1)).toContain("is on again at 20i");
    expect((await state()).watch).toMatchObject({ offSince: null, lastAlertAt: null, askedOnAt: null });
  });

  it("switches an off placeholder back on, logs it, and tells the team once", async () => {
    twentyi.packages.get(holderId)!.enabled = false;
    await runHolderWatch(T0);
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
    expect(posts.filter((p) => p.includes("TAWD asked 20i to switch it back on"))).toHaveLength(1);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_preview_holder_switched_on"))).toHaveLength(1);
    await runHolderWatch(at(HOUR));
    expect(posts.at(-1)).toContain("is on again");
  });

  it("tells the team when the placeholder is gone from the account", async () => {
    // The account still holds other packages (a client's preview), so 20i is answering.
    await twentyi.createPackage({ typeId: "tawd-wp", domain: "joes.tawdpreviews.com", label: "joes" });
    twentyi.packages.delete(holderId);
    expect(await runHolderWatch(T0)).toContain("The placeholder is missing at 20i.");
    expect(posts.some((p) => p.includes("is gone from VML's 20i account"))).toBe(true);
  });

  it("doesn't take a 20i that isn't answering for an off placeholder", async () => {
    twentyi.refuse.listPackages = new TwentyiError("20i said no (503)", "server", 503);
    expect(await runHolderWatch(T0)).toContain("20i didn't answer");
    expect(posts.filter((p) => p.includes("placeholder"))).toEqual([]);
    expect((await state()).watch?.offSince ?? null).toBeNull();
  });

  it("says once when 20i hasn't answered for a whole day, and starts afresh once it answers (review of PR #26)", async () => {
    twentyi.refuse.listPackages = new TwentyiError("20i said no (401): bad key", "refused", 401);
    for (const hours of [0, 1, 12, 23]) await runHolderWatch(at(hours * HOUR));
    expect(posts.filter((p) => p.includes("isn't answering"))).toEqual([]);
    await runHolderWatch(at(DAY));
    const silent = posts.filter((p) => p.includes("isn't answering"));
    expect(silent).toHaveLength(1);
    expect(silent[0]).toContain("since 2026-11-03 12:00 UTC");
    expect(silent[0]).toContain("approved-address list");
    expect(silent[0]).not.toContain("hooks.slack.com");
    await runHolderWatch(at(2 * DAY));
    expect(posts.filter((p) => p.includes("isn't answering"))).toHaveLength(1);
    twentyi.refuse = {};
    expect(await runHolderWatch(at(2 * DAY + HOUR))).toContain("The placeholder is on.");
    expect((await state()).watch).toMatchObject({ unansweredSince: null, unansweredAlerted: false });
  });

  it("takes an empty package list for 20i answering oddly, never for a missing placeholder (review of PR #26)", async () => {
    twentyi.listPackages = async () => [];
    expect(await runHolderWatch(T0)).toContain("20i didn't answer (an empty package list)");
    expect(posts.filter((p) => p.includes("gone from VML's 20i account"))).toEqual([]);
  });

  it("asks 20i to switch it on once an hour at most while 20i catches up (review of PR #26)", async () => {
    twentyi.packages.get(holderId)!.enabled = false;
    let asked = 0;
    // 20i takes its time to show the change: the package still reads off.
    twentyi.setPackageEnabled = async () => void (asked += 1);
    expect(await runHolderWatch(T0)).toContain("asked back on");
    expect(await runHolderWatch(at(30 * 60_000))).toContain("already asked back on, waiting for 20i");
    expect(asked).toBe(1);
    await runHolderWatch(at(HOUR));
    expect(asked).toBe(2);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_preview_holder_switched_on"))).toHaveLength(2);
    expect(posts.filter((p) => p.includes("placeholder package for tawdpreviews.com"))).toHaveLength(1);
  });

  it("leaves a placeholder to a switch-off check still running from before 0.119.0", async () => {
    await h.db.update(appSetting).set({ value: { packageId: holderId, test: { phase: "watching", projectId: "p", host: "x.tawdpreviews.com", startedAt: T0.toISOString(), phaseAt: T0.toISOString(), seq: 2 } } }).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING));
    twentyi.packages.get(holderId)!.enabled = false;
    expect(await runHolderWatch(T0)).toContain("left to it");
    expect(twentyi.packages.get(holderId)!.enabled).toBe(false);
    // Still running 3 hours on (it takes about 2.5 at most): left to it.
    expect(await runHolderWatch(at(3 * HOUR))).toContain("left to it");
  });

  it("takes the placeholder back from an old switch-off check that stopped (review of PR #26)", async () => {
    const started = at(-5 * HOUR).toISOString();
    await h.db.update(appSetting).set({ value: { packageId: holderId, test: { phase: "switching_on", projectId: "p", host: "x.tawdpreviews.com", startedAt: started, phaseAt: started, seq: 9 } } }).where(eq(appSetting.key, PREVIEW_HOLDER_SETTING));
    twentyi.packages.get(holderId)!.enabled = false;
    const said = await runHolderWatch(T0);
    expect(said).toContain("The old switch-off check had stopped; the watch took the placeholder back.");
    expect(twentyi.packages.get(holderId)!.enabled).toBe(true);
    expect((await state()).test).toBeUndefined();
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "site.wp_preview_holder_test_abandoned"))).toHaveLength(1);
    expect(posts.filter((p) => p.includes("placeholder package for tawdpreviews.com"))).toHaveLength(1);
  });

  it("decides when to tell the team", () => {
    expect(holderAlertDue(undefined, T0)).toBe(true);
    expect(holderAlertDue({ offSince: T0.toISOString(), lastAlertAt: T0.toISOString() }, at(23 * HOUR))).toBe(false);
    expect(holderAlertDue({ offSince: T0.toISOString(), lastAlertAt: T0.toISOString() }, at(DAY))).toBe(true);
  });
});

describe("the preview domain's registration, once a day", () => {
  const expiringIn = (days: number, from = T0) => new Date(from.getTime() + days * DAY - HOUR).toISOString();

  it("reads the expiry date from RDAP and says nothing more than 30 days out", async () => {
    expect(rdapExpiry({ events: [{ eventAction: "expiration", eventDate: "2027-11-01T00:00:00Z" }] })?.toISOString()).toBe("2027-11-01T00:00:00.000Z");
    expect(rdapExpiry({ events: [] })).toBeNull();
    expect(await runHolderWatch(T0)).toContain("tawdpreviews.com expires 2027-11-01");
    expect(posts).toEqual([]);
    expect((await state()).domain).toMatchObject({ expiresAt: "2027-11-01T00:00:00.000Z", alerted: [] });
    // Asked at the domain's own registry, not rdap.org (which answers TAWD's server with a 403 page; 0.122.1).
    expect(rdap.urls).toEqual(["https://rdap.verisign.com/com/v1/domain/tawdpreviews.com"]);
    // Read at most once in 20 hours.
    await runHolderWatch(at(5 * HOUR));
    expect(rdap.asked).toBe(1);
  });

  it("warns at 30, 14, 7, 3 and 1 days, each once, then every day after it lapses; a renewal starts the warnings again", async () => {
    rdap.expires = expiringIn(30);
    await runHolderWatch(T0);
    expect(posts).toEqual([expect.stringContaining("tawdpreviews.com expires in 30 days")]);
    // The next day (29 days): nothing new.
    await runHolderWatch(at(DAY));
    expect(posts).toHaveLength(1);
    for (const [d, n] of [[16, 1], [14, 2], [13, 2], [7, 3], [3, 4], [2, 4]] as const) {
      await runHolderWatch(at((30 - d) * DAY));
      expect(posts).toHaveLength(n);
    }
    // One day out, then lapsed: every day.
    await runHolderWatch(at(29 * DAY));
    expect(posts.at(-1)).toContain("tawdpreviews.com expires in about 23 hours");
    await runHolderWatch(at(31 * DAY));
    expect(posts.at(-1)).toContain("tawdpreviews.com expired on");
    await runHolderWatch(at(32 * DAY));
    expect(posts).toHaveLength(7);
    // Renewed for a year: quiet again.
    rdap.expires = expiringIn(365, at(33 * DAY));
    await runHolderWatch(at(33 * DAY));
    expect(posts).toHaveLength(7);
    expect((await state()).domain).toMatchObject({ alerted: [] });
  });

  it("says once when RDAP hasn't answered for three days", async () => {
    rdap.fails = true;
    await runHolderWatch(T0);
    await runHolderWatch(at(DAY));
    expect(posts).toEqual([]);
    await runHolderWatch(at(3 * DAY));
    expect(posts).toEqual([expect.stringContaining("hasn't been able to read tawdpreviews.com's registration")]);
    await runHolderWatch(at(4 * DAY));
    expect(posts).toHaveLength(1);
    rdap.fails = false;
    await runHolderWatch(at(5 * DAY));
    expect((await state()).domain).toMatchObject({ unreadSince: null, unreadAlerted: false });
  });

  it("says 'expired' from the moment it lapses, not 'today' (review of PR #26)", async () => {
    rdap.expires = new Date(T0.getTime() - 2 * HOUR).toISOString();
    await runHolderWatch(T0);
    expect(posts).toEqual([expect.stringContaining("tawdpreviews.com expired on 2026-11-03")]);
  });

  it("keeps warning from the date it knows while RDAP is down (review of PR #26)", async () => {
    rdap.expires = expiringIn(3);
    await runHolderWatch(T0);
    expect(posts).toEqual([expect.stringContaining("expires in 3 days")]);
    rdap.fails = true;
    // Two days on: one day left, RDAP silent. Still told, with a note that the date is the last one read.
    await runHolderWatch(at(2 * DAY));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("tawdpreviews.com expires in about 23 hours");
    expect(posts[1]).toContain("the registry isn't answering right now");
    // Lapsed, still silent: every day.
    await runHolderWatch(at(3 * DAY));
    expect(posts.at(-1)).toContain("tawdpreviews.com expired on");
    expect((await state()).domain).toMatchObject({ expiresAt: expiringIn(3) });
  });

  it("picks the right warning", () => {
    expect(domainWarningDue(45, [])).toBeNull();
    expect(domainWarningDue(30, [])).toBe(30);
    expect(domainWarningDue(20, [30])).toBeNull();
    expect(domainWarningDue(10, [30])).toBe(14);
    expect(domainWarningDue(5, [30])).toBe(7);
  });
});

describe("queued every hour by the web's tick", () => {
  it("adds one job a clock hour, only with a preview domain", async () => {
    const added: { name: string; jobId?: string }[] = [];
    setQueueForTesting({ add: async (name, _data, options) => void added.push({ name, jobId: options?.jobId }), getJob: async () => null });
    try {
      expect(await holderWatchTick(T0)).toBe(true);
      expect(added).toEqual([{ name: WP_HOLDER_WATCH_JOB, jobId: "wp-holder-watch-2026110312" }]);
      expect(wpHolderWatchJobId("2026-11-03T12:59:00.000Z")).toBe(wpHolderWatchJobId(T0.toISOString()));
      vi.stubEnv("WP_PREVIEW_DOMAIN", "");
      expect(await holderWatchTick(T0)).toBe(false);
      expect(added).toHaveLength(1);
    } finally {
      setQueueForTesting(null);
    }
  });
});
