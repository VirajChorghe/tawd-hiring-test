ALTER TABLE "preview_decision" ALTER COLUMN "deploy_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_decision" ADD COLUMN "wp_version" integer;