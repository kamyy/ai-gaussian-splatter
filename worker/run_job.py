"""The worker's entrypoint: runs one stage of a worker job on a GPU instance.

The web app launches an EC2 spot instance (a discounted AWS virtual machine) for each stage and passes the worker job's
settings as environment variables. settings.stage picks the stage. "reconstruct" downloads the photos, runs COLMAP to
work out where each was taken, and saves a point cloud, then pauses so the user can decide whether to train. "train"
downloads the photos again, trains the Gaussian splat with gsplat, and uploads the results.

It reports status back to the web app at each step, and terminates its own instance from the finally block below, on
success and on failure alike, so a worker job never runs up spend past its own end.
"""

import logging
import sys
import time
from pathlib import Path

from pipeline import fetch, sfm, sparse_export, status
from pipeline.colmap_model import SparseModel, read_sparse_model
from pipeline.config import Settings, get_settings
from pipeline.instance import terminate_self
from pipeline.timing import ResourceSampler, log_line, timed

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _run_reconstruct(settings: Settings) -> int:
    try:
        status.report_status(settings, "reconstruction_running", booted_at=settings.booted_at)
        with timed("fetch_photos"):
            photos_dir = fetch.fetch_photos(settings)

        sfm_result = sfm.run_colmap(photos_dir, Path(settings.local_workdir) / "colmap")
        logger.info(
            "COLMAP registered %d/%d images (%.0f%%)",
            sfm_result.num_images_registered,
            sfm_result.num_images_input,
            sfm_result.registered_ratio * 100,
        )
        if sfm_result.registered_ratio < 0.5:
            # A low registered ratio is a capture-quality problem, not a pipeline bug. Fail clearly rather than
            # letting the user pay for training on a broken reconstruction.
            raise RuntimeError(
                f"Only {sfm_result.registered_ratio:.0%} of photos registered — "
                "capture likely has insufficient overlap between angles"
            )

        # Persisted so a later, separate EC2 instance (the train stage) can resume without re-running COLMAP. The
        # browser can show the point cloud and camera positions while the visitor decides whether to proceed.
        with timed("upload_outputs"):
            sparse_export.upload_sparse_model(sfm_result.sparse_dir, settings)
            point_cloud_key = sparse_export.export_and_upload_point_cloud(sfm_result.sparse_dir, settings)
            sparse_export.export_and_upload_cameras(sfm_result.sparse_dir, settings)

        status.report_status(settings, "awaiting_training", point_cloud_s3_key=point_cloud_key)
        return 0

    except Exception as exc:  # noqa: BLE001 — a worker job failure must always be reported, not just logged
        logger.exception("Job %s failed during reconstruction", settings.job_id)
        status.report_status(settings, "failed", error_message=str(exc))
        return 1

    finally:
        # Attempted on every path out of the try, success or failure. Missing it leaves the instance billing until
        # user-data's scheduled shutdown fires at the instance's lifetime ceiling (web/lib/server/workerLauncher.ts).
        terminate_self()


def _run_train(settings: Settings) -> int:
    try:
        # Reported before the import below, so the web app's image-pull time for this stage stops at the container's
        # start rather than also counting the seconds torch takes to load.
        status.report_status(settings, "training_running", booted_at=settings.booted_at)

        # Imported here rather than at module scope because both modules reach torch, which the reconstruct image does
        # not carry (worker/Dockerfile). worker/pipeline/export.py reaches it through worker/pipeline/train.py rather
        # than directly. The import stays inside the try, after training_running is reported. An import above the try
        # fails before that status is sent, and terminate_self() does not run.
        with timed("import_torch"):
            from pipeline import export, train

        with timed("fetch_photos"):
            photos_dir = fetch.fetch_photos(settings)

        sparse_dir = Path(settings.local_workdir) / "colmap_sparse"
        with timed("download_sparse_model"):
            sparse_export.download_sparse_model(settings, sparse_dir)
        # Parsed once and handed to train.train() below, rather than letting it re-parse the same files itself.
        sparse = read_sparse_model(sparse_dir)
        _verify_referenced_photos_present(sparse, photos_dir)

        scene = train.train(sparse_dir, photos_dir, settings, sparse=sparse)

        status.report_status(settings, "uploading_result")
        with timed("export_scene"):
            files = export.export_scene(scene, settings)
        with timed("upload_result"):
            keys = export.upload_result(files, settings)

        status.report_status(
            settings,
            "complete",
            result_ply_s3_key=keys.ply,
            result_spz_s3_key=keys.spz,
            thumbnail_s3_key=keys.thumbnail,
        )
        return 0

    except Exception as exc:  # noqa: BLE001 — a worker job failure must always be reported, not just logged
        logger.exception("Job %s failed during training", settings.job_id)
        status.report_status(settings, "failed", error_message=str(exc))
        return 1

    finally:
        terminate_self()


def _verify_referenced_photos_present(sparse: SparseModel, photos_dir: Path) -> None:
    """Fails the train stage when a photo named by the COLMAP model is missing from disk. A missing file would
    otherwise surface deep inside train.train() as a raw FileNotFoundError. There is no per-photo delete. Deleting the
    splat cancels the worker job first.
    """
    missing = [image.name for image in sparse.images.values() if not (photos_dir / image.name).exists()]
    if missing:
        raise RuntimeError(f"Photo(s) referenced by the COLMAP reconstruction are missing: {missing}")


def main() -> int:
    settings = get_settings()

    # From user-data's `docker run` to here: the container's start plus this module's own imports.
    if settings.docker_run_at is not None:
        log_line("timing", phase="container_start", ms=max(0, round(time.time() * 1000) - settings.docker_run_at))

    Path(settings.local_workdir).mkdir(parents=True, exist_ok=True)

    with ResourceSampler():
        if settings.stage == "reconstruct":
            return _run_reconstruct(settings)
        return _run_train(settings)


if __name__ == "__main__":
    sys.exit(main())
