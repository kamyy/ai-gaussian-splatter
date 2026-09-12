# The Next.js app (pages + the REST API as Route Handlers) on Fargate, behind an internet-facing Application
# Load Balancer.
#
# The tasks share the public subnets with the ALB and carry a public IP, so their calls to S3 and the EC2 API
# egress through the internet gateway rather than a NAT gateway (see network.tf for the cost reasoning).
# Nothing can open a connection to them regardless: aws_security_group.web admits only aws_security_group.alb.
# TLS terminates at the ALB with an ACM certificate for local.app_hostname, and plain HTTP is redirected to
# HTTPS.

# ---------------------------------------------------------------------------
# Execution role — pulls the container image and writes logs. It's also the role ECS uses to fetch the DB
# secret's value before handing it to the container as an env var, so the DB secret grant belongs here, not on
# the task role.
#
# Deliberately not the AmazonECSTaskExecutionRolePolicy managed policy: it grants the two logs actions below at
# Resource: "*" (every log group in the account) and the image-pull actions at Resource: "*" too (read access to
# every ECR repo in the account). Reconstructed below instead: the logs actions scoped to this config's own two
# log groups, and the pull actions scoped to this one repository (ecr:GetAuthorizationToken stays account-wide —
# it has no resource-level permissions to scope to).
# ---------------------------------------------------------------------------

locals {
  ecs_tasks_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role" "execution" {
  name               = local.execution_role_name
  assume_role_policy = local.ecs_tasks_assume_role_policy
}

resource "aws_iam_role_policy" "execution_logs" {
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = [
        "${aws_cloudwatch_log_group.web.arn}:*",
        "${aws_cloudwatch_log_group.migration.arn}:*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "execution_ecr_pull" {
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = aws_ecr_repository.web.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "execution_db_secret_read" {
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_db_instance.main.master_user_secret[0].secret_arn
    }]
  })
}

resource "aws_iam_role_policy" "execution_clerk_secret_read" {
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = var.clerk_secret_key_arn
    }]
  })

  # var.clerk_secret_key_arn's own validation block can only check its shape, not that it names this deploy's own
  # account/region — checked here instead, since a precondition can reference data/resources a variable
  # validation can't. Catches a copy-paste of another account's or another environment's secret ARN at apply time
  # rather than a stuck task at start.
  lifecycle {
    precondition {
      condition     = strcontains(var.clerk_secret_key_arn, ":secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:")
      error_message = "clerk_secret_key_arn must be a secret in this deploy's own account (${data.aws_caller_identity.current.account_id}) and region (${var.aws_region})."
    }
  }
}

# The one subnet the worker's spot instance ever launches into (web/lib/server/ec2Launcher.ts's SubnetId) — a
# single local so the env var below and the RunInstances IAM grant can't reference two different subnets.
locals {
  worker_subnet = values(aws_subnet.public)[0]
}

# Shared by both containers that talk to Postgres — the web service below and the migration task. Defined once
# so a future change (a renamed secret field, a moved CA path) can't be applied to one and silently missed on
# the other.
locals {
  db_environment = [
    { name = "DATABASE_HOST", value = aws_db_instance.main.address },
    { name = "DATABASE_PORT", value = tostring(aws_db_instance.main.port) },
    { name = "DATABASE_NAME", value = local.database_name },
    # Turns on TLS verification against RDS with the CA bundle web/Dockerfile bakes into the image. An env var
    # rather than a hardcoded path so a locally-run container can still talk to a plain Postgres.
    { name = "DATABASE_SSL_CA", value = local.rds_ca_bundle_path },
  ]
  db_secrets = [
    { name = "DATABASE_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
    { name = "DATABASE_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
  ]
}

# ---------------------------------------------------------------------------
# Migration task — runs `node web/scripts/db-migrate.cjs` (web/Dockerfile's `migrator` stage) as a one-off
# ecs:RunTask, ahead of the service's own rollout — see RUNBOOK.md and AGENTS.md for why migrations can't run
# at container boot. execution_role is reused as-is: it already has ECR pull and DB-secret read, everything
# this container needs to start. The migration task role gets its own fixed name for the same
# RUNBOOK-literalness reason as execution_role, and needs no grants at all: the container only opens a TCP
# connection to RDS, no AWS API calls.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "migration_task" {
  name               = local.migration_task_role_name
  assume_role_policy = local.ecs_tasks_assume_role_policy
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/ecs/${local.migration_task_family}"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "migration" {
  family                   = local.migration_task_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migration_task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.web.repository_url}:${local.migrate_image_tag}-migrate"
    essential = true
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migration.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migrate"
      }
    }
    environment = local.db_environment
    secrets     = local.db_secrets
  }])
}

