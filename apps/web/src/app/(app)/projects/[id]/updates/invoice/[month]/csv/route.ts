import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { requireUser } from "@/lib/session";
import { UpdatesError } from "@/lib/updates";
import { invoiceCsvFile } from "@/lib/updates-docs";

/* The month's invoice as CSV, for the books (Updates, 1 October 2026). Admins only. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; month: string }> }): Promise<Response> {
  const { id, month } = await params;
  const viewer = await requireUser();
  if (!can(viewer, "money.manage")) return new Response("Admins only", { status: 403 });
  try {
    const file = await invoiceCsvFile(getDb(), id, month);
    return new Response(file.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${file.fileName}"`, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UpdatesError) return new Response(error.message, { status: 404 });
    throw error;
  }
}
