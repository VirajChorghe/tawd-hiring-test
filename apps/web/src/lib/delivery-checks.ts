import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { claimScheduledRun } from "@tawd/core/scheduled-run";
import { and, desc, eq, isNotNull, lt } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { appSetting, deliveryTest, formHeartbeat, goLive, netlifySite, project, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { FormsRelayError, HEARTBEAT_MARK, channelSecret, postmarkSend, postmarkSetup } from "@/lib/forms-relay";
import { notifySlack } from "@/lib/slack-notify";

/*
  F4 (1 October 2026, docs/plans/forms-email-domains.md): proving form
  messages keep arriving.

  1. The test inboxes: one at each provider VML's clients use. TAWD emails
     them all through Postmark once a month (and on demand); whoever checks
     the inbox opens the email and clicks where it landed. No inbox password
     is ever stored.
  2. The weekly check of each live site: TAWD fills in the site's real
     form, marked "TAWD-HEARTBEAT <token>", and waits for it to reach TAWD
     (the relay records it and never emails the client). Nothing within an
     hour tells Slack.
*/

type Db = Database;
type Ctx = { db: Db; ipAddress: string | null; userAgent: string | null };

export const LAB_SETTING = "delivery_lab";
export const MAX_INBOXES = 20;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const baseUrl = () => (process.env.BETTER_AUTH_URL?.trim() || "https://tawd.velocitymedialab.com").replace(/\/$/, "");
const isEmail = (v: string) => /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(v);

export interface LabInbox {
  address: string;
  provider: string;
}

/* "vml.test@gmail.com, Gmail" per line; anything that isn't an address is named, not saved. */
export function readInboxes(text: string): { inboxes: LabInbox[]; problems: string[] } {
  const inboxes: LabInbox[] = [];
  const problems: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [address = "", ...rest] = line.split(",").map((p) => p.trim());
    if (!isEmail(address)) {
      problems.push(`"${line.slice(0, 80)}" isn't "address, provider".`);
      continue;
    }
    if (!inboxes.some((i) => i.address.toLowerCase() === address.toLowerCase())) inboxes.push({ address, provider: rest.join(", ").slice(0, 60) || address.split("@")[1]! });
  }
  if (inboxes.length > MAX_INBOXES) problems.push(`At most ${MAX_INBOXES} inboxes.`);
  return { inboxes: inboxes.slice(0, MAX_INBOXES), problems };
}

export async function loadInboxes(db: Db): Promise<LabInbox[]> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, LAB_SETTING)).limit(1);
  return ((row?.value as { inboxes?: LabInbox[] } | undefined)?.inboxes ?? []).filter((i) => isEmail(i.address));
}

