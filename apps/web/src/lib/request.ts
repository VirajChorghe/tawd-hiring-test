/*
  TAWD runs behind Coolify's reverse proxy, so the socket address is always
  the proxy. The visitor's real address arrives in a forwarded header.

  Which header, and which entry (C4, audit F-022, 12 November 2026): the
  caller can send any x-forwarded-for it likes, and the leftmost entry is
  exactly what it typed; the audit varied it on every try and was never
  throttled. x-real-ip is set by Coolify's proxy itself, so it comes first.
  Failing that, the RIGHTMOST x-forwarded-for entry: the one the proxy in
  front of TAWD appended, which the caller cannot choose (with one proxy
  hop, as on the droplet). Still an address for the record, never on its own
  the basis of an access decision.
*/

export function getClientIp(headers: Headers): string | null {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const chain = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return chain.at(-1) ?? null;
}

export function getUserAgent(headers: Headers): string | null {
  const value = headers.get("user-agent");
  if (!value) return null;
  // Keep the log readable and bounded.
  return value.length > 512 ? value.slice(0, 512) : value;
}

/*
  A request body read up to a limit (13 October 2026, the whole-code
  review). The public webhooks take posts from anyone: a declared size over
  the limit is refused before reading, and the read stops as soon as the
  bytes pass it, so a huge post can't fill the web app's memory. Null means
  too big or unreadable.
*/
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}
