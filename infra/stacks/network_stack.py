import aws_cdk as cdk
from aws_cdk import aws_ec2 as ec2
from constructs import Construct


class NetworkStack(cdk.Stack):
    """VPC, subnets, and security groups (plan §6). Deliberately minimal — one
    VPC with public + private-with-egress subnets across 2 AZs, no NAT
    redundancy or multi-AZ complexity, since this is a low-traffic portfolio
    project, not a production-scale service.
    """

    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        # Explicit AZs rather than max_azs, which needs an account/region
        # lookup (a real AWS call) to enumerate available AZs — this way
        # `cdk synth` works without live credentials. Still just 2 AZs, same
        # as intended.
        self.vpc = ec2.Vpc(
            self,
            "Vpc",
            availability_zones=[f"{self.region}a", f"{self.region}b"],
            nat_gateways=1,
            subnet_configuration=[
                ec2.SubnetConfiguration(name="public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="private", subnet_type=ec2.SubnetType.PRIVATE_WITH_EGRESS, cidr_mask=24),
            ],
        )

        # CloudFormation's GroupDescription pattern disallows several common
        # punctuation characters (e.g. ">", the unicode em dash "—") that
        # are easy to reach for by habit — plain ASCII only below.
        #
        # Passed to the ALB in BackendStack, but declared here so that both
        # ends of the ALB-to-tasks ingress rule live in one stack. That rule is
        # not written by hand anywhere: ApplicationLoadBalancedFargateService
        # registers the target group as a connectable, and CDK derives the rule
        # from the container port. Declaring this group in BackendStack instead
        # makes `cdk synth` fail outright — the rule's source would be a
        # BackendStack group while its target (backend_security_group) is a
        # NetworkStack one, and BackendStack already depends on NetworkStack,
        # so CDK reports a DependencyCycle.
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
