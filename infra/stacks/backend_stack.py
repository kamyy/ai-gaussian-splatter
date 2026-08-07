import aws_cdk as cdk
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_ecs_patterns as ecs_patterns
from aws_cdk import aws_elasticloadbalancingv2 as elbv2
from aws_cdk import aws_iam as iam
from aws_cdk import aws_rds as rds
from aws_cdk import aws_route53 as route53
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_secretsmanager as secretsmanager
from constructs import Construct

from stacks.data_stack import DATABASE_NAME
from stacks.registry_stack import IMAGE_TAG
from stacks.tags import WORKER_TAG_KEY, WORKER_TAG_VALUE

# Where web/Dockerfile's `ADD` puts Amazon's RDS global CA bundle. Must match
# that line — the image supplies the file, this stack turns it on.
RDS_CA_BUNDLE_PATH = "/app/certs/rds-global-bundle.pem"

# Single source of truth for the Next.js container's listen port — used by
# both the task definition and the target group's health check below, so they
# can't drift out of sync with each other. The ALB-to-tasks ingress rule
# derives from it too, but is generated rather than written down. The copies
# that do have to be changed by hand are web/Dockerfile's PORT and the port
# asserted in infra/tests/test_network_stack.py.
CONTAINER_PORT = 8000

# The public hostname. The Route 53 zone is registered in this account; only
# its ID varies by environment, so that alone is passed in.
DOMAIN_ZONE_NAME = "orky.net"
APP_HOSTNAME = f"ai-gaussian-splatter.{DOMAIN_ZONE_NAME}"

# Both named explicitly rather than left to CloudFormation's generated names,
# so `aws ecs update-service --force-new-deployment` — the only way a push to
# the fixed image tag reaches the running service — can be written down
# literally in docs/RUNBOOK.md instead of looked up per environment.
CLUSTER_NAME = "ai-gaussian-splatter"
SERVICE_NAME = "ai-gaussian-splatter-backend"

# Must exceed the ALB's own idle timeout (60s, left at the CDK default below)
# or the ALB can hand a request to a keep-alive socket Node already closed —
# see the KEEP_ALIVE_TIMEOUT env var below for the full explanation.
KEEP_ALIVE_TIMEOUT_MS = "65000"


