"""Worker entrypoint. Reads job config from env vars, runs COLMAP -> gsplat
training -> export, and reports status back to the web app at each phase.
Self-terminates the EC2 instance from the finally block below, on success
and on failure alike, so a job never runs up spend past its own end.
"""

import logging
import sys
from pathlib import Path

from pipeline import export, fetch, sfm, status, train
from pipeline.config import get_settings
from pipeline.instance import terminate_self

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def main() -> int:
    settings = get_settings()
    Path(settings.local_workdir).mkdir(parents=True, exist_ok=True)

    try:
        status.report_status(settings, "colmap_running")
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
            # training on a broken reconstruction.
            raise RuntimeError(
                f"Only {sfm_result.registered_ratio:.0%} of photos registered — "
                "capture likely has insufficient overlap between angles"
            )

        status.report_status(settings, "training_running")
        scene = train.train(sfm_result.sparse_dir, photos_dir, settings)

        status.report_status(settings, "uploading_result")
        ply_path, thumbnail_path = export.export_scene(scene, settings)
        result_key, thumbnail_key = export.upload_result(ply_path, thumbnail_path, settings)

        status.report_status(settings, "complete", result_s3_key=result_key, thumbnail_s3_key=thumbnail_key)
        return 0

    except Exception as exc:  # noqa: BLE001 — a job failure must always be reported, not just logged
        logger.exception("Job %s failed", settings.job_id)
        status.report_status(settings, "failed", error_message=str(exc))
        return 1

    finally:
        # Attempted on every path out of the try, success or failure. Nothing outside the instance will terminate it
        # if this is missed.
        terminate_self()


if __name__ == "__main__":
    sys.exit(main())
