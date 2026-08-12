import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2
from constructs import Construct


class NetworkStack(cdk.Stack):
    """VPC, subnets, and security groups. Deliberately minimal — one
    VPC with public + isolated subnets across 2 AZs, no NAT gateway or
    multi-AZ complexity, since this is a low-traffic portfolio project, not a
    production-scale service.
    """

    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        # Explicit AZs rather than max_azs, which needs an account/region
        # lookup (a real AWS call) to enumerate available AZs — this way
        # `cdk synth` works without live credentials. Still just 2 AZs, same
        # as intended.
        #
        # nat_gateways=0: everything needing outbound internet (the backend
        # tasks, the GPU workers) runs in the public subnets with a public IP
        # and egresses through the internet gateway instead — ARCHITECTURE.md
        # has the cost reasoning. The security groups, not the absence of a
        # route, are therefore what keep those tasks unreachable from outside.
        # The isolated subnets hold only RDS, which needs no outbound access.
        self.vpc = ec2.Vpc(
            self,
            "Vpc",
            availability_zones=[f"{self.region}a", f"{self.region}b"],
            nat_gateways=0,
            subnet_configuration=[
                ec2.SubnetConfiguration(name="public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="private", subnet_type=ec2.SubnetType.PRIVATE_ISOLATED, cidr_mask=24),
            ],
        )

        # CloudFormation's GroupDescription disallows several common
        # punctuation characters (e.g. ">", em dash "—") — plain ASCII only
        # below.
        #
        # Declared here, not in BackendStack, so both ends of the
        # auto-generated ALB-to-tasks ingress rule live in one stack —
        # declaring this group in BackendStack instead fails `cdk synth` with a
        # DependencyCycle (see AGENTS.md). This is also why backend_stack.py
        # builds its ALB manually rather than via the CDK pattern — the pattern
        # would create its own security group instead of using this one.
        self.alb_security_group = ec2.SecurityGroup(
            self,
            "AlbSecurityGroup",
            vpc=self.vpc,
            description="Public ALB in front of the backend ECS service",
            allow_all_outbound=True,
        )

        # Receives the generated ALB-to-tasks rule described above, and gives
        # the backend tasks a stable identity that db_security_group's own
        # ingress rule can name as a source — security-group references check
        # ENI membership, not the referenced group's own rules.
        self.backend_security_group = ec2.SecurityGroup(
            self,
            "BackendSecurityGroup",
            vpc=self.vpc,
            description="Backend ECS service to RDS",
            allow_all_outbound=True,
        )

        self.worker_security_group = ec2.SecurityGroup(
            self,
            "WorkerSecurityGroup",
            vpc=self.vpc,
            description="GPU spot worker instances, outbound only (S3, backend callback)",
            allow_all_outbound=True,
        )

        self.db_security_group = ec2.SecurityGroup(
            self,
            "DbSecurityGroup",
            vpc=self.vpc,
            description="RDS Postgres, inbound only from the backend ECS service",
            allow_all_outbound=False,
        )
        self.db_security_group.add_ingress_rule(
            self.backend_security_group,
            ec2.Port.tcp(5432),
            "Backend to Postgres",
        )
