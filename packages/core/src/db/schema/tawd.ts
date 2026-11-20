import { sql } from "drizzle-orm";
import {
  check,
  date,
  bigint,
  boolean,
  real,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { customer } from "./customer";

// The value sets live in src/lib/enums.ts so forms can use them without
// pulling the database layer into the browser bundle.
export * from "@tawd/core/enums";

/*
  Fixed value sets are stored as plain text columns, validated by zod in
  src/lib/validation.ts, rather than as PostgreSQL enum types.

  Reason: migrations must stay backward-compatible because Coolify keeps the
  old container running while the new one starts. Adding a value to a
  PostgreSQL enum is awkward and removing one is close to impossible, whereas
  a text column takes a new value with no migration at all.
*/

export const userRole = pgTable(
  "user_role",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

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

export const project = pgTable("project", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientName: text("client_name").notNull(),
  trade: text("trade").notNull(),
  tier: text("tier").notNull(),
  lane: text("lane").notNull(),
  // Null on Lane 1, where the option does not apply.
  laneOption: text("lane_option"),
  // 1 to 3. Null on Lane 2 Option A, which has no concepts: the approved
  // design is built directly. See skills/TAWD-PROFILE.md section 9.
  conceptCount: integer("concept_count"),
  status: text("status").notNull().default("intake"),
  /*
    Money (Phase 5, 26 September 2026), in whole cents, admins only: the
    package and prices this project was sold at, copied from the price list
    when it was created (later list changes never touch it; an admin can
    change it with a logged reason). Going Live stamps liveAt: the build fee
    counts that month, the monthly fee every month from then until the month
    it was cancelled. No card or payment data anywhere.
  */
  packageKey: text("package_key"),
  buildFeeCents: integer("build_fee_cents"),
  monthlyFeeCents: integer("monthly_fee_cents"),
  liveAt: timestamp("live_at", { withTimezone: true }),
  cancelledOn: date("cancelled_on"),
  cancelReason: text("cancel_reason"),
  /*
    Where the client's site lives (Build B, 4b, 27 September 2026):
    "netlify" (Build A, the default) or "wordpress" (Build B, on 20i since 5 October 2026).
    PMs and admins change it, logged; locked once the site is live.
  */
  hosting: text("hosting").notNull().default("netlify"),
  // Build B (1 October 2026): the WordPress site's form plugin, "cf7" (Contact Form 7, the default) or "gravityforms" (VML's licence).
  formPlugin: text("form_plugin").notNull().default("cf7"),
  /*
    A test project and its AI spending cap (Jason, 28 September 2026): a
    run that would take the project's AI spend past the cap doesn't start.
    A test project's cap is $5 unless an admin sets another; an admin can
    cap any project. Whole cents; null is no cap.
  */
  isTest: boolean("is_test").notNull().default(false),
  aiCapCents: integer("ai_cap_cents"),
  // The client's social videos for the site (29 September 2026): TikTok and Instagram links, click-to-play.
  videos: jsonb("videos"),
  createdByUserId: text("created_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /*
    Team or self-serve (Part 2, task 1, 3 November 2026; values in enums.ts).
    Every existing project is "team". A self-serve project belongs to exactly
    one customer and a team project to none: the database refuses anything
    else (project_flow_customer), so ownership can't be half-set by any code
    path. A customer can't be deleted while they own a project.
  */
  flow: text("flow").notNull().default("team"),
  customerId: text("customer_id").references(() => customer.id, { onDelete: "restrict" }),
}, (table) => [
  check(
    "project_flow_customer",
    sql`(${table.flow} = 'team' AND ${table.customerId} IS NULL) OR (${table.flow} = 'self_serve' AND ${table.customerId} IS NOT NULL)`,
  ),
  index("project_customer_id_idx").on(table.customerId),
]);

export const projectMember = pgTable(
  "project_member",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

/*
  The activity log.

  Append-only, enforced by a database trigger created in a hand-written
  migration: any UPDATE, DELETE or TRUNCATE raises an exception, so no code
  path in TAWD can rewrite history.

  Each row also carries a fingerprint chaining it to the row before it, so
  tampering by someone with direct database access is detectable even though
  it cannot be prevented. See src/lib/activity.ts.
*/
export const activityLog = pgTable(
  "activity_log",
  {
    // Identity column, so ordering is unambiguous even for rows written in
    // the same millisecond. The hash chain follows this order.
    seq: bigint("seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    // Nullable: a failed login from an address with no account still gets
    // recorded. actorEmail is kept as plain text so the entry stays readable
    // even when there is no user to join to.
    actorUserId: text("actor_user_id").references(() => user.id),
    actorEmail: text("actor_email"),

    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),

    valueBefore: jsonb("value_before"),
    valueAfter: jsonb("value_after"),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    // Fingerprint of the previous entry, null for the very first one.
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (table) => [
    index("activity_log_entity_idx").on(table.entityType, table.entityId),
    index("activity_log_occurred_at_idx").on(table.occurredAt),
  ],
);

/*
  Failed login throttling, separate from Better Auth's own rate limiter so the
  rule is ours to reason about and test: five failures for one email address
  within fifteen minutes locks that address for fifteen minutes.
*/
export const loginAttempt = pgTable(
  "login_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    ipAddress: text("ip_address"),
    succeeded: boolean("succeeded").notNull().default(false),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("login_attempt_email_idx").on(table.email, table.attemptedAt)],
);

/*
  The client intake.

  One row per project, holding the form as a single JSON document rather than
  forty columns.

  The reason is migration safety. Coolify keeps the old container running
  while the new one starts, so every migration has to be backward-compatible,
  and this form will certainly change as real clients come through. A document
  absorbs a new question with no migration at all.

  The trade-off is that the database does not type-check the contents, so
  every read and write goes through the zod schema in src/lib/intake/schema.ts
  instead. Nothing writes here directly.
*/
export const projectIntake = pgTable("project_intake", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull().default({}),
  updatedByUserId: text("updated_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
  Uploaded files.

  These get real rows because they have a life of their own: uploaded,
  viewed, captioned, removed. The file itself lives in Cloudflare R2 and never
  touches the droplet's disk; `storageKey` is where to find it.

  A row is written before the upload starts, with status "pending", and moves
  to "ready" once the upload is confirmed and its real size checked. A row
  left pending means the browser gave up part-way through.
*/
export const intakeFileKinds = [
  "logo",
  "brand_guide",
  "photo",
  "content_document",
] as const;

export const intakeFile = pgTable(
  "intake_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    caption: text("caption"),
    status: text("status").notNull().default("pending"),
    uploadedByUserId: text("uploaded_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("intake_file_project_idx").on(table.projectId, table.kind)],
);

/*
  The mockup engine.

  A run produces one to three concepts. Each concept is built by one design
  skill in one direction, then checked, reviewed, improved once and checked
  again. Every stage of every concept is a row in concept_step, which is what
  the generating screen reads.

  Money is deliberately NOT stored. Token counts are, and the dollars and
  cents are worked out from the configured rates when they are displayed.
  Prices change and a model can turn out to cost something other than we
  thought; tokens are the fact, the money is a calculation.
*/

export const mockupRunStatuses = [
  "queued",
  "running",
  "succeeded",
  // Built, but at least one concept still shows a placeholder for a field
  // the intake gate treats as required. Not client-ready until it is filled.
  "needs_intake",
  // Built, but a concept's final checks still fail after the fix rounds.
  "checks_failed",
  // Built and reviewed, but a concept still scores under 3 on a Creative
  // Director question after its one rebuild. The PM decides what next.
  "needs_pm_review",
  // The concepts were built but the Creative Director review did not finish.
  "review_incomplete",
  "failed",
  "stopped",
] as const;
export type MockupRunStatus = (typeof mockupRunStatuses)[number];

export const conceptLabels = ["A", "B", "C"] as const;
export type ConceptLabel = (typeof conceptLabels)[number];

export const conceptStatuses = [
  "queued",
  "running",
  "ready",
  // Scored under 4.5 (8 October 2026): not shown to the PM or the client until an admin shows it anyway.
  "held",
  "failed",
  "stopped",
] as const;
export type ConceptStatus = (typeof conceptStatuses)[number];

export const pipelineSteps = [
  "build",
  "checks",
  "review",
  "improve",
  "final_checks",
] as const;
export type PipelineStep = (typeof pipelineSteps)[number];

export const stepStatuses = [
  "waiting",
  "working",
  "done",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof stepStatuses)[number];

export const mockupRun = pgTable(
  "mockup_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptCount: integer("concept_count").notNull(),
    // Critique and polish once per concept after the review (27 September 2026); the PM can skip it. New runs set it on; older runs had none.
    polish: boolean("polish").notNull().default(false),
    status: text("status").notNull().default("queued"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    // What the team was told it would cost, before anything ran.
    estimatedInputTokens: bigint("estimated_input_tokens", { mode: "number" }),
    estimatedOutputTokens: bigint("estimated_output_tokens", { mode: "number" }),
    // The model actually used, recorded per run: it is configurable, so a
    // run from last month may have used a different one.
    model: text("model").notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("mockup_run_project_idx").on(table.projectId)],
);

export const concept = pgTable(
  "concept",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => mockupRun.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The neutral label the client sees. Nothing on a concept says which
    // skill made it: TAWD-PROFILE section 9, "Both options".
    label: text("label").notNull(),
    direction: text("direction").notNull(),
    skillId: text("skill_id").notNull(),
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    // Set once the team decides to include it in the client pack.
    sendToClient: boolean("send_to_client").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Stamped every minute while the worker builds the concept. A "running" concept whose heartbeat is over ten minutes old (or missing: counted from created_at) was left by a worker that stopped, and the next delivery of its job takes it over.
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  },
  (table) => [index("concept_run_idx").on(table.runId)],
);

export const conceptVersion = pgTable(
  "concept_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    // 1 as built, 2 after the improvement round.
    version: integer("version").notNull(),
    // Token counts below are the concept's running total when this version
    // was stored, not this version's own share. See conceptSpend().
    // Where the artefacts live in R2. The HTML is the source of truth; the
    // PNGs are what the client is shown.
    htmlKey: text("html_key"),
    pngKey: text("png_key"),
    foldPngKey: text("fold_png_key"),
    checks: jsonb("checks"),
    review: jsonb("review"),
    summary: text("summary"),
    placeholderCount: integer("placeholder_count"),
    // How much of each reference site this version used (0.99.0, reference-use.ts): measured by code once, the first time it's shown.
    referenceUse: jsonb("reference_use"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("concept_version_concept_idx").on(table.conceptId)],
);

export const conceptStep = pgTable(
  "concept_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    status: text("status").notNull().default("waiting"),
    // One short line for the generating screen: "Checking layout",
    // "1 fix: contrast", "Fixing note 2 of 3".
    detail: text("detail"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("concept_step_concept_idx").on(table.conceptId)],
);

/*
  The design log.

  Written when a concept is built, read before the next project in the same
  trade and city picks its directions, so two competitors down the road do
  not get the same look. DIRECTIONS.md selection rule 3.
*/
export const designLogEntry = pgTable(
  "design_log_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").references(() => concept.id, {
      onDelete: "set null",
    }),
    trade: text("trade").notNull(),
    city: text("city"),
    direction: text("direction").notNull(),
    // A coarse family such as "green" or "blue", so near-matches are caught
    // without pretending two hex codes are comparable.
    paletteFamily: text("palette_family"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("design_log_trade_city_idx").on(table.trade, table.city)],
);

/*
  A deleted project, remembered.

  Deleting a project removes its data and files, but the activity log is
  append-only and keeps every entry that mentions it. This row is what lets
  those entries still say which project they were about - "(deleted
  project) Pat Rivera" - and records who deleted it, when and why.

  The id is the old project id, deliberately with no foreign key: the
  project it pointed at is gone.
*/
export const deletedProject = pgTable("deleted_project", {
  id: uuid("id").primaryKey(),
  clientName: text("client_name").notNull(),
  trade: text("trade").notNull(),
  statusAtDeletion: text("status_at_deletion").notNull(),
  reason: text("reason").notNull(),
  filesRemoved: integer("files_removed").notNull(),
  deletedByUserId: text("deleted_by_user_id").references(() => user.id),
  deletedByEmail: text("deleted_by_email"),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/*
  What a deleted project's AI work consumed, kept for accounting.

  The token counts live on concept versions, which go when a project is
  deleted. One row per concept is copied here first, so the spend stays
  queryable. Tokens, not money, as everywhere else: the dollars are worked
  out from the configured rates when shown.
*/
export const aiUsageArchive = pgTable(
  "ai_usage_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No foreign keys: every row here outlives the records it describes.
    projectId: uuid("project_id").notNull(),
    clientName: text("client_name").notNull(),
    runId: uuid("run_id").notNull(),
    conceptId: uuid("concept_id").notNull(),
    conceptLabel: text("concept_label").notNull(),
    direction: text("direction").notNull(),
    skillId: text("skill_id").notNull(),
    model: text("model").notNull(),
    versions: integer("versions").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("ai_usage_archive_project_idx").on(table.projectId)],
);

/*
  One row per AI call, written by the worker the moment the call returns.

  This is the spend ledger: the Spend page, the estimates and the monthly
  limit all read it. Token counts, never money - the dollars are worked out
  from the configured rates when shown.

  No foreign keys, on purpose. A project can be deleted; what its work cost
  cannot be un-spent, so these rows outlive everything they describe. The
  project's name is resolved from project or deleted_project when shown.
*/
export const aiCallSteps = [
  "build",
  "fix",
  "review",
  "improve",
  "rebuild",
  // Request changes, from the team or from the client's decision.
  "changes",
  // Lane 2, Option B: the Creative Director reviewing the designer's Figma design.
  "design_review",
  // Lane 2, Option B: the faithful HTML copy of the designer's homepage frame.
  "faithful_copy",
  // The cheap look at the faithful copy next to the design, section by section.
  "faithful_check",
  // Lane 2, Option B: the ticked fixes applied to the copy, one section at a time (and finding their sections).
  "design_improve",
  // The Creative Director scoring the improved design.
  "design_rescore",
  // Taking the designer's pushed-back changes out of a section that also has accepted ones.
  "design_decisions",
  // Phase 7b: one page's copy, drafted or redrafted.
  "content_draft",
  // Design + content (0.100.0): one page's words improved from the current site's.
  "content_improve",
  // Build A (8a): the shared header and footer, then each page of the site.
  "site_parts",
  "site_page",
  // Build A (8c): a monthly edit, one live page at a time.
  "site_edit",
  // The page review's Fix these (3 October 2026): the commented parts of one built page.
  "site_page_fix",
  // Add-on: TAWD designs an original wordmark logo when the client has none.
  "logo_design",
  // The Senior SEO agent's report on the current site (full audit), and its check of the built site before go-live.
  "seo_audit_report",
  "seo_golive_check",
  // Mockup inputs (27 September 2026): a reference site's brief, and the visible text in the client's photos.
  "reference_study",
  "photo_text",
  // Content first (1 October 2026): the home page's words for a new site, before the concepts.
  "home_words",
  // The one bounded pass after the Creative Director: Impeccable's critique, then its polish.
  "polish_critique",
  "polish",
  // An uploaded design page with no text layer, read by vision (28 September 2026).
  "design_read",
  // E5a: one page built from the new read, the whole design in one call.
  "design_page",
  // Option A: the phone version of an exactly copied page (CSS only).
  "design_mobile",
  // Lane 2's site from the design (29 September 2026): the header and footer, each page from its picture, a page reworked from feedback.
  "design_site_parts",
  "design_site_page",
  "design_site_rework",
] as const;
export type AiCallStep = (typeof aiCallSteps)[number];

export const aiCall = pgTable(
  "ai_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    // Null for a Creative Director review, which covers every concept at once.
    conceptId: uuid("concept_id"),
    step: text("step").notNull(),
    // The fix round (1 or 2) or the review pass, when the step has several.
    round: integer("round"),
    model: text("model").notNull(),
    // Who pressed Generate (or, from 3c, Request changes).
    startedByUserId: text("started_by_user_id"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" })
      .notNull()
      .default(0),
    // Written to the one-hour cache (charged at twice the input price), apart from the five-minute writes above.
    cacheWrite1hTokens: bigint("cache_write_1h_tokens", { mode: "number" }).notNull().default(0),
    // Rows filled in from concept versions stored before this ledger existed.
    backfilled: boolean("backfilled").notNull().default(false),
    /*
      Where the model's full answer is kept in R2, saved before anything
      reads it, so a paid answer is never lost to a parsing mistake. Under
      the project's folder: deleting the project removes the file and clears
      this, while the row itself (the spend) stays.
    */
    responseKey: text("response_key"),
    /*
      How much of the page the call worked on, for the before-and-after on
      Spend: "page" (the whole page sent and rewritten), "sections" (only
      the parts involved) or "locate" (the small call that finds which
      parts a written request is about). Null for steps it does not apply
      to (build, review, rebuild).
    */
    scope: text("scope"),
    /*
      How long the call took, from the request to the last word of the
      answer (8 October 2026, for the cost and time of each step). Summed
      over a multi-turn call's turns; null for calls made before it was kept.
    */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_call_created_idx").on(table.createdAt),
    index("ai_call_run_idx").on(table.runId),
    index("ai_call_project_idx").on(table.projectId),
  ],
);

/*
  Settings an admin can change without a deploy, such as the monthly AI
  limit. One row per key; every change is also in the activity log.
*/
/*
  Stops (Jason, 28 September 2026): the Stop button on running work. The
  key is a kind of work on a project ("copies:<project id>") or one copy
  ("copy:<copy id>"); the worker ends jobs queued before requestedAt at
  their next AI call.
*/
export const stopRequest = pgTable("stop_request", {
  key: text("key").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  requestedByUserId: text("requested_by_user_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appSetting = pgTable("app_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ---------- Phase 3c: team review, changes and the client's decision ---------- */

/*
  A team comment on a concept.

  Pinned comments carry where they were placed, as percentages of the full
  page render, and the version they were placed on: a pin only makes sense
  on the image it was dropped on. A reply has a parent and no pin.

  Comments stay with the team until somebody uses Request changes. The
  comments included in a request point at it, and sentInVersion says which
  version they went into ("Sent in v3").
*/
export const conceptComment = pgTable(
  "concept_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    version: integer("version").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    body: text("body").notNull(),
    pinX: real("pin_x"),
    pinY: real("pin_y"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id),
    changeRequestId: uuid("change_request_id"),
    sentInVersion: integer("sent_in_version"),
    /*
      The section (band) of its version a pin sits on, read from the bands
      measured with that version's render (2 October 2026). Null for a
      general comment, or a pin on a version measured before bands were kept.
    */
    band: integer("band"),
    /*
      What the Creative Director found after the comment was sent: "done" or
      "not_done", on outcome_version. The comment stays open until a person
      resolves it (Jason, 2 October 2026).
    */
    outcome: text("outcome"),
    outcomeVersion: integer("outcome_version"),
    // The Creative Director's one line on it: what was done, or what is still wrong (8 October 2026).
    outcomeReason: text("outcome_reason"),
    /* How many times it has been sent; a "Not done" comment gets one more try, asked for by a person. */
    tries: integer("tries").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("concept_comment_concept_idx").on(table.conceptId),
    index("concept_comment_project_idx").on(table.projectId),
  ],
);

export const changeRequestStatuses = ["queued", "working", "done", "failed"] as const;
export type ChangeRequestStatus = (typeof changeRequestStatuses)[number];

/*
  One Request changes: from the team's notes and pins, or from what the
  client said when their decision was recorded. The worker makes the next
  version from it, reruns the checks and has the Creative Director score it.
*/
export const conceptChangeRequest = pgTable(
  "concept_change_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    // "team" (Request changes) or "client" (a recorded client decision).
    source: text("source").notNull(),
    notes: text("notes").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id),
    baseVersion: integer("base_version").notNull(),
    // The first version it made; later fix rounds may add more.
    resultVersion: integer("result_version"),
    status: text("status").notNull().default("queued"),
    detail: text("detail"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("concept_change_request_concept_idx").on(table.conceptId)],
);

/*
  What the client decided, recorded by the team after the call or email.
  Approved as is moves the project to Content; changes requested starts a
  change request on the chosen concept.
*/
/*
  Approved sections (Jason, 8 October 2026: "get it right on the first
  go"). When a client picks a concept, its sections are copied here by
  code, with the client's own name, phone, email, address and photos taken
  out, and later builds start from them: structure and finish only, never
  words or facts. Goes with its project.
*/
export const sectionExample = pgTable(
  "section_example",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // The band's place on its page, so one band is copied once.
    bandIndex: integer("band_index").notNull(),
    direction: text("direction").notNull(),
    trade: text("trade").notNull(),
    // hero, services, why, process, proof, area, contact (pictures.ts BandKind).
    kind: text("kind").notNull(),
    html: text("html").notNull(),
    // The page's style rules this band uses.
    css: text("css").notNull(),
    // The concept's newest Creative Director average when it was copied.
    score: integer("score_tenths"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("section_example_direction_idx").on(table.direction),
    uniqueIndex("section_example_band_idx").on(table.conceptId, table.version, table.bandIndex),
  ],
);

export const clientDecision = pgTable(
  "client_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // phone, email or meeting
    channel: text("channel").notNull(),
    changesRequested: boolean("changes_requested").notNull(),
    clientSaid: text("client_said").notNull(),
    // "Logo approved by the client" (Jason, 26 September 2026). Null on decisions from before the tick.
    logoApproved: boolean("logo_approved"),
    changeRequestId: uuid("change_request_id"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("client_decision_project_idx").on(table.projectId)],
);

/*
  A project's Slack channel (3d): an incoming webhook, encrypted at rest.

  The URL is never shown again after saving; only its last four characters
  are kept in the clear so the team can tell which webhook is connected.
  The last failure is kept here so the project can show a warning until the
  next post gets through.
*/
export const projectSlack = pgTable("project_slack", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  webhookEncrypted: text("webhook_encrypted").notNull(),
  webhookHint: text("webhook_hint").notNull(),
  postComments: boolean("post_comments").notNull().default(false),
  connectedByUserId: text("connected_by_user_id").references(() => user.id),
  connectedAt: timestamp("connected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastPostAt: timestamp("last_post_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
});

/*
  Lane 2, Option B: the designer's Figma file for a project (Figma part 1).

  One per project. Reading the file is free but Figma limits how often a
  key may read, so the file is read once per check and kept in R2
  (fileJsonKey); the readiness check and the import both work from that
  copy. The import renders the final frames and downloads the design's
  images into R2, under the project's folder, so nothing is read twice and
  deleting the project removes them.
*/
export const figmaDesign = pgTable("figma_design", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  fileKey: text("file_key").notNull(),
  // "figma" (a Figma link) or "upload" (a PDF or images read into the same shape, 28 September 2026).
  source: text("source").notNull().default("figma"),
  linkedByUserId: text("linked_by_user_id").references(() => user.id),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),

  /* The last check: "ok", "warnings" or "failed" (the file could not be read). */
  checkStatus: text("check_status"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  /* Why the file could not be read (FigmaError kind and its message). */
  failureKind: text("failure_kind"),
  failureMessage: text("failure_message"),
  /* Figma's own name, date and version for the file, and what the check found (Readiness). */
  fileName: text("file_name"),
  figmaVersion: text("figma_version"),
  readiness: jsonb("readiness"),
  /* The whole file as Figma sent it, in R2. */
  fileJsonKey: text("file_json_key"),
  /* The page the PM chose when no page is named as final. */
  chosenPageId: text("chosen_page_id"),

  /* The import: "queued", "working", "done" or "failed". */
  importStatus: text("import_status"),
  importFailure: text("import_failure"),
  // While an uploaded design is read: { page, pages, part, parts, done, total } (27 September 2026).
  importProgress: jsonb("import_progress"),
  /*
    The pages read from the picture so far, kept when a later page fails
    so the next read only reads what's missing: { files, pages } where
    files names the uploaded files they came from (27 September 2026).
  */
  pagesRead: jsonb("pages_read"),
  importQueuedAt: timestamp("import_queued_at", { withTimezone: true }),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  importedByUserId: text("imported_by_user_id").references(() => user.id),
  /* The Figma version that was imported, so a newer check shows it is out of date. */
  importedVersion: text("imported_version"),
  /* Each final frame's rendered image in R2: { id, name, width, height, isHome, imageKey, scale }. */
  frames: jsonb("frames"),
  /* The design's images in R2, by Figma image reference; null where Figma had none. */
  imageFiles: jsonb("image_files"),
  /* The logo and icons (drawn shapes), rendered in the same request as the frames: ImportedAsset[]. */
  designAssets: jsonb("design_assets"),
  /* Warnings found only when importing (a frame Figma could not render, a missing image). */
  importWarnings: jsonb("import_warnings"),
  // Where links go whose words don't say (29 September 2026): { "read more": "/husky-talk/" | "remove" }.
  linkRules: jsonb("link_rules"),
  /* The last "Pre-fill the intake from the design": what was filled, left alone and not found. */
  prefillResult: jsonb("prefill_result"),
  /*
    Option B's first step skipped (29 September 2026): the site built without
    the Creative Director's review. Who and when; logged too.
  */
  reviewSkippedAt: timestamp("review_skipped_at", { withTimezone: true }),
  reviewSkippedByUserId: text("review_skipped_by_user_id").references(() => user.id),
});

/*
  Every read of the Figma API, so the team can see how close the key is to
  Figma's limit (about 20 reads a month on a View or Collab seat). Like the
  AI ledger, it outlives a deleted project: it holds no content.
*/
export const figmaRead = pgTable(
  "figma_read",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    // "file", "images" (rendering frames) or "image_fills".
    endpoint: text("endpoint").notNull(),
    ok: boolean("ok").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("figma_read_created_idx").on(table.createdAt)],
);

/*
  Lane 2, Option B, stop 4b: the Creative Director's review of the
  designer's homepage frame. Every review is kept; the newest is shown. Its
  AI call is in the ledger under step "design_review", with this row's id
  as its run id.
*/
export const designReview = pgTable(
  "design_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    // The Figma version and frame reviewed, so a newer import shows the review is of an older design.
    figmaVersion: text("figma_version").notNull(),
    frameId: text("frame_id").notNull(),
    frameName: text("frame_name").notNull(),
    // Scores for the eight questions, the summary, safety advice and how the answer was read.
    review: jsonb("review"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    // What the team was told it would cost, in tokens.
    estimatedInputTokens: bigint("estimated_input_tokens", { mode: "number" }),
    estimatedOutputTokens: bigint("estimated_output_tokens", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the worker started it (13 October 2026): the stuck-work check never fails a job started within the hour. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("design_review_project_idx").on(table.projectId)],
);

/*
  One finding of a design review, pinned to the layer it is about. Must-fix
  and Should-fix findings can be ticked by a PM to be applied in the
  improved version (4c); Must-fix start ticked. Recommendations are
  suggestions only and are never applied.
*/
export const designFinding = pgTable(
  "design_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => designReview.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // 1, 2, 3 ... in the order shown: Must-fix first, then Should-fix, then Recommendations.
    number: integer("number").notNull(),
    // "must_fix", "should_fix" or "recommendation".
    grade: text("grade").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    problem: text("problem").notNull(),
    change: text("change").notNull(),
    why: text("why").notNull(),
    // The Figma layer it is about; null for a finding about the whole page.
    layerId: text("layer_id"),
    layerName: text("layer_name"),
    // Where the pin sits, in percent across and down the frame.
    pinX: real("pin_x"),
    pinY: real("pin_y"),
    ticked: boolean("ticked").notNull().default(false),
    tickedByUserId: text("ticked_by_user_id").references(() => user.id),
    tickedAt: timestamp("ticked_at", { withTimezone: true }),
  },
  (table) => [index("design_finding_review_idx").on(table.reviewId)],
);

/*
  Intake fields filled from the designer's Figma design (Lane 2), marked
  "from the design" until the PM confirms them or saves a different value.
  Only ever written into fields that were empty. Goes with the project.
*/
export const intakePrefill = pgTable(
  "intake_prefill",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "business.phone", "services.items" and so on.
    fieldKey: text("field_key").notNull(),
    // The value that was filled in, to tell a correction from a confirmation.
    value: jsonb("value").notNull(),
    // The design's text it was read from, or (origin "site") the current site's address it came from.
    source: text("source").notNull(),
    // "design" (Lane 2's design) or "site" (the current website's read, 0.96.0).
    origin: text("origin").notNull().default("design"),
    // "pending", "confirmed" or "corrected".
    status: text("status").notNull().default("pending"),
    filledByUserId: text("filled_by_user_id").references(() => user.id),
    filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.fieldKey] })],
);

