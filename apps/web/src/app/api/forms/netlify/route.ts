import { getDb } from "@tawd/core/db";
import { receiveNetlify } from "@/lib/forms-relay";
import { getClientIp, getUserAgent, readBodyCapped } from "@/lib/request";

/*
  F2: Netlify's "submission created" webhook for a client site's forms. No
  login: Netlify signs each one with the project's key (X-Webhook-Signature),
  and anything unsigned or signed wrongly is refused.
*/
export const dynamic = "force-dynamic";

const MAX_BODY = 200_000;
const STATUS = { ok: 200, unknown: 404, forbidden: 401, unreadable: 400 } as const;

export async function POST(request: Request): Promise<Response> {
  const site = new URL(request.url).searchParams.get("site") ?? "";
  if (!site) return new Response("Bad request", { status: 400 });
  const raw = await readBodyCapped(request, MAX_BODY);
  if (raw === null) return new Response("Bad request", { status: 400 });
  const result = await receiveNetlify({ db: getDb(), ipAddress: getClientIp(request.headers), userAgent: getUserAgent(request.headers) }, site, raw, request.headers.get("x-webhook-signature"));
  return new Response(result, { status: STATUS[result] });
}
