# The independent, infra-level safety net: an AWS Budget alert plus a CloudWatch billing alarm, deliberately
# separate from the application-level rate limiting/daily-cap logic in the web app, so a bug in that logic
# can't silently blow the budget unnoticed.
#
# Billing metrics and the Budgets API only publish/operate against us-east-1, regardless of where the rest of
# the app runs — hence provider = aws.billing throughout this file (see providers.tf).

# A customer-managed key, not the alias/aws/sns default: the default's policy can't be edited, and it doesn't
# let CloudWatch call kms:GenerateDataKey. The alarm below would then fail its action with "CloudWatch Alarms
# does not have authorization to access the SNS topic encryption key" and silently never notify. Costs
# $1/month, which is the price of encrypting the one channel that reports how much this account is spending.
resource "aws_kms_key" "billing_alerts" {
  provider = aws.billing

  description         = "Encrypts the billing alert SNS topic"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableIAMUserPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchToUseTheKey"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_sns_topic" "billing_alerts" {
  provider = aws.billing

  name              = "ai-gaussian-splatter-billing-alerts"
  kms_master_key_id = aws_kms_key.billing_alerts.id
}

resource "aws_sns_topic_subscription" "billing_alerts_email" {
  provider = aws.billing

  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_budgets_budget" "monthly" {
  provider = aws.billing

  name         = "ai-gaussian-splatter-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(var.monthly_budget_limit_usd)
  limit_unit   = "USD"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# EstimatedCharges publishes nothing at all until "Receive Billing Alerts" is switched on in the account's
# billing preferences (a console-only setting — see RUNBOOK.md). treat_missing_data is stated explicitly so the
# no-data case reads as "not wired up yet" rather than as an alarm.
resource "aws_cloudwatch_metric_alarm" "billing" {
  provider = aws.billing

  alarm_name          = "ai-gaussian-splatter-estimated-charges"
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  dimensions          = { Currency = "USD" }
  statistic           = "Maximum"
  period              = 21600
  evaluation_periods  = 1
  threshold           = var.monthly_budget_limit_usd
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.billing_alerts.arn]
}
