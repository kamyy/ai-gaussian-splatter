# Creates the S3 bucket that infra/'s own state lives in. Chicken-and-egg with the "backend s3" block
# that bucket is used for, so this config keeps its own local state and is applied once per account,
# before the first `terraform init` in infra/. See RUNBOOK.md's "First-time account setup" section.

terraform {
  # Same version .github/workflows/ci.yml installs. A floor would let a newer local CLI plan silently.
  required_version = "1.16.2"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "ai-gaussian-splatter"
    }
  }
}

data "aws_caller_identity" "current" {}

# No fixed literal name: bucket names are global, so the account id keeps this from colliding with
# another account's state bucket without anyone having to pick one by hand.
resource "aws_s3_bucket" "state" {
  bucket = "ai-gaussian-splatter-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
