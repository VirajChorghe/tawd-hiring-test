-- One read of the current site (0.96.0, docs/plans/flow-a-one-read.md section 2).
ALTER TABLE "intake_prefill" ADD COLUMN "origin" text DEFAULT 'design' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "home" jsonb;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "home_failure" text;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "home_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "kept_plan" jsonb;--> statement-breakpoint
-- Single-flight for the kept plan, and the go for a blocked site read estimated over $1 (Fable's review H1, M6).
ALTER TABLE "site_import" ADD COLUMN "kept_plan_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "consent_estimate_usd" real;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "consent_route" text;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "consent_usd" real;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "consent_by_user_id" text;--> statement-breakpoint
-- The home page read (current_site_read) copied onto the pages read of the same address.
UPDATE "site_import" s SET "home" = c."result", "home_read_at" = c."read_at" FROM "current_site_read" c WHERE c."project_id" = s."project_id" AND c."url" = s."url" AND c."status" = 'done' AND c."result" IS NOT NULL;--> statement-breakpoint
UPDATE "site_import" s SET "home_failure" = c."failure_reason" FROM "current_site_read" c WHERE c."project_id" = s."project_id" AND c."url" = s."url" AND c."status" = 'failed';--> statement-breakpoint
-- Projects with only a home page read (every project that didn't keep its content): a 'home-only' row.
INSERT INTO "site_import" ("project_id", "url", "status", "page_limit", "source", "pages", "home", "home_read_at", "home_failure", "failure_reason", "finished_at", "created_at")
SELECT c."project_id", c."url",
  CASE WHEN c."status" = 'done' THEN 'done' ELSE 'failed' END,
  CASE p."tier" WHEN 'pro' THEN 50 WHEN 'growth' THEN 20 ELSE 10 END,
  'home-only', '[]'::jsonb,
  CASE WHEN c."status" = 'done' THEN c."result" END,
  c."read_at",
  CASE WHEN c."status" = 'failed' THEN c."failure_reason" WHEN c."status" <> 'done' THEN 'The read was cut off. Read again.' END,
  CASE WHEN c."status" = 'failed' THEN c."failure_reason" WHEN c."status" <> 'done' THEN 'The read was cut off. Read again.' END,
  c."read_at", c."created_at"
FROM "current_site_read" c JOIN "project" p ON p."id" = c."project_id"
WHERE NOT EXISTS (SELECT 1 FROM "site_import" s WHERE s."project_id" = c."project_id");--> statement-breakpoint
-- 0.94.0's reads waiting for the Internet Archive (removed in 0.96.0): failed with the blocked site's message.
UPDATE "site_import" SET "status" = 'failed', "step" = NULL, "finished_at" = now(), "failure_reason" = regexp_replace("url", '^(https?://)?(www\.)?([^/:?#]+).*$', '\3') || ' blocks TAWD''s server, so its pages can''t be read from here. Reading again won''t change that.' WHERE "status" = 'waiting';--> statement-breakpoint
ALTER TABLE "site_import" DROP COLUMN "retry_at";--> statement-breakpoint
ALTER TABLE "site_import" DROP COLUMN "tries";
