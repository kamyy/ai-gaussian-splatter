"""Reports a worker job's progress back to the web app.

Sends PATCH /api/v1/internal/jobs/{id}/status (web/app/api/v1/internal/jobs/[jobId]/status/route.ts), authenticated with
the job's callback token. The web app updates the job's row from it, which is what the splat's page polls.
"""

import logging

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


def report_status(
    settings: Settings,
    status: str,
    *,
    error_message: str | None = None,
    result_ply_s3_key: str | None = None,
    result_spz_s3_key: str | None = None,
    thumbnail_s3_key: str | None = None,
    point_cloud_s3_key: str | None = None,
    training_progress: int | None = None,
    booted_at: int | None = None,
) -> None:
    """PATCH the job's status back to the web app. Best effort: network errors are logged and swallowed rather than
    raised, because a failed status update must never stop the pipeline from continuing, or from reaching the finally
    block that terminates the instance. See worker/run_job.py.
    """
    payload: dict[str, str | int] = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    if result_ply_s3_key is not None:
        payload["result_ply_s3_key"] = result_ply_s3_key
    if result_spz_s3_key is not None:
        payload["result_spz_s3_key"] = result_spz_s3_key
    if thumbnail_s3_key is not None:
        payload["thumbnail_s3_key"] = thumbnail_s3_key
    if point_cloud_s3_key is not None:
        payload["point_cloud_s3_key"] = point_cloud_s3_key
    if training_progress is not None:
        payload["training_progress"] = training_progress
    if booted_at is not None:
        payload["booted_at"] = booted_at

    url = f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/status"
    try:
        response = httpx.patch(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {settings.callback_token}"},
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        # Warning, not exception(): the traceback of a swallowed error reads like a crash in the job log. The web app
        # being unreachable is also expected during a local pipeline run. %r, not %s: httpx's timeout errors carry an
        # empty message, so %s would log the failure with nothing identifying it after the colon.
        logger.warning("Failed to report status %r for job %s: %r", status, settings.job_id, exc)
