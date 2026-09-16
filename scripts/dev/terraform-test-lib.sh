#!/usr/bin/env bash
# Checks the HCL scrapers in scripts/lib/terraform.sh. The root package.json's scripts:check calls it, from the
# pre-commit hook and CI's lint-format job.
#
# .github/workflows/deploy.yml signs its AWS credentials with tf_get_aws_region and smoke-tests the origin
# tf_get_app_hostname builds, so a spelling in infra/variables.tf or infra/locals.tf that these no longer read breaks a
# deploy rather than a plan. The checks against the real files are shape-only, since asserting the region or the
# hostname literally would write each a second time. The fixtures below own their inputs, so those assert exact output.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
source "$REPO_ROOT/scripts/lib/terraform.sh"

FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT
mkdir "$FIXTURE/infra"

failures=0

# Every check runs to the end, so one broken scraper doesn't hide the next one.
check_equals() {
  local label=$1 expected=$2 actual=$3
  if [[ $actual == "$expected" ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  fi
}

check_matches() {
  local label=$1 pattern=$2 actual=$3
  if [[ $actual =~ $pattern ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label: '$actual' does not match /$pattern/" >&2
    failures=$((failures + 1))
  fi
}

# A scraper that can't read its value must exit non-zero. Printing a partial or stray value instead is what would
# reach AWS as a region or a hostname.
check_fails() {
  local label=$1 output
  shift
  if output=$("$@" 2>/dev/null); then
    echo "FAIL $label: expected a non-zero exit, got '$output'" >&2
    failures=$((failures + 1))
  else
    echo "ok   $label"
  fi
}

# The helpers read $ROOT, which they set themselves when sourced. Reassigning it points them at a fixture.
point_root_at_fixture() {
  ROOT=$FIXTURE
}

point_root_at_repo() {
  ROOT=$REPO_ROOT
}

point_root_at_repo
check_matches "tf_get_aws_region reads infra/variables.tf" '^[a-z]{2}(-[a-z]+)+-[0-9]+$' "$(tf_get_aws_region)"
check_matches "tf_get_app_hostname reads infra/locals.tf" '^[a-z0-9][a-z0-9-]*\.example\.com$' \
  "$(tf_get_app_hostname example.com)"
check_equals "tf_get_local reads infra/locals.tf" "ai-gaussian-splatter" "$(tf_get_local project_tag)"

point_root_at_fixture

# A default sitting after a validation block, which is the shape terraform fmt leaves behind for a variable that has
# both.
cat > "$FIXTURE/infra/variables.tf" <<'HCL'
variable "aws_region" {
  type = string

  validation {
    condition     = var.aws_region != ""
    error_message = "aws_region must be set."
  }

  default = "eu-central-1"
}

variable "later" {
  default = "not-this-one"
}
HCL
check_equals "tf_get_var_default skips a validation block" "eu-central-1" "$(tf_get_var_default aws_region)"
check_equals "tf_get_aws_region takes that default" "eu-central-1" "$(tf_get_aws_region)"

# The named variable has no default, so the search has to stop at its closing brace rather than run on into the next
# variable's.
cat > "$FIXTURE/infra/variables.tf" <<'HCL'
variable "aws_region" {
  type = string
}

variable "later" {
  default = "not-this-one"
}
HCL
check_fails "tf_get_var_default stops at the variable's closing brace" tf_get_var_default aws_region

# An expression rather than a literal. The awk leaves a stray token here, which is the reason tf_get_aws_region checks
# the shape of what it got instead of passing it straight to the AWS CLI.
cat > "$FIXTURE/infra/variables.tf" <<'HCL'
variable "aws_region" {
  default = format("%s-%s", "us", "west-2")
}
HCL
check_fails "tf_get_aws_region refuses a default it can't read as a region" tf_get_aws_region

cat > "$FIXTURE/infra/locals.tf" <<'HCL'
locals {
  app_hostname = "splat.${var.domain_zone_name}"
}
HCL
check_equals "tf_get_app_hostname substitutes the zone name" "splat.example.com" "$(tf_get_app_hostname example.com)"

# Only ${var.domain_zone_name} is substituted, so any other interpolation would survive into a URL.
cat > "$FIXTURE/infra/locals.tf" <<'HCL'
locals {
  app_hostname = "${local.project_tag}.${var.domain_zone_name}"
}
HCL
check_fails "tf_get_app_hostname refuses a hostname it only partly resolved" tf_get_app_hostname example.com

cat > "$FIXTURE/infra/locals.tf" <<'HCL'
locals {
  app_hostname = format("%s.%s", local.project_tag, var.domain_zone_name)
}
HCL
check_fails "tf_get_app_hostname refuses a hostname that isn't a string literal" tf_get_app_hostname example.com

point_root_at_repo
if ((failures > 0)); then
  echo "$failures check(s) failed." >&2
  exit 1
fi
