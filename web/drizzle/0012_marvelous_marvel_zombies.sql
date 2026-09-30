ALTER TABLE "jobs" ADD COLUMN "colmap_booted_at" timestamp (6) with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "training_booted_at" timestamp (6) with time zone;