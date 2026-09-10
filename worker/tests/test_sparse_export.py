import boto3
import numpy as np
import pytest
from moto import mock_aws
from plyfile import PlyData

from pipeline.sparse_export import download_sparse_model, export_and_upload_point_cloud, upload_sparse_model


def _write_fake_sparse_model(sparse_dir):
    sparse_dir.mkdir(parents=True, exist_ok=True)
    (sparse_dir / "cameras.bin").write_bytes(b"fake-cameras")
    (sparse_dir / "images.bin").write_bytes(b"fake-images")
    (sparse_dir / "points3D.bin").write_bytes(b"fake-points3d")


@mock_aws
def test_upload_sparse_model_puts_all_three_files_at_deterministic_prefix(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)
    sparse_dir = tmp_path / "sparse" / "0"
    _write_fake_sparse_model(sparse_dir)

    upload_sparse_model(sparse_dir, settings)

    prefix = f"splats/{settings.splat_id}/colmap_sparse/"
    for filename in ("cameras.bin", "images.bin", "points3D.bin"):
        body = s3.get_object(Bucket=settings.splats_bucket, Key=f"{prefix}{filename}")["Body"].read()
        assert body == (sparse_dir / filename).read_bytes()


@mock_aws
def test_download_sparse_model_round_trips_bytes_exactly(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)
    sparse_dir = tmp_path / "sparse" / "0"
    _write_fake_sparse_model(sparse_dir)
    upload_sparse_model(sparse_dir, settings)

    dest_dir = tmp_path / "downloaded"
    result = download_sparse_model(settings, dest_dir)

    assert result == dest_dir
    for filename in ("cameras.bin", "images.bin", "points3D.bin"):
        assert (dest_dir / filename).read_bytes() == (sparse_dir / filename).read_bytes()


@mock_aws
def test_download_sparse_model_raises_naming_missing_files(settings, tmp_path):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)
    # Only upload one of the three expected files.
    s3.put_object(Bucket=settings.splats_bucket, Key=f"splats/{settings.splat_id}/colmap_sparse/cameras.bin", Body=b"x")

    with pytest.raises(RuntimeError, match="images.bin"):
        download_sparse_model(settings, tmp_path / "downloaded")


@mock_aws
def test_export_and_upload_point_cloud_writes_raw_rgb_ply(settings, tmp_path, monkeypatch):
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=settings.splats_bucket)
    sparse_dir = tmp_path / "sparse" / "0"
    sparse_dir.mkdir(parents=True)

    fake_sparse = type(
        "FakeSparseModel",
        (),
        {
            "points_xyz": np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float64),
            "points_rgb": np.array([[10, 20, 30], [40, 50, 60]], dtype=np.uint8),
        },
    )()
    monkeypatch.setattr("pipeline.sparse_export.read_sparse_model", lambda _dir: fake_sparse)

    key = export_and_upload_point_cloud(sparse_dir, settings)

    assert key == f"splats/{settings.splat_id}/point_cloud.ply"
    downloaded_path = tmp_path / "downloaded.ply"
    s3.download_file(settings.splats_bucket, key, str(downloaded_path))
    ply = PlyData.read(str(downloaded_path))
    vertex = ply["vertex"]
    assert len(vertex) == 2
    assert list(vertex["x"]) == [1.0, 4.0]
    assert list(vertex["red"]) == [10, 40]
    assert list(vertex["blue"]) == [30, 60]
