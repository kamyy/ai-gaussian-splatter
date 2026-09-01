import re

import pytest
from aws_cdk.assertions import Template

from stacks.web_stack import (
    APP_HOSTNAME,
    CLERK_SECRET_KEY_NAME,
    CLUSTER_NAME,
    CONTAINER_PORT,
    KEEP_ALIVE_TIMEOUT_MS,
    MIGRATION_TASK_FAMILY,
    RDS_CA_BUNDLE_PATH,
    SERVICE_NAME,
)
from tests.conftest import CLERK_SECRET_KEY_ARN, build_app_stacks

ECR_PULL_ACTIONS = {"ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"}


def _web_container(template: Template) -> dict:
    """The web service's own container, as distinct from
    MigrationTaskDefinition's. WebStack synthesizes two
    AWS::ECS::TaskDefinition resources, and ecs_patterns.
    ApplicationLoadBalancedFargateService names its container "web" by
    default (the migration one is explicitly named "migrate" in
    infra/stacks/web_stack.py).
    """
    containers = [
        c
        for props in template.find_resources("AWS::ECS::TaskDefinition").values()
        for c in props["Properties"]["ContainerDefinitions"]
        if c["Name"] == "web"
    ]
    (container,) = containers
    return container


def test_execution_role_ecr_pull_scoped_to_repo_not_account_wide(wired_stacks):
    """Regression test: the ECR image-pull actions must never appear with
    Resource: "*". That was the AmazonECSTaskExecutionRolePolicy managed
    policy's over-widening (read access to every repo in the account),
    fixed by reconstructing the execution role's policy manually.
    """
    template = Template.from_stack(wired_stacks["web"])

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
    not the instance profile's ARN. IAM authorizes PassRole for
    RunInstances-with-IamInstanceProfile against the role's ARN. Using the
    instance profile ARN was the original bug (AccessDenied on every worker
    launch).
    """
    template = Template.from_stack(wired_stacks["web"])

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
    endpoint. Both are set explicitly in infra/stacks/web_stack.py. The target
    group's defaults are "/" on the traffic port, which would report a task
    healthy off the Next.js root page without ever exercising /api/v1/healthz.
    """
    template = Template.from_stack(wired_stacks["web"])

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
    template = Template.from_stack(wired_stacks["web"])
    container = _web_container(template)

    secrets = {s["Name"]: s["ValueFrom"] for s in container["Secrets"]}
    assert "DATABASE_URL" not in secrets, "the RDS secret is a JSON blob and must not be passed as DATABASE_URL"
    assert {"DATABASE_USER", "DATABASE_PASSWORD"} <= secrets.keys()

    # The `arn:json-key::` selector is what makes ECS extract a single field.
    for name, json_key in (("DATABASE_USER", "username"), ("DATABASE_PASSWORD", "password")):
        assert f":{json_key}::" in str(secrets[name]), f"{name} must select the '{json_key}' field of the secret"

    # The non-secret half travels as plain environment variables.
    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}
    assert {"DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME"} <= environment.keys()

    # RDS requires TLS (rds.force_ssl=1 by default on Postgres 15+) and its certificates chain to Amazon roots that Node
    # does not trust, so the app must be pointed at the CA bundle web/Dockerfile bakes into the image.
    assert environment.get("DATABASE_SSL_CA") == RDS_CA_BUNDLE_PATH


def test_app_public_url_reaches_the_container_without_a_trailing_slash():
    """The worker builds its callback URL by appending a path to this with an
    f-string (worker/pipeline/status.py), so a trailing slash gives it
    `//api/v1/...`, which nothing routes. worker/pipeline/status.py logs and
    swallows callback failures by design, so the job would simply stop
    reporting. Built with its own app rather than the shared fixture, since
    the point is a non-default input.
    """
    stacks = build_app_stacks(app_public_url="https://ai-gaussian-splatter.orky.net/")
    template = Template.from_stack(stacks["web"])
    container = _web_container(template)

    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}
    assert environment["APP_PUBLIC_URL"] == "https://ai-gaussian-splatter.orky.net"


