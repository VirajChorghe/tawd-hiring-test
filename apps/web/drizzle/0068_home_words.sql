CREATE TABLE "home_words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"testimonials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"write_status" text,
	"write_failure" text,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_words" ADD CONSTRAINT "home_words_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "home_words_project_idx" ON "home_words" USING btree ("project_id");