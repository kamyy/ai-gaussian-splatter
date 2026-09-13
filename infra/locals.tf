# Constants shared across more than one of the *.tf files below (values used by only one file stay local to it,
# e.g. web.tf's worker_subnet/db_environment). Keeping a shared value here means a rename touches one file
# instead of every file that references it.
locals {
  project_tag = "ai-gaussian-splatter"

  # EC2 has no native "restrict to the calling/launched instance" condition, so the worker's self-termination
  # grant (worker_iam.tf) and the web task role's RunInstances/TerminateInstances grants (web.tf) both scope
  # themselves to instances carrying this tag instead.
  worker_tag_key   = "Role"
  worker_tag_value = "worker"

  availability_zones = [for suffix in ["a", "b"] : "${var.aws_region}${suffix}"]

  # Both named explicitly rather than left to a generated name, so `aws ecs update-service
  # --force-new-deployment` (a Clerk secret rotation still needs one) can be written down literally in
  # RUNBOOK.md instead of looked up per environment.
  cluster_name             = "ai-gaussian-splatter"
  service_name             = "ai-gaussian-splatter-web"
  execution_role_name      = "ai-gaussian-splatter-execution"
  migration_task_role_name = "ai-gaussian-splatter-migrate-task"

  # Named for the same reason: RUNBOOK.md and .github/workflows/ci.yml's deploy job name this family literally
  # (`aws ecs run-task --task-definition ai-gaussian-splatter-migrate`) rather than looking it up.
  migration_task_family = "ai-gaussian-splatter-migrate"

  domain_zone_name = "orky.net"
  app_hostname     = "ai-gaussian-splatter.${local.domain_zone_name}"

  database_name = "ai_gaussian_splatter"

  # Single source of truth for the Next.js container's listen port, used by the task definition, the target
  # group health check, and the ALB-to-tasks security group rule. web/Dockerfile's PORT is the one copy that
  # has to be kept in sync by hand.
  container_port = 8000

  # Where web/Dockerfile's `ADD` puts Amazon's RDS global CA bundle. Must match that line.
  rds_ca_bundle_path = "/app/certs/rds-global-bundle.pem"

  # Must stay above the ALB's own idle timeout (60s, left at its default below) or the ALB serves intermittent
  # 502s — see AGENTS.md.
  keep_alive_timeout_ms = "65000"

  # How many releases the web ECR repository keeps per tag suffix. See registry.tf.
  releases_kept = 10

  # Far shallower than releases_kept: the worker image is ~19 GB and isn't part of any ECS rollback mechanism,
  # so there's no reason to pay for that many of them. See registry.tf.
  worker_releases_kept = 2

  # Shared by every S3 role-policy grant in web.tf/worker_iam.tf, so an action list change (e.g. adding
  # s3:PutObjectTagging) is made once instead of separately on each role/bucket pair.
  s3_read_actions = ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"]
  s3_read_write_actions = concat(local.s3_read_actions, [
    "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload",
  ])
}
