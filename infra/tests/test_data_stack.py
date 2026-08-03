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
