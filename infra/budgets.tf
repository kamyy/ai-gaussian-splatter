# The infra-level spend safety net: an AWS Budget, deliberately separate from the application-level rate
# limiting/daily-cap logic in the web app.
#
# The Budgets API only operates against us-east-1, regardless of where the rest of the app runs — hence
# provider = aws.billing (see infra/providers.tf).

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
