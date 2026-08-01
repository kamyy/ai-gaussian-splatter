"""initial schema

Revision ID: 727fb3e65bf5
Revises:
Create Date: 2026-07-30

NOTE: hand-written, translating app/models.py directly, rather than
`alembic revision --autogenerate` — no live Postgres was available in the
sandbox this was written in to autogenerate against. Verify with
`alembic upgrade head` against a real Postgres (plan M2) before trusting it.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "727fb3e65bf5"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("clerk_user_id", sa.String(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_users_clerk_user_id", "users", ["clerk_user_id"])

    object_status = postgresql.ENUM(
        "draft",
        "uploading",
        "ready_to_process",
        "processing",
        "complete",
        "failed",
        name="object_status",
    )
    object_status.create(op.get_bind())

    op.create_table(
        "objects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("status", object_status, nullable=False, server_default="draft"),
        sa.Column("thumbnail_s3_key", sa.String(), nullable=True),
        sa.Column("is_shareable", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_objects_user_id", "objects", ["user_id"])

    photo_upload_status = postgresql.ENUM("pending", "uploaded", "failed", name="photo_upload_status")
    photo_upload_status.create(op.get_bind())

    op.create_table(
        "photos",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("objects.id"), nullable=False),
        sa.Column("s3_key", sa.String(), nullable=False),
        sa.Column("original_filename", sa.String(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("upload_status", photo_upload_status, nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_photos_object_id", "photos", ["object_id"])

    job_status = postgresql.ENUM(
        "queued",
        "launching",
        "colmap_running",
        "training_running",
        "uploading_result",
        "complete",
        "failed",
        "cancelled",
        name="job_status",
    )
    job_status.create(op.get_bind())

    op.create_table(
        "jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("object_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("objects.id"), nullable=False),
        sa.Column("status", job_status, nullable=False, server_default="queued"),
        sa.Column("callback_token", sa.String(), nullable=False),
        sa.Column("ec2_instance_id", sa.String(), nullable=True),
        sa.Column("error_message", sa.String(), nullable=True),
        sa.Column("result_s3_key", sa.String(), nullable=True),
        sa.Column("thumbnail_s3_key", sa.String(), nullable=True),
        sa.Column("colmap_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("colmap_finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("training_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("training_finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_jobs_object_id", "jobs", ["object_id"])

    op.create_table(
        "rate_limit_counters",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("scope", "window_start", name="uq_rate_limit_scope_window"),
    )
    op.create_index("ix_rate_limit_counters_scope", "rate_limit_counters", ["scope"])

    op.create_table(
        "global_job_counters",
        sa.Column("day", sa.DateTime(timezone=True), primary_key=True),
        sa.Column("jobs_started", sa.Integer(), nullable=False, server_default="0"),
    )

    op.create_table(
        "gallery_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("splat_s3_key", sa.String(), nullable=False),
        sa.Column("thumbnail_s3_key", sa.String(), nullable=False),
        sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("gallery_items")
    op.drop_table("global_job_counters")
    op.drop_table("rate_limit_counters")
    op.drop_table("jobs")
    postgresql.ENUM(name="job_status").drop(op.get_bind())
    op.drop_table("photos")
    postgresql.ENUM(name="photo_upload_status").drop(op.get_bind())
    op.drop_table("objects")
    postgresql.ENUM(name="object_status").drop(op.get_bind())
    op.drop_table("users")
