CREATE TABLE "stop_request" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by_user_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stop_request" ADD CONSTRAINT "stop_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;