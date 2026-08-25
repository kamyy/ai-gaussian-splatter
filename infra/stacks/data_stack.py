import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_rds as rds
from aws_cdk import aws_s3 as s3
from constructs import Construct

# Imported by web_stack.py to build the container's DATABASE_NAME. The RDS L2 construct doesn't expose the initial
# database name as an attribute, so without this the literal would have to be repeated in both stacks.
DATABASE_NAME = "ai_gaussian_splatter"


class DataStack(cdk.Stack):
    """RDS Postgres (single-AZ, db.t4g.micro — a genuinely relational schema at
    low traffic, with no need for Multi-AZ at this scale) and the two S3
    buckets (uploads, splats).

    Both buckets' CORS rules name `app_origin` rather than "*": the browser
    talks to S3 directly on both legs (presigned PUT on upload, presigned GET
    in the viewer), so "*" would let any page a visitor lands on read a shared
    or leaked splat URL cross-origin. The origin is passed in because the
    hostname constant lives in web_stack, which already imports from this
    module.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.Vpc,
        db_security_group: ec2.SecurityGroup,
        app_origin: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        self.database = rds.DatabaseInstance(
            self,
            "Database",
            engine=rds.DatabaseInstanceEngine.postgres(version=rds.PostgresEngineVersion.VER_18),
            instance_type=ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
            vpc=vpc,
            # Isolated, not public like the tasks and workers: RDS needs no outbound internet, so it keeps the stronger
            # placement — no route in or out, reachable only from db_security_group's one ingress rule.
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PRIVATE_ISOLATED),
            security_groups=[db_security_group],
            multi_az=False,
            allocated_storage=20,
            # gp2 baseline is 3 IOPS/GiB with a 100 IOPS floor, so at 20 GiB the floor is all there is. gp3 includes
            # 3000 IOPS and 125 MiB/s at any size from 20 GiB up.
            storage_type=rds.StorageType.GP3,
            storage_encrypted=True,
            # RDS defaults to 1, which is the whole recovery window for a bad migration given removal_policy=SNAPSHOT
            # and no deletion protection. Backups of a 20 GiB instance are nearly free.
            backup_retention=cdk.Duration.days(7),
            credentials=rds.Credentials.from_generated_secret("splatter_admin"),
            database_name=DATABASE_NAME,
            removal_policy=cdk.RemovalPolicy.SNAPSHOT,
            deletion_protection=False,
            # RDS windows are fixed UTC and don't shift for DST — 10:00 UTC is 3am Pacific during PDT, drifting to 2am
            # Pacific during PST.
            preferred_maintenance_window="sun:10:00-sun:10:30",
        )

        # Uploads are ephemeral (source photos, not the deliverable) — expire after 90 days to bound storage cost;
        # splats are the actual output and kept indefinitely (no lifecycle rule).
        self.uploads_bucket = s3.Bucket(
            self,
            "UploadsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            # Adds the aws:SecureTransport deny. The browser reaches this bucket directly on a presigned URL, which is
            # the one hop in this architecture that leaves AWS's network.
            enforce_ssl=True,
            cors=[
                s3.CorsRule(
                    allowed_methods=[s3.HttpMethods.PUT],
                    allowed_origins=[app_origin],
                    allowed_headers=["*"],
                ),
            ],
            lifecycle_rules=[s3.LifecycleRule(expiration=cdk.Duration.days(90))],
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        # CORS is needed here for the same reason as on uploads, in the other direction: the viewer fetches the .ply
        # straight from S3 in the browser (components/viewer/SplatViewer.tsx passes the presigned URL to DropInViewer),
        # so it is a cross-origin GET that S3 rejects without a matching rule.
        self.splats_bucket = s3.Bucket(
            self,
            "SplatsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            cors=[
                s3.CorsRule(
                    allowed_methods=[s3.HttpMethods.GET, s3.HttpMethods.HEAD],
                    allowed_origins=[app_origin],
                    allowed_headers=["*"],
                ),
            ],
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        # ALB access logs, written by the ELB service rather than by the app — so no CORS rule. 90 days is how far back
        # an abuse investigation is likely to reach; the ALB is otherwise the one hop that keeps no record of who
        # called. RETAIN like the buckets above, which needs no auto_delete_objects custom resource; the lifecycle rule
        # is what bounds the cost of keeping it.
        self.access_logs_bucket = s3.Bucket(
            self,
            "AccessLogsBucket",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            lifecycle_rules=[s3.LifecycleRule(expiration=cdk.Duration.days(90))],
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )
