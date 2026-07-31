"""Public, unauthenticated endpoints (plan §3) — these are what Next.js's
generateMetadata calls server-side to emit real og:title/og:image tags for
the curated gallery and for a user's shared completed objects.
"""

import uuid

import boto3
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..models import GalleryItem, Job, JobStatus, Object, ObjectStatus
from ..schemas import GalleryItemRead, PublicObjectRead
from ..services.s3 import presign_splat_download

router = APIRouter(prefix="/api/v1", tags=["public"])


@router.get("/gallery", response_model=list[GalleryItemRead])
def list_gallery(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> list[GalleryItemRead]:
    items = db.query(GalleryItem).order_by(GalleryItem.display_order).all()
    return [_gallery_item_to_read(item, settings) for item in items]


@router.get("/gallery/{item_id}", response_model=GalleryItemRead)
def get_gallery_item(
    item_id: uuid.UUID,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> GalleryItemRead:
    item = db.query(GalleryItem).filter(GalleryItem.id == item_id).one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Gallery item not found")
    return _gallery_item_to_read(item, settings)


@router.get("/public/objects/{object_id}", response_model=PublicObjectRead)
def get_public_object(
    object_id: uuid.UUID,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PublicObjectRead:
    """Only exposes complete + is_shareable objects (plan §2's sharing
    default) — else 404, same as if the object simply doesn't exist.
    """
    obj = (
        db.query(Object)
        .filter(Object.id == object_id, Object.status == ObjectStatus.complete, Object.is_shareable.is_(True))
        .one_or_none()
    )
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    latest_job = (
        db.query(Job)
        .filter(Job.object_id == object_id, Job.status == JobStatus.complete)
        .order_by(Job.created_at.desc())
        .first()
    )
    if latest_job is None or latest_job.result_s3_key is None or obj.thumbnail_s3_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

    return PublicObjectRead(
        title=obj.name,
        thumbnail_url=_thumbnail_url(obj.thumbnail_s3_key, settings),
        splat_url=presign_splat_download(latest_job.result_s3_key),
    )


def _gallery_item_to_read(item: GalleryItem, settings: Settings) -> GalleryItemRead:
    return GalleryItemRead(
        id=item.id,
        title=item.title,
        description=item.description,
        thumbnail_url=_thumbnail_url(item.thumbnail_s3_key, settings),
        splat_url=presign_splat_download(item.splat_s3_key),
    )


def _thumbnail_url(key: str, settings: Settings) -> str:
    client = boto3.client("s3", region_name=settings.aws_region)
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": settings.splats_bucket, "Key": key}, ExpiresIn=3600
    )
