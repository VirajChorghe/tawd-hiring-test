CREATE TABLE "page_fix" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text NOT NULL,
	"slug" text NOT NULL,
	"base_build_id" uuid NOT NULL,
	"base_version" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"detail" text,
	"after_key" text,
	"parts_key" text,
	"changed" jsonb,
	"build_id" uuid,
	"result_version" integer,
	"estimate" text,
	"failure_reason" text,
	"requested_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD COLUMN "fix_id" uuid;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD COLUMN "sent_in_version" integer;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD COLUMN "outcome_version" integer;--> statement-breakpoint
ALTER TABLE "page_fix" ADD CONSTRAINT "page_fix_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_fix" ADD CONSTRAINT "page_fix_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_fix_project_idx" ON "page_fix" USING btree ("project_id","page_id");