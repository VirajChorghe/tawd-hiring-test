import Link from "next/link";

import { getDb } from "@tawd/core/db";
import { formatCost } from "@tawd/core/mockups";
import { getLimitState } from "@/lib/spend";

/*
  The in-app warning at 80% of the monthly AI limit, for admins, on every
  page. At 100% it says new runs are paused. Anthropic's own cap refuses the
  calls anyway, so a run started past it would fail part-way and waste what
  it had already spent.
*/
export async function SpendWarning() {
  const state = await getLimitState(getDb());
  if (!state.warn) return null;

  return (
    <div className={state.blocked ? "spend-banner is-blocked" : "spend-banner"} role="status">
      <strong>
        {state.blocked
          ? "Monthly AI limit reached: new runs are paused."
          : `AI spend is at ${Math.floor(state.ratio * 100)}% of this month's limit.`}
      </strong>{" "}
      {formatCost(state.spent)} of {formatCost(state.limit)} so far.{" "}
      {state.blocked
        ? "Raise the limit on the Spend page and the cap in the Anthropic console to start new runs."
        : "Generate is paused automatically at 100%."}{" "}
      <Link href="/admin/spend">Open Spend</Link>
    </div>
  );
}
