import { createHash, randomBytes } from "node:crypto";
import { claimScheduledRun } from "@tawd/core/scheduled-run";
import { and, desc, eq, lt } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { formChannel, formHeartbeat, formMessage, formTest, goLive, netlifySite, project } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { decryptSecret, encryptSecret, hasEncryptionKey } from "@tawd/core/secrets";
import { loadIntake } from "@tawd/core/intake/service";
import { formDefinition } from "@tawd/core/site";
import {
  readNetlifySubmission,
  readPostmarkEvent,
  readWordpressSubmission,
  relayEmail,
  testEmail,
  verifyNetlifySignature,
  verifyWordpressSignature,
  type RelaySubmission,
} from "@tawd/core/forms-relay";
import { notifySlack } from "@/lib/slack-notify";

/*
  F2, form messages through TAWD (1 October 2026,
  docs/plans/forms-email-domains.md). Every message from a client site's
  forms comes here (Netlify's signed webhook, or TAWD's WordPress theme
  with the project's key), is kept 90 days, and is emailed to the client
  through Postmark from VML's own address, with the visitor as Reply-To.
  Postmark then says whether it was delivered, bounced or marked as spam;
  a bounce tells the PM and Slack. A test message with an "I got it" link
  proves each recipient gets them; go-live waits for one confirmation.

  POSTMARK_SERVER_TOKEN and FORMS_FROM_EMAIL are read by the web app only,
  sent to Postmark and nowhere else, never logged. Until they're set,
  nothing changes: the forms email the client directly, as before.
*/

type Db = Database;
type Ctx = { db: Db; ipAddress: string | null; userAgent: string | null };

export class FormsRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormsRelayError";
  }
}

export const KEEP_DAYS = 90;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const baseUrl = () => (process.env.BETTER_AUTH_URL?.trim() || "https://tawd.velocitymedialab.com").replace(/\/$/, "");

export function postmarkSetup(): { configured: boolean; missing: string[] } {
  const missing = ["POSTMARK_SERVER_TOKEN", "FORMS_FROM_EMAIL"].filter((n) => !process.env[n]?.trim());
  return { configured: missing.length === 0 && hasEncryptionKey(), missing };
}

/* ---------- Postmark ---------- */

type Fetch = typeof fetch;
let postmarkFetch: Fetch | null = null;
/** Tests answer for Postmark: nothing here reaches it. */
export function setPostmarkFetchForTesting(stand: Fetch | null): void {
  postmarkFetch = stand;
}

