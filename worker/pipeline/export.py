"""Write the trained splat to a viewer-compatible .ply, render one thumbnail
image via gsplat's own rasterizer, and upload both to S3. The thumbnail
reuses the same renderer training already uses, so it costs no new
dependency.
"""

from pathlib import Path

import boto3
import numpy as np
import torch
from PIL import Image as PILImage
from plyfile import PlyData, PlyElement

from .config import CropBox, Settings
from .crop import inside_crop_box
from .train import GaussianModel, TrainedScene, render_view

# The DC-term encoding the standard 3DGS .ply format uses (INRIA reference exporter), which
# Spark and most other splat viewers expect: color = SH_C0 * f_dc + 0.5.
_SH_C0 = 0.28209479177387814


def export_scene(scene: TrainedScene, settings: Settings) -> tuple[Path, Path]:
    """Writes result.ply and thumbnail.png into local_workdir and returns their paths. It doesn't upload them. See
    upload_result().
    """
    workdir = Path(settings.local_workdir)
    ply_path = workdir / "result.ply"
    thumbnail_path = workdir / "thumbnail.png"

    if settings.crop_box is not None:
        scene = _crop_scene(scene, settings.crop_box)

    _write_ply(scene, ply_path)
    _render_thumbnail(scene, thumbnail_path)

    return ply_path, thumbnail_path


def upload_result(ply_path: Path, thumbnail_path: Path, settings: Settings) -> tuple[str, str]:
    """Uploads to s3://{splats_bucket}/splats/{splat_id}/{result.ply,thumbnail.png}
    and returns (result_s3_key, thumbnail_s3_key).
    """
    s3 = boto3.client("s3")
    result_key = f"splats/{settings.splat_id}/result.ply"
    thumbnail_key = f"splats/{settings.splat_id}/thumbnail.png"

    s3.upload_file(str(ply_path), settings.splats_bucket, result_key)
    s3.upload_file(str(thumbnail_path), settings.splats_bucket, thumbnail_key)

    return result_key, thumbnail_key


def _crop_scene(scene: TrainedScene, box: CropBox) -> TrainedScene:
    """Keeps each Gaussian whose center is inside the box. A Gaussian straddling a face is kept or dropped whole."""
    model = scene.model
    mask = torch.from_numpy(inside_crop_box(model.means.detach().cpu().numpy(), box)).to(model.means.device)
    if not bool(mask.any()):
        raise RuntimeError("The crop box doesn't contain any of the splat")
    cropped = GaussianModel(
        means=model.means[mask],
        scales=model.scales[mask],
        quats=model.quats[mask],
        opacities=model.opacities[mask],
        colors=model.colors[mask],
    )
    return TrainedScene(
        model=cropped,
        canonical_viewmat=scene.canonical_viewmat,
        canonical_K=scene.canonical_K,
        canonical_width=scene.canonical_width,
        canonical_height=scene.canonical_height,
    )


def _write_ply(scene: TrainedScene, path: Path) -> None:
    model = scene.model
    n = model.means.shape[0]

    means = model.means.detach().cpu().numpy()
    colors = torch.sigmoid(model.colors).detach().cpu().numpy()
    f_dc = (colors - 0.5) / _SH_C0

    quats = model.quats.detach().cpu().numpy()
    quats = quats / np.linalg.norm(quats, axis=-1, keepdims=True)

    scales = model.scales.detach().cpu().numpy()  # already log-space
    opacities = model.opacities.detach().cpu().numpy()  # already logit-space

    dtype = [
        ("x", "f4"),
        ("y", "f4"),
        ("z", "f4"),
        ("nx", "f4"),
        ("ny", "f4"),
        ("nz", "f4"),
        ("f_dc_0", "f4"),
        ("f_dc_1", "f4"),
        ("f_dc_2", "f4"),
        ("opacity", "f4"),
        ("scale_0", "f4"),
        ("scale_1", "f4"),
        ("scale_2", "f4"),
        ("rot_0", "f4"),
        ("rot_1", "f4"),
        ("rot_2", "f4"),
        ("rot_3", "f4"),
    ]
    vertex = np.zeros(n, dtype=dtype)
    vertex["x"], vertex["y"], vertex["z"] = means[:, 0], means[:, 1], means[:, 2]
    vertex["nx"] = vertex["ny"] = vertex["nz"] = 0.0
    vertex["f_dc_0"], vertex["f_dc_1"], vertex["f_dc_2"] = f_dc[:, 0], f_dc[:, 1], f_dc[:, 2]
    vertex["opacity"] = opacities
    vertex["scale_0"], vertex["scale_1"], vertex["scale_2"] = scales[:, 0], scales[:, 1], scales[:, 2]
    vertex["rot_0"], vertex["rot_1"], vertex["rot_2"], vertex["rot_3"] = (
        quats[:, 0],
        quats[:, 1],
        quats[:, 2],
        quats[:, 3],
    )

    PlyData([PlyElement.describe(vertex, "vertex")], text=False).write(str(path))


def _render_thumbnail(scene: TrainedScene, path: Path) -> None:
    rendered = render_view(
        scene.model, scene.canonical_viewmat, scene.canonical_K, scene.canonical_width, scene.canonical_height
    )
    image_array = (rendered.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
    PILImage.fromarray(image_array).save(path)