/*
  A person's correction to the new design read (E4b-2, Lane 2, 14 November
  2026): a band renamed, given another role or new edges. Admins only while
  the new route is built (Jason, 14 November). Rows are only ever added and
  all of them apply, oldest first, a later one winning for the fields it
  sets, so every correction stays on record (who, what, which read, when).

  Corrections belong to one upload (`version`): a new upload is a new design,
  so they don't carry over. They are kept across re-reads of that upload
  (Jason, 14 November): each is applied to the band of the new read in the
  same place (figma/read-corrections.ts; edges only when it was read in
  nearly the same place), and one that no band matches is listed, never
  dropped silently.
*/
export const designReadCorrection = pgTable(
  "design_read_correction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The upload read it corrects (figma_design.file_key).
    version: text("version").notNull(),
    page: integer("page").notNull().default(1),
    // "band" (more kinds come with words and pictures).
    target: text("target").notNull(),
    // Where it was made, in the design's pixels: for a band its top and bottom on the read it was made on.
    anchor: jsonb("anchor").notNull(),
    // What changed: for a band any of name, role, top, bottom.
    change: jsonb("change").notNull(),
    // The read (runId) it was made on.
    madeOnRun: text("made_on_run").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("design_read_correction_project_version_idx").on(table.projectId, table.version)],
);

