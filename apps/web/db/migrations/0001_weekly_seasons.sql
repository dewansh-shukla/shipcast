ALTER TABLE "snapshots" DROP CONSTRAINT "snapshots_builder_window_key";--> statement-breakpoint
DROP INDEX "snapshots_window_idx";--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "week_key" text;--> statement-breakpoint
-- Backfill from the window each row already reported. `IYYY-"W"IW` is Postgres'
-- own ISO-8601 week, the same calendar `weekKeyFor` in @ao-wrapped/shared
-- computes: Monday start, and week 1 is the week holding the first Thursday.
UPDATE "snapshots" SET "week_key" = to_char("window_from", 'IYYY-"W"IW') WHERE "week_key" IS NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ALTER COLUMN "week_key" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "snapshots_week_idx" ON "snapshots" USING btree ("week_key");--> statement-breakpoint
-- Rows predating weekly seasons could hold two windows for one builder inside
-- one week. This refuses them rather than picking a winner: which snapshot
-- survives is a judgement about someone's score, not a migration's to make.
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_builder_week_key" UNIQUE("builder_id","week_key");
