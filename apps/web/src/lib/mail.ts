import { after } from "next/server";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";

import { recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";

/*
  Sending email.

  Through Resend's web API when RESEND_API_KEY is set (26 September 2026:
  DigitalOcean blocks the SMTP ports, so Gmail over SMTP can't be reached
  from the droplet), otherwise over SMTP (SMTP_* variables), otherwise not
  at all. MAIL_FROM is the sender either way.

  Emails go out in the background, after the page has answered, so
  "Forgot password?" replies at once. Every attempt is logged as "Email
  sent" or "Email not sent" with the reason, never with what the email
  held (a reset link is a key to an account).
*/

const smtpSchema = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  // "TAWD <no-reply@velocitymedialab.com>"; "TAWD no-reply@velocitymedialab.com" works too.
  MAIL_FROM: z.string().min(3),
});

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailSender = (mail: OutgoingMail) => Promise<void>;
export type MailRoute = "Resend" | "SMTP";

let override: MailSender | null = null;
let smtpTransport: Transporter | null = null;
let fetcher: typeof fetch = (...args) => fetch(...args);
const pending = new Set<Promise<unknown>>();

/** Only for tests: what "sending" does instead. Settings are read again next time. */
export function setMailSenderForTesting(sender: MailSender | null): void {
  override = sender;
  smtpTransport = null;
}

/** Only for tests: Resend's API. */
export function setMailFetchForTesting(fn: typeof fetch | null): void {
  fetcher = fn ?? ((...args) => fetch(...args));
}

/** For tests: wait for every email started outside a request. */
export async function settleMail(): Promise<void> {
  await Promise.all([...pending]);
}

