# shellcheck shell=bash
# Callers that run terraform assign TERRAFORM=$(tf_get_bin). tf_export_vars needs scripts/lib/github.sh's
# gh_get_repo_var, so source that first when calling it. Not meant to be run directly.

ROOT=$(git rev-parse --show-toplevel)

# Prints the Terraform CLI to run. Prefers the binary scripts/dev/terraform-install.sh writes, because a terraform
# earlier on PATH can be a different version than infra/providers.tf pins. CI has no copy there:
# hashicorp/setup-terraform installs whatever tf_get_required_version reads, so that is the fallback.
tf_get_bin() {
  local bin
  if [[ -x $HOME/.local/bin/terraform ]]; then
    bin=$HOME/.local/bin/terraform
  else
    bin=$(command -v terraform || true)
  fi
  if [[ -z $bin || ! -x $bin ]]; then
    echo "Terraform is missing. Run scripts/dev/terraform-install.sh." >&2
    return 1
  fi
  printf '%s\n' "$bin"
}

# Prints the exact required_version in infra/providers.tf. scripts/dev/terraform-install.sh and CI's
# hashicorp/setup-terraform both call this so the pin is not copied into .github/workflows/ci.yml or
# .github/workflows/deploy.yml. A non-x.y.z value is refused because a blank terraform_version would make
# setup-terraform install latest.
tf_get_required_version() {
  local version
  version=$(grep -oP 'required_version = "\K[^"]+' "$ROOT/infra/providers.tf" || true)
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Could not parse an exact required_version from infra/providers.tf." >&2
    return 1
  fi
  printf '%s\n' "$version"
}

# Prints a variable's quoted default from infra/variables.tf. Only string defaults are read, which is all the scripts
# need. It exists so the AWS CLI calls in scripts/ and the region .github/workflows/deploy.yml signs with resolve to
# the same value Terraform itself plans with, rather than each carrying its own copy of the region.
tf_get_var_default() {
  local var_name=$1 var_val
  # depth tracks nesting so a validation block's own closing brace does not end the search before the default line.
  var_val=$(awk -v var_name="$var_name" '
    !inblock && $1 == "variable" && $2 == "\"" var_name "\"" { inblock = 1; depth = 1; next }
    inblock && depth == 1 && $1 == "default" && $2 == "=" { sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit }
    inblock { depth += gsub(/{/, "{") - gsub(/}/, "}"); if (depth <= 0) { exit } }
  ' "$ROOT/infra/variables.tf")
  if [[ -z $var_val ]]; then
    echo "Can't read var.$var_name's default from infra/variables.tf." >&2
    return 1
  fi
  printf '%s\n' "$var_val"
}

# The region every AWS CLI call in scripts/ targets. infra/providers.tf configures the AWS provider from the same
# variable, so changing var.aws_region's default moves the deploy and the scripts together.
tf_get_aws_region() {
  local region
  region=$(tf_get_var_default aws_region) || return 1
  # The default is parsed out of HCL by tf_get_var_default, so a reformatted or unquoted default could yield a stray
  # token rather than nothing. .github/workflows/deploy.yml signs with whatever this prints, so the shape is checked
  # here instead of surfacing as an unrelated AWS error several steps later.
  if [[ ! $region =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
    echo "var.aws_region's default in infra/variables.tf is not a region name: $region" >&2
    return 1
  fi
  printf '%s\n' "$region"
}

# Prints the app hostname for the given DNS zone. The prefix matches local.app_hostname in infra/locals.tf and does
# not change, so this does not scrape that file.
tf_get_app_hostname() {
  local zone_name=${1-}
  if [[ -z $zone_name ]]; then
    echo "A DNS zone name is required." >&2
    return 1
  fi
  printf '%s\n' "ai-gaussian-splatter.$zone_name"
}

# The tag the running service's PRIMARY task definition names, the same ECS lookup the deploy job's "Resolve tags" step
# uses when a service exists. Any SHA-shaped value when nothing is serving, or the plan shows an image change that isn't
# coming.
tf_get_live_web_image_tag() {
  local task_def image region
  region=$(tf_get_aws_region)

  # shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
  if ! task_def=$(aws ecs describe-services --region "$region" \
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

  image=$(aws ecs describe-task-definition --region "$region" --task-definition "$task_def" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text) || return 1
  # The image is tagged "<sha>-web" (infra/web.tf), but web_image_tag takes the bare SHA.
  image=${image##*:}
  printf '%s\n' "${image%-web}"
}

# Exports every TF_VAR_* infra/ requires. They come from the same repository variables
# .github/workflows/deploy.yml applies with, except web_image_tag, which that job sets itself.
tf_export_vars() {
  TF_VAR_hosted_zone_id=$(gh_get_repo_var HOSTED_ZONE_ID)
  TF_VAR_clerk_secret_key_arn=$(gh_get_repo_var CLERK_SECRET_KEY_ARN)
  TF_VAR_alert_email=$(gh_get_repo_var ALERT_EMAIL)
  TF_VAR_domain_zone_name=$(gh_get_repo_var DOMAIN_ZONE_NAME)
  TF_VAR_worker_ami_id=$(gh_get_repo_var WORKER_AMI_ID)
  TF_VAR_worker_image_tag=$(gh_get_repo_var WORKER_IMAGE_TAG)
  TF_VAR_web_image_tag=$(tf_get_live_web_image_tag)

  export TF_VAR_hosted_zone_id TF_VAR_clerk_secret_key_arn TF_VAR_alert_email TF_VAR_domain_zone_name \
    TF_VAR_worker_ami_id TF_VAR_worker_image_tag TF_VAR_web_image_tag
}

# Points infra/ at the state bucket. -reconfigure because the bucket name follows the signed-in account. A leftover
# .terraform from infra:check (no backend) or from a plan against a different account would otherwise make init try to
# migrate state.
tf_init() {
  local terraform
  terraform=$(tf_get_bin)
  "$terraform" -chdir="$ROOT/infra" init -input=false -reconfigure \
    -backend-config="bucket=ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID" \
    -backend-config="key=infra.tfstate" \
    -backend-config="region=$(tf_get_aws_region)"
}
