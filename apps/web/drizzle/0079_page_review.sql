CREATE TABLE "page_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_version" integer NOT NULL,
	"page_id" text NOT NULL,
	"page_hash" text NOT NULL,
	"parts_hash" text NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_review_comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"build_version" integer NOT NULL,
	"page_id" text NOT NULL,
	"parent_id" uuid,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"area" text,
	"section" integer,
	"section_label" text,
	"pin_x" real,
	"pin_y" real,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "pages_override_version" integer;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "pages_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "go_live" ADD COLUMN "pages_override_by" text;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_approval" ADD CONSTRAINT "page_approval_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD CONSTRAINT "page_review_comment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD CONSTRAINT "page_review_comment_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_review_comment" ADD CONSTRAINT "page_review_comment_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_approval_page_idx" ON "page_approval" USING btree ("project_id","page_id");--> statement-breakpoint
CREATE INDEX "page_review_comment_page_idx" ON "page_review_comment" USING btree ("project_id","page_id");--> statement-breakpoint
ALTER TABLE "go_live" ADD CONSTRAINT "go_live_pages_override_by_user_id_fk" FOREIGN KEY ("pages_override_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;