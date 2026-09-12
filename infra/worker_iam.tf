# The GPU spot worker's IAM role/instance profile — scoped to exactly: S3 read (uploads), S3 read/write
# (splats), and terminating itself. No other permissions, so a compromised instance can't do much beyond its
# own job.

resource "aws_iam_role" "worker" {
  name        = "ai-gaussian-splatter-worker"
  description = "GPU spot worker instance role: S3 read on uploads, read/write on splats, self-terminate only"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "worker_uploads_read" {
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.s3_read_actions
      Resource = [aws_s3_bucket.uploads.arn, "${aws_s3_bucket.uploads.arn}/*"]
    }]
  })
}

resource "aws_iam_role_policy" "worker_splats_read_write" {
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.s3_read_write_actions
      Resource = [aws_s3_bucket.splats.arn, "${aws_s3_bucket.splats.arn}/*"]
    }]
  })
}

# Self-termination only, scoped so the worker can kill itself at the end of its job (worker/run_job.py's
# finally block) but nothing else running in the account. EC2 doesn't support resource-level restriction to
# "the calling instance" directly, so this is scoped by the same worker-tag convention used in web.tf's
# RunInstances grant — see locals.tf for the shared tag key/value.
resource "aws_iam_role_policy" "worker_self_terminate" {
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "ec2:TerminateInstances"
      Resource  = "*"
      Condition = { StringEquals = { "ec2:ResourceTag/${local.worker_tag_key}" = local.worker_tag_value } }
    }]
  })
}

# AWSServiceRoleForEC2Spot is not managed here: it's one account-wide role shared by every other Spot workload,
# so creating it fails outright in an account that already has one, and Terraform deleting it on this config's
# behalf would break those other workloads. It has to exist before web/lib/server/ec2Launcher.ts's first
# RunInstances call — see RUNBOOK.md for the one-time setup.
resource "aws_iam_instance_profile" "worker" {
  name = "ai-gaussian-splatter-worker"
  role = aws_iam_role.worker.name
}
