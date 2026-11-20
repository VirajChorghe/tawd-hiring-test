CREATE TABLE "seo_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"step" text,
	"site_url" text NOT NULL,
	"sandbox" boolean NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rankings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_page_task_id" text,
	"crawl" jsonb,
	"page_speed" jsonb,
	"report" jsonb,
	"extra_evidence_file_id" uuid,
	"estimate_usd" real DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seo_golive_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"edit_request_id" uuid,
	"signed_off_by_user_id" text,
	"signed_off_at" timestamp with time zone,
	"sign_off_note" text,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "seo_audit" ADD CONSTRAINT "seo_audit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_golive_check" ADD CONSTRAINT "seo_golive_check_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seo_audit_project_idx" ON "seo_audit" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "seo_golive_check_project_idx" ON "seo_golive_check" USING btree ("project_id");