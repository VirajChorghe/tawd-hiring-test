CREATE TABLE "design_copy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"figma_version" text NOT NULL,
	"frame_id" text NOT NULL,
	"frame_name" text NOT NULL,
	"source_key" text,
	"html_key" text,
	"png_key" text,
	"fidelity" jsonb,
	"checks" jsonb,
	"notes" jsonb,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "figma_design" ADD COLUMN "design_assets" jsonb;--> statement-breakpoint
ALTER TABLE "design_copy" ADD CONSTRAINT "design_copy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_copy" ADD CONSTRAINT "design_copy_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_copy_project_idx" ON "design_copy" USING btree ("project_id");