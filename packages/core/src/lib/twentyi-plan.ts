/*
  VML's 20i plan, in a module with nothing server-side in it, so a screen
  can name it (8 October 2026: the preview card said "50 packages" in fixed
  text while the plan holds 25). wp-preview.ts re-exports it.
*/

/** VML's 20i plan (Todd bought Reseller 25, 6 October 2026): one package per site. */
export const TWENTYI_PLAN = { name: "Reseller 25", limit: 25 } as const;
/** The plan a package past the limit moves VML to. UNCONFIRMED: Jason asks 20i (7 October 2026); Reseller 50 was $39.99 a month on 5 October. */
export const TWENTYI_NEXT_PLAN = { name: "Reseller 50", monthly: 39.99 } as const;
