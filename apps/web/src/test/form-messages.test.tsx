import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  F2, form messages through TAWD (1 October 2026). A message from Netlify
  (signed webhook) or from TAWD's WordPress theme (signed with the
  project's key) is kept, emailed to the client through Postmark from VML's
  address with the visitor as Reply-To, and followed: delivered, bounced,
  spam. A test message with "I got it" proves each recipient gets them.
  Postmark and Netlify are stand-ins here.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/app/actions", () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => ({ ok: true })), has: () => true }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, formMessage, formTest, netlifySite } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { emptyIntake } from "@tawd/core/intake";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { goLiveGate } from "@tawd/core/site";
import {
  readNetlifySubmission,
  readPostmarkEvent,
  readWordpressSubmission,
  relayEmail,
  signLikeNetlify,
  signWordpress,
  verifyNetlifySignature,
  verifyWordpressSignature,
} from "@tawd/core/forms-relay";
import { createProject } from "@/lib/projects";
import { setNetlifyFetchForTesting, syncFormRecipients } from "@/lib/netlify";
import {
  channelSecret,
  confirmTest,
  formsConfirmed,
  loadFormMessages,
  postmarkSetup,
  PURGE_EVERY_MS,
  PURGE_FIRST_MS,
  purgeOldMessages,
  receiveNetlify,
  receiveWordpress,
  recordPostmarkEvent,
  resendMessage,
  schedulePurge,
  sendTestMessages,
  setPostmarkFetchForTesting,
  viewMessage,
} from "@/lib/forms-relay";
import { POST as netlifyRoute } from "@/app/api/forms/netlify/route";
import { POST as postmarkRoute } from "@/app/api/forms/postmark/route";
import { FormMessagesCard } from "@/components/build/form-messages-card";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
let sent: Record<string, unknown>[];
let postmarkFails: string | null;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  sent = [];
  postmarkFails = null;
  setPostmarkFetchForTesting(async (_url, init) => {
    if (postmarkFails) return Response.json({ ErrorCode: 406, Message: postmarkFails }, { status: 422 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    return Response.json({ ErrorCode: 0, MessageID: `pm-${sent.length}` });
  });
  vi.stubEnv("POSTMARK_SERVER_TOKEN", "pm-token");
  vi.stubEnv("FORMS_FROM_EMAIL", "forms@velocitymedialab.com");
  vi.stubEnv("NETLIFY_FORM_COPY_EMAIL", "sites@vml.example");
  vi.stubEnv("BETTER_AUTH_URL", "https://tawd.velocitymedialab.com");
});

afterEach(async () => {
  setPostmarkFetchForTesting(null);
  setNetlifyFetchForTesting(null);
  vi.unstubAllEnvs();
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const NETLIFY_BODY = {
  id: "sub-1",
  form_name: "contact",
  data: { name: "Ana Ruiz", email: "ana@example.com", phone: "(916) 555-0142", message: "Ants in the kitchen <script>alert(1)</script>", photos: { url: "https://netlify-files.example/a.jpg", filename: "ants.jpg" }, "bot-field": "", ip: "1.2.3.4" },
  ordered_human_fields: [
    { title: "Name", name: "name", value: "Ana Ruiz" },
    { title: "Email", name: "email", value: "ana@example.com" },
    { title: "Phone", name: "phone", value: "(916) 555-0142" },
    { title: "Message", name: "message", value: "Ants in the kitchen <script>alert(1)</script>" },
    { title: "Photos", name: "photos", value: { url: "https://netlify-files.example/a.jpg", filename: "ants.jpg" } },
  ],
};

async function project() {
  const admin = await seedAdmin(h);
  const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
  const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
  const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "growth", clientName: "Harbor Pest" });
  await saveIntakeSection(h.ctx, admin.viewer, id, "business", { ...emptyIntake().business, email: "owner@harborpest.example" });
  await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-harbor", url: "https://tawd-harbor.netlify.app", formEmails: [] });
  return { admin, pm, content, id };
}

