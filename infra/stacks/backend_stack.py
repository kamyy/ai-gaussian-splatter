import re

import aws_cdk as cdk
from aws_cdk import aws_certificatemanager as acm
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_ecs_patterns as ecs_patterns
from aws_cdk import aws_elasticloadbalancingv2 as elbv2
from aws_cdk import aws_iam as iam
from aws_cdk import aws_logs as logs
from aws_cdk import aws_rds as rds
from aws_cdk import aws_route53 as route53
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_secretsmanager as secretsmanager
from constructs import Construct

from stacks.data_stack import DATABASE_NAME
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
# so `aws ecs update-service --force-new-deployment` — which a Clerk key
# rotation still needs, since that changes no template — can be written down
# literally in RUNBOOK.md instead of looked up per environment.
CLUSTER_NAME = "ai-gaussian-splatter"
SERVICE_NAME = "ai-gaussian-splatter-backend"

# Must stay above the ALB's own idle timeout (60s, left at the CDK default
# below) or the ALB serves intermittent 502s — see AGENTS.md.
KEEP_ALIVE_TIMEOUT_MS = "65000"

# Clerk's server-side API key is created out of band before this stack exists
# (RUNBOOK.md) and only read here. Naming it once lets the RUNBOOK's
# create-secret command and the ARN check below agree by construction.
CLERK_SECRET_NAME = "ai-gaussian-splatter/clerk-secret-key"


