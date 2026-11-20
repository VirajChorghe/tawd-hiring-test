CREATE TABLE "logo_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"channel" text NOT NULL,
	"client_said" text NOT NULL,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logo_swap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "logo_approval" ADD CONSTRAINT "logo_approval_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logo_approval" ADD CONSTRAINT "logo_approval_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logo_approval" ADD CONSTRAINT "logo_approval_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logo_swap" ADD CONSTRAINT "logo_swap_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logo_swap" ADD CONSTRAINT "logo_swap_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logo_swap" ADD CONSTRAINT "logo_swap_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logo_approval_project_idx" ON "logo_approval" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "logo_swap_project_idx" ON "logo_swap" USING btree ("project_id");