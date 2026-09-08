ALTER TYPE "public"."job_status" ADD VALUE 'awaiting_training' BEFORE 'training_running';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "colmap_point_cloud_s3_key" text;