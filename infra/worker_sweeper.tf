# The sweeper: a scheduled Lambda that terminates overdue worker instances.
#
# It runs every 10 minutes, terminates any worker instance older than the lifetime ceiling, and emails alert_email the
# list. It backstops the `shutdown -h` each instance schedules for itself in user-data (web/lib/server/ec2Launcher.ts),
# which never gets scheduled when cloud-init itself fails to run.
#
# The email subscription below needs a one-time confirmation click before anything is delivered (RUNBOOK.md).

data "archive_file" "worker_sweeper" {
  type        = "zip"
  source_file = "${path.module}/lambda/worker_sweeper.py"
  # Inside .terraform/ so the build output stays gitignored.
  output_path = "${path.module}/.terraform/build/worker_sweeper.zip"
}

resource "aws_sns_topic" "alerts" {
  name = "ai-gaussian-splatter-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_iam_role" "worker_sweeper" {
  name = "ai-gaussian-splatter-worker-sweeper"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "worker_sweeper" {
  name              = "/aws/lambda/ai-gaussian-splatter-worker-sweeper"
  retention_in_days = 30
}

resource "aws_iam_role_policy" "worker_sweeper" {
  role = aws_iam_role.worker_sweeper.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ec2:DescribeInstances has no resource-level permissions to scope.
      {
        Sid      = "DescribeWorkers"
        Effect   = "Allow"
        Action   = "ec2:DescribeInstances"
        Resource = "*"
      },
      {
        Sid       = "TerminateWorker"
        Effect    = "Allow"
        Action    = "ec2:TerminateInstances"
        Resource  = "*"
        Condition = { StringEquals = { "ec2:ResourceTag/${local.worker_tag_key}" = local.worker_tag_value } }
      },
      {
        Sid      = "PublishAlert"
        Effect   = "Allow"
        Action   = "sns:Publish"
        Resource = aws_sns_topic.alerts.arn
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.worker_sweeper.arn}:*"
      },
    ]
  })
}

resource "aws_lambda_function" "worker_sweeper" {
  function_name    = "ai-gaussian-splatter-worker-sweeper"
  role             = aws_iam_role.worker_sweeper.arn
  runtime          = "python3.14"
  handler          = "worker_sweeper.handler"
  filename         = data.archive_file.worker_sweeper.output_path
  source_code_hash = data.archive_file.worker_sweeper.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      # The grace over the ceiling covers boot, since the ceiling counts from when user-data runs rather than from
      # launch. web/lib/server/reconcileJob.ts allows the same.
      MAX_AGE_MINUTES  = tostring(local.worker_max_lifetime_minutes + 15)
      WORKER_TAG_KEY   = local.worker_tag_key
      WORKER_TAG_VALUE = local.worker_tag_value
      ALERT_TOPIC_ARN  = aws_sns_topic.alerts.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker_sweeper]
}

resource "aws_cloudwatch_event_rule" "worker_sweeper" {
  name                = "ai-gaussian-splatter-worker-sweeper"
  schedule_expression = "rate(10 minutes)"
}

resource "aws_cloudwatch_event_target" "worker_sweeper" {
  rule = aws_cloudwatch_event_rule.worker_sweeper.name
  arn  = aws_lambda_function.worker_sweeper.arn
}

resource "aws_lambda_permission" "worker_sweeper" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker_sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.worker_sweeper.arn
}
