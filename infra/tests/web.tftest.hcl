mock_provider "aws" {}

mock_provider "aws" {
  alias = "billing"
}

variables {
  worker_ami_id        = "ami-0123456789abcdef0"
  alert_email          = "test@example.com"
  hosted_zone_id       = "Z00000000000000000000"
  clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:ai-gaussian-splatter/clerk-secret-key-AAAAAA"
  web_image_tag        = "0123abc"
}

run "fixed_literal_names" {
  command = apply

  # These are named directly in RUNBOOK.md and .github/workflows/ci.yml (e.g. `aws ecs run-task
  # --task-definition ai-gaussian-splatter-migrate`) rather than looked up, so they must stay literal.
  assert {
    condition     = aws_ecs_cluster.main.name == "ai-gaussian-splatter"
    error_message = "cluster name is a fixed literal"
  }

  assert {
    condition     = aws_ecs_service.web.name == "ai-gaussian-splatter-web"
    error_message = "service name is a fixed literal"
  }

  assert {
    condition     = aws_ecs_task_definition.migration.family == "ai-gaussian-splatter-migrate"
    error_message = "migration task family is a fixed literal"
  }

  assert {
    condition     = aws_iam_role.execution.name == "ai-gaussian-splatter-execution"
    error_message = "execution role name is a fixed literal"
  }

  assert {
    condition     = aws_iam_role.migration_task.name == "ai-gaussian-splatter-migrate-task"
    error_message = "migration task role name is a fixed literal"
  }
}

run "pass_role_targets_the_role_not_the_instance_profile" {
  command = apply

  # Regression guard: RunInstances with IamInstanceProfile evaluates iam:PassRole against the underlying role's
  # ARN, not the instance profile ARN that wraps it. Getting this wrong is a real prior AccessDenied bug.
  assert {
    condition     = jsondecode(aws_iam_role_policy.task_pass_worker_role.policy).Statement[0].Resource == aws_iam_role.worker.arn
    error_message = "iam:PassRole must target the worker role's ARN, not aws_iam_instance_profile.worker.arn"
  }
}

run "run_instances_statements_stay_split" {
  command = apply

  # Regression guard: a single statement conditioned on aws:RequestTag would evaluate false for every resource
  # type except the tagged instance itself and deny the whole RunInstances call.
  assert {
    condition     = jsondecode(aws_iam_role_policy.task_ec2_run_instances.policy).Statement[0].Action == "ec2:RunInstances"
    error_message = "the unconditioned RunInstances statement must exist"
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_iam_role_policy.task_ec2_run_instances.policy).Statement[0]), "Condition")
    error_message = "the unconditioned RunInstances statement must not carry aws:RequestTag — that's the second, separate statement"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.task_ec2_run_instances_tagged.policy).Statement[0].Condition.StringEquals["aws:RequestTag/Role"] == "worker"
    error_message = "the tagged RunInstances statement must require aws:RequestTag/Role=worker"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.task_ec2_create_tags.policy).Statement[0].Condition.StringEquals["ec2:CreateAction"] == "RunInstances"
    error_message = "ec2:CreateTags must be scoped to tags applied at launch, not a general tag-anything grant"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.task_ec2_terminate.policy).Statement[0].Condition.StringEquals["ec2:ResourceTag/Role"] == "worker"
    error_message = "ec2:TerminateInstances must be scoped to instances tagged Role=worker"
  }
}

run "web_container_wiring" {
  command = apply

  assert {
    condition     = aws_lb_target_group.web.health_check[0].path == "/api/v1/healthz" && aws_lb_target_group.web.health_check[0].port == "8000"
    error_message = "health check must hit the app's own route, not the ALB default /"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "KEEP_ALIVE_TIMEOUT" && e.value == "65000"
    ])
    error_message = "KEEP_ALIVE_TIMEOUT must exceed the ALB's 60s idle timeout, or healthy deploys serve intermittent 502s"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets :
      s.name if contains(["DATABASE_USER", "DATABASE_PASSWORD"], s.name)
    ]) == 2
    error_message = "DB credentials must reach the container as two separate secret fields, never one assembled DATABASE_URL"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.web.container_definitions)[0].portMappings[0].containerPort == 8000
    error_message = "container must listen on the same port the target group health check and SG rule use"
  }
}

run "migration_task_role_carries_no_grants" {
  command = apply

  # There is no aws_iam_role_policy resource anywhere in this config attached to aws_iam_role.migration_task —
  # that's a config-level fact (the migration task role appears only in its own aws_iam_role declaration),
  # not something re-checked at plan time here. The container only opens a TCP connection to RDS; every AWS
  # API call the migration flow needs (ECR pull, DB secret read) runs under execution_role instead.
  assert {
    condition     = aws_iam_role.migration_task.name != aws_iam_role.execution.name
    error_message = "the migration task role and the execution role must stay distinct"
  }
}

