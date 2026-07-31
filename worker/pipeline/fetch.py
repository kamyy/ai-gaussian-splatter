"""Download a job's uploaded photos from S3 (plan §4 step 3)."""

from pathlib import Path

import boto3

from .config import Settings


def fetch_photos(settings: Settings) -> Path:
    """Download objects/{object_id}/photos/* into local_workdir/photos and return
    that directory. Raises if no photos are found — the caller (run_job.py)
    treats that as a job failure, not a silent no-op.
    """
    s3 = boto3.client("s3")
    prefix = f"objects/{settings.object_id}/photos/"
    dest_dir = Path(settings.local_workdir) / "photos"
    dest_dir.mkdir(parents=True, exist_ok=True)

    paginator = s3.get_paginator("list_objects_v2")
    downloaded = 0
    for page in paginator.paginate(Bucket=settings.uploads_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            filename = key.rsplit("/", 1)[-1]
            if not filename:
                continue
            s3.download_file(settings.uploads_bucket, key, str(dest_dir / filename))
            downloaded += 1

    if downloaded == 0:
        raise RuntimeError(
            f"No photos found at s3://{settings.uploads_bucket}/{prefix} for object {settings.object_id}"
        )

    return dest_dir
