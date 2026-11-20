ALTER TABLE "page_fix" ADD COLUMN "estimate_cost" real;--> statement-breakpoint
ALTER TABLE "page_fix" ADD COLUMN "check_findings" jsonb;--> statement-breakpoint
ALTER TABLE "page_fix" ADD COLUMN "retried" boolean DEFAULT false NOT NULL;