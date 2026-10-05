#!/usr/bin/env bash
# Tests the helpers in scripts/lib/terraform.sh that read values out of infra/'s Terraform files.
#
# Those helpers parse HCL (Terraform's config language) with text tools, so a change to how a value is written in infra/
# can silently break them. This checks them against the real files and against fixtures.

# The root package.json's infra:test calls it, from CI's infra job and the root `pnpm test`.
#
# .github/workflows/deploy.yml signs its AWS credentials with tf_get_aws_region, so a scraper that does not read a
# variable in infra/variables.tf breaks a deploy rather than a plan. The check against the real file is shape-only,
# since asserting the region literally would write it a second time. The fixtures below own their inputs, so those
# assert exact output. tf_get_app_hostname does not read infra/: it prefixes the zone name with ai-gaussian-splatter.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/terraform-test-lib.sh"
  echo
  echo "Checks the HCL scrapers in scripts/lib/terraform.sh."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

# Clears any repository location git has exported (GIT_DIR, GIT_INDEX_FILE, ...), as it does for a script run from a
# git hook. Left set, the fixture repository's init and commit below act on this repository instead. From a linked
# worktree that commits the staged files as "no web/" and marks the repository bare.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

REPO_ROOT=$(git rev-parse --show-toplevel)
source "$REPO_ROOT/scripts/lib/terraform.sh"

FIXTURE=$(mktemp -d)
# A second fixture, a repository holding a commit but no web/ or worker/ directory, for the missing-path checks below.
EMPTY_REPO=$(mktemp -d)
trap 'rm -rf "$FIXTURE" "$EMPTY_REPO"' EXIT
mkdir "$FIXTURE/infra"
git -C "$EMPTY_REPO" -c init.defaultBranch=main init -q
git -C "$EMPTY_REPO" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m "no web/ or worker/"

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
# A fixed width, not `git rev-parse --short`, whose length varies with the local object count (AGENTS.md).
check_matches "tf_get_web_image_tag is 12 hex characters" '^[0-9a-f]{12}$' "$(tf_get_web_image_tag)"
check_equals "tf_get_web_image_tag is web/'s tree id" "$(git -C "$REPO_ROOT" rev-parse HEAD:web | cut -c1-12)" \
  "$(tf_get_web_image_tag)"
# Dropping pipefail is what makes this discriminate: this file sets it, the deploy job does not, and a piped helper
# fails only where it is set (AGENTS.md). check_fails runs this in a subshell, so the `set` doesn't escape.
web_image_tag_without_pipefail() {
  set +o pipefail
  tf_get_web_image_tag
}
ROOT=$EMPTY_REPO
check_fails "tf_get_web_image_tag fails when web/ is missing" web_image_tag_without_pipefail
point_root_at_repo

check_matches "tf_get_worker_image_tag is 12 hex characters" '^[0-9a-f]{12}$' "$(tf_get_worker_image_tag HEAD)"
check_equals "tf_get_worker_image_tag is worker/'s tree id at the ref" \
  "$(git -C "$REPO_ROOT" rev-parse HEAD:worker | cut -c1-12)" "$(tf_get_worker_image_tag HEAD)"
worker_image_tag_without_pipefail() {
  set +o pipefail
  tf_get_worker_image_tag HEAD
}
ROOT=$EMPTY_REPO
check_fails "tf_get_worker_image_tag fails when worker/ is missing" worker_image_tag_without_pipefail
point_root_at_repo

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
