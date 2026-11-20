CREATE TABLE "design_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"grade" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"problem" text NOT NULL,
	"change" text NOT NULL,
	"why" text NOT NULL,
	"layer_id" text,
	"layer_name" text,
	"pin_x" real,
	"pin_y" real,
	"ticked" boolean DEFAULT false NOT NULL,
	"ticked_by_user_id" text,
	"ticked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "design_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"figma_version" text NOT NULL,
	"frame_id" text NOT NULL,
	"frame_name" text NOT NULL,
	"review" jsonb,
	"started_by_user_id" text,
	"estimated_input_tokens" bigint,
	"estimated_output_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "design_finding" ADD CONSTRAINT "design_finding_review_id_design_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."design_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_finding" ADD CONSTRAINT "design_finding_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_finding" ADD CONSTRAINT "design_finding_ticked_by_user_id_user_id_fk" FOREIGN KEY ("ticked_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_review" ADD CONSTRAINT "design_review_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_review" ADD CONSTRAINT "design_review_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_finding_review_idx" ON "design_finding" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "design_review_project_idx" ON "design_review" USING btree ("project_id");