# Bucket/key/region are supplied via `-backend-config` at `terraform init` (see RUNBOOK.md), not hardcoded
# here: the bucket comes from infra/bootstrap/ and its name is account-specific. use_lockfile is Terraform's
# native S3 state locking (>= 1.10) — no separate DynamoDB table needed.
terraform {
  # Same version .github/workflows/ci.yml installs. A floor would let a newer local CLI plan silently.
  required_version = "1.16.2"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = local.project_tag
    }
  }
}

# The Budgets API only operates in us-east-1 regardless of where the rest of the app runs — see budgets.tf.
provider "aws" {
  alias  = "billing"
  region = "us-east-1"

  default_tags {
    tags = {
      Project = local.project_tag
    }
  }
}

data "aws_caller_identity" "current" {}
