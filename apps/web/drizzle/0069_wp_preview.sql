CREATE TABLE "wp_preview" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"dir" text NOT NULL,
	"db_name" text NOT NULL,
	"db_user" text NOT NULL,
	"db_password_encrypted" text NOT NULL,
	"admin_user" text NOT NULL,
	"admin_password_encrypted" text NOT NULL,
	"state" text NOT NULL,
	"version" integer,
	"deployed_version" integer,
	"https" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"form_emails" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_reason" text,
	"started_by_user_id" text,
	"started_at" timestamp with time zone,
	"deployed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wp_preview" ADD CONSTRAINT "wp_preview_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wp_preview" ADD CONSTRAINT "wp_preview_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;