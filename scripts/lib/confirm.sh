# shellcheck shell=bash
# Sourced by the scripts in scripts/dev/ and scripts/prod/ that ask before creating or deleting anything. Not meant to
# be run directly.

# Asks before a script creates or deletes anything, and exits unless the answer is y or Y. In the AWS scripts it follows
# require_aws_login's identity line, which is the last chance to catch the wrong account.
confirm() {
  local reply
  read -rp "$1 [y/N] " reply

  if [[ $reply != [yY] ]]; then
    echo "Aborted." >&2
    exit 1
  fi
}
