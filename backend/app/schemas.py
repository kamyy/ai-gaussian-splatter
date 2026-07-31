"""Pydantic request/response models — FastAPI validates against these and
derives the /docs OpenAPI schema from them (plan's Express/FastAPI comparison).
"""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from .models import JobStatus, ObjectStatus, PhotoUploadStatus


class ObjectCreate(BaseModel):
    name: str


class ObjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: ObjectStatus
    thumbnail_s3_key: str | None
    is_shareable: bool
    created_at: datetime


class PhotoPresignRequest(BaseModel):
    filename: str
    content_type: str


class PhotoPresignItem(BaseModel):
    photo_id: uuid.UUID
    presigned_put_url: str
    s3_key: str


class PhotoPresignResponse(BaseModel):
    photos: list[PhotoPresignItem]


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    object_id: uuid.UUID
    status: JobStatus
    error_message: str | None
    result_s3_key: str | None
    thumbnail_s3_key: str | None
    created_at: datetime
    updated_at: datetime


class SplatUrlResponse(BaseModel):
    url: str


class WorkerStatusUpdate(BaseModel):
    status: JobStatus
    error_message: str | None = None
    result_s3_key: str | None = None
    thumbnail_s3_key: str | None = None
    ec2_instance_id: str | None = None


class GalleryItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str | None
    thumbnail_url: str
    splat_url: str


class PublicObjectRead(BaseModel):
    title: str
    thumbnail_url: str
    splat_url: str


# Re-export for convenience in routers that need PhotoUploadStatus without
# importing models directly.
__all__ = [
    "ObjectCreate",
    "ObjectRead",
    "PhotoPresignRequest",
    "PhotoPresignItem",
    "PhotoPresignResponse",
    "JobRead",
    "SplatUrlResponse",
    "WorkerStatusUpdate",
    "GalleryItemRead",
    "PublicObjectRead",
    "PhotoUploadStatus",
]
