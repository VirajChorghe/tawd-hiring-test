CREATE TABLE "project_slack" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"webhook_encrypted" text NOT NULL,
	"webhook_hint" text NOT NULL,
	"post_comments" boolean DEFAULT false NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_post_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_slack" ADD CONSTRAINT "project_slack_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_slack" ADD CONSTRAINT "project_slack_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;