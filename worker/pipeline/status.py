"""Worker -> web status callback: PATCH /api/v1/internal/jobs/{id}/status."""

import logging

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


def report_status(
    settings: Settings,
    status: str,
    *,
    error_message: str | None = None,
    result_s3_key: str | None = None,
    thumbnail_s3_key: str | None = None,
    ec2_instance_id: str | None = None,
) -> None:
    """PATCH the job's status back to the web app. Best-effort: logs and swallows
    network errors rather than raising, since a failed status update should never
    prevent the pipeline from continuing (or from reaching the finally block that
    terminates the instance) — see run_job.py.
    """
    payload: dict[str, str] = {"status": status}
    if error_message is not None:
        payload["error_message"] = error_message
    if result_s3_key is not None:
        payload["result_s3_key"] = result_s3_key
    if thumbnail_s3_key is not None:
        payload["thumbnail_s3_key"] = thumbnail_s3_key
    if ec2_instance_id is not None:
        payload["ec2_instance_id"] = ec2_instance_id

    url = f"{settings.app_public_url}/api/v1/internal/jobs/{settings.job_id}/status"
    try:
        response = httpx.patch(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {settings.callback_token}"},
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        # Warning, not exception(): the traceback of a swallowed error reads like a crash in the job log, and the web
        # app being unreachable is expected during a local pipeline run. %r, not %s: httpx's timeout errors carry an
        # empty message, so %s would log the failure with nothing identifying it after the colon.
        logger.warning("Failed to report status %r for job %s: %r", status, settings.job_id, exc)
