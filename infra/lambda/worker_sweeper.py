"""Terminates worker instances that have outlived their lifetime ceiling, and emails a list of them.

Each worker instance schedules its own `shutdown -h` from user-data (web/lib/server/ec2Launcher.ts). This catches the
instances where that never happened, such as a boot where cloud-init never ran. infra/worker_sweeper.tf runs it on a
schedule and sets its environment.
"""

import os
from datetime import UTC, datetime, timedelta

import boto3

ec2 = boto3.client("ec2")
sns = boto3.client("sns")


def overdue_instance_ids(reservations, now, max_age):
    """The ids of the instances in a DescribeInstances page launched longer than max_age before now."""
    return [
        instance["InstanceId"]
        for reservation in reservations
        for instance in reservation["Instances"]
        if now - instance["LaunchTime"] > max_age
    ]


def handler(event, context):
    max_age_minutes = int(os.environ["MAX_AGE_MINUTES"])
    max_age = timedelta(minutes=max_age_minutes)
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
            f"These worker instances ran longer than {max_age_minutes} minutes and were terminated: "
            f"{', '.join(overdue)}.\n\n"
            "Their own shutdown never fired, so something failed before or during boot. Check each instance's console "
            "output in EC2, and the matching jobs rows."
        ),
    )
    print(f"terminated {overdue}")
    return {"terminated": overdue}
