CREATE TABLE "section_example" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"band_index" integer NOT NULL,
	"direction" text NOT NULL,
	"trade" text NOT NULL,
	"kind" text NOT NULL,
	"html" text NOT NULL,
	"css" text NOT NULL,
	"score_tenths" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "section_example" ADD CONSTRAINT "section_example_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_example" ADD CONSTRAINT "section_example_concept_id_concept_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concept"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "section_example_direction_idx" ON "section_example" USING btree ("direction");--> statement-breakpoint
CREATE UNIQUE INDEX "section_example_band_idx" ON "section_example" USING btree ("concept_id","version","band_index");