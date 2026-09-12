# VPC, subnets, and security groups. Deliberately minimal — one VPC with public + isolated subnets across 2
# AZs, no NAT gateway or multi-AZ complexity, since this is a low-traffic demo project, not a production-scale
# service.
#
# nat_gateways=0 equivalent: everything needing outbound internet (the web tasks, the GPU workers) runs in the
# public subnets with a public IP and egresses through the internet gateway instead — ARCHITECTURE.md has the
# cost reasoning. The security groups, not the absence of a route, are therefore what keep those tasks
# unreachable from outside. The isolated subnets hold only RDS, which needs no outbound access.
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "ai-gaussian-splatter"
  }
}

# Every VPC gets a default security group with an allow-all ingress/egress rule from AWS itself. Managing it here
# with no ingress/egress blocks strips both, so nothing can attach to it and inherit an open rule by accident.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  for_each = { for idx, az in local.availability_zones : az => idx }

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, each.value)
  availability_zone       = each.key
  map_public_ip_on_launch = true

  tags = {
    Name = "ai-gaussian-splatter-public-${each.key}"
  }
}

# RDS is the only thing here — it needs no outbound internet, so it keeps the stronger placement: no route in
# or out, reachable only from db_security_group's one ingress rule below.
resource "aws_subnet" "private" {
  for_each = { for idx, az in local.availability_zones : az => idx }

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, each.value + length(local.availability_zones))
  availability_zone = each.key

  tags = {
    Name = "ai-gaussian-splatter-private-${each.key}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "ai-gaussian-splatter-public"
  }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# No default route out — isolated in fact, not just in name.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "ai-gaussian-splatter-private"
  }
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

# A route table entry, not a billed interface endpoint — free. With no NAT gateway every S3 call otherwise
# leaves through the internet gateway, including the workers' multi-GB splat uploads; this keeps them on AWS's
# network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.private.id]
}

# Declared here, not in web.tf, so it sits alongside the other group that names a public CIDR. The ALB-to-tasks
# ingress rule itself lives in web.tf, once the container port is known.
resource "aws_security_group" "alb" {
  name        = "ai-gaussian-splatter-alb"
  description = "Public ALB in front of the web ECS service"
  vpc_id      = aws_vpc.main.id
}

# The app's only route in from the internet, and the only rule in this file that names a public CIDR. Port 80
# is the redirect listener; it never reaches a task.
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from anyone"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP from anyone, redirected"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Receives the ALB-to-tasks rule (web.tf), and gives the web tasks a stable identity that the DB security
# group's own ingress rule can name as a source. Security-group references check ENI membership, not the
# referenced group's own rules.
resource "aws_security_group" "web" {
  name        = "ai-gaussian-splatter-web"
  description = "Web ECS service to RDS"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "web_all" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "worker" {
  name        = "ai-gaussian-splatter-worker"
  description = "GPU spot worker instances, outbound only (S3, web callback)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "worker_all" {
  security_group_id = aws_security_group.worker.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# No egress rule declared at all, deliberately: an aws_security_group with zero egress blocks has zero egress
# rules (Terraform removes AWS's own default allow-all-outbound rule on creation), so RDS has no outbound path.
resource "aws_security_group" "db" {
  name        = "ai-gaussian-splatter-db"
  description = "RDS Postgres, inbound only from the web ECS service"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_web" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.web.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Web to Postgres"
}
