import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
  F2, form messages through TAWD (1 October 2026,
  docs/plans/forms-email-domains.md). The rules, with no network: reading
  a submission from Netlify or from TAWD's WordPress theme, checking it was
  signed with the project's key, and the email TAWD sends for it. The
  visitor's words are only ever text in the email (escaped in its HTML).
*/

export interface RelayField {
  label: string;
  value: string;
}

export interface RelaySubmission {
  formName: string;
  fields: RelayField[];
  files: { name: string; url: string }[];
  visitorName: string | null;
  visitorEmail: string | null;
  externalId: string | null;
}

/* Fields that are the form's machinery, never the visitor's words. */
const HIDDEN = new Set(["form-name", "bot-field", "ip", "user_agent", "referrer", "_wpcf7", "_wpcf7_version", "_wpcf7_locale", "_wpcf7_unit_tag", "_wpcf7_container_post", "_wpcf7_posted_data_hash"]);

const LABELS: Record<string, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  message: "Message",
  service: "Service needed",
  address: "Address or ZIP code",
  bestTime: "Best time to call",
  heardAbout: "How did you hear about us?",
  photos: "Photos",
  emergency: "This is an emergency",
  textConsent: "OK to text",
};

const text = (v: unknown, max = 5000) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "").slice(0, max).trim();
const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

function finish(formName: string, fields: RelayField[], files: RelaySubmission["files"], externalId: string | null): RelaySubmission {
  const byLabel = (re: RegExp) => fields.find((f) => re.test(f.label))?.value ?? "";
  const email = byLabel(/^e-?mail\b/i);
  return {
    formName: formName || "contact",
    fields: fields.filter((f) => f.value !== "").slice(0, 40),
    files: files.slice(0, 10),
    visitorName: byLabel(/^(your )?name\b/i) || null,
    visitorEmail: isEmail(email) ? email : null,
    externalId,
  };
}

/* Netlify's "submission created" webhook (its outgoing JSON). */
export function readNetlifySubmission(json: unknown): RelaySubmission | null {
  const o = json as { id?: string; form_name?: string; data?: Record<string, unknown>; ordered_human_fields?: { title?: string; name?: string; value?: unknown }[] } | null;
  if (!o || typeof o !== "object" || !o.data || typeof o.data !== "object") return null;
  const files: RelaySubmission["files"] = [];
  const fields: RelayField[] = [];
  const add = (name: string, label: string, value: unknown) => {
    if (HIDDEN.has(name)) return;
    if (value && typeof value === "object" && "url" in (value as object)) {
      const f = value as { url?: unknown; filename?: unknown };
      if (typeof f.url === "string" && /^https:\/\//.test(f.url)) files.push({ name: text(f.filename, 200) || name, url: f.url });
      return;
    }
    fields.push({ label: label || LABELS[name] || name, value: text(value) });
  };
  if (Array.isArray(o.ordered_human_fields) && o.ordered_human_fields.length) {
    for (const f of o.ordered_human_fields) add(text(f.name, 100), LABELS[text(f.name, 100)] ?? text(f.title, 200), f.value ?? o.data[text(f.name, 100)]);
  } else {
    for (const [name, value] of Object.entries(o.data)) add(name, LABELS[name] ?? name, value);
  }
  return finish(text(o.form_name, 100), fields, files, text(o.id, 100) || null);
}

/* What TAWD's WordPress theme sends: { form, id, fields: { name: value }, files: [{ name, url }] }. */
export function readWordpressSubmission(json: unknown): RelaySubmission | null {
  const o = json as { form?: unknown; id?: unknown; fields?: Record<string, unknown>; labels?: Record<string, unknown>; files?: { name?: unknown; url?: unknown }[] } | null;
  if (!o || typeof o !== "object" || !o.fields || typeof o.fields !== "object") return null;
  const fields: RelayField[] = [];
  for (const [name, value] of Object.entries(o.fields)) {
    if (HIDDEN.has(name) || name.startsWith("_")) continue;
    // "||", not "??": text() gives "" for a missing label, and an empty label would hide the field's name (13 October 2026, the whole-code review).
    fields.push({ label: LABELS[name] || text(o.labels?.[name], 200) || name, value: Array.isArray(value) ? value.map((v) => text(v)).join(", ") : text(value) });
  }
  const files = (Array.isArray(o.files) ? o.files : []).map((f) => ({ name: text(f.name, 200), url: text(f.url, 1000) })).filter((f) => /^https:\/\//.test(f.url));
  return finish(text(o.form, 100), fields, files, text(o.id, 100) || null);
}

/* ---------- signatures ---------- */

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/*
  Netlify signs its webhooks with a JWT (HS256) in X-Webhook-Signature:
  { iss: "netlify", sha256: <hex of the body> }, keyed by the secret TAWD
  gave it when it made the hook.
*/
export function verifyNetlifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const [head, payload, sig] = header.split(".");
  if (!head || !payload || !sig) return false;
  const expected = b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest());
  if (!safeEqual(sig, expected)) return false;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: string };
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: string; sha256?: string };
    return header.alg === "HS256" && claims.iss === "netlify" && claims.sha256 === createHash("sha256").update(rawBody).digest("hex");
  } catch {
    return false;
  }
}

/* For tests and the stand-in: a signature as Netlify makes it. */
export function signLikeNetlify(rawBody: string, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: "netlify", sha256: createHash("sha256").update(rawBody).digest("hex") }));
  return `${head}.${payload}.${b64url(createHmac("sha256", secret).update(`${head}.${payload}`).digest())}`;
}

