"""Terminates worker instances that have outlived their lifetime ceiling, and emails a list of them.

Each worker instance schedules its own `shutdown -h` from user-data (web/lib/server/ec2Launcher.ts). This catches the
instances where that never happened, such as a boot where cloud-init never ran. infra/worker_sweeper.tf runs it on a
schedule and sets its environment.

Each instance's ceiling is its own MaxLifetimeMinutes tag, which web/lib/server/ec2Launcher.ts sets at launch from the
runtime setting in force then. Lowering that setting therefore never cuts short a stage launched under a longer one.
"""

import os
from datetime import UTC, datetime, timedelta

import boto3

# Must match the tag key web/lib/server/ec2Launcher.ts writes.
LIFETIME_TAG_KEY = "MaxLifetimeMinutes"

# Covers boot, since an instance's ceiling counts from when user-data runs rather than from launch.
# web/lib/server/reconcileJob.ts allows the same.
GRACE = timedelta(minutes=15)

ec2 = boto3.client("ec2")
sns = boto3.client("sns")


def instance_max_age(instance, max_age):
    """How long this instance may run: its own tagged ceiling plus the grace, never more than max_age.

    An instance with no tag, or one that doesn't parse, gets max_age.
    """
    tags = {tag["Key"]: tag["Value"] for tag in instance.get("Tags", [])}
    try:
        own = timedelta(minutes=int(tags[LIFETIME_TAG_KEY])) + GRACE
    except (KeyError, ValueError):
        return max_age

    return min(own, max_age)


def overdue_instance_ids(reservations, now, max_age):
    """The ids of the instances in a DescribeInstances page that have run longer than instance_max_age allows."""
    return [
        instance["InstanceId"]
        for reservation in reservations
        for instance in reservation["Instances"]
        if now - instance["LaunchTime"] > instance_max_age(instance, max_age)
    ]


def handler(event, context):
    max_age = timedelta(minutes=int(os.environ["MAX_AGE_MINUTES"]))
    now = datetime.now(UTC)
    overdue = []
    pages = ec2.get_paginator("describe_instances").paginate(
        Filters=[
            {"Name": f"tag:{os.environ['WORKER_TAG_KEY']}", "Values": [os.environ["WORKER_TAG_VALUE"]]},
            {"Name": "instance-state-name", "Values": ["pending", "running"]},
        ]
    )
    for page in pages:
        overdue += overdue_instance_ids(page["Reservations"], now, max_age)

    if not overdue:
        return {"terminated": []}

    ec2.terminate_instances(InstanceIds=overdue)
    sns.publish(
        TopicArn=os.environ["ALERT_TOPIC_ARN"],
        Subject="ai-gaussian-splatter: worker instances terminated",
        Message=(
            "These worker instances ran past their lifetime ceiling and were terminated: "
            f"{', '.join(overdue)}.\n\n"
            "Their own shutdown never fired, so something failed before or during boot. Check each instance's console "
            "output in EC2, and the matching jobs rows."
        ),
    )
    print(f"terminated {overdue}")
    return {"terminated": overdue}
