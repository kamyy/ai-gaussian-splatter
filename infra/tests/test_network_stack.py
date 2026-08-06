from aws_cdk.assertions import Match, Template

# Security-group-to-security-group rules are always emitted as standalone
# AWS::EC2::SecurityGroupIngress resources; only CIDR peers are eligible to be
# inlined onto the group itself. Both rules asserted below are SG-to-SG, so
# they are counted here, while the ALB's own 0.0.0.0/0 rules are asserted as
# inline properties further down.
SECURITY_GROUP_INGRESS = "AWS::EC2::SecurityGroupIngress"


def test_backend_security_group_has_exactly_one_ingress_rule_from_alb(wired_stacks):
    """The backend tasks must be reachable only from the load balancer. They
    run in private subnets with no public IP, so the ALB is their sole ingress
    path.

    The rule itself is generated, not hand-written: the load-balanced Fargate
    pattern registers the target group as a connectable and CDK derives the
    rule from the container port. What this asserts is that exactly one such
    rule exists — a second would be a route around the load balancer.
    """
    template = Template.from_stack(wired_stacks["network"])

    security_groups = template.find_resources(
        "AWS::EC2::SecurityGroup",
        {"Properties": {"GroupDescription": "Backend ECS service to RDS"}},
    )
    assert len(security_groups) == 1
    backend_sg_logical_id, backend_sg_props = next(iter(security_groups.items()))

    # A CIDR peer added directly to this group (e.g. via add_ingress_rule)
    # inlines onto the group's own SecurityGroupIngress property instead of
    # synthesizing as a standalone resource, so the standalone-resource count
    # below would not catch it — this rules that route out too.
    assert "SecurityGroupIngress" not in backend_sg_props["Properties"]

    ingress_rules = template.find_resources(SECURITY_GROUP_INGRESS)
    targeting_backend_sg = [
        r
        for r in ingress_rules.values()
        if r["Properties"].get("GroupId", {}).get("Fn::GetAtt", [None])[0] == backend_sg_logical_id
    ]
    assert len(targeting_backend_sg) == 1

    (rule,) = targeting_backend_sg
    assert rule["Properties"]["IpProtocol"] == "tcp"
    assert rule["Properties"]["FromPort"] == 8000
    assert rule["Properties"]["ToPort"] == 8000
    assert rule["Properties"]["Description"] == "Load balancer to target"
    # An SG source, not a CIDR — nothing outside the ALB may reach the tasks.
    assert "SourceSecurityGroupId" in rule["Properties"]
    assert "CidrIp" not in rule["Properties"]


def test_db_security_group_has_exactly_one_ingress_rule_from_backend(wired_stacks):
    template = Template.from_stack(wired_stacks["network"])

    security_groups = template.find_resources(
        "AWS::EC2::SecurityGroup",
        {"Properties": {"GroupDescription": "RDS Postgres, inbound only from the backend ECS service"}},
    )
    assert len(security_groups) == 1
    (db_sg_props,) = security_groups.values()

    # Same rationale as the backend SG check above: a CIDR peer added directly
    # to this group would inline onto its own properties instead of
    # synthesizing as a standalone resource, so the count below alone
    # wouldn't catch it.
    assert "SecurityGroupIngress" not in db_sg_props["Properties"]

    # The backend-from-ALB rule and this one; see SECURITY_GROUP_INGRESS above.
    template.resource_count_is(SECURITY_GROUP_INGRESS, 2)
    template.has_resource_properties(
        SECURITY_GROUP_INGRESS,
        {
            "IpProtocol": "tcp",
            "FromPort": 5432,
            "ToPort": 5432,
            "Description": "Backend to Postgres",
            "GroupId": Match.any_value(),
            "SourceSecurityGroupId": Match.any_value(),
        },
    )


def test_alb_security_group_is_the_only_one_open_to_the_internet(wired_stacks):
    """The ALB is the single internet-facing component, so it is the only
    security group allowed a 0.0.0.0/0 rule — and only on the two listener
    ports.
    """
    template = Template.from_stack(wired_stacks["network"])

    open_ports_by_group = {
        logical_id: sorted(
            # An all-traffic rule synthesizes as IpProtocol "-1" with no
            # FromPort at all. It must register as exposure rather than raise
            # a KeyError, so it stands in as -1 and fails the check below.
            rule.get("FromPort", -1)
            for rule in (props["Properties"].get("SecurityGroupIngress") or [])
            # Both families, so an IPv6 rule can't slip past an IPv4-only check.
            if rule.get("CidrIp") == "0.0.0.0/0" or rule.get("CidrIpv6") == "::/0"
        )
        for logical_id, props in template.find_resources("AWS::EC2::SecurityGroup").items()
    }
    groups_open_to_internet = {k: v for k, v in open_ports_by_group.items() if v}

    assert len(groups_open_to_internet) == 1
    (open_ports,) = groups_open_to_internet.values()
    assert open_ports == [80, 443]
    assert "Alb" in next(iter(groups_open_to_internet))
