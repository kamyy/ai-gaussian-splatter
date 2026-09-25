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

import { JOB_STATUS_DB_VALUES, PHOTO_UPLOAD_STATUSES, SPLAT_STATUSES } from "@/lib/types";

/**
 * Data model.
 *
 * PascalCase-free by design: table, column, and enum names are all snake_case in Postgres, with each column stating its
 * database name explicitly rather than relying on drizzle's `casing` option. So a migration and a runtime query can
 * never silently disagree on a name.
 *
 * The table export is `splats`, not `objects`, to avoid shadowing JS's `Object`. The same naming is used throughout
 * the app, including REST paths and hooks.
 *
 * Enum labels come from web/lib/types.ts, so the client-side unions and the Postgres labels are one list.
 */

export const splatStatus = pgEnum("splat_status", SPLAT_STATUSES);
export const photoUploadStatus = pgEnum("photo_upload_status", PHOTO_UPLOAD_STATUSES);
// JOB_STATUS_DB_VALUES, not JOB_STATUSES: the enum's label set is a superset that also keeps the pre-rename
// "colmap_running" value valid (web/lib/types.ts).
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
      .references(() => users.id),
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
    thumbnailS3Key: text("thumbnail_s3_key"),
    pointCloudS3Key: text("point_cloud_s3_key"),

    colmapStartedAt: timestamp("colmap_started_at", { withTimezone: true, precision: 6 }),
    colmapFinishedAt: timestamp("colmap_finished_at", { withTimezone: true, precision: 6 }),
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
    // JOB_ENDED_STATUSES (web/lib/types.ts) by hand. This is a raw SQL fragment, so it can't import that constant.
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
