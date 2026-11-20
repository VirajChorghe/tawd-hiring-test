import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { rebaseSiteFile, siteFileKey } from "@/lib/site-builds";
import { requireUser } from "@/lib/session";

/*
  A built site, viewed inside TAWD before any deploy (8a): each file read
  from R2 as it will be served, links pointed at this build. Team only.

  In a sandbox with no scripts (13 October 2026, the whole-code review): a
  page here runs on TAWD's own address, so a script in it (the AI's, or a
  client's tag manager) could act as the person viewing it. Same origin is
  kept so Review pages can draw its pins on the page; nothing in the page
  itself runs. The real site, scripts and all, is the preview on Netlify.
*/
export const dynamic = "force-dynamic";

const BUILT_SITE_SANDBOX = {
  "Content-Security-Policy": "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
};

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  xml: "application/xml",
  txt: "text/plain; charset=utf-8",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; version: string; path?: string[] }> },
): Promise<Response> {
  await requireUser();
  const { id, version, path = [] } = await params;
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) return new Response("Not found", { status: 404 });
  let prefix: string;
  try {
    prefix = projectStoragePrefix(id);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const key = siteFileKey(prefix, v, path);
  if (!key) return new Response("Not found", { status: 404 });
  const body = await getStorage().get(key);
  if (!body) return new Response("Not found", { status: 404 });
  const ext = key.split(".").pop()!.toLowerCase();
  const type = TYPES[ext] ?? "application/octet-stream";
  const base = `/projects/${id}/build/site/${v}`;
  const out = ext === "html" || ext === "css" ? rebaseSiteFile(body.toString("utf8"), base) : new Uint8Array(body);
  return new Response(out, { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", ...BUILT_SITE_SANDBOX } });
}
