ALTER TABLE "addon_price" ADD COLUMN "per_page" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_addon" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Client-supplied design (Jason, 27 September 2026): per page, added by itself when a project's design is read from an upload or imported from Figma; no price until an admin sets one.
INSERT INTO "addon_price" ("key", "name", "price_cents", "quoted", "monthly", "per_page", "sort_order") VALUES
  ('client_design', 'Client-supplied design (per page)', NULL, false, false, true, 15)
ON CONFLICT ("key") DO NOTHING;
