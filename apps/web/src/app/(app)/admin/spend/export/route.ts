import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { formatWhen } from "@/lib/labels";
import { getCurrentUser } from "@/lib/session";
import { loadSpendReport } from "@/lib/spend";
import {
  pacificToday,
  parsePeriod,
  resolvePeriod,
  callsCsv,
  spendCsv,
} from "@/lib/spend-report";

/*
  The Spend page's CSV: one row per run in the chosen period, with its cost
  split by step and its token counts; or, with by=call, one row per AI call
  (its step, model, tokens, dollars and time). Admins only, like the page.
*/
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const current = await getCurrentUser();
  // The same bar as requireUser, answered with a status instead of a redirect.
  if (!current || current.mustChangePassword || !can(current, "spend.view")) {
    return new Response("Not allowed.", { status: 403 });
  }

  const url = new URL(request.url);
  const today = pacificToday();
  const period = resolvePeriod(
    parsePeriod(
      {
        period: url.searchParams.get("period") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
      },
      today,
    ),
    today,
  );

  const { report } = await loadSpendReport(getDb(), current, period);
  const perCall = url.searchParams.get("by") === "call";
  const name = `tawd-spend${perCall ? "-per-call" : ""}-${
    period.kind === "custom" ? `${period.from}-to-${period.to}` : period.value
  }.csv`;

  return new Response(perCall ? callsCsv(report, formatWhen) : spendCsv(report, formatWhen), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
