import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Email (26 September 2026): through Resend's API once RESEND_API_KEY is
  set (DigitalOcean blocks the SMTP ports), otherwise SMTP; sent in the
  background and logged "sent" or "not sent" with the reason; a sender with
  or without angle brackets; the Team page's "Send a test email".
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/admin/users",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

import { activityLog } from "@tawd/core/schema";
import {
  deliverMail,
  explainMailError,
  explainResendError,
  mailSettings,
  parseFrom,
  sendTestEmail,
  setMailFetchForTesting,
  setMailSenderForTesting,
  settleMail,
} from "@/lib/mail";
import { describeChanges } from "@/lib/timeline-text";
import { EmailCheck } from "@/components/team/email-check";
import { createHarness, type Harness } from "./harness";

const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "RESEND_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let h: Harness;
let calls: { url: string; auth: string | null; body: Record<string, unknown> }[];

beforeEach(async () => {
  h = await createHarness();
  for (const key of KEYS) delete process.env[key];
  calls = [];
});

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setMailSenderForTesting(null);
  setMailFetchForTesting(null);
  await h.close();
});

const set = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  Object.assign(process.env, values);
  setMailSenderForTesting(null);
};

/* A stand-in for Resend's API: answers with the given status and body. */
const resend = (status: number, body: Record<string, unknown>) =>
  setMailFetchForTesting((async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);

const mail = { to: "owner@velocitymedialab.com", subject: "Set a new TAWD password", text: "t", html: "<p>h</p>" };

describe("which way email goes", () => {
  it("uses Resend once its key is set, SMTP when only that is complete, and says what's missing otherwise", () => {
    expect(mailSettings()).toEqual({ configured: false, via: null, missing: ["RESEND_API_KEY", "MAIL_FROM"], through: null, from: null });
    set({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "smtp-user@example.com", SMTP_PASSWORD: "abcdefghijklmnop", MAIL_FROM: "TAWD smtp-user@example.com" });
    expect(mailSettings()).toMatchObject({ via: "SMTP", through: "smtp.gmail.com:587 as smtp-user@example.com", from: "TAWD <smtp-user@example.com>" });
    set({ RESEND_API_KEY: "re_secret", MAIL_FROM: "TAWD <no-reply@velocitymedialab.com>" });
    const settings = mailSettings();
    expect(settings).toEqual({ configured: true, via: "Resend", missing: [], through: "Resend", from: "TAWD <no-reply@velocitymedialab.com>" });
    expect(JSON.stringify(settings)).not.toContain("re_secret");
    expect(JSON.stringify(settings)).not.toContain("abcdefghijklmnop");
  });

  it("reads the sender with or without angle brackets", () => {
    expect(parseFrom("TAWD smtp-user@example.com")).toEqual({ name: "TAWD", address: "smtp-user@example.com" });
    expect(parseFrom("TAWD <smtp-user@example.com>")).toBe("TAWD <smtp-user@example.com>");
    expect(parseFrom("smtp-user@example.com")).toBe("smtp-user@example.com");
  });
});

describe("sending through Resend", () => {
  it("posts to Resend's API with the key and the sender, in the background, and logs it as sent", async () => {
    set({ RESEND_API_KEY: "re_secret", MAIL_FROM: "TAWD no-reply@velocitymedialab.com" });
    resend(200, { id: "email-1" });
    deliverMail(h.db, mail, { purpose: "password reset link", userId: "u-1" });
    await settleMail();
    expect(calls).toEqual([
      {
        url: "https://api.resend.com/emails",
        auth: "Bearer re_secret",
        body: { from: "TAWD <no-reply@velocitymedialab.com>", to: ["owner@velocitymedialab.com"], subject: "Set a new TAWD password", text: "t", html: "<p>h</p>" },
      },
    ]);
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "email.sent"));
    expect(log).toMatchObject({ entityType: "user", entityId: "u-1" });
    expect(describeChanges("email.sent", null, log!.valueAfter, new Map())).toEqual(["Password reset link to owner@velocitymedialab.com through Resend"]);
    // The email itself is never in the log.
    expect(JSON.stringify(log)).not.toContain("<p>h</p>");
  });

  it("logs a refusal as not sent, in plain words, with Resend's own", async () => {
    set({ RESEND_API_KEY: "re_wrong", MAIL_FROM: "TAWD <no-reply@velocitymedialab.com>" });
    resend(401, { name: "validation_error", message: "API key is invalid" });
    deliverMail(h.db, mail, { purpose: "password reset link" });
    await settleMail();
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "email.not_sent"));
    expect(describeChanges("email.not_sent", null, log!.valueAfter, new Map())).toEqual([
      "Password reset link to owner@velocitymedialab.com through Resend",
      'Resend refused the API key. Check RESEND_API_KEY in Coolify is the whole key (it starts with re_) and can send email. It said: "API key is invalid"',
    ]);
    expect(explainResendError(403, "The velocitymedialab.com domain is not verified. Please, add and verify your domain.")).toMatch(
      /^Resend refused the sender: its domain isn't verified in Resend yet\./,
    );
  });

  it("logs not sent, with what's missing, while email isn't set up", async () => {
    deliverMail(h.db, mail, { purpose: "password reset link" });
    await settleMail();
    const [log] = await h.db.select().from(activityLog).where(eq(activityLog.action, "email.not_sent"));
    expect((log!.valueAfter as { reason: string }).reason).toBe("Email isn't set up: RESEND_API_KEY and MAIL_FROM are missing in Coolify.");
  });
});

