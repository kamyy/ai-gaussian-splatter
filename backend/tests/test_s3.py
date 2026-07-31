import boto3
from moto import mock_aws

from app.services.s3 import object_exists, photo_s3_key, presign_photo_upload, presign_splat_download


def test_photo_s3_key_format():
    key = photo_s3_key("obj-1", "photo-1", ".jpg")
    assert key == "objects/obj-1/photos/photo-1.jpg"


@mock_aws
def test_presign_photo_upload_returns_working_url():
    import os

    bucket = os.environ["UPLOADS_BUCKET"]
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=bucket)

    key, url = presign_photo_upload("obj-1", "photo-1", ".jpg", "image/jpeg")

    assert key == "objects/obj-1/photos/photo-1.jpg"
    assert bucket in url
    assert key in url


@mock_aws
def test_presign_splat_download_returns_working_url():
    import os

    bucket = os.environ["SPLATS_BUCKET"]
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=bucket)

    url = presign_splat_download("objects/obj-1/result.ply")

    assert bucket in url
    assert "objects/obj-1/result.ply" in url


@mock_aws
def test_object_exists_true_and_false():
    import os

    bucket = os.environ["UPLOADS_BUCKET"]
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=bucket)
    s3.put_object(Bucket=bucket, Key="objects/obj-1/photos/a.jpg", Body=b"data")

    assert object_exists(bucket, "objects/obj-1/photos/a.jpg") is True
    assert object_exists(bucket, "objects/obj-1/photos/missing.jpg") is False
