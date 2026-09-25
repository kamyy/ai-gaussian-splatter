"""Worker entrypoint. Reads job config from env vars and runs one phase of the pipeline, chosen by settings.stage:
"reconstruct" (fetch -> COLMAP -> point cloud, then pauses so the user can decide whether to train) or "train" (fetch ->
gsplat training -> export). Reports status back to the web app at each phase and self-terminates the EC2 instance from
the finally block below, on success and on failure alike, so a job never runs up spend past its own end.
"""

import logging
import sys
from pathlib import Path

from pipeline import fetch, sfm, sparse_export, status
from pipeline.colmap_model import SparseModel, read_sparse_model
from pipeline.config import Settings, get_settings
from pipeline.instance import terminate_self

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _run_reconstruct(settings: Settings) -> int:
    try:
        status.report_status(settings, "reconstruction_running")
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

        # Persisted so a later, separate EC2 instance (the train phase) can resume without re-running COLMAP, and so
        # the browser can show the point cloud and camera positions while the user decides whether to proceed.
        sparse_export.upload_sparse_model(sfm_result.sparse_dir, settings)
        point_cloud_key = sparse_export.export_and_upload_point_cloud(sfm_result.sparse_dir, settings)
        sparse_export.export_and_upload_cameras(sfm_result.sparse_dir, settings)

        status.report_status(settings, "awaiting_training", point_cloud_s3_key=point_cloud_key)
        return 0

    except Exception as exc:  # noqa: BLE001 — a job failure must always be reported, not just logged
        logger.exception("Job %s failed during reconstruction", settings.job_id)
        status.report_status(settings, "failed", error_message=str(exc))
        return 1

    finally:
        # Attempted on every path out of the try, success or failure. Missing it leaves the instance billing until
        # user-data's scheduled shutdown fires hours later (web/lib/server/ec2Launcher.ts).
        terminate_self()


def _run_train(settings: Settings) -> int:
    try:
        # Imported here rather than at module scope because both modules reach torch, which the reconstruct image does
        # not carry (worker/Dockerfile). worker/pipeline/export.py reaches it through worker/pipeline/train.py rather
        # than directly. Inside the try so that a failed import is still reported and still self-terminates: raised
        # above it, the worker job would sit at training_running while the instance billed until user-data's shutdown.
        from pipeline import export, train

        status.report_status(settings, "training_running")
        photos_dir = fetch.fetch_photos(settings)

        sparse_dir = Path(settings.local_workdir) / "colmap_sparse"
        sparse_export.download_sparse_model(settings, sparse_dir)
        # Parsed once and handed to train.train() below, rather than letting it re-parse the same files itself.
        sparse = read_sparse_model(sparse_dir)
        _verify_referenced_photos_present(sparse, photos_dir)

        scene = train.train(sparse_dir, photos_dir, settings, sparse=sparse)

        status.report_status(settings, "uploading_result")
        ply_path, thumbnail_path = export.export_scene(scene, settings)
        result_key, thumbnail_key = export.upload_result(ply_path, thumbnail_path, settings)

        status.report_status(settings, "complete", result_s3_key=result_key, thumbnail_s3_key=thumbnail_key)
        return 0

    except Exception as exc:  # noqa: BLE001 — a job failure must always be reported, not just logged
        logger.exception("Job %s failed during training", settings.job_id)
        status.report_status(settings, "failed", error_message=str(exc))
        return 1

    finally:
        terminate_self()


def _verify_referenced_photos_present(sparse: SparseModel, photos_dir: Path) -> None:
    """The reconstruct and train phases run on separate instances, potentially hours apart at awaiting_training, and
    nothing blocks photo uploads/deletion for a splat while its job sits paused there. A photo COLMAP referenced but
    that has since been removed would otherwise surface deep inside train.train() as a raw FileNotFoundError.
    """
    missing = [image.name for image in sparse.images.values() if not (photos_dir / image.name).exists()]
    if missing:
        raise RuntimeError(f"Photo(s) referenced by the COLMAP reconstruction are missing: {missing}")


def main() -> int:
    settings = get_settings()
    Path(settings.local_workdir).mkdir(parents=True, exist_ok=True)

    if settings.stage == "reconstruct":
        return _run_reconstruct(settings)
    return _run_train(settings)


if __name__ == "__main__":
    sys.exit(main())
