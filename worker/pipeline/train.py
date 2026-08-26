"""3D Gaussian Splatting training via gsplat, at a reduced iteration count for
object-centric captures.

The training loop below has never executed on a GPU. The structure follows
the standard 3DGS algorithm and gsplat's `rasterization()` signature, but no
CUDA kernel here has ever run. Nothing in it is proven; see AGENTS.md.

Simplifications relative to the original paper, made deliberately for a
reduced-iteration, object-centric MVP rather than by oversight:
- Direct RGB colors, not full spherical-harmonics view-dependent color
  (sh_degree=0) — adequate for a mostly-diffuse single-object capture.
- Simplified densification (clone high-position-gradient points + prune
  low-opacity points on a fixed schedule) rather than the paper's full
  clone/split heuristic.
- Camera radial distortion from COLMAP is not undistorted before training
  (see colmap_model.py) — acceptable for SIMPLE_RADIAL's typically small
  phone-camera distortion at this quality bar, not for wide-angle lenses.
"""

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image as PILImage

from .colmap_model import SparseModel, qvec_to_rotmat, read_sparse_model
from .config import Settings

logger = logging.getLogger(__name__)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


@dataclass
class GaussianModel:
    means: torch.Tensor  # (N, 3)
    scales: torch.Tensor  # (N, 3), log-space
    quats: torch.Tensor  # (N, 4)
    opacities: torch.Tensor  # (N,), logit-space
    colors: torch.Tensor  # (N, 3), in [0, 1]


@dataclass
class TrainedScene:
    model: GaussianModel
    canonical_viewmat: torch.Tensor  # (4, 4) — a representative pose, for export.py's thumbnail
    canonical_K: torch.Tensor  # (3, 3)
    canonical_width: int
    canonical_height: int


