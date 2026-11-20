ALTER TABLE "go_live" ADD COLUMN "speed_override_version" integer;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "speed_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "speed_override_by" text;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_speed_override_by_user_id_fk" FOREIGN KEY ("speed_override_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;