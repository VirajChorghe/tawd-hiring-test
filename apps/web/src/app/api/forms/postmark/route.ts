import { timingSafeEqual } from "node:crypto";

import { getDb } from "@tawd/core/db";
import { recordPostmarkEvent } from "@/lib/forms-relay";
import { recordLabEvent } from "@/lib/delivery-checks";
import { readPostmarkEvent } from "@tawd/core/forms-relay";
import { getClientIp, getUserAgent, readBodyCapped } from "@/lib/request";

/*
  F2: Postmark's Delivery, Bounce and Spam complaint webhooks. Postmark
  signs in with the user name "tawd" and POSTMARK_WEBHOOK_SECRET (basic
  auth, set in the webhook's URL in Postmark); anything else is refused.
*/
export const dynamic = "force-dynamic";

function authorized(header: string | null): boolean {
  const secret = process.env.POSTMARK_WEBHOOK_SECRET?.trim();
  if (!secret || !header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64");
  const wanted = Buffer.from(`tawd:${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get("authorization"))) return new Response("Unauthorized", { status: 401 });
  const raw = await readBodyCapped(request, 100_000);
  if (raw === null) return new Response("Bad request", { status: 400 });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  // Postmark only needs to hear 200; an event about a message TAWD doesn't know is simply ignored.
  const db = getDb();
  const known = await recordPostmarkEvent({ db, ipAddress: getClientIp(request.headers), userAgent: getUserAgent(request.headers) }, json);
  // F4: a report on a delivery check to VML's test inboxes.
  const event = known ? null : readPostmarkEvent(json);
  if (event) await recordLabEvent(db, event.messageId, event.status, event.detail);
  return new Response("ok", { status: 200 });
}
