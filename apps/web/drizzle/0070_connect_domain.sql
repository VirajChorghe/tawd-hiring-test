ALTER TABLE "go_live" ADD COLUMN "connect_path" text;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "connect_found" jsonb;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "connect_check" jsonb;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "records_ok_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "client_link_hash" text;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "client_link_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "client_link_by" text;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "client_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_client_link_by_user_id_fk" FOREIGN KEY ("client_link_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;