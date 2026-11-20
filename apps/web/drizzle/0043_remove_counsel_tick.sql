ALTER TABLE "go_live" DROP CONSTRAINT "go_live_counsel_reviewed_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "go_live" DROP COLUMN "counsel_reviewed_by";--> statement-breakpoint
ALTER TABLE "go_live" DROP COLUMN "counsel_reviewed_at";