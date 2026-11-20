CREATE TABLE "content_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"channel" text NOT NULL,
	"client_said" text NOT NULL,
	"pages" jsonb NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"body" text,
	"note" text,
	"failure_reason" text,
	"created_by_user_id" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"ai_score" real,
	"ai_score_checked_at" timestamp with time zone,
	"ai_score_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content_decision" ADD CONSTRAINT "content_decision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_page_id_page_plan_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page_plan_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_draft" ADD CONSTRAINT "page_draft_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_draft" ADD CONSTRAINT "page_draft_page_id_page_plan_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page_plan_page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_decision_project_idx" ON "content_decision" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_comment_page_idx" ON "page_comment" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "page_draft_page_idx" ON "page_draft" USING btree ("page_id");