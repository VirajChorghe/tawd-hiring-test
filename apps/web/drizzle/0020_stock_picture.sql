CREATE TABLE "stock_picture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"query" text NOT NULL,
	"status" text NOT NULL,
	"shutterstock_id" text,
	"description" text,
	"image_key" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_picture" ADD CONSTRAINT "stock_picture_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_picture_project_query_idx" ON "stock_picture" USING btree ("project_id","query");