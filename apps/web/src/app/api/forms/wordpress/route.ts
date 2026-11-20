import { getDb } from "@tawd/core/db";
import { receiveWordpress } from "@/lib/forms-relay";
import { getClientIp, getUserAgent, readBodyCapped } from "@/lib/request";

/*
  F2: a form message from a client's WordPress site (TAWD's theme sends it).
  No login: the theme signs each one with the project's key and the time
  (X-Tawd-Signature); anything unsigned, signed wrongly or older than ten
  minutes is refused, and the site then emails the client itself.
*/
export const dynamic = "force-dynamic";

const MAX_BODY = 200_000;
const STATUS = { ok: 200, unknown: 404, forbidden: 401, unreadable: 400 } as const;

export async function POST(request: Request): Promise<Response> {
  const projectId = new URL(request.url).searchParams.get("project") ?? "";
  if (!projectId) return new Response("Bad request", { status: 400 });
  const raw = await readBodyCapped(request, MAX_BODY);
  if (raw === null) return new Response("Bad request", { status: 400 });
  const result = await receiveWordpress({ db: getDb(), ipAddress: getClientIp(request.headers), userAgent: getUserAgent(request.headers) }, projectId, raw, request.headers.get("x-tawd-signature"));
  return new Response(result, { status: STATUS[result] });
}
