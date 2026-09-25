"""The crop-box test worker/pipeline/export.py applies to the trained Gaussians. It needs numpy only, not torch."""

import numpy as np

from .colmap_model import qvec_to_rotmat
from .config import CropBox


def inside_crop_box(points: np.ndarray, box: CropBox) -> np.ndarray:
    """A boolean mask over points, shape (N, 3), true for each point inside the box or on its surface."""
    x, y, z, w = box.quaternion
    # R carries the box's own axes into the world, so its transpose carries world offsets back onto them. Row vectors
    # times R apply that transpose.
    rotation = qvec_to_rotmat(np.array([w, x, y, z]) / np.linalg.norm([w, x, y, z]))
    local = (points - np.asarray(box.center)) @ rotation
    return np.all(np.abs(local) <= np.asarray(box.size) / 2, axis=1)
