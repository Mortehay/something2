#!/usr/bin/env bash
# `make pi-hook-register` (SOMET-401): teach GitHub how to reach this board.
#
# The two Actions secrets the delivery workflow needs are, by their nature,
# facts about the BOARD rather than about the repository:
#
#   DEPLOY_HOOK_SECRET   generated on the board, never travels from the
#                        workstation; this reads it back and hands it to gh
#                        without it passing through a terminal or a file
#   DEPLOY_HOOK_URL      the current tunnel hostname + /deploy-hook
#
# The URL is the awkward half, and honestly so: a trycloudflare quick tunnel
# gets a NEW random hostname every restart, so this has to be re-run after one.
# That is a property of the free tunnel, not of this script -- phase 2's named
# tunnel on a real domain is what makes the URL stable.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env
require_env GIT_REPOSITORY

REMOTE_SH="$(dirname "${BASH_SOURCE[0]}")/remote.sh"

command -v gh >/dev/null 2>&1 || {
  cat >&2 <<MSG
the GitHub CLI (gh) is not installed, and it is what sets the Actions secrets.

set them by hand instead, at
  ${GIT_REPOSITORY%.git}/settings/secrets/actions

  DEPLOY_HOOK_SECRET   \$(make pi-hook-secret)
  DEPLOY_HOOK_URL      \$(make pi-tunnel-url)/deploy-hook
MSG
  exit 1
}

# owner/repo from the clone url, so this follows a fork without being told.
REPO_SLUG="$(printf '%s' "${GIT_REPOSITORY%.git}" | sed -E 's#.*github\.com[:/]##')"

url="$(bash "$REMOTE_SH" tunnel-url)"
secret="$(bash "$REMOTE_SH" hook-secret)"

# The value is piped, never passed as an argument: arguments are visible in
# the process list of whatever machine this runs on.
printf '%s' "$secret" | gh secret set DEPLOY_HOOK_SECRET --repo "$REPO_SLUG" >/dev/null
printf '%s' "${url}/deploy-hook" | gh secret set DEPLOY_HOOK_URL --repo "$REPO_SLUG" >/dev/null

cat <<MSG
registered with ${REPO_SLUG}:
  DEPLOY_HOOK_SECRET   (read from the board, not shown)
  DEPLOY_HOOK_URL      ${url}/deploy-hook

a push to the deployment branch now builds images and deploys the board.

NOTE: a quick tunnel takes a NEW hostname every restart, so re-run this after
one -- otherwise the workflow will POST to a hostname that no longer exists
and the deploy step will fail rather than silently doing nothing.
MSG
