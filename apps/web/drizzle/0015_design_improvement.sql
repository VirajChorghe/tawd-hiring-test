CREATE TABLE "design_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"improvement_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"section_number" integer NOT NULL,
	"section_name" text NOT NULL,
	"what" text NOT NULL,
	"why" text NOT NULL,
	"finding_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_image_key" text,
	"after_image_key" text,
	"before_html_key" text,
	"after_html_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_improvement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"detail" text,
	"failure_reason" text,
	"source_key" text,
	"html_key" text,
	"png_key" text,
	"rescore" jsonb,
	"checks" jsonb,
	"not_applied" jsonb,
	"started_by_user_id" text,
	"estimated_input_tokens" bigint,
	"estimated_output_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "design_change" ADD CONSTRAINT "design_change_improvement_id_design_improvement_id_fk" FOREIGN KEY ("improvement_id") REFERENCES "public"."design_improvement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_change" ADD CONSTRAINT "design_change_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD CONSTRAINT "design_improvement_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD CONSTRAINT "design_improvement_copy_id_design_copy_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."design_copy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD CONSTRAINT "design_improvement_review_id_design_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."design_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD CONSTRAINT "design_improvement_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_change_improvement_idx" ON "design_change" USING btree ("improvement_id");--> statement-breakpoint
CREATE INDEX "design_improvement_project_idx" ON "design_improvement" USING btree ("project_id");