"""Presign + complete endpoints. Rate limiting happens here — see plan §5:
this gates *before* any upload happens (per-IP + per-user), separate from
the global daily cap which only gates the expensive job-launch step (jobs.py).
"""

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..deps import get_client_ip, get_current_user
from ..models import Object, Photo, PhotoUploadStatus, User
from ..schemas import PhotoPresignItem, PhotoPresignRequest, PhotoPresignResponse
from ..services.rate_limit import check_and_increment_ip, check_and_increment_user
from ..services.s3 import presign_photo_upload

router = APIRouter(prefix="/api/v1/objects", tags=["uploads"])


@router.post("/{object_id}/photos/presign", response_model=PhotoPresignResponse)
def presign_photos(
    object_id: uuid.UUID,
    body: list[PhotoPresignRequest],
    request_ip: str = Depends(get_client_ip),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PhotoPresignResponse:
    obj = db.query(Object).filter(Object.id == object_id, Object.user_id == user.id).one_or_none()
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Object not found")

    # Both checks before any S3 URL is issued — the actual multi-account
    # defense (per-IP) plus the per-user quota, per plan §5.
    check_and_increment_ip(db, request_ip, settings.rate_limit_ip_per_hour)
    check_and_increment_user(db, str(user.id), settings.rate_limit_user_per_day)

    items: list[PhotoPresignItem] = []
    for item in body:
        photo_id = uuid.uuid4()
        extension = Path(item.filename).suffix or ".jpg"
        s3_key, presigned_url = presign_photo_upload(str(object_id), str(photo_id), extension, item.content_type)

        photo = Photo(
            id=photo_id,
            object_id=object_id,
            s3_key=s3_key,
            original_filename=item.filename,
            content_type=item.content_type,
            upload_status=PhotoUploadStatus.pending,
        )
        db.add(photo)
        items.append(PhotoPresignItem(photo_id=photo_id, presigned_put_url=presigned_url, s3_key=s3_key))

    db.commit()
    return PhotoPresignResponse(photos=items)


@router.post("/{object_id}/photos/{photo_id}/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_photo(
    object_id: uuid.UUID,
    photo_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    photo = (
        db.query(Photo)
        .join(Object)
        .filter(Photo.id == photo_id, Photo.object_id == object_id, Object.user_id == user.id)
        .one_or_none()
    )
    if photo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Photo not found")

    photo.upload_status = PhotoUploadStatus.uploaded
    db.commit()