/*
  Lane 2, Option B: the faithful copy, the designer's homepage frame
  rebuilt as a static HTML page with nothing changed, and how closely it
  matches the Figma frame. Every attempt is kept; the newest is shown. Its
  AI call is in the ledger under step "faithful_copy", with this row's id
  as its run id.
*/
export const designCopy = pgTable(
  "design_copy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull().default("queued"),
    // While it runs (28 September 2026): { stage: "building" | "checking" | "rebuilding", done, total }.
    progress: jsonb("progress"),
    failureReason: text("failure_reason"),
    figmaVersion: text("figma_version").notNull(),
    frameId: text("frame_id").notNull(),
    frameName: text("frame_name").notNull(),
    // The page with its image tokens, the page with the images in, and its full-page render.
    sourceKey: text("source_key"),
    htmlKey: text("html_key"),
    pngKey: text("png_key"),
    // How closely the render matches the Figma frame: overall and per section.
    fidelity: jsonb("fidelity"),
    // The usual checks, for information only: nothing in the copy is changed.
    checks: jsonb("checks"),
    // Anything the builder had to substitute (a font without a web license).
    notes: jsonb("notes"),
    /*
      The phone version (28 September 2026, Option A): CSS added to this copy
      for screens under 768px, from the page's mobile frame when there is
      one, or a responsive version for the designer to accept or push back.
      Status: null, "queued", "working", "done" or "failed".
    */
    mobileStatus: text("mobile_status"),
    // "mobile frame" or "responsive".
    mobileFrom: text("mobile_from"),
    mobileFrameId: text("mobile_frame_id"),
    mobilePngKey: text("mobile_png_key"),
    mobileOverflow: boolean("mobile_overflow"),
    mobileFailure: text("mobile_failure"),
    // The designer's decision on a responsive version: "accepted" or "pushed_back".
    mobileDecision: text("mobile_decision"),
    mobileDecidedByUserId: text("mobile_decided_by_user_id").references(() => user.id),
    mobileDecidedAt: timestamp("mobile_decided_at", { withTimezone: true }),
    mobileDecisionNote: text("mobile_decision_note"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    // Accepted as it is by the PM, the designer or an admin, with their note (28 September 2026).
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedNote: text("accepted_note"),
    // Replay (28 September 2026): built from this earlier copy's saved AI answers, for $0.
    replayOf: uuid("replay_of"),
    // The kit repair (29 September 2026): this copy made right with the style kit by code, $0.
    repairOf: uuid("repair_of"),
    // Filled by code from the copy of a page that shares its layout (29 September 2026), $0.
    filledFrom: uuid("filled_from"),
    // The words and links tidy (29 September 2026): what it changed and the links it couldn't place.
    tidy: jsonb("tidy"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the worker started it (13 October 2026): the stuck-work check never fails a job started within the hour. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("design_copy_project_idx").on(table.projectId)],
);

/*
  The style kit (Jason, 28 September 2026): the design's colours, fonts,
  panels, boxes, buttons, ribbons and icons, found by code from its pages
  (no AI), for the copies to use. One row per build; the newest done one
  for the current design is used. The kit (and each page's inventory) is
  JSON; the chosen fonts' files, the kit sheet and the page put together
  from the kit alone are in R2 under the project.
*/
export const styleKit = pgTable(
  "style_kit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The design import it was built from.
    designVersion: text("design_version").notNull(),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    kit: jsonb("kit"),
    // Each page's inventory (large), the kit sheet, the home page from the kit alone.
    inventoriesKey: text("inventories_key"),
    sheetKey: text("sheet_key"),
    previewKey: text("preview_key"),
    // The home page from the kit alone: its match with the design and its element check.
    previewFidelity: integer("preview_fidelity"),
    previewCheck: jsonb("preview_check"),
    // Fonts the designer chose over the matched ones, by role ({ "script": "Kaushan Script" }).
    fontOverrides: jsonb("font_overrides"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("style_kit_project_idx").on(table.projectId)],
);

/*
  Lane 2, Option B, 4c: the improved design. The ticked fixes from the
  Creative Director's review applied to the faithful copy, one section at a
  time, each change tracked (design_change); then one re-score. Every
  attempt is kept; the newest is shown. Its AI calls are in the ledger under
  "design_improve" and "design_rescore", with this row's id as their run id.
*/
export const designImprovement = pgTable(
  "design_improvement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The copy the fixes were applied to, and the review they came from.
    copyId: uuid("copy_id")
      .notNull()
      .references(() => designCopy.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => designReview.id, { onDelete: "cascade" }),
    // "fixes": the ticked fixes made on the copy. "decisions": that version with the designer's
    // pushed-back changes taken out (parentId is the fixes version it came from).
    kind: text("kind").notNull().default("fixes"),
    parentId: uuid("parent_id"),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull().default("queued"),
    // One short line while it runs: "Fixing section 3 of 5".
    detail: text("detail"),
    failureReason: text("failure_reason"),
    // The page with its image tokens, the page with the images in, and its full-page render.
    sourceKey: text("source_key"),
    htmlKey: text("html_key"),
    pngKey: text("png_key"),
    // The Creative Director's scores of the improved page, the same eight questions as the review.
    rescore: jsonb("rescore"),
    // The usual checks on the improved page, and ticked fixes that were not applied, with why.
    checks: jsonb("checks"),
    notApplied: jsonb("not_applied"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    estimatedInputTokens: bigint("estimated_input_tokens", { mode: "number" }),
    estimatedOutputTokens: bigint("estimated_output_tokens", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the worker started it (13 October 2026): the stuck-work check never fails a job started within the hour. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("design_improvement_project_idx").on(table.projectId)],
);

/*
  One tracked change in an improved design: which section, what changed and
  why in plain words, the review findings it answers, and the section's
  before and after (pictures, and the markup so it can be put back).
*/
export const designChange = pgTable(
  "design_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    improvementId: uuid("improvement_id")
      .notNull()
      .references(() => designImprovement.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // 1, 2, 3 ... in page order.
    number: integer("number").notNull(),
    // "fix" (from the review), "contrast" (a darker shade, by code) or "font" (a font swap).
    kind: text("kind").notNull(),
    sectionNumber: integer("section_number").notNull(),
    sectionName: text("section_name").notNull(),
    what: text("what").notNull(),
    why: text("why").notNull(),
    // The review findings' numbers this change answers.
    findingNumbers: jsonb("finding_numbers").notNull().default([]),
    beforeImageKey: text("before_image_key"),
    afterImageKey: text("after_image_key"),
    beforeHtmlKey: text("before_html_key"),
    afterHtmlKey: text("after_html_key"),
    // The designer's answer, from the Web Designer or an admin: "accepted" or "pushed_back", with an optional note.
    decision: text("decision"),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("design_change_improvement_idx").on(table.improvementId)],
);

/*
  A brand guide PDF, read once when it was uploaded (26 September 2026):
  the colours, fonts and logo rules found in its text, offered in the
  intake as "From the brand guide" suggestions the PM uses or dismisses.
  Nothing is written into the intake until the PM says so. No AI.
*/
export const brandGuideReading = pgTable(
  "brand_guide_reading",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => intakeFile.id, { onDelete: "cascade" }),
    // "done", "no_text" (a scan: nothing to read without AI) or "failed".
    status: text("status").notNull(),
    pages: integer("pages"),
    colors: jsonb("colors").notNull().default([]),
    fonts: jsonb("fonts").notNull().default([]),
    logoRules: jsonb("logo_rules").notNull().default([]),
    // What the PM did with each suggestion: { "color:#1F4E79": "used", "rule:2": "dismissed" }.
    handled: jsonb("handled").notNull().default({}),
    failureReason: text("failure_reason"),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("brand_guide_reading_project_idx").on(table.projectId)],
);

