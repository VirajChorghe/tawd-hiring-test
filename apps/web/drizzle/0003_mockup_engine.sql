CREATE TABLE "concept" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"label" text NOT NULL,
	"direction" text NOT NULL,
	"skill_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"send_to_client" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "concept_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"html_key" text,
	"png_key" text,
	"fold_png_key" text,
	"checks" jsonb,
	"review" jsonb,
	"summary" text,
	"placeholder_count" integer,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_log_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid,
	"trade" text NOT NULL,
	"city" text,
	"direction" text NOT NULL,
	"palette_family" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_count" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_by_user_id" text,
	"estimated_input_tokens" bigint,
	"estimated_output_tokens" bigint,
	"model" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_run_id_mockup_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mockup_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept" ADD CONSTRAINT "concept_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_step" ADD CONSTRAINT "concept_step_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_version" ADD CONSTRAINT "concept_version_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_log_entry" ADD CONSTRAINT "design_log_entry_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_log_entry" ADD CONSTRAINT "design_log_entry_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_run" ADD CONSTRAINT "mockup_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup_run" ADD CONSTRAINT "mockup_run_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_run_idx" ON "concept" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "concept_step_concept_idx" ON "concept_step" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "concept_version_concept_idx" ON "concept_version" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "design_log_trade_city_idx" ON "design_log_entry" USING btree ("trade","city");--> statement-breakpoint
CREATE INDEX "mockup_run_project_idx" ON "mockup_run" USING btree ("project_id");