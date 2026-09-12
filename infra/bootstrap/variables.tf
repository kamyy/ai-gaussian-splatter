variable "aws_region" {
  description = "Region the state bucket lives in. infra/'s own backend block must point at the same bucket/region."
  type        = string
  default     = "us-west-2"
}
