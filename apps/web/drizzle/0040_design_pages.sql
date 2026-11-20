CREATE TABLE "design_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"figma_version" text NOT NULL,
	"frame_id" text NOT NULL,
	"frame_name" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_home" boolean DEFAULT false NOT NULL,
	"mobile_frame_id" text,
	"position" integer NOT NULL,
	"confirmed_by_user_id" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_status" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_from" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_frame_id" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_png_key" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_overflow" boolean;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_failure" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_decision" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_decided_by_user_id" text;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_copy" ADD COLUMN "mobile_decision_note" text;--> statement-breakpoint
ALTER TABLE "design_page" ADD CONSTRAINT "design_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_page" ADD CONSTRAINT "design_page_confirmed_by_user_id_user_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_page_project_idx" ON "design_page" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "design_copy" ADD CONSTRAINT "design_copy_mobile_decided_by_user_id_user_id_fk" FOREIGN KEY ("mobile_decided_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;