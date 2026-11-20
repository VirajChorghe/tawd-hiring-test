CREATE TABLE "dev_time" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"request_id" uuid,
	"minutes" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"worked_on" date NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"before_key" text NOT NULL,
	"after_key" text NOT NULL,
	"changed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"client_words" text NOT NULL,
	"team_note" text DEFAULT '' NOT NULL,
	"requested_on" date NOT NULL,
	"page_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"base_build_id" uuid,
	"build_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_build" ADD COLUMN "edit_request_id" uuid;--> statement-breakpoint
ALTER TABLE "dev_time" ADD CONSTRAINT "dev_time_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dev_time" ADD CONSTRAINT "dev_time_request_id_edit_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."edit_request"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_page" ADD CONSTRAINT "edit_page_request_id_edit_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."edit_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_page" ADD CONSTRAINT "edit_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_request" ADD CONSTRAINT "edit_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_time_project_idx" ON "dev_time" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "edit_page_request_idx" ON "edit_page" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "edit_request_project_idx" ON "edit_request" USING btree ("project_id");