# The inputs to infra/: every value that differs between deployments.
#
# Each variable is set on the command line or, for the deploy job, from a GitHub repository variable. Most required ones
# have a validation block, so a missing or malformed value fails before Terraform reaches AWS.

# Editing this default on a live account has an order to it. Tear the stack down first, while the default still names
# the region the stack is deployed in (AGENTS.md).
variable "aws_region" {
  description = "Primary region for every resource except the budgets provider (us-east-1, fixed — see providers.tf)."
  type        = string
  default     = "us-west-2"
}

# The AMI every worker instance boots. Only forwarded to the web task as WORKER_AMI_ID; the first thing to test it
# is the RunInstances call in web/lib/server/workerLauncher.ts, one worker job at a time.
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

# Where every alert goes. These reach it through an SNS email subscription, which delivers nothing until the address
# confirms it:
# - infra/alarms.tf (the CloudWatch alarms)
# - infra/worker_sweeper.tf (the worker sweeper)
# The AWS Budget (infra/budgets.tf) emails it directly.
variable "alert_email" {
  description = "Email address the CloudWatch alarms, the worker sweeper and the AWS Budget notify."
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
# record (see AGENTS.md). `scripts/prod/bootstrap.sh gh-vars` looks the id up from that name.
variable "hosted_zone_id" {
  description = "Route 53 hosted zone id for var.domain_zone_name. Only records are added here; the zone itself is never created or destroyed by this config."
  type        = string

  # Catches the empty string CI sends for an unset repository variable (AGENTS.md), or the `/hostedzone/`-prefixed form
  # the Route 53 API returns, which `scripts/prod/bootstrap.sh gh-vars` strips.
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

# No deploy builds a worker image, so this changes only when scripts/prod/worker-push-image.sh pushes one (RUNBOOK.md).
# That script tags the images with worker/'s git tree id on main, truncated to 12 characters, and sets the
# WORKER_IMAGE_TAG repository variable .github/workflows/deploy.yml passes in here.
variable "worker_image_tag" {
  description = "Tag identifying the worker images' build, without the -reconstruct/-train suffix infra/locals.tf appends."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.worker_image_tag))
    error_message = "worker_image_tag must be an abbreviated git object id (7-40 hex characters) identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

variable "monthly_budget_limit_usd" {
  description = "AWS Budget threshold. Must stay above the stack's own fixed monthly cost (~$35) or both notifications fire every month regardless of usage."
  type        = number
  default     = 75
}
