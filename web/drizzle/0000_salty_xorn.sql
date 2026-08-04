CREATE TYPE "public"."job_status" AS ENUM('queued', 'launching', 'colmap_running', 'training_running', 'uploading_result', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."photo_upload_status" AS ENUM('pending', 'uploaded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."splat_status" AS ENUM('draft', 'uploading', 'ready_to_process', 'processing', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "gallery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"splat_s3_key" text NOT NULL,
	"thumbnail_s3_key" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_job_counters" (
	"day" timestamp (6) with time zone PRIMARY KEY NOT NULL,
	"jobs_started" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"splat_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"callback_token" text NOT NULL,
	"ec2_instance_id" text,
	"error_message" text,
	"result_s3_key" text,
	"thumbnail_s3_key" text,
	"colmap_started_at" timestamp (6) with time zone,
	"colmap_finished_at" timestamp (6) with time zone,
	"training_started_at" timestamp (6) with time zone,
	"training_finished_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"splat_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer,
	"upload_status" "photo_upload_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"window_start" timestamp (6) with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "splats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "splat_status" DEFAULT 'draft' NOT NULL,
	"thumbnail_s3_key" text,
	"is_shareable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_splat_id_splats_id_fk" FOREIGN KEY ("splat_id") REFERENCES "public"."splats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_splat_id_splats_id_fk" FOREIGN KEY ("splat_id") REFERENCES "public"."splats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splats" ADD CONSTRAINT "splats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_jobs_splat_id" ON "jobs" USING btree ("splat_id");--> statement-breakpoint
CREATE INDEX "ix_photos_splat_id" ON "photos" USING btree ("splat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rate_limit_scope_window" ON "rate_limit_counters" USING btree ("scope","window_start");--> statement-breakpoint
CREATE INDEX "ix_rate_limit_counters_scope" ON "rate_limit_counters" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "ix_splats_user_id" ON "splats" USING btree ("user_id");