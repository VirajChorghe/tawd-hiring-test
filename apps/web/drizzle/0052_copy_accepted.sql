ALTER TABLE "design_copy" ADD COLUMN "accepted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "accepted_note" text;