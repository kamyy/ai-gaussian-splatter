# shellcheck shell=bash
# Not meant to be run directly.

# Fails fast when no AWS credentials are active, and exports AWS_ACCOUNT_ID for the caller. GetCallerIdentity needs no
# IAM permission, so this works for the dev IAM user as well as an admin signed in with `aws login`.
aws_require_login() {
  local identity arn
  if ! identity=$(aws sts get-caller-identity --query '[Account, Arn]' --output text 2>/dev/null); then
    echo "Not signed in to AWS. Run: aws login" >&2
    exit 1
  fi

  read -r AWS_ACCOUNT_ID arn <<<"$identity"
  export AWS_ACCOUNT_ID
  echo "AWS account $AWS_ACCOUNT_ID as $arn"
}
