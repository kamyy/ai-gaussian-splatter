#!/usr/bin/env bash
# Streams one of the deployed account's CloudWatch log groups to the terminal.
#
# The web service, the migration task, the worker sweeper and the worker instances each write to their own log group.
# This saves looking up the group name and region for each one. It only reads, so it asks for no confirmation.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/logs-tail.sh SOURCE [SINCE]"
  echo
  echo "Follows one CloudWatch log group in the deployed account. SOURCE is one of:"
  echo "  web        the web service's own output: API errors, stack traces, failed DB queries"
  echo "  migrate    each deploy's database migration task"
  echo "  sweeper    the Lambda that terminates overdue worker instances"
  echo "  worker     COLMAP and gsplat output from every worker instance, one stream per worker job stage"
  echo
  echo "SINCE is how far back to start, such as 10m, 1h or 2d. The default is 10m."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

source_name=$1
since=${2:-10m}

# These names are fixed. They are not scraped from Terraform. The names live in:
# - infra/web.tf
# - infra/worker_iam.tf
# - infra/worker_sweeper.tf
case $source_name in
  web) LOG_GROUP=/ecs/ai-gaussian-splatter-web ;;
  migrate) LOG_GROUP=/ecs/ai-gaussian-splatter-migrate ;;
  sweeper) LOG_GROUP=/aws/lambda/ai-gaussian-splatter-worker-sweeper ;;
  worker) LOG_GROUP=/ai-gaussian-splatter/worker ;;
  *)
    echo "$source_name is not a log source." >&2
    usage >&2
    exit 1
    ;;
esac

aws_require_login
gh_require_login
gh_require_aws_deploy_account

REGION=$(tf_get_aws_region)

# Tail against a missing group prints a bare API error. The group is missing before the first deploy.
found=$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'].logGroupName" --output text)
if [[ -z $found ]]; then
  echo "Log group $LOG_GROUP does not exist. The deploy job creates it on its first run." >&2
  exit 1
fi

exec aws logs tail "$LOG_GROUP" --region "$REGION" --since "$since" --follow --format short
