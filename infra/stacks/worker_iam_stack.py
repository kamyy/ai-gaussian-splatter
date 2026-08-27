import aws_cdk as cdk
from aws_cdk import aws_iam as iam
from aws_cdk import aws_s3 as s3
from constructs import Construct

from stacks.tags import WORKER_TAG_KEY, WORKER_TAG_VALUE


class WorkerIamStack(cdk.Stack):
    """The GPU spot worker's IAM role/instance profile — scoped to
    exactly: S3 read (uploads), S3 read/write (splats), and terminating itself.
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
            description="GPU spot worker instance role: S3 read on uploads, read/write on splats, self-terminate only",
        )

        uploads_bucket.grant_read(self.role)
        splats_bucket.grant_read_write(self.role)

        # This is self-termination only, scoped so the worker can kill itself at the end of its job (run_job.py's
        # finally block) but nothing else running in the account. EC2 doesn't support resource-level restriction to
        # "the calling instance" directly, so this is scoped by the same worker-tag convention used in web_stack.py's
        # RunInstances grant (see stacks/tags.py — the shared source of truth for that tag).
        self.role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:TerminateInstances"],
                resources=["*"],
                conditions={"StringEquals": {f"ec2:ResourceTag/{WORKER_TAG_KEY}": WORKER_TAG_VALUE}},
            )
        )

        # AWSServiceRoleForEC2Spot is imported, not created here: it's one account-wide singleton shared with every
        # other Spot workload, so creating it fails outright in an account that already has one, and CloudFormation
        # deleting it on this stack's behalf would break those other workloads. This stack borrows the role; it never
        # owns it. It has to exist before ec2Launcher.ts's first RunInstances call, since EC2 only auto-creates it for
        # a Spot request made in the console, not one made through the API. See RUNBOOK.md for the one-time setup.
        self.instance_profile = iam.InstanceProfile(
            self,
            "WorkerInstanceProfile",
            role=self.role,
        )
        self.instance_profile_arn = self.instance_profile.instance_profile_arn

        cdk.CfnOutput(self, "WorkerInstanceProfileArnOutput", value=self.instance_profile_arn)
