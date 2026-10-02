"""3D Gaussian Splatting training via gsplat, at a reduced iteration count for object-centric captures.

Simplifications relative to the original paper, made deliberately for a reduced-iteration, object-centric MVP rather
than by oversight:
- Densification is gsplat's DefaultStrategy with its schedule scaled down from 30k iterations to the run's length (see
  _build_strategy).
- Camera radial distortion from COLMAP is not undistorted before training (see worker/pipeline/colmap_model.py). That
  is acceptable for SIMPLE_RADIAL's typically small phone-camera distortion at this quality bar, not for wide-angle
  lenses.
"""

import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image as PILImage

from .colmap_model import SparseModel, qvec_to_rotmat, read_sparse_model
from .config import Settings
from .status import report_status

logger = logging.getLogger(__name__)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# COLMAP downsamples for feature detection only and keeps camera intrinsics in the original photo's pixel dimensions.
# Training at that resolution makes every ground-truth image resident in VRAM at full size, which OOMs a consumer GPU
# well before a modest photo count. 1600px matches the reference 3DGS implementation's longest-edge target.
MAX_TRAINING_EDGE = 1600

# Each initial Gaussian is sized from the RMS distance to this many of its nearest COLMAP points, as in the reference
# 3DGS implementation. A per-point distance keeps a few stray background points from inflating every Gaussian, which a
# scene-wide extent does not.
INIT_SCALE_NEIGHBOURS = 3
MIN_INIT_SCALE = 1e-4

# Spherical harmonics (SH) let a Gaussian's color change with the viewing direction, which is what makes a highlight
# move across a glossy surface as the camera orbits. Degree 3 is the reference 3DGS implementation's, and the highest
# the viewer renders.
SH_DEGREE = 3
# The constant that turns an RGB value in [0, 1] into the degree-0 (DC) SH coefficient and back: rgb = SH_C0 * dc + 0.5.
SH_C0 = 0.28209479177387814

# With Settings.eval_holdout set, every 8th registered photo is held back from training and scored afterwards, as the
# reference 3DGS evaluation does.
EVAL_HOLDOUT_EVERY = 8

# SSIM (structural similarity) compares local brightness, contrast, and structure over a sliding Gaussian window rather
# than pixel by pixel. These are the reference implementation's window and stabilizing constants.
SSIM_WINDOW = 11
SSIM_SIGMA = 1.5
SSIM_C1 = 0.01**2
SSIM_C2 = 0.03**2

# Gaussian positions learn at this rate times the scene scale, as in the reference 3DGS implementation. Scaling by the
# scene makes a step move a Gaussian the same fraction of the object whatever units COLMAP reconstructed it in.
MEANS_LR = 1.6e-4
# The positions' rate decays exponentially to this fraction of MEANS_LR by the last step. Without the decay, positions
# keep jittering around their best spot until training ends, and the render comes out soft.
MEANS_LR_FINAL_FRACTION = 0.01


@dataclass
class GaussianModel:
    means: torch.Tensor  # (N, 3)
    scales: torch.Tensor  # (N, 3), log-space
    quats: torch.Tensor  # (N, 4)
    opacities: torch.Tensor  # (N,), logit-space
    sh0: torch.Tensor  # (N, 1, 3), the degree-0 SH coefficient per color channel
    shN: torch.Tensor  # (N, (SH_DEGREE + 1) ** 2 - 1, 3), the higher-degree coefficients


@dataclass
class TrainedScene:
    model: GaussianModel
    canonical_viewmat: torch.Tensor  # (4, 4) — a representative pose, for worker/pipeline/export.py's thumbnail
    canonical_K: torch.Tensor  # (3, 3)
    canonical_width: int
    canonical_height: int


