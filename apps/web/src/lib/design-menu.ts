/*
  The approved design's menu against the page plan (17 November 2026).

  A supplied homepage is the design the client approved, and its menu says
  what the site's pages are. A plan made before that approval, or a page
  someone renamed by hand afterwards, leaves the plan naming pages the menu
  does not. TAWD never remakes the plan by itself: remaking it replaces
  every page and takes their drafts with them, so the team decides.

  This is the one place that comparison is made. Both the Page plan card and
  the Next step bar read it, so they can never disagree about whether the
  plan follows the design — the first version of this put the sentence on
  the card alone, and the bar went on offering to draft the pages the design
  does not have (the browser walk of #107, on live TAWD).
*/
import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { pagePlanPage } from "@tawd/core/schema";
import { isHomeLabel } from "@tawd/core/supplied-nav";
import { suppliedHomeNav } from "@tawd/core/site-read";

/** The design's menu items this plan has no page for, in the design's order. Empty when the plan follows the menu, or when there is no supplied design. */
export async function missingMenuItems(db: Database, projectId: string, pages?: { name: string }[]): Promise<string[]> {
  const plan = pages ?? (await db.select({ name: pagePlanPage.name }).from(pagePlanPage).where(eq(pagePlanPage.projectId, projectId)));
  if (plan.length === 0) return [];
  const nav = await suppliedHomeNav(db, projectId);
  if (!nav?.length) return [];
  const have = new Set(plan.map((p) => p.name.trim().toLowerCase()));
  return nav.filter((link) => !isHomeLabel(link.label) && !have.has(link.label.trim().toLowerCase())).map((link) => link.label);
}

/*
  What the team reads. Two things it must not do (CodeRabbit's third pass on
  #107). It must not say why the pages are missing: this compares names and
  has read no date, so "the plan was made before the design was approved"
  was a fact TAWD had not checked, and it is also the team's own wording
  after someone renames a page. And it must not name the "Make it again"
  button: that button is drawn only for someone who can edit the plan, so a
  sentence naming it would point a Designer or a Founder at a button not on
  their screen.
*/
export function designMenuWarning(missing: string[]): string | null {
  if (missing.length === 0) return null;
  return `The design the client approved has ${missing.length} menu item${missing.length === 1 ? "" : "s"} this plan has no page for: ${missing.join(", ")}. Making the plan again follows the design's menu, and replaces every page in the plan.`;
}