export async function saveInboxes(ctx: Ctx, actor: Viewer, text: string): Promise<LabInbox[]> {
  assertCan(actor, "settings.manage");
  const { inboxes, problems } = readInboxes(text);
  if (problems.length) throw new FormsRelayError(problems.join(" "));
  const value = { inboxes };
  await ctx.db.insert(appSetting).values({ key: LAB_SETTING, value }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date(), updatedByUserId: actor.id } });
  await recordActivity(ctx.db, { action: "delivery.inboxes_saved", entityType: "setting", entityId: LAB_SETTING, ...actorFields(actor), valueAfter: { count: inboxes.length, providers: inboxes.map((i) => i.provider) }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return inboxes;
}

/* ---------- 1. the test inboxes ---------- */

export async function sendLabTest(ctx: Ctx, actor: Viewer): Promise<number> {
  if (actor !== SYSTEM_ACTOR) assertCan(actor, "settings.manage");
  if (!postmarkSetup().configured) throw new FormsRelayError("Postmark isn't set up yet.");
  const inboxes = await loadInboxes(ctx.db);
  if (inboxes.length === 0) throw new FormsRelayError("Add the test inboxes first.");
  const runId = randomUUID();
  for (const inbox of inboxes) {
    const token = randomBytes(24).toString("base64url");
    const [row] = await ctx.db.insert(deliveryTest).values({ runId, address: inbox.address, provider: inbox.provider, tokenHash: hash(token), status: "sent" }).returning({ id: deliveryTest.id });
    const link = `${baseUrl()}/forms/lab/${token}`;
    try {
      const postmarkId = await postmarkSend({
        to: [inbox.address],
        subject: `New website message from TAWD delivery check (${inbox.provider})`,
        textBody: `This is TAWD's monthly delivery check for ${inbox.provider}. It looks like a client's website message on purpose.\n\nWhere did it land? Tell us here:\n${link}\n\n--\nVelocity Media Lab`,
        htmlBody: `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#18212b;max-width:560px"><p>This is TAWD's monthly delivery check for <strong>${inbox.provider.replace(/[<>&"]/g, "")}</strong>. It looks like a client's website message on purpose.</p><p><a href="${link}" style="display:inline-block;background:#205af2;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Tell us where it landed</a></p><p style="color:#5b6570;font-size:13px">Velocity Media Lab</p></div>`,
        fromName: "TAWD delivery check",
        metadata: { deliveryTestId: row!.id },
      });
      await ctx.db.update(deliveryTest).set({ postmarkId }).where(eq(deliveryTest.id, row!.id));
    } catch (error) {
      await ctx.db.update(deliveryTest).set({ status: "failed", detail: error instanceof FormsRelayError ? error.message : "It couldn't be sent." }).where(eq(deliveryTest.id, row!.id));
    }
  }
  await recordActivity(ctx.db, { action: "delivery.test_sent", entityType: "setting", entityId: LAB_SETTING, ...actorFields(actor), valueAfter: { inboxes: inboxes.length }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return inboxes.length;
}

/* Whoever checks the inbox: where it landed. Null for a link that isn't good. */
export async function answerLabTest(ctx: Ctx, token: string, where: "inbox" | "spam"): Promise<{ provider: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await ctx.db.select().from(deliveryTest).where(eq(deliveryTest.tokenHash, hash(token))).limit(1);
  if (!row || Date.now() - row.sentAt.getTime() > 45 * 86_400_000) return null;
  await ctx.db.update(deliveryTest).set({ status: where, answeredAt: new Date() }).where(eq(deliveryTest.id, row.id));
  await recordActivity(ctx.db, { action: "delivery.test_answered", entityType: "setting", entityId: LAB_SETTING, ...actorFields(SYSTEM_ACTOR), valueAfter: { provider: row.provider, where }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { provider: row.provider };
}

/* Postmark's report on a delivery test (the relay's webhook sends the unknown ones here). */
export async function recordLabEvent(db: Db, postmarkId: string, status: "delivered" | "bounced" | "spam", detail: string): Promise<boolean> {
  const [row] = await db.select().from(deliveryTest).where(eq(deliveryTest.postmarkId, postmarkId)).limit(1);
  if (!row) return false;
  // "Delivered" says the server took it; where it landed is the person's answer.
  if (status !== "delivered" && row.status === "sent") await db.update(deliveryTest).set({ status: status === "spam" ? "spam" : "bounced", detail }).where(eq(deliveryTest.id, row.id));
  return true;
}

/* ---------- 2. each live site's form, every week ---------- */

type Fetch = typeof fetch;
let siteFetch: Fetch | null = null;
/** Tests answer for the live sites. */
export function setHeartbeatFetchForTesting(stand: Fetch | null): void {
  siteFetch = stand;
}

async function liveNetlifySites(db: Db): Promise<{ projectId: string; clientName: string; domain: string }[]> {
  const rows = await db
    .select({ projectId: goLive.projectId, domain: goLive.domain, clientName: project.clientName, hosting: project.hosting })
    .from(goLive)
    .innerJoin(project, eq(project.id, goLive.projectId))
    .innerJoin(netlifySite, eq(netlifySite.projectId, goLive.projectId))
    .where(isNotNull(goLive.wentLiveAt));
  return rows.filter((r) => r.domain && r.hosting !== "wordpress").map((r) => ({ projectId: r.projectId, clientName: r.clientName, domain: r.domain! }));
}

/* How the check reaches a WordPress site's form: Contact Form 7's own address, or the theme's signed check for Gravity Forms. */
export type WpFormTarget = { plugin: "cf7"; formId: number } | { plugin: "gravityforms" };

/* B3: live WordPress sites, by the form TAWD's weekly check fills in; a suspended site (20i) is skipped, so it raises no false alarm. */
async function liveWordpressSites(db: Db): Promise<{ projectId: string; clientName: string; domain: string; target: WpFormTarget }[]> {
  const rows = await db
    .select({ projectId: wpPreview.projectId, domain: wpPreview.liveDomain, state: wpPreview.liveState, formId: wpPreview.liveFormId, suspendedAt: wpPreview.suspendedAt, clientName: project.clientName, formPlugin: project.formPlugin })
    .from(wpPreview)
    .innerJoin(project, eq(project.id, wpPreview.projectId));
  return rows
    .filter((r) => r.state === "live" && !r.suspendedAt && r.domain && (r.formPlugin === "gravityforms" || r.formId))
    .map((r) => ({ projectId: r.projectId, clientName: r.clientName, domain: r.domain!, target: r.formPlugin === "gravityforms" ? { plugin: "gravityforms" as const } : { plugin: "cf7" as const, formId: r.formId! } }));
}

/*
  Fills in the site's form the way a visitor's browser does: Netlify takes
  the form's name and its fields; a WordPress site, Contact Form 7's own
  address with the form's id, or (Gravity Forms) the theme's check,
  signed with the project's key, which submits through Gravity Forms.
  "preview": a check of the WordPress preview by hand, which the hourly
  sweep leaves alone (it's not the live site).
*/
export async function sendHeartbeat(db: Db, projectId: string, domain: string, target: WpFormTarget | null = null, status: "sent" | "preview" = "sent"): Promise<void> {
  const token = randomBytes(18).toString("base64url");
  const [row] = await db.insert(formHeartbeat).values({ projectId, token, status }).returning({ id: formHeartbeat.id });
  const message = `${HEARTBEAT_MARK} ${token} (an automatic weekly check that this form works; please ignore)`;
  let url = `https://${domain}/`;
  let headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  let body: string | FormData = new URLSearchParams({ "form-name": "contact", name: "TAWD weekly check", message }).toString();
  if (target?.plugin === "cf7") {
    url = `https://${domain}/wp-json/contact-form-7/v1/contact-forms/${target.formId}/feedback`;
    const form = new FormData();
    for (const [k, v] of Object.entries({ name: "TAWD weekly check", message, _wpcf7: String(target.formId), _wpcf7_unit_tag: `wpcf7-f${target.formId}-o1`, _wpcf7_version: "6.1.7", _wpcf7_locale: "en_US", _wpcf7_container_post: "0" })) form.append(k, v);
    body = form;
    headers = {};
  } else if (target?.plugin === "gravityforms") {
    url = `https://${domain}/wp-json/tawd/v1/check`;
    body = JSON.stringify({ message });
    const at = Math.floor(Date.now() / 1000);
    headers = { "Content-Type": "application/json", "X-Tawd-Signature": `${at}.${createHmac("sha256", await channelSecret(db, projectId)).update(`${at}.${body}`).digest("hex")}` };
  }
  try {
    const response = await (siteFetch ?? fetch)(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 400) {
      // Gravity Forms' check says why (the theme's own words), the rest only their status.
      const reason = target?.plugin === "gravityforms" ? ((await response.json().catch(() => null)) as { message?: string } | null)?.message : undefined;
      await db.update(formHeartbeat).set({ status: "failed", detail: reason ? `The site answered ${response.status}: ${reason.slice(0, 300)}` : `The site answered ${response.status}.` }).where(eq(formHeartbeat.id, row!.id));
    }
  } catch {
    await db.update(formHeartbeat).set({ status: "failed", detail: "The site didn't answer." }).where(eq(formHeartbeat.id, row!.id));
  }
}

/* The WordPress preview's form, checked by hand (PMs and admins): the same check the live site gets every week. */
export async function checkPreviewForm(ctx: Ctx, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  if (!postmarkSetup().configured) throw new FormsRelayError("Postmark isn't set up yet: the check needs messages to come through TAWD.");
  const [row] = await ctx.db
    .select({ state: wpPreview.state, host: wpPreview.host, liveState: wpPreview.liveState, formPlugin: project.formPlugin })
    .from(wpPreview)
    .innerJoin(project, eq(project.id, wpPreview.projectId))
    .where(eq(wpPreview.projectId, projectId))
    .limit(1);
  if (!row || row.state !== "ready" || !row.host) throw new FormsRelayError("Deploy the WordPress preview first.");
  if (row.liveState === "live") throw new FormsRelayError("The site is live: the weekly check covers it (System, Email delivery).");
  if (row.formPlugin !== "gravityforms") throw new FormsRelayError("This check is for Gravity Forms sites; with Contact Form 7, fill in the preview's form yourself.");
  await sendHeartbeat(ctx.db, projectId, row.host, { plugin: "gravityforms" }, "preview");
  await recordActivity(ctx.db, { action: "delivery.preview_form_checked", entityType: "project", entityId: projectId, ...actorFields(actor), ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* The preview's last check by hand, for its card. */
export async function loadPreviewCheck(db: Db, projectId: string): Promise<{ status: string; at: Date; detail: string | null } | null> {
  const [hb] = await db.select().from(formHeartbeat).where(eq(formHeartbeat.projectId, projectId)).orderBy(desc(formHeartbeat.sentAt)).limit(1);
  return hb && (hb.status === "preview" || hb.status === "received" || hb.status === "failed") ? { status: hb.status, at: hb.receivedAt ?? hb.sentAt, detail: hb.detail } : null;
}

export async function checkAllSites(ctx: Ctx, actor: Viewer, now = new Date()): Promise<number> {
  if (actor !== SYSTEM_ACTOR) assertCan(actor, "settings.manage");
  if (!postmarkSetup().configured) throw new FormsRelayError("Postmark isn't set up yet: the weekly check needs messages to come through TAWD.");
  const sites = await liveNetlifySites(ctx.db);
  for (const s of sites) await sendHeartbeat(ctx.db, s.projectId, s.domain);
  const wordpress = await liveWordpressSites(ctx.db);
  for (const s of wordpress) await sendHeartbeat(ctx.db, s.projectId, s.domain, s.target);
  const at = now.toISOString();
  await ctx.db
    .insert(appSetting)
    .values({ key: WEEKLY_CHECKS_SETTING, value: { at } })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: { at }, updatedAt: new Date() } });
  return sites.length + wordpress.length;
}

/*
  When the weekly check of every live site last ran (13 October 2026, the
  whole-code review): the Monday timer goes by this, not by the newest
  heartbeat, which a check of one WordPress preview by hand also makes.
*/
export const WEEKLY_CHECKS_SETTING = "weekly_site_checks";

/* A check with nothing back within an hour (or that couldn't be sent) is a problem the PM hears about. */
export async function sweepHeartbeats(db: Db, now = new Date()): Promise<number> {
  const late = await db.select().from(formHeartbeat).where(and(eq(formHeartbeat.status, "sent"), lt(formHeartbeat.sentAt, new Date(now.getTime() - 60 * 60_000))));
  for (const hb of late) {
    await db.update(formHeartbeat).set({ status: "missing", detail: "Nothing came back within an hour." }).where(eq(formHeartbeat.id, hb.id));
    await recordActivity(db, { action: "delivery.site_form_missing", entityType: "project", entityId: hb.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { sentAt: hb.sentAt.toISOString() } });
    notifySlack(db, hb.projectId, { kind: "golive_step", step: "the weekly check of the live site's form didn't arrive in TAWD within an hour. Fill in the site's form yourself to see what happens (Form messages)." });
  }
  return late.length;
}

/* ---------- the System card ---------- */

export interface DeliveryView {
  configured: boolean;
  inboxes: (LabInbox & { status: string | null; detail: string | null; at: Date | null })[];
  lastRun: Date | null;
  sites: { projectId: string; clientName: string; domain: string; status: string | null; at: Date | null; detail: string | null }[];
}

export async function loadDelivery(db: Db): Promise<DeliveryView> {
  const inboxes = await loadInboxes(db);
  const tests = await db.select().from(deliveryTest).orderBy(desc(deliveryTest.sentAt)).limit(200);
  const sites = [...(await liveNetlifySites(db)), ...(await liveWordpressSites(db))];
  const beats = await db.select().from(formHeartbeat).orderBy(desc(formHeartbeat.sentAt)).limit(500);
  return {
    configured: postmarkSetup().configured,
    inboxes: inboxes.map((i) => {
      const last = tests.find((t) => t.address.toLowerCase() === i.address.toLowerCase());
      return { ...i, status: last?.status ?? null, detail: last?.detail ?? null, at: last ? (last.answeredAt ?? last.sentAt) : null };
    }),
    lastRun: tests[0]?.sentAt ?? null,
    sites: sites.map((s) => {
      const last = beats.find((b) => b.projectId === s.projectId);
      return { ...s, status: last?.status ?? null, at: last ? (last.receivedAt ?? last.sentAt) : null, detail: last?.detail ?? null };
    }),
  };
}

/* ---------- the timer ---------- */

/*
  Started with the web server: once an hour it settles late checks, sends
  the weekly site checks on Mondays (once), and the inbox test on the 1st of
  the month (once).
*/
export async function deliveryTick(db: Db, now = new Date()): Promise<void> {
  await sweepHeartbeats(db, now);
  if (!postmarkSetup().configured) return;
  const ctx = { db, ipAddress: null, userAgent: null };
  const [weekly] = await db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, WEEKLY_CHECKS_SETTING)).limit(1);
  // No stamp yet: the check runs. A heartbeat can't stand in for it, since a preview's check by hand that failed reads "failed"
  // like a live one (CodeRabbit, PR #14); at worst the first Monday after this sends one extra round, never to the client.
  const lastRun = weekly ? Date.parse((weekly.value as { at?: string }).at ?? "") : NaN;
  if (now.getUTCDay() === 1 && (!Number.isFinite(lastRun) || now.getTime() - lastRun > 5 * 86_400_000)) await checkAllSites(ctx, SYSTEM_ACTOR, now).catch(() => 0);
  const [lastLab] = await db.select({ at: deliveryTest.sentAt }).from(deliveryTest).orderBy(desc(deliveryTest.sentAt)).limit(1);
  if (now.getUTCDate() === 1 && (!lastLab || now.getTime() - lastLab.at.getTime() > 20 * 86_400_000) && (await loadInboxes(db)).length) await sendLabTest(ctx, SYSTEM_ACTOR).catch(() => 0);
}

export function scheduleDeliveryChecks(db: Db): void {
  // D5: one run per interval across every web server and restart (scheduled-run.ts).
  const tick = async () => {
    if (await claimScheduledRun(db as never, "delivery-checks", 60 * 60_000 * 0.9)) await deliveryTick(db);
  };
  const timer = setInterval(() => void tick().catch(() => undefined), 60 * 60_000);
  timer.unref();
}
