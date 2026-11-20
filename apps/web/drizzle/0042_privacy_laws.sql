CREATE TABLE "privacy_law" (
	"key" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"state_name" text NOT NULL,
	"law_name" text NOT NULL,
	"citation" text NOT NULL,
	"applies_to" text NOT NULL,
	"coverage" text NOT NULL,
	"wording" text NOT NULL,
	"source_urls" jsonb NOT NULL,
	"checked_on" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_checked_by_user_id" text,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_law" ADD CONSTRAINT "privacy_law_last_checked_by_user_id_user_id_fk" FOREIGN KEY ("last_checked_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;