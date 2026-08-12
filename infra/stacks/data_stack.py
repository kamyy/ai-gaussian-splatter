import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_rds as rds
from aws_cdk import aws_s3 as s3
from constructs import Construct

# Imported by backend_stack.py to build the container's DATABASE_NAME. The RDS
# L2 construct doesn't expose the initial database name as an attribute, so
# without this the literal would have to be repeated in both stacks.
DATABASE_NAME = "ai_gaussian_splatter"


class DataStack(cdk.Stack):
    """RDS Postgres (single-AZ, db.t4g.micro — plan §2's justification: genuinely
    relational schema, low traffic, no need for Multi-AZ at this scale) and
    the two S3 buckets (uploads, splats).
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.Vpc,
        db_security_group: ec2.SecurityGroup,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        self.database = rds.DatabaseInstance(
            self,
            "Database",
            engine=rds.DatabaseInstanceEngine.postgres(version=rds.PostgresEngineVersion.VER_18),
            instance_type=ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
            vpc=vpc,
            # Isolated, not public like the tasks and workers: RDS needs no
            # outbound internet, so it keeps the stronger placement — no route
            # in or out, reachable only from db_security_group's one ingress
            # rule.
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_ISOLATED),
            security_groups=[db_security_group],
            multi_az=False,
            allocated_storage=20,
            storage_encrypted=True,
            credentials=rds.Credentials.from_generated_secret("splatter_admin"),
            database_name=DATABASE_NAME,
            removal_policy=cdk.RemovalPolicy.SNAPSHOT,
            deletion_protection=False,
            # RDS windows are fixed UTC and don't shift for DST — 10:00 UTC is
            # 3am Pacific during PDT, drifting to 2am Pacific during PST.
            preferred_maintenance_window="sun:10:00-sun:10:30",
        )

        # Uploads are ephemeral (source photos, not the deliverable) — expire
        # after 90 days to bound storage cost; splats are the actual output and
        # kept indefinitely (no lifecycle rule).
        self.uploads_bucket = s3.Bucket(
            self,
            "UploadsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            cors=[
                s3.CorsRule(
                    allowed_methods=[s3.HttpMethods.PUT],
                    allowed_origins=["*"],  # tightened to the real frontend origin at deploy time
                    allowed_headers=["*"],
                ),
            ],
            lifecycle_rules=[s3.LifecycleRule(expiration=cdk.Duration.days(90))],
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        self.splats_bucket = s3.Bucket(
            self,
            "SplatsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )
