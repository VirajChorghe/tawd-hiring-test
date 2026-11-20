CREATE TABLE "client_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"channel" text NOT NULL,
	"changes_requested" boolean NOT NULL,
	"client_said" text NOT NULL,
	"change_request_id" uuid,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_change_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"source" text NOT NULL,
	"notes" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"base_version" integer NOT NULL,
	"result_version" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"detail" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "concept_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"parent_id" uuid,
	"version" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"pin_x" real,
	"pin_y" real,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"change_request_id" uuid,
	"sent_in_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_decision" ADD CONSTRAINT "client_decision_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_decision" ADD CONSTRAINT "client_decision_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_decision" ADD CONSTRAINT "client_decision_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_change_request" ADD CONSTRAINT "concept_change_request_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_change_request" ADD CONSTRAINT "concept_change_request_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_change_request" ADD CONSTRAINT "concept_change_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD CONSTRAINT "concept_comment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD CONSTRAINT "concept_comment_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD CONSTRAINT "concept_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD CONSTRAINT "concept_comment_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_decision_project_idx" ON "client_decision" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "concept_change_request_concept_idx" ON "concept_change_request" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "concept_comment_concept_idx" ON "concept_comment" USING btree ("concept_id");--> statement-breakpoint
CREATE INDEX "concept_comment_project_idx" ON "concept_comment" USING btree ("project_id");