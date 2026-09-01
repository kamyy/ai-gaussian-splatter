import {
  bigserial,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { JOB_STATUSES, PHOTO_UPLOAD_STATUSES, SPLAT_STATUSES } from "@/lib/types";

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
 * Enum labels come from lib/types.ts, so the client-side unions and the Postgres labels are one list.
 */

export const splatStatus = pgEnum("splat_status", SPLAT_STATUSES);
export const photoUploadStatus = pgEnum("photo_upload_status", PHOTO_UPLOAD_STATUSES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  // No separate index on clerkUserId — .unique() already creates one, and a second would be maintained on every insert
  // for nothing.
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

    colmapStartedAt: timestamp("colmap_started_at", { withTimezone: true, precision: 6 }),
    colmapFinishedAt: timestamp("colmap_finished_at", { withTimezone: true, precision: 6 }),
    trainingStartedAt: timestamp("training_started_at", { withTimezone: true, precision: 6 }),
    trainingFinishedAt: timestamp("training_finished_at", { withTimezone: true, precision: 6 }),

    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  table => [index("ix_jobs_splat_id").on(table.splatId)],
);

/**
 * Fixed-window counters backing per-IP/per-user rate limiting. Incremented via `INSERT … ON CONFLICT … DO UPDATE …
 * RETURNING` in web/lib/server/rateLimit.ts — the unique index below is that statement's conflict target, so it is
 * load-bearing, not just an optimisation.
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

export const galleryItems = pgTable("gallery_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  splatS3Key: text("splat_s3_key").notNull(),
  thumbnailS3Key: text("thumbnail_s3_key").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
});

export type User = typeof users.$inferSelect;
export type Splat = typeof splats.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
