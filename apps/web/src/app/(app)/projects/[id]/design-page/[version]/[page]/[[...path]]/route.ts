import { getStorage } from "@tawd/core/intake/storage";
import { ASSET_FILE_NAME, isReadRunId, readAssetKeys } from "@tawd/core/figma/read-assets";
import { readPageKeys } from "@tawd/core/figma/read-page";
import { loadSavedReadItems } from "@/lib/design-read-items";
import { requireUser } from "@/lib/session";

/*
  The page built from the new design read, viewed inside TAWD (E5a, Lane 2,
  15 November 2026). Admin only, like the rest of the new route.

  The page is written by the AI, so it is served under the same sandbox the
  built-site preview uses and for the same reason (13 October 2026, the
  whole-code review): it runs on TAWD's own address, so anything scripted
  in it could act as the person viewing it. Nothing in the page runs here.
  A built page should carry no JavaScript at all -- the build is told not
  to, and code reports it when it does -- but the sandbox does not depend
  on that being true.

  The read's own runId is looked up rather than taken from the address, so
  what is served is always the page of the read that is saved now, and no
  address can be pointed at another read's folder.
*/
export const dynamic = "force-dynamic";

/*
  Nothing runs, and nothing is fetched from anywhere but TAWD. `default-src
  'none'` matters as much as `script-src`: the build is told to load nothing
  from the internet and code reports it when it does, but a page that
  slipped through would otherwise still fetch a remote picture or stylesheet
  from an admin's browser, which both tells that address the page was opened
  and lets it decide what is drawn.
*/
const SANDBOX = {
  "Content-Security-Policy":
    "sandbox allow-same-origin; default-src 'none'; script-src 'none'; object-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; version: string; page: string; path?: string[] }> }): Promise<Response> {
  const user = await requireUser();
  if (!user.isAdmin) return new Response("Not found", { status: 404 });

  const { id, version, page, path = [] } = await params;
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) return new Response("Not found", { status: 404 });
  if (path.length > 1) return new Response("Not found", { status: 404 });

  const saved = await loadSavedReadItems(id, version, n);
  const runId = saved?.runId ?? null;
  if (!runId || !isReadRunId(id, runId)) return new Response("Not found", { status: 404 });

  const storage = getStorage();

  /*
    The page is served at ".../<page>/index.html", not ".../<page>", so that
    the plain `<img src="p3.png">` the build writes resolves to
    ".../<page>/p3.png" and lands on this route's file branch. Served one
    level up, the browser would resolve it to ".../<version>/p3.png", which
    is not a page number and 404s: every picture on the page would be
    broken, and the file branch below could never be reached at all.
  */
  const file = path[0] === "index.html" ? undefined : path[0];
  if (file !== undefined && file !== "") {
    if (!ASSET_FILE_NAME.test(file)) return new Response("Not found", { status: 404 });
    const bytes = await storage.get(readAssetKeys(id, version, n, runId).file(file));
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", ...SANDBOX } });
  }

  const html = await storage.get(readPageKeys(id, version, n, runId).html);
  if (!html) return new Response("No page has been built from this read yet.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(html.toString("utf8"), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SANDBOX } });
}
