ALTER TABLE "ai_call" ADD COLUMN "scope" text;--> statement-breakpoint
-- Everything before this: the improvement round and Request changes always rewrote the whole page.
UPDATE "ai_call" SET "scope" = 'page' WHERE "step" IN ('improve', 'changes');--> statement-breakpoint
-- Fix rounds became section-only with 0.14.0, confirmed live at 2026-09-24 20:47 UTC.
UPDATE "ai_call" SET "scope" = CASE WHEN "created_at" < '2026-09-24T20:47:06Z' THEN 'page' ELSE 'sections' END WHERE "step" = 'fix';
