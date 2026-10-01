/**
 * The database schema: every Postgres table, enum and index, as Drizzle definitions.
 *
 * This is the source of truth for the database. Editing it doesn't change the database by itself. `pnpm db:generate`
 * writes a migration into web/drizzle/ from the difference, and `pnpm db:migrate` applies it. The exported table
 * objects are also what queries import.
 */

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { JOB_STATUS_DB_VALUES, PHOTO_UPLOAD_STATUSES, SPLAT_STATUSES } from "@/lib/statuses";

// Data model.
//
// PascalCase-free by design: table, column, and enum names are all snake_case in Postgres, with each column stating its
// database name explicitly rather than relying on drizzle's `casing` option. So a migration and a runtime query can
// never silently disagree on a name.
//
// Enum labels come from web/lib/statuses.ts, so the client-side unions and the Postgres labels are one list.

export const splatStatus = pgEnum("splat_status", SPLAT_STATUSES);
export const photoUploadStatus = pgEnum("photo_upload_status", PHOTO_UPLOAD_STATUSES);
/**
 * JOB_STATUS_DB_VALUES, not JOB_STATUSES: the enum's label set also holds the unused "colmap_running" label
 * (web/lib/statuses.ts).
 */
export const jobStatus = pgEnum("job_status", JOB_STATUS_DB_VALUES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  // No separate index on clerkUserId. .unique() already creates one, and a second index would be updated on every
  // insert for nothing.
});

export const splats = pgTable(
  "splats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: splatStatus("status").notNull().default("draft"),
    thumbnailS3Key: text("thumbnail_s3_key"),
    isShareable: boolean("is_shareable").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  table => [index("ix_splats_user_id").on(table.userId)],
);

export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    splatId: uuid("splat_id")
      .notNull()
      .references(() => splats.id, { onDelete: "cascade" }),
    s3Key: text("s3_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes"),
    // Pixel dimensions as the browser displays the photo, read at upload. Nullable only so the column can be added to
    // a table that already has rows. Every upload sets both.
    width: integer("width"),
    height: integer("height"),
    // A small JPEG copy for the photo grid and library cards, uploaded next to the original. Null for a photo uploaded
    // before thumbnails existed, which shows its original instead.
    thumbnailS3Key: text("thumbnail_s3_key"),
    // When the photo was taken: its EXIF capture time, else the file's last-modified time, both read in the browser.
    // Photos are shown oldest first. Null for a photo uploaded before this was recorded, which sorts last.
    takenAt: timestamp("taken_at", { withTimezone: true, precision: 3 }),
    uploadStatus: photoUploadStatus("upload_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  },
  table => [index("ix_photos_splat_id").on(table.splatId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    splatId: uuid("splat_id")
      .notNull()
      .references(() => splats.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("queued"),
    callbackToken: text("callback_token").notNull(),
    ec2InstanceId: text("ec2_instance_id"),
    errorMessage: text("error_message"),
    resultS3Key: text("result_s3_key"),
    resultSpzS3Key: text("result_spz_s3_key"),
    thumbnailS3Key: text("thumbnail_s3_key"),
    pointCloudS3Key: text("point_cloud_s3_key"),

    // When each stage's instance finished booting and its user-data started, as the worker reports it. The gap from
    // there to that stage's *StartedAt is the image pull. Null for a local run, which has no instance to boot.
    colmapBootedAt: timestamp("colmap_booted_at", { withTimezone: true, precision: 6 }),
    colmapStartedAt: timestamp("colmap_started_at", { withTimezone: true, precision: 6 }),
    colmapFinishedAt: timestamp("colmap_finished_at", { withTimezone: true, precision: 6 }),
    // When web/app/api/v1/splats/[splatId]/train/route.ts launched the train stage's instance. trainingStartedAt, set
    // by the worker once it is running, comes after it by the instance's boot and image pull.
    trainingLaunchedAt: timestamp("training_launched_at", { withTimezone: true, precision: 6 }),
    trainingBootedAt: timestamp("training_booted_at", { withTimezone: true, precision: 6 }),
    trainingStartedAt: timestamp("training_started_at", { withTimezone: true, precision: 6 }),
    trainingFinishedAt: timestamp("training_finished_at", { withTimezone: true, precision: 6 }),
    // Percent of gsplat's iterations done, 0-100, reported by the train stage's worker as it goes. Null before
    // training starts.
    trainingProgress: smallint("training_progress"),

    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  table => [
    index("ix_jobs_splat_id").on(table.splatId),
    // Enforces "at most one active job per splat" in the database. web/app/api/v1/splats/[splatId]/process/route.ts
    // relies on this to make its double-trigger guard atomic: a racing request fails at the INSERT with a unique
    // violation, so no separate read-then-write check is needed. Keep the excluded statuses in sync with
    // JOB_ENDED_STATUSES (web/lib/statuses.ts) by hand. This is a raw SQL fragment, so it can't import that constant.
    uniqueIndex("uq_jobs_splat_id_active")
      .on(table.splatId)
      .where(sql`${table.status} not in ('complete', 'failed', 'cancelled')`),
  ],
);

/**
 * Fixed-window counters behind the per-IP and per-user rate limits. web/lib/server/rateLimit.ts increments them with
 * `INSERT … ON CONFLICT … DO UPDATE … RETURNING`. The unique index below is that statement's conflict target, so the
 * statement depends on it. It is not just an optimization.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scope: text("scope").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, precision: 6 }).notNull(),
    count: integer("count").notNull().default(0),
  },
  table => [
    uniqueIndex("uq_rate_limit_scope_window").on(table.scope, table.windowStart),
    index("ix_rate_limit_counters_scope").on(table.scope),
  ],
);

/** The hard global daily cap backstop. */
export const globalJobCounters = pgTable("global_job_counters", {
  day: timestamp("day", { withTimezone: true, precision: 6 }).primaryKey(),
  jobsStarted: integer("jobs_started").notNull().default(0),
});

export type User = typeof users.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
