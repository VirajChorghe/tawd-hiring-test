import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { requireUser } from "@/lib/session";
import { UpdatesError } from "@/lib/updates";
import { quoteDocument } from "@/lib/updates-docs";

/* The quote as a clean page, to print or save as PDF for the client (Updates, 1 October 2026). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; quoteId: string }> }): Promise<Response> {
  const { id, quoteId } = await params;
  const viewer = await requireUser();
  if (!can(viewer, "project.view")) return new Response("Not allowed", { status: 403 });
  try {
    return new Response(await quoteDocument(getDb(), id, quoteId), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UpdatesError) return new Response(error.message, { status: 404 });
    throw error;
  }
}
