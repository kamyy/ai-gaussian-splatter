# RDS Postgres (single-AZ, db.t4g.micro — a genuinely relational schema at low traffic, with no need for
# Multi-AZ at this scale) and the two S3 buckets (uploads, splats).
#
# Both buckets' CORS rules name local.app_origin rather than "*": the browser talks to S3 directly on both legs
# (presigned PUT on upload, presigned GET in the viewer), so "*" would let any page a visitor lands on read a
# shared or leaked splat URL cross-origin.

resource "aws_db_subnet_group" "main" {
  name       = "ai-gaussian-splatter"
  subnet_ids = [for s in aws_subnet.private : s.id]
}

resource "aws_db_instance" "main" {
  identifier     = "ai-gaussian-splatter"
  engine         = "postgres"
  engine_version = "18"
  instance_class = "db.t4g.micro"

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  multi_az               = false

  allocated_storage = 20
  # gp2's baseline is 3 IOPS/GiB with a 100 IOPS floor, so at 20 GiB the floor is all there is. gp3 includes
  # 3000 IOPS and 125 MiB/s at any size from 20 GiB up.
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = local.database_name
  username = "splatter_admin"
  # RDS creates and rotates its own Secrets Manager secret for the master password, with no separate
  # `random_password` resource needed. The generated secret's JSON includes both `username` and `password`
  # fields, so web.tf reads both off the one secret ARN in `aws_db_instance.main.master_user_secret[0].secret_arn`.
  manage_master_user_password = true

  # RDS defaults to 1 day, which is the whole recovery window for a bad migration given no deletion protection.
  # Backups of a 20 GiB instance are nearly free.
  backup_retention_period = 7
  # RDS windows are fixed UTC and don't shift for DST. 10:00 UTC is 3am Pacific during PDT, drifting to 2am
  # Pacific during PST.
  maintenance_window = "sun:10:00-sun:10:30"

  deletion_protection = false
  # No live data exists yet to protect, so a bare `terraform destroy` removes the instance outright with no
  # final snapshot. Revisit before a real deploy holds real user data.
  skip_final_snapshot = true
}

# Uploads are ephemeral (source photos, not the deliverable). They expire after 90 days to bound storage cost;
# splats are the actual output and kept indefinitely (no lifecycle rule).
resource "aws_s3_bucket" "uploads" {
  bucket_prefix = "ai-gaussian-splatter-uploads-"
  # No live data exists yet to protect, so `terraform destroy` empties and deletes this bucket outright.
  # Revisit before a real deploy holds real uploads.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [local.app_origin]
    allowed_headers = ["*"]
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-after-90-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

# Adds the aws:SecureTransport deny. The browser reaches this bucket directly on a presigned URL, which is the
# one hop in this architecture that leaves AWS's network.
resource "aws_s3_bucket_policy" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  policy = local.deny_insecure_transport_policy["uploads"]
}

# CORS is needed here for the same reason as on uploads, in the other direction: the viewer fetches the .ply
# straight from S3 in the browser (web/components/viewer/SplatViewer.tsx passes the presigned URL to
# DropInViewer), so it is a cross-origin GET that S3 rejects without a matching rule.
resource "aws_s3_bucket" "splats" {
  bucket_prefix = "ai-gaussian-splatter-splats-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "splats" {
  bucket                  = aws_s3_bucket.splats.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "splats" {
  bucket = aws_s3_bucket.splats.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "splats" {
  bucket = aws_s3_bucket.splats.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = [local.app_origin]
    allowed_headers = ["*"]
  }
}

resource "aws_s3_bucket_policy" "splats" {
  bucket = aws_s3_bucket.splats.id
  policy = local.deny_insecure_transport_policy["splats"]
}

# ALB access logs are written by the ELB service rather than by the app, so no CORS rule is needed. The ALB is
# otherwise the one hop that keeps no record of who called. 90 days is how far back an abuse investigation is
# likely to reach.
resource "aws_s3_bucket" "access_logs" {
  bucket_prefix = "ai-gaussian-splatter-access-logs-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-after-90-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

# The ALB's own log-delivery service principal needs a bucket policy statement granting it PutObject before
# `aws_lb.web`'s `access_logs` block (web.tf) can write here — Terraform's `aws_lb` resource doesn't add this
# automatically, so it has to be written out by hand.
resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowALBLogDelivery"
        Effect    = "Allow"
        Principal = { Service = "logdelivery.elasticloadbalancing.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.access_logs.arn}/*"
        # Without this, any account whose ALB is pointed at this bucket's name could write log objects into it —
        # the service principal alone isn't restricted to this account's own load balancers.
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# Adds the aws:SecureTransport deny to a bucket that otherwise has no other policy statement of its own.
locals {
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
