# Runs fully offline via mock_provider, so terraform test never reaches real AWS here. The values below are arbitrary
# but well-formed stand-ins for the real ones a deploy passes. See infra/variables.tf for what each one means.
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

  # infra/ deliberately has no aws_nat_gateway or aws_eip resource (see infra/network.tf). A plan never contains one, so
  # there is nothing to assert about their absence here.

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

run "subnets_keep_their_cidrs_as_zones_are_added" {
  command = plan

  # A changed cidr_block replaces the subnet, and RDS and the web tasks can't leave a subnet that is being replaced.
  assert {
    condition = (
      aws_subnet.public["us-west-2a"].cidr_block == "10.0.0.0/24" &&
      aws_subnet.public["us-west-2b"].cidr_block == "10.0.1.0/24" &&
      aws_subnet.private["us-west-2a"].cidr_block == "10.0.2.0/24" &&
      aws_subnet.private["us-west-2b"].cidr_block == "10.0.3.0/24"
    )
    error_message = "the first two zones' subnets must keep the CIDRs they were created with"
  }

  assert {
    condition     = aws_subnet.public["us-west-2c"].cidr_block == "10.0.4.0/24" && length(aws_subnet.private) == 2
    error_message = "the third zone gets a public subnet only, on the next free /24"
  }
}
