# CloudWatch alarms that email alert_email when the live site degrades.
#
# Each alarm publishes to aws_sns_topic.alerts (infra/worker_sweeper.tf), the same topic the sweeper uses, so one
# confirmed email subscription covers them all. The thresholds are first guesses, to be tuned against real traffic.
# treat_missing_data is notBreaching on all four alarms. A quiet site reports no 5xx data points, so that alarm
# stays healthy. The unhealthy-host, sweeper-error, and RDS-storage alarms use the same setting so a missing metric
# does not page.

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "ai-gaussian-splatter-alb-target-5xx"
  alarm_description   = "The web tasks returned ${local.alarm_5xx_threshold}+ 5xx responses in ${local.alarm_period_seconds / 60} minutes. Read the web logs (RUNBOOK.md)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix }
  statistic           = "Sum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = local.alarm_5xx_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  alarm_name          = "ai-gaussian-splatter-alb-unhealthy-hosts"
  alarm_description   = "A web task has failed its ALB health check for ${local.alarm_period_seconds / 60} minutes. Check the ECS service's events."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Maximum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_sweeper_errors" {
  alarm_name          = "ai-gaussian-splatter-worker-sweeper-errors"
  alarm_description   = "The worker sweeper Lambda failed, so overdue worker instances may keep billing. Read its logs (RUNBOOK.md)."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.worker_sweeper.function_name }
  statistic           = "Sum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_low_storage" {
  alarm_name          = "ai-gaussian-splatter-rds-low-storage"
  alarm_description   = "The database has under ${local.alarm_rds_free_storage_bytes / 1073741824} GB of free storage."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = local.alarm_period_seconds
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = local.alarm_rds_free_storage_bytes
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
