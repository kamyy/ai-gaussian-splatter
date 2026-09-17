#!/usr/bin/env bash
# Checks the HCL scrapers in scripts/lib/terraform.sh. The root package.json's scripts:check calls it, from the
# pre-commit hook and CI's lint-format job.
#
# .github/workflows/deploy.yml signs its AWS credentials with tf_get_aws_region, so a spelling in infra/variables.tf
# that this no longer reads breaks a deploy rather than a plan. The check against the real file is shape-only, since
# asserting the region literally would write it a second time. The fixtures below own their inputs, so those assert
# exact output. tf_get_app_hostname does not read infra/: it prefixes the zone name with ai-gaussian-splatter.

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

# A helper that can't produce its value must exit non-zero. A partial or stray value printed instead is what would
# reach AWS as a region, or .github/workflows/deploy.yml's smoke test as a hostname.
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
check_equals "tf_get_app_hostname appends the zone name" "ai-gaussian-splatter.example.com" \
  "$(tf_get_app_hostname example.com)"
check_fails "tf_get_app_hostname refuses an empty zone name" tf_get_app_hostname ""

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

point_root_at_repo
if ((failures > 0)); then
  echo "$failures check(s) failed." >&2
  exit 1
fi
