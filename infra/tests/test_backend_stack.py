from aws_cdk.assertions import Template

ECR_PULL_ACTIONS = {"ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"}


def test_execution_role_ecr_pull_scoped_to_repo_not_account_wide(wired_stacks):
    """Regression test: the ECR image-pull actions must never appear with
    Resource: "*" — that was the AmazonECSTaskExecutionRolePolicy managed
    policy's over-widening (read access to every repo in the account),
    fixed by reconstructing the execution role's policy manually.
    """
    template = Template.from_stack(wired_stacks["backend"])

    policies = template.find_resources("AWS::IAM::Policy")
    execution_role_policies = [props for name, props in policies.items() if "ExecutionRole" in name]
    assert len(execution_role_policies) == 1

    statements = execution_role_policies[0]["Properties"]["PolicyDocument"]["Statement"]
    for statement in statements:
        actions = statement["Action"]
        actions = actions if isinstance(actions, list) else [actions]
        if ECR_PULL_ACTIONS & set(actions):
            assert statement["Resource"] != "*", (
                "ECR image-pull actions must be scoped to the repo ARN, not Resource: '*'"
            )


def test_pass_role_targets_worker_role_not_instance_profile(wired_stacks):
    """Regression test: iam:PassRole must target the worker IAM role's ARN,
    not the instance profile's ARN — IAM authorizes PassRole for
    RunInstances-with-IamInstanceProfile against the role's ARN. Using the
    instance profile ARN was the original bug (AccessDenied on every worker
    launch).
    """
    template = Template.from_stack(wired_stacks["backend"])

    policies = template.find_resources("AWS::IAM::Policy")
    task_role_policies = [props for name, props in policies.items() if "TaskRole" in name]
    assert len(task_role_policies) == 1

    statements = task_role_policies[0]["Properties"]["PolicyDocument"]["Statement"]
    pass_role_statements = [s for s in statements if s["Action"] == "iam:PassRole"]
    assert len(pass_role_statements) == 1

    resource = pass_role_statements[0]["Resource"]
    resource_str = str(resource)
    assert "WorkerRole" in resource_str
    assert "WorkerInstanceProfile" not in resource_str


def test_health_check_path_format(wired_stacks):
    """Regression test: Express Mode's healthCheckPath is PROTOCOL:PORT/PATH,
    not a bare path (CDK's own default is "HTTP:80/ping").
    """
    template = Template.from_stack(wired_stacks["backend"])

    template.has_resource_properties(
        "AWS::ECS::ExpressGatewayService",
        {"HealthCheckPath": "HTTP:8000/api/v1/healthz"},
    )


def test_database_credentials_projected_as_individual_secret_fields(wired_stacks):
    """Regression test: the container must receive DATABASE_USER/DATABASE_PASSWORD
    as individual JSON fields of the RDS secret, never the whole secret as
    DATABASE_URL.

    The original bug passed the bare secret ARN as DATABASE_URL, so the app
    received a JSON credentials blob where it expected a postgresql:// string
    and every query failed. ECS cannot assemble a connection string, so the
    parts are projected separately and web/lib/server/databaseUrl.ts builds the
    URL — see that file.
    """
    template = Template.from_stack(wired_stacks["backend"])

    services = template.find_resources("AWS::ECS::ExpressGatewayService")
    (service_props,) = services.values()
    container = service_props["Properties"]["PrimaryContainer"]

    secrets = {s["Name"]: s["ValueFrom"] for s in container["Secrets"]}
    assert "DATABASE_URL" not in secrets, "the RDS secret is a JSON blob and must not be passed as DATABASE_URL"
    assert {"DATABASE_USER", "DATABASE_PASSWORD"} <= secrets.keys()

    # The `arn:json-key::` selector is what makes ECS extract a single field.
    for name, json_key in (("DATABASE_USER", "username"), ("DATABASE_PASSWORD", "password")):
        assert f":{json_key}::" in str(secrets[name]), f"{name} must select the '{json_key}' field of the secret"

    # The non-secret half travels as plain environment variables.
    environment = {e["Name"] for e in container["Environment"]}
    assert {"DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME"} <= environment


def test_network_configuration_uses_public_subnets(wired_stacks):
    template = Template.from_stack(wired_stacks["backend"])

    services = template.find_resources("AWS::ECS::ExpressGatewayService")
    assert len(services) == 1
    (service_props,) = services.values()
    subnets = service_props["Properties"]["NetworkConfiguration"]["Subnets"]
    assert len(subnets) == 2
    for subnet_ref in subnets:
        assert "publicSubnet" in str(subnet_ref)
