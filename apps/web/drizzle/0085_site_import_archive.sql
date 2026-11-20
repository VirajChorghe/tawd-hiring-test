ALTER TABLE "site_import" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_import" ADD COLUMN "heartbeat_at" timestamp with time zone;