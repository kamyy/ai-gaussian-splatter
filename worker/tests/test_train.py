import numpy as np
import pytest
import torch
from PIL import Image as PILImage

from pipeline.colmap_model import Camera, Image, SparseModel
from pipeline.config import Settings
from pipeline.train import (
    MAX_TRAINING_EDGE,
    GaussianModel,
    _densify_and_prune,
    _load_views,
    _max_gaussians_for_device,
    train,
)


def _make_sparse_model(width: int, height: int) -> SparseModel:
    camera = Camera(camera_id=1, width=width, height=height, fx=1000.0, fy=1000.0, cx=width / 2, cy=height / 2)
    image = Image(
        image_id=1,
        qvec=np.array([1.0, 0.0, 0.0, 0.0]),
        tvec=np.array([0.0, 0.0, 0.0]),
        camera_id=1,
        name="photo.jpg",
    )
    return SparseModel(
        cameras={1: camera},
        images={1: image},
        points_xyz=np.zeros((1, 3), dtype=np.float32),
        points_rgb=np.zeros((1, 3), dtype=np.uint8),
    )


def test_load_views_downscales_photos_above_the_longest_edge_cap(tmp_path):
    """A 12MP phone photo (well above MAX_TRAINING_EDGE) must come back scaled down, with fx/fy/cx/cy scaled by the
    same factor as width/height — otherwise K no longer matches the pixels it projects onto.
    """
    width, height = 4032, 3024
    sparse = _make_sparse_model(width, height)
    PILImage.new("RGB", (width, height)).save(tmp_path / "photo.jpg")

    cameras, _viewmats, images_tensor = _load_views(sparse, tmp_path)

    K, scaled_width, scaled_height = cameras[0]
    assert max(scaled_width, scaled_height) == MAX_TRAINING_EDGE

    scale = MAX_TRAINING_EDGE / max(width, height)
    assert K[0, 0].item() == pytest.approx(1000.0 * scale)
    assert K[1, 1].item() == pytest.approx(1000.0 * scale)
    assert K[0, 2].item() == pytest.approx((width / 2) * scale)
    assert K[1, 2].item() == pytest.approx((height / 2) * scale)
    assert images_tensor[0].shape[:2] == (scaled_height, scaled_width)


def test_load_views_leaves_small_photos_unscaled(tmp_path):
    width, height = 800, 600
    sparse = _make_sparse_model(width, height)
    PILImage.new("RGB", (width, height)).save(tmp_path / "photo.jpg")

    cameras, _viewmats, images_tensor = _load_views(sparse, tmp_path)

    K, scaled_width, scaled_height = cameras[0]
    assert (scaled_width, scaled_height) == (width, height)
    assert K[0, 0].item() == pytest.approx(1000.0)
    assert images_tensor[0].shape[:2] == (height, width)


def _make_settings() -> Settings:
    return Settings(
        job_id="job-1",
        splat_id="splat-1",
        callback_token="tok",
        app_public_url="https://example.test",
        uploads_bucket="uploads",
        splats_bucket="splats",
    )


def _raise_oom(*_args, **_kwargs):
    raise torch.OutOfMemoryError(
        "CUDA out of memory. Tried to allocate 5.74 GiB. GPU 0 has a total capacity of 11.62 GiB..."
    )


def test_train_translates_cuda_oom_into_a_clean_runtime_error(monkeypatch, tmp_path):
    """torch's OutOfMemoryError is a multi-line CUDA allocator dump aimed at a developer. run_job.py reports
    whatever this raises verbatim to the browser (web/components/job/JobStatusPoller.tsx), so it must come out as
    something a user waiting on their splat can actually read.
    """
    sparse = _make_sparse_model(800, 600)
    monkeypatch.setattr("pipeline.train.read_sparse_model", lambda _path: sparse)
    monkeypatch.setattr("pipeline.train._load_views", _raise_oom)

    with pytest.raises(RuntimeError, match="ran out of GPU memory") as exc_info:
        train(tmp_path, tmp_path, _make_settings())

    assert "CUDA out of memory" not in str(exc_info.value)


def _make_gaussian_model(n: int) -> GaussianModel:
    return GaussianModel(
        means=torch.zeros(n, 3, requires_grad=True),
        scales=torch.zeros(n, 3, requires_grad=True),
        quats=torch.zeros(n, 4, requires_grad=True),
        opacities=torch.full((n,), 10.0, requires_grad=True),  # sigmoid(10) ~ 1, safely above the prune threshold
        colors=torch.zeros(n, 3, requires_grad=True),
    )


def test_densify_and_prune_clones_five_percent_when_under_the_cap():
    result = _densify_and_prune(_make_gaussian_model(100), max_points=1000)
    assert len(result.means) == 105


def test_densify_and_prune_stops_cloning_at_the_cap():
    """Already at the cap: pruning still runs (it only ever removes points), but no new points get cloned in."""
    result = _densify_and_prune(_make_gaussian_model(100), max_points=100)
    assert len(result.means) == 100


def test_densify_and_prune_clamps_cloning_to_fit_under_the_cap():
    """5% of 100 would clone 5, but only 3 more fit under the cap."""
    result = _densify_and_prune(_make_gaussian_model(100), max_points=103)
    assert len(result.means) == 103


def test_max_gaussians_for_device_has_no_cap_without_cuda(monkeypatch):
    monkeypatch.setattr("pipeline.train.torch.cuda.is_available", lambda: False)
    assert _max_gaussians_for_device() == 10**9


def test_max_gaussians_for_device_scales_with_total_vram(monkeypatch):
    class FakeDeviceProperties:
        total_memory = 12 * 1024**3  # 12 GiB, a small consumer GPU

    monkeypatch.setattr("pipeline.train.torch.cuda.is_available", lambda: True)
    monkeypatch.setattr("pipeline.train.torch.cuda.get_device_properties", lambda _index: FakeDeviceProperties())

    assert _max_gaussians_for_device() == (12 * 1024**3 // 2) // 2048
