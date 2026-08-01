import aws_cdk as cdk
from aws_cdk import aws_iam as iam
from aws_cdk import aws_s3 as s3
from constructs import Construct

from stacks.tags import WORKER_TAG_KEY, WORKER_TAG_VALUE


class WorkerIamStack(cdk.Stack):
    """The GPU spot worker's IAM role/instance profile (plan §4, §6) — scoped to
    exactly: S3 read (uploads), S3 write (splats), and terminating itself.
    No other permissions, so a compromised instance can't do much beyond its
    own job.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        uploads_bucket: s3.Bucket,
        splats_bucket: s3.Bucket,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        self.role = iam.Role(
            self,
            "WorkerRole",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            description="GPU spot worker instance role, S3 rw scoped to the two buckets, self-terminate only",
        )

        uploads_bucket.grant_read(self.role)
        splats_bucket.grant_read_write(self.role)

        # Self-termination only — scoped so the worker can kill itself (plan §4's
        # "instance self-terminates in all cases") but nothing else running in
        # the account. EC2 doesn't support resource-level restriction to
        # "the calling instance" directly, so this is scoped by the same
        # worker-tag convention used in backend_stack.py's RunInstances grant
        # (see stacks/tags.py — the shared source of truth for that tag).
        self.role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:TerminateInstances"],
                resources=["*"],
                conditions={"StringEquals": {f"ec2:ResourceTag/{WORKER_TAG_KEY}": WORKER_TAG_VALUE}},
            )
        )

        self.instance_profile = iam.CfnInstanceProfile(
            self,
            "WorkerInstanceProfile",
            roles=[self.role.role_name],
        )
        self.instance_profile_arn = self.instance_profile.attr_arn

        cdk.CfnOutput(self, "WorkerInstanceProfileArnOutput", value=self.instance_profile_arn)
