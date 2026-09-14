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
  worker_image_tag     = "0123abc"
}

run "repository_is_fixed_name_immutable_and_force_deletable" {
  command = apply

  assert {
    condition     = aws_ecr_repository.web.name == "ai-gaussian-splatter"
    error_message = "repository name is a fixed literal that RUNBOOK.md and .github/workflows/deploy.yml name directly"
  }

  assert {
    condition     = aws_ecr_repository.web.image_tag_mutability == "IMMUTABLE"
    error_message = "a pushed tag must never be repointable, or the circuit breaker's rollback means nothing"
  }

  assert {
    condition     = aws_ecr_repository.web.force_delete == true
    error_message = "a full `terraform destroy` must not get stuck on a non-empty repository"
  }
}

run "lifecycle_policy_keeps_web_and_migrate_tags_separately" {
  command = apply

  assert {
    condition     = length(jsondecode(aws_ecr_lifecycle_policy.web.policy).rules) == 2
    error_message = "exactly one lifecycle rule per tag suffix (*-web, *-migrate) is expected"
  }

  assert {
    condition = anytrue([
      for rule in jsondecode(aws_ecr_lifecycle_policy.web.policy).rules :
      contains(rule.selection.tagPatternList, "*-web") && rule.selection.countNumber == 10
    ])
    error_message = "the *-web rule must cap at RELEASES_KEPT (10)"
  }

  assert {
    condition = anytrue([
      for rule in jsondecode(aws_ecr_lifecycle_policy.web.policy).rules :
      contains(rule.selection.tagPatternList, "*-migrate") && rule.selection.countNumber == 10
    ])
    error_message = "the *-migrate rule must cap at RELEASES_KEPT (10)"
  }
}

run "worker_repository_is_separate_immutable_and_force_deletable" {
  command = apply

  assert {
    condition     = aws_ecr_repository.worker.name == "ai-gaussian-splatter-worker"
    error_message = "the worker repository name is a fixed literal RUNBOOK.md names directly"
  }

  assert {
    condition     = aws_ecr_repository.worker.image_tag_mutability == "IMMUTABLE"
    error_message = "a pushed worker tag must never be repointable, matching the web repository's discipline"
  }

  assert {
    condition     = aws_ecr_repository.worker.force_delete == true
    error_message = "a full `terraform destroy` must not get stuck on a non-empty repository"
  }
}

run "worker_lifecycle_keeps_far_fewer_images_than_web" {
  command = apply

  assert {
    condition = anytrue([
      for rule in jsondecode(aws_ecr_lifecycle_policy.worker.policy).rules :
      contains(rule.selection.tagPatternList, "*") && rule.selection.countNumber == 2
    ])
    error_message = "the ~19 GB worker image isn't part of any ECS rollback mechanism, so it should keep far fewer images than RELEASES_KEPT (10)"
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
