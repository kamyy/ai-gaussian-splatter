import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2
from aws_cdk import aws_ecr as ecr
from aws_cdk import aws_ecs as ecs
from aws_cdk import aws_iam as iam
from aws_cdk import aws_rds as rds
from aws_cdk import aws_s3 as s3
from constructs import Construct

from stacks.tags import WORKER_TAG_KEY, WORKER_TAG_VALUE

# Single source of truth for the FastAPI container's listen port — used by
# both the task definition and the health check path below, so they can't
# drift out of sync with each other.
CONTAINER_PORT = 8000

key_value_pair = ecs.CfnExpressGatewayService.KeyValuePairProperty


class BackendStack(cdk.Stack):
    """FastAPI backend on ECS Express Mode (`AWS::ECS::ExpressGatewayService`) —
    App Runner's replacement, since App Runner stopped accepting new customers
    2026-04-30. Express Mode auto-provisions the ECS cluster/service, ALB,
    security groups, and auto-scaling from a single resource, aiming at the
    same "no hand-wired orchestration" DX App Runner had.

    Only an L1 construct (`CfnExpressGatewayService`) exists as of
    aws-cdk-lib 2.262 — no L2 yet (tracked in aws/aws-cdk#36234) — so, same as
    the App Runner resources this replaces, config is explicit with no L2
    conveniences.
    """

    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.Vpc,
        backend_security_group: ec2.SecurityGroup,
        database: rds.DatabaseInstance,
        uploads_bucket: s3.Bucket,
        splats_bucket: s3.Bucket,
        worker_ami_id: str,
        worker_instance_profile_arn: str,
        worker_role_arn: str,
        worker_security_group_id: str,
        worker_subnet_id: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, id, **kwargs)

        self.repository = ecr.Repository(
            self,
            "BackendRepository",
            repository_name="ai-gaussian-splatter-backend",
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        # Lets ECS provision the ALB/security groups/auto-scaling on this
        # service's behalf. Trust + managed policy per AWS's Express Mode setup
        # docs — this role is assumed by the ECS control plane, not the running
        # container.
        infrastructure_role = iam.Role(
            self,
            "ExpressInfrastructureRole",
            assumed_by=iam.ServicePrincipal("ecs.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name(
                    "service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
                ),
            ],
        )

        # Pulls the container image and writes logs — also the role ECS uses to
        # fetch the DATABASE_URL secret's value before handing it to the
        # container as an env var, so the DB secret grant belongs here, not on
        # the task role.
        #
        # Deliberately not using the AmazonECSTaskExecutionRolePolicy managed
        # policy: its JSON (verified against AWS's managed policy reference)
        # grants ecr:GetAuthorizationToken, logs:CreateLogStream, and
        # logs:PutLogEvents at Resource: "*" — all three are unavoidably
        # account-wide (GetAuthorizationToken isn't resource-scopable; ECS
        # doesn't know the log group ahead of time) — but it also grants the
        # actual image-pull actions (BatchCheckLayerAvailability,
        # GetDownloadUrlForLayer, BatchGetImage) at Resource: "*", i.e. read
        # access to every ECR repo in the account. Reconstructed below: the two
        # unavoidably-broad logs actions explicitly, and GetAuthorizationToken
        # comes along for free from grant_pull, which scopes the real pull
        # actions to this one repository instead of every repo in the account.
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
        self.repository.grant_pull(execution_role)  # also grants ecr:GetAuthorizationToken (Resource: "*", unavoidably)
        # database.secret is always populated — credentials come from
        # from_generated_secret in data_stack.py — so this is safe to assert
        # once and reuse, rather than encoding the same invariant two
        # different ways.
        assert database.secret is not None
        db_secret = database.secret
        db_secret.grant_read(execution_role)

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

        ecs.CfnExpressGatewayService(
            self,
            "Service",
            service_name="ai-gaussian-splatter-backend",
            infrastructure_role_arn=infrastructure_role.role_arn,
            execution_role_arn=execution_role.role_arn,
            task_role_arn=task_role.role_arn,
            cpu="256",  # 0.25 vCPU, matching the App Runner sizing this replaces
            memory="512",  # 0.5 GB
            # Express Mode's healthCheckPath is PROTOCOL:PORT/PATH (CDK's own
            # default is "HTTP:80/ping"), not a bare path.
            health_check_path=f"HTTP:{CONTAINER_PORT}/api/v1/healthz",
            # Express Mode requires subnets with an Internet Gateway route to
            # provision an internet-facing ALB. Providing public subnets also
            # auto-enables assignPublicIp on the Fargate tasks themselves, which
            # is what lets them reach AWS APIs (S3, EC2 RunInstances) without a
            # NAT gateway — verified against AWS's docs ("Resources created by
            # Amazon ECS Express Mode services" > Network configuration
            # defaults): "If you provide custom public subnets, Express Mode
            # will provision an internet-facing ALB and turn on assignPublicIP
            # for your tasks." Private subnets would leave both the ALB internal
            # and the tasks' own outbound calls broken (assignPublicIp is
            # disabled for private subnets per the same doc, making you
            # responsible for a NAT gateway yourself).
            network_configuration=ecs.CfnExpressGatewayService.ExpressGatewayServiceNetworkConfigurationProperty(
                subnets=[subnet.subnet_id for subnet in vpc.public_subnets],
                security_groups=[backend_security_group.security_group_id],
            ),
            # Bounded auto-scaling — matches the "auto-scaling like App Runner
            # had" intent; without this it defaults to a fixed single task.
            scaling_target=ecs.CfnExpressGatewayService.ExpressGatewayScalingTargetProperty(
                min_task_count=1,
                max_task_count=3,
            ),
            primary_container=ecs.CfnExpressGatewayService.ExpressGatewayContainerProperty(
                image=f"{self.repository.repository_uri}:latest",
                container_port=CONTAINER_PORT,
                environment=[
                    key_value_pair(name="UPLOADS_BUCKET", value=uploads_bucket.bucket_name),
                    key_value_pair(name="SPLATS_BUCKET", value=splats_bucket.bucket_name),
                    key_value_pair(name="WORKER_AMI_ID", value=worker_ami_id),
                    key_value_pair(name="WORKER_SUBNET_ID", value=worker_subnet_id),
                    key_value_pair(name="WORKER_SECURITY_GROUP_ID", value=worker_security_group_id),
                    key_value_pair(name="WORKER_INSTANCE_PROFILE_ARN", value=worker_instance_profile_arn),
                ],
                secrets=[
                    ecs.CfnExpressGatewayService.SecretProperty(name="DATABASE_URL", value_from=db_secret.secret_arn)
                ],
            ),
        )
