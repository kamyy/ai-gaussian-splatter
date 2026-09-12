variable "aws_region" {
  description = "Primary region for every resource except the budgets provider (us-east-1, fixed — see locals.tf)."
  type        = string
  default     = "us-west-2"
}

# The AMI each job's spot instance boots. Only forwarded to the web task as WORKER_AMI_ID; the first thing to
# test it is the RunInstances call in web/lib/server/ec2Launcher.ts, a job at a time.
variable "worker_ami_id" {
  description = "AMI each job's GPU spot instance boots. Must carry Docker, the NVIDIA driver/container toolkit, and the AWS CLI (see RUNBOOK.md)."
  type        = string
}

# Where the billing budget/alarm send spend alerts, as an SNS email subscription.
variable "alert_email" {
  description = "Email address the AWS Budget and CloudWatch billing alarm notify."
  type        = string
}

# The orky.net hosted zone, imported for the ALB's alias record and ACM's validation record — see AGENTS.md.
variable "hosted_zone_id" {
  description = "Route 53 hosted zone id for orky.net. Only records are added here; the zone itself is never created or destroyed by this config."
  type        = string
}

# The Clerk secret is created by hand before the first apply and only referenced here, so its ARN (suffix and
# all) has to be passed in — see AGENTS.md.
variable "clerk_secret_key_arn" {
  description = "Complete ARN (including Secrets Manager's suffix) of the ai-gaussian-splatter/clerk-secret-key secret."
  type        = string

  # Catches a missing suffix, a bare secret name, or the wrong secret name. A variable validation block can only
  # see the variable's own value, not other resources, so it can't also check the ARN's account/region match this
  # deploy's own — that cross-check is a lifecycle precondition on aws_iam_role_policy.execution_clerk_secret_read
  # in web.tf instead.
  validation {
    condition     = can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:\\d{12}:secret:ai-gaussian-splatter/clerk-secret-key-[A-Za-z0-9]{6}$", var.clerk_secret_key_arn))
    error_message = "clerk_secret_key_arn must be the complete ARN of ai-gaussian-splatter/clerk-secret-key, including its 6-character suffix, as returned by `aws secretsmanager create-secret` (see RUNBOOK.md)."
  }
}

# A commit SHA rather than a moving tag, so every release is its own task definition and the deployment circuit
# breaker can roll back to one that still names the image it was deployed with. Rolling back by hand is this
# same variable with an older SHA.
variable "web_image_tag" {
  description = "Commit SHA identifying the web service's image build."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.web_image_tag))
    error_message = "web_image_tag must be a commit SHA identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

# Not required like web_image_tag: it has a safe default (mirror the service's own tag), so a bare
# `-var web_image_tag=` with no `-var migrate_image_tag=` keeps every existing manual RUNBOOK invocation
# working unchanged. .github/workflows/ci.yml's deploy job diverges the two on purpose — see RUNBOOK.md.
variable "migrate_image_tag" {
  description = "Commit SHA for the migration task's image build. Empty (the default) mirrors web_image_tag."
  type        = string
  default     = ""

  validation {
    condition     = var.migrate_image_tag == "" || can(regex("^[0-9a-f]{7,40}$", var.migrate_image_tag))
    error_message = "migrate_image_tag must be a commit SHA identifying one immutable build, not a moving tag (see RUNBOOK.md)."
  }
}

# Where the GPU worker PATCHes job status back to. A stable custom domain, so there is no chicken-and-egg with
# the ALB this config creates: the ALB is aliased to this name rather than the name being read off the ALB.
variable "app_public_url" {
  description = "Public HTTPS origin the app is reachable at. Must match local.app_hostname or status callbacks silently fail."
  type        = string
  default     = "https://ai-gaussian-splatter.orky.net"

  validation {
    condition     = startswith(var.app_public_url, "https://")
    error_message = "app_public_url must be an https:// URL."
  }
}

variable "monthly_budget_limit_usd" {
  description = "AWS Budget / CloudWatch billing alarm threshold. Must stay above the stack's own fixed monthly cost (~$35) or both notifications fire every month regardless of usage."
  type        = number
  default     = 75
}

locals {
  # Normalized here, not at either use, because both consumers append to it and neither tolerates a trailing
  # slash: worker/pipeline/status.py's callback URL would double-slash, and the S3 CORS rules in data.tf match
  # the browser's Origin header exactly.
  app_origin = trimsuffix(var.app_public_url, "/")

  migrate_image_tag = var.migrate_image_tag != "" ? var.migrate_image_tag : var.web_image_tag
}
