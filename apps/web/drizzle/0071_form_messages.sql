CREATE TABLE "form_channel" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"form_name" text NOT NULL,
	"visitor_name" text,
	"visitor_email" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"postmark_id" text,
	"detail" text,
	"external_id" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_test" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"token_hash" text NOT NULL,
	"postmark_id" text,
	"status" text NOT NULL,
	"detail" text,
	"sent_by_user_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "form_channel" ADD CONSTRAINT "form_channel_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_message" ADD CONSTRAINT "form_message_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_test" ADD CONSTRAINT "form_test_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_test" ADD CONSTRAINT "form_test_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_message_project_idx" ON "form_message" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "form_message_external_idx" ON "form_message" USING btree ("project_id","external_id");