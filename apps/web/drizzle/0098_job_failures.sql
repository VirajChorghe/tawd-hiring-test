CREATE TABLE "job_failure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"job_name" text NOT NULL,
	"job_id" text DEFAULT '' NOT NULL,
	"project_id" uuid,
	"label" text NOT NULL,
	"error_class" text NOT NULL,
	"message" text NOT NULL,
	"stack" text DEFAULT '' NOT NULL,
	"last_ai_call_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "job_failure_occurred_idx" ON "job_failure" USING btree ("occurred_at");