/*
  "TAWD <x@y.com>" as it is, or "TAWD x@y.com" (no angle brackets) read as
  the name TAWD and the address x@y.com, so a sender typed either way works.
*/
export function parseFrom(value: string): { name: string; address: string } | string {
  const trimmed = value.trim();
  if (/<[^>]+@[^>]+>/.test(trimmed)) return trimmed;
  const address = /[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/.exec(trimmed)?.[0];
  if (!address) return trimmed;
  const name = trimmed.replace(address, "").replace(/["<>]/g, "").trim();
  return name ? { name, address } : address;
}

const fromText = (from: ReturnType<typeof parseFrom>) => (typeof from === "string" ? from : `${from.name} <${from.address}>`);

/* Which way email goes: Resend when its key is set, SMTP when that is complete, else none. */
export function mailRoute(): MailRoute | null {
  if (process.env.RESEND_API_KEY?.trim() && process.env.MAIL_FROM?.trim()) return "Resend";
  if (smtpSchema.safeParse(process.env).success) return "SMTP";
  return null;
}

/* ---------- sending now ---------- */

export type SendResult = { ok: true; via: MailRoute | "test" } | { ok: false; via: MailRoute | null; reason: string };

/* Sends it and waits for the answer. Never throws. */
export async function sendMailNow(mail: OutgoingMail): Promise<SendResult> {
  if (override) {
    await override(mail);
    return { ok: true, via: "test" };
  }
  const route = mailRoute();
  if (!route) return { ok: false, via: null, reason: notSetUp() };
  const from = parseFrom(process.env.MAIL_FROM!);
  if (route === "Resend") {
    try {
      const response = await fetcher(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromText(from), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, via: "Resend" };
      const body = (await response.json().catch(() => ({}))) as { message?: string; name?: string };
      return { ok: false, via: "Resend", reason: explainResendError(response.status, body.message ?? body.name ?? "") };
    } catch (error) {
      return {
        ok: false,
        via: "Resend",
        reason: `TAWD couldn't reach Resend (api.resend.com): ${error instanceof Error && error.name === "TimeoutError" ? "no answer within 15 seconds" : "the connection failed"}.`,
      };
    }
  }
  try {
    smtpTransport ??= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      // 465 speaks TLS from the start; 587 and 25 upgrade with STARTTLS.
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      // Fail within seconds when the port is blocked, rather than hanging.
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
    });
    await smtpTransport.sendMail({ from, ...mail });
    return { ok: true, via: "SMTP" };
  } catch (error) {
    return { ok: false, via: "SMTP", reason: explainMailError(error) };
  }
}

/* ---------- sending in the background, logged ---------- */

/*
  Sends after the page has answered (Next's after() inside a request;
  started at once and tracked outside one, so a test can wait for it), then
  logs "Email sent" or "Email not sent" with the reason.
*/
export function deliverMail(db: Database, mail: OutgoingMail, about: { purpose: string; userId?: string | null }): void {
  const task = async () => {
    const result = await sendMailNow(mail);
    await logSend(db, mail, about, result).catch((error: unknown) =>
      console.error(`Logging an email failed: ${error instanceof Error ? error.message : "unknown error"}`),
    );
    if (!result.ok) console.warn(`"${mail.subject}" was not sent: ${result.reason}`);
  };
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
}

async function logSend(db: Database, mail: OutgoingMail, about: { purpose: string; userId?: string | null }, result: SendResult) {
  await recordActivity(db, {
    action: result.ok ? "email.sent" : "email.not_sent",
    entityType: about.userId ? "user" : "setting",
    entityId: about.userId ?? "email",
    valueAfter: {
      purpose: about.purpose,
      to: mail.to,
      via: result.via,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  });
}

/* ---------- checking that it works (Team page, admins only) ---------- */

export interface MailSettings {
  configured: boolean;
  via: MailRoute | null;
  /** What is still missing, by variable name. */
  missing: string[];
  /** Where it goes: "Resend", or "smtp.gmail.com:587 as x@y"; never a key or password. */
  through: string | null;
  from: string | null;
}

export function mailSettings(): MailSettings {
  const via = mailRoute();
  const from = process.env.MAIL_FROM?.trim() ? fromText(parseFrom(process.env.MAIL_FROM)) : null;
  if (via === "Resend") return { configured: true, via, missing: [], through: "Resend", from };
  if (via === "SMTP") {
    return { configured: true, via, missing: [], through: `${process.env.SMTP_HOST}:${process.env.SMTP_PORT} as ${process.env.SMTP_USER}`, from };
  }
  const missing = ["RESEND_API_KEY", ...(from ? [] : ["MAIL_FROM"])];
  return { configured: false, via: null, missing, through: null, from };
}

function notSetUp(): string {
  const { missing } = mailSettings();
  return `Email isn't set up: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing in Coolify.`;
}

/* The Team page's test: sent now (so the admin sees the answer), and logged like any other. */
export async function sendTestEmail(db: Database, to: string): Promise<{ ok: boolean; message: string }> {
  const mail: OutgoingMail = {
    to,
    subject: "TAWD test email",
    text: "This is a test email from TAWD. If you can read it, TAWD can send email (password reset links included).\n\nTAWD, Velocity Media Lab",
    html: "<p>This is a test email from TAWD. If you can read it, TAWD can send email (password reset links included).</p><p style=\"color:#5b6570\">TAWD, Velocity Media Lab</p>",
  };
  const result = await sendMailNow(mail);
  await logSend(db, mail, { purpose: "test email" }, result);
  if (result.ok) {
    return { ok: true, message: `Sent to ${to}${result.via === "test" ? "" : ` through ${result.via}`}. Check that inbox, and the spam folder.` };
  }
  return { ok: false, message: result.reason };
}

/* ---------- refusals in plain words ---------- */

export function explainResendError(status: number, said: string): string {
  const quote = said ? ` It said: "${said.replace(/\s+/g, " ").trim().slice(0, 300)}"` : "";
  if (/domain/i.test(said) && /verif/i.test(said)) {
    return `Resend refused the sender: its domain isn't verified in Resend yet. Add the DNS records Resend shows for the domain, wait for "Verified", then try again.${quote}`;
  }
  if (status === 401 || status === 403) {
    return `Resend refused the API key. Check RESEND_API_KEY in Coolify is the whole key (it starts with re_) and can send email.${quote}`;
  }
  if (status === 422) return `Resend refused the email as written: usually MAIL_FROM isn't on a domain verified in Resend.${quote}`;
  if (status === 429) return `Resend is limiting how fast TAWD sends; try again in a minute.${quote}`;
  return `Resend refused the email (error ${status}).${quote}`;
}

/* An SMTP server's refusal in plain words, with its own words after. */
export function explainMailError(error: unknown): string {
  const e = (error ?? {}) as { code?: string; responseCode?: number; response?: string; message?: string };
  const said = (e.response || e.message || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const host = process.env.SMTP_HOST ?? "the mail server";
  const port = process.env.SMTP_PORT ?? "";
  let plain: string;
  if (e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534) {
    plain =
      "The mail server refused the username or password. For Gmail, SMTP_USER must be the full Gmail address and SMTP_PASSWORD a 16-letter App Password (not the normal password), made while 2-Step Verification is on.";
  } else if (e.code === "ETIMEDOUT" || e.code === "ECONNECTION" || e.code === "ESOCKET" || e.code === "ECONNREFUSED") {
    plain = `TAWD couldn't reach ${host}${port ? ` on port ${port}` : ""}: the connection ${e.code === "ECONNREFUSED" || /ECONNREFUSED/.test(said) ? "was refused" : "timed out"}. The server's outgoing mail ports may be blocked (DigitalOcean blocks them on many accounts until support lifts it).`;
  } else if (e.code === "EDNS" || e.code === "ENOTFOUND") {
    plain = `No mail server answers at "${host}". Check SMTP_HOST (for Gmail: smtp.gmail.com).`;
  } else if (e.code === "EENVELOPE" || e.responseCode === 550 || e.responseCode === 553 || e.responseCode === 555) {
    plain = "The mail server refused the sender or the recipient address. For Gmail, MAIL_FROM must be the same Gmail address (or an alias set up in Gmail).";
  } else if (e.code === "ETLS" || /certificate|tls/i.test(said)) {
    plain = "The secure connection to the mail server failed. For Gmail use port 587.";
  } else {
    plain = "The mail server refused.";
  }
  return said ? `${plain} It said: "${said}"` : plain;
}
