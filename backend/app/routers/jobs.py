"""Job trigger + status. /process is where the global daily cap is checked
(plan §5) — separate from uploads.py's per-IP/per-user checks, since this
specifically gates the expensive GPU-launch step.
"""

import os
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..db import get_db
from ..deps import get_current_user, get_job_for_callback_token
from ..models import Job, JobStatus, Object, ObjectStatus, PhotoUploadStatus, User
from ..schemas import JobRead, SplatUrlResponse, WorkerStatusUpdate
from ..services.ec2_launcher import generate_callback_token, launch_job
from ..services.rate_limit import check_and_increment_global_daily
from ..services.s3 import presign_splat_download

router = APIRouter(prefix="/api/v1/objects", tags=["jobs"])
internal_router = APIRouter(prefix="/api/v1/internal", tags=["internal"])


@router.post("/{object_id}/process", response_model=JobRead, status_code=status.HTTP_201_CREATED)
def trigger_process(
    object_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Job:
    obj = db.query(Object).filter(Object.id == object_id, Object.user_id == user.id).one_or_none()
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Object not found")

    uploaded_count = sum(1 for p in obj.photos if p.upload_status == PhotoUploadStatus.uploaded)
    if uploaded_count < settings.min_photos_per_object:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Need at least {settings.min_photos_per_object} uploaded photos, have {uploaded_count}",
        )

    # The hard backstop, checked last so per-user/IP limits already screened
    # most abuse before this expensive step is even considered (plan §5).
    check_and_increment_global_daily(db, settings.global_max_jobs_per_day)

    callback_token = generate_callback_token()
    job = Job(object_id=object_id, status=JobStatus.queued, callback_token=callback_token)
    db.add(job)
    obj.status = ObjectStatus.processing
    db.commit()
    db.refresh(job)

    instance_id = launch_job(
        job_id=str(job.id),
        object_id=str(object_id),
        callback_token=callback_token,
        worker_image_uri=_worker_image_uri(),
        ecr_registry=_ecr_registry(),
    )
    job.status = JobStatus.launching
    job.ec2_instance_id = instance_id
    db.commit()
    db.refresh(job)

    return job


@router.get("/{object_id}/jobs/latest", response_model=JobRead)
def get_latest_job(
    object_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    job = (
        db.query(Job)
        .join(Object)
        .filter(Job.object_id == object_id, Object.user_id == user.id)
        .order_by(Job.created_at.desc())
        .first()
    )
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No jobs for this object")
    return job


@router.get("/{object_id}/splat", response_model=SplatUrlResponse)
def get_splat_url(
    object_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SplatUrlResponse:
    obj = db.query(Object).filter(Object.id == object_id, Object.user_id == user.id).one_or_none()
    if obj is None or obj.status != ObjectStatus.complete:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Splat not ready")

    latest_job = (
        db.query(Job)
        .filter(Job.object_id == object_id, Job.status == JobStatus.complete)
        .order_by(Job.created_at.desc())
        .first()
    )
    if latest_job is None or latest_job.result_s3_key is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Splat not ready")

    return SplatUrlResponse(url=presign_splat_download(latest_job.result_s3_key))


@internal_router.patch("/jobs/{job_id}/status", status_code=status.HTTP_204_NO_CONTENT)
def update_job_status(
    body: WorkerStatusUpdate,
    job: Job = Depends(get_job_for_callback_token),
    db: Session = Depends(get_db),
) -> None:
    job.status = body.status
    if body.error_message is not None:
        job.error_message = body.error_message
    if body.result_s3_key is not None:
        job.result_s3_key = body.result_s3_key
    if body.thumbnail_s3_key is not None:
        job.thumbnail_s3_key = body.thumbnail_s3_key
    if body.ec2_instance_id is not None:
        job.ec2_instance_id = body.ec2_instance_id

    now = datetime.now(UTC)
    if body.status == JobStatus.colmap_running and job.colmap_started_at is None:
        job.colmap_started_at = now
    elif body.status == JobStatus.training_running:
        job.colmap_finished_at = job.colmap_finished_at or now
        job.training_started_at = job.training_started_at or now
    elif body.status == JobStatus.uploading_result:
        job.training_finished_at = job.training_finished_at or now

    obj = db.query(Object).filter(Object.id == job.object_id).one()
    if body.status == JobStatus.complete:
        obj.status = ObjectStatus.complete
        if body.thumbnail_s3_key is not None:
            obj.thumbnail_s3_key = body.thumbnail_s3_key
    elif body.status == JobStatus.failed:
        obj.status = ObjectStatus.failed

    db.commit()


def _worker_image_uri() -> str:
    # Populated from the ECR repo CDK stack output once infra is deployed
    # (plan §9) — placeholder for local/pre-deploy development.
    return os.environ.get("WORKER_IMAGE_URI", "REPLACE_WITH_ECR_IMAGE_URI")


def _ecr_registry() -> str:
    return os.environ.get("ECR_REGISTRY", "REPLACE_WITH_ECR_REGISTRY")