# ---------------------------------------------------------------------------
# Task role — the running application code's own permissions: S3 rw on both buckets,
# ec2:RunInstances/TerminateInstances scoped by tag.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "ai-gaussian-splatter-task"
  assume_role_policy = local.ecs_tasks_assume_role_policy
}

resource "aws_iam_role_policy" "task_bucket_read_write" {
  for_each = { uploads = aws_s3_bucket.uploads, splats = aws_s3_bucket.splats }

  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.s3_read_write_actions
      Resource = [each.value.arn, "${each.value.arn}/*"]
    }]
  })
}

# RunInstances is authorized against every resource the request touches, each one separately. Only the
# instance carries the worker tag (web/lib/server/ec2Launcher.ts tags ResourceType "instance"), so
# aws:RequestTag is absent from the request context for the rest. A single statement conditioned on that key
# would evaluate false for them and deny the whole call. Hence the split: the tag constrains what can be
# launched (the second statement below), this one only names what it is launched from and into.
resource "aws_iam_role_policy" "task_ec2_run_instances" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "ec2:RunInstances"
      Resource = [
        # AMIs are not account-scoped, hence the empty account segment.
        "arn:aws:ec2:${var.aws_region}::image/*",
        # The worker only ever launches into this one subnet and this one security group (both passed as env vars
        # by web/lib/server/ec2Launcher.ts), so both are scoped to the exact resource rather than every subnet or
        # security group in the account.
        local.worker_subnet.arn,
        aws_security_group.worker.arn,
        # The ENI and root volume RunInstances creates don't exist yet at authorization time, so neither can be
        # scoped past the resource type.
        "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:network-interface/*",
        "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:volume/*",
        "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key-pair/*",
        # Only evaluated at all if the spot request itself is tagged on create, which web/lib/server/ec2Launcher.ts
        # does not do. But omitting it would otherwise start failing every launch with nothing to point at.
        "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:spot-instances-request/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "task_ec2_run_instances_tagged" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "ec2:RunInstances"
      Resource  = "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"
      Condition = { StringEquals = { "aws:RequestTag/${local.worker_tag_key}" = local.worker_tag_value } }
    }]
  })
}

# A request carrying TagSpecifications is authorized a second time against ec2:CreateTags, separately from
# RunInstances. Without this the launch fails even though the statements above allow it. The ec2:CreateAction
# condition keeps it from becoming a general tag-anything grant: it only applies to tags applied at launch.
resource "aws_iam_role_policy" "task_ec2_create_tags" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "ec2:CreateTags"
      Resource  = "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*/*"
      Condition = { StringEquals = { "ec2:CreateAction" = "RunInstances" } }
    }]
  })
}

resource "aws_iam_role_policy" "task_ec2_terminate" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "ec2:TerminateInstances"
      Resource  = "*"
      Condition = { StringEquals = { "ec2:ResourceTag/${local.worker_tag_key}" = local.worker_tag_value } }
    }]
  })
}

# PassRole is authorized against the role being passed, not the instance profile ARN that wraps it.
# RunInstances with IamInstanceProfile evaluates iam:PassRole against the underlying role's ARN.
resource "aws_iam_role_policy" "task_pass_worker_role" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "iam:PassRole"
      Resource = aws_iam_role.worker.arn
    }]
  })
}

# `aws ecs execute-command` opens an SSM Session Manager channel from inside the task, which needs these four
# actions on the task role. `enable_execute_command = true` on the service below does not grant them itself.
# None of the four support resource-level scoping.
resource "aws_iam_role_policy" "task_ssm_exec" {
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })
}

