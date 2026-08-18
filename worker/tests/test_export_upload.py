import boto3
from moto import mock_aws

from pipeline.export import upload_result


@mock_aws
def test_upload_result_puts_files_at_expected_keys(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)

    ply_path = tmp_path / "result.ply"
    ply_path.write_bytes(b"fake-ply-data")
    thumbnail_path = tmp_path / "thumbnail.png"
    thumbnail_path.write_bytes(b"fake-png-data")

    result_key, thumbnail_key = upload_result(ply_path, thumbnail_path, settings)

    assert result_key == f"splats/{settings.splat_id}/result.ply"
    assert thumbnail_key == f"splats/{settings.splat_id}/thumbnail.png"

    body = s3.get_object(Bucket=settings.splats_bucket, Key=result_key)["Body"].read()
    assert body == b"fake-ply-data"
