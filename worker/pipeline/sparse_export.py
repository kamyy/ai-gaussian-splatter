"""Persists the COLMAP reconstruct phase's output across the pause before training:
the raw sparse model (so a later, separate EC2 instance can resume training without
re-running COLMAP), plus a viewer-facing point-cloud .ply and camera poses (so the browser
can show both while the user decides whether to proceed).
"""

import json
from pathlib import Path

import boto3
import numpy as np
from botocore.exceptions import ClientError
from plyfile import PlyData, PlyElement

from .colmap_model import qvec_to_rotmat, read_sparse_model
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
    uploads it to s3://{splats_bucket}/splats/{splat_id}/point_cloud.ply.

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

    ply_path = Path(settings.local_workdir) / "point_cloud.ply"
    PlyData([PlyElement.describe(vertex, "vertex")], text=False).write(str(ply_path))

    s3 = boto3.client("s3")
    key = f"splats/{settings.splat_id}/point_cloud.ply"
    s3.upload_file(str(ply_path), settings.splats_bucket, key)
    return key


def _cameras_key(settings: Settings) -> str:
    # Deterministic from splat_id alone, like _sparse_model_prefix(), so the web app's cameras route can find it with
    # no key threaded through the status callback.
    return f"splats/{settings.splat_id}/cameras.json"


def export_and_upload_cameras(sfm_sparse_dir: Path, settings: Settings) -> None:
    """Uploads where each registered photo was taken from, in the point cloud's own coordinate frame.

    One entry per registered image: its photo filename, the camera center in world space, COLMAP's world-to-camera
    rotation as three rows, and its camera's image size and focal lengths in pixels. A photo COLMAP couldn't place has
    no entry, which is how the browser flags it.
    """
    sparse = read_sparse_model(sfm_sparse_dir)

    cameras = []
    for image in sparse.images.values():
        rotation = qvec_to_rotmat(image.qvec)
        center = -rotation.T @ image.tvec
        camera = sparse.cameras[image.camera_id]
        cameras.append(
            {
                "name": image.name,
                "center": center.tolist(),
                "rotation": rotation.tolist(),
                "width": camera.width,
                "height": camera.height,
                "fx": camera.fx,
                "fy": camera.fy,
            }
        )

    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=settings.splats_bucket,
        Key=_cameras_key(settings),
        Body=json.dumps({"cameras": cameras}).encode(),
        ContentType="application/json",
    )