/*
  "Websites they like" (intake, Website section), photographed once by the
  worker (first screen at 1440 wide, no AI) so the team sees them and the
  mockup builder gets them as visual inspiration, never to copy.
*/
/*
  The client's current website, read by the worker's browser (Jason,
  30 September 2026; no AI): the home page's menu, sections, phone numbers
  and testimonials, the words the mockups and the content start from. One
  row per project, replaced when the address changes or it's read again.
*/
export const currentSiteRead = pgTable(
  "current_site_read",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // queued, working, done, failed.
    status: text("status").notNull().default("queued"),
    result: jsonb("result"),
    failureReason: text("failure_reason"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("current_site_read_project_idx").on(table.projectId)],
);

/*
  Keep the current site (Jason, 6 October 2026): the current site's pages,
  read by code (no AI) when the content choice is "Keep all content as is".
  One row per project, replaced when it's read again. Each page's kept
  words are in R2 (projects/<id>/site-import/<row id>/<n>.json); this row
  holds what the screens and the SEO suggestions need.
*/
export const siteImport = pgTable(
  "site_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // queued, working, done, failed.
    status: text("status").notNull().default("queued"),
    step: text("step"),
    // The tier's page limit when it was read.
    pageLimit: integer("page_limit").notNull(),
    // "sitemap", "menu" or "archive-list": where the page list came from.
    source: text("source"),
    // ImportedPageSummary[] (core site-import-seo.ts).
    pages: jsonb("pages").notNull().default([]),
    // { url, reason }[]: not pages (feeds, archives), or replaced (the policies).
    skipped: jsonb("skipped").notNull().default([]),
    // Addresses over the page limit, not read.
    notImported: jsonb("not_imported").$type<string[]>().notNull().default([]),
    failed: jsonb("failed").notNull().default([]),
    brokenLinks: jsonb("broken_links").notNull().default([]),
    menu: jsonb("menu").notNull().default([]),
    requests: integer("requests").notNull().default(0),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    // "Use these pages": when the page plan and the kept copy were made from it, and by whom.
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: text("used_by_user_id"),
    // The worker bumps heartbeat_at with each step: "cut off" is measured from it (0.94.0; the archive's retry_at and tries went in 0.96.0).
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /*
      One read of the current site (0.96.0, docs/plans/flow-a-one-read.md):
      the home page as a browser sees it (CurrentSiteResult plus its look:
      colours, fonts and a first-screen screenshot in R2), saved before the
      pages finish; or why the browser couldn't read it (not fatal).
    */
    home: jsonb("home"),
    homeFailure: text("home_failure"),
    homeReadAt: timestamp("home_read_at", { withTimezone: true }),
    // What the automatic page plan did with this read (KeptPlanNote, core site/site-read.ts).
    keptPlan: jsonb("kept_plan"),
    // Set while one caller makes or updates the plan (single-flight: the worker and a page render can't both make it).
    keptPlanClaimedAt: timestamp("kept_plan_claimed_at", { withTimezone: true }),
    /*
      A blocked site read through a paid route estimated over $1 (Jason's
      rule): the read waits (status "needs_consent") with the estimate and
      the route, until a person gives the go (consent_usd, who).
    */
    consentEstimateUsd: real("consent_estimate_usd"),
    consentRoute: text("consent_route"),
    consentUsd: real("consent_usd"),
    consentByUserId: text("consent_by_user_id"),
  },
  (table) => [uniqueIndex("site_import_project_idx").on(table.projectId)],
);

/*
  Blocked sites (Part D, 7 October 2026): every paid call a blocked route
  made while reading a client's current site (Jina Reader first, Zyte
  second), for Spend and the monthly caps. No foreign key: like
  seo_data_call it stays when the project is deleted (what was spent stays
  counted). Never holds the page or any key.
*/
export const siteReadCall = pgTable(
  "site_read_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    readId: uuid("read_id"),
    // "jina" or "zyte".
    route: text("route").notNull(),
    // "home", "screenshot" or "page".
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    // Jina's own token count (0 for Zyte).
    tokens: integer("tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    // True when the cost is TAWD's estimate (the answer didn't carry its own).
    estimated: boolean("estimated").notNull().default(false),
    ok: boolean("ok").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("site_read_call_created_idx").on(table.createdAt)],
);

/*
  Content first, part 2 (1 October 2026): the home page's words before the
  concepts, section by section, and its testimonials to confirm. Lane 1.
  Used (approved) by the team before Generate; the concepts carry them.
*/
export const homeWords = pgTable(
  "home_words",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // current_site, client_copy, tawd.
    source: text("source").notNull(),
    sections: jsonb("sections").$type<{ name: string; words: string }[]>().notNull().default([]),
    testimonials: jsonb("testimonials").$type<{ text: string; confirmed: boolean }[]>().notNull().default([]),
    // For the AI writing (New site): queued, working, done, failed.
    writeStatus: text("write_status"),
    writeFailure: text("write_failure"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("home_words_project_idx").on(table.projectId)],
);

