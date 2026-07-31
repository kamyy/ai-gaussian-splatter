"""EC2 instance self-termination via the instance metadata service (IMDSv2).

The instance terminating itself in all cases (success, failure, or the
CloudWatch alarm backstop per plan §4) is what prevents runaway spend — see
run_job.py's finally block.
"""

import logging

import boto3
import httpx

logger = logging.getLogger(__name__)

_IMDS_BASE = "http://169.254.169.254/latest"


def get_self_instance_id() -> str | None:
    """Returns None (rather than raising) when not actually running on EC2 —
    e.g. local dev per plan M4, where the pipeline runs synchronously without
    a real instance to terminate.
    """
    try:
        token_resp = httpx.put(
            f"{_IMDS_BASE}/api/token",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
            timeout=2.0,
        )
        token_resp.raise_for_status()
        id_resp = httpx.get(
            f"{_IMDS_BASE}/meta-data/instance-id",
            headers={"X-aws-ec2-metadata-token": token_resp.text},
            timeout=2.0,
        )
        id_resp.raise_for_status()
        return id_resp.text
    except httpx.HTTPError:
        logger.info("Not running on EC2 (or IMDS unreachable) — skipping self-termination")
        return None


def terminate_self() -> None:
    instance_id = get_self_instance_id()
    if instance_id is None:
        return
    try:
        boto3.client("ec2").terminate_instances(InstanceIds=[instance_id])
        logger.info("Termination requested for %s", instance_id)
    except Exception:
        logger.exception("Failed to terminate self (%s) — CloudWatch alarm backstop should catch this", instance_id)
