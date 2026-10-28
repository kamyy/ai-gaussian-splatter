#!/usr/bin/env bash
# Opens a tunnel from this machine to the deployed RDS database, so a client such as TablePlus can read it.
#
# RDS sits in isolated subnets and accepts connections only from the web service's security group. This script gets in
# through the running web ECS task, which is in that group. It asks AWS Systems Manager (SSM) Session Manager to forward
# a local port through the task's managed SSM agent to the RDS endpoint. Nothing new is exposed to the internet.
#
# The client logs in as the read-only splatter_readonly role (web/drizzle/0001_readonly_role.sql) with an RDS IAM
# authentication token, so no database password exists. The token is signed here from the AWS CLI's own credentials and
# expires after 15 minutes. A client that opens a new connection after that needs a fresh token from a re-run.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/db-tunnel.sh"
  echo
  echo "Prints the connection settings and a 15-minute login token, then forwards localhost:5433 to the deployed"
  echo "database until you stop it with Ctrl-C. Point TablePlus or psql at 127.0.0.1:5433 as the read-only user"
  echo "splatter_readonly, with the token as the password and SSL required."
  echo
  echo "A connection that is already open keeps working after the token expires. A new one needs the token from a"
  echo "fresh run."
  echo
  echo "Needs aws login as an admin of the deployed account, gh login, and the Session Manager plugin"
  echo "(scripts/dev/setup.sh session-manager). Needs a running web task."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

# These names are fixed. They are not scraped from Terraform. The names live in:
# - infra/data.tf
# - infra/locals.tf
# - infra/web.tf
CLUSTER=ai-gaussian-splatter
SERVICE=ai-gaussian-splatter-web
CONTAINER=web
DB_INSTANCE=ai-gaussian-splatter
DB_NAME=ai_gaussian_splatter
DB_USER=splatter_readonly
LOCAL_PORT=5433

if ! command -v session-manager-plugin >/dev/null; then
  echo "The Session Manager plugin is missing. Run: scripts/dev/setup.sh session-manager" >&2
  exit 1
fi

aws_require_login
gh_require_login
gh_require_aws_deploy_account

REGION=$(tf_get_aws_region)

# A deploy replaces the task, so the id is looked up on every run.
task_arn=$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --query 'taskArns[0]' --output text)
if [[ $task_arn == None ]]; then
  echo "The $SERVICE service has no running task to tunnel through." >&2
  exit 1
fi
task_id=${task_arn##*/}

# The target names the container's runtime id as well as the task. The SSM agent ECS adds to the task reports its own
# status. A task that started before the service turned on execute-command has no running agent.
task_info=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_id" \
  --query "tasks[0].containers[?name=='$CONTAINER'] | [0].[runtimeId, managedAgents[?name=='ExecuteCommandAgent'] | [0].lastStatus]" \
  --output text)
read -r runtime_id agent_status <<<"$task_info"
if [[ $runtime_id == None ]]; then
  echo "Task $task_id has no container named $CONTAINER with a runtime id yet. It may still be starting." >&2
  exit 1
fi
if [[ $agent_status != RUNNING ]]; then
  echo "Task $task_id has no running SSM agent (status: $agent_status)." >&2
  echo "A task that started before execute-command was enabled has none. A new deploy replaces the task." >&2
  exit 1
fi

db_info=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$DB_INSTANCE" \
  --query 'DBInstances[0].[Endpoint.Address, Endpoint.Port, IAMDatabaseAuthenticationEnabled]' --output text)
read -r db_host db_port iam_enabled <<<"$db_info"
if [[ $iam_enabled != True ]]; then
  echo "IAM database authentication is not on for $DB_INSTANCE yet. RDS applies it in the maintenance window." >&2
  echo "To apply it now, run: aws rds modify-db-instance --db-instance-identifier $DB_INSTANCE --apply-immediately" \
    "--enable-iam-database-authentication" >&2
  exit 1
fi

# A tunnel from an earlier run still holds the port. Stopping it closes its connections, so a client reconnects with
# the new token.
if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then
  echo "Port $LOCAL_PORT is already in use, by an earlier tunnel or another program." >&2
  echo "Press Ctrl-C in the earlier tunnel, or stop the other program, then run this again." >&2
  exit 1
fi

token=$(aws rds generate-db-auth-token --region "$REGION" --hostname "$db_host" --port "$db_port" --username "$DB_USER")

echo
echo "Starting the tunnel. Connect to:"
echo "  Host      127.0.0.1"
echo "  Port      $LOCAL_PORT"
echo "  Database  $DB_NAME"
echo "  User      $DB_USER"
echo "  SSL       required, without hostname verification"
echo "  Password  the token below, valid 15 minutes for a new connection"
echo
echo "$token"
echo
echo "Once it reports it is waiting for connections, it stays open until you press Ctrl-C."

exec aws ssm start-session --region "$REGION" --target "ecs:${CLUSTER}_${task_id}_${runtime_id}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$db_host\"],\"portNumber\":[\"$db_port\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
