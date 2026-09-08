"""Persists the COLMAP reconstruct phase's output across the pause before training:
the raw sparse model (so a later, separate EC2 instance can resume training without
re-running COLMAP) and a viewer-facing point-cloud .ply (so the browser can show it
while the user decides whether to proceed).
"""

from pathlib import Path

import boto3
import numpy as np
from botocore.exceptions import ClientError
from plyfile import PlyData, PlyElement

from .colmap_model import read_sparse_model
from .config import Settings

_SPARSE_MODEL_FILES = ("cameras.bin", "images.bin", "points3D.bin")


def _sparse_model_prefix(settings: Settings) -> str:
    # Deterministic from splat_id alone, like fetch.fetch_photos()'s photo prefix, so the train phase's fresh
    # instance can find it with no key threaded through the status callback.
    return f"splats/{settings.splat_id}/colmap_sparse/"


def upload_sparse_model(sparse_dir: Path, settings: Settings) -> None:
    """Uploads cameras.bin/images.bin/points3D.bin so a later train-phase instance can
    download them back down instead of re-running COLMAP.
    """
    s3 = boto3.client("s3")
    prefix = _sparse_model_prefix(settings)
    for filename in _SPARSE_MODEL_FILES:
        s3.upload_file(str(sparse_dir / filename), settings.splats_bucket, f"{prefix}{filename}")


def download_sparse_model(settings: Settings, dest_dir: Path) -> Path:
    """Downloads cameras.bin/images.bin/points3D.bin into dest_dir and returns it.

    Raises RuntimeError naming any missing file rather than letting colmap_model.read_sparse_model fail later with an
    opaque FileNotFoundError/struct error.
    """
    s3 = boto3.client("s3")
    prefix = _sparse_model_prefix(settings)
    dest_dir.mkdir(parents=True, exist_ok=True)

    missing: list[str] = []
    for filename in _SPARSE_MODEL_FILES:
        key = f"{prefix}{filename}"
        try:
            s3.download_file(settings.splats_bucket, key, str(dest_dir / filename))
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey"):
                missing.append(key)
            else:
                raise

    if missing:
        raise RuntimeError(f"Missing COLMAP sparse model file(s) in s3://{settings.splats_bucket}: {missing}")

    return dest_dir


def export_and_upload_point_cloud(sfm_sparse_dir: Path, settings: Settings) -> str:
    """Writes the COLMAP sparse point cloud as a plain x/y/z/red/green/blue .ply and
    uploads it to s3://{splats_bucket}/splats/{splat_id}/colmap_point_cloud.ply.

    Unlike worker/pipeline/export.py's result.ply, colors here are already 0-255 RGB straight from COLMAP — no
    spherical-harmonics DC-term encoding to apply, since this isn't a trained Gaussian.
    """
    sparse = read_sparse_model(sfm_sparse_dir)

    dtype = [("x", "f4"), ("y", "f4"), ("z", "f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")]
    vertex = np.zeros(sparse.points_xyz.shape[0], dtype=dtype)
    vertex["x"], vertex["y"], vertex["z"] = sparse.points_xyz[:, 0], sparse.points_xyz[:, 1], sparse.points_xyz[:, 2]
    vertex["red"], vertex["green"], vertex["blue"] = (
        sparse.points_rgb[:, 0],
        sparse.points_rgb[:, 1],
        sparse.points_rgb[:, 2],
    )

    ply_path = Path(settings.local_workdir) / "colmap_point_cloud.ply"
    PlyData([PlyElement.describe(vertex, "vertex")], text=False).write(str(ply_path))

    s3 = boto3.client("s3")
    key = f"splats/{settings.splat_id}/colmap_point_cloud.ply"
    s3.upload_file(str(ply_path), settings.splats_bucket, key)
    return key
