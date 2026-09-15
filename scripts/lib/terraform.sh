# shellcheck shell=bash
# Sourced by scripts/prod/terraform-plan.sh, scripts/prod/terraform-destroy.sh,
# scripts/prod/delete-tf-state-bucket.sh, scripts/dev/terraform-check.sh, and scripts/dev/run-tests.sh. load_tf_vars needs
# scripts/lib/github.sh's gh_repo_var, so source that first when calling it. Not meant to be run directly.

ROOT=$(git rev-parse --show-toplevel)

# Prefer the binary scripts/prod/install-terraform.sh writes. A terraform earlier on PATH can be a different version
# than infra/providers.tf pins. CI has no copy there: hashicorp/setup-terraform puts the same pin on PATH, so that is
# the fallback.
if [[ -x $HOME/.local/bin/terraform ]]; then
  TERRAFORM=$HOME/.local/bin/terraform
else
  TERRAFORM=$(command -v terraform) || true
fi

require_local_terraform() {
  if [[ -z ${TERRAFORM:-} || ! -x $TERRAFORM ]]; then
    echo "Terraform is missing. Run scripts/prod/install-terraform.sh." >&2
    exit 1
  fi
}

# Exports every TF_VAR_* infra/ requires. They come from the same repository variables
# .github/workflows/deploy.yml applies with, except web_image_tag, which that job sets itself.
load_tf_vars() {
  local task_def image

  TF_VAR_hosted_zone_id=$(gh_repo_var HOSTED_ZONE_ID)
  TF_VAR_clerk_secret_key_arn=$(gh_repo_var CLERK_SECRET_KEY_ARN)
  TF_VAR_alert_email=$(gh_repo_var ALERT_EMAIL)
  TF_VAR_app_public_url=$(gh_repo_var APP_PUBLIC_URL)
  TF_VAR_worker_ami_id=$(gh_repo_var WORKER_AMI_ID)
  TF_VAR_worker_image_tag=$(gh_repo_var WORKER_IMAGE_TAG)

  # The deploy job sets web_image_tag itself. Use the tag the running service's PRIMARY task definition names, the same
  # ECS lookup that job's "Resolve tags" step uses when a service exists, or the plan shows an image change that isn't
  # coming.
  # shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
  if ! task_def=$(aws ecs describe-services --region us-west-2 \
    --cluster ai-gaussian-splatter --services ai-gaussian-splatter-web \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text 2>&1); then
    # A missing cluster means no service yet. A missing service in an existing cluster isn't an error at all, and the
    # query prints None for it. Any other error stops here, rather than planning a rollout that isn't coming.
    if [[ $task_def != *ClusterNotFoundException* ]]; then
      echo "$task_def" >&2
      exit 1
    fi
    task_def=None
  fi

  if [[ -z $task_def || $task_def == None ]]; then
    # No service is running, so the plan creates one whatever the tag is. Any SHA-shaped value passes validation.
    TF_VAR_web_image_tag=$(git rev-parse --short HEAD)
  else
    image=$(aws ecs describe-task-definition --region us-west-2 --task-definition "$task_def" \
      --query 'taskDefinition.containerDefinitions[0].image' --output text)
    # The image is tagged "<sha>-web" (infra/web.tf), but web_image_tag takes the bare SHA.
    image=${image##*:}
    TF_VAR_web_image_tag=${image%-web}
  fi

  export TF_VAR_hosted_zone_id TF_VAR_clerk_secret_key_arn TF_VAR_alert_email TF_VAR_app_public_url \
    TF_VAR_worker_ami_id TF_VAR_worker_image_tag TF_VAR_web_image_tag
}

# Points infra/ at the state bucket. -reconfigure because the bucket name follows the signed-in account. A leftover
# .terraform from infra:check (no backend) or from a plan against a different account would otherwise make init try to
# migrate state.
tf_init() {
  require_local_terraform
  "$TERRAFORM" -chdir="$ROOT/infra" init -input=false -reconfigure \
    -backend-config="bucket=ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID" \
    -backend-config="key=infra.tfstate" \
    -backend-config="region=us-west-2"
}
