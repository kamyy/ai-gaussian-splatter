output "state_bucket" {
  description = "Pass this as -backend-config=\"bucket=...\" when running `terraform init` in infra/."
  value       = aws_s3_bucket.state.id
}
