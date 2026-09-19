# RDS Postgres and the two S3 buckets the app reads and writes (uploads, splats). The ALB's access-log bucket lives in
# web.tf, beside the load balancer that writes it.
#
# The uploads and splats buckets' CORS rules name local.app_origin rather than "*": the browser talks to S3
# directly on both legs (presigned PUT on upload, presigned GET in the viewer), so "*" would let another
# origin's JavaScript read a shared or leaked splat URL cross-origin via fetch/XHR. It does not stop a leaked
# URL from being opened directly (CORS only gates cross-origin script reads, not navigation).

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

# Uploads (source photos) and splats (the deliverable) are both kept indefinitely. Nothing expires them; delete an
# object by hand if it should go.
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

# Adds the aws:SecureTransport deny. The browser reaches this bucket directly on a presigned URL, one of
# several hops in this architecture that cross the public internet (alongside the ALB and the worker's status
# callback to it).
resource "aws_s3_bucket_policy" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  policy = local.deny_insecure_transport_policy["uploads"]
}

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

# Needed for the same reason as on uploads, in the other direction: the viewer fetches the .ply straight from S3 in
# the browser (web/components/viewer/SplatViewer.tsx passes the presigned URL to DropInViewer), so it is a
# cross-origin GET that S3 rejects without a matching rule.
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
