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

run "database_config" {
  command = apply

  assert {
    condition     = aws_db_instance.main.engine == "postgres" && aws_db_instance.main.engine_version == "18"
    error_message = "must be Postgres 18"
  }

  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.micro" && aws_db_instance.main.multi_az == false
    error_message = "single-AZ db.t4g.micro at this traffic level"
  }

  assert {
    condition     = aws_db_instance.main.storage_type == "gp3"
    error_message = "gp3, not gp2 — gp2's floor is 100 IOPS at this size, gp3 includes 3000"
  }

  assert {
    condition     = aws_db_instance.main.backup_retention_period == 7
    error_message = "RDS defaults to 1 day, which is too short a recovery window given no deletion protection"
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true
    error_message = "credentials must come from RDS's own managed Secrets Manager secret, never a literal password"
  }

  assert {
    condition     = aws_db_instance.main.skip_final_snapshot == true && aws_db_instance.main.deletion_protection == false
    error_message = "no live data exists yet to protect, so a bare `terraform destroy` must fully remove the instance"
  }
}

run "bucket_cors_matches_the_app_origin" {
  command = apply

  # cors_rule (and its nested attributes) come back as sets, whose elements have no addressable index — iterate
  # with a `for` expression and check membership instead of indexing with [0].
  assert {
    condition = anytrue([
      for r in aws_s3_bucket_cors_configuration.uploads.cors_rule : toset(r.allowed_methods) == toset(["PUT"])
    ])
    error_message = "uploads bucket must allow PUT only"
  }

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_cors_configuration.uploads.cors_rule :
      contains(tolist(r.allowed_origins), "https://ai-gaussian-splatter.example.com")
    ])
    error_message = "a trailing slash on app_public_url must be stripped before it reaches the CORS origin"
  }

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_cors_configuration.splats.cors_rule : toset(r.allowed_methods) == toset(["GET", "HEAD"])
    ])
    error_message = "splats bucket must allow GET+HEAD only"
  }

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_cors_configuration.uploads.cors_rule : !contains(tolist(r.allowed_origins), "*")
    ])
    error_message = "CORS origin must never be *, or a leaked splat/upload URL is readable cross-origin"
  }
}

run "buckets_force_destroy_and_block_public_access" {
  command = apply

  assert {
    condition     = alltrue([for b in [aws_s3_bucket.uploads, aws_s3_bucket.splats, aws_s3_bucket.access_logs] : b.force_destroy == true])
    error_message = "every bucket must be force_destroy=true so `terraform destroy` doesn't get stuck on a non-empty bucket"
  }

  assert {
    condition     = alltrue([for p in [aws_s3_bucket_public_access_block.uploads, aws_s3_bucket_public_access_block.splats, aws_s3_bucket_public_access_block.access_logs] : p.block_public_acls && p.block_public_policy])
    error_message = "every bucket must block all public access"
  }
}

# mock_provider fills computed attributes with plausible-looking scalars, but leaves computed
# lists/sets empty by default and doesn't know about format-validated fields (ARNs). These overrides
# give the handful of computed values other resources in infra/ actually depend on (or validate
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
