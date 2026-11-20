CREATE TABLE "hosting_account_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"results" jsonb,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wp_preview" ALTER COLUMN "host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ALTER COLUMN "dir" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ALTER COLUMN "db_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ALTER COLUMN "db_user" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "package_id" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "package_domain" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "staging_host" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "package_ipv4" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "ssh_host" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "ssh_user" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "db_host" text;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "certs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "ip_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "ip_note" jsonb;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD COLUMN "limit_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "hosting_account_check" ADD CONSTRAINT "hosting_account_check_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TABLE "bluehost_check" CASCADE;--> statement-breakpoint
DELETE FROM "ssh_key" WHERE "purpose" = 'bluehost';--> statement-breakpoint
DELETE FROM "app_setting" WHERE "key" = 'bluehost_host_key';--> statement-breakpoint
-- WordPress moves to 20i (5 October 2026): the add-on's name no longer names the host (only if nobody renamed it).
UPDATE "addon_price" SET "name" = 'WordPress hosting' WHERE "key" = 'wordpress_hosting' AND "name" = 'WordPress hosting (Bluehost)';