describe("reading a message and its signature", () => {
  it("reads Netlify's submission: labelled fields in order, photos as links, the machinery left out", () => {
    const s = readNetlifySubmission(NETLIFY_BODY)!;
    expect(s.fields.map((f) => f.label)).toEqual(["Name", "Email", "Phone", "Message"]);
    expect(s.files).toEqual([{ name: "ants.jpg", url: "https://netlify-files.example/a.jpg" }]);
    expect(s).toMatchObject({ formName: "contact", visitorName: "Ana Ruiz", visitorEmail: "ana@example.com", externalId: "sub-1" });
    expect(readNetlifySubmission({ nope: 1 })).toBeNull();
    const wp = readWordpressSubmission({ form: "quote", id: "w1", fields: { name: "Bo", email: "not-an-email", service: ["Termites"], _wpcf7: "12" } })!;
    expect(wp).toMatchObject({ formName: "quote", visitorName: "Bo", visitorEmail: null, fields: [{ label: "Name", value: "Bo" }, { label: "Email", value: "not-an-email" }, { label: "Service needed", value: "Termites" }] });
    // A field TAWD doesn't know keeps its own label, or its name when it has none (13 October 2026).
    const other = readWordpressSubmission({ form: "quote", fields: { "gate-code": "1234", "pet-name": "Rex" }, labels: { "gate-code": "Gate code" } })!;
    expect(other.fields).toEqual([{ label: "Gate code", value: "1234" }, { label: "pet-name", value: "Rex" }]);
  });

  it("accepts only messages signed with the project's key (and, from WordPress, fresh ones)", () => {
    const raw = JSON.stringify(NETLIFY_BODY);
    expect(verifyNetlifySignature(raw, signLikeNetlify(raw, "k1"), "k1")).toBe(true);
    expect(verifyNetlifySignature(raw, signLikeNetlify(raw, "k2"), "k1")).toBe(false);
    expect(verifyNetlifySignature(`${raw} `, signLikeNetlify(raw, "k1"), "k1")).toBe(false);
    expect(verifyNetlifySignature(raw, null, "k1")).toBe(false);
    const now = 1_790_000_000;
    expect(verifyWordpressSignature("{}", signWordpress("{}", "k1", now), "k1", now)).toBe(true);
    expect(verifyWordpressSignature("{}", signWordpress("{}", "k1", now - 700), "k1", now)).toBe(false);
    expect(verifyWordpressSignature("{}", signWordpress("{}", "k2", now), "k1", now)).toBe(false);
  });

  it("writes the email with the visitor's words as text only", () => {
    const e = relayEmail({ site: "harborpest.com", clientName: "Harbor Pest", submission: readNetlifySubmission(NETLIFY_BODY)!, when: new Date() });
    expect(e.subject).toBe("New website message from Ana Ruiz");
    expect(e.htmlBody).toContain("Ants in the kitchen &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(e.htmlBody).not.toContain("<script>");
    expect(e.textBody).toContain("Reply to this email to answer Ana Ruiz directly.");
    expect(relayEmail({ site: "x", clientName: "y", submission: { formName: "quote", fields: [], files: [], visitorName: "Evil\r\nBcc: a@b.c", visitorEmail: null }, when: new Date() }).subject).toBe("New website quote request from Evil Bcc: a@b.c");
  });

  it("reads Postmark's delivered, bounced and spam reports", () => {
    expect(readPostmarkEvent({ RecordType: "Delivery", MessageID: "m1", Recipient: "a@b.co", DeliveredAt: "2026-10-01T10:00:00Z" })).toMatchObject({ status: "delivered" });
    expect(readPostmarkEvent({ RecordType: "Bounce", MessageID: "m1", Email: "a@b.co", Description: "Mailbox full" })).toMatchObject({ status: "bounced", detail: "a@b.co bounced: Mailbox full" });
    expect(readPostmarkEvent({ RecordType: "SpamComplaint", MessageID: "m1", Email: "a@b.co" })?.status).toBe("spam");
    expect(readPostmarkEvent({ RecordType: "Open", MessageID: "m1" })).toBeNull();
  });
});

describe("a message from the site", () => {
  it("is kept and emailed to the client from VML's address, the visitor as Reply-To, VML's copy hidden; a retried webhook isn't sent twice", async () => {
    const { id } = await project();
    const raw = JSON.stringify(NETLIFY_BODY);
    const secret = await channelSecret(h.db, id);
    expect(await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, secret))).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ From: '"Harbor Pest website" <forms@velocitymedialab.com>', To: "owner@harborpest.example", Bcc: "sites@vml.example", ReplyTo: "ana@example.com", Subject: "New website message from Ana Ruiz", TrackOpens: false });
    const [row] = await h.db.select().from(formMessage).where(eq(formMessage.projectId, id));
    expect(row).toMatchObject({ source: "netlify", status: "sent", postmarkId: "pm-1", visitorEmail: "ana@example.com" });
    // Netlify retries: the same submission isn't emailed again.
    await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, secret));
    expect(sent).toHaveLength(1);
    expect(await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, "wrong"))).toBe("forbidden");
    expect(await receiveNetlify(h.ctx, "site-9", raw, signLikeNetlify(raw, secret))).toBe("unknown");
  });

  it("from WordPress, signed with the project's key and the time", async () => {
    const { id } = await project();
    const raw = JSON.stringify({ form: "contact", id: "w-1", fields: { name: "Bo", message: "Wasps" } });
    expect(await receiveWordpress(h.ctx, id, raw, signWordpress(raw, "nope"))).toBe("unknown");
    const secret = await channelSecret(h.db, id);
    expect(await receiveWordpress(h.ctx, id, raw, signWordpress(raw, secret))).toBe("ok");
    expect(sent[0]).toMatchObject({ To: "owner@harborpest.example", Subject: "New website message from Bo" });
    expect(sent[0]!.ReplyTo).toBeUndefined();
  });

  it("is kept when Postmark fails, says why, and can be sent again (to the address as it is now)", async () => {
    const { pm, content, id } = await project();
    postmarkFails = "Inactive recipient";
    const raw = JSON.stringify(NETLIFY_BODY);
    await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, await channelSecret(h.db, id)));
    const [failed] = await h.db.select().from(formMessage).where(eq(formMessage.projectId, id));
    expect(failed).toMatchObject({ status: "failed", detail: "Postmark didn't send it: Inactive recipient." });

    postmarkFails = null;
    await saveIntakeSection(h.ctx, pm.viewer, id, "forms", { recipients: ["office@harborpest.example"] });
    await expect(resendMessage(h.ctx, content.viewer, id, failed!.id)).rejects.toBeInstanceOf(PermissionError);
    await resendMessage(h.ctx, pm.viewer, id, failed!.id);
    expect(sent.at(-1)!.To).toBe("office@harborpest.example");
    expect((await h.db.select().from(formMessage).where(eq(formMessage.id, failed!.id)))[0]!.status).toBe("sent");
  });

  it("follows Postmark's reports: delivered, or bounced (logged, and the card says so)", async () => {
    const { pm, id } = await project();
    const raw = JSON.stringify(NETLIFY_BODY);
    await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, await channelSecret(h.db, id)));
    await recordPostmarkEvent(h.ctx, { RecordType: "Delivery", MessageID: "pm-1", Recipient: "owner@harborpest.example", DeliveredAt: "2026-10-01T10:00:00Z" });
    expect((await h.db.select().from(formMessage).where(eq(formMessage.projectId, id)))[0]).toMatchObject({ status: "delivered" });
    await recordPostmarkEvent(h.ctx, { RecordType: "Bounce", MessageID: "pm-1", Email: "owner@harborpest.example", Description: "The mailbox is full" });
    const view = await loadFormMessages(h.db, id);
    expect(view.alert).toBe("owner@harborpest.example bounced: The mailbox is full Check the address with the client.");
    expect(view.messages[0]).toMatchObject({ form: "Contact", visitor: "Ana Ruiz", status: "bounced" });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "forms.bounced"))).length).toBe(1);
    // The contents only on View, and that's logged.
    const opened = await viewMessage(h.ctx, pm.viewer, id, view.messages[0]!.id);
    expect(opened.fields[0]).toEqual({ label: "Name", value: "Ana Ruiz" });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "forms.message_viewed"))).length).toBe(1);
  });

  it("is removed after 90 days", async () => {
    const { id } = await project();
    await h.db.insert(formMessage).values({ projectId: id, source: "netlify", formName: "contact", status: "sent", createdAt: new Date(Date.now() - 91 * 86_400_000) });
    await h.db.insert(formMessage).values({ projectId: id, source: "netlify", formName: "contact", status: "sent" });
    expect(await purgeOldMessages(h.db)).toBe(1);
    expect(await h.db.select().from(formMessage)).toHaveLength(1);
  });

  it("is cleared a minute after each start and every hour, not once a day (a deploy no longer resets it)", async () => {
    const { id } = await project();
    await h.db.insert(formMessage).values({ projectId: id, source: "netlify", formName: "contact", status: "sent", createdAt: new Date(Date.now() - 91 * 86_400_000) });
    // The clock too: each run is claimed against the time (D5, scheduled-run.ts), so an hour of timers must also be an hour on the clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      schedulePurge(h.db);
      await vi.advanceTimersByTimeAsync(PURGE_FIRST_MS);
      await vi.waitFor(async () => expect(await h.db.select().from(formMessage)).toHaveLength(0));
      await h.db.insert(formMessage).values({ projectId: id, source: "netlify", formName: "contact", status: "sent", createdAt: new Date(Date.now() - 95 * 86_400_000) });
      await vi.advanceTimersByTimeAsync(PURGE_EVERY_MS);
      await vi.waitFor(async () => expect(await h.db.select().from(formMessage)).toHaveLength(0));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("the test message", () => {
  it("goes to every recipient; the client's click (not the email scanner's) confirms it, and go-live waits for one", async () => {
    const { pm, id } = await project();
    expect(await formsConfirmed(h.db, id)).toBe(false);
    expect(await sendTestMessages(h.ctx, pm.viewer, id)).toBe(1);
    await expect(sendTestMessages(h.ctx, pm.viewer, id)).rejects.toThrow("less than a minute ago");
    const email = sent[0]!;
    expect(email).toMatchObject({ To: "owner@harborpest.example", Subject: "Test: messages from your new website (tawd-harbor.netlify.app)" });
    const token = /\/forms\/confirm\/([A-Za-z0-9_-]+)/.exec(String(email.TextBody))![1]!;
    const [row] = await h.db.select().from(formTest).where(eq(formTest.projectId, id));
    expect(row!.tokenHash).not.toContain(token);
    expect((await loadFormMessages(h.db, id)).recipients[0]).toMatchObject({ email: "owner@harborpest.example", state: "sent" });

    expect(await confirmTest(h.ctx, "not-a-real-token-at-all-xx")).toBeNull();
    expect(await confirmTest(h.ctx, token)).toEqual({ recipient: "owner@harborpest.example", site: "tawd-harbor.netlify.app" });
    expect(await formsConfirmed(h.db, id)).toBe(true);
    expect((await loadFormMessages(h.db, id)).recipients[0]!.state).toBe("confirmed");

    const steps = { domainConfirmed: true, emailVerified: true, emailConfirmed: true, netlifyDomain: true, nameserversSwitched: true, httpsConfirmed: true, ga4Recorded: true };
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true, formsConfirmed: false }).blockers).toEqual(["Form messages: the client hasn't confirmed the test message yet (Form messages, Send a test message)."]);
    expect(goLiveGate({ buildFeePaid: true, checklist: [], steps, founderFlags: [], hasBuild: true, formsConfirmed: null }).ready).toBe(true);
  });

  it("changes nothing until Postmark is set up", async () => {
    const { pm, id } = await project();
    vi.stubEnv("POSTMARK_SERVER_TOKEN", "");
    expect(postmarkSetup().configured).toBe(false);
    expect(await formsConfirmed(h.db, id)).toBeNull();
    await expect(sendTestMessages(h.ctx, pm.viewer, id)).rejects.toThrow("Postmark isn't set up yet");
  });
});

