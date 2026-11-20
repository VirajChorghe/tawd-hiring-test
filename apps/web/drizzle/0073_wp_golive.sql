ALTER TABLE "wp_preview" ADD COLUMN "live_domain" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "bluehost_domain_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "bluehost_domain_note" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "live_steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "live_state" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "backups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "live_form_id" integer;