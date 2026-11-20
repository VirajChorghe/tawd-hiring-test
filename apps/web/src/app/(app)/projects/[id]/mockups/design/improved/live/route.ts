import { getDb } from "@tawd/core/db";
import { assertCan } from "@tawd/core/permissions";
import { designImprovementPage } from "@/lib/design-improvement";
import { requireUser } from "@/lib/session";

/*
  The improved design as a working web page, for signed-in team members only.
  Served in a sandbox (no scripts, its own origin), since the page was
  written by the AI from the designer's content.
*/
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const current = await requireUser();
  assertCan(current, "project.view");
  // ?v=decisions: the version with the designer's decisions.
  const kind = new URL(request.url).searchParams.get("v") === "decisions" ? "decisions" : "fixes";
  const html = await designImprovementPage(getDb(), id, kind);
  if (!html) return new Response("There is no finished improved design yet.", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
