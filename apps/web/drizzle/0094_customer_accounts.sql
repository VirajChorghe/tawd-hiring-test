CREATE TABLE "customer" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"phone_number" text,
	"phone_number_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "customer_email_unique" UNIQUE("email"),
	CONSTRAINT "customer_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "flow" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "customer_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_email_lower_unique" ON "customer" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_customer_id_idx" ON "project" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_flow_customer" CHECK (("project"."flow" = 'team' AND "project"."customer_id" IS NULL) OR ("project"."flow" = 'self_serve' AND "project"."customer_id" IS NOT NULL));