# shellcheck shell=bash
# Sourced by scripts/prod/install-terraform.sh, scripts/prod/terraform-plan.sh, scripts/prod/terraform-destroy.sh,
# scripts/prod/delete-tf-state-bucket.sh, scripts/prod/set-gh-repo-variables.sh, scripts/prod/configure-ci-role.sh,
# scripts/prod/first-time-account-setup.sh, scripts/dev/terraform-check.sh, scripts/dev/run-tests.sh,
# scripts/dev/create-dev-resources.sh, and the hashicorp/setup-terraform steps in .github/workflows/ci.yml and
# .github/workflows/deploy.yml. Callers that run terraform assign TERRAFORM=$(tf_bin). load_tf_vars needs
# scripts/lib/github.sh's gh_repo_var, so source that first when calling it. Not meant to be run directly.

ROOT=$(git rev-parse --show-toplevel)

# Prints the Terraform CLI to run. Prefers the binary scripts/prod/install-terraform.sh writes, because a terraform
# earlier on PATH can be a different version than infra/providers.tf pins. CI has no copy there:
# hashicorp/setup-terraform installs whatever tf_required_version reads, so that is the fallback.
tf_bin() {
  local bin
  if [[ -x $HOME/.local/bin/terraform ]]; then
    bin=$HOME/.local/bin/terraform
  else
    bin=$(command -v terraform || true)
  fi
  if [[ -z $bin || ! -x $bin ]]; then
    echo "Terraform is missing. Run scripts/prod/install-terraform.sh." >&2
    return 1
  fi
  printf '%s\n' "$bin"
}

require_local_terraform() {
  if [[ -z ${TERRAFORM:-} || ! -x $TERRAFORM ]]; then
    echo "Terraform is missing. Run scripts/prod/install-terraform.sh." >&2
    exit 1
  fi
}

# Prints the exact required_version in infra/providers.tf. scripts/prod/install-terraform.sh and CI's
# hashicorp/setup-terraform both call this so the pin is not copied into .github/workflows/ci.yml or
# .github/workflows/deploy.yml. A non-x.y.z value is refused because a blank terraform_version would make
# setup-terraform install latest.
tf_required_version() {
  local version
  version=$(grep -oP 'required_version = "\K[^"]+' "$ROOT/infra/providers.tf" || true)
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not parse an exact required_version from infra/providers.tf." >&2
    return 1
  fi
  printf '%s\n' "$version"
}

# Prints a quoted local variable from infra/locals.tf.
tf_local_var() {
  local name=$1 value
  value=$(grep -oP "$name\\s*=\\s*\"\\K[^\"]+" "$ROOT/infra/locals.tf" || true)
  if [[ -z $value ]]; then
    echo "Can't read local.$name from infra/locals.tf." >&2
    return 1
  fi
  printf '%s\n' "$value"
}

# Resolves ${local.domain_zone_name} inside local.app_hostname using the zone name already read.
tf_app_hostname() {
  local zone_name=$1 hostname
  hostname=$(tf_local_var app_hostname)
  # shellcheck disable=SC2016 # The single quotes match Terraform's own ${...} literally.
  hostname=${hostname//'${local.domain_zone_name}'/$zone_name}
  if [[ -z $hostname || $hostname == *\$\{* ]]; then
    echo "Can't resolve local.app_hostname in infra/locals.tf: $hostname" >&2
    return 1
  fi
  printf '%s\n' "$hostname"
}

# The tag the running service's PRIMARY task definition names, the same ECS lookup the deploy job's "Resolve tags" step
# uses when a service exists. Any SHA-shaped value when nothing is serving, or the plan shows an image change that isn't
# coming.
tf_live_web_image_tag() {
  local task_def image

  # shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
  if ! task_def=$(aws ecs describe-services --region us-west-2 \
    --cluster ai-gaussian-splatter --services ai-gaussian-splatter-web \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text 2>&1); then
    # A missing cluster means no service yet. A missing service in an existing cluster isn't an error at all, and the
    # query prints None for it. Any other error stops here, rather than planning a rollout that isn't coming.
    if [[ $task_def != *ClusterNotFoundException* ]]; then
      echo "$task_def" >&2
      return 1
    fi
    task_def=None
  fi

  if [[ -z $task_def || $task_def == None ]]; then
    git rev-parse --short HEAD
    return
  fi

  image=$(aws ecs describe-task-definition --region us-west-2 --task-definition "$task_def" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text) || return 1
  # The image is tagged "<sha>-web" (infra/web.tf), but web_image_tag takes the bare SHA.
  image=${image##*:}
  printf '%s\n' "${image%-web}"
}

# Exports every TF_VAR_* infra/ requires. They come from the same repository variables
# .github/workflows/deploy.yml applies with, except web_image_tag, which that job sets itself.
load_tf_vars() {
  TF_VAR_hosted_zone_id=$(gh_repo_var HOSTED_ZONE_ID)
  TF_VAR_clerk_secret_key_arn=$(gh_repo_var CLERK_SECRET_KEY_ARN)
  TF_VAR_alert_email=$(gh_repo_var ALERT_EMAIL)
  TF_VAR_app_public_url=$(gh_repo_var APP_PUBLIC_URL)
  TF_VAR_worker_ami_id=$(gh_repo_var WORKER_AMI_ID)
  TF_VAR_worker_image_tag=$(gh_repo_var WORKER_IMAGE_TAG)
  TF_VAR_web_image_tag=$(tf_live_web_image_tag)

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
