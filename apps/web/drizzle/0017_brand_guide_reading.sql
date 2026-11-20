CREATE TABLE "brand_guide_reading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text NOT NULL,
	"pages" integer,
	"colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fonts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"logo_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_guide_reading" ADD CONSTRAINT "brand_guide_reading_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_guide_reading" ADD CONSTRAINT "brand_guide_reading_file_id_intake_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."intake_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_guide_reading_project_idx" ON "brand_guide_reading" USING btree ("project_id");