import boto3
import pytest
from moto import mock_aws

from pipeline.fetch import fetch_photos


@mock_aws
def test_fetch_photos_downloads_all_objects_under_prefix(settings):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.uploads_bucket)
    s3.put_object(Bucket=settings.uploads_bucket, Key=f"splats/{settings.splat_id}/photos/a.jpg", Body=b"fake-a")
    s3.put_object(Bucket=settings.uploads_bucket, Key=f"splats/{settings.splat_id}/photos/b.jpg", Body=b"fake-b")
    # A photo belonging to a different splat must not be pulled in.
    s3.put_object(Bucket=settings.uploads_bucket, Key="splats/other-splat/photos/c.jpg", Body=b"fake-c")

    dest_dir = fetch_photos(settings)

    downloaded = sorted(p.name for p in dest_dir.iterdir())
    assert downloaded == ["a.jpg", "b.jpg"]
    assert (dest_dir / "a.jpg").read_bytes() == b"fake-a"


@mock_aws
def test_fetch_photos_raises_when_none_found(settings):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.uploads_bucket)

    with pytest.raises(RuntimeError, match="No photos found"):
        fetch_photos(settings)
