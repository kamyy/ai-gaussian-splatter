"""Presigned S3 URLs (plan §4 step 1) — uploads always go through the
backend so the rate limit is enforced before any bytes hit S3.
"""

import boto3
from botocore.exceptions import ClientError

from ..config import get_settings

_PRESIGN_EXPIRY_SECONDS = 15 * 60


def photo_s3_key(object_id: str, photo_id: str, extension: str) -> str:
    return f"objects/{object_id}/photos/{photo_id}{extension}"


def presign_photo_upload(object_id: str, photo_id: str, extension: str, content_type: str) -> tuple[str, str]:
    """Returns (s3_key, presigned_put_url)."""
    settings = get_settings()
    key = photo_s3_key(object_id, photo_id, extension)
    client = boto3.client("s3", region_name=settings.aws_region)
    url = client.generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.uploads_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=_PRESIGN_EXPIRY_SECONDS,
    )
    return key, url


def presign_splat_download(splats_bucket_key: str) -> str:
    settings = get_settings()
    client = boto3.client("s3", region_name=settings.aws_region)
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.splats_bucket, "Key": splats_bucket_key},
        ExpiresIn=_PRESIGN_EXPIRY_SECONDS,
    )


def object_exists(bucket: str, key: str) -> bool:
    settings = get_settings()
    client = boto3.client("s3", region_name=settings.aws_region)
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("404", "NoSuchKey"):
            return False
        raise
