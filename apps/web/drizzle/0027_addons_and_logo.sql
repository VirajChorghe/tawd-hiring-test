CREATE TABLE "addon_price" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer,
	"quoted" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logo_design" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"option_count" integer NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_index" integer,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_addon" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"addon_key" text NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "logo_design" ADD CONSTRAINT "logo_design_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_addon" ADD CONSTRAINT "project_addon_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logo_design_project_idx" ON "logo_design" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_addon_project_idx" ON "project_addon" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "addon_price" ("key", "name", "price_cents", "quoted", "sort_order") VALUES
  ('logo_design', 'Logo design (TAWD designs one)', NULL, false, 1),
  ('seo_audit_20', 'Full SEO audit, up to 20 pages', NULL, false, 2),
  ('seo_audit_40', 'Full SEO audit, 21 to 40 pages', NULL, false, 3),
  ('seo_audit_60', 'Full SEO audit, 41 to 60 pages', NULL, false, 4),
  ('seo_audit_80', 'Full SEO audit, 61 to 80 pages', NULL, false, 5),
  ('seo_audit_100', 'Full SEO audit, 81 to 100 pages', NULL, false, 6),
  ('seo_audit_quote', 'Full SEO audit, over 100 pages', NULL, true, 7)
ON CONFLICT ("key") DO NOTHING;
