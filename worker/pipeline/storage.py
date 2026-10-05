"""Builds the S3 client every download and upload in the worker uses.

On AWS the instance's own IAM role has no S3 access (infra/worker_iam.tf), because a worker processes photos anyone can
upload. The worker instead asks the web app for credentials scoped to its own splat
(web/app/api/v1/internal/jobs/[jobId]/s3-credentials/route.ts), authenticated with the same callback token as its status
updates. A local run has no such endpoint to ask, so it keeps boto3's default credentials, the dev IAM user's keys.
"""

import logging
import time
from typing import Any

import boto3
import httpx

from .config import Settings

logger = logging.getLogger(__name__)

# Seconds to wait before each retry. The app is briefly unreachable while ECS replaces its tasks during a deploy, and a
# failure here fails the whole stage, which at upload time throws away a finished training run. These waits ride out
# about half a minute of that.
_RETRY_DELAYS = (2.0, 4.0, 8.0, 16.0)


def _post_for_credentials(settings: Settings) -> dict[str, str]:
    response = httpx.post(
        f"{settings.app_origin}/api/v1/internal/jobs/{settings.job_id}/s3-credentials",
        headers={"Authorization": f"Bearer {settings.callback_token}"},
        timeout=10.0,
    )
    response.raise_for_status()
    credentials: dict[str, str] = response.json()
    return credentials


def _request_credentials(settings: Settings) -> dict[str, str]:
    """Asks the app for credentials, retrying a network failure or a 5xx. A 4xx is raised straight away, because asking
    again gets the same answer: a wrong token, or a worker job that has ended.

    Each warning logs the error with %r, not %s, for the same reason as worker/pipeline/status.py: httpx's timeout
    errors have empty messages.
    """
    for delay in _RETRY_DELAYS:
        try:
            return _post_for_credentials(settings)
        except httpx.HTTPStatusError as exc:
            if not exc.response.is_server_error:
                raise
            logger.warning("Couldn't get S3 credentials for job %s, retrying in %.0fs: %r", settings.job_id, delay, exc)
        except httpx.TransportError as exc:
            logger.warning("Couldn't get S3 credentials for job %s, retrying in %.0fs: %r", settings.job_id, delay, exc)
        time.sleep(delay)

    return _post_for_credentials(settings)


def s3_client(settings: Settings) -> Any:
    """An S3 client for this worker job. Call it right before each batch of transfers rather than keeping one for a
    whole stage, because the app's credentials expire after an hour. Raises once the app refuses or stays unreachable,
    since every S3 call would fail anyway.
    """
    if not settings.s3_credentials_from_app:
        return boto3.client("s3")

    credentials = _request_credentials(settings)

    return boto3.client(
        "s3",
        aws_access_key_id=credentials["access_key_id"],
        aws_secret_access_key=credentials["secret_access_key"],
        aws_session_token=credentials["session_token"],
    )