def train(
    sfm_sparse_dir: Path, photos_dir: Path, settings: Settings, sparse: SparseModel | None = None
) -> TrainedScene:
    """sparse is an optional pre-parsed model, for callers (worker/run_job.py's train phase) that already read the
    same sfm_sparse_dir for their own purposes and would otherwise parse cameras.bin/images.bin/points3D.bin twice.
    """
    if DEVICE == "cpu":
        logger.warning("No CUDA device available — training will be extremely slow or impractical.")

    if sparse is None:
        sparse = read_sparse_model(sfm_sparse_dir)

    # Translated into a plain RuntimeError so worker/run_job.py's generic handler reports it as-is to the browser
    # (see web/components/splats/StageCard.tsx). torch's own OutOfMemoryError message is a multi-line CUDA
    # allocator dump aimed at a developer, not something to show a user waiting on their splat.
    try:
        model, cameras, viewmats, images_tensor = _train_loop(sparse, photos_dir, settings)
    except torch.OutOfMemoryError as exc:
        raise RuntimeError(
            f"Training ran out of GPU memory with {len(sparse.images)} registered photos. Try a smaller photo set, "
            "or a GPU with more VRAM."
        ) from exc

    canonical_idx = len(images_tensor) // 2
    canonical_K, canonical_width, canonical_height = cameras[canonical_idx]
    return TrainedScene(
        model=model,
        canonical_viewmat=viewmats[canonical_idx],
        canonical_K=canonical_K,
        canonical_width=canonical_width,
        canonical_height=canonical_height,
    )


