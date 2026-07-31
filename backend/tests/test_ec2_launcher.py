import boto3
from moto import mock_aws

from app.services.ec2_launcher import generate_callback_token, launch_job


def test_generate_callback_token_is_unique_and_nontrivial():
    tokens = {generate_callback_token() for _ in range(100)}
    assert len(tokens) == 100
    assert all(len(t) > 20 for t in tokens)


@mock_aws
def test_launch_job_starts_a_spot_instance_with_expected_tags():
    ec2 = boto3.client("ec2", region_name="us-east-1")
    vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]
    subnet = ec2.create_subnet(VpcId=vpc["VpcId"], CidrBlock="10.0.0.0/24")["Subnet"]
    sg = ec2.create_security_group(GroupName="worker-sg", Description="worker", VpcId=vpc["VpcId"])

    iam = boto3.client("iam", region_name="us-east-1")
    iam.create_role(
        RoleName="worker",
        AssumeRolePolicyDocument='{"Version": "2012-10-17", "Statement": []}',
    )
    profile = iam.create_instance_profile(InstanceProfileName="worker")["InstanceProfile"]
    iam.add_role_to_instance_profile(InstanceProfileName="worker", RoleName="worker")

    import os

    os.environ["WORKER_SUBNET_ID"] = subnet["SubnetId"]
    os.environ["WORKER_SECURITY_GROUP_ID"] = sg["GroupId"]
    os.environ["WORKER_INSTANCE_PROFILE_ARN"] = profile["Arn"]
    # get_settings() caches on first call in this process; for a real test
    # suite this would use dependency injection instead of module-level
    # caching — acceptable simplification for this skeleton (see app/config.py).
    import app.config

    app.config._settings = None

    instance_id = launch_job(
        job_id="job-123",
        object_id="obj-456",
        callback_token="tok-abc",
        worker_image_uri="123456789012.dkr.ecr.us-east-1.amazonaws.com/worker:latest",
        ecr_registry="123456789012.dkr.ecr.us-east-1.amazonaws.com",
    )

    instances = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0]["Instances"]
    assert len(instances) == 1
    tags = {t["Key"]: t["Value"] for t in instances[0]["Tags"]}
    assert tags["JobId"] == "job-123"
    assert tags["Role"] == "worker"
