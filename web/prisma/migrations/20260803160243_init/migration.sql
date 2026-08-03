-- CreateEnum
CREATE TYPE "splat_status" AS ENUM ('draft', 'uploading', 'ready_to_process', 'processing', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "photo_upload_status" AS ENUM ('pending', 'uploaded', 'failed');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'launching', 'colmap_running', 'training_running', 'uploading_result', 'complete', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splats" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "splat_status" NOT NULL DEFAULT 'draft',
    "thumbnail_s3_key" TEXT,
    "is_shareable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "splats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "splat_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "upload_status" "photo_upload_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "splat_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "callback_token" TEXT NOT NULL,
    "ec2_instance_id" TEXT,
    "error_message" TEXT,
    "result_s3_key" TEXT,
    "thumbnail_s3_key" TEXT,
    "colmap_started_at" TIMESTAMPTZ(6),
    "colmap_finished_at" TIMESTAMPTZ(6),
    "training_started_at" TIMESTAMPTZ(6),
    "training_finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "id" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_job_counters" (
    "day" TIMESTAMPTZ(6) NOT NULL,
    "jobs_started" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "global_job_counters_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "gallery_items" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "splat_s3_key" TEXT NOT NULL,
    "thumbnail_s3_key" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "gallery_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_user_id_key" ON "users"("clerk_user_id");

-- CreateIndex
CREATE INDEX "ix_splats_user_id" ON "splats"("user_id");

-- CreateIndex
CREATE INDEX "ix_photos_splat_id" ON "photos"("splat_id");

-- CreateIndex
CREATE INDEX "ix_jobs_splat_id" ON "jobs"("splat_id");

-- CreateIndex
CREATE INDEX "ix_rate_limit_counters_scope" ON "rate_limit_counters"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rate_limit_scope_window" ON "rate_limit_counters"("scope", "window_start");

-- AddForeignKey
ALTER TABLE "splats" ADD CONSTRAINT "splats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_splat_id_fkey" FOREIGN KEY ("splat_id") REFERENCES "splats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_splat_id_fkey" FOREIGN KEY ("splat_id") REFERENCES "splats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
