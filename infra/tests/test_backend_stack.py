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
    execution_role_policies = [
        props for name, props in policies.items() if "ExecutionRole" in name
    ]
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


def test_network_configuration_uses_public_subnets(wired_stacks):
    template = Template.from_stack(wired_stacks["backend"])

    services = template.find_resources("AWS::ECS::ExpressGatewayService")
    assert len(services) == 1
    (service_props,) = services.values()
    subnets = service_props["Properties"]["NetworkConfiguration"]["Subnets"]
    assert len(subnets) == 2
    for subnet_ref in subnets:
        assert "publicSubnet" in str(subnet_ref)