def test_clerk_secret_is_imported_never_created_by_this_stack(wired_stacks):
    """The Clerk key is created by hand before the first deploy (RUNBOOK.md),
    so this stack must own no secret at all. The RDS one belongs to DataStack.
    Creating it here again would break both ends: CloudFormation cannot create
    a secret whose name is already taken, so the deploy would fail outright,
    and on a fresh account it would instead come up holding a random value that
    only a second rollout could replace.
    """
    template = Template.from_stack(wired_stacks["web"])

    template.resource_count_is("AWS::SecretsManager::Secret", 0)


def test_clerk_secret_reaches_the_container_by_complete_arn(wired_stacks):
    """ECS resolves a task definition's `valueFrom` against the complete ARN —
    the one carrying Secrets Manager's six-character suffix. A partial ARN
    (from Secret.from_secret_name_v2, say) synthesizes and deploys clean, then
    fails at task start, so the suffix is pinned here.
    """
    template = Template.from_stack(wired_stacks["web"])
    container = _web_container(template)

    secrets = {s["Name"]: s["ValueFrom"] for s in container["Secrets"]}
    assert secrets.get("CLERK_SECRET_KEY") == CLERK_SECRET_KEY_ARN


def test_execution_role_can_read_the_clerk_secret(wired_stacks):
    """The execution role is what fetches secret values before handing them to
    the container, so without this grant the task never starts. It is a
    separate failure from the DB grant next to it and would surface only as a
    stopped task, never in the application logs.
    """
    template = Template.from_stack(wired_stacks["web"])

    policies = template.find_resources("AWS::IAM::Policy")
    execution_role_policies = [props for name, props in policies.items() if "ExecutionRole" in name]
    assert len(execution_role_policies) == 1

    statements = execution_role_policies[0]["Properties"]["PolicyDocument"]["Statement"]
    reads_clerk_secret = [
        s
        for s in statements
        if "secretsmanager:GetSecretValue" in (s["Action"] if isinstance(s["Action"], list) else [s["Action"]])
        and CLERK_SECRET_KEY_NAME in str(s["Resource"])
    ]
    assert len(reads_clerk_secret) == 1


@pytest.mark.parametrize(
    "bad_arn",
    [
        pytest.param(CLERK_SECRET_KEY_ARN.rsplit("-", 1)[0], id="partial-arn-missing-the-suffix"),
        pytest.param(CLERK_SECRET_KEY_ARN.replace("123456789012", "999999999999"), id="another-accounts-secret"),
        pytest.param(CLERK_SECRET_KEY_ARN.replace(CLERK_SECRET_KEY_NAME, "some/other-secret"), id="a-different-secret"),
        pytest.param(CLERK_SECRET_KEY_NAME, id="the-bare-name"),
    ],
)
def test_a_wrong_clerk_secret_arn_fails_at_synth(bad_arn):
    """CloudFormation never validates an imported ARN, so every one of these
    deploys clean and only shows up as a task that will not start. The check in
    WebStack is what turns them into a synth-time error instead — including
    the case that matters most, a real deploy that forgot `-c clerkSecretKeyArn=`
    and is still carrying infra/app.py's placeholder-account default.
    """
    with pytest.raises(ValueError, match="clerkSecretKeyArn"):
        build_app_stacks(clerk_secret_key_arn=bad_arn)


def test_the_service_names_one_immutable_build(wired_stacks):
    """The task definition must name a per-release tag. With a moving tag every
    release shares one task definition, so the circuit breaker's rollback
    restarts the previous deployment against that same string and Fargate
    re-pulls the image that just failed. The rollback restores the
    configuration faithfully, but the configuration identifies no image.
    """
    template = Template.from_stack(wired_stacks["web"])
    container = _web_container(template)

    # An Fn::Join of the repository URI and the tag; the tag is the last piece.
    tag = str(container["Image"]).rsplit(":", 1)[-1].strip("'\"} ]")
    assert tag.endswith("-web"), f"expected a *-web tag, got {tag!r}"
    assert re.fullmatch(r"[0-9a-f]{7,40}", tag.removesuffix("-web")), f"expected a commit SHA, got {tag!r}"


