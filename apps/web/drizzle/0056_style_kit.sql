CREATE TABLE "style_kit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"design_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"kit" jsonb,
	"inventories_key" text,
	"sheet_key" text,
	"preview_key" text,
	"preview_fidelity" integer,
	"preview_check" jsonb,
	"font_overrides" jsonb,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "style_kit" ADD CONSTRAINT "style_kit_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_kit" ADD CONSTRAINT "style_kit_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "style_kit_project_idx" ON "style_kit" USING btree ("project_id");