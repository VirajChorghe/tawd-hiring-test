import { getDb } from "@tawd/core/db";
import { assertCan } from "@tawd/core/permissions";
import { designCopyPage } from "@/lib/design-copy";
import { requireUser } from "@/lib/session";

/*
  The faithful copy as a working web page, for signed-in team members only.
  Served in a sandbox (no scripts, its own origin), since the page was
  written by the AI from the designer's content.
*/
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  // A page of an Option A design, by its copy's id (28 September 2026).
  const copyId = new URL(request.url).searchParams.get("copy");
  const current = await requireUser();
  assertCan(current, "project.view");
  const html = await designCopyPage(getDb(), id, copyId);
  if (!html) return new Response("There is no finished copy yet.", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
