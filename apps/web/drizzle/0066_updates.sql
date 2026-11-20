CREATE TABLE "update_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"month" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"lines" jsonb NOT NULL,
	"total_cents" integer,
	"status" text DEFAULT 'waiting' NOT NULL,
	"decision_channel" text,
	"client_said" text,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_request" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "edit_request" ADD COLUMN "estimate_minutes" integer;--> statement-breakpoint
ALTER TABLE "edit_request" ADD COLUMN "page_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "edit_request" ADD COLUMN "redesign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "update_invoice" ADD CONSTRAINT "update_invoice_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_quote" ADD CONSTRAINT "update_quote_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_quote" ADD CONSTRAINT "update_quote_request_id_edit_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."edit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "update_invoice_project_month_idx" ON "update_invoice" USING btree ("project_id","month");--> statement-breakpoint
CREATE INDEX "update_quote_project_idx" ON "update_quote" USING btree ("project_id");--> statement-breakpoint
-- Updates (Jason, 30 September 2026): the prices a quote is made from. Blank until an admin sets them on Pricing.
INSERT INTO "addon_price" ("key", "name", "price_cents", "quoted", "monthly", "per_page", "sort_order") VALUES
  ('hours_over', 'Hours over the plan (per hour)', NULL, false, false, false, 30),
  ('new_page', 'New page', NULL, false, false, false, 31),
  ('redesign', 'Redesign', NULL, false, false, false, 32)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- The included hours a month, per tier: 8 for each, as before, until an admin changes them on Pricing (Pro gets more later).
INSERT INTO "app_setting" ("key", "value") VALUES ('included_hours', '{"starter": 8, "growth": 8, "pro": 8}')
ON CONFLICT ("key") DO NOTHING;
