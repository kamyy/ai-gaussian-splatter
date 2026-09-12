mock_provider "aws" {}

mock_provider "aws" {
  alias = "billing"
}

variables {
  worker_ami_id        = "ami-0123456789abcdef0"
  alert_email          = "test@example.com"
  hosted_zone_id       = "Z00000000000000000000"
  clerk_secret_key_arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:ai-gaussian-splatter/clerk-secret-key-AAAAAA"
  web_image_tag        = "0123abc"
}

run "worker_self_terminate_scoped_by_tag" {
  command = apply

  assert {
    condition     = jsondecode(aws_iam_role_policy.worker_self_terminate.policy).Statement[0].Condition.StringEquals["ec2:ResourceTag/Role"] == "worker"
    error_message = "the worker's self-terminate grant must be scoped to instances tagged Role=worker, matching web.tf's task role condition"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.worker_self_terminate.policy).Statement[0].Action == "ec2:TerminateInstances"
    error_message = "the worker role must be able to terminate itself"
  }
}

run "worker_instance_profile_wraps_the_role" {
  command = apply

  assert {
    condition     = aws_iam_instance_profile.worker.role == aws_iam_role.worker.name
    error_message = "the instance profile must wrap the worker role"
  }
}

# mock_provider fills computed attributes with plausible-looking scalars, but leaves computed
# lists/sets empty by default and doesn't know about format-validated fields (ARNs). These overrides
# give the handful of computed values other resources in this config actually depend on (or validate
# the shape of) something usable, so the whole plan resolves offline.
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
      domain_name           = "ai-gaussian-splatter.orky.net"
      resource_record_name  = "_mock.ai-gaussian-splatter.orky.net."
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
  target = aws_sns_topic.billing_alerts
  values = {
    arn = "arn:aws:sns:us-east-1:000000000000:ai-gaussian-splatter-billing-alerts"
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
