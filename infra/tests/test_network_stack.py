from aws_cdk.assertions import Match, Template


def test_backend_security_group_has_no_ingress_rules(wired_stacks):
    """Regression test: backend_security_group must have zero ingress rules
    of its own — Express Mode auto-creates its own correctly-scoped SG pair,
    so any rule here would only be redundant over-exposure (fixed bug).
    """
    template = Template.from_stack(wired_stacks["network"])

    security_groups = template.find_resources(
        "AWS::EC2::SecurityGroup",
        {"Properties": {"GroupDescription": "ECS Express Mode backend service to RDS"}},
    )
    assert len(security_groups) == 1
    (sg_props,) = security_groups.values()
    assert not sg_props["Properties"].get("SecurityGroupIngress")

    ingress_rules = template.find_resources("AWS::EC2::SecurityGroupIngress")
    backend_sg_logical_id = next(iter(security_groups))
    referencing_backend_sg = [
        r
        for r in ingress_rules.values()
        if r["Properties"].get("GroupId", {}).get("Fn::GetAtt", [None])[0] == backend_sg_logical_id
    ]
    assert referencing_backend_sg == []


def test_db_security_group_has_exactly_one_ingress_rule_from_backend(wired_stacks):
    template = Template.from_stack(wired_stacks["network"])

    template.resource_count_is("AWS::EC2::SecurityGroupIngress", 1)
    template.has_resource_properties(
        "AWS::EC2::SecurityGroupIngress",
        {
            "IpProtocol": "tcp",
            "FromPort": 5432,
            "ToPort": 5432,
            "Description": "Backend (ECS Express Mode service) to Postgres",
            "GroupId": Match.any_value(),
            "SourceSecurityGroupId": Match.any_value(),
        },
    )
