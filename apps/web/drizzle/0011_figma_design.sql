CREATE TABLE "figma_design" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"file_key" text NOT NULL,
	"linked_by_user_id" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_status" text,
	"checked_at" timestamp with time zone,
	"failure_kind" text,
	"failure_message" text,
	"file_name" text,
	"figma_version" text,
	"readiness" jsonb,
	"file_json_key" text,
	"chosen_page_id" text,
	"import_status" text,
	"import_failure" text,
	"import_queued_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"imported_by_user_id" text,
	"imported_version" text,
	"frames" jsonb,
	"image_files" jsonb,
	"import_warnings" jsonb
);
--> statement-breakpoint
CREATE TABLE "figma_read" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "figma_design" ADD CONSTRAINT "figma_design_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_design" ADD CONSTRAINT "figma_design_linked_by_user_id_user_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "figma_design" ADD CONSTRAINT "figma_design_imported_by_user_id_user_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "figma_read_created_idx" ON "figma_read" USING btree ("created_at");