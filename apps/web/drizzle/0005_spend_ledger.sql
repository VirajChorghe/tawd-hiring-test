CREATE TABLE "ai_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"concept_id" uuid,
	"step" text NOT NULL,
	"round" integer,
	"model" text NOT NULL,
	"started_by_user_id" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_call_created_idx" ON "ai_call" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_call_run_idx" ON "ai_call" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ai_call_project_idx" ON "ai_call" USING btree ("project_id");--> statement-breakpoint
/*
  Fill the ledger from what already exists.

  Concept versions store the concept's running total when each was saved,
  so version 1 is the build and each later version's own share is its total
  minus the one before. Deleted projects kept one total per concept in
  ai_usage_archive, with no split by step, so those count as build.
*/
INSERT INTO "ai_call" (
  "project_id", "run_id", "concept_id", "step", "round", "model",
  "started_by_user_id", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_tokens", "backfilled", "created_at"
)
SELECT
  c."project_id",
  c."run_id",
  v."concept_id",
  CASE WHEN v."version" = 1 THEN 'build' ELSE 'fix' END,
  CASE WHEN v."version" = 1 THEN NULL ELSE v."version" - 1 END,
  r."model",
  r."started_by_user_id",
  GREATEST(v."input_tokens" - COALESCE(LAG(v."input_tokens") OVER w, 0), 0),
  GREATEST(v."output_tokens" - COALESCE(LAG(v."output_tokens") OVER w, 0), 0),
  GREATEST(v."cache_read_tokens" - COALESCE(LAG(v."cache_read_tokens") OVER w, 0), 0),
  GREATEST(v."cache_write_tokens" - COALESCE(LAG(v."cache_write_tokens") OVER w, 0), 0),
  true,
  v."created_at"
FROM "concept_version" v
JOIN "concept" c ON c."id" = v."concept_id"
JOIN "mockup_run" r ON r."id" = c."run_id"
WINDOW w AS (PARTITION BY v."concept_id" ORDER BY v."version");
--> statement-breakpoint
INSERT INTO "ai_call" (
  "project_id", "run_id", "concept_id", "step", "round", "model",
  "started_by_user_id", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_tokens", "backfilled", "created_at"
)
SELECT
  a."project_id", a."run_id", a."concept_id", 'build', NULL, a."model",
  NULL, a."input_tokens", a."output_tokens",
  a."cache_read_tokens", a."cache_write_tokens", true, a."built_at"
FROM "ai_usage_archive" a
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_call" x WHERE x."concept_id" = a."concept_id"
);
