mock_provider "aws" {}

mock_provider "aws" {
  alias = "billing"
}

variables {
  worker_ami_id        = "ami-0123456789abcdef0"
  alert_email          = "test@example.com"
  hosted_zone_id       = "Z00000000000000000000"
  domain_zone_name     = "example.com"
  clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:ai-gaussian-splatter/clerk-secret-key-AAAAAA"
  web_image_tag        = "0123abc"
  worker_image_tag     = "0123abc"
}

run "alarms_publish_to_the_alert_topic" {
  command = apply

  assert {
    condition = alltrue([
      for a in [
        aws_cloudwatch_metric_alarm.alb_target_5xx,
        aws_cloudwatch_metric_alarm.alb_unhealthy_hosts,
        aws_cloudwatch_metric_alarm.worker_sweeper_errors,
        aws_cloudwatch_metric_alarm.rds_low_storage,
      ] : a.alarm_actions == toset([aws_sns_topic.alerts.arn])
    ])
    error_message = "every alarm must publish to the alerts topic, the only one with a confirmed email subscription"
  }

  assert {
    condition = alltrue([
      for a in [
        aws_cloudwatch_metric_alarm.alb_target_5xx,
        aws_cloudwatch_metric_alarm.alb_unhealthy_hosts,
        aws_cloudwatch_metric_alarm.worker_sweeper_errors,
        aws_cloudwatch_metric_alarm.rds_low_storage,
      ] : startswith(a.alarm_name, "ai-gaussian-splatter-") && a.treat_missing_data == "notBreaching"
    ])
    error_message = "alarm names need the ai-gaussian-splatter- prefix the CI role's grant is scoped to, and a quiet site must not alarm"
  }
}

run "alarms_watch_the_right_resources" {
  command = apply

  assert {
    condition     = aws_cloudwatch_metric_alarm.alb_target_5xx.dimensions["LoadBalancer"] == aws_lb.web.arn_suffix
    error_message = "the 5xx alarm must watch the web ALB"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.alb_unhealthy_hosts.dimensions["LoadBalancer"] == aws_lb.web.arn_suffix
      && aws_cloudwatch_metric_alarm.alb_unhealthy_hosts.dimensions["TargetGroup"] == aws_lb_target_group.web.arn_suffix
    )
    error_message = "the unhealthy-host alarm needs both the ALB and the target group dimensions, or it never reports data"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.worker_sweeper_errors.dimensions["FunctionName"] == aws_lambda_function.worker_sweeper.function_name
    error_message = "the sweeper alarm must watch the sweeper Lambda"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.rds_low_storage.dimensions["DBInstanceIdentifier"] == aws_db_instance.main.identifier
    error_message = "the storage alarm must watch the application database"
  }
}

# mock_provider fills computed attributes with plausible-looking values, but it leaves computed lists and sets empty and
# knows nothing about format-validated fields such as ARNs. These overrides supply usable values for the few computed
# attributes that other resources in infra/ read or validate, so the whole plan resolves offline.
override_resource {
  target = aws_db_instance.main
  values = {
    address = "ai-gaussian-splatter.mock.us-west-2.rds.amazonaws.com"
    port    = 5432
    master_user_secret = [{
      secret_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:mock-db-secret-AbCdEf"
    }]
  }
}

override_resource {
  target = aws_acm_certificate.web
  values = {
    arn = "arn:aws:acm:us-west-2:000000000000:certificate/mock-cert-id"
    domain_validation_options = [{
      domain_name           = "ai-gaussian-splatter.example.com"
      resource_record_name  = "_mock.ai-gaussian-splatter.example.com."
      resource_record_type  = "CNAME"
      resource_record_value = "_mock.acm-validations.aws."
    }]
  }
}

override_resource {
  target = aws_lb.web
  values = {
    arn      = "arn:aws:elasticloadbalancing:us-west-2:000000000000:loadbalancer/app/ai-gaussian-splatter/abc123"
    dns_name = "ai-gaussian-splatter-123456.us-west-2.elb.amazonaws.com"
    zone_id  = "Z1H1FL5HABSF5"
  }
}

override_resource {
  target = aws_iam_role.execution
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-execution"
  }
}

override_resource {
  target = aws_iam_role.migration_task
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-migrate-task"
  }
}

override_resource {
  target = aws_iam_role.task
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-task"
  }
}

override_resource {
  target = aws_iam_role.worker
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-worker"
  }
}

override_resource {
  target = aws_lb_target_group.web
  values = {
    arn = "arn:aws:elasticloadbalancing:us-west-2:000000000000:targetgroup/ai-gaussian-splatter-web/abc123"
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "000000000000"
  }
}

override_resource {
  target = aws_iam_role.worker_sweeper
  values = {
    arn = "arn:aws:iam::000000000000:role/ai-gaussian-splatter-worker-sweeper"
  }
}

override_resource {
  target = aws_sns_topic.alerts
  values = {
    arn = "arn:aws:sns:us-west-2:000000000000:ai-gaussian-splatter-alerts"
  }
}

override_resource {
  target = aws_lambda_function.worker_sweeper
  values = {
    arn = "arn:aws:lambda:us-west-2:000000000000:function:ai-gaussian-splatter-worker-sweeper"
  }
}

override_resource {
  target = aws_cloudwatch_event_rule.worker_sweeper
  values = {
    arn = "arn:aws:events:us-west-2:000000000000:rule/ai-gaussian-splatter-worker-sweeper"
  }
}