def train(sfm_sparse_dir: Path, photos_dir: Path, settings: Settings) -> TrainedScene:
    if DEVICE == "cpu":
        logger.warning("No CUDA device available — training will be extremely slow or impractical.")

    sparse = read_sparse_model(sfm_sparse_dir)
    cameras, viewmats, images_tensor = _load_views(sparse, photos_dir)
    model = _init_gaussians(sparse)

    iterations = 20 if settings.fast_test_mode else settings.training_iterations

    # Schedules are fractions of the run, not fixed step counts: at the default 10k these work out to the usual
    # densify-every-1000 / log-every-500 / stop-densifying-500-before-the-end, while a 20-iteration fast-test run still
    # exercises _densify_and_prune instead of never reaching it.
    densify_every = max(1, iterations // 10)
    densify_until = iterations - max(1, iterations // 20)
    log_every = max(1, iterations // 20)

    optimizer = _build_optimizer(model)

    for step in range(iterations):
        idx = np.random.randint(0, len(images_tensor))
        K, width, height = cameras[idx]
        viewmat = viewmats[idx]
        gt_image = images_tensor[idx]

        rendered, alpha, _meta = _render(model, viewmat, K, width, height)
        loss = torch.nn.functional.l1_loss(rendered, gt_image)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        if step % log_every == 0:
            logger.info("iter %d/%d loss=%.4f", step, iterations, loss.item())

        if step > 0 and step % densify_every == 0 and step < densify_until:
            model = _densify_and_prune(model)
            optimizer = _build_optimizer(model)

    canonical_idx = len(images_tensor) // 2
    canonical_K, canonical_width, canonical_height = cameras[canonical_idx]
    return TrainedScene(
        model=model,
        canonical_viewmat=viewmats[canonical_idx],
        canonical_K=canonical_K,
        canonical_width=canonical_width,
        canonical_height=canonical_height,
    )


def render_view(model: GaussianModel, viewmat: torch.Tensor, K: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Public entrypoint for export.py's thumbnail render — reuses the same
    rasterization call as training, just without gradient tracking.
    """
    with torch.no_grad():
        rendered, _alpha, _meta = _render(model, viewmat, K, width, height)
    return rendered


def _load_views(sparse: SparseModel, photos_dir: Path):
    cameras: list[tuple[torch.Tensor, int, int]] = []
    viewmats: list[torch.Tensor] = []
    images_tensor: list[torch.Tensor] = []

    for image in sparse.images.values():
        camera = sparse.cameras[image.camera_id]
        K = torch.tensor(
            [[camera.fx, 0, camera.cx], [0, camera.fy, camera.cy], [0, 0, 1]],
            dtype=torch.float32,
            device=DEVICE,
        )

        R = qvec_to_rotmat(image.qvec)
        t = image.tvec
        viewmat = np.eye(4, dtype=np.float32)
        viewmat[:3, :3] = R
        viewmat[:3, 3] = t
        viewmats.append(torch.tensor(viewmat, device=DEVICE))

        img_path = photos_dir / image.name
        pil_img = PILImage.open(img_path).convert("RGB").resize((camera.width, camera.height))
        img_tensor = torch.tensor(np.array(pil_img), dtype=torch.float32, device=DEVICE) / 255.0
        images_tensor.append(img_tensor)

        cameras.append((K, camera.width, camera.height))

    if not images_tensor:
        raise RuntimeError("No registered images with matching photo files found for training")

    return cameras, viewmats, images_tensor


def _init_gaussians(sparse: SparseModel) -> GaussianModel:
    n = len(sparse.points_xyz)
    if n == 0:
        raise RuntimeError("COLMAP produced an empty sparse point cloud — cannot initialize Gaussians")

    means = torch.tensor(sparse.points_xyz, dtype=torch.float32, device=DEVICE, requires_grad=True)

    # Initial scale: a small fraction of the scene's bounding-box diagonal, uniform across points — the densification
    # loop refines this over training rather than relying on a precise per-point KNN estimate.
    extent = float(np.linalg.norm(sparse.points_xyz.max(axis=0) - sparse.points_xyz.min(axis=0)))
    init_scale = max(extent * 0.01, 1e-4)
    scales = torch.full((n, 3), np.log(init_scale), dtype=torch.float32, device=DEVICE, requires_grad=True)

    quats = torch.zeros((n, 4), dtype=torch.float32, device=DEVICE)
    quats[:, 0] = 1.0
    quats.requires_grad_(True)

    opacities = torch.full((n,), _logit(0.1), dtype=torch.float32, device=DEVICE, requires_grad=True)

    colors = torch.tensor(
        sparse.points_rgb.astype(np.float32) / 255.0, dtype=torch.float32, device=DEVICE, requires_grad=True
    )

    return GaussianModel(means=means, scales=scales, quats=quats, opacities=opacities, colors=colors)


def _build_optimizer(model: GaussianModel) -> torch.optim.Optimizer:
    return torch.optim.Adam(
        [
            {"params": [model.means], "lr": 1.6e-4},
            {"params": [model.scales], "lr": 5e-3},
            {"params": [model.quats], "lr": 1e-3},
            {"params": [model.opacities], "lr": 5e-2},
            {"params": [model.colors], "lr": 2.5e-3},
        ]
    )


def _render(model: GaussianModel, viewmat: torch.Tensor, K: torch.Tensor, width: int, height: int):
    """Returns (rendered_image, alpha, meta) for the single camera passed in.
    gsplat.rasterization is batched over cameras, so we slice batch index 0
    out of the image and alpha before returning them. Meta is returned as-is,
    since neither caller currently uses it.
    """
    import gsplat  # imported lazily so the rest of the module is importable/testable without CUDA/gsplat installed

    renders, alphas, meta = gsplat.rasterization(
        means=model.means,
        quats=model.quats / model.quats.norm(dim=-1, keepdim=True),
        scales=torch.exp(model.scales),
        opacities=torch.sigmoid(model.opacities),
        colors=torch.sigmoid(model.colors),
        viewmats=viewmat[None],
        Ks=K[None],
        width=width,
        height=height,
    )
    return renders[0], alphas[0], meta


def _densify_and_prune(model: GaussianModel, opacity_prune_threshold: float = 0.005) -> GaussianModel:
    """Simplified densification (see module docstring): clone the top 5% of
    points by position-gradient magnitude, and prune points whose opacity
    has decayed below threshold.
    """
    with torch.no_grad():
        grad_norm = model.means.grad.norm(dim=-1) if model.means.grad is not None else torch.zeros(len(model.means))
        keep = torch.sigmoid(model.opacities) > opacity_prune_threshold

        n_clone = max(1, int(0.05 * keep.sum().item()))
        clone_idx = torch.topk(grad_norm * keep, n_clone).indices

        def _cat(t: torch.Tensor, idx: torch.Tensor) -> torch.Tensor:
            kept = t[keep]
            cloned = t[idx] + (torch.randn_like(t[idx]) * 1e-3 if t.dim() > 1 else 0)
            return torch.cat([kept, cloned], dim=0).detach().requires_grad_(True)

        return GaussianModel(
            means=_cat(model.means, clone_idx),
            scales=_cat(model.scales, clone_idx),
            quats=_cat(model.quats, clone_idx),
            opacities=_cat(model.opacities, clone_idx),
            colors=_cat(model.colors, clone_idx),
        )


def _logit(p: float) -> float:
    return float(np.log(p / (1 - p)))
