#!/usr/bin/env bash
# Prints how long each phase of recent worker-job stages took, from the worker log group in the deployed account.
#
# Each stage's log stream carries `timing phase=<name> ms=<n>` lines. The host writes them for its boot, ECR login and
# image pull (web/lib/server/workerLauncher.ts's user-data), and the container for each pipeline phase
# (worker/pipeline/timing.py). This collects them with a CloudWatch Logs Insights query, to show where a stage's wall
# clock goes before anyone optimizes it. It only reads, so it asks for no confirmation.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/logs-timings.sh [SINCE] [JOB_ID]"
  echo
  echo "Prints each worker-job stage's phase timings, one row per phase, grouped by log stream (<job id>-<stage>)."
  echo
  echo "SINCE is how far back to look, such as 10m, 1h or 2d. The default is 1d."
  echo "JOB_ID narrows the output to one worker job, and adds its context lines (instance type, photo count) and its"
  echo "sample lines: CPU, disk and GPU use every few seconds, each tagged with the phase running at the time."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

if [[ $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

since=${1:-1d}
job_id=${2-}

# Fixed, as in scripts/prod/logs-tail.sh. infra/worker_iam.tf creates it.
LOG_GROUP=/ai-gaussian-splatter/worker

if [[ ! $since =~ ^([0-9]+)([mhd])$ ]]; then
  echo "SINCE must be a number followed by m, h or d, such as 1h." >&2
  exit 1
fi
case ${BASH_REMATCH[2]} in
  m) since_seconds=$((BASH_REMATCH[1] * 60)) ;;
  h) since_seconds=$((BASH_REMATCH[1] * 3600)) ;;
  d) since_seconds=$((BASH_REMATCH[1] * 86400)) ;;
esac

# A job id is a UUID, so it needs no escaping inside the query's regex.
if [[ -n $job_id ]]; then
  if [[ ! $job_id =~ ^[0-9a-f-]+$ ]]; then
    echo "$job_id is not a worker job id." >&2
    exit 1
  fi
  query="filter @logStream like /^$job_id-/ and @message like /(timing|context|sample) /
| parse @message /(?<line>(timing|context|sample) .*)$/
| sort @timestamp asc
| display @logStream, line
| limit 10000"
else
  query="filter @message like /timing phase=/
| parse @message /timing phase=(?<phase>\S+) ms=(?<ms>\d+)(?<fields>.*)$/
| sort @logStream asc, @timestamp asc
| display @logStream, phase, ms, fields
| limit 10000"
fi

aws_require_login
gh_require_login
gh_require_aws_deploy_account

REGION=$(tf_get_aws_region)

now=$(date +%s)
query_id=$(aws logs start-query --region "$REGION" --log-group-name "$LOG_GROUP" \
  --start-time $((now - since_seconds)) --end-time "$now" --query-string "$query" --query queryId --output text)

# Insights queries run asynchronously, so this polls until the query has finished.
status=Running
while [[ $status == Running || $status == Scheduled ]]; do
  sleep 1
  status=$(aws logs get-query-results --region "$REGION" --query-id "$query_id" --query status --output text)
done

if [[ $status != Complete ]]; then
  echo "The Logs Insights query ended as $status." >&2
  exit 1
fi

# Each result row is a list of {field, value} pairs. @ptr is Insights' own record pointer, which nobody reads.
# shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
rows=$(aws logs get-query-results --region "$REGION" --query-id "$query_id" \
  --query 'results[*][?field!=`@ptr`].value' --output text)
if [[ -z $rows ]]; then
  echo "No timing lines in $LOG_GROUP from the last $since." >&2
  exit 0
fi

column -t -s $'\t' <<<"$rows"
