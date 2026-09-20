mock_provider "aws" {}

mock_provider "aws" {
  alias = "billing"
}

variables {
  worker_ami_id        = "ami-0123456789abcdef0"
  alert_email          = "test@example.com"
  hosted_zone_id       = "Z00000000000000000000"
  domain_zone_name     = "example.com"
  clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:ai-gaussian-splatter/clerk-secret-key-AAAAAA"
  web_image_tag        = "0123abc"
  worker_image_tag     = "4567def"
}

run "fixed_literal_names" {
  command = apply

  # These are named directly in RUNBOOK.md and .github/workflows/deploy.yml (e.g. `aws ecs run-task --task-definition
  # ai-gaussian-splatter-migrate`) rather than looked up, so they must stay literal.
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
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "PassWorkerRole" && s.Resource == aws_iam_role.worker.arn
    ])
    error_message = "iam:PassRole must target the worker role's ARN, not aws_iam_instance_profile.worker.arn"
  }
}

run "run_instances_statements_stay_split" {
  command = apply

  # Regression guard: a single statement conditioned on aws:RequestTag would evaluate false for every resource
  # type except the tagged instance itself and deny the whole RunInstances call.
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "RunInstances" && s.Action == "ec2:RunInstances" && !contains(keys(s), "Condition")
    ])
    error_message = "the unconditioned RunInstances statement must exist and must not carry aws:RequestTag — that's the separate RunInstancesTagged statement"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "RunInstancesTagged" && try(s.Condition.StringEquals["aws:RequestTag/Role"], "") == "worker"
    ])
    error_message = "the tagged RunInstances statement must require aws:RequestTag/Role=worker"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "CreateTagsOnLaunch" && try(s.Condition.StringEquals["ec2:CreateAction"], "") == "RunInstances"
    ])
    error_message = "ec2:CreateTags must be scoped to tags applied at launch, not a general tag-anything grant"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "TerminateWorker" && try(s.Condition.StringEquals["ec2:ResourceTag/Role"], "") == "worker"
    ])
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
    condition = anytrue([
      for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s.name == "DATABASE_USER"
    ])
    error_message = "DATABASE_USER must reach the web container as a secret field, never one assembled DATABASE_URL"
  }

  # Regression guard: the web service must fetch its own password at connect time (databaseUrl.ts's
  # fetchDatabasePassword) rather than trusting a value ECS injected once at task start, which RDS's 7-day secret
  # rotation would eventually make stale for this long-lived service.
  assert {
    condition = !anytrue([
      for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s.name == "DATABASE_PASSWORD"
    ])
    error_message = "the web task must not receive a static DATABASE_PASSWORD — see DATABASE_SECRET_ARN instead"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "DATABASE_SECRET_ARN" && e.value == aws_db_instance.main.master_user_secret[0].secret_arn
    ])
    error_message = "DATABASE_SECRET_ARN must name the RDS-managed secret so the app can fetch the current password"
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.task.policy).Statement :
      s.Sid == "DbSecretRead" && s.Resource == aws_db_instance.main.master_user_secret[0].secret_arn
    ])
    error_message = "the task role must be able to read the DB secret itself, or fetchDatabasePassword can't work"
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.web.container_definitions)[0].portMappings[0].containerPort == 8000
    error_message = "container must listen on the same port the target group health check and SG rule use"
  }

  # The override_resource blocks below give each ECR repository its own URL, and worker_image_tag differs from
  # web_image_tag. So these fail if either URI names the web repository or the web tag. The us-west-2 in these
  # assertions and the ECR_REGISTRY one below is var.aws_region's default: if that default moves, the right fix
  # is to move these too, not to stop asserting the region.
  #
  # The two suffixes are asserted separately because a stage pulling the other stage's image is the failure this
  # split exists to prevent, and it would still be a valid worker repository URI.
  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "WORKER_RECONSTRUCT_IMAGE_URI" && e.value == "000000000000.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-worker:4567def-reconstruct"
    ])
    error_message = "WORKER_RECONSTRUCT_IMAGE_URI must name the worker repository, worker_image_tag, and the -reconstruct suffix"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "WORKER_TRAIN_IMAGE_URI" && e.value == "000000000000.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-worker:4567def-train"
    ])
    error_message = "WORKER_TRAIN_IMAGE_URI must name the worker repository, worker_image_tag, and the -train suffix"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "ECR_REGISTRY" && e.value == "000000000000.dkr.ecr.us-west-2.amazonaws.com"
    ])
    error_message = "ECR_REGISTRY must be the account's ECR registry hostname, for docker login in ec2Launcher.ts's user-data"
  }

  # Regression guard: every AWS SDK client the app constructs reads getEnv().AWS_REGION explicitly. Without this
  # env var, each client falls back to its own default-region resolution instead, which can silently land on the
  # wrong region.
  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "AWS_REGION" && e.value == var.aws_region
    ])
    error_message = "AWS_REGION must be set explicitly so the app's AWS SDK clients target the right region"
  }

  # worker/pipeline/status.py builds its callback as f"{app_public_url}/api/v1/...", so a trailing slash here is a
  # silent 404 on every status update rather than anything Terraform would reject.
  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "APP_PUBLIC_URL" && !endswith(e.value, "/")
    ])
    error_message = "APP_PUBLIC_URL must carry no trailing slash, or the worker's status callbacks 404"
  }
}

