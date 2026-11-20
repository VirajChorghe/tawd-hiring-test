import Link from "next/link";

import { getDb } from "@tawd/core/db";
import { loadE2eCheck } from "@/lib/e2e-check";

/*
  For admins, on every page, only when the latest Site check failed (29
  September 2026): the Site check left the top bar, so a failure still has
  to be seen.
*/
export async function SiteCheckWarning() {
  const check = await loadE2eCheck(getDb());
  if (check?.status !== "failed") return null;
  const step = check.steps.find((s) => s.status === "failed");
  return (
    <div className="spend-banner is-blocked" role="status">
      <strong>The last Site check failed{step ? ` at "${step.label}"` : ""}.</strong>{" "}
      {step?.detail ? `${step.detail} ` : ""}
      <Link href="/admin/system#site-check">Open System</Link>
    </div>
  );
}
