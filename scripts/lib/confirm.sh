# shellcheck shell=bash
# Not meant to be run directly.

# Asks before a script creates or deletes anything, and exits unless the answer is y or Y. In the AWS scripts it follows
# aws_require_login's identity line, which is the last chance to catch the wrong account.
confirm() {
  local prompt=$1 reply
  read -rp "$prompt [y/N] " reply

  if [[ $reply != [yY] ]]; then
    echo "Aborted." >&2
    exit 1
  fi
}
