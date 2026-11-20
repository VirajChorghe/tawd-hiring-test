CREATE TABLE "site_build" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"step" text,
	"concept_id" uuid,
	"concept_version" integer,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_build" ADD CONSTRAINT "site_build_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_build_project_idx" ON "site_build" USING btree ("project_id");