class BackendStack(cdk.Stack):
    """The Next.js app (pages + the REST API as Route Handlers) on Fargate,
    behind an internet-facing Application Load Balancer.

    The tasks share the public subnets with the ALB and carry a public IP, so
    their calls to S3 and the EC2 API egress through the internet gateway
    rather than a NAT gateway (see network_stack.py for the cost reasoning).
    Nothing can open a connection to them regardless: backend_security_group
    admits only alb_security_group. TLS terminates at the ALB with an ACM
    certificate for APP_HOSTNAME, and plain HTTP is redirected to HTTPS.
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
        access_logs_bucket: s3.Bucket,
        worker_ami_id: str,
        worker_instance_profile_arn: str,
        worker_role_arn: str,
        worker_security_group_id: str,
        worker_subnet_id: str,
        app_public_url: str,
        hosted_zone_id: str,
        clerk_secret_arn: str,
        image_tag: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        # Clerk's server-side API key, imported rather than created: it holds a
        # third party's credential, so it is set once by hand and this stack
        # only reads it. Creating it here instead would fill it with a random
        # value on the first deploy and force a second rollout to replace that
        # with the real key, since ECS resolves secrets at task start.
        #
        # Its public counterpart, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, is
        # deliberately absent: it is a `docker build --build-arg` in
        # web/Dockerfile, not a runtime env var — see AGENTS.md.
        #
        # CloudFormation never validates an imported ARN, so a wrong one is
        # invisible until a task fails to start. Checked here instead. The
        # account and region are this stack's own, which is what makes a
        # forgotten `-c clerkSecretArn=` fail: app.py's placeholder names the
        # placeholder account and matches nothing real. The trailing six
        # characters are Secrets Manager's own suffix — ECS wants the complete
        # ARN, and a partial one pasted without it is the likeliest typo.
        expected = rf"arn:aws:secretsmanager:{self.region}:{self.account}:secret:{CLERK_SECRET_NAME}-\w{{6}}"
        if re.fullmatch(expected, clerk_secret_arn) is None:
            raise ValueError(
                f"clerkSecretArn must be the complete ARN of {CLERK_SECRET_NAME} in "
                f"{self.account}/{self.region}, as returned by `aws secretsmanager create-secret` "
                f"(see RUNBOOK.md); got {clerk_secret_arn!r}"
            )
        clerk_secret = secretsmanager.Secret.from_secret_complete_arn(self, "ClerkSecretKey", clerk_secret_arn)

        # The image tag has to identify one immutable build, which is why a
        # commit SHA is the only accepted shape. A moving tag like `latest`
        # would leave every task definition naming the same string, so the
        # deployment circuit breaker's rollback would restart the previous
        # deployment against it and Fargate would re-pull the image that just
        # failed — the rollback restores the configuration faithfully, but the
        # configuration would not identify an image. RegistryStack additionally
        # refuses to let a pushed tag be repointed.
        if re.fullmatch(r"[0-9a-f]{7,40}", image_tag) is None:
            raise ValueError(
                f"imageTag must be a commit SHA identifying one immutable build, "
                f"not a moving tag (see RUNBOOK.md); got {image_tag!r}"
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
        clerk_secret.grant_read(execution_role)

        # The running application code's own permissions — S3 rw on both
        # buckets, ec2:RunInstances/TerminateInstances scoped by tag.
        task_role = iam.Role(
            self,
            "TaskRole",
            assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        )
        uploads_bucket.grant_read_write(task_role)
        splats_bucket.grant_read_write(task_role)
        # RunInstances is authorized against every resource the request touches,
        # each one separately. Only the instance carries the worker tag
        # (ec2Launcher.ts tags ResourceType "instance"), so aws:RequestTag is
        # absent from the request context for the rest — a single statement
        # conditioned on that key would evaluate false for them and deny the
        # whole call. Hence the split: the tag constrains what can be launched,
        # this statement only names what it is launched from and into.
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:RunInstances"],
                resources=[
                    # AMIs are not account-scoped, hence the empty account.
                    self.format_arn(service="ec2", resource="image", resource_name="*", account=""),
                    self.format_arn(service="ec2", resource="subnet", resource_name="*"),
                    self.format_arn(service="ec2", resource="security-group", resource_name="*"),
                    self.format_arn(service="ec2", resource="network-interface", resource_name="*"),
                    self.format_arn(service="ec2", resource="volume", resource_name="*"),
                    self.format_arn(service="ec2", resource="key-pair", resource_name="*"),
                    # Only evaluated at all if the spot request itself is
                    # tagged on create, which ec2Launcher.ts does not do — but
                    # adding one tag specification for it would otherwise start
                    # failing every launch with nothing to point at.
                    self.format_arn(service="ec2", resource="spot-instances-request", resource_name="*"),
                ],
            )
        )
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:RunInstances"],
                resources=[self.format_arn(service="ec2", resource="instance", resource_name="*")],
                conditions={"StringEquals": {f"aws:RequestTag/{WORKER_TAG_KEY}": WORKER_TAG_VALUE}},
            )
        )
        # A request carrying TagSpecifications is authorized a second time
        # against ec2:CreateTags, separately from RunInstances — without this
        # the launch fails even though the statements above allow it. The
        # ec2:CreateAction condition keeps it from becoming a general
        # tag-anything grant: it only applies to tags applied at launch.
        task_role.add_to_policy(
            iam.PolicyStatement(
                actions=["ec2:CreateTags"],
                resources=[self.format_arn(service="ec2", resource="*", resource_name="*")],
                conditions={"StringEquals": {"ec2:CreateAction": "RunInstances"}},
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
        # Never from_lookup() — see AGENTS.md.
        hosted_zone = route53.HostedZone.from_hosted_zone_attributes(
            self,
            "HostedZone",
            hosted_zone_id=hosted_zone_id,
            zone_name=DOMAIN_ZONE_NAME,
        )

        # Declared inline so the certificate lands in the ALB's own region,
        # which is the only region an ALB can reference — see AGENTS.md.
        certificate = acm.Certificate(
            self,
            "Certificate",
            domain_name=APP_HOSTNAME,
            validation=acm.CertificateValidation.from_dns(hosted_zone),
        )

        # Built manually rather than via the CDK pattern, so its security
        # group can be the one NetworkStack owns — see AGENTS.md for why the
        # pattern's own group would cause a DependencyCycle.
        self.load_balancer = elbv2.ApplicationLoadBalancer(
            self,
            "LoadBalancer",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_security_group,
            vpc_subnets=ec2.SubnetSelection(subnets=vpc.public_subnets),
            # Headers that don't parse are dropped rather than passed to the
            # app, so request smuggling can't be assembled out of them.
            drop_invalid_header_fields=True,
        )
        # The only record of who called: the app logs its own handlers, not the
        # requests the ALB rejected or redirected before reaching them.
        self.load_balancer.log_access_logs(access_logs_bucket)

        # Fargate capacity providers must be enabled on the cluster before the
        # service below can name FARGATE_SPOT in a strategy.
        cluster = ecs.Cluster(
            self,
            "Cluster",
            vpc=vpc,
            cluster_name=CLUSTER_NAME,
            enable_fargate_capacity_providers=True,
            # Exec sessions otherwise default to logging through the container's
            # awslogs driver, which needs four logs actions on the task role
            # that CDK does not add — the session works and silently records
            # nothing. Nothing here needs an audit trail of debugging sessions,
            # so turn the logging off rather than widen the task role.
            execute_command_configuration=ecs.ExecuteCommandConfiguration(
                logging=ecs.ExecuteCommandLogging.NONE,
            ),
        )

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
            # Must stay set explicitly — an unset ssl_policy is not this
            # value, it is the weak 2016-08 default. See AGENTS.md.
            ssl_policy=elbv2.SslPolicy.RECOMMENDED_TLS,
            cpu=256,  # 0.25 vCPU
            memory_limit_mib=512,
            # ~70% off on-demand Fargate, accepting two exposures that come
            # with it: a reclaim stops the task about two minutes after its
            # notice, and at desired_count 1 there is no other task in the
            # target group, so the site 503s until a replacement passes health
            # checks; and a Spot capacity shortage in the region leaves ECS
            # unable to place a task at all. min_healthy_percent below governs
            # deployments only and does not cover either case. No on-demand
            # `base` because a base of 1 against a single-task service would
            # put every task on on-demand and save nothing.
            capacity_provider_strategies=[
                ecs.CapacityProviderStrategy(capacity_provider="FARGATE_SPOT", weight=1),
            ],
            # Mutually exclusive with `vpc`: the pattern creates a cluster of
            # its own when given a VPC, and that one gets a generated name.
            cluster=cluster,
            # Public subnets with a public IP, so outbound calls to S3 and the
            # EC2 API reach the internet gateway directly instead of needing a
            # NAT gateway. Without assign_public_ip the tasks cannot pull from
            # ECR at all and the deployment hangs until the circuit breaker
            # trips. backend_security_group is what keeps them unreachable.
            task_subnets=ec2.SubnetSelection(subnets=vpc.public_subnets),
            assign_public_ip=True,
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
            # `aws ecs execute-command` into a running task. The alternative
            # when a deploy misbehaves is reading CloudWatch and guessing;
            # CDK adds the ssmmessages actions to the task role itself.
            enable_execute_command=True,
            # The default 50% floors to zero healthy tasks at desired_count 1,
            # letting ECS stop the only running task before its replacement
            # passes health checks — a window of 503s on every deploy.
            min_healthy_percent=100,
            task_image_options=ecs_patterns.ApplicationLoadBalancedTaskImageOptions(
                # from_ecr_repository rather than from_registry: it reads the
                # repository's ARN to scope the execution role's pull grant,
                # instead of treating the URI as an opaque public image name.
                image=ecs.ContainerImage.from_ecr_repository(repository, tag=image_tag),
                container_port=CONTAINER_PORT,
                execution_role=execution_role,
                task_role=task_role,
                # Passed explicitly only for the retention: the log group the
                # pattern creates on its own keeps every line forever. The
                # group itself is still retained on stack delete.
                log_driver=ecs.LogDriver.aws_logs(
                    stream_prefix="web",
                    log_retention=logs.RetentionDays.ONE_MONTH,
                ),
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
                    # rather than an assembled URL — web/lib/server/databaseUrl.ts
                    # builds the URL from these plus the two secrets below. See
                    # AGENTS.md for why ECS can't assemble it here.
                    "DATABASE_HOST": database.db_instance_endpoint_address,
                    "DATABASE_PORT": database.db_instance_endpoint_port,
                    "DATABASE_NAME": DATABASE_NAME,
                    # Turns on TLS verification against RDS with the CA bundle
                    # web/Dockerfile bakes into the image (see AGENTS.md). An
                    # env var rather than a hardcoded path so a locally-run
                    # container can still talk to a plain Postgres.
                    "DATABASE_SSL_CA": RDS_CA_BUNDLE_PATH,
                    # Read by Next's standalone server.js to override Node's
                    # 5s idle-socket close, which the ALB outlives — see
                    # AGENTS.md.
                    "KEEP_ALIVE_TIMEOUT": KEEP_ALIVE_TIMEOUT_MS,
                },
                # Only the credentials go through Secrets Manager; the endpoint
                # and database name above aren't secret and stay readable in
                # the console.
                secrets={
                    "DATABASE_USER": ecs.Secret.from_secrets_manager(db_secret, field="username"),
                    "DATABASE_PASSWORD": ecs.Secret.from_secrets_manager(db_secret, field="password"),
                    "CLERK_SECRET_KEY": ecs.Secret.from_secrets_manager(clerk_secret),
                },
            ),
        )
        # Otherwise the first deploy is a race. enable_fargate_capacity_providers
        # emits a ClusterCapacityProviderAssociations resource, and both it and
        # the service only Ref the cluster — nothing orders them — so
        # CloudFormation may create the service first, and CreateService naming
        # a capacity provider the cluster has no association for yet fails.
        # The associations resource is a child of the Cluster construct, so
        # depending on the construct is what covers it.
        self.service.service.node.add_dependency(cluster)

        self.service.target_group.configure_health_check(
            path="/api/v1/healthz",
            port=str(CONTAINER_PORT),
        )
        # The default 300s is a floor on how long every deployment takes to
        # retire a task. Nothing here holds a long-lived request, so draining
        # is only about letting in-flight ones finish.
        self.service.target_group.set_attribute("deregistration_delay.timeout_seconds", "30")

        # Without this the service sits at a fixed single task.
        scaling = self.service.service.auto_scale_task_count(min_capacity=1, max_capacity=3)
        scaling.scale_on_cpu_utilization("CpuScaling", target_utilization_percent=60)