# ---------------------------------------------------------------------------
# TLS / DNS
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "web" {
  domain_name       = local.app_hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# count = 1, not for_each: this certificate only ever has one domain name (no SANs), so the count of validation
# records is statically known even though their content (the CNAME name/value ACM assigns) is not known until
# apply. for_each would need to derive its instance keys from that same not-yet-known content, which Terraform
# refuses to plan — a real limitation, not a mocking artifact. count sidesteps it because only the *number* of
# instances has to be known up front.
resource "aws_route53_record" "cert_validation" {
  count = 1

  zone_id         = var.hosted_zone_id
  name            = tolist(aws_acm_certificate.web.domain_validation_options)[0].resource_record_name
  type            = tolist(aws_acm_certificate.web.domain_validation_options)[0].resource_record_type
  records         = [tolist(aws_acm_certificate.web.domain_validation_options)[0].resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "web" {
  certificate_arn         = aws_acm_certificate.web.arn
  validation_record_fqdns = [aws_route53_record.cert_validation[0].fqdn]
}

# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "web" {
  name               = "ai-gaussian-splatter"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.public : s.id]

  # Headers that don't parse are dropped rather than passed to the app, so request smuggling can't be
  # assembled out of them.
  drop_invalid_header_fields = true

  # The only record of who called: the app logs its own handlers, not the requests the ALB rejected or
  # redirected before reaching them.
  access_logs {
    bucket  = aws_s3_bucket.access_logs.id
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.access_logs]
}

resource "aws_lb_target_group" "web" {
  name        = "ai-gaussian-splatter-web"
  port        = local.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # A cold Next.js server start can outrun a short interval; the health check below just needs to eventually
  # pass within health_check_grace_period_seconds on the service (set below).
  health_check {
    path     = "/api/v1/healthz"
    port     = tostring(local.container_port)
    protocol = "HTTP"
  }

  # The default 300s is a floor on how long every deployment takes to retire a task. Nothing here holds a
  # long-lived request, so draining is only about letting in-flight ones finish.
  deregistration_delay = 30
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web.arn
  port              = 443
  protocol          = "HTTPS"
  # Must stay set explicitly. An unset ssl_policy on the AWS side defaults to the weak 2016-08 policy, not this
  # one — see AGENTS.md.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = aws_acm_certificate_validation.web.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_route53_record" "web" {
  zone_id = var.hosted_zone_id
  name    = local.app_hostname
  type    = "A"

  alias {
    name                   = aws_lb.web.dns_name
    zone_id                = aws_lb.web.zone_id
    evaluate_target_health = true
  }
}

# The only path in to the web tasks: exactly the ALB, on exactly the port the container listens on.
resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = local.container_port
  to_port                      = local.container_port
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------------
# ECS cluster + web service
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.cluster_name

  # Exec sessions otherwise default to logging through the container's awslogs driver, which needs four logs
  # actions on the task role that nothing here grants. The session works and silently records nothing. Nothing
  # here needs an audit trail of debugging sessions, so turn the logging off rather than widen the task role.
  configuration {
    execute_command_configuration {
      logging = "NONE"
    }
  }
}

# Fargate capacity providers must be associated with the cluster before the service below can name
# FARGATE_SPOT in a strategy — the aws_ecs_service depends_on this explicitly to enforce that order.
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.service_name}"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "web" {
  family                   = local.service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}-web"
    essential    = true
    portMappings = [{ containerPort = local.container_port, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.web.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "web"
      }
    }
    environment = concat(local.db_environment, [
      { name = "UPLOADS_BUCKET", value = aws_s3_bucket.uploads.id },
      { name = "SPLATS_BUCKET", value = aws_s3_bucket.splats.id },
      { name = "WORKER_AMI_ID", value = var.worker_ami_id },
      { name = "WORKER_SUBNET_ID", value = local.worker_subnet.id },
      { name = "WORKER_SECURITY_GROUP_ID", value = aws_security_group.worker.id },
      { name = "WORKER_INSTANCE_PROFILE_ARN", value = aws_iam_instance_profile.worker.arn },
      # Where the GPU worker PATCHes job status back to. Passed in rather than read off the load balancer, so
      # it stays the stable custom domain the ALB is aliased to.
      { name = "APP_PUBLIC_URL", value = local.app_origin },
      # Read by Next's standalone server.js to override Node's 5s idle-socket close, which the ALB outlives —
      # see AGENTS.md.
      { name = "KEEP_ALIVE_TIMEOUT", value = local.keep_alive_timeout_ms },
    ])
    # Only the credentials go through Secrets Manager; the endpoint and database name above aren't secret and
    # stay readable in the console.
    secrets = concat(local.db_secrets, [
      { name = "CLERK_SECRET_KEY", valueFrom = var.clerk_secret_key_arn },
    ])
  }])
}

resource "aws_ecs_service" "web" {
  name            = local.service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    subnets          = [for s in aws_subnet.public : s.id]
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = local.container_port
  }

  # A cold Next.js server start can outrun the default 60s. A task killed inside the grace period never gets
  # far enough to say why. /api/v1/healthz answers from the app alone; it does not touch the database, so a
  # passing health check says nothing about RDS connectivity.
  health_check_grace_period_seconds = 300

  # Without this, a deployment whose tasks never reach a steady state (an image that isn't in ECR yet, a
  # container that crashes on boot) is not reported as failed until ECS's own timeout expires, which takes
  # hours. Roll back instead.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # The default 50% floors to zero healthy tasks at desired_count 1, letting ECS stop the only running task
  # before its replacement passes health checks — a window of 503s on every deploy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # `aws ecs execute-command` into a running task. The alternative when a deploy misbehaves is reading
  # CloudWatch and guessing.
  enable_execute_command = true

  depends_on = [aws_ecs_cluster_capacity_providers.main, aws_lb_listener.https]
}

# Without this the service sits at a fixed single task.
resource "aws_appautoscaling_target" "web" {
  min_capacity       = 1
  max_capacity       = 3
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  service_namespace  = aws_appautoscaling_target.web.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 60
  }
}
