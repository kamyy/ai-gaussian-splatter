# The permissions a GPU worker instance runs with.
#
# The IAM role and instance profile web/lib/server/ec2Launcher.ts attaches to each worker instance, and the CloudWatch
# log group their container output goes to. Both bucket grants cover the whole bucket, not just the calling worker
# job's own objects. The terminate grant matches every worker instance, not only the caller. EC2 has no resource-level
# condition for "the calling instance" that could narrow either one.
#
# AWSServiceRoleForEC2Spot is deliberately not managed here. It is one account-wide role shared by every other Spot
# workload, so creating it fails in an account that already has one, and letting Terraform delete it would break those
# other workloads. It has to exist before web/lib/server/ec2Launcher.ts's first RunInstances call. See RUNBOOK.md for
# the one-time setup.

resource "aws_iam_role" "worker" {
  name        = "ai-gaussian-splatter-worker"
  description = "GPU spot worker instance role: ECR pull, S3 read on uploads, read/write on splats, terminate instances tagged Role=worker"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# Where each worker instance's container output goes, so COLMAP and gsplat output outlives the instance that printed it.
# web/lib/server/ec2Launcher.ts's `docker run` names this group and creates one stream per worker job stage. The group
# is created here rather than by the Docker log driver, so the instance role needs no logs:CreateLogGroup.
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ai-gaussian-splatter/worker"
  retention_in_days = 30
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # web/lib/server/ec2Launcher.ts's user-data runs `aws ecr get-login-password` and then `docker run`, which pulls
      # aws_ecr_repository.worker's image using this instance's own role. Nothing else authenticates that pull.
      # ecr:GetAuthorizationToken has no resource-level permissions to scope.
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "EcrPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.worker.arn
      },
      {
        Sid      = "UploadsRead"
        Effect   = "Allow"
        Action   = local.s3_read_actions
        Resource = [aws_s3_bucket.uploads.arn, "${aws_s3_bucket.uploads.arn}/*"]
      },
      {
        Sid      = "SplatsReadWrite"
        Effect   = "Allow"
        Action   = local.s3_read_write_actions
        Resource = [aws_s3_bucket.splats.arn, "${aws_s3_bucket.splats.arn}/*"]
      },
      # What lets the `docker run` in web/lib/server/ec2Launcher.ts's user-data write to aws_cloudwatch_log_group.worker.
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.worker.arn}:*"
      },
      # What lets worker/run_job.py's finally block terminate its own instance at the end of a stage, scoped by the
      # same worker-tag convention infra/web.tf's RunInstances grant uses (infra/locals.tf holds the shared tag
      # key/value).
      {
        Sid       = "SelfTerminate"
        Effect    = "Allow"
        Action    = "ec2:TerminateInstances"
        Resource  = "*"
        Condition = { StringEquals = { "ec2:ResourceTag/${local.worker_tag_key}" = local.worker_tag_value } }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "worker" {
  name = "ai-gaussian-splatter-worker"
  role = aws_iam_role.worker.name
}
