output "load_balancer_dns_name" {
  value = aws_lb.web.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.web.repository_url
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.id
}

output "splats_bucket" {
  value = aws_s3_bucket.splats.id
}

output "access_logs_bucket" {
  value = aws_s3_bucket.access_logs.id
}

output "worker_instance_profile_arn" {
  value = aws_iam_instance_profile.worker.arn
}

output "database_secret_arn" {
  description = "Secrets Manager ARN holding the RDS master username/password, managed by RDS itself."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}
