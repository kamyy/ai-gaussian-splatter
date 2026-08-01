"""SQLAlchemy models — plan §2 data model."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class ObjectStatus(str, enum.Enum):
    draft = "draft"
    uploading = "uploading"
    ready_to_process = "ready_to_process"
    processing = "processing"
    complete = "complete"
    failed = "failed"


class PhotoUploadStatus(str, enum.Enum):
    pending = "pending"
    uploaded = "uploaded"
    failed = "failed"


class JobStatus(str, enum.Enum):
    queued = "queued"
    launching = "launching"
    colmap_running = "colmap_running"
    training_running = "training_running"
    uploading_result = "uploading_result"
    complete = "complete"
    failed = "failed"
    cancelled = "cancelled"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    clerk_user_id: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    objects: Mapped[list["Object"]] = relationship(back_populates="user")


class Object(Base):
    __tablename__ = "objects"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[ObjectStatus] = mapped_column(
        Enum(ObjectStatus, name="object_status"), default=ObjectStatus.draft, nullable=False
    )
    thumbnail_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    is_shareable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="objects")
    photos: Mapped[list["Photo"]] = relationship(back_populates="object", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship(back_populates="object", cascade="all, delete-orphan")


class Photo(Base):
    __tablename__ = "photos"

    id: Mapped[uuid.UUID] = _uuid_pk()
    object_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("objects.id"), nullable=False, index=True)
    s3_key: Mapped[str] = mapped_column(String, nullable=False)
    original_filename: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    upload_status: Mapped[PhotoUploadStatus] = mapped_column(
        Enum(PhotoUploadStatus, name="photo_upload_status"), default=PhotoUploadStatus.pending, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    object: Mapped["Object"] = relationship(back_populates="photos")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    object_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("objects.id"), nullable=False, index=True)
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, name="job_status"), default=JobStatus.queued, nullable=False
    )
    callback_token: Mapped[str] = mapped_column(String, nullable=False)
    ec2_instance_id: Mapped[str | None] = mapped_column(String, nullable=True)
    error_message: Mapped[str | None] = mapped_column(String, nullable=True)
    result_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    thumbnail_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)

    colmap_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    colmap_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    training_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    training_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    object: Mapped["Object"] = relationship(back_populates="jobs")


class RateLimitCounter(Base):
    """Fixed-window counters backing per-IP/per-user rate limiting (plan §5)."""

    __tablename__ = "rate_limit_counters"
    __table_args__ = (UniqueConstraint("scope", "window_start", name="uq_rate_limit_scope_window"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String, nullable=False, index=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class GlobalJobCounter(Base):
    """The hard global daily cap backstop (plan §5)."""

    __tablename__ = "global_job_counters"

    day: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    jobs_started: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class GalleryItem(Base):
    __tablename__ = "gallery_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    splat_s3_key: Mapped[str] = mapped_column(String, nullable=False)
    thumbnail_s3_key: Mapped[str] = mapped_column(String, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