@pytest.mark.parametrize(
    "bad_tag",
    [
        pytest.param("latest", id="the-moving-tag-this-exists-to-prevent"),
        pytest.param("v1.2.3", id="a-release-name"),
        pytest.param("", id="empty"),
    ],
)
def test_a_moving_web_image_tag_fails_at_synth(bad_tag):
    """Rejected structurally rather than by convention: a moving tag is the one
    input that quietly disarms rollback, and nothing downstream would complain.
    """
    with pytest.raises(ValueError, match="webImageTag"):
        build_app_stacks(web_image_tag=bad_tag)


@pytest.mark.parametrize(
    "bad_tag",
    [
        pytest.param("latest", id="the-moving-tag-this-exists-to-prevent"),
        pytest.param("v1.2.3", id="a-release-name"),
        pytest.param("", id="empty"),
    ],
)
def test_a_moving_migrate_image_tag_fails_at_synth(bad_tag):
    """Mirrors test_a_moving_web_image_tag_fails_at_synth. migrateImageTag is
    validated with the same _require_commit_sha helper.
    """
    with pytest.raises(ValueError, match="migrateImageTag"):
        build_app_stacks(migrate_image_tag=bad_tag)


def _migrate_container(template: Template) -> dict:
    """The migration task's own container, as distinct from the web
    service's — see _web_container above.
    """
    containers = [
        c
        for props in template.find_resources("AWS::ECS::TaskDefinition").values()
        for c in props["Properties"]["ContainerDefinitions"]
        if c["Name"] == "migrate"
    ]
    (container,) = containers
    return container


def test_migration_task_definition_family_and_image_tag(wired_stacks):
    """The migration task must run the *-migrate image built alongside the web
    image (web/Dockerfile's `migrator` stage) — never the web image itself,
    which has no drizzle-kit or migrations on board.
    """
    template = Template.from_stack(wired_stacks["web"])

    template.has_resource_properties("AWS::ECS::TaskDefinition", {"Family": MIGRATION_TASK_FAMILY})

    container = _migrate_container(template)
    tag = str(container["Image"]).rsplit(":", 1)[-1].strip("'\"} ]")
    assert tag.endswith("-migrate"), f"expected a *-migrate tag, got {tag!r}"


def test_migration_task_shares_the_web_services_database_wiring(wired_stacks):
    """Regression test mirroring test_database_credentials_projected_as_individual_secret_fields.
    The migration container needs the identical DB connection shape (same
    host/port/name env vars, same secret-field selectors, same CA bundle path)
    since it resolves its connection through the same web/lib/server/databaseUrl.ts
    code.
    """
    template = Template.from_stack(wired_stacks["web"])
    container = _migrate_container(template)

    secrets = {s["Name"]: s["ValueFrom"] for s in container["Secrets"]}
    assert {"DATABASE_USER", "DATABASE_PASSWORD"} <= secrets.keys()
    for name, json_key in (("DATABASE_USER", "username"), ("DATABASE_PASSWORD", "password")):
        assert f":{json_key}::" in str(secrets[name])

    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}
    assert {"DATABASE_HOST", "DATABASE_PORT", "DATABASE_NAME"} <= environment.keys()
    assert environment.get("DATABASE_SSL_CA") == RDS_CA_BUNDLE_PATH


def test_migration_task_role_has_no_grants(wired_stacks):
    """Regression guard on the claim in infra/stacks/web_stack.py's comment:
    the migration container only opens a TCP connection to RDS, no AWS API
    calls, so MigrationTaskRole should carry no inline policy at all.
    """
    template = Template.from_stack(wired_stacks["web"])

    policies = template.find_resources("AWS::IAM::Policy")
    migration_role_policies = [props for name, props in policies.items() if "MigrationTaskRole" in name]
    assert migration_role_policies == []


