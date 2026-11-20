CREATE TABLE "build_fee_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"paid_on" text NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"recorded_by_user_id" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "go_live" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"domain" text,
	"registrar" text,
	"registrant" text,
	"domain_confirmed_by" text,
	"domain_confirmed_at" timestamp with time zone,
	"dkim_selectors" jsonb,
	"email_records" jsonb,
	"email_read_at" timestamp with time zone,
	"cloudflare_zone_id" text,
	"nameservers" jsonb,
	"cloudflare_ready_at" timestamp with time zone,
	"email_check" jsonb,
	"email_verified_at" timestamp with time zone,
	"email_confirmed_by" text,
	"email_confirmed_at" timestamp with time zone,
	"email_confirm_note" text,
	"netlify_domain_at" timestamp with time zone,
	"nameservers_switched_at" timestamp with time zone,
	"https_confirmed_at" timestamp with time zone,
	"ga4_property_id" text,
	"ga4_measurement_id" text,
	"ga4_editor_confirmed_by" text,
	"ga4_recorded_at" timestamp with time zone,
	"live_version" integer,
	"live_url" text,
	"went_live_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_deploy" ADD COLUMN "kind" text DEFAULT 'preview' NOT NULL;--> statement-breakpoint
ALTER TABLE "build_fee_payment" ADD CONSTRAINT "build_fee_payment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_fee_payment" ADD CONSTRAINT "build_fee_payment_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_domain_confirmed_by_user_id_fk" FOREIGN KEY ("domain_confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_email_confirmed_by_user_id_fk" FOREIGN KEY ("email_confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_ga4_editor_confirmed_by_user_id_fk" FOREIGN KEY ("ga4_editor_confirmed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_fee_payment_project_idx" ON "build_fee_payment" USING btree ("project_id");