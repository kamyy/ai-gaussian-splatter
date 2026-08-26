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

        # Explicit AZs rather than max_azs, which needs an account/region lookup (a real AWS call) to enumerate
        # available AZs. This way `cdk synth` works without live credentials. Still just 2 AZs, same as intended.
        #
        # nat_gateways=0: everything needing outbound internet (the web tasks, the GPU workers) runs in the public
        # subnets with a public IP and egresses through the internet gateway instead — ARCHITECTURE.md has the cost
        # reasoning. The security groups, not the absence of a route, are therefore what keep those tasks unreachable
        # from outside. The isolated subnets hold only RDS, which needs no outbound access.
        self.vpc = ec2.Vpc(
            self,
            "Vpc",
            availability_zones=[f"{self.region}a", f"{self.region}b"],
            nat_gateways=0,
            subnet_configuration=[
                ec2.SubnetConfiguration(name="public", subnet_type=ec2.SubnetType.PUBLIC, cidr_mask=24),
                ec2.SubnetConfiguration(name="private", subnet_type=ec2.SubnetType.PRIVATE_ISOLATED, cidr_mask=24),
            ],
            # A route table entry, not a billed endpoint — free, unlike the interface kind. With nat_gateways=0 every S3
            # call otherwise leaves through the internet gateway, including the workers' multi-GB splat uploads; this
            # keeps them on AWS's network.
            gateway_endpoints={
                "S3": ec2.GatewayVpcEndpointOptions(service=ec2.GatewayVpcEndpointAwsService.S3),
            },
        )

        # CloudFormation's GroupDescription disallows several common punctuation characters (e.g. ">", em dash "—") —
        # plain ASCII only below.
        #
        # Declared here, not in WebStack, so both ends of the auto-generated ALB-to-tasks ingress rule live in one
        # stack. Declaring this group in WebStack instead fails `cdk synth` with a DependencyCycle (see AGENTS.md). This
        # is also why web_stack.py builds its ALB manually rather than via the CDK pattern. The pattern would create its
        # own security group instead of using this one.
        self.alb_security_group = ec2.SecurityGroup(
            self,
            "AlbSecurityGroup",
            vpc=self.vpc,
            description="Public ALB in front of the web ECS service",
            allow_all_outbound=True,
        )
        # The app's only route in from the internet, and the only rule in this file that names a public CIDR. Written
        # out rather than left to the ecs-patterns construct, which stops adding it once the service is handed explicit
        # security groups (feature flag aws-ecs-patterns:secGroupsDisablesImplicitOpenListener). The symptom is an ALB
        # that provisions cleanly and refuses every connection. Port 80 is the redirect listener; it never reaches a
        # task.
        self.alb_security_group.add_ingress_rule(ec2.Peer.any_ipv4(), ec2.Port.tcp(443), "HTTPS from anyone")
        self.alb_security_group.add_ingress_rule(ec2.Peer.any_ipv4(), ec2.Port.tcp(80), "HTTP from anyone, redirected")

        # Receives the generated ALB-to-tasks rule described above, and gives the web tasks a stable identity that
        # db_security_group's own ingress rule can name as a source. Security-group references check ENI membership,
        # not the referenced group's own rules.
        self.web_security_group = ec2.SecurityGroup(
            self,
            "WebSecurityGroup",
            vpc=self.vpc,
            description="Web ECS service to RDS",
            allow_all_outbound=True,
        )

        self.worker_security_group = ec2.SecurityGroup(
            self,
            "WorkerSecurityGroup",
            vpc=self.vpc,
            description="GPU spot worker instances, outbound only (S3, web callback)",
            allow_all_outbound=True,
        )

        self.db_security_group = ec2.SecurityGroup(
            self,
            "DbSecurityGroup",
            vpc=self.vpc,
            description="RDS Postgres, inbound only from the web ECS service",
            allow_all_outbound=False,
        )
        self.db_security_group.add_ingress_rule(
            self.web_security_group,
            ec2.Port.tcp(5432),
            "Web to Postgres",
        )