class BackendStack(cdk.Stack):
    """The Next.js app (pages + the REST API as Route Handlers) on Fargate,
    behind an internet-facing Application Load Balancer.

    The ALB sits in the public subnets and is the only internet-facing part;
    the tasks run in the private subnets with no public IP, reaching AWS APIs
    (S3, EC2 RunInstances) through the VPC's NAT gateway. TLS terminates at
    the ALB with an ACM certificate for APP_HOSTNAME, and plain HTTP is
    redirected to HTTPS.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.Vpc,
        backend_security_group: ec2.SecurityGroup,
        alb_security_group: ec2.SecurityGroup,
        repository: ecr.IRepository,
        database: rds.DatabaseInstance,
        uploads_bucket: s3.Bucket,
        splats_bucket: s3.Bucket,
        worker_ami_id: str,
        worker_instance_profile_arn: str,
        worker_role_arn: str,
        worker_security_group_id: str,
        worker_subnet_id: str,
        app_public_url: str,
        hosted_zone_id: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        # Clerk's server-side API key. Created empty; populate it out-of-band
        # (console or `aws secretsmanager put-secret-value`) after the first
        # deploy — the value must never be in source or in CloudFormation
        # template JSON. Same treatment as the RDS-generated DATABASE_URL.
        #
        # Its public counterpart, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, is
        # deliberately NOT here: Next.js inlines NEXT_PUBLIC_* variables into
        # the bundle at build time, so setting it as a container env var has no
        # effect. It is a `docker build --build-arg` instead (see the web
        # Dockerfile).
        self.clerk_secret = secretsmanager.Secret(
            self,
            "ClerkSecretKey",
            secret_name="ai-gaussian-splatter/clerk-secret-key",
            description="Clerk CLERK_SECRET_KEY — set manually after deploy",
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        # Pulls the container image and writes logs — also the role ECS uses
        # to fetch the DB secret's value before handing it to the container as
        # an env var, so the DB secret grant belongs here, not on the task
        # role.
        #
        # Deliberately not using the AmazonECSTaskExecutionRolePolicy managed
        # policy: besides the two logs actions below (unavoidably
        # account-wide, since ECS doesn't know the log group ahead of time),
        # it also grants the image-pull actions (BatchCheckLayerAvailability,
        # GetDownloadUrlForLayer, BatchGetImage) at Resource: "*" — read
        # access to every ECR repo in the account. Reconstructed below
        # instead: the two logs actions explicitly, plus `grant_pull`, which
        # scopes the real pull actions to this one repository (see its inline
        # comment for the one action that stays account-wide).
        execution_role = iam.Role(
            self,
            "ExecutionRole",
            assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        )
        execution_role.add_to_policy(
            iam.PolicyStatement(
                actions=["logs:CreateLogStream", "logs:PutLogEvents"],
                resources=["*"],
            )
        )
        repository.grant_pull(execution_role)  # also grants ecr:GetAuthorizationToken (Resource: "*", unavoidably)
        # database.secret is always populated — credentials come from
        # from_generated_secret in data_stack.py — so this is safe to assert
        # once and reuse, rather than encoding the same invariant two
        # different ways.
        assert database.secret is not None
        db_secret = database.secret
        db_secret.grant_read(execution_role)
        self.clerk_secret.grant_read(execution_role)

        # The running application code's own permissions — S3 rw on both
        # buckets, ec2:RunInstances/TerminateInstances scoped by tag (plan §6's
        # IAM section).
        task_role = iam.Role(
            self,
            "TaskRole",
            assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        )
        uploads_bucket.grant_read_write(task_role)
        splats_bucket.grant_read_write(task_role)
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:RunInstances"],
                # RunInstances requires resource-level perms on multiple ARN types; tightened via conditions below
                resources=["*"],
                conditions={"StringEquals": {f"aws:RequestTag/{WORKER_TAG_KEY}": WORKER_TAG_VALUE}},
            )
        )
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:TerminateInstances"],
                resources=["*"],
                conditions={"StringEquals": {f"ec2:ResourceTag/{WORKER_TAG_KEY}": WORKER_TAG_VALUE}},
            )
        )
        # PassRole is authorized against the role being passed, not the
        # instance profile ARN that wraps it — RunInstances with
        # IamInstanceProfile evaluates iam:PassRole against the underlying
        # role's ARN.
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["iam:PassRole"],
                resources=[worker_role_arn],
            )
        )

        # Imported, never managed: this stack only adds records to the zone.
        # An imported zone is not part of the template's resource set, so no
        # CloudFormation operation — `cdk destroy` included — can modify or
        # delete the zone itself or anything already in it.
        hosted_zone = route53.HostedZone.from_hosted_zone_attributes(
            self,
            "HostedZone",
            hosted_zone_id=hosted_zone_id,
            zone_name=DOMAIN_ZONE_NAME,
        )

        # An ALB is regional and can only reference a certificate in its own
        # region, which declaring it here gets — a us-east-1 certificate can't
        # attach to this ALB. (us-east-1 is only special for CloudFront,
        # unused here, which reads certificates from that region regardless of
        # where the origin lives.) Certificates are free and Route 53 zones
        # are global, so DNS validation is unaffected by which region issues
        # the certificate.
        certificate = acm.Certificate(
            self,
            "Certificate",
            domain_name=APP_HOSTNAME,
            validation=acm.CertificateValidation.from_dns(hosted_zone),
        )

        # Built manually rather than via the CDK pattern, so its security
        # group can be the one NetworkStack owns — see network_stack.py's
        # alb_security_group comment for why the pattern's own group would
        # cause a DependencyCycle.
        self.load_balancer = elbv2.ApplicationLoadBalancer(
            self,
            "LoadBalancer",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_security_group,
            vpc_subnets=ec2.SubnetSelection(subnets=vpc.public_subnets),
        )

        cluster = ecs.Cluster(self, "Cluster", vpc=vpc, cluster_name=CLUSTER_NAME)

        self.service = ecs_patterns.ApplicationLoadBalancedFargateService(
            self,
            "Service",
            service_name=SERVICE_NAME,
            load_balancer=self.load_balancer,
            certificate=certificate,
            domain_name=APP_HOSTNAME,
            domain_zone=hosted_zone,
            protocol=elbv2.ApplicationProtocol.HTTPS,
            redirect_http=True,
            # Set explicitly: a listener created via the API or CloudFormation
            # (as this one is) defaults to the weak ELBSecurityPolicy-2016-08,
            # which still negotiates TLS 1.0/1.1 — unlike the console, whose
            # default is this same strong policy. TLS 1.2/1.3 only, which
            # every browser since ~2014 and the worker's Python client speak.
            ssl_policy=elbv2.SslPolicy.RECOMMENDED_TLS,
            cpu=256,  # 0.25 vCPU
            memory_limit_mib=512,
            # Mutually exclusive with `vpc`: the pattern creates a cluster of
            # its own when given a VPC, and that one gets a generated name.
            cluster=cluster,
            # The point of the private subnets here is that tasks get no public
            # IP; their outbound calls to S3 and the EC2 API go through the
            # VPC's NAT gateway instead. Only the ALB above is internet-facing.
            task_subnets=ec2.SubnetSelection(subnets=vpc.private_subnets),
            security_groups=[backend_security_group],
            # A cold Next.js server start can outrun the default 60s, and a
            # task killed inside the grace period never gets far enough to say
            # why. /api/v1/healthz answers from the app alone — it does not
            # touch the database, so a passing health check says nothing about
            # RDS connectivity.
            health_check_grace_period=cdk.Duration.seconds(300),
            # Without this, a deployment whose tasks never reach a steady state
            # (an image that isn't in ECR yet, a container that crashes on
            # boot) is not reported as failed until ECS's own timeout expires,
            # which takes hours. Roll back instead.
            circuit_breaker=ecs.DeploymentCircuitBreaker(rollback=True),
            # The default 50% floors to zero healthy tasks at desired_count 1,
            # letting ECS stop the only running task before its replacement
            # passes health checks — a window of 503s on every deploy.
            min_healthy_percent=100,
            task_image_options=ecs_patterns.ApplicationLoadBalancedTaskImageOptions(
                # from_ecr_repository rather than from_registry: it reads the
                # repository's ARN to scope the execution role's pull grant,
                # instead of treating the URI as an opaque public image name.
                image=ecs.ContainerImage.from_ecr_repository(repository, tag=IMAGE_TAG),
                container_port=CONTAINER_PORT,
                execution_role=execution_role,
                task_role=task_role,
                environment={
                    "UPLOADS_BUCKET": uploads_bucket.bucket_name,
                    "SPLATS_BUCKET": splats_bucket.bucket_name,
                    "WORKER_AMI_ID": worker_ami_id,
                    "WORKER_SUBNET_ID": worker_subnet_id,
                    "WORKER_SECURITY_GROUP_ID": worker_security_group_id,
                    "WORKER_INSTANCE_PROFILE_ARN": worker_instance_profile_arn,
                    # Where the GPU worker PATCHes job status back to. Passed in
                    # rather than read off the load balancer, so it stays the
                    # stable custom domain the ALB is aliased to.
                    "APP_PUBLIC_URL": app_public_url,
                    # The non-secret half of the connection, passed as parts
                    # rather than an assembled URL: RDS writes its generated
                    # credentials to Secrets Manager as a JSON blob, and ECS
                    # cannot assemble a postgresql:// URL out of that blob
                    # itself. The app builds the URL in
                    # web/lib/server/databaseUrl.ts.
                    "DATABASE_HOST": database.db_instance_endpoint_address,
                    "DATABASE_PORT": database.db_instance_endpoint_port,
                    "DATABASE_NAME": DATABASE_NAME,
                    # RDS Postgres 15+ defaults to rds.force_ssl=1, and its
                    # certificates chain to Amazon's own root CAs, absent from
                    # Node's trust store — without this CA bundle the
                    # connection fails either unencrypted ("no pg_hba.conf
                    # entry ... no encryption") or unverified
                    # ("UNABLE_TO_VERIFY_LEAF_SIGNATURE"). web/Dockerfile bakes
                    # the bundle into the image; set as an env var (not
                    # hardcoded) so a locally-run container can still talk to
                    # a plain Postgres.
                    "DATABASE_SSL_CA": RDS_CA_BUNDLE_PATH,
                    # The ALB pools connections to the target for up to its
                    # own idle timeout (60s, the CDK default, unchanged).
                    # Node's http server closes idle keep-alive sockets after
                    # 5s by default; Next's standalone server.js only
                    # overrides that when this env var is set (build/utils.js).
                    # Without it, the ALB can hand a request to a socket the
                    # app already closed — a 502 with no application-level
                    # error, since the app never saw the request. Kept a
                    # little above the ALB's timeout so the ALB always closes
                    # (or reuses) the connection first, per AWS's guidance.
                    "KEEP_ALIVE_TIMEOUT": KEEP_ALIVE_TIMEOUT_MS,
                },
                # `field=` is what makes ECS extract a single JSON key rather
                # than handing over the whole secret. Only the credentials go
                # through Secrets Manager; the endpoint and database name above
                # aren't secret and stay readable in the console.
                secrets={
                    "DATABASE_USER": ecs.Secret.from_secrets_manager(db_secret, field="username"),
                    "DATABASE_PASSWORD": ecs.Secret.from_secrets_manager(db_secret, field="password"),
                    "CLERK_SECRET_KEY": ecs.Secret.from_secrets_manager(self.clerk_secret),
                },
            ),
        )
        self.service.target_group.configure_health_check(
            path="/api/v1/healthz",
            port=str(CONTAINER_PORT),
        )

        # Without this the service sits at a fixed single task.
        scaling = self.service.service.auto_scale_task_count(min_capacity=1, max_capacity=3)
        scaling.scale_on_cpu_utilization("CpuScaling", target_utilization_percent=60)
