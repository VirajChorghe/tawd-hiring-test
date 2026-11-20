import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { commentsCsv, loadCommentRows } from "@/lib/comments-export";
import { formatWhen } from "@/lib/labels";
import { getCurrentUser } from "@/lib/session";

/* Comments and fixes (8 October 2026): every team comment on a concept, as a CSV. Admins only, like Spend. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const current = await getCurrentUser();
  if (!current || current.mustChangePassword || !can(current, "spend.view")) {
    return new Response("Not allowed.", { status: 403 });
  }
  const db = getDb();
  return new Response(commentsCsv(await loadCommentRows(db), formatWhen), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tawd-comments-and-fixes.csv"',
      "Cache-Control": "no-store",
    },
  });
}
