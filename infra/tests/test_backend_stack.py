from aws_cdk.assertions import Template

from stacks.backend_stack import (
    APP_HOSTNAME,
    CLUSTER_NAME,
    CONTAINER_PORT,
    KEEP_ALIVE_TIMEOUT_MS,
    RDS_CA_BUNDLE_PATH,
    SERVICE_NAME,
)

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


def test_health_check_targets_the_container_port(wired_stacks):
    """The health check must hit the app's own port and its real health
    endpoint. Both are set explicitly in backend_stack.py — the target group's
    defaults are "/" on the traffic port, which would report a task healthy
    off the Next.js root page without ever exercising /api/v1/healthz.
    """
    template = Template.from_stack(wired_stacks["backend"])

    template.has_resource_properties(
        "AWS::ElasticLoadBalancingV2::TargetGroup",
        {"HealthCheckPath": "/api/v1/healthz", "HealthCheckPort": str(CONTAINER_PORT)},
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

    task_definitions = template.find_resources("AWS::ECS::TaskDefinition")
    (task_definition_props,) = task_definitions.values()
    (container,) = task_definition_props["Properties"]["ContainerDefinitions"]

    secrets = {s["Name"]: s["ValueFrom"] for s in container["Secrets"]}
    assert "DATABASE_URL" not in secrets, "the RDS secret is a JSON blob and must not be passed as DATABASE_URL"
    assert {"DATABASE_USER", "DATABASE_PASSWORD"} <= secrets.keys()

    # The `arn:json-key::` selector is what makes ECS extract a single field.
    for name, json_key in (("DATABASE_USER", "username"), ("DATABASE_PASSWORD", "password")):
        assert f":{json_key}::" in str(secrets[name]), f"{name} must select the '{json_key}' field of the secret"

    # The non-secret half travels as plain environment variables.
    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}
    assert {"DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME"} <= environment.keys()

    # RDS requires TLS (rds.force_ssl=1 by default on Postgres 15+) and its
    # certificates chain to Amazon roots that Node does not trust, so the app
    # must be pointed at the CA bundle web/Dockerfile bakes into the image.
    assert environment.get("DATABASE_SSL_CA") == RDS_CA_BUNDLE_PATH


def test_keep_alive_timeout_exceeds_the_albs_idle_timeout(wired_stacks):
    """Regression test: without this env var, Node's standalone server closes
    idle keep-alive sockets after its 5s default, well under the ALB's 60s
    idle timeout — the ALB can then hand a request to a socket the app already
    closed, a 502 with no application-level log to explain it. Silent to drop
    or mistype, so it's pinned here rather than left to only show up as
    intermittent production 502s.
    """
    template = Template.from_stack(wired_stacks["backend"])

    task_definitions = template.find_resources("AWS::ECS::TaskDefinition")
    (task_definition_props,) = task_definitions.values()
    (container,) = task_definition_props["Properties"]["ContainerDefinitions"]
    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}

    assert environment.get("KEEP_ALIVE_TIMEOUT") == KEEP_ALIVE_TIMEOUT_MS


def test_tasks_run_in_public_subnets_with_a_public_ip(wired_stacks):
    """The tasks egress through the internet gateway rather than a NAT
    gateway, which requires both a public subnet and a public IP — without the
    IP they cannot even pull their own image from ECR. What keeps them
    unreachable is backend_security_group, asserted in test_network_stack.py.
    """
    template = Template.from_stack(wired_stacks["backend"])

    services = template.find_resources("AWS::ECS::Service")
    assert len(services) == 1
    (service_props,) = services.values()
    awsvpc = service_props["Properties"]["NetworkConfiguration"]["AwsvpcConfiguration"]

    assert awsvpc["AssignPublicIp"] == "ENABLED"
    subnets = awsvpc["Subnets"]
    assert len(subnets) == 2
    for subnet_ref in subnets:
        assert "publicSubnet" in str(subnet_ref)


def test_service_runs_on_fargate_spot(wired_stacks):
    """~70% of the task's compute cost. A strategy naming only FARGATE_SPOT
    also has to leave LaunchType unset — ECS rejects a service that specifies
    both.
    """
    template = Template.from_stack(wired_stacks["backend"])

    services = template.find_resources("AWS::ECS::Service")
    (service_props,) = services.values()

    assert "LaunchType" not in service_props["Properties"]
    assert service_props["Properties"]["CapacityProviderStrategy"] == [
        {"CapacityProvider": "FARGATE_SPOT", "Weight": 1},
    ]


def test_service_waits_for_the_capacity_provider_association(wired_stacks):
    """CreateService fails if it names FARGATE_SPOT before the cluster has an
    association for it, and both resources merely Ref the cluster — so without
    an explicit dependency CloudFormation is free to order them the wrong way
    and the first deploy fails intermittently.
    """
    template = Template.from_stack(wired_stacks["backend"])

    associations = template.find_resources("AWS::ECS::ClusterCapacityProviderAssociations")
    assert len(associations) == 1
    (association_id,) = associations.keys()

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    assert association_id in service_props["DependsOn"]


