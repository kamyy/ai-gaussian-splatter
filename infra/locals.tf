# Every local value in infra/ is declared here, including the ones only one .tf file reads, so there is a single
# place to look for where a derived value comes from. The sections below group by subject rather than by consuming
# file, because several of these are read from two or three .tf files at once.

locals {
  # ---------------------------------------------------------------------------
  # Tags and fixed names
  # ---------------------------------------------------------------------------

  project_tag = "ai-gaussian-splatter"

  # EC2 has no native "restrict to the calling/launched instance" condition, so the worker's self-termination
  # grant (worker_iam.tf) and the web task role's RunInstances/TerminateInstances grants (web.tf) both scope
  # themselves to instances carrying this tag instead.
  worker_tag_key   = "Role"
  worker_tag_value = "worker"

  # All four named explicitly rather than left to a generated name, so `aws ecs update-service
  # --force-new-deployment` (a Clerk secret rotation still needs one) can be written down literally in
  # RUNBOOK.md instead of looked up per environment.
  cluster_name             = "ai-gaussian-splatter"
  service_name             = "ai-gaussian-splatter-web"
  execution_role_name      = "ai-gaussian-splatter-execution"
  migration_task_role_name = "ai-gaussian-splatter-migrate-task"

  # Named for the same reason: RUNBOOK.md and .github/workflows/deploy.yml name this family literally (`aws ecs run-task
  # --task-definition ai-gaussian-splatter-migrate`) rather than looking it up.
  migration_task_family = "ai-gaussian-splatter-migrate"

  # ---------------------------------------------------------------------------
  # Network and DNS
  # ---------------------------------------------------------------------------

  availability_zones = [for suffix in ["a", "b"] : "${var.aws_region}${suffix}"]

  # The one subnet the worker's spot instance ever launches into (web/lib/server/ec2Launcher.ts's SubnetId). A
  # single local keeps web.tf's WORKER_SUBNET_ID env var and its RunInstances IAM grant from naming two different
  # subnets.
  worker_subnet = values(aws_subnet.public)[0]

  app_hostname = "ai-gaussian-splatter.${var.domain_zone_name}"

  # Derived from the hostname above rather than passed in separately, so the certificate, the DNS record, and the
  # origin the worker PATCHes status back to cannot disagree. It carries no trailing slash, because both consumers
  # append to it: worker/pipeline/status.py would double-slash its callback path, and the S3 CORS rules in data.tf
  # are matched against the browser's Origin header exactly.
  app_origin = "https://${local.app_hostname}"

  # ---------------------------------------------------------------------------
  # Container images
  # ---------------------------------------------------------------------------

  # The registry hostname web/lib/server/ec2Launcher.ts's user-data logs into before pulling. It is built from
  # account/region directly rather than parsed out of aws_ecr_repository.worker.repository_url, matching how
  # .github/workflows/deploy.yml and RUNBOOK.md construct the same string for their own docker/podman logins.
  ecr_registry     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  worker_image_uri = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"

  # .github/workflows/deploy.yml is the only caller that ever diverges these two builds (ARCHITECTURE.md).
  migrate_image_tag = var.migrate_image_tag != "" ? var.migrate_image_tag : var.web_image_tag

  # How many releases the web ECR repository keeps per tag suffix. See registry.tf.
  releases_kept = 10

  # Far shallower than releases_kept: the worker image is ~19 GB and isn't part of any ECS rollback mechanism,
  # so there's no reason to pay for that many of them. See registry.tf.
  worker_releases_kept = 2

  # ---------------------------------------------------------------------------
  # Database wiring
  # ---------------------------------------------------------------------------

  database_name = "ai_gaussian_splatter"

  # Where web/Dockerfile downloads Amazon's RDS global CA bundle, in both of its stages. Must match that path.
  rds_ca_bundle_path = "/app/certs/rds-global-bundle.pem"

  # Shared by both containers in web.tf that talk to Postgres, the web service and the migration task. Defined once
  # so a future change (a renamed secret field, a moved CA path) can't be applied to one and silently missed on
  # the other. The username is shared too, since it never changes. The password is not: see db_password_secret.
  db_environment = [
    { name = "DATABASE_HOST", value = aws_db_instance.main.address },
    { name = "DATABASE_PORT", value = tostring(aws_db_instance.main.port) },
    { name = "DATABASE_NAME", value = local.database_name },
    # Turns on TLS verification against RDS with the CA bundle web/Dockerfile bakes into the image. An env var
    # rather than a hardcoded path so a locally-run container can still talk to a plain Postgres.
    { name = "DATABASE_SSL_CA", value = local.rds_ca_bundle_path },
  ]
  db_user_secret = [
    { name = "DATABASE_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
  ]
  # Only the migration task takes this: it runs for seconds and exits, well inside RDS's 7-day rotation window for
  # this secret, so a value ECS injects once at task start can't go stale. The long-lived web service instead
  # fetches the current password itself at connect time (web.tf's DATABASE_SECRET_ARN, web/lib/server/databaseUrl.ts's
  # fetchDatabasePassword) rather than trusting one this static either.
  db_password_secret = [
    { name = "DATABASE_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
  ]

  # ---------------------------------------------------------------------------
  # Web container runtime
  # ---------------------------------------------------------------------------

  # Single source of truth for the Next.js container's listen port, used by the task definition, the target
  # group health check, and the ALB-to-tasks security group rule. web/Dockerfile's PORT is the one copy that
  # has to be kept in sync by hand.
  container_port = 8000

  # Must stay above the ALB's own idle timeout (60s, left at its default in web.tf) or the ALB serves intermittent
  # 502s. See AGENTS.md.
  keep_alive_timeout_ms = "65000"

  # ---------------------------------------------------------------------------
  # Policy documents
  # ---------------------------------------------------------------------------

  # The trust policy shared by every ECS task role in web.tf.
  ecs_tasks_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  # Shared by every S3 role-policy grant in web.tf/worker_iam.tf, so an action list change (e.g. adding
  # s3:PutObjectTagging) is made once instead of separately on each role/bucket pair.
  s3_read_actions = ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"]
  s3_read_write_actions = concat(local.s3_read_actions, [
    "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload",
  ])

  # Adds the aws:SecureTransport deny to a data.tf bucket that otherwise has no other policy statement of its own.
  # The access-log bucket in web.tf writes its own policy instead, because it also needs the ALB log-delivery grant.
  deny_insecure_transport_policy = {
    for name, bucket in { uploads = aws_s3_bucket.uploads, splats = aws_s3_bucket.splats } :
    name => jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [bucket.arn, "${bucket.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }]
    })
  }
}