describe("Netlify, once Postmark is set up", () => {
  it("sends each message to TAWD (signed) and keeps only VML's copy as Netlify's own email", async () => {
    const { admin, id } = await project();
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "t");
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    setNetlifyFetchForTesting(async (url, init) => {
      const path = String(url).replace("https://api.netlify.com/api/v1", "");
      calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === "GET") return Response.json([{ id: "h1", type: "email", event: "submission_created", data: { email: "owner@harborpest.example" } }]);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "new" });
    });
    await syncFormRecipients(h.db, admin.viewer, id);
    const relay = calls.find((c) => c.body?.type === "url")!;
    expect(relay.body).toMatchObject({ site_id: "site-1", event: "submission_created", data: { url: "https://tawd.velocitymedialab.com/api/forms/netlify?site=site-1", signature_secret: await channelSecret(h.db, id) } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /hooks?site_id=site-1", "POST /hooks", "DELETE /hooks/h1", "POST /hooks"]);
    expect(calls.at(-1)!.body).toMatchObject({ type: "email", data: { email: "sites@vml.example" } });
  });
});

describe("the web addresses", () => {
  it("Netlify's refuses an unsigned message; Postmark's needs its password", async () => {
    await project();
    const raw = JSON.stringify(NETLIFY_BODY);
    expect((await netlifyRoute(new Request("https://tawd.velocitymedialab.com/api/forms/netlify?site=site-1", { method: "POST", body: raw }))).status).toBe(401);
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a made-up secret for the test
    vi.stubEnv("POSTMARK_WEBHOOK_SECRET", "s3cret");
    expect((await postmarkRoute(new Request("https://tawd.velocitymedialab.com/api/forms/postmark", { method: "POST", body: "{}" }))).status).toBe(401);
    const ok = await postmarkRoute(new Request("https://tawd.velocitymedialab.com/api/forms/postmark", { method: "POST", body: "{}", headers: { authorization: `Basic ${Buffer.from("tawd:s3cret").toString("base64")}` } }));
    expect(ok.status).toBe(200);
  });

  it("refuses an oversized post: by its declared size before reading, and by counting when it doesn't declare one", async () => {
    await project();
    const url = "https://tawd.velocitymedialab.com/api/forms/netlify?site=site-1";
    let declaredPulled = 0;
    const declaredBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          declaredPulled += 1;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const declared = await netlifyRoute(new Request(url, { method: "POST", body: declaredBody, headers: { "content-length": "300000000" }, duplex: "half" } as RequestInit));
    expect(declared.status).toBe(400);
    expect(declaredPulled).toBe(0);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64_000));
      },
    });
    const streamed = await netlifyRoute(new Request(url, { method: "POST", body: endless, duplex: "half" } as RequestInit));
    expect(streamed.status).toBe(400);
    expect(pulled).toBeLessThan(10);
  });
});

describe("the card", () => {
  it("says Postmark isn't set up, or shows who gets the messages and what happened to each", () => {
    const off = renderToStaticMarkup(<FormMessagesCard projectId="p1" canEdit setupMissing={["POSTMARK_SERVER_TOKEN"]} recipients={[]} messages={[]} alert={null} />);
    expect(off).toContain("Postmark isn&#x27;t set up yet");
    expect(off).not.toContain("Send a test message");
    const on = renderToStaticMarkup(
      <FormMessagesCard
        projectId="p1"
        canEdit
        setupMissing={[]}
        recipients={[{ email: "owner@harborpest.example", state: "confirmed", line: "Confirmed today" }]}
        messages={[{ id: "m1", when: "today", form: "Contact", visitor: "Ana Ruiz", status: "failed", detail: "Postmark didn't send it." }]}
        alert={null}
      />,
    );
    expect(on).toContain("Confirmed");
    expect(on).toContain("Send a test message");
    expect(on).toContain("Contact, Ana Ruiz");
    expect(on).toContain("Send again");
    expect(on).not.toContain("Ants");
  });
});
