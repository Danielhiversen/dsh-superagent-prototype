#!/bin/sh
# Prepare a new ticket from current GitHub main before creating its branch.
# An optional repository URL supports local Git integration tests.
set -eu

: "${DSH_SUPERAGENT_DIR:?Ticket directory is required}"
: "${DSH_SUPERAGENT_NAME:?Ticket name is required}"
repository=${1:-https://github.com/${DSH_SUPERAGENT_GITHUB_REPOSITORY:?GitHub repository is required}.git}
branch="dhh/$DSH_SUPERAGENT_NAME"
git check-ref-format --branch "$branch" >/dev/null
if [ -e "$DSH_SUPERAGENT_DIR" ] || [ -L "$DSH_SUPERAGENT_DIR" ]; then
  printf '%s\n' 'Refusing to replace an existing ticket workspace.' >&2
  exit 1
fi
export GIT_TERMINAL_PROMPT=0
# Publish the workspace only after every Git operation succeeds. Failed pulls
# must never leave a directory the executor could mistake for a prepared one.
staging=$(mktemp -d "${DSH_SUPERAGENT_DIR}.prepare.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
trap 'exit 1' HUP INT TERM
git clone --branch main -- "$repository" "$staging"
git -C "$staging" pull --ff-only origin main
base=main
if [ -n "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-}" ]; then
  # Review/fix tickets continue the existing PR rather than replacing its work.
  git -C "$staging" fetch origin "$DSH_SUPERAGENT_GITHUB_PR_HEAD"
  base=FETCH_HEAD
fi
git -C "$staging" switch --no-track -c "$branch" "$base"
# rename publishes the checkout atomically without GNU-specific mv options.
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging" "$DSH_SUPERAGENT_DIR"
