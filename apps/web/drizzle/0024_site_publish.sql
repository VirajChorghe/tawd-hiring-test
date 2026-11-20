CREATE TABLE "netlify_site" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"admin_url" text,
	"form_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preview_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"deploy_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"channel" text NOT NULL,
	"client_said" text NOT NULL,
	"recorded_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_deploy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"netlify_deploy_id" text,
	"url" text,
	"state" text NOT NULL,
	"error" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_build" ADD COLUMN "checks" jsonb;--> statement-breakpoint
ALTER TABLE "site_build" ADD COLUMN "mode" text DEFAULT 'preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "netlify_site" ADD CONSTRAINT "netlify_site_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_decision" ADD CONSTRAINT "preview_decision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_decision" ADD CONSTRAINT "preview_decision_deploy_id_site_deploy_id_fk" FOREIGN KEY ("deploy_id") REFERENCES "public"."site_deploy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_deploy" ADD CONSTRAINT "site_deploy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_deploy" ADD CONSTRAINT "site_deploy_build_id_site_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."site_build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preview_decision_project_idx" ON "preview_decision" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "site_deploy_project_idx" ON "site_deploy" USING btree ("project_id");