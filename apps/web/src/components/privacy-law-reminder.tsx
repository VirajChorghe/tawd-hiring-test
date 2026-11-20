import Link from "next/link";

import { getDb } from "@tawd/core/db";
import { isReviewDue } from "@/lib/privacy-laws";

/* The quarterly "Review privacy laws" reminder, for admins, on every page (28 September 2026). */
export async function PrivacyLawReminder() {
  if (!(await isReviewDue(getDb()))) return null;
  return (
    <div className="spend-banner" role="status">
      <strong>Time to review the state privacy laws.</strong> It&rsquo;s been three months: check each rule against its official source.{" "}
      <Link href="/admin/privacy-laws">Review privacy laws</Link>
    </div>
  );
}
