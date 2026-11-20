CREATE TABLE "wireframe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"enabled" boolean,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sitemap" jsonb,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wireframe" ADD CONSTRAINT "wireframe_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wireframe" ADD CONSTRAINT "wireframe_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wireframe" ADD CONSTRAINT "wireframe_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wireframe_project_idx" ON "wireframe" USING btree ("project_id");