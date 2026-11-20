ALTER TABLE "addon_price" ADD COLUMN "monthly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "hosting" text DEFAULT 'netlify' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_addon" ADD COLUMN "monthly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- WordPress hosting (Jason, 27 September 2026): a monthly add-on, added by itself when a project that isn't Pro moves to WordPress; no price until an admin sets one.
INSERT INTO "addon_price" ("key", "name", "price_cents", "quoted", "monthly", "sort_order") VALUES
  ('wordpress_hosting', 'WordPress hosting (Bluehost)', NULL, false, true, 14)
ON CONFLICT ("key") DO NOTHING;
