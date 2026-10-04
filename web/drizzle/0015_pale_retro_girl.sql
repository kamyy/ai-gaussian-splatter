ALTER TABLE "jobs" ADD COLUMN "completed_at" timestamp (6) with time zone;--> statement-breakpoint
-- A complete job's last write before this column existed could be a crop or its undo, so updated_at is only the
-- fallback. training_finished_at misses the result's upload, which takes seconds.
UPDATE "jobs" SET "completed_at" = COALESCE("training_finished_at", "updated_at") WHERE "status" = 'complete';
