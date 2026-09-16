# shellcheck shell=bash
# Sourced by scripts/dev/create-resources.sh, scripts/lib/worker.sh, and scripts/dev/run-web-container.sh.
# web/.env isn't committed. web/.env.example is the record of what it holds. Not meant to be run directly.

# Usage: env_create_file <env-file> <aws-account-id> <aws-region>
#
# Copies <env-file>.example to <env-file> only when nothing is there yet, so a re-run never replaces values filled in by
# hand. Then sets UPLOADS_BUCKET, SPLATS_BUCKET, and AWS_REGION from the account id and region. Mode is 600, because the
# file ends up holding the dev user's secret key. GNU cp would keep the example's 644, so this uses install instead.
env_create_file() {
  local env_file=$1 aws_account_id=$2 aws_region=$3 example
  if [[ -f $env_file ]]; then
    echo "$env_file already exists. Keeping it."
    return
  fi

  example=${env_file}.example
  install -m 600 "$example" "$env_file"
  env_set "$env_file" UPLOADS_BUCKET "ai-gaussian-splatter-dev-uploads-$aws_account_id"
  env_set "$env_file" SPLATS_BUCKET "ai-gaussian-splatter-dev-splats-$aws_account_id"
  env_set "$env_file" AWS_REGION "$aws_region"
  echo "Created $env_file."
}

# Usage: env_set <env-file> <env-var> <env-val>
#
# Replaces that variable's line, or appends one when there isn't any. The value reaches awk through the environment
# rather than inside an awk or sed expression, because AWS secret keys can contain / and +.
env_set() {
  local env_file=$1 env_var=$2 env_val=$3 tmp
  if ! grep -q "^$env_var=" "$env_file"; then
    if [[ -s $env_file && -n $(tail -c1 "$env_file") ]]; then
      # Without a final newline, the appended line would be glued onto the file's last one.
      printf '\n' >> "$env_file"
    fi
    printf '%s=%s\n' "$env_var" "$env_val" >>"$env_file"
    return
  fi

  tmp=$(mktemp)
  ENV_VAR=$env_var ENV_VAL=$env_val awk '
    index($0, ENVIRON["ENV_VAR"] "=") == 1 { $0 = ENVIRON["ENV_VAR"] "=" ENVIRON["ENV_VAL"] }
    { print }' "$env_file" >"$tmp"
  # Copied back rather than moved, so the file keeps its own permissions.
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
}

# Usage: env_get <env-file> <env-var>
#
# Prints that variable's value, or exits naming the file and variable when it's missing or empty.
env_get() {
  local env_file=$1 env_var=$2 env_val
  env_val=$(grep -oP -m1 "^$env_var=\K.*" "$env_file" || true)
  if [[ -z $env_val ]]; then
    echo "$env_file has no $env_var value." >&2
    exit 1
  fi

  printf '%s\n' "$env_val"
}
