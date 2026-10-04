ALTER TABLE "jobs" ADD COLUMN "crop_box" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cropped_result_s3_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cropped_result_spz_s3_key" text;