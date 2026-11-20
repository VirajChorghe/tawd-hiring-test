CREATE TABLE "package_price" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"build_fee_cents" integer,
	"monthly_fee_cents" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "package_key" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "build_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "monthly_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "cancelled_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
INSERT INTO "package_price" ("key", "name", "build_fee_cents", "monthly_fee_cents", "sort_order") VALUES ('starter', 'Starter', 19900, 9900, 1), ('growth', 'Growth', NULL, NULL, 2), ('pro', 'Pro', NULL, NULL, 3) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "project" SET "package_key" = "tier" WHERE "package_key" IS NULL;
