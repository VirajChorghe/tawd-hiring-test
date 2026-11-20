CREATE TABLE "ai_usage_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"run_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"concept_label" text NOT NULL,
	"direction" text NOT NULL,
	"skill_id" text NOT NULL,
	"model" text NOT NULL,
	"versions" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"trade" text NOT NULL,
	"status_at_deletion" text NOT NULL,
	"reason" text NOT NULL,
	"files_removed" integer NOT NULL,
	"deleted_by_user_id" text,
	"deleted_by_email" text,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deleted_project" ADD CONSTRAINT "deleted_project_deleted_by_user_id_user_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_archive_project_idx" ON "ai_usage_archive" USING btree ("project_id");