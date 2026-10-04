-- Any row still labeled colmap_running has to move before the type below drops that label.
UPDATE "jobs" SET "status" = 'reconstruction_running' WHERE "status" = 'colmap_running';--> statement-breakpoint
-- The partial unique index's predicate names this enum, so it is recreated after the type is.
DROP INDEX "uq_jobs_splat_id_active";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'queued'::text;--> statement-breakpoint
DROP TYPE "public"."job_status";--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'launching', 'awaiting_training', 'training_running', 'uploading_result', 'complete', 'failed', 'cancelled', 'reconstruction_running');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'queued'::"public"."job_status";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE "public"."job_status" USING "status"::"public"."job_status";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_splat_id_active" ON "jobs" USING btree ("splat_id") WHERE "jobs"."status" not in ('complete', 'failed', 'cancelled');