export async function postmarkSend(email: { to: string[]; bcc?: string | null; replyTo?: string | null; subject: string; textBody: string; htmlBody: string; fromName: string; metadata: Record<string, string> }): Promise<string> {
  const token = process.env.POSTMARK_SERVER_TOKEN?.trim();
  const from = process.env.FORMS_FROM_EMAIL?.trim();
  if (!token || !from) throw new FormsRelayError("Postmark isn't set up yet.");
  // The client's business name on the sender line; the address is always VML's own.
  const name = email.fromName.replace(/["\r\n<>]/g, "").slice(0, 60).trim() || "Website";
  const response = await (postmarkFetch ?? fetch)("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({
      From: `"${name} website" <${from}>`,
      To: email.to.join(", "),
      ...(email.bcc ? { Bcc: email.bcc } : {}),
      ...(email.replyTo ? { ReplyTo: email.replyTo } : {}),
      Subject: email.subject,
      TextBody: email.textBody,
      HtmlBody: email.htmlBody,
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Metadata: email.metadata,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as { MessageID?: string; ErrorCode?: number; Message?: string };
  if (response.status === 401) throw new FormsRelayError("Postmark refused the token: check POSTMARK_SERVER_TOKEN in Coolify.");
  if (!response.ok || !json.MessageID || (json.ErrorCode ?? 0) !== 0) throw new FormsRelayError(`Postmark didn't send it: ${json.Message ?? `it answered ${response.status}`}.`);
  return json.MessageID;
}

/* ---------- the project's key for its forms ---------- */

export async function channelSecret(db: Db, projectId: string): Promise<string> {
  const [row] = await db.select().from(formChannel).where(eq(formChannel.projectId, projectId)).limit(1);
  if (row) return decryptSecret(row.secretEncrypted);
  const secret = randomBytes(32).toString("base64url");
  await db.insert(formChannel).values({ projectId, secretEncrypted: encryptSecret(secret) }).onConflictDoNothing();
  const [saved] = await db.select().from(formChannel).where(eq(formChannel.projectId, projectId)).limit(1);
  return decryptSecret(saved!.secretEncrypted);
}

/** Where the site's forms send: Netlify's webhook, and TAWD's WordPress theme. */
export const relayUrls = () => ({ netlify: `${baseUrl()}/api/forms/netlify`, wordpress: `${baseUrl()}/api/forms/wordpress` });

/* ---------- a message comes in ---------- */

async function recipientsFor(db: Db, projectId: string): Promise<string[]> {
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  return intake ? formDefinition(intake.data).recipients : [];
}

async function siteName(db: Db, projectId: string): Promise<{ site: string; clientName: string }> {
  const [proj] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  const [live] = await db.select({ domain: goLive.domain, liveUrl: goLive.liveUrl }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  const [site] = await db.select({ url: netlifySite.url }).from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  return { site: live?.domain ?? site?.url.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "your website", clientName: proj?.clientName ?? "" };
}

/* Keeps the message, then emails it; a failure is kept with its reason and tells the PM. */
/* F4: the weekly check's own message ("TAWD-HEARTBEAT <token>" in a field). */
export const HEARTBEAT_MARK = "TAWD-HEARTBEAT";

export async function receiveSubmission(ctx: Ctx, projectId: string, source: "netlify" | "wordpress", submission: RelaySubmission): Promise<{ id: string; status: string }> {
  // F4: the weekly check of the site's form is recorded as arrived and never emailed to the client.
  const beat = submission.fields.map((f) => new RegExp(`${HEARTBEAT_MARK} ([A-Za-z0-9_-]{16,64})`).exec(f.value)?.[1]).find(Boolean);
  if (beat) {
    const [hb] = await ctx.db.select().from(formHeartbeat).where(and(eq(formHeartbeat.projectId, projectId), eq(formHeartbeat.token, beat))).limit(1);
    if (hb) {
      if (!hb.receivedAt) await ctx.db.update(formHeartbeat).set({ status: "received", receivedAt: new Date(), detail: null }).where(eq(formHeartbeat.id, hb.id));
      return { id: hb.id, status: "heartbeat" };
    }
  }
  if (submission.externalId) {
    const [seen] = await ctx.db.select({ id: formMessage.id, status: formMessage.status }).from(formMessage).where(and(eq(formMessage.projectId, projectId), eq(formMessage.externalId, submission.externalId))).limit(1);
    if (seen) return seen;
  }
  const recipients = await recipientsFor(ctx.db, projectId);
  const [row] = await ctx.db
    .insert(formMessage)
    .values({ projectId, source, formName: submission.formName, visitorName: submission.visitorName, visitorEmail: submission.visitorEmail, fields: submission.fields, files: submission.files, recipients, status: "queued", externalId: submission.externalId })
    .returning({ id: formMessage.id });
  await sendMessage(ctx, projectId, row!.id);
  const [after] = await ctx.db.select({ status: formMessage.status }).from(formMessage).where(eq(formMessage.id, row!.id)).limit(1);
  return { id: row!.id, status: after!.status };
}

async function sendMessage(ctx: Ctx, projectId: string, id: string): Promise<void> {
  const [msg] = await ctx.db.select().from(formMessage).where(eq(formMessage.id, id)).limit(1);
  if (!msg) return;
  const recipients = msg.recipients as string[];
  const names = await siteName(ctx.db, projectId);
  if (recipients.length === 0) {
    await ctx.db.update(formMessage).set({ status: "failed", detail: "No address to send it to: add one under Website forms (or the business email)." }).where(eq(formMessage.id, id));
    notifySlack(ctx.db, projectId, { kind: "golive_step", step: `a website message came in but there's no address to send it to. Add one under Website forms; it's kept in TAWD (Form messages).` });
    return;
  }
  try {
    const email = relayEmail({ site: names.site, clientName: names.clientName, submission: { formName: msg.formName, fields: msg.fields as RelaySubmission["fields"], files: msg.files as RelaySubmission["files"], visitorName: msg.visitorName, visitorEmail: msg.visitorEmail }, when: msg.createdAt });
    const copy = process.env.NETLIFY_FORM_COPY_EMAIL?.trim();
    const postmarkId = await postmarkSend({ ...email, to: recipients, bcc: copy && !recipients.includes(copy) ? copy : null, replyTo: msg.visitorEmail, fromName: names.clientName, metadata: { projectId, messageId: id } });
    await ctx.db.update(formMessage).set({ status: "sent", postmarkId, sentAt: new Date(), detail: null }).where(eq(formMessage.id, id));
  } catch (error) {
    const reason = error instanceof FormsRelayError ? error.message : "It couldn't be sent.";
    await ctx.db.update(formMessage).set({ status: "failed", detail: reason }).where(eq(formMessage.id, id));
    notifySlack(ctx.db, projectId, { kind: "golive_step", step: `a website message couldn't be emailed to the client (${reason}). It's kept in TAWD: open Form messages and send it again.` });
  }
}

export async function receiveNetlify(ctx: Ctx, siteId: string, rawBody: string, signature: string | null): Promise<"ok" | "unknown" | "forbidden" | "unreadable"> {
  const [site] = await ctx.db.select({ projectId: netlifySite.projectId }).from(netlifySite).where(eq(netlifySite.siteId, siteId)).limit(1);
  if (!site) return "unknown";
  if (!verifyNetlifySignature(rawBody, signature, await channelSecret(ctx.db, site.projectId))) return "forbidden";
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return "unreadable";
  }
  const submission = readNetlifySubmission(json);
  if (!submission) return "unreadable";
  await receiveSubmission(ctx, site.projectId, "netlify", submission);
  return "ok";
}

export async function receiveWordpress(ctx: Ctx, projectId: string, rawBody: string, signature: string | null): Promise<"ok" | "unknown" | "forbidden" | "unreadable"> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return "unknown";
  const [row] = await ctx.db.select({ projectId: formChannel.projectId }).from(formChannel).where(eq(formChannel.projectId, projectId)).limit(1);
  if (!row) return "unknown";
  if (!verifyWordpressSignature(rawBody, signature, await channelSecret(ctx.db, projectId))) return "forbidden";
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return "unreadable";
  }
  const submission = readWordpressSubmission(json);
  if (!submission) return "unreadable";
  await receiveSubmission(ctx, projectId, "wordpress", submission);
  return "ok";
}

/* ---------- what Postmark says happened ---------- */

export async function recordPostmarkEvent(ctx: Ctx, json: unknown): Promise<boolean> {
  const event = readPostmarkEvent(json);
  if (!event) return false;
  const [msg] = await ctx.db.select().from(formMessage).where(eq(formMessage.postmarkId, event.messageId)).limit(1);
  const [test] = msg ? [] : await ctx.db.select().from(formTest).where(eq(formTest.postmarkId, event.messageId)).limit(1);
  const projectId = msg?.projectId ?? test?.projectId;
  if (!projectId) return false;
  if (msg) await ctx.db.update(formMessage).set({ status: event.status, detail: event.detail, ...(event.status === "delivered" ? { deliveredAt: event.at } : {}) }).where(eq(formMessage.id, msg.id));
  if (test) await ctx.db.update(formTest).set({ status: event.status, detail: event.detail }).where(eq(formTest.id, test.id));
  if (event.status !== "delivered") {
    await recordActivity(ctx.db, { action: "forms.bounced", entityType: "project", entityId: projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { status: event.status, detail: event.detail, test: Boolean(test) } });
    notifySlack(ctx.db, projectId, { kind: "golive_step", step: `${test ? "the test message" : "a website message"}: ${event.detail} Check the address with the client (Form messages).` });
  }
  return true;
}

/* ---------- the test message, and the client's "I got it" ---------- */

export async function sendTestMessages(ctx: Ctx, actor: Viewer, projectId: string): Promise<number> {
  assertCan(actor, "project.edit");
  if (!postmarkSetup().configured) throw new FormsRelayError("Postmark isn't set up yet: an admin adds POSTMARK_SERVER_TOKEN and FORMS_FROM_EMAIL to the web app in Coolify.");
  const recipients = await recipientsFor(ctx.db, projectId);
  if (recipients.length === 0) throw new FormsRelayError("There's no address to send to: add one under Website forms (or the business email).");
  const [recent] = await ctx.db.select({ sentAt: formTest.sentAt }).from(formTest).where(eq(formTest.projectId, projectId)).orderBy(desc(formTest.sentAt)).limit(1);
  if (recent && Date.now() - recent.sentAt.getTime() < 60_000) throw new FormsRelayError("A test went out less than a minute ago: give it a moment to arrive.");
  const names = await siteName(ctx.db, projectId);
  for (const recipient of recipients) {
    const token = randomBytes(24).toString("base64url");
    const [row] = await ctx.db.insert(formTest).values({ projectId, recipient, tokenHash: hash(token), status: "sent", sentByUserId: actor.id }).returning({ id: formTest.id });
    try {
      const email = testEmail({ site: names.site, clientName: names.clientName, confirmUrl: `${baseUrl()}/forms/confirm/${token}` });
      const postmarkId = await postmarkSend({ ...email, to: [recipient], fromName: names.clientName, metadata: { projectId, testId: row!.id } });
      await ctx.db.update(formTest).set({ postmarkId }).where(eq(formTest.id, row!.id));
    } catch (error) {
      await ctx.db.update(formTest).set({ status: "failed", detail: error instanceof FormsRelayError ? error.message : "It couldn't be sent." }).where(eq(formTest.id, row!.id));
    }
  }
  await recordActivity(ctx.db, { action: "forms.test_sent", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { recipients }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return recipients.length;
}

/* The client's click: the recipient and the site it's for, or null for a link that isn't good. */
export async function confirmTest(ctx: Ctx, token: string): Promise<{ recipient: string; site: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await ctx.db.select().from(formTest).where(eq(formTest.tokenHash, hash(token))).limit(1);
  if (!row || Date.now() - row.sentAt.getTime() > 30 * 86_400_000) return null;
  if (!row.confirmedAt) {
    await ctx.db.update(formTest).set({ confirmedAt: new Date(), status: row.status === "sent" ? "delivered" : row.status }).where(eq(formTest.id, row.id));
    await recordActivity(ctx.db, { action: "forms.test_confirmed", entityType: "project", entityId: row.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { recipient: row.recipient }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    notifySlack(ctx.db, row.projectId, { kind: "golive_step", step: `${row.recipient} confirmed they got the test message.` });
  }
  return { recipient: row.recipient, site: (await siteName(ctx.db, row.projectId)).site };
}

/** Whether a recipient has confirmed a test (go-live waits for one); null while Postmark isn't set up. */
export async function formsConfirmed(db: Db, projectId: string): Promise<boolean | null> {
  if (!postmarkSetup().configured) return null;
  const rows = await db.select({ confirmedAt: formTest.confirmedAt, recipient: formTest.recipient }).from(formTest).where(eq(formTest.projectId, projectId));
  const current = new Set(await recipientsFor(db, projectId));
  return rows.some((r) => r.confirmedAt && current.has(r.recipient));
}

/* ---------- the card ---------- */

export interface FormMessagesView {
  setup: { configured: boolean; missing: string[] };
  recipients: { email: string; state: "confirmed" | "sent" | "bounced" | "failed" | "none"; line: string | null }[];
  messages: { id: string; at: Date; form: string; visitor: string | null; status: string; detail: string | null }[];
  alert: string | null;
}

export async function loadFormMessages(db: Db, projectId: string): Promise<FormMessagesView> {
  const recipients = await recipientsFor(db, projectId);
  const tests = await db.select().from(formTest).where(eq(formTest.projectId, projectId)).orderBy(desc(formTest.sentAt));
  const messages = await db.select().from(formMessage).where(eq(formMessage.projectId, projectId)).orderBy(desc(formMessage.createdAt)).limit(10);
  const bad = [...messages.filter((m) => m.status === "bounced" || m.status === "spam"), ...tests.filter((t) => t.status === "bounced" || t.status === "spam")][0];
  return {
    setup: postmarkSetup(),
    recipients: recipients.map((email) => {
      const mine = tests.filter((t) => t.recipient === email);
      const confirmed = mine.find((t) => t.confirmedAt);
      const last = mine[0];
      if (confirmed) return { email, state: "confirmed" as const, line: `Confirmed ${confirmed.confirmedAt!.toISOString()}` };
      if (!last) return { email, state: "none" as const, line: null };
      if (last.status === "bounced" || last.status === "spam") return { email, state: "bounced" as const, line: last.detail };
      if (last.status === "failed") return { email, state: "failed" as const, line: last.detail };
      return { email, state: "sent" as const, line: `Test sent ${last.sentAt.toISOString()}` };
    }),
    messages: messages.map((m) => ({ id: m.id, at: m.createdAt, form: /quote/i.test(m.formName) ? "Quote" : "Contact", visitor: m.visitorName, status: m.status, detail: m.detail })),
    alert: bad?.detail ? `${bad.detail} Check the address with the client.` : null,
  };
}

/* One message's contents: the client's customer's details, so each opening is logged. */
export async function viewMessage(ctx: Ctx, actor: Viewer, projectId: string, id: string) {
  assertCan(actor, "project.edit");
  const [msg] = await ctx.db.select().from(formMessage).where(and(eq(formMessage.id, id), eq(formMessage.projectId, projectId))).limit(1);
  if (!msg) throw new FormsRelayError("That message is no longer kept (messages are kept 90 days).");
  await recordActivity(ctx.db, { action: "forms.message_viewed", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { messageId: id }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  return { fields: msg.fields as RelaySubmission["fields"], files: msg.files as RelaySubmission["files"], recipients: msg.recipients as string[], status: msg.status, detail: msg.detail, at: msg.createdAt };
}

export async function resendMessage(ctx: Ctx, actor: Viewer, projectId: string, id: string): Promise<void> {
  assertCan(actor, "project.edit");
  const [msg] = await ctx.db.select().from(formMessage).where(and(eq(formMessage.id, id), eq(formMessage.projectId, projectId))).limit(1);
  if (!msg) throw new FormsRelayError("That message is no longer kept.");
  // The recipients as they are now (a corrected address).
  await ctx.db.update(formMessage).set({ recipients: await recipientsFor(ctx.db, projectId), status: "queued" }).where(eq(formMessage.id, id));
  await sendMessage(ctx, projectId, id);
  await recordActivity(ctx.db, { action: "forms.message_resent", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { messageId: id }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/* Kept 90 days, then gone (the client's customers' details). Started with the web server (schedulePurge). */
export async function purgeOldMessages(db: Db, now = new Date()): Promise<number> {
  const removed = await db.delete(formMessage).where(lt(formMessage.createdAt, new Date(now.getTime() - KEEP_DAYS * 86_400_000))).returning({ id: formMessage.id });
  return removed.length;
}

/*
  A minute after the server starts, then every hour (6 October 2026): a
  once-a-day timer restarted with every deploy, and TAWD deploys most days,
  so it hardly ever ran. Deleting what's past 90 days is cheap and safe to
  repeat.
*/
export const PURGE_FIRST_MS = 60_000;
export const PURGE_EVERY_MS = 60 * 60_000;

export function schedulePurge(db: Db): void {
  // D5: one run per interval across every web server and restart (scheduled-run.ts).
  const run = () =>
    void (async () => {
      if (await claimScheduledRun(db as never, "form-purge", PURGE_EVERY_MS * 0.9)) await purgeOldMessages(db);
    })().catch(() => undefined);
  setTimeout(run, PURGE_FIRST_MS).unref();
  setInterval(run, PURGE_EVERY_MS).unref();
}
