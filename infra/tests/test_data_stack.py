from aws_cdk.assertions import Match, Template


def test_database_config(wired_stacks):
    template = Template.from_stack(wired_stacks["data"])

    template.has_resource_properties(
        "AWS::RDS::DBInstance",
        {
            "Engine": "postgres",
            "EngineVersion": "18",
            "DBInstanceClass": "db.t4g.micro",
            "MultiAZ": False,
            "AllocatedStorage": "20",
            "StorageEncrypted": True,
            "PreferredMaintenanceWindow": "sun:10:00-sun:10:30",
            "DeletionProtection": False,
        },
    )


def test_uploads_bucket_has_90_day_lifecycle_rule(wired_stacks):
    template = Template.from_stack(wired_stacks["data"])

    template.has_resource_properties(
        "AWS::S3::Bucket",
        {
            "CorsConfiguration": Match.any_value(),
            "LifecycleConfiguration": {"Rules": [Match.object_like({"ExpirationInDays": 90, "Status": "Enabled"})]},
        },
    )


def test_splats_bucket_has_no_lifecycle_rule(wired_stacks):
    template = Template.from_stack(wired_stacks["data"])

    buckets = template.find_resources("AWS::S3::Bucket")
    without_lifecycle = [props for props in buckets.values() if "LifecycleConfiguration" not in props["Properties"]]
    assert len(without_lifecycle) == 1


def test_splats_bucket_allows_cross_origin_reads(wired_stacks):
    """The viewer fetches the .ply from S3 in the browser, so without a GET
    rule every splat fails to load — and nothing in the TypeScript suite would
    catch it, since the presigned URL itself is valid.
    """
    template = Template.from_stack(wired_stacks["data"])

    buckets = template.find_resources("AWS::S3::Bucket")
    (splats_props,) = [props for props in buckets.values() if "LifecycleConfiguration" not in props["Properties"]]
    (cors_rule,) = splats_props["Properties"]["CorsConfiguration"]["CorsRules"]

    assert sorted(cors_rule["AllowedMethods"]) == ["GET", "HEAD"]


def test_bucket_cors_origin_drops_a_trailing_slash():
    """appPublicUrl is a base URL, so a trailing slash on it is harmless
    everywhere except here: S3 matches the browser's Origin header exactly, so
    an un-normalized value would reject every upload and every splat fetch
    while the presigned URLs stayed valid. Built with its own app rather than
    the shared fixture, since the point is a non-default input.
    """
    import aws_cdk as cdk

    from app import build_stacks
    from tests.conftest import ENV

    stacks = build_stacks(
        cdk.App(),
        ENV,
        worker_ami_id="ami-000000000000",
        alert_email="nobody@example.com",
        app_public_url="https://ai-gaussian-splatter.orky.net/",
        hosted_zone_id="Z00000000000000000000",
    )
    template = Template.from_stack(stacks["data"])

    for props in template.find_resources("AWS::S3::Bucket").values():
        for rule in props["Properties"].get("CorsConfiguration", {}).get("CorsRules", []):
            assert rule["AllowedOrigins"] == ["https://ai-gaussian-splatter.orky.net"]


def test_bucket_cors_names_the_app_origin_not_a_wildcard(wired_stacks):
    """The browser reads and writes both buckets directly through presigned
    URLs, so a wildcard would let any page a visitor happens to load fetch a
    shared or leaked splat URL cross-origin.
    """
    template = Template.from_stack(wired_stacks["data"])

    rules = [
        rule
        for props in template.find_resources("AWS::S3::Bucket").values()
        for rule in props["Properties"].get("CorsConfiguration", {}).get("CorsRules", [])
    ]
    assert len(rules) == 2
    for rule in rules:
        assert rule["AllowedOrigins"] == ["https://ai-gaussian-splatter.orky.net"]


def test_database_is_in_isolated_subnets(wired_stacks):
    """RDS keeps the placement the tasks gave up: no route to or from the
    internet. It needs no outbound access, so nothing is gained by moving it
    out of the isolated subnets.

    Resolved against the subnet-type tag in NetworkStack rather than the
    logical IDs' spelling: those derive from the subnet configuration's `name`
    ("private"), which stays the same whatever the type underneath is.
    """
    network_template = Template.from_stack(wired_stacks["network"])
    isolated_subnet_ids = {
        logical_id
        for logical_id, props in network_template.find_resources("AWS::EC2::Subnet").items()
        if {"Key": "aws-cdk:subnet-type", "Value": "Isolated"} in props["Properties"]["Tags"]
    }
    assert len(isolated_subnet_ids) == 2

    template = Template.from_stack(wired_stacks["data"])
    subnet_groups = template.find_resources("AWS::RDS::DBSubnetGroup")
    assert len(subnet_groups) == 1
    (subnet_group_props,) = subnet_groups.values()

    subnet_refs = subnet_group_props["Properties"]["SubnetIds"]
    assert len(subnet_refs) == 2
    # Cross-stack, so each arrives as an Fn::ImportValue naming the exporting
    # stack's logical ID.
    for subnet_ref in subnet_refs:
        assert any(logical_id in str(subnet_ref) for logical_id in isolated_subnet_ids)
