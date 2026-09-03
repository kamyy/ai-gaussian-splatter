"""Structure-from-Motion via COLMAP: exhaustive matching, favouring accuracy
over speed for a small object-centric photo set.

Requires the `colmap` CLI on PATH (installed via `worker/Dockerfile` / baked
AMI). It is not a pip package, hence subprocess rather than pycolmap.
"""

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class SfmResult:
    sparse_dir: Path
    num_images_input: int
    num_images_registered: int

    @property
    def registered_ratio(self) -> float:
        if self.num_images_input == 0:
            return 0.0
        return self.num_images_registered / self.num_images_input


def run_colmap(photos_dir: Path, workdir: Path) -> SfmResult:
    """Run the standard COLMAP CLI pipeline (feature extraction -> exhaustive
    matching -> incremental mapping) and return the sparse reconstruction.

    A good object-centric capture registers close to every photo, so a low
    registered_ratio signals a capture-quality problem rather than a pipeline
    bug. The caller should surface it instead of silently training on a
    broken reconstruction.
    """
    database_path = workdir / "database.db"
    sparse_dir = workdir / "sparse"
    sparse_dir.mkdir(parents=True, exist_ok=True)

    image_paths = [p for p in photos_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
    if not image_paths:
        raise RuntimeError(f"No photos found in {photos_dir}")
    num_images_input = len(image_paths)

    # COLMAP scans --image_path itself rather than taking an explicit file list. A stray non-image file left in
    # photos_dir (a phone's video sidecar, a thumbnail) therefore gets read as an image too. --ImageReader.single_camera
    # then locks every photo's intrinsics to whichever file COLMAP reads first, so a wrong-sized stray file poisons
    # every real photo with CAMERA_SINGLE_DIM_ERROR and the reconstruction fails outright. Symlinking only the
    # accepted suffixes into their own directory keeps COLMAP from ever seeing anything else.
    images_dir = workdir / "images"
    images_dir.mkdir(exist_ok=True)
    for p in image_paths:
        (images_dir / p.name).symlink_to(p)

    _run(
        [
            "colmap",
            "feature_extractor",
            "--database_path",
            str(database_path),
            "--image_path",
            str(images_dir),
            "--ImageReader.single_camera",
            "1",
            "--FeatureExtraction.use_gpu",
            "1",
        ]
    )

    _run(
        [
            "colmap",
            "exhaustive_matcher",
            "--database_path",
            str(database_path),
            "--FeatureMatching.use_gpu",
            "1",
        ]
    )

    _run(
        [
            "colmap",
            "mapper",
            "--database_path",
            str(database_path),
            "--image_path",
            str(images_dir),
            "--output_path",
            str(sparse_dir),
        ]
    )

    # `mapper` writes one sub-model per connected component (0, 1, 2...) when the photo set doesn't fully connect. Only
    # model 0 is used, and the other components' images are therefore never counted as registered below. So a capture
    # that fragments shows up as a low registered ratio, which is what worker/run_job.py rejects it on.
    model_dir = sparse_dir / "0"
    if not model_dir.exists():
        raise RuntimeError(
            f"COLMAP mapper produced no reconstruction at {model_dir} — "
            "capture likely has insufficient overlap between photos"
        )

    num_registered = _count_registered_images(model_dir)

    return SfmResult(
        sparse_dir=model_dir,
        num_images_input=num_images_input,
        num_images_registered=num_registered,
    )


def _count_registered_images(model_dir: Path) -> int:
    result = _run(["colmap", "model_analyzer", "--path", str(model_dir)], capture=True)
    # COLMAP reports through glog, which writes to stderr and never to stdout, so the count is not where a plain `colmap
    # ... | grep` would look for it. Both streams are searched rather than stderr alone, so the parse does not break
    # again if a future version prints it directly.
    output = f"{result.stdout}\n{result.stderr}"
    match = re.search(r"Registered images:\s*(\d+)", output)
    if not match:
        raise RuntimeError(f"Could not parse registered image count from model_analyzer output: {output!r}")
    return int(match.group(1))


def _run(cmd: list[str], capture: bool = False) -> subprocess.CompletedProcess:
    logger.info("Running: %s", " ".join(cmd))
    result = subprocess.run(
        cmd,
        check=True,
        capture_output=capture,
        text=capture,
    )
    return result
