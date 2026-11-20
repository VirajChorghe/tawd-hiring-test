CREATE TABLE "delivery_test" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"address" text NOT NULL,
	"provider" text NOT NULL,
	"token_hash" text NOT NULL,
	"postmark_id" text,
	"status" text NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "form_heartbeat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "form_heartbeat" ADD CONSTRAINT "form_heartbeat_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_test_sent_idx" ON "delivery_test" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "form_heartbeat_project_idx" ON "form_heartbeat" USING btree ("project_id","sent_at");