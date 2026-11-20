CREATE TABLE "health_flag_confirmation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"flag_id" text NOT NULL,
	"rule" text NOT NULL,
	"found" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"build_version" integer NOT NULL,
	"confirmed_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_flag_confirmation" ADD CONSTRAINT "health_flag_confirmation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_flag_confirmation" ADD CONSTRAINT "health_flag_confirmation_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "health_flag_confirmation_flag_idx" ON "health_flag_confirmation" USING btree ("project_id","flag_id");