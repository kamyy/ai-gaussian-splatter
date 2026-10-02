"""Saves the trained splat and uploads it to S3.

Writes the splat as .ply and .spz, renders one thumbnail image with gsplat's own rasterizer, and uploads all three to
S3, AWS's file storage. The .ply is the lossless download, readable by every splat tool. The .spz is the compressed copy
the web viewer loads. The thumbnail reuses the renderer training already uses, so it costs no new dependency.
"""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image as PILImage
from plyfile import PlyData, PlyElement

from .config import CropBox, Settings
from .crop import inside_crop_box
from .spz import write_spz
from .storage import s3_client
from .train import GaussianModel, TrainedScene, render_view


@dataclass
class ExportedFiles:
    ply: Path
    spz: Path
    thumbnail: Path


@dataclass
class UploadedKeys:
    ply: str
    spz: str
    thumbnail: str


def export_scene(scene: TrainedScene, settings: Settings) -> ExportedFiles:
    """Writes result.ply, result.spz, and thumbnail.png into local_workdir and returns their paths. It doesn't upload
    them. See upload_result().
    """
    workdir = Path(settings.local_workdir)
    files = ExportedFiles(ply=workdir / "result.ply", spz=workdir / "result.spz", thumbnail=workdir / "thumbnail.png")

    if settings.crop_box is not None:
        scene = _crop_scene(scene, settings.crop_box)

    _write_ply(scene, files.ply)
    write_spz(scene.model, files.spz)
    _render_thumbnail(scene, files.thumbnail)

    return files


def upload_result(files: ExportedFiles, settings: Settings) -> UploadedKeys:
    """Uploads to s3://{splats_bucket}/splats/{splat_id}/ under each file's own name and returns their keys."""
    s3 = s3_client(settings)
    prefix = f"splats/{settings.splat_id}"
    keys = UploadedKeys(ply=f"{prefix}/result.ply", spz=f"{prefix}/result.spz", thumbnail=f"{prefix}/thumbnail.png")

    s3.upload_file(str(files.ply), settings.splats_bucket, keys.ply)
    s3.upload_file(str(files.spz), settings.splats_bucket, keys.spz)
    s3.upload_file(str(files.thumbnail), settings.splats_bucket, keys.thumbnail)

    return keys


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
        sh0=model.sh0[mask],
        shN=model.shN[mask],
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
    f_dc = model.sh0.detach().cpu().numpy()[:, 0, :]
    # The standard 3DGS .ply (the INRIA reference exporter's) orders the higher-degree coefficients channel-major: every
    # red coefficient, then every green, then every blue.
    f_rest = model.shN.detach().cpu().numpy().transpose(0, 2, 1).reshape(n, -1)

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
        *((f"f_rest_{i}", "f4") for i in range(f_rest.shape[1])),
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
    for i in range(f_rest.shape[1]):
        vertex[f"f_rest_{i}"] = f_rest[:, i]
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