/* TAWD's WordPress theme: "<unix time>.<hex HMAC-SHA256 of time.body>", fresh within 10 minutes. */
export function signWordpress(rawBody: string, secret: string, at = Math.floor(Date.now() / 1000)): string {
  return `${at}.${createHmac("sha256", secret).update(`${at}.${rawBody}`).digest("hex")}`;
}

export function verifyWordpressSignature(rawBody: string, header: string | null, secret: string, now = Math.floor(Date.now() / 1000)): boolean {
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(now - Number(m[1])) > 600) return false;
  return safeEqual(m[2]!, createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest("hex"));
}

/* ---------- the email ---------- */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface RelayEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export function relayEmail(input: { site: string; clientName: string; submission: Pick<RelaySubmission, "formName" | "fields" | "files" | "visitorName" | "visitorEmail">; when: Date }): RelayEmail {
  const s = input.submission;
  const kind = /quote/i.test(s.formName) ? "quote request" : "message";
  const subject = `New website ${kind}${s.visitorName ? ` from ${s.visitorName.replace(/[\r\n]+/g, " ").slice(0, 80)}` : ""}`;
  const lines = s.fields.map((f) => `${f.label}: ${f.value}`);
  const files = s.files.map((f) => `${f.name}: ${f.url}`);
  const reply = s.visitorEmail ? `Reply to this email to answer ${s.visitorName ?? "them"} directly.` : "They didn't leave an email address: call them back.";
  const textBody = `A new ${kind} from your website, ${input.site}.\n\n${lines.join("\n")}${files.length ? `\n\nPhotos:\n${files.join("\n")}` : ""}\n\n${reply}\n\n--\nSent by Velocity Media Lab for ${input.clientName}.`;
  const rows = s.fields.map((f) => `<tr><td style="padding:6px 16px 6px 0;color:#5b6570;vertical-align:top;white-space:nowrap">${esc(f.label)}</td><td style="padding:6px 0;white-space:pre-wrap">${esc(f.value)}</td></tr>`).join("");
  const photos = s.files.length ? `<p style="margin:16px 0 4px;color:#5b6570">Photos</p><ul style="margin:0;padding-left:18px">${s.files.map((f) => `<li><a href="${esc(f.url)}">${esc(f.name)}</a></li>`).join("")}</ul>` : "";
  const htmlBody = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#18212b;max-width:560px"><p style="margin:0 0 12px">A new ${kind} from your website, <strong>${esc(input.site)}</strong>.</p><table style="border-collapse:collapse">${rows}</table>${photos}<p style="margin:16px 0 0">${esc(reply)}</p><p style="margin:24px 0 0;color:#5b6570;font-size:13px">Sent by Velocity Media Lab for ${esc(input.clientName)}.</p></div>`;
  return { subject, textBody, htmlBody };
}

export function testEmail(input: { site: string; clientName: string; confirmUrl: string }): RelayEmail {
  const subject = `Test: messages from your new website (${input.site})`;
  const textBody = `This is a test from ${input.clientName}'s new website, ${input.site}.\n\nWhen a visitor fills in a form on the site, their message will come to this address, from this sender.\n\nPlease confirm you got this test:\n${input.confirmUrl}\n\nIf you found it in spam or junk, mark it Not spam first, so the real ones arrive in your inbox.\n\n--\nVelocity Media Lab`;
  const htmlBody = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#18212b;max-width:560px"><p>This is a test from ${esc(input.clientName)}'s new website, <strong>${esc(input.site)}</strong>.</p><p>When a visitor fills in a form on the site, their message will come to this address, from this sender.</p><p><a href="${esc(input.confirmUrl)}" style="display:inline-block;background:#205af2;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">I got it</a></p><p style="color:#5b6570">If you found this in spam or junk, mark it Not spam first, so the real ones arrive in your inbox.</p><p style="color:#5b6570;font-size:13px">Velocity Media Lab</p></div>`;
  return { subject, textBody, htmlBody };
}

/* ---------- Postmark's webhooks ---------- */

export type DeliveryEvent = { messageId: string; status: "delivered" | "bounced" | "spam"; detail: string; at: Date };

/* Postmark's Delivery, Bounce and SpamComplaint webhooks, as one shape; null for anything else. */
export function readPostmarkEvent(json: unknown): DeliveryEvent | null {
  const o = json as { RecordType?: string; MessageID?: string; DeliveredAt?: string; BouncedAt?: string; Description?: string; Details?: string; Type?: string; Recipient?: string; Email?: string } | null;
  if (!o?.RecordType || !o.MessageID) return null;
  const at = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : new Date());
  if (o.RecordType === "Delivery") return { messageId: o.MessageID, status: "delivered", detail: `Delivered to ${o.Recipient ?? "the inbox server"}.`, at: at(o.DeliveredAt) };
  if (o.RecordType === "Bounce") return { messageId: o.MessageID, status: "bounced", detail: `${o.Email ?? "The address"} bounced: ${o.Description ?? o.Type ?? "no reason given"}`.slice(0, 500), at: at(o.BouncedAt) };
  if (o.RecordType === "SpamComplaint") return { messageId: o.MessageID, status: "spam", detail: `${o.Email ?? "The recipient"} marked it as spam.`, at: at(o.BouncedAt) };
  return null;
}
