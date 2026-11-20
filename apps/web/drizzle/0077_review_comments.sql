ALTER TABLE "concept_comment" ADD COLUMN "band" integer;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD COLUMN "outcome_version" integer;--> statement-breakpoint
ALTER TABLE "concept_comment" ADD COLUMN "tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Comments already sent once count as one try.
UPDATE "concept_comment" SET "tries" = 1 WHERE "change_request_id" IS NOT NULL;