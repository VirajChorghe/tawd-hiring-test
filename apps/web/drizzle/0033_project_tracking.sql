CREATE TABLE "project_tracking" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"ga4" text DEFAULT '' NOT NULL,
	"gtm" text DEFAULT '' NOT NULL,
	"meta_pixel" text DEFAULT '' NOT NULL,
	"google_ads" text DEFAULT '' NOT NULL,
	"consent_mode" text DEFAULT 'opt_in' NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_tracking" ADD CONSTRAINT "project_tracking_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tracking" ADD CONSTRAINT "project_tracking_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;