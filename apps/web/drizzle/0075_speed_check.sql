CREATE TABLE "speed_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"target" text NOT NULL,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"results" jsonb,
	"error" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "speed_check" ADD CONSTRAINT "speed_check_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speed_check_project_idx" ON "speed_check" USING btree ("project_id","created_at");