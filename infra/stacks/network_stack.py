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
        # Deliberately has no ingress rule of its own. Per AWS's Express Mode
        # docs (Resources created by Amazon ECS Express Mode services —
        # "networkConfiguration.SecurityGroups"), Express Mode always creates
        # its own Load Balancer + Service security group pair with minimal
        # required ingress, regardless of what's passed in; a security group
        # you provide is only an *additional* ingress path, not a replacement.
        # So this group needs no ingress rule of its own — its only job is to
        # give the backend tasks a stable identity that db_security_group's
        # own ingress rule below can reference as a source, since
        # security-group references check ENI membership, not the referenced
        # group's own rules.
        self.backend_security_group = ec2.SecurityGroup(
            self,
            "BackendSecurityGroup",
            vpc=self.vpc,
            description="ECS Express Mode backend service to RDS",
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
            description="RDS Postgres, inbound only from the backend ECS Express Mode service",
            allow_all_outbound=False,
        )
        self.db_security_group.add_ingress_rule(
            self.backend_security_group,
            ec2.Port.tcp(5432),
            "Backend (ECS Express Mode service) to Postgres",
        )
