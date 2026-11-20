CREATE TABLE "keyword_metric" (
	"keyword" text NOT NULL,
	"place" text NOT NULL,
	"sandbox" boolean NOT NULL,
	"search_volume" integer,
	"cpc" real,
	"competition" text,
	"difficulty" integer,
	"volume_fetched_at" timestamp with time zone,
	"difficulty_fetched_at" timestamp with time zone,
	CONSTRAINT "keyword_metric_keyword_place_sandbox_pk" PRIMARY KEY("keyword","place","sandbox")
);
--> statement-breakpoint
CREATE TABLE "keyword_research" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"sandbox" boolean NOT NULL,
	"keyword_count" integer DEFAULT 0 NOT NULL,
	"places" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimate_usd" real DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"cached_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"started_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_plan_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"main_keyword" text DEFAULT '' NOT NULL,
	"supporting_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"meta_description" text DEFAULT '' NOT NULL,
	"h1" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_data_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"research_id" uuid,
	"endpoint" text NOT NULL,
	"sandbox" boolean NOT NULL,
	"keyword_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"message" text,
	"started_by_user_id" text,
	"response_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_keyword" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"research_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"service" text,
	"area" text NOT NULL,
	"place" text NOT NULL,
	"search_volume" integer,
	"cpc" real,
	"competition" text,
	"difficulty" integer
);
--> statement-breakpoint
ALTER TABLE "keyword_research" ADD CONSTRAINT "keyword_research_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_plan_page" ADD CONSTRAINT "page_plan_page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keyword" ADD CONSTRAINT "seo_keyword_research_id_keyword_research_id_fk" FOREIGN KEY ("research_id") REFERENCES "public"."keyword_research"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_keyword" ADD CONSTRAINT "seo_keyword_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "keyword_research_project_idx" ON "keyword_research" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_plan_page_project_idx" ON "page_plan_page" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "seo_data_call_created_idx" ON "seo_data_call" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "seo_keyword_research_idx" ON "seo_keyword" USING btree ("research_id");