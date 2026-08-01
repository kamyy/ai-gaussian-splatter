"""Parser for COLMAP's binary sparse reconstruction format (cameras.bin,
images.bin, points3D.bin) — layout per COLMAP's own read_write_model.py
reference. Used to feed camera poses + the initial point cloud into
train.py without needing pycolmap as a dependency.
"""

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# model_id -> (name, num_params). Only the common models COLMAP's
# feature_extractor actually produces are handled; params beyond
# focal length + principal point (e.g. radial distortion) are read but
# not applied — a known MVP simplification (see train.py docstring).
_CAMERA_MODELS = {
    0: ("SIMPLE_PINHOLE", 3),
    1: ("PINHOLE", 4),
    2: ("SIMPLE_RADIAL", 4),
    3: ("RADIAL", 5),
}


@dataclass
class Camera:
    camera_id: int
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float


@dataclass
class Image:
    image_id: int
    qvec: np.ndarray  # (4,) w, x, y, z
    tvec: np.ndarray  # (3,)
    camera_id: int
    name: str


@dataclass
class SparseModel:
    cameras: dict[int, Camera]
    images: dict[int, Image]
    points_xyz: np.ndarray  # (N, 3)
    points_rgb: np.ndarray  # (N, 3) uint8


def qvec_to_rotmat(qvec: np.ndarray) -> np.ndarray:
    w, x, y, z = qvec
    return np.array(
        [
            [1 - 2 * y**2 - 2 * z**2, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x**2 - 2 * z**2, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x**2 - 2 * y**2],
        ]
    )


def read_sparse_model(model_dir: Path) -> SparseModel:
    points_xyz, points_rgb = _read_points3d(model_dir / "points3D.bin")
    return SparseModel(
        cameras=_read_cameras(model_dir / "cameras.bin"),
        images=_read_images(model_dir / "images.bin"),
        points_xyz=points_xyz,
        points_rgb=points_rgb,
    )


def _read_cameras(path: Path) -> dict[int, Camera]:
    cameras: dict[int, Camera] = {}
    with open(path, "rb") as f:
        (num_cameras,) = struct.unpack("<Q", f.read(8))
        for _ in range(num_cameras):
            camera_id, model_id, width, height = struct.unpack("<iiQQ", f.read(24))
            _, num_params = _CAMERA_MODELS[model_id]
            params = struct.unpack(f"<{num_params}d", f.read(8 * num_params))
            fx = params[0]
            fy = params[1] if num_params >= 4 and model_id == 1 else fx
            cx = params[1] if model_id in (0, 2, 3) else params[2]
            cy = params[2] if model_id in (0, 2, 3) else params[3]
            cameras[camera_id] = Camera(camera_id, width, height, fx, fy, cx, cy)
    return cameras


def _read_images(path: Path) -> dict[int, Image]:
    images: dict[int, Image] = {}
    with open(path, "rb") as f:
        (num_images,) = struct.unpack("<Q", f.read(8))
        for _ in range(num_images):
            image_id = struct.unpack("<i", f.read(4))[0]
            qvec = np.array(struct.unpack("<4d", f.read(32)))
            tvec = np.array(struct.unpack("<3d", f.read(24)))
            camera_id = struct.unpack("<i", f.read(4))[0]
            name = _read_cstring(f)
            (num_points2d,) = struct.unpack("<Q", f.read(8))
            f.read(24 * num_points2d)  # x, y, point3D_id per 2D point — unused here
            images[image_id] = Image(image_id, qvec, tvec, camera_id, name)
    return images


def _read_points3d(path: Path) -> tuple[np.ndarray, np.ndarray]:
    xyz_list: list[tuple[float, float, float]] = []
    rgb_list: list[tuple[int, int, int]] = []
    with open(path, "rb") as f:
        (num_points,) = struct.unpack("<Q", f.read(8))
        for _ in range(num_points):
            f.read(8)  # point3D_id
            xyz = struct.unpack("<3d", f.read(24))
            rgb = struct.unpack("<3B", f.read(3))
            f.read(8)  # error
            (track_length,) = struct.unpack("<Q", f.read(8))
            f.read(8 * track_length)  # image_id, point2D_idx per track entry — unused
            xyz_list.append(xyz)
            rgb_list.append(rgb)
    return np.array(xyz_list, dtype=np.float64), np.array(rgb_list, dtype=np.uint8)


def _read_cstring(f) -> str:
    chars = bytearray()
    while (c := f.read(1)) != b"\x00":
        chars += c
    return chars.decode("utf-8")