def test_cluster_and_service_names_are_fixed(wired_stacks):
    """RUNBOOK.md writes the `aws ecs update-service
    --force-new-deployment` command out literally, since pushing to the fixed
    image tag is otherwise invisible to the running service. Generated names
    would make that command wrong.
    """
    template = Template.from_stack(wired_stacks["backend"])

    (cluster_props,) = template.find_resources("AWS::ECS::Cluster").values()
    assert cluster_props["Properties"]["ClusterName"] == CLUSTER_NAME

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    assert service_props["Properties"]["ServiceName"] == SERVICE_NAME


def test_a_failed_deployment_rolls_back_instead_of_hanging(wired_stacks):
    """Without the circuit breaker, a deployment whose tasks never stabilize
    (unpullable image, container crashing on boot) sits in progress for hours
    before ECS calls it failed. Rollback must also be on, or the breaker only
    stops the deployment and leaves the service with no healthy tasks.
    """
    template = Template.from_stack(wired_stacks["backend"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    config = service_props["Properties"]["DeploymentConfiguration"]

    assert config["DeploymentCircuitBreaker"] == {"Enable": True, "Rollback": True}


def test_deployments_keep_a_healthy_task_serving(wired_stacks):
    """At desired_count 1 the 50% default floors to zero healthy tasks: ECS
    may stop the only running task before its replacement passes health
    checks, which is a window of 503s on every deploy.
    """
    template = Template.from_stack(wired_stacks["backend"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    config = service_props["Properties"]["DeploymentConfiguration"]

    assert config["MinimumHealthyPercent"] == 100


def test_health_check_grace_period_covers_a_cold_start(wired_stacks):
    """A task killed inside the grace period never gets far enough to report
    why it failed. The default 60s can be shorter than a cold Next.js start.
    """
    template = Template.from_stack(wired_stacks["backend"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()

    assert service_props["Properties"]["HealthCheckGracePeriodSeconds"] == 300


def test_load_balancer_is_internet_facing_in_the_public_subnets(wired_stacks):
    template = Template.from_stack(wired_stacks["backend"])

    load_balancers = template.find_resources("AWS::ElasticLoadBalancingV2::LoadBalancer")
    assert len(load_balancers) == 1
    (lb_props,) = load_balancers.values()

    assert lb_props["Properties"]["Scheme"] == "internet-facing"
    subnets = lb_props["Properties"]["Subnets"]
    assert len(subnets) == 2
    for subnet_ref in subnets:
        assert "publicSubnet" in str(subnet_ref)


def test_traffic_is_https_with_http_redirected(wired_stacks):
    """Regression test: the app serves session cookies, so it must never fall
    back to a plaintext listener. An ALB terminates TLS only if a certificate
    is attached, and the certificate must be in the ALB's own region — which
    is what declaring it in this stack achieves.
    """
    template = Template.from_stack(wired_stacks["backend"])

    listeners = template.find_resources("AWS::ElasticLoadBalancingV2::Listener")
    by_port = {props["Properties"]["Port"]: props["Properties"] for props in listeners.values()}
    assert set(by_port) == {80, 443}

    assert by_port[443]["Protocol"] == "HTTPS"
    assert len(by_port[443]["Certificates"]) == 1
    assert by_port[443]["DefaultActions"][0]["Type"] == "forward"

    # Must be set explicitly: an unset policy is not "the sensible default"
    # here, it is ELBSecurityPolicy-2016-08, which still allows TLS 1.0/1.1.
    assert by_port[443]["SslPolicy"] == "ELBSecurityPolicy-TLS13-1-2-2021-06"

    assert by_port[80]["DefaultActions"][0]["Type"] == "redirect"
    assert by_port[80]["DefaultActions"][0]["RedirectConfig"]["Protocol"] == "HTTPS"

    template.has_resource_properties(
        "AWS::CertificateManager::Certificate",
        {"DomainName": APP_HOSTNAME},
    )


def test_autoscaling_is_bounded(wired_stacks):
    template = Template.from_stack(wired_stacks["backend"])

    template.has_resource_properties(
        "AWS::ApplicationAutoScaling::ScalableTarget",
        {"MinCapacity": 1, "MaxCapacity": 3},
    )
    template.has_resource_properties(
        "AWS::ApplicationAutoScaling::ScalingPolicy",
        {
            "PolicyType": "TargetTrackingScaling",
            "TargetTrackingScalingPolicyConfiguration": {
                "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
            },
        },
    )


def test_hosted_zone_is_imported_and_only_added_to(wired_stacks):
    """Regression guard on the orky.net zone: the stack must never own it.
    An imported zone is not in the resource set, so no CloudFormation
    operation can modify or delete the zone or any pre-existing record. The
    one record this stack does create is the app's own alias; the certificate's
    validation record is written by ACM itself, not by CloudFormation.
    """
    template = Template.from_stack(wired_stacks["backend"])

    assert template.find_resources("AWS::Route53::HostedZone") == {}

    record_sets = template.find_resources("AWS::Route53::RecordSet")
    assert len(record_sets) == 1
    (record_props,) = record_sets.values()
    assert record_props["Properties"]["Name"] == f"{APP_HOSTNAME}."
    assert record_props["Properties"]["Type"] == "A"
