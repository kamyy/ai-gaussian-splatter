import numpy as np
import pytest
import torch
from PIL import Image as PILImage

from pipeline.colmap_model import Camera, Image, SparseModel
from pipeline.config import Settings
from pipeline.train import (
    MAX_TRAINING_EDGE,
    MIN_INIT_SCALE,
    _build_strategy,
    _init_gaussians,
    _load_views,
    _max_gaussians_for_device,
    _nearest_neighbour_scales,
    _scene_scale,
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
    same factor as width/height. Otherwise K no longer matches the pixels it projects onto.
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
    """torch's OutOfMemoryError is a multi-line CUDA allocator dump aimed at a developer. worker/run_job.py reports
    whatever this raises verbatim to the browser (web/components/splats/StageCard.tsx), so it must come out as
    something a user waiting on their splat can actually read.
    """
    sparse = _make_sparse_model(800, 600)
    monkeypatch.setattr("pipeline.train.read_sparse_model", lambda _path: sparse)
    monkeypatch.setattr("pipeline.train._load_views", _raise_oom)

    with pytest.raises(RuntimeError, match="ran out of GPU memory") as exc_info:
        train(tmp_path, tmp_path, _make_settings())

    assert "CUDA out of memory" not in str(exc_info.value)


def test_build_strategy_refines_within_a_fast_test_run():
    """A 20-iteration smoke test must still reach the strategy's refine steps, or it stops covering densification."""
    strategy = _build_strategy(20)
    refine_steps = [
        step
        for step in range(20)
        if strategy.refine_start_iter < step < strategy.refine_stop_iter and step % strategy.refine_every == 0
    ]
    assert refine_steps


def test_build_strategy_keeps_the_reference_proportions_at_10k():
    strategy = _build_strategy(10_000)
    assert (strategy.refine_start_iter, strategy.refine_every, strategy.refine_stop_iter) == (166, 33, 5000)


def test_scene_scale_is_the_farthest_camera_from_the_cameras_centre():
    def viewmat_at(centre: list[float]) -> torch.Tensor:
        viewmat = torch.eye(4)
        viewmat[:3, 3] = -torch.tensor(centre)  # identity rotation, so t = -centre
        return viewmat

    scale = _scene_scale([viewmat_at([-1.0, 0.0, 0.0]), viewmat_at([1.0, 0.0, 0.0]), viewmat_at([0.0, 3.0, 0.0])])

    # The cameras' mean is (0, 1, 0), and the farthest camera from it is the one at (0, 3, 0).
    assert scale == pytest.approx(1.1 * 2.0)


def test_max_gaussians_for_device_has_no_cap_without_cuda(monkeypatch):
    monkeypatch.setattr("pipeline.train.torch.cuda.is_available", lambda: False)
    assert _max_gaussians_for_device() == 10**9


def test_max_gaussians_for_device_scales_with_free_vram(monkeypatch):
    free_bytes = 8 * 1024**3  # 8 GiB free out of a 12 GiB card already holding loaded images/model state

    monkeypatch.setattr("pipeline.train.torch.cuda.is_available", lambda: True)
    monkeypatch.setattr("pipeline.train.torch.cuda.mem_get_info", lambda: (free_bytes, 12 * 1024**3))

    assert _max_gaussians_for_device() == (free_bytes // 2) // 2048


def test_nearest_neighbour_scales_ignore_a_distant_outlier():
    """A stray point far from the subject must not inflate the Gaussians around the subject, which a scene-wide
    extent did.
    """
    grid = torch.tensor([[x, y, 0.0] for x in range(4) for y in range(4)])
    outlier = torch.tensor([[1000.0, 0.0, 0.0]])

    scales = _nearest_neighbour_scales(torch.cat([grid, outlier]))

    assert scales[:16] == pytest.approx(_nearest_neighbour_scales(grid).tolist())
    assert scales[:16].max().item() < 2.0


def test_nearest_neighbour_scales_floor_a_single_point():
    scales = _nearest_neighbour_scales(torch.zeros(1, 3))
    assert scales.tolist() == pytest.approx([MIN_INIT_SCALE])


def test_init_gaussians_renders_colmap_colors_unchanged():
    """_render applies a sigmoid to colors, so the initial colors must be stored so that the sigmoid returns
    COLMAP's RGB.
    """
    sparse = _make_sparse_model(800, 600)
    sparse.points_xyz = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    sparse.points_rgb = np.array([[255, 128, 0], [10, 20, 30]], dtype=np.uint8)

    model = _init_gaussians(sparse)

    rendered = torch.sigmoid(model.colors).detach().cpu().numpy() * 255
    assert rendered == pytest.approx(sparse.points_rgb.astype(np.float32), abs=0.5)
