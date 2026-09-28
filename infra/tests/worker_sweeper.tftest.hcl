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

run "sweeper_terminate_scoped_by_tag" {
  command = apply

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.worker_sweeper.policy).Statement :
      s.Sid == "TerminateWorker" && s.Action == "ec2:TerminateInstances" &&
      try(s.Condition.StringEquals["ec2:ResourceTag/Role"], "") == "worker"
    ])
    error_message = "the sweeper may only terminate instances tagged Role=worker, or it could stop anything in the account"
  }

  assert {
    condition     = aws_lambda_function.worker_sweeper.environment[0].variables.WORKER_TAG_KEY == "Role" && aws_lambda_function.worker_sweeper.environment[0].variables.WORKER_TAG_VALUE == "worker"
    error_message = "the sweeper must look for the same tag its terminate grant is scoped to"
  }
}

run "sweeper_waits_past_the_lifetime_ceiling" {
  command = apply

  assert {
    condition     = tonumber(aws_lambda_function.worker_sweeper.environment[0].variables.MAX_AGE_MINUTES) > local.worker_max_lifetime_minutes
    error_message = "the sweeper must only terminate instances older than the ceiling their own shutdown enforces"
  }
}

run "sweeper_runs_on_a_schedule" {
  command = apply

  assert {
    condition     = aws_cloudwatch_event_target.worker_sweeper.arn == aws_lambda_function.worker_sweeper.arn
    error_message = "the schedule must invoke the sweeper Lambda"
  }

  assert {
    condition     = aws_lambda_permission.worker_sweeper.source_arn == aws_cloudwatch_event_rule.worker_sweeper.arn
    error_message = "the Lambda must allow the schedule's rule to invoke it"
  }
}

run "sweeper_alerts_the_alert_email" {
  command = apply

  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == var.alert_email && aws_sns_topic_subscription.alerts_email.protocol == "email"
    error_message = "sweeper alerts must reach alert_email"
  }

  assert {
    condition     = aws_lambda_function.worker_sweeper.environment[0].variables.ALERT_TOPIC_ARN == aws_sns_topic.alerts.arn
    error_message = "the sweeper must publish to the topic alert_email subscribes to"
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