export const likedSiteShot = pgTable(
  "liked_site_shot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // "queued", "done" or "failed".
    status: text("status").notNull().default("queued"),
    imageKey: text("image_key"),
    failureReason: text("failure_reason"),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    /*
      Reference study (27 September 2026): a taller desktop screenshot of the
      page, the outline read from it (no AI), and the reference brief (AI,
      when allowed): structure and craft only.
    */
    pageImageKey: text("page_image_key"),
    outline: jsonb("outline"),
    brief: jsonb("brief"),
    // null (not asked), "queued", "working", "done" or "failed".
    briefStatus: text("brief_status"),
    briefFailure: text("brief_failure"),
    studiedAt: timestamp("studied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("liked_site_shot_project_idx").on(table.projectId)],
);

/*
  Shutterstock previews in mockups: each search phrase a project's pages
  asked for, looked up once. "found" keeps the watermarked preview in R2
  (under the project, so deleting the project removes it); "none" means no
  picture matched, "failed" that the search did not work (tried again
  later). Nothing is licensed.
*/
export const stockPicture = pgTable(
  "stock_picture",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    status: text("status").notNull(),
    shutterstockId: text("shutterstock_id"),
    description: text("description"),
    imageKey: text("image_key"),
    failureReason: text("failure_reason"),
    // Why this picture may clash with the brand (another company's uniform colours, a competitor), or null.
    clash: text("clash"),
    /*
      F28 (9 November 2026): the other answers Shutterstock gave for this
      phrase, best first, as [{ id, description, previewUrl, clash }]. The
      search already returned up to five and TAWD kept one, so two concepts
      asking the same phrase were handed the same photograph - a code-level
      guarantee that the concepts looked alike. Keeping the rest lets each
      concept take a different one with no further search.
    */
    candidates: jsonb("candidates"),
    /*
      Which picture each concept took for this phrase, as { conceptId: shutterstockId }.
      A concept that has taken one keeps it, so a rebuild or a fix round does
      not change the page's photographs underneath the team.
    */
    takenBy: jsonb("taken_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("stock_picture_project_query_idx").on(table.projectId, table.query)],
);

/*
  SEO data (Phase 7a, 26 September 2026): DataForSEO keyword research.

  A research run looks up search volume and difficulty for the project's
  services in its service areas. keyword_metric is shared by every project
  and keyed by keyword, place and sandbox-or-live, so the same lookup is
  never paid for twice; seo_keyword is one run's result for one project.
  seo_data_call is the ledger for Spend, kept like ai_call when a project is
  deleted (its saved answer is removed).
*/
export const keywordResearch = pgTable(
  "keyword_research",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "working", "done" or "failed".
    status: text("status").notNull().default("working"),
    // True for DataForSEO's free sandbox, whose numbers are test data.
    sandbox: boolean("sandbox").notNull(),
    keywordCount: integer("keyword_count").notNull().default(0),
    places: jsonb("places").notNull().default([]),
    estimateUsd: real("estimate_usd").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    // How many keywords came from the cache rather than a paid lookup.
    cachedCount: integer("cached_count").notNull().default(0),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("keyword_research_project_idx").on(table.projectId)],
);

export const seoKeyword = pgTable(
  "seo_keyword",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    researchId: uuid("research_id")
      .notNull()
      .references(() => keywordResearch.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    // The intake service it came from, or null for the trade itself.
    service: text("service"),
    // The city, state or "United States" it is for.
    area: text("area").notNull(),
    place: text("place").notNull(),
    searchVolume: integer("search_volume"),
    cpc: real("cpc"),
    competition: text("competition"),
    difficulty: integer("difficulty"),
  },
  (table) => [index("seo_keyword_research_idx").on(table.researchId)],
);

export const keywordMetric = pgTable(
  "keyword_metric",
  {
    keyword: text("keyword").notNull(),
    place: text("place").notNull(),
    sandbox: boolean("sandbox").notNull(),
    searchVolume: integer("search_volume"),
    cpc: real("cpc"),
    competition: text("competition"),
    // Null until the difficulty lookup has answered for this keyword.
    difficulty: integer("difficulty"),
    volumeFetchedAt: timestamp("volume_fetched_at", { withTimezone: true }),
    difficultyFetchedAt: timestamp("difficulty_fetched_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.keyword, table.place, table.sandbox] })],
);

export const seoDataCall = pgTable(
  "seo_data_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    researchId: uuid("research_id"),
    // "search_volume" or "keyword_difficulty".
    endpoint: text("endpoint").notNull(),
    sandbox: boolean("sandbox").notNull(),
    keywordCount: integer("keyword_count").notNull().default(0),
    // What DataForSEO charged (its own "cost" field); 0 in the sandbox.
    costUsd: real("cost_usd").notNull().default(0),
    ok: boolean("ok").notNull(),
    message: text("message"),
    startedByUserId: text("started_by_user_id"),
    // The raw answer in R2, saved before it is read; cleared when the project is deleted.
    responseKey: text("response_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("seo_data_call_created_idx").on(table.createdAt)],
);

/*
  The page plan (Phase 7a): the site's pages in menu order, each with its
  keywords, title, meta description and H1. Made from the tier and the
  keyword research, then edited by the team.
*/
export const pagePlanPage = pgTable(
  "page_plan_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    // home, about, contact, service, service_areas, city, faq, reviews or other.
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    mainKeyword: text("main_keyword").notNull().default(""),
    supportingKeywords: jsonb("supporting_keywords").$type<string[]>().notNull().default([]),
    title: text("title").notNull().default(""),
    metaDescription: text("meta_description").notNull().default(""),
    h1: text("h1").notNull().default(""),
    // The hub this detailed page belongs to, by its slug (the hub rule, 28 September 2026); null when none.
    parentSlug: text("parent_slug"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("page_plan_page_project_idx").on(table.projectId)],
);

/*
  Page drafts (Phase 7b): each page's copy as Markdown, one row per
  version. AI drafts and redrafts are "draft"/"redraft" (queued, working,
  done or failed); an editor's change in place is "edit" (done at once).
  Approval is of one version: a newer version needs approving again. The
  AI-writing score (Originality.ai) is information for the team only.
*/
export const pageDraft = pgTable(
  "page_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pagePlanPage.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // "draft", "redraft" or "edit".
    source: text("source").notNull(),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull(),
    body: text("body"),
    // Request a redraft: what the team asked for.
    note: text("note"),
    failureReason: text("failure_reason"),
    createdByUserId: text("created_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    aiScore: real("ai_score"),
    aiScoreCheckedAt: timestamp("ai_score_checked_at", { withTimezone: true }),
    aiScoreError: text("ai_score_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("page_draft_page_idx").on(table.pageId)],
);

export const pageComment = pgTable(
  "page_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pagePlanPage.id, { onDelete: "cascade" }),
    // The version the comment was left on.
    version: integer("version").notNull(),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("page_comment_page_idx").on(table.pageId)],
);

/* The client's decision on the copy pack (the approved pages), recorded by the PM like the mockup decision. */
export const contentDecision = pgTable(
  "content_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "approved" or "changes_requested".
    outcome: text("outcome").notNull(),
    // "phone call", "email" or "meeting".
    channel: text("channel").notNull(),
    clientSaid: text("client_said").notNull(),
    // Each page and the version the client saw: [{ pageId, name, version }].
    pages: jsonb("pages").notNull(),
    recordedByUserId: text("recorded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("content_decision_project_idx").on(table.projectId)],
);

/*
  Build A (8a): one build of the static site. Its files are in R2 under
  projects/<id>/site/v<version>/, exactly as Netlify will serve them.
  "pages" lists each page with its path, its first-screen picture and the
  placeholders left on it.
*/
export const siteBuild = pgTable(
  "site_build",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull(),
    // What it is doing now: "Building page 3 of 9: Water heaters".
    step: text("step"),
    // The approved concept and version it was built from.
    conceptId: uuid("concept_id"),
    conceptVersion: integer("concept_version"),
    pages: jsonb("pages").notNull().default([]),
    fileCount: integer("file_count").notNull().default(0),
    // 8b: the go-live checklist, run on the built files.
    checks: jsonb("checks"),
    // 8b: "preview" (robots and headers say noindex) until Phase 9 goes live.
    mode: text("mode").notNull().default("preview"),
    // 8c: a rebuild with one edit request's changes, from the saved sources (no AI).
    editRequestId: uuid("edit_request_id"),
    /*
      Lane 2's site from the design (29 September 2026): { kind: "design",
      only?: page slugs to build now (the rest kept from the last build),
      rework?: { slug, feedback } }. Null for a Lane 1 build.
    */
    options: jsonb("options"),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /*
      Stamped every minute while the worker works on the build (audit F-006,
      12 November 2026). A "working" build with no stamp for ten minutes was
      left by a worker that stopped; the worker's sweep marks it failed so a
      new build can start (sweepStalledSiteBuilds, stuck-work.ts).
    */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  },
  (table) => [index("site_build_project_idx").on(table.projectId)],
);

/*
  Build A, 8b: each client's site on VML's Netlify team account (one per
  project), its deploys (Netlify keeps every one, so any can be restored),
  and the client's decision on a preview link, recorded like the mockup
  decision. The Netlify token lives only in Coolify.
*/
/*
  F2, form messages through TAWD (1 October 2026). Each project's key for
  the site's forms to sign what they send (Netlify's webhook signature and
  the WordPress hook's HMAC), encrypted with TAWD_ENCRYPTION_KEY.
*/
export const formChannel = pgTable("form_channel", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  secretEncrypted: text("secret_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  Every message from a client site's forms, kept 90 days (the client's
  customers' details), and what happened to its email: queued, sent,
  delivered, bounced, spam (a complaint), failed. fields is
  [{ label, value }]; files is [{ name, url }].
*/
export const formMessage = pgTable(
  "form_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // netlify, wordpress or test.
    source: text("source").notNull(),
    formName: text("form_name").notNull(),
    visitorName: text("visitor_name"),
    visitorEmail: text("visitor_email"),
    fields: jsonb("fields").notNull().default([]),
    files: jsonb("files").notNull().default([]),
    recipients: jsonb("recipients").notNull().default([]),
    status: text("status").notNull(),
    postmarkId: text("postmark_id"),
    detail: text("detail"),
    // The sender's own id for the submission, so a retried webhook isn't sent twice.
    externalId: text("external_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("form_message_project_idx").on(t.projectId, t.createdAt), uniqueIndex("form_message_external_idx").on(t.projectId, t.externalId)],
);

/* The test message to each recipient, and the client's "I got it" (only the link's hash is kept). */
export const formTest = pgTable("form_test", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  recipient: text("recipient").notNull(),
  tokenHash: text("token_hash").notNull(),
  postmarkId: text("postmark_id"),
  // sent, delivered, bounced, failed.
  status: text("status").notNull(),
  detail: text("detail"),
  sentByUserId: text("sent_by_user_id").references(() => user.id),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

/*
  F4 (1 October 2026): the monthly delivery test to VML's test inboxes at
  the common providers. One row per inbox per run; whoever checks the inbox
  says where it landed (inbox or spam). status: sent, failed, bounced,
  inbox, spam.
*/
export const deliveryTest = pgTable(
  "delivery_test",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    address: text("address").notNull(),
    provider: text("provider").notNull(),
    tokenHash: text("token_hash").notNull(),
    postmarkId: text("postmark_id"),
    status: text("status").notNull(),
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [index("delivery_test_sent_idx").on(t.sentAt)],
);

/*
  F4: the weekly check of each live site's form: TAWD fills it in, marked
  as a test, and waits for the message to reach TAWD (the client isn't
  emailed). status: sent, received, missing, failed.
*/
export const formHeartbeat = pgTable(
  "form_heartbeat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    status: text("status").notNull(),
    detail: text("detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
  },
  (t) => [index("form_heartbeat_project_idx").on(t.projectId, t.sentAt)],
);

/*
  The Speed check (1 October 2026): Google PageSpeed on a project's
  preview (Netlify or WordPress), on a phone and a computer, before
  anything goes live. Free, no AI. status: queued, done, failed.
*/
export const speedCheck = pgTable(
  "speed_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** "netlify" or "wordpress": which preview. */
    target: text("target").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull(),
    /** { mobile, desktop }: each the four scores, the timings and the main things to fix (readPageSpeed). */
    results: jsonb("results"),
    error: text("error"),
    /*
      The build version the preview was serving when the check started
      (3 October 2026): the go-live gate counts a check only for the build
      going live. Null on checks from before.
    */
    buildVersion: integer("build_version"),
    requestedByUserId: text("requested_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("speed_check_project_idx").on(t.projectId, t.createdAt)],
);

export const netlifySite = pgTable("netlify_site", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  siteId: text("site_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  adminUrl: text("admin_url"),
  // Who Netlify emails a form submission to: the client first, then VML.
  formEmails: jsonb("form_emails").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  Build B, B2 (1 October 2026): a project's WordPress preview; on 20i since
  5 October 2026 (docs/plans/build-b-20i.md): one 20i hosting package per
  site. One row a project: its preview address and web root, its database
  (the password encrypted with TAWD_ENCRYPTION_KEY), the WordPress login
  TAWD made (encrypted, shown only to admins, logged), and the last
  deploy's steps: [{ key, label, state: waiting|working|done|failed|warn, detail }].
  state: deploying, ready, failed, removing, removed.

  host is the address the team opens, the speed gate measures and go-live
  moves from: <name>.<WP_PREVIEW_DOMAIN> (decision D1, option B), or 20i's
  staging address without one. host, dir and the database names are null
  until the steps that make them answer (20i says what they are).
*/
export const wpPreview = pgTable("wp_preview", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  host: text("host"),
  // The package's web root, from its home folder ("public_html").
  dir: text("dir"),
  dbName: text("db_name"),
  dbUser: text("db_user"),
  dbPasswordEncrypted: text("db_password_encrypted").notNull(),
  adminUser: text("admin_user").notNull(),
  adminPasswordEncrypted: text("admin_password_encrypted").notNull(),
  state: text("state").notNull(),
  // The build version being deployed, then the one on the preview.
  version: integer("version"),
  deployedVersion: integer("deployed_version"),
  https: boolean("https").notNull().default(false),
  steps: jsonb("steps").notNull().default([]),
  // Who the forms send to, fixed when the deploy starts: { to: string[], copy: string | null }.
  formEmails: jsonb("form_emails").notNull().default({}),
  /*
    B3 (1 October 2026): the live site. The client's domain once it's on
    the package (the same WordPress, not a copy); the go-live and rollback
    steps (as steps above); the backups taken before go-live and before each
    later deploy to the live site: [{ at, kind, version, stamp, sqlKey,
    filesKey, bytes }] (R2 keys, newest first); the Contact Form 7 form
    TAWD's weekly check fills in.
  */
  liveDomain: text("live_domain"),
  // When the client's domain was added on the host (database names kept from Bluehost).
  domainOnHostAt: timestamp("bluehost_domain_at", { withTimezone: true }),
  domainOnHostNote: text("bluehost_domain_note"),
  liveAt: timestamp("live_at", { withTimezone: true }),
  liveSteps: jsonb("live_steps").notNull().default([]),
  liveState: text("live_state"),
  backups: jsonb("backups").notNull().default([]),
  liveFormId: integer("live_form_id"),
  /* ---------- 20i (5 October 2026) ---------- */
  packageId: text("package_id"),
  // The package's main domain (also its SSH user): <name>.<preview domain>, never the client's domain.
  packageDomain: text("package_domain"),
  // 20i's own address for the package (reduced-capacity servers): a fallback link only.
  stagingHost: text("staging_host"),
  // The IPv4 visitors reach the package on, as 20i last said.
  packageIpv4: text("package_ipv4"),
  sshHost: text("ssh_host"),
  sshUser: text("ssh_user"),
  dbHost: text("db_host"),
  // The certificates: { preview?, live? }, each a WpCert (core wp-preview.ts).
  certs: jsonb("certs").notNull().default({}),
  // The daily IP watch: when it last looked, and what it found ({ apiIp, apex, www, ok, alertedAt, fixedAt }).
  ipCheckedAt: timestamp("ip_checked_at", { withTimezone: true }),
  ipNote: jsonb("ip_note"),
  // Suspended at 20i (an admin's Suspend); null when running.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  // The admin who confirmed this would go past VML's 20i plan (a dearer plan).
  limitConfirmedBy: text("limit_confirmed_by"),
  failureReason: text("failure_reason"),
  startedByUserId: text("started_by_user_id").references(() => user.id),
  startedAt: timestamp("started_at", { withTimezone: true }),
  deployedAt: timestamp("deployed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const siteDeploy = pgTable(
  "site_deploy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    buildId: uuid("build_id")
      .notNull()
      .references(() => siteBuild.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    netlifyDeployId: text("netlify_deploy_id"),
    url: text("url"),
    // Phase 9: "preview" (noindex; a draft once the site is live), "live" (the published site) or "rollback" (a restore of an earlier live deploy).
    kind: text("kind").notNull().default("preview"),
    // "uploading", "ready" or "failed".
    state: text("state").notNull(),
    error: text("error"),
    /*
      Opened as a signed-out visitor right after it's ready (29 September
      2026): set when Netlify refused (its "private project" setting), with
      what to change. Null when anyone with the link can open it.
    */
    accessWarning: text("access_warning"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (table) => [index("site_deploy_project_idx").on(table.projectId)],
);

export const previewDecision = pgTable(
  "preview_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The Netlify preview the client saw; null for a WordPress preview (8 October 2026).
    deployId: uuid("deploy_id").references(() => siteDeploy.id, { onDelete: "cascade" }),
    // The WordPress preview's build version the client saw, when the project is on WordPress.
    wpVersion: integer("wp_version"),
    // "approved" or "changes_requested".
    outcome: text("outcome").notNull(),
    channel: text("channel").notNull(),
    clientSaid: text("client_said").notNull(),
    recordedByUserId: text("recorded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("preview_decision_project_idx").on(table.projectId)],
);

/*
  Build A, 8c: the monthly edits. The plan includes 8 dev hours a month;
  every request is logged (what the client asked, when, the time spent and
  the AI it cost) against them. A request is an edit, or a quote (new
  pages and redesigns are priced separately). Each page an edit touches
  keeps its before and after in R2.
*/
export const editRequest = pgTable(
  "edit_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "edit" or "quote".
    kind: text("kind").notNull(),
    clientWords: text("client_words").notNull(),
    teamNote: text("team_note").notNull().default(""),
    requestedOn: date("requested_on").notNull(),
    pageIds: jsonb("page_ids").$type<string[]>().notNull().default([]),
    // open, queued, editing, edited, failed, rebuilt, done, quoted.
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    // Updates (1 October 2026): the category, the PM's estimate, the built site's pages (every lane) and a quote.
    category: text("category"),
    estimateMinutes: integer("estimate_minutes"),
    pagePaths: jsonb("page_paths").$type<string[]>().notNull().default([]),
    redesign: boolean("redesign").notNull().default(false),
    // The build the edit was made on, and the build it went into.
    baseBuildId: uuid("base_build_id"),
    buildId: uuid("build_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [index("edit_request_project_idx").on(table.projectId)],
);

export const editPage = pgTable(
  "edit_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => editRequest.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    beforeKey: text("before_key").notNull(),
    afterKey: text("after_key").notNull(),
    changed: boolean("changed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("edit_page_request_idx").on(table.requestId)],
);

/*
  Updates (1 October 2026): a quote for a request that needs one (a new page,
  a redesign, or hours over the plan), priced from the Pricing page, and the
  client's answer. Work on the request waits for an approval.
*/
export const updateQuote = pgTable(
  "update_quote",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    requestId: uuid("request_id")
      .notNull()
      .references(() => editRequest.id, { onDelete: "cascade" }),
    // [{ key, label, quantity, unitCents (null: price not set), amountCents }]
    lines: jsonb("lines").$type<{ key: string; label: string; quantity: number; unitCents: number | null; amountCents: number | null }[]>().notNull(),
    totalCents: integer("total_cents"),
    // waiting, approved, declined.
    status: text("status").notNull().default("waiting"),
    decisionChannel: text("decision_channel"),
    clientSaid: text("client_said"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: text("decided_by_user_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("update_quote_project_idx").on(table.projectId)],
);

/* Updates (1 October 2026): the month's invoice, every line entered or confirmed by an admin. */
export const updateInvoice = pgTable(
  "update_invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "2026-10"
    month: text("month").notNull(),
    // [{ date, task, category, hours, amountCents }]
    lines: jsonb("lines").$type<{ date: string; task: string; category: string; hours: number; amountCents: number }[]>().notNull(),
    totalCents: integer("total_cents").notNull(),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("update_invoice_project_month_idx").on(table.projectId, table.month)],
);

export const devTime = pgTable(
  "dev_time",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").references(() => editRequest.id, { onDelete: "set null" }),
    minutes: integer("minutes").notNull(),
    note: text("note").notNull().default(""),
    workedOn: date("worked_on").notNull(),
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("dev_time_project_idx").on(table.projectId)],
);

/*
  Add-ons (Jason, 26 September 2026): one-off extras priced by admins on
  the Pricing page (logged). A project keeps each add-on at the price it
  had when it was added, and it counts with the build fee. "quoted" rows
  have no list price (the 100+ page SEO audit).
*/
export const addonPrice = pgTable("addon_price", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents"),
  quoted: boolean("quoted").notNull().default(false),
  // Charged every month the site is live, with the monthly fee (WordPress hosting, 27 September 2026).
  monthly: boolean("monthly").notNull().default(false),
  // Priced per page, the project's quantity being its page count (the client-supplied design, 27 September 2026).
  perPage: boolean("per_page").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectAddon = pgTable(
  "project_addon",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    addonKey: text("addon_key").notNull(),
    name: text("name").notNull(),
    // The price when it was added; null for a quote still to agree.
    priceCents: integer("price_cents"),
    monthly: boolean("monthly").notNull().default(false),
    // How many: the design's page count for a per-page add-on, else 1. The charge is priceCents times this.
    quantity: integer("quantity").notNull().default(1),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [index("project_addon_project_idx").on(table.projectId)],
);

/*
  TAWD's logo designs for a client with no logo: an original wordmark (the
  business name and a simple icon) in the brand colours, as SVG and PNG.
  One option on Starter, two on Growth, three on Pro. The chosen one
  becomes the intake's logo, so the mockups use it and the client approves
  it with them.
*/
export const logoDesign = pgTable(
  "logo_design",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "queued", "working", "done" or "failed".
    status: text("status").notNull(),
    optionCount: integer("option_count").notNull(),
    // [{ svgKey, pngKey, name }]
    options: jsonb("options").notNull().default([]),
    chosenIndex: integer("chosen_index"),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("logo_design_project_idx").on(table.projectId)],
);

/*
  SEO audits of the client's current website (Jason, 26 September 2026).
  "quick" is the free "Don't lose it" check every project with a website
  gets: its pages (from the sitemap), which of them rank, and a redirect
  map from each old address to its new page, which Build A turns into the
  site's redirects. "full" is the paid add-on: DataForSEO's crawl, Google
  PageSpeed, rankings and traffic, and the Senior SEO agent's report.
*/
export const seoAudit = pgTable(
  "seo_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // "quick" or "full".
    kind: text("kind").notNull(),
    // queued, crawling, working, done, failed.
    status: text("status").notNull(),
    step: text("step"),
    siteUrl: text("site_url").notNull(),
    sandbox: boolean("sandbox").notNull(),
    pageCount: integer("page_count").notNull().default(0),
    // [{ url, path }]
    pages: jsonb("pages").notNull().default([]),
    // [{ url, keywords, bestPosition, traffic, topKeyword }]
    rankings: jsonb("rankings").notNull().default([]),
    // [{ from, to, pageName, reason, keep }]
    redirects: jsonb("redirects").notNull().default([]),
    // Full audit only: DataForSEO On-Page's task and its summary, PageSpeed, the report.
    onPageTaskId: text("on_page_task_id"),
    crawl: jsonb("crawl"),
    pageSpeed: jsonb("page_speed"),
    report: jsonb("report"),
    // The Screaming Frog export the SEO team attached, if any (an intake file).
    extraEvidenceFileId: uuid("extra_evidence_file_id"),
    estimateUsd: real("estimate_usd").notNull().default(0),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("seo_audit_project_idx").on(table.projectId)],
);

/*
  The Senior SEO Manager's check of the built site before go-live: the
  findings (fixed automatically, or listed), and the SEO team's sign-off,
  which the go-live gate needs.
*/
export const seoGoLiveCheck = pgTable(
  "seo_golive_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    buildId: uuid("build_id").notNull(),
    version: integer("version").notNull(),
    // queued, working, done, failed.
    status: text("status").notNull(),
    // [{ key, page, problem, fix, safe, fixed }]
    findings: jsonb("findings").notNull().default([]),
    summary: text("summary"),
    // The edit request made for the safe fixes, if any.
    editRequestId: uuid("edit_request_id"),
    signedOffByUserId: text("signed_off_by_user_id"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    signOffNote: text("sign_off_note"),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("seo_golive_check_project_idx").on(table.projectId)],
);

/*
  The price list (Phase 5): each package's build fee and monthly fee, in
  whole cents, set by admins; blank until set. Starter, Growth and Pro are
  the tiers; admins can add more. Every change is logged. Projects copy
  their prices from here when they are created.
*/
export const packagePrice = pgTable("package_price", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  buildFeeCents: integer("build_fee_cents"),
  monthlyFeeCents: integer("monthly_fee_cents"),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  The client's DESIGN.md (26 September 2026): written from the approved
  mockup (Lane 2: the designer's approved Figma design) when the client
  approves it, versioned, and given to every page build and monthly edit.
*/
export const clientDesignDoc = pgTable(
  "client_design_doc",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // "concept" (a TAWD mockup) or "figma" (the designer's approved design, Lane 2).
    source: text("source").notNull(),
    conceptId: uuid("concept_id").references(() => concept.id, { onDelete: "set null" }),
    conceptVersion: integer("concept_version"),
    markdown: text("markdown").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("client_design_doc_project_idx").on(table.projectId)],
);

/*
  Health and beauty rules (26 September 2026): a flag on the built site the
  PM has confirmed with the client ("that wording is theirs and correct").
  A flag is resolved when it is fixed (gone from the newest build) or
  confirmed here; go-live waits for every one. Keyed by the rule and the
  words found, so a confirmation carries to later builds of the same words.
*/
export const healthFlagConfirmation = pgTable(
  "health_flag_confirmation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    flagId: text("flag_id").notNull(),
    rule: text("rule").notNull(),
    found: text("found").notNull(),
    note: text("note").notNull().default(""),
    buildVersion: integer("build_version").notNull(),
    confirmedByUserId: text("confirmed_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("health_flag_confirmation_flag_idx").on(table.projectId, table.flagId)],
);

/*
  Which version each service runs (26 September 2026): the worker writes
  its version when it starts and every few minutes, so a signed-in check of
  /api/health can confirm the web app and the worker are on the same one.
*/
export const serviceHeartbeat = pgTable("service_heartbeat", {
  service: text("service").primaryKey(),
  version: text("version").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  // Which environment variables the service has: names and yes/no only (settings-check.ts).
  env: jsonb("env").notNull().default({}),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  A project's tracking codes (Todd's request, 26 September 2026): IDs only,
  entered by the PM; the builder writes the code into every page, loading
  nothing before the visitor's consent (site/tracking.ts). consent_mode is
  "opt_in" (ask first) or "opt_out" (on unless the visitor opts out).
*/
export const projectTracking = pgTable("project_tracking", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  ga4: text("ga4").notNull().default(""),
  gtm: text("gtm").notNull().default(""),
  metaPixel: text("meta_pixel").notNull().default(""),
  googleAds: text("google_ads").notNull().default(""),
  // CallRail's "companyId/scriptKey" (Consent PR1, 8 November 2026); loaded only behind the same consent gate.
  callRail: text("call_rail").notNull().default(""),
  consentMode: text("consent_mode").notNull().default("opt_in"),
  updatedByUserId: text("updated_by_user_id").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  The logo after approval (27 September 2026). A swap puts the intake's
  current logo into the approved concept as a new version (no AI); a logo
  approval records the client saying yes to the logo later, the way the
  mockup decision is recorded, and updates the "Logo approved" mark.
*/
export const logoSwap = pgTable(
  "logo_swap",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version"),
    // queued, working, done, failed
    status: text("status").notNull().default("queued"),
    failureReason: text("failure_reason"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("logo_swap_project_idx").on(table.projectId)],
);

export const logoApproval = pgTable(
  "logo_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // phone, email or meeting
    channel: text("channel").notNull(),
    clientSaid: text("client_said").notNull(),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("logo_approval_project_idx").on(table.projectId)],
);

/*
  The photo text check (27 September 2026): the visible text in the
  client's photos (signs, doors, vans, uniforms), read by one AI call, then
  compared with the intake with no AI. In the Finley team photo the door
  says "530A" while the intake address is 1100 Melody Ln, Suite 2017.
*/
export const photoTextCheck = pgTable(
  "photo_text_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // queued, working, done, failed
    status: text("status").notNull().default("queued"),
    // [{ fileId, fileName, texts: string[] }]
    readings: jsonb("readings"),
    // [{ fileId, fileName, text, problem }]
    findings: jsonb("findings"),
    failureReason: text("failure_reason"),
    startedByUserId: text("started_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("photo_text_check_project_idx").on(table.projectId)],
);

/*
  Critique then polish (27 September 2026): after the Creative Director's
  review, one bounded pass with Impeccable's critique and polish. The
  critique and the before and after are kept; the polished page is a new
  version of the concept (stage "polish").
*/
export const polishPass = pgTable(
  "polish_pass",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id, { onDelete: "cascade" }),
    fromVersion: integer("from_version").notNull(),
    toVersion: integer("to_version"),
    // queued, working, done, failed
    status: text("status").notNull().default("queued"),
    // [{ area, problem, fix }]
    critique: jsonb("critique"),
    // { richness, checks, pngKey } before and after
    before: jsonb("before"),
    after: jsonb("after"),
    estimate: text("estimate"),
    failureReason: text("failure_reason"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("polish_pass_project_idx").on(table.projectId)],
);

/*
  Phase 9, go-live (28 September 2026).

  build_fee_payment: admins record that the build fee was paid (the
  go-live gate needs it); taking it back is logged too. One row per
  project; removedAt keeps an undone record.

  go_live: one row per project, the steps in order: the domain (always
  registered in the client's name), the client's email records read from
  public DNS and copied into the zone on VML's Cloudflare account, checked
  there and confirmed by the PM with the client's email provider, the
  domain on the Netlify site, the nameserver switch at the registrar (the
  client's or the PM's job; TAWD checks it), HTTPS, GA4 (a client-owned
  property with VML as Editor, recorded by hand), then the live deploy.
*/
export const buildFeePayment = pgTable(
  "build_fee_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    paidOn: text("paid_on").notNull(),
    method: text("method").notNull(),
    note: text("note"),
    recordedByUserId: text("recorded_by_user_id").references(() => user.id),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("build_fee_payment_project_idx").on(table.projectId)],
);

export const goLive = pgTable("go_live", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  domain: text("domain"),
  registrar: text("registrar"),
  registrant: text("registrant"),
  domainConfirmedBy: text("domain_confirmed_by").references(() => user.id),
  domainConfirmedAt: timestamp("domain_confirmed_at", { withTimezone: true }),
  // DKIM selectors the PM typed (from the client's email provider).
  dkimSelectors: jsonb("dkim_selectors"),
  // The records found in public DNS before the switch: [{ type, name, content, priority? }]
  emailRecords: jsonb("email_records"),
  emailReadAt: timestamp("email_read_at", { withTimezone: true }),
  cloudflareZoneId: text("cloudflare_zone_id"),
  nameservers: jsonb("nameservers"),
  cloudflareReadyAt: timestamp("cloudflare_ready_at", { withTimezone: true }),
  // What the check found: [{ record, ok, found }]
  emailCheck: jsonb("email_check"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  emailConfirmedBy: text("email_confirmed_by").references(() => user.id),
  emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
  emailConfirmNote: text("email_confirm_note"),
  netlifyDomainAt: timestamp("netlify_domain_at", { withTimezone: true }),
  // From RDAP and public DNS before the switch (28 September 2026): { registrar, registrarUrl, nameservers, rdapSigned, dnssec, checkedAt }.
  registry: jsonb("registry"),
  nameserversSwitchedAt: timestamp("nameservers_switched_at", { withTimezone: true }),
  httpsConfirmedAt: timestamp("https_confirmed_at", { withTimezone: true }),
  ga4PropertyId: text("ga4_property_id"),
  ga4MeasurementId: text("ga4_measurement_id"),
  ga4EditorConfirmedBy: text("ga4_editor_confirmed_by").references(() => user.id),
  ga4RecordedAt: timestamp("ga4_recorded_at", { withTimezone: true }),
  liveVersion: integer("live_version"),
  liveUrl: text("live_url"),
  wentLiveAt: timestamp("went_live_at", { withTimezone: true }),
  /*
    F3, Connect the domain (1 October 2026): the path (records, access or
    vml_dns; null until the PM looks), what TAWD found in public DNS
    ({ snapshot, host, email, advice, at }), the last record check
    ({ changes, ok, resolvers, at }), when the records were right, and the
    client's private link (stored as a SHA-256 hash, never the link).
  */
  connectPath: text("connect_path"),
  connectFound: jsonb("connect_found"),
  connectCheck: jsonb("connect_check"),
  recordsOkAt: timestamp("records_ok_at", { withTimezone: true }),
  clientLinkHash: text("client_link_hash"),
  clientLinkAt: timestamp("client_link_at", { withTimezone: true }),
  clientLinkBy: text("client_link_by").references(() => user.id),
  clientDoneAt: timestamp("client_done_at", { withTimezone: true }),
  /* The speed gate (Jason, 1 October 2026): a founder let this build go live below 85, recorded with the build's version. */
  speedOverrideVersion: integer("speed_override_version"),
  /* A founder let this build go live before every page was approved (3 October 2026). */
  pagesOverrideVersion: integer("pages_override_version"),
  pagesOverrideAt: timestamp("pages_override_at", { withTimezone: true }),
  pagesOverrideBy: text("pages_override_by").references(() => user.id),
  speedOverrideAt: timestamp("speed_override_at", { withTimezone: true }),
  speedOverrideBy: text("speed_override_by").references(() => user.id),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  The design's pages (28 September 2026): each desktop frame of an imported
  or uploaded design, as a page of the site, with its mobile frame when
  there is one. Lane 2, Option A builds every one exactly. Written from the
  import, confirmed (and renamed) by the PM.
*/
export const designPage = pgTable(
  "design_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    // The import these pages were proposed from; a newer import proposes them again.
    figmaVersion: text("figma_version").notNull(),
    frameId: text("frame_id").notNull(),
    frameName: text("frame_name").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isHome: boolean("is_home").notNull().default(false),
    mobileFrameId: text("mobile_frame_id"),
    position: integer("position").notNull(),
    /*
      The SEO pass (29 September 2026): code's suggestions (title,
      description, H1, alt text by picture, heading notes) and what the team
      approved, with who and when. The build uses the approved ones.
    */
    seo: jsonb("seo"),
    confirmedByUserId: text("confirmed_by_user_id").references(() => user.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("design_page_project_idx").on(table.projectId)],
);

/*
  The state privacy rules (28 September 2026): one row per state law, the
  wording and sources kept in step with docs/policies (the source, synced
  when the admin page opens), and when an admin last checked each against
  its official source. Every site's privacy policy adds the sections for
  its states; a rule unchecked for three months flags the projects in that
  state. The quarterly "Review privacy laws" is kept in app_setting
  "privacy_law_review".
*/
export const privacyLaw = pgTable("privacy_law", {
  key: text("key").primaryKey(),
  state: text("state").notNull(),
  stateName: text("state_name").notNull(),
  lawName: text("law_name").notNull(),
  citation: text("citation").notNull(),
  appliesTo: text("applies_to").notNull(),
  coverage: text("coverage").notNull(),
  wording: text("wording").notNull(),
  sourceUrls: jsonb("source_urls").notNull(),
  // The date the repo's text was checked, and the last time an admin checked it since.
  checkedOn: text("checked_on").notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastCheckedByUserId: text("last_checked_by_user_id").references(() => user.id),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- Build B: hosting (Bluehost 4a, 28 September 2026; 20i, 5 October 2026) ---------- */

/*
  TAWD's SSH key for a host it deploys to (28 September 2026): one row
  per purpose ("twentyi"; "bluehost" until 5 October 2026). The private key is encrypted with
  TAWD_ENCRYPTION_KEY (secrets.ts), read only by the worker, never shown
  and never given to an AI. Replacing the key overwrites the row.
*/
export const sshKey = pgTable("ssh_key", {
  purpose: text("purpose").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKeyEncrypted: text("private_key_encrypted").notNull(),
  fingerprint: text("fingerprint").notNull(),
  createdByUserId: text("created_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
  "Check the 20i account" (5 October 2026): run by the worker through 20i's
  API, read-only, no SSH. results is AccountCheckResult (core wp-preview.ts):
  whether the key works, the package types (no data centres: 20i's API has no list) and how many
  packages the account has (20i's own count).
*/
export const hostingAccountCheck = pgTable("hosting_account_check", {
  id: uuid("id").primaryKey().defaultRandom(),
  // queued, working, done, failed.
  status: text("status").notNull(),
  results: jsonb("results"),
  failureReason: text("failure_reason"),
  startedByUserId: text("started_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/*
  The end-to-end check (Jason, 29 September 2026): a test project built from
  a small design with stand-in answers (no AI), deployed as a Netlify
  preview, and its share link opened, page by page and picture by picture.
  steps is [{ key, label, status: waiting|running|passed|failed, detail }].
  The test project is kept until the next check, so its link can be opened.
*/
export const e2eCheck = pgTable("e2e_check", {
  id: uuid("id").primaryKey().defaultRandom(),
  // running, passed, failed.
  status: text("status").notNull(),
  steps: jsonb("steps").notNull().default([]),
  projectId: uuid("project_id"),
  previewUrl: text("preview_url"),
  startedByUserId: text("started_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/*
  The page-by-page review of a built site (step 3a, 3 October 2026): a PM,
  the Web Designer, a founder or an admin opens each built page in TAWD,
  pins comments to its sections and approves it.
*/
export const pageReviewComment = pgTable(
  "page_review_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** The build version the comment was made on. */
    buildVersion: integer("build_version").notNull(),
    /** BuiltPage.pageId. */
    pageId: text("page_id").notNull(),
    parentId: uuid("parent_id"),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    body: text("body").notNull(),
    /** "header", "footer" or "main" (a section of the page's own content); null for a general comment. */
    area: text("area"),
    /** With area "main": the section's place among <main>'s parts, from 0. */
    section: integer("section"),
    /** The section's name when it was pinned (its first heading). */
    sectionLabel: text("section_label"),
    /** Where in the section, in percent of its width and height. */
    pinX: real("pin_x"),
    pinY: real("pin_y"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => user.id),
    /* Fix these (3b): the fix it went in, the build version that fix made, and how many times it was sent. */
    fixId: uuid("fix_id"),
    sentInVersion: integer("sent_in_version"),
    tries: integer("tries").notNull().default(0),
    /* The check after a fix (3c): "done" or "not_done" on outcome_version. */
    outcome: text("outcome"),
    outcomeVersion: integer("outcome_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_review_comment_page_idx").on(t.projectId, t.pageId)],
);

/*
  A page approved on a build version. It carries over to a later version
  while the page's own source and the shared header and footer are the
  same (the two hashes), Jason, 3 October 2026.
*/
export const pageApproval = pgTable(
  "page_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    buildVersion: integer("build_version").notNull(),
    pageId: text("page_id").notNull(),
    pageHash: text("page_hash").notNull(),
    partsHash: text("parts_hash").notNull(),
    approvedByUserId: text("approved_by_user_id")
      .notNull()
      .references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    /** Taken back (a mistake): kept for the record, no longer counted. */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [index("page_approval_page_idx").on(t.projectId, t.pageId)],
);

/*
  The wireframe (3 October 2026): the home page's sections in order and the
  site map, before the concepts, on Growth and Pro (a PM can switch it on
  for Starter, or off). Made by code from the intake; approved by a PM, the
  Web Designer or an admin. Any change after approval asks for it again.
*/
export const wireframe = pgTable(
  "wireframe",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Null follows the tier (on for Growth and Pro); true or false is a PM's choice. */
    enabled: boolean("enabled"),
    /** WireframeSection[] (packages/core mockups/wireframe.ts); empty until first saved. */
    sections: jsonb("sections").notNull().default([]),
    /** The site map as approved: [{ name, slug, parentSlug }]. */
    sitemap: jsonb("sitemap"),
    approvedByUserId: text("approved_by_user_id").references(() => user.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    updatedByUserId: text("updated_by_user_id").references(() => user.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wireframe_project_idx").on(t.projectId)],
);

/*
  Fix these (step 3b, 3 October 2026): one page's open review comments sent
  to the AI with only the parts they're on; the answer is put into a new
  build version made from the saved sources (no AI for the other pages).
*/
export const pageFix = pgTable(
  "page_fix",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    pageName: text("page_name").notNull(),
    /** The page's file name in the build's sources ("home", "drain-cleaning"). */
    slug: text("slug").notNull(),
    baseBuildId: uuid("base_build_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    /** queued, fixing, building, done, failed. */
    status: text("status").notNull().default("queued"),
    detail: text("detail"),
    /** The changed page and shared parts, in R2 (fixes/<id>/...). */
    afterKey: text("after_key"),
    partsKey: text("parts_key"),
    /** Which parts changed: section numbers, "header", "footer". */
    changed: jsonb("changed"),
    buildId: uuid("build_id"),
    resultVersion: integer("result_version"),
    estimate: text("estimate"),
    /** The estimate of one AI call in dollars, for the stop at twice the estimate (3c). */
    estimateCost: real("estimate_cost"),
    /*
      TAWD's code check after the fix (3c, 5 October 2026): PageFixCheck,
      what it found on the first version and on the final one, and why the
      retry didn't make a version when it didn't.
    */
    checkFindings: jsonb("check_findings"),
    /** The one automatic retry ran (a second AI call). */
    retried: boolean("retried").notNull().default(false),
    failureReason: text("failure_reason"),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("page_fix_project_idx").on(t.projectId, t.pageId)],
);

/*
  One row for every job that failed in the worker (audit F-040, 12 November
  2026), so an engineer has something to read after a redeploy has taken the
  container logs. No foreign key on project_id: like ai_call, a record of what
  went wrong stays when its project is deleted, and never blocks the deletion.
  The message and stack are scrubbed of tokens and passwords before they are
  stored (apps/worker/src/failures.ts). last_ai_call_id is the newest ai_call
  row for the same project in the hour before the failure, or null.
*/
export const jobFailure = pgTable(
  "job_failure",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queue: text("queue").notNull(),
    jobName: text("job_name").notNull(),
    jobId: text("job_id").notNull().default(""),
    projectId: uuid("project_id"),
    // The handler's own words, e.g. "Run 123: review".
    label: text("label").notNull(),
    errorClass: text("error_class").notNull(),
    message: text("message").notNull(),
    stack: text("stack").notNull().default(""),
    lastAiCallId: uuid("last_ai_call_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_failure_occurred_idx").on(t.occurredAt)],
);

/*
  D5 (audit F-042, 12 November 2026): when each piece of scheduled work last
  ran. The web app's timers (domain checks, the form-message purge, delivery
  checks, the WordPress daily work; the Site check after a deploy has its own claim) restarted
  with every deploy and would have run twice with a second web server. A
  tick now does its work only after claiming its name here, which only one
  server can do per interval, and the time survives a restart.
*/
export const scheduledRun = pgTable("scheduled_run", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
});