run "migration_task_keeps_the_static_password" {
  command = apply

  # Unlike the web service, the migration task runs for seconds and exits — well inside RDS's 7-day rotation
  # window — so it keeps using the value ECS injects once at task start instead of fetching its own.
  assert {
    condition = length([
      for s in jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].secrets :
      s.name if contains(["DATABASE_USER", "DATABASE_PASSWORD"], s.name)
    ]) == 2
    error_message = "the migration task must still receive both DB credential fields as secrets"
  }
}

run "migration_task_role_carries_no_grants" {
  command = apply

  # There is no aws_iam_role_policy resource anywhere in infra/ attached to aws_iam_role.migration_task —
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

run "access_log_bucket_force_destroy_and_blocks_public_access" {
  command = apply

  assert {
    condition     = aws_s3_bucket.access_logs.force_destroy == true
    error_message = "the access-log bucket must be force_destroy=true so `terraform destroy` doesn't get stuck on a non-empty bucket"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.access_logs.block_public_acls && aws_s3_bucket_public_access_block.access_logs.block_public_policy
    error_message = "the access-log bucket must block all public access"
  }
}

run "certificate_and_dns" {
  command = apply

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

# Every hostname the deploy touches has to follow var.domain_zone_name. Asserting that against the fixture's own zone
# can't tell local.app_hostname apart from a literal spelling of the same string, so this run supplies a second zone.
# A hardcoded hostname passes everywhere else and only shows up in production: the certificate covers a name the A
# record doesn't serve, so ACM validation never completes and the worker PATCHes status to an origin the ALB doesn't
# answer on.
run "hostnames_follow_the_zone_variable" {
  command = apply

  variables {
    domain_zone_name = "other.test"
  }

  assert {
    condition     = aws_acm_certificate.web.domain_name == "ai-gaussian-splatter.other.test"
    error_message = "the certificate must cover local.app_hostname, which follows var.domain_zone_name"
  }

  assert {
    condition     = aws_route53_record.web.name == "ai-gaussian-splatter.other.test"
    error_message = "the A-alias record must name local.app_hostname, the hostname the certificate covers"
  }

  assert {
    condition = anytrue([
      for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment :
      e.name == "APP_PUBLIC_URL" && e.value == "https://ai-gaussian-splatter.other.test"
    ])
    error_message = "APP_PUBLIC_URL must be local.app_origin, the same hostname the certificate and A record use"
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

run "rejects_a_moving_worker_image_tag" {
  command = plan

  variables {
    worker_image_tag = "latest"
  }

  expect_failures = [var.worker_image_tag]
}

run "rejects_an_empty_worker_image_tag" {
  command = plan

  variables {
    worker_image_tag = ""
  }

  expect_failures = [var.worker_image_tag]
}

run "rejects_an_empty_worker_ami_id" {
  command = plan

  variables {
    worker_ami_id = ""
  }

  expect_failures = [var.worker_ami_id]
}

run "rejects_an_ami_name_as_worker_ami_id" {
  command = plan

  variables {
    worker_ami_id = "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)"
  }

  expect_failures = [var.worker_ami_id]
}

run "rejects_an_empty_hosted_zone_id" {
  command = plan

  variables {
    hosted_zone_id = ""
  }

  expect_failures = [var.hosted_zone_id]
}

run "rejects_a_prefixed_hosted_zone_id" {
  command = plan

  variables {
    hosted_zone_id = "/hostedzone/Z00000000000000000000"
  }

  expect_failures = [var.hosted_zone_id]
}

run "rejects_an_empty_domain_zone_name" {
  command = plan

  variables {
    domain_zone_name = ""
  }

  expect_failures = [var.domain_zone_name]
}

run "rejects_a_domain_zone_name_with_a_scheme" {
  command = plan

  variables {
    domain_zone_name = "https://example.com"
  }

  expect_failures = [var.domain_zone_name]
}

# The Route 53 console spells a zone name with a trailing dot, and its API returns one. Both are what a human pastes.
run "rejects_a_domain_zone_name_with_a_trailing_dot" {
  command = plan

  variables {
    domain_zone_name = "example.com."
  }

  expect_failures = [var.domain_zone_name]
}

run "rejects_an_uppercase_domain_zone_name" {
  command = plan

  variables {
    domain_zone_name = "Example.com"
  }

  expect_failures = [var.domain_zone_name]
}

run "rejects_a_non_email_alert_email" {
  command = plan

  variables {
    alert_email = "not-an-email"
  }

  expect_failures = [var.alert_email]
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

  expect_failures = [aws_iam_role_policy.execution]
}

# mock_provider fills computed attributes with plausible-looking scalars, but leaves computed
# lists/sets empty by default and doesn't know about format-validated fields (ARNs). These overrides
# give the handful of computed values other resources in infra/ actually depend on (or validate
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
      domain_name           = "ai-gaussian-splatter.example.com"
      resource_record_name  = "_mock.ai-gaussian-splatter.example.com."
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

# Distinct literal URLs so the worker image URI assertions can tell the two repositories apart. mock_provider would
# otherwise give each a random string.
override_resource {
  target = aws_ecr_repository.web
  values = {
    repository_url = "000000000000.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter"
  }
}

override_resource {
  target = aws_ecr_repository.worker
  values = {
    repository_url = "000000000000.dkr.ecr.us-west-2.amazonaws.com/ai-gaussian-splatter-worker"
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "000000000000"
  }
}
