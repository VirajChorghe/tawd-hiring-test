CREATE TABLE "intake_prefill" (
	"project_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"filled_by_user_id" text,
	"filled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "intake_prefill_project_id_field_key_pk" PRIMARY KEY("project_id","field_key")
);
--> statement-breakpoint
ALTER TABLE "figma_design" ADD COLUMN "prefill_result" jsonb;--> statement-breakpoint
ALTER TABLE "intake_prefill" ADD CONSTRAINT "intake_prefill_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_prefill" ADD CONSTRAINT "intake_prefill_filled_by_user_id_user_id_fk" FOREIGN KEY ("filled_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_prefill" ADD CONSTRAINT "intake_prefill_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;