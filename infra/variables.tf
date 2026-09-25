# Editing this default on a live account has an order to it. Tear the stack down first, while the default still names
# the region the stack is deployed in (AGENTS.md).
variable "aws_region" {
  description = "Primary region for every resource except the budgets provider (us-east-1, fixed — see providers.tf)."
  type        = string
  default     = "us-west-2"
}

# The AMI every worker instance boots. Only forwarded to the web task as WORKER_AMI_ID; the first thing to test it
# is the RunInstances call in web/lib/server/ec2Launcher.ts, one worker job at a time.
variable "worker_ami_id" {
  description = "AMI every GPU worker instance boots. Must carry Docker, the NVIDIA driver/container toolkit, and the AWS CLI (see RUNBOOK.md)."
  type        = string

  # Catches the empty string CI sends for an unset repository variable (AGENTS.md), or an AMI name pasted in place
  # of its ID. It checks shape only, not that the AMI exists or carries the GPU stack.
  validation {
    condition     = can(regex("^ami-([0-9a-f]{8}|[0-9a-f]{17})$", var.worker_ami_id))
    error_message = "worker_ami_id must be an AMI ID like ami-0123456789abcdef0 (see RUNBOOK.md)."
  }
}

# Where the AWS Budget emails spend alerts directly (no SNS topic in between).
variable "alert_email" {
  description = "Email address the AWS Budget notifies."
  type        = string

  # Catches a string that isn't an email at all (a blank value, a stray flag, a copy-paste mistake). It can't catch a
  # typo that still looks like an email (alert+email@gmial.com). That kind of mistake only shows up as an alert that
  # never arrives (AGENTS.md).
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must look like an email address (local-part@domain.tld)."
  }
}

# The DNS zone the app's own hostname sits under. local.app_hostname prefixes it with the project name, and the
# ACM certificate, the Route 53 record, the S3 CORS origins, and the worker's callback URL all derive from that
# one local, so this is the only place the domain is named.
variable "domain_zone_name" {
  description = "Public DNS zone the app's hostname sits under, e.g. example.com. The zone itself is never created or destroyed by this config."
  type        = string

  # Catches the empty string CI sends for an unset repository variable (AGENTS.md), and a value pasted with a
  # scheme, a trailing dot, or a path. It checks shape only, not that a zone by that name exists.
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain_zone_name))
    error_message = "domain_zone_name must be a bare DNS zone name like example.com, with no scheme, trailing dot, or path (see RUNBOOK.md)."
  }
}

# The hosted zone that var.domain_zone_name names. It is referenced for the ALB's alias record and ACM's validation
# record (see AGENTS.md). scripts/prod/set-gh-repo-variables.sh looks the id up from that name.
variable "hosted_zone_id" {
  description = "Route 53 hosted zone id for var.domain_zone_name. Only records are added here; the zone itself is never created or destroyed by this config."
  type        = string

  # Catches the empty string CI sends for an unset repository variable (AGENTS.md), or the `/hostedzone/`-prefixed form
  # the Route 53 API returns, which scripts/prod/set-gh-repo-variables.sh strips.
  validation {
    condition     = can(regex("^Z[0-9A-Z]+$", var.hosted_zone_id))
    error_message = "hosted_zone_id must be a bare Route 53 zone ID like Z0123456789ABCDEFGHIJ, without the /hostedzone/ prefix (see RUNBOOK.md)."
  }
}

# The Clerk secret is created by hand before the first apply and only referenced here, so its full ARN, including the
# suffix, has to be passed in. See AGENTS.md.
variable "clerk_secret_key_arn" {
  description = "Complete ARN (including Secrets Manager's suffix) of the ai-gaussian-splatter/clerk-secret-key secret."
  type        = string

  # Catches a missing suffix, a bare secret name, or the wrong secret name. A variable's validation block can only see
  # that variable's own value, so it can't check that the ARN's account and region match this deploy. That check is a
  # lifecycle precondition on aws_iam_role_policy.execution in infra/web.tf instead.
  validation {
    condition     = can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:\\d{12}:secret:ai-gaussian-splatter/clerk-secret-key-[A-Za-z0-9]{6}$", var.clerk_secret_key_arn))
    error_message = "clerk_secret_key_arn must be the complete ARN of ai-gaussian-splatter/clerk-secret-key, including its 6-character suffix, as returned by `aws secretsmanager create-secret` (see RUNBOOK.md)."
  }
}

# An immutable per-build tag rather than a moving one, so every release is its own task definition and the deployment
# circuit breaker can roll back to one that still names the image it was deployed with. Rolling back by hand is this
# same variable with an older tag. .github/workflows/deploy.yml sets it to web/'s git tree id truncated to 12
# characters, not to a commit SHA (ARCHITECTURE.md).
variable "web_image_tag" {
  description = "Tag identifying the web service's image build, without the -web suffix infra/web.tf appends."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.web_image_tag))
    error_message = "web_image_tag must be an abbreviated git object id (7-40 hex characters) identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

# Not required like web_image_tag, because it has a safe default: the service's own tag. A `-var web_image_tag=` with no
# `-var migrate_image_tag=` therefore keeps every manual command in RUNBOOK.md working unchanged.
# .github/workflows/deploy.yml sets the two to different tags on purpose (ARCHITECTURE.md, Migration ordering).
variable "migrate_image_tag" {
  description = "Tag for the migration task's image build. Empty (the default) mirrors web_image_tag."
  type        = string
  default     = ""

  validation {
    condition     = var.migrate_image_tag == "" || can(regex("^[0-9a-f]{7,40}$", var.migrate_image_tag))
    error_message = "migrate_image_tag must be an abbreviated git object id (7-40 hex characters) identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

# GPU worker deployment stays manual (ARCHITECTURE.md): unlike web_image_tag/migrate_image_tag, no deploy ever
# rebuilds and pushes a worker image, so this changes only when someone hand-builds and pushes a new one (RUNBOOK.md).
# It stays a commit SHA, because scripts/prod/worker-push-image.sh tags the image with the checked-out commit.
# Set as a stable GitHub repository variable for CI the same way worker_ami_id is.
variable "worker_image_tag" {
  description = "Commit SHA identifying the worker image's build, pushed by hand to aws_ecr_repository.worker."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.worker_image_tag))
    error_message = "worker_image_tag must be a commit SHA identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

variable "monthly_budget_limit_usd" {
  description = "AWS Budget threshold. Must stay above the stack's own fixed monthly cost (~$35) or both notifications fire every month regardless of usage."
  type        = number
  default     = 75
}
