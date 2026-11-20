CREATE TABLE "current_site_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"failure_reason" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "current_site_read" ADD CONSTRAINT "current_site_read_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "current_site_read_project_idx" ON "current_site_read" USING btree ("project_id");