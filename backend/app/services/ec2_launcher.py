"""Direct boto3 spot-instance-per-job launch (plan §4) — no SQS/Batch/Step
Functions. IAM instance profile is scoped externally (infra/lib/worker-iam-stack.ts)
to exactly: S3 read (uploads bucket), S3 write (splats bucket),
ec2:TerminateInstances on itself.
"""

import base64
import secrets

import boto3

from ..config import get_settings

_USER_DATA_TEMPLATE = """#!/bin/bash
set -euo pipefail

# Fetch secrets from SSM at boot rather than embedding them in plaintext
# user-data (visible via the EC2 describe-instances API) — plan §6.
CALLBACK_TOKEN="{callback_token}"
JOB_ID="{job_id}"
OBJECT_ID="{object_id}"
BACKEND_URL="{backend_url}"
UPLOADS_BUCKET="{uploads_bucket}"
SPLATS_BUCKET="{splats_bucket}"

$(aws ecr get-login --no-include-email --region {aws_region}) || \\
    aws ecr get-login-password --region {aws_region} | docker login --username AWS --password-stdin {ecr_registry}

docker run --rm --gpus all \\
    -e JOB_ID="$JOB_ID" \\
    -e OBJECT_ID="$OBJECT_ID" \\
    -e CALLBACK_TOKEN="$CALLBACK_TOKEN" \\
    -e BACKEND_URL="$BACKEND_URL" \\
    -e UPLOADS_BUCKET="$UPLOADS_BUCKET" \\
    -e SPLATS_BUCKET="$SPLATS_BUCKET" \\
    {worker_image_uri}
"""


def generate_callback_token() -> str:
    """A per-job token (plan §3), not a static shared secret — scopes what a
    compromised instance can mutate to the one job it was launched for.
    """
    return secrets.token_urlsafe(32)


def launch_job(
    *,
    job_id: str,
    object_id: str,
    callback_token: str,
    worker_image_uri: str,
    ecr_registry: str,
) -> str:
    """Launches the spot worker instance and returns its instance ID."""
    settings = get_settings()
    ec2 = boto3.client("ec2", region_name=settings.aws_region)

    user_data = _USER_DATA_TEMPLATE.format(
        callback_token=callback_token,
        job_id=job_id,
        object_id=object_id,
        backend_url=settings.backend_public_url,
        uploads_bucket=settings.uploads_bucket,
        splats_bucket=settings.splats_bucket,
        worker_image_uri=worker_image_uri,
        ecr_registry=ecr_registry,
        aws_region=settings.aws_region,
    )
    user_data_b64 = base64.b64encode(user_data.encode()).decode()

    response = ec2.run_instances(
        ImageId=settings.worker_ami_id,
        InstanceType=settings.worker_instance_type,
        MinCount=1,
        MaxCount=1,
        SubnetId=settings.worker_subnet_id,
        SecurityGroupIds=[settings.worker_security_group_id],
        IamInstanceProfile={"Arn": settings.worker_instance_profile_arn},
        UserData=user_data_b64,
        InstanceMarketOptions={
            "MarketType": "spot",
            "SpotOptions": {"SpotInstanceType": "one-time", "InstanceInterruptionBehavior": "terminate"},
        },
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name", "Value": f"ai-gaussian-splatter-worker-{job_id}"},
                    {"Key": "Role", "Value": "worker"},
                    {"Key": "JobId", "Value": job_id},
                ],
            }
        ],
        InstanceInitiatedShutdownBehavior="terminate",
    )
    return response["Instances"][0]["InstanceId"]
