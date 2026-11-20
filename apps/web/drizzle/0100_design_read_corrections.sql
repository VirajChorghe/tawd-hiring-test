CREATE TABLE "design_read_correction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" text NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"target" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"change" jsonb NOT NULL,
	"made_on_run" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_read_correction" ADD CONSTRAINT "design_read_correction_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_read_correction" ADD CONSTRAINT "design_read_correction_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_read_correction_project_version_idx" ON "design_read_correction" USING btree ("project_id","version");