def _train_loop(sparse: SparseModel, photos_dir: Path, settings: Settings):
    """Everything train() wraps in a single OutOfMemoryError handler, factored out so that handler wraps one call
    instead of re-indenting this whole body.
    """
    cameras, viewmats, images_tensor = _load_views(sparse, photos_dir)
    train_indices, eval_indices = _split_views(len(images_tensor), settings.eval_holdout)
    if settings.eval_holdout:
        np.random.seed(0)
        torch.manual_seed(0)
    # gsplat's strategy replaces entries of this dict as it clones, splits, and prunes, carrying each optimizer's
    # state across. So nothing may hold on to an individual parameter between steps.
    params = {name: torch.nn.Parameter(tensor.detach()) for name, tensor in vars(_init_gaussians(sparse)).items()}
    scene_scale = _scene_scale(viewmats)
    optimizers = _build_optimizers(params, scene_scale)

    iterations = settings.training_iterations
    log_every = max(1, iterations // 20)
    means_lr_decay = torch.optim.lr_scheduler.ExponentialLR(
        optimizers["means"], gamma=MEANS_LR_FINAL_FRACTION ** (1 / iterations)
    )

    from gsplat.strategy.ops import reset_opa  # imported lazily for the same reason as in _render

    strategy = _build_strategy(iterations)
    strategy.check_sanity(params, optimizers)
    strategy_state = strategy.initialize_state(scene_scale=scene_scale)
    max_points = _max_gaussians_for_device()

    started = time.monotonic()
    for step in range(iterations):
        idx = train_indices[np.random.randint(0, len(train_indices))]
        K, width, height = cameras[idx]
        viewmat = viewmats[idx]
        gt_image = images_tensor[idx]

        sh_degree = _sh_degree_at(step, iterations)
        rendered, _alpha, meta = _render(GaussianModel(**params), viewmat, K, width, height, sh_degree)
        strategy.step_pre_backward(params, optimizers, strategy_state, step, meta)
        loss = torch.nn.functional.l1_loss(rendered, gt_image)
        loss.backward()
        for optimizer in optimizers.values():
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
        means_lr_decay.step()

        if len(params["means"]) >= max_points:
            # No gradient exceeds infinity, so this stops growth while pruning carries on.
            strategy.grow_grad2d = float("inf")
        strategy.step_post_backward(params, optimizers, strategy_state, step, meta, packed=True)
        if _is_opacity_reset_step(step, iterations, strategy.refine_stop_iter):
            reset_opa(params, optimizers, strategy_state, value=strategy.prune_opa * 2.0)
        if len(params["means"]) == 0:
            raise RuntimeError("Every Gaussian's opacity decayed below the prune threshold; the model has collapsed")

        if step % log_every == 0:
            logger.info("iter %d/%d loss=%.4f gaussians=%d", step, iterations, loss.item(), len(params["means"]))
            # On the log schedule, 20 callbacks a run, for the progress bar on the splat's page. report_status never
            # raises, so an unreachable web app costs its timeout here and nothing more.
            report_status(settings, "training_running", training_progress=step * 100 // iterations)

    logger.info("Trained %d iterations in %.0fs", iterations, time.monotonic() - started)
    model = GaussianModel(**params)
    if eval_indices:
        _evaluate(model, cameras, viewmats, images_tensor, eval_indices, Path(settings.local_workdir) / "eval")
    return model, cameras, viewmats, images_tensor


def _split_views(count: int, eval_holdout: bool) -> tuple[list[int], list[int]]:
    """(train_indices, eval_indices) over the loaded views. Without eval_holdout every view trains."""
    if not eval_holdout:
        return list(range(count)), []
    eval_indices = list(range(0, count, EVAL_HOLDOUT_EVERY))
    train_indices = [i for i in range(count) if i % EVAL_HOLDOUT_EVERY != 0]
    if not train_indices:
        raise RuntimeError(f"Holding out every {EVAL_HOLDOUT_EVERY}th photo leaves none of {count} to train on")
    return train_indices, eval_indices


def _evaluate(model: GaussianModel, cameras, viewmats, images_tensor, eval_indices: list[int], out_dir: Path) -> None:
    """Logs mean PSNR and SSIM over the held-out views. It also writes a ground-truth-beside-render PNG per view to
    out_dir, which is worker/jobdir/eval/ on the host, for looking at what the numbers miss.

    PSNR (peak signal-to-noise ratio) is in decibels and higher is better. It rewards matching exact pixel values.
    SSIM runs from 0 to 1 and rewards matching local structure, such as edges and texture.
    """
    # Emptied first, so a splat with fewer views doesn't leave an earlier splat's extra renders beside its own.
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    psnrs, ssims = [], []
    for idx in eval_indices:
        K, width, height = cameras[idx]
        rendered = render_view(model, viewmats[idx], K, width, height).clamp(0, 1)
        gt_image = images_tensor[idx]
        psnrs.append(_psnr(rendered, gt_image))
        ssims.append(_ssim(rendered, gt_image).item())
        side_by_side = (torch.cat([gt_image, rendered], dim=1) * 255).byte().cpu().numpy()
        PILImage.fromarray(side_by_side).save(out_dir / f"view-{idx:03d}.png")
    logger.info(
        "Held-out eval over %d views: PSNR=%.2f dB SSIM=%.4f (side-by-sides in %s)",
        len(eval_indices),
        float(np.mean(psnrs)),
        float(np.mean(ssims)),
        out_dir,
    )


def _psnr(a: torch.Tensor, b: torch.Tensor) -> float:
    return -10 * torch.log10(torch.nn.functional.mse_loss(a, b)).item()


def _ssim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Mean SSIM between two (H, W, 3) images in [0, 1], as a scalar tensor."""
    coords = torch.arange(SSIM_WINDOW, dtype=a.dtype, device=a.device) - SSIM_WINDOW // 2
    gauss = torch.exp(-(coords**2) / (2 * SSIM_SIGMA**2))
    gauss = gauss / gauss.sum()

    x = a.permute(2, 0, 1)
    y = b.permute(2, 0, 1)
    # All five maps SSIM blurs are stacked as one batch of single-channel images. The 2D Gaussian window is applied as
    # a horizontal pass then a vertical one, which runs about 6x faster than an 11x11 conv2d per map.
    maps = torch.cat([x, y, x * x, y * y, x * y])[:, None]
    maps = torch.nn.functional.conv2d(maps, gauss.view(1, 1, 1, -1), padding=(0, SSIM_WINDOW // 2))
    maps = torch.nn.functional.conv2d(maps, gauss.view(1, 1, -1, 1), padding=(SSIM_WINDOW // 2, 0))
    mu_x, mu_y, blur_xx, blur_yy, blur_xy = maps[:, 0].split(3)
    var_x = blur_xx - mu_x**2
    var_y = blur_yy - mu_y**2
    cov_xy = blur_xy - mu_x * mu_y
    ssim_map = ((2 * mu_x * mu_y + SSIM_C1) * (2 * cov_xy + SSIM_C2)) / (
        (mu_x**2 + mu_y**2 + SSIM_C1) * (var_x + var_y + SSIM_C2)
    )
    return ssim_map.mean()


def render_view(model: GaussianModel, viewmat: torch.Tensor, K: torch.Tensor, width: int, height: int) -> torch.Tensor:
    """Public entrypoint for worker/pipeline/export.py's thumbnail render. It reuses the same rasterization call as
    training, just without gradient tracking.
    """
    with torch.no_grad():
        rendered, _alpha, _meta = _render(model, viewmat, K, width, height, SH_DEGREE)
    return rendered


def _load_views(sparse: SparseModel, photos_dir: Path):
    cameras: list[tuple[torch.Tensor, int, int]] = []
    viewmats: list[torch.Tensor] = []
    images_tensor: list[torch.Tensor] = []

    for image in sparse.images.values():
        camera = sparse.cameras[image.camera_id]
        fx, fy, cx, cy = camera.fx, camera.fy, camera.cx, camera.cy
        width, height = camera.width, camera.height

        # fx/fy/cx/cy are scaled by the same factor as width/height, or K no longer matches the pixels it projects
        # onto.
        longest_edge = max(width, height)
        if longest_edge > MAX_TRAINING_EDGE:
            scale = MAX_TRAINING_EDGE / longest_edge
            fx, fy, cx, cy = fx * scale, fy * scale, cx * scale, cy * scale
            width, height = round(width * scale), round(height * scale)

        K = torch.tensor(
            [[fx, 0, cx], [0, fy, cy], [0, 0, 1]],
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
        pil_img = PILImage.open(img_path).convert("RGB").resize((width, height))
        img_tensor = torch.tensor(np.array(pil_img), dtype=torch.float32, device=DEVICE) / 255.0
        images_tensor.append(img_tensor)

        cameras.append((K, width, height))

    if not images_tensor:
        raise RuntimeError("No registered images with matching photo files found for training")

    return cameras, viewmats, images_tensor


def _init_gaussians(sparse: SparseModel) -> GaussianModel:
    n = len(sparse.points_xyz)
    if n == 0:
        raise RuntimeError("COLMAP produced an empty sparse point cloud — cannot initialize Gaussians")

    means = torch.tensor(sparse.points_xyz, dtype=torch.float32, device=DEVICE, requires_grad=True)

    scales = _nearest_neighbour_scales(means.detach()).log()[:, None].repeat(1, 3).requires_grad_(True)

    quats = torch.zeros((n, 4), dtype=torch.float32, device=DEVICE)
    quats[:, 0] = 1.0
    quats.requires_grad_(True)

    opacities = torch.full((n,), _logit(0.1), dtype=torch.float32, device=DEVICE, requires_grad=True)

    # Each point starts as COLMAP's color from every direction: the DC coefficient that renders as its RGB, and no
    # higher-degree terms.
    rgb = torch.tensor(sparse.points_rgb.astype(np.float32) / 255.0, dtype=torch.float32, device=DEVICE)
    sh0 = ((rgb - 0.5) / SH_C0)[:, None, :].requires_grad_(True)
    shN = torch.zeros((n, (SH_DEGREE + 1) ** 2 - 1, 3), dtype=torch.float32, device=DEVICE, requires_grad=True)

    return GaussianModel(means=means, scales=scales, quats=quats, opacities=opacities, sh0=sh0, shN=shN)


def _nearest_neighbour_scales(points: torch.Tensor) -> torch.Tensor:
    """Per-point RMS distance to its INIT_SCALE_NEIGHBOURS nearest neighbours, shape (N,)."""
    n = len(points)
    k = min(INIT_SCALE_NEIGHBOURS, n - 1)
    if k == 0:
        return torch.full((n,), MIN_INIT_SCALE, device=points.device)

    # Chunked so the pairwise distance matrix never holds more than 1024 rows at once. A full (N, N) matrix for a
    # few hundred thousand COLMAP points would not fit in VRAM.
    scales = []
    for chunk in points.split(1024):
        squared = torch.cdist(chunk, points).square()
        # Each row's smallest distance is the point to itself, so it is dropped.
        nearest = squared.topk(k + 1, dim=1, largest=False).values[:, 1:]
        scales.append(nearest.mean(dim=1).sqrt())
    return torch.cat(scales).clamp_min(MIN_INIT_SCALE)


def _build_optimizers(params: dict[str, torch.nn.Parameter], scene_scale: float) -> dict[str, torch.optim.Optimizer]:
    """One Adam per parameter, which is the shape gsplat's strategy needs to resize each one's state."""
    learning_rates = {
        "means": MEANS_LR * scene_scale,
        "scales": 5e-3,
        "quats": 1e-3,
        "opacities": 5e-2,
        "sh0": 2.5e-3,
        "shN": 2.5e-3 / 20,
    }
    return {name: torch.optim.Adam([params[name]], lr=lr) for name, lr in learning_rates.items()}


def _build_strategy(iterations: int):
    """gsplat's defaults assume a 30k-iteration run: refine every 100 steps from step 500 to step 15k. Each is scaled
    by the same fraction of the run here, so a 10k run keeps the reference proportions.

    Its own opacity reset never fires in gsplat 1.5.3, whose condition for it is always false. _train_loop resets
    opacities itself instead, on the schedule _is_opacity_reset_step gives.

    Growth is decided by absolute gradients (AbsGS) at gsplat's recommended threshold for them. Averaged gradients
    cancel out across a Gaussian covering fine texture, so it never splits. On test captures this held or improved
    quality while ending with about half as many Gaussians, which also makes training about a quarter faster.

    Pruning by size is off. The Gaussians it removes are the large ones covering whatever the photos barely reach, such
    as a ceiling or the far corners of a room. Nothing trained replaces them, so pruning them leaves holes that the
    viewer shows as its background.
    """
    from gsplat.strategy import DefaultStrategy  # imported lazily for the same reason as in _render

    return DefaultStrategy(
        refine_start_iter=iterations * 500 // 30_000,
        refine_stop_iter=iterations // 2,
        refine_every=max(1, iterations * 100 // 30_000),
        prune_scale3d=float("inf"),
        absgrad=True,
        grow_grad2d=0.0008,
    )


def _is_opacity_reset_step(step: int, iterations: int, refine_stop_iter: int) -> bool:
    """Every 3000 steps of a 30k-iteration run, scaled to the run's length like _build_strategy, and only while the
    strategy still refines. The reset caps every Gaussian's opacity just above the prune threshold. The ones the photos
    need climb back, and the rest, mostly floaters hanging in front of the cameras, get pruned at the next refine.
    """
    interval = max(1, iterations * 3000 // 30_000)
    return 0 < step < refine_stop_iter and step % interval == 0


def _sh_degree_at(step: int, iterations: int) -> int:
    """Raises the SH degree by one every 1000 steps of a 30k-iteration run, scaled to the run's length like
    _build_strategy. Starting at degree 0 lets each Gaussian's base color settle before the direction-dependent terms
    can absorb it.
    """
    interval = max(1, iterations * 1000 // 30_000)
    return min(step // interval, SH_DEGREE)


def _scene_scale(viewmats: list[torch.Tensor]) -> float:
    """1.1 times the farthest camera's distance from the cameras' mean position, as the reference 3DGS implementation
    measures it. The strategy's size threshold for splitting is a fraction of this.
    """
    centres = torch.stack([-(v[:3, :3].T @ v[:3, 3]) for v in viewmats])
    return 1.1 * (centres - centres.mean(dim=0)).norm(dim=-1).max().item()


def _render(model: GaussianModel, viewmat: torch.Tensor, K: torch.Tensor, width: int, height: int, sh_degree: int):
    """Returns (rendered_image, alpha, meta) for the single camera passed in. gsplat.rasterization is batched over
    cameras, so batch index 0 is sliced out of the image and alpha before returning them. Meta is returned as-is for
    the densification strategy, which reads its 2D means and their gradients.
    """
    import gsplat  # imported lazily so the rest of the module is importable/testable without CUDA/gsplat installed

    renders, alphas, meta = gsplat.rasterization(
        means=model.means,
        quats=model.quats / model.quats.norm(dim=-1, keepdim=True),
        scales=torch.exp(model.scales),
        opacities=torch.sigmoid(model.opacities),
        colors=torch.cat([model.sh0, model.shN], dim=1),
        sh_degree=sh_degree,
        viewmats=viewmat[None],
        Ks=K[None],
        width=width,
        height=height,
        absgrad=True,
    )
    return renders[0], alphas[0], meta


def _max_gaussians_for_device() -> int:
    """A device-sized ceiling on the point count densification is allowed to grow to. Without one, growth carries on
    until the strategy's refine_stop_iter regardless of how much VRAM is left, so a run on a small GPU can climb for
    thousands of iterations before finally OOMing.

    2KB/point is a deliberately conservative, unmeasured budget covering the point's own six tensors, Adam's two
    moment estimates per tensor, and gsplat's per-render tile-intersection buffers, which also scale with point
    count. Read against currently-free memory, not the card's total, so ground-truth images, the optimizer, and
    PyTorch's own overhead already resident by this point in training are accounted for. Half of what's free is
    reserved for everything that still grows later (new Adam moment buffers, tile-intersection memory at larger
    point counts) before this budget is computed.
    """
    if not torch.cuda.is_available():
        return 10**9  # No GPU to run out of, and CPU training is already impractically slow regardless of size.
    free_bytes, _total_bytes = torch.cuda.mem_get_info()
    budget_bytes = free_bytes // 2
    return max(1, budget_bytes // 2048)


def _logit(p: float) -> float:
    return float(np.log(p / (1 - p)))
