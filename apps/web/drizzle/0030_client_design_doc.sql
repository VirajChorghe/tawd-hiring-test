CREATE TABLE "client_design_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"concept_id" uuid,
	"concept_version" integer,
	"markdown" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_design_doc" ADD CONSTRAINT "client_design_doc_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_design_doc" ADD CONSTRAINT "client_design_doc_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_design_doc" ADD CONSTRAINT "client_design_doc_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_design_doc_project_idx" ON "client_design_doc" USING btree ("project_id");