run "service_uses_fargate_spot_only" {
  command = apply

  assert {
    condition     = tolist(aws_ecs_service.web.capacity_provider_strategy)[0].capacity_provider == "FARGATE_SPOT"
    error_message = "the service must run entirely on FARGATE_SPOT, no on-demand base"
  }

  assert {
    condition     = aws_ecs_service.web.deployment_minimum_healthy_percent == 100
    error_message = "the default 50% would let ECS stop the only running task before its replacement passes health checks"
  }

  assert {
    condition     = aws_ecs_service.web.deployment_circuit_breaker[0].enable == true && aws_ecs_service.web.deployment_circuit_breaker[0].rollback == true
    error_message = "a deployment that never reaches steady state must roll back, not hang for hours"
  }
}

run "autoscaling_bounds" {
  command = apply

  assert {
    condition     = aws_appautoscaling_target.web.min_capacity == 1 && aws_appautoscaling_target.web.max_capacity == 3
    error_message = "must autoscale between 1 and 3 tasks"
  }

  assert {
    condition     = aws_appautoscaling_policy.web_cpu.target_tracking_scaling_policy_configuration[0].target_value == 60
    error_message = "CPU target tracking must target 60%"
  }
}

run "certificate_and_dns" {
  command = apply

  assert {
    condition     = aws_acm_certificate.web.domain_name == "ai-gaussian-splatter.orky.net"
    error_message = "certificate must cover the app's own hostname"
  }

  assert {
    condition     = aws_acm_certificate.web.validation_method == "DNS"
    error_message = "must validate via DNS against the imported zone, not email"
  }

  assert {
    condition     = aws_route53_record.web.type == "A" && aws_route53_record.web.zone_id == var.hosted_zone_id
    error_message = "the app's A-alias record must land in the imported zone"
  }

  assert {
    condition     = aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "an unset ssl_policy on the AWS side defaults to the weak 2016-08 policy — this must be explicit"
  }
}

run "rejects_a_moving_web_image_tag" {
  command = plan

  variables {
    web_image_tag = "latest"
  }

  expect_failures = [var.web_image_tag]
}

run "rejects_an_empty_web_image_tag" {
  command = plan

  variables {
    web_image_tag = ""
  }

  expect_failures = [var.web_image_tag]
}

run "rejects_a_non_https_app_public_url" {
  command = plan

  variables {
    app_public_url = "http://ai-gaussian-splatter.orky.net"
  }

  expect_failures = [var.app_public_url]
}

run "rejects_a_clerk_secret_arn_with_no_suffix" {
  command = plan

  variables {
    clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:ai-gaussian-splatter/clerk-secret-key"
  }

  expect_failures = [var.clerk_secret_key_arn]
}

run "rejects_a_clerk_secret_arn_for_the_wrong_secret" {
  command = plan

  variables {
    clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:some-other-app/clerk-secret-key-AAAAAA"
  }

  expect_failures = [var.clerk_secret_key_arn]
}

run "rejects_a_clerk_secret_arn_from_a_different_account" {
  command = plan

  variables {
    clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:999999999999:secret:ai-gaussian-splatter/clerk-secret-key-AAAAAA"
  }

  expect_failures = [aws_iam_role_policy.execution_clerk_secret_read]
}

# mock_provider fills computed attributes with plausible-looking scalars, but leaves computed
# lists/sets empty by default and doesn't know about format-validated fields (ARNs). These overrides
# give the handful of computed values other resources in this config actually depend on (or validate
# the shape of) something usable, so the whole plan resolves offline.
override_resource {
  target = aws_db_instance.main
  values = {
    address = "ai-gaussian-splatter.mock.us-west-2.rds.amazonaws.com"
    port    = 5432
    master_user_secret = [{
      secret_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:mock-db-secret-AbCdEf"
    }]
  }
}

override_resource {
  target = aws_acm_certificate.web
  values = {
    arn = "arn:aws:acm:us-west-2:000000000000:certificate/mock-cert-id"
    domain_validation_options = [{
      domain_name           = "ai-gaussian-splatter.orky.net"
      resource_record_name  = "_mock.ai-gaussian-splatter.orky.net."
      resource_record_type  = "CNAME"
      resource_record_value = "_mock.acm-validations.aws."
    }]
  }
}

override_resource {
  target = aws_lb.web
  values = {
    arn      = "arn:aws:elasticloadbalancing:us-west-2:000000000000:loadbalancer/app/ai-gaussian-splatter/abc123"
    dns_name = "ai-gaussian-splatter-123456.us-west-2.elb.amazonaws.com"
    zone_id  = "Z1H1FL5HABSF5"
  }
}

override_resource {
  target = aws_sns_topic.billing_alerts
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:ai-gaussian-splatter-billing-alerts"
  }
}

override_resource {
  target = aws_iam_role.execution
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-execution"
  }
}

override_resource {
  target = aws_iam_role.migration_task
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-migrate-task"
  }
}

override_resource {
  target = aws_iam_role.task
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-task"
  }
}

override_resource {
  target = aws_iam_role.worker
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-worker"
  }
}

override_resource {
  target = aws_lb_target_group.web
  values = {
    arn = "arn:aws:elasticloadbalancing:us-west-2:000000000000:targetgroup/ai-gaussian-splatter-web/abc123"
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "000000000000"
  }
}
