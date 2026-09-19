# The state bucket is created by hand once (RUNBOOK.md, Creating account prerequisites).
terraform {
  # Exact, not a floor. A range would let a newer local CLI plan. scripts/lib/terraform.sh's tf_get_required_version
  # reads this string for local install and for hashicorp/setup-terraform in .github/workflows/ci.yml and
  # .github/workflows/deploy.yml.
  required_version = "1.16.2"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # terraform init -backend-config adds these three arguments to the backend "s3" block:
  #   - bucket = ai-gaussian-splatter-tfstate-<account-id>
  #   - key    = infra.tfstate
  #   - region = the default of var.aws_region in infra/variables.tf
  # bucket is not written in HCL here because its name would pin infra/ to one account.
  backend "s3" {
    # Terraform's native S3 state locking (>= 1.10). No separate DynamoDB table is needed.
    # use_lockfile is not the HCL lockfile infra/.terraform.lock.hcl. That file pins provider versions.
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

# The Budgets API only operates in us-east-1 regardless of where the rest of the app runs — see infra/budgets.tf.
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
