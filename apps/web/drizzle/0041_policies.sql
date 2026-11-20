ALTER TABLE "go_live" ADD COLUMN "counsel_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "counsel_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_counsel_reviewed_by_user_id_fk" FOREIGN KEY ("counsel_reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;