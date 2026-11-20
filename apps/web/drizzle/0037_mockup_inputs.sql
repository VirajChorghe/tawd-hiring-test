CREATE TABLE "photo_text_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"readings" jsonb,
	"findings" jsonb,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "polish_pass" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"critique" jsonb,
	"before" jsonb,
	"after" jsonb,
	"estimate" text,
	"failure_reason" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "page_image_key" text;--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "outline" jsonb;--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "brief" jsonb;--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "brief_status" text;--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "brief_failure" text;--> statement-breakpoint
ALTER TABLE "liked_site_shot" ADD COLUMN "studied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mockup_run" ADD COLUMN "polish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_picture" ADD COLUMN "clash" text;--> statement-breakpoint
ALTER TABLE "photo_text_check" ADD CONSTRAINT "photo_text_check_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_text_check" ADD CONSTRAINT "photo_text_check_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polish_pass" ADD CONSTRAINT "polish_pass_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polish_pass" ADD CONSTRAINT "polish_pass_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polish_pass" ADD CONSTRAINT "polish_pass_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_text_check_project_idx" ON "photo_text_check" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "polish_pass_project_idx" ON "polish_pass" USING btree ("project_id");