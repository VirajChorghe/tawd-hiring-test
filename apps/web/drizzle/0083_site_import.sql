CREATE TABLE "site_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"page_limit" integer NOT NULL,
	"source" text,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_imported" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"broken_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"menu" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"started_by_user_id" text,
	"used_at" timestamp with time zone,
	"used_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_import" ADD CONSTRAINT "site_import_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_import_project_idx" ON "site_import" USING btree ("project_id");