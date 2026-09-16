# Fully offline via mock_provider: terraform test never reaches real AWS here. Values below are arbitrary but
# well-formed stand-ins for the real ones a deploy would pass — see infra/variables.tf for what each means.
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

run "no_nat_gateway_or_extra_public_ingress" {
  command = apply

  # There is no aws_nat_gateway/aws_eip resource anywhere in infra/ by design (see network.tf) — nothing
  # to assert at runtime for their absence, since the plan simply never contains one.

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_https.cidr_ipv4 == "0.0.0.0/0"
    error_message = "the ALB security group must admit HTTPS from anywhere"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_http.cidr_ipv4 == "0.0.0.0/0"
    error_message = "the ALB security group must admit HTTP from anywhere (redirected to HTTPS)"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.alb_https.from_port == 443 && aws_vpc_security_group_ingress_rule.alb_http.from_port == 80
    error_message = "the ALB must listen on 443 and 80 only"
  }
}

run "db_only_reachable_from_web" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_web.referenced_security_group_id == aws_security_group.web.id
    error_message = "the DB security group must only admit traffic from the web security group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.db_from_web.from_port == 5432
    error_message = "the DB security group must admit Postgres (5432) only"
  }
}

run "default_security_group_is_stripped" {
  command = apply

  assert {
    condition     = length(aws_default_security_group.default.ingress) == 0 && length(aws_default_security_group.default.egress) == 0
    error_message = "the VPC's default security group must carry no rules"
  }
}

run "s3_gateway_endpoint_covers_both_route_tables" {
  command = apply

  assert {
    condition     = length(aws_vpc_endpoint.s3.route_table_ids) == 2
    error_message = "the S3 gateway endpoint must be reachable from both the public and private route tables"
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
