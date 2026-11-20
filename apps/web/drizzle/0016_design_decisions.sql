ALTER TABLE "design_change" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "design_change" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "design_change" ADD COLUMN "decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "design_change" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD COLUMN "kind" text DEFAULT 'fixes' NOT NULL;--> statement-breakpoint
ALTER TABLE "design_improvement" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "design_change" ADD CONSTRAINT "design_change_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;