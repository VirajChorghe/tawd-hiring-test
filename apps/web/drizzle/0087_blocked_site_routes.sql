CREATE TABLE "site_read_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"read_id" uuid,
	"route" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"ok" boolean NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "site_read_call_created_idx" ON "site_read_call" USING btree ("created_at");