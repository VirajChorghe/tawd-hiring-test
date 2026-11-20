/*
  The fixed value sets, with no imports at all.

  They live here rather than in the Drizzle schema because forms in the
  browser need them. Importing them from the schema would drag the database
  layer into the client bundle. The schema imports these instead.

  Stored values are snake_case and must stay stable: they are written into the
  activity log, which cannot be rewritten.
*/

export const teamRoles = [
  "founder",
  "pm",
  "web_designer",
  "seo",
  "content",
] as const;
export type TeamRole = (typeof teamRoles)[number];

/*
  Which front door a project came through (Part 2, task 1, 3 November 2026).
  "team": made by the VML team in TAWD, exactly as before (every existing project).
  "self_serve": made by a customer in the customer app; it belongs to one customer.
  Self-serve rules (auto-advance, customer approvals, the pay wall) apply only to
  self-serve projects. Called "flow" in code because project-type.ts already means
  the Lane and hosting change; on screen it reads "Team" / "Self-serve".
*/
export const projectFlows = ["team", "self_serve"] as const;
export type ProjectFlow = (typeof projectFlows)[number];

export const trades = [
  "plumbing",
  "hvac",
  "electrical",
  "roofing",
  "legal",
  "glass_and_windows",
  "garage_doors",
  "well_and_pump",
  "home_services",
  // Jason, 27 September 2026 (Finley Pest Control fell through to "other").
  "pest_control",
  "med_spa",
  // Creative businesses (Jason, 26 September 2026): Gallery and Portfolio leads for these.
  "interior_design",
  "art_decorative_finishes",
  "photography",
  "architecture_remodeling",
  "other",
] as const;
export type Trade = (typeof trades)[number];

export const tiers = ["starter", "growth", "pro"] as const;
export type Tier = (typeof tiers)[number];

export const lanes = ["lane_1", "lane_2"] as const;
export type Lane = (typeof lanes)[number];

// Lane 2 only. A: the supplied design is client-approved, build it as is.
// B: treat the supplied design as a reference, review and improve it.
export const laneOptions = ["a", "b"] as const;
export type LaneOption = (typeof laneOptions)[number];

export const projectStatuses = [
  "intake",
  "mockups",
  "content",
  "build",
  "qa",
  "live",
  "paused",
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