def test_keep_alive_timeout_exceeds_the_albs_idle_timeout(wired_stacks):
    """Regression test: without this env var, Node's standalone server closes
    idle keep-alive sockets after its 5s default, well under the ALB's 60s
    idle timeout. The ALB can then hand a request to a socket the app already
    closed, a 502 with no application-level log to explain it. Silent to drop
    or mistype, so it's pinned here rather than left to only show up as
    intermittent production 502s.
    """
    template = Template.from_stack(wired_stacks["web"])
    container = _web_container(template)
    environment = {e["Name"]: e.get("Value") for e in container["Environment"]}

    assert environment.get("KEEP_ALIVE_TIMEOUT") == KEEP_ALIVE_TIMEOUT_MS


def test_tasks_run_in_public_subnets_with_a_public_ip(wired_stacks):
    """The tasks egress through the internet gateway rather than a NAT
    gateway, which requires both a public subnet and a public IP. Without the
    IP they cannot even pull their own image from ECR. What keeps them
    unreachable is web_security_group, asserted in infra/tests/test_network_stack.py.
    """
    template = Template.from_stack(wired_stacks["web"])

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
    also has to leave LaunchType unset. ECS rejects a service that specifies
    both.
    """
    template = Template.from_stack(wired_stacks["web"])

    services = template.find_resources("AWS::ECS::Service")
    (service_props,) = services.values()

    assert "LaunchType" not in service_props["Properties"]
    assert service_props["Properties"]["CapacityProviderStrategy"] == [
        {"CapacityProvider": "FARGATE_SPOT", "Weight": 1},
    ]


def test_service_waits_for_the_capacity_provider_association(wired_stacks):
    """CreateService fails if it names FARGATE_SPOT before the cluster has an
    association for it, and both resources merely Ref the cluster. So without
    an explicit dependency CloudFormation is free to order them the wrong way
    and the first deploy fails intermittently.
    """
    template = Template.from_stack(wired_stacks["web"])

    associations = template.find_resources("AWS::ECS::ClusterCapacityProviderAssociations")
    assert len(associations) == 1
    (association_id,) = associations.keys()

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    assert association_id in service_props["DependsOn"]


def test_cluster_and_service_names_are_fixed(wired_stacks):
    """RUNBOOK.md writes the `aws ecs update-service
    --force-new-deployment` command out literally, for the one rollout that is
    not a deploy: rotating the Clerk key changes no template, so nothing else
    restarts the tasks that hold the old value. Generated names would make that
    command wrong.
    """
    template = Template.from_stack(wired_stacks["web"])

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
    template = Template.from_stack(wired_stacks["web"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    config = service_props["Properties"]["DeploymentConfiguration"]

    assert config["DeploymentCircuitBreaker"] == {"Enable": True, "Rollback": True}


def test_deployments_keep_a_healthy_task_serving(wired_stacks):
    """At desired_count 1 the 50% default floors to zero healthy tasks: ECS
    may stop the only running task before its replacement passes health
    checks, which is a window of 503s on every deploy.
    """
    template = Template.from_stack(wired_stacks["web"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()
    config = service_props["Properties"]["DeploymentConfiguration"]

    assert config["MinimumHealthyPercent"] == 100


def test_health_check_grace_period_covers_a_cold_start(wired_stacks):
    """A task killed inside the grace period never gets far enough to report
    why it failed. The default 60s can be shorter than a cold Next.js start.
    """
    template = Template.from_stack(wired_stacks["web"])

    (service_props,) = template.find_resources("AWS::ECS::Service").values()

    assert service_props["Properties"]["HealthCheckGracePeriodSeconds"] == 300


def test_load_balancer_is_internet_facing_in_the_public_subnets(wired_stacks):
    template = Template.from_stack(wired_stacks["web"])

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
    template = Template.from_stack(wired_stacks["web"])

    listeners = template.find_resources("AWS::ElasticLoadBalancingV2::Listener")
    by_port = {props["Properties"]["Port"]: props["Properties"] for props in listeners.values()}
    assert set(by_port) == {80, 443}

    assert by_port[443]["Protocol"] == "HTTPS"
    assert len(by_port[443]["Certificates"]) == 1
    assert by_port[443]["DefaultActions"][0]["Type"] == "forward"

    # Must be set explicitly: an unset policy is not "the sensible default" here, it is ELBSecurityPolicy-2016-08, which
    # still allows TLS 1.0/1.1.
    assert by_port[443]["SslPolicy"] == "ELBSecurityPolicy-TLS13-1-2-2021-06"

    assert by_port[80]["DefaultActions"][0]["Type"] == "redirect"
    assert by_port[80]["DefaultActions"][0]["RedirectConfig"]["Protocol"] == "HTTPS"

    template.has_resource_properties(
        "AWS::CertificateManager::Certificate",
        {"DomainName": APP_HOSTNAME},
    )


def test_autoscaling_is_bounded(wired_stacks):
    template = Template.from_stack(wired_stacks["web"])

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
    template = Template.from_stack(wired_stacks["web"])

    assert template.find_resources("AWS::Route53::HostedZone") == {}

    record_sets = template.find_resources("AWS::Route53::RecordSet")
    assert len(record_sets) == 1
    (record_props,) = record_sets.values()
    assert record_props["Properties"]["Name"] == f"{APP_HOSTNAME}."
    assert record_props["Properties"]["Type"] == "A"


def _task_role_statements(wired_stacks):
    template = Template.from_stack(wired_stacks["web"])
    policies = template.find_resources("AWS::IAM::Policy")
    task_role_policies = [props for name, props in policies.items() if "TaskRole" in name]
    assert len(task_role_policies) == 1
    return task_role_policies[0]["Properties"]["PolicyDocument"]["Statement"]


def test_run_instances_tag_condition_only_applies_to_the_instance(wired_stacks):
    """Regression test: RunInstances is authorized against every resource the
    request touches, and only the instance is tagged. A single statement
    carrying the aws:RequestTag condition denies the AMI, subnet, and security
    group. Every launch fails with UnauthorizedOperation.
    """
    statements = [s for s in _task_role_statements(wired_stacks) if s["Action"] == "ec2:RunInstances"]
    assert len(statements) == 2

    (conditioned,) = [s for s in statements if "Condition" in s]
    (unconditioned,) = [s for s in statements if "Condition" not in s]

    assert conditioned["Condition"] == {"StringEquals": {"aws:RequestTag/Role": "worker"}}
    assert "instance/*" in str(conditioned["Resource"])

    # The resource types the request names but never tags. Left off, IAM has no Allow for them and denies the whole
    # call.
    for resource_type in ("image", "subnet", "security-group", "network-interface", "volume"):
        assert f"{resource_type}/*" in str(unconditioned["Resource"])
    assert "instance/*" not in str(unconditioned["Resource"])


def test_tagging_on_launch_is_granted_and_scoped_to_run_instances(wired_stacks):
    """TagSpecifications triggers a second authorization against
    ec2:CreateTags. The ec2:CreateAction condition keeps that from becoming a
    licence to retag anything in the account.
    """
    statements = [s for s in _task_role_statements(wired_stacks) if s["Action"] == "ec2:CreateTags"]
    assert len(statements) == 1
    assert statements[0]["Condition"] == {"StringEquals": {"ec2:CreateAction": "RunInstances"}}


def test_container_logs_expire(wired_stacks):
    """The log group the ecs-patterns construct creates unprompted has no
    retention and a Retain deletion policy, so nothing ever reclaims it.
    """
    template = Template.from_stack(wired_stacks["web"])
    log_groups = template.find_resources("AWS::Logs::LogGroup")
    assert log_groups
    for props in log_groups.values():
        assert props["Properties"].get("RetentionInDays") is not None


def test_load_balancer_records_requests_and_drops_invalid_headers(wired_stacks):
    """The ALB is the only place a request the app never handled is visible."""
    template = Template.from_stack(wired_stacks["web"])
    (props,) = template.find_resources("AWS::ElasticLoadBalancingV2::LoadBalancer").values()
    attributes = {a["Key"]: a["Value"] for a in props["Properties"]["LoadBalancerAttributes"]}

    assert attributes["access_logs.s3.enabled"] == "true"
    assert attributes["routing.http.drop_invalid_header_fields.enabled"] == "true"


def test_execute_command_is_available_for_debugging(wired_stacks):
    template = Template.from_stack(wired_stacks["web"])
    template.has_resource_properties("AWS::ECS::Service", {"EnableExecuteCommand": True})