describe("the test email", () => {
  it("sends now to the admin's own address, says through what, and logs it", async () => {
    set({ RESEND_API_KEY: "re_secret", MAIL_FROM: "TAWD <no-reply@velocitymedialab.com>" });
    resend(200, { id: "email-2" });
    expect(await sendTestEmail(h.db, "owner@velocitymedialab.com")).toEqual({
      ok: true,
      message: "Sent to owner@velocitymedialab.com through Resend. Check that inbox, and the spam folder.",
    });
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "email.sent"))).toHaveLength(1);
  });

  it("says plainly when an SMTP server can't be reached (a real refused connection)", async () => {
    set({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_USER: "a@b.com", SMTP_PASSWORD: "x", MAIL_FROM: "TAWD a@b.com" });
    const result = await sendTestEmail(h.db, "owner@velocitymedialab.com");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^TAWD couldn't reach 127\.0\.0\.1 on port 1: the connection was refused\./);
  }, 30_000);

  it("explains Gmail's refusals in plain words, with Gmail's own", () => {
    set({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587" });
    expect(explainMailError({ code: "EAUTH", responseCode: 535, response: "535-5.7.8 Username and Password not accepted." })).toMatch(
      /^The mail server refused the username or password\..*It said: "535-5\.7\.8 Username and Password not accepted\."$/,
    );
    expect(explainMailError({ code: "ETIMEDOUT", message: "Connection timeout" })).toContain(
      "TAWD couldn't reach smtp.gmail.com on port 587: the connection timed out.",
    );
  });
});

describe("the Team page's Email card", () => {
  it("shows where email goes from, and the button", () => {
    const html = renderToStaticMarkup(
      <EmailCheck email="owner@velocitymedialab.com" settings={{ configured: true, missing: [], through: "Resend", from: "TAWD <no-reply@velocitymedialab.com>" }} />,
    );
    expect(html).toContain("Sends through Resend, from TAWD &lt;no-reply@velocitymedialab.com&gt;.");
    expect(html).toContain("Send a test email");
    const off = renderToStaticMarkup(
      <EmailCheck email="a@velocitymedialab.com" settings={{ configured: false, missing: ["RESEND_API_KEY"], through: null, from: "TAWD <x@y.com>" }} />,
    );
    expect(off).toContain("Not set up: RESEND_API_KEY is missing in Coolify.");
  });
});
