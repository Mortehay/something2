#!/usr/bin/env bash
# `make pi-provision` (SOMET-426): a bare board to a running, publicly
# reachable stack. Idempotent -- a second run changes nothing and destroys
# nothing.
#
# The order is not arbitrary. Everything that can refuse happens BEFORE
# anything that changes the board, so a wrong .env costs a ten-second refusal
# rather than a half-provisioned machine: reachability, then the data-safety
# rule, then "can this board actually reach the repository". Only after all
# three does anything get installed, cloned or emptied.
#
# No git credential is involved anywhere. The repository is public and the
# board clones anonymously over https, so there is no token to leak into the
# board's git config and nothing to rewrite afterwards.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env
require_env GIT_REPOSITORY ORANGEPI_BRANCH ORANGEPI_APP_DIR

APP="$ORANGEPI_APP_DIR"
DATA="$ORANGEPI_DATA_DIR"

printf '%sboard%s      %s@%s\n%sapp dir%s    %s   %s(emptied by this script)%s\n%sdata dir%s   %s   %s(never touched by this script)%s\n%sbranch%s     %s\n\n' \
  "$C_BOLD" "$C_OFF" "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS" \
  "$C_BOLD" "$C_OFF" "$APP" "$C_DIM" "$C_OFF" \
  "$C_BOLD" "$C_OFF" "$DATA" "$C_DIM" "$C_OFF" \
  "$C_BOLD" "$C_OFF" "$ORANGEPI_BRANCH"

# --- 1. Refuse early, before anything changes ------------------------------

check_reachable() {
  pi_ssh 'echo "reached $(hostname) ($(uname -m), $(. /etc/os-release; echo "$PRETTY_NAME"))"' || {
    printf 'no password-free ssh to %s@%s -- run `make pi-keygen` first.\n' \
      "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS" >&2
    return 1
  }
}
run_step "reach the board" check_reachable

# The load-bearing guard (SOMET-425). It runs before anything is emptied,
# because the whole point is that emptying APP_DIR must never be able to take
# the game's data with it.
run_step "verify the data directory is outside the app directory" assert_data_dir_outside_app_dir

# Checked FROM THE BOARD, not from the workstation: the workstation reaching
# GitHub says nothing about a board on a network that cannot, and finding that
# out during the clone means finding it out after APP_DIR has been emptied.
check_repo_reachable() {
  pi_ssh "GIT_TERMINAL_PROMPT=0 git ls-remote --heads $(printf '%q' "$GIT_REPOSITORY") $(printf '%q' "$ORANGEPI_BRANCH")" \
    | grep -q "refs/heads/${ORANGEPI_BRANCH}$" || {
      cat >&2 <<MSG
the board cannot reach ${GIT_REPOSITORY} at branch '${ORANGEPI_BRANCH}' anonymously.

  * the repository must be PUBLIC -- the board holds no credential by design.
  * the branch must exist. '${ORANGEPI_BRANCH}' is the DEPLOYMENT branch, and
    it is created by promoting main into it, not by pushing to it directly.
MSG
      return 1
    }
  echo "${GIT_REPOSITORY} @ ${ORANGEPI_BRANCH} is reachable anonymously"
}
run_step "verify the repository is reachable from the board" check_repo_reachable

# --- 2. Privileges ---------------------------------------------------------

# Scoped NOPASSWD sudo for docker and systemctl only, never blanket. The
# password is fed on STDIN rather than as an argument -- arguments are visible
# in the board's process list, stdin is not -- and it is needed exactly once,
# on a board that does not have this file yet.
configure_sudo() {
  pi_ssh "PW=$(printf '%q' "${ORANGEPI_PASSWORD:-}") LOGIN=$(printf '%q' "$ORANGEPI_LOGIN") bash -s" <<'REMOTE'
set -euo pipefail
RULE="/etc/sudoers.d/something2-orangepi"
WANT="$LOGIN ALL=(root) NOPASSWD: /usr/bin/docker, /usr/bin/systemctl, /bin/systemctl"

if sudo -n test -f "$RULE" 2>/dev/null && sudo -n grep -qF "$WANT" "$RULE" 2>/dev/null; then
  echo "scoped NOPASSWD sudo already configured"
  exit 0
fi

run_privileged() {
  if sudo -n true 2>/dev/null; then sudo "$@"; 
  elif [ -n "$PW" ]; then printf '%s\n' "$PW" | sudo -S -p '' "$@"; 
  else
    echo "sudo needs a password and ORANGEPI_PASSWORD is empty -- set it for this one run, or create $RULE by hand" >&2
    exit 1
  fi
}

# visudo -cf validates BEFORE the file is installed. A malformed sudoers file
# can lock every user out of sudo on the board, and the board is headless.
tmp="$(mktemp)"
printf '%s\n' "$WANT" > "$tmp"
chmod 440 "$tmp"
if ! visudo -cf "$tmp" >/dev/null 2>&1; then
  echo "generated sudoers rule failed validation; refusing to install it" >&2
  exit 1
fi
run_privileged install -m 440 -o root -g root "$tmp" "$RULE"
rm -f "$tmp"
echo "installed scoped NOPASSWD sudo for docker and systemctl"
REMOTE
}
run_step "configure scoped NOPASSWD sudo" configure_sudo

# --- 3. Docker -------------------------------------------------------------

install_docker() {
  pi_ssh "PW=$(printf '%q' "${ORANGEPI_PASSWORD:-}") LOGIN=$(printf '%q' "$ORANGEPI_LOGIN") bash -s" <<'REMOTE'
set -euo pipefail
run_privileged() {
  if sudo -n true 2>/dev/null; then sudo "$@";
  elif [ -n "$PW" ]; then printf '%s\n' "$PW" | sudo -S -p '' "$@";
  else echo "sudo needs a password and ORANGEPI_PASSWORD is empty" >&2; exit 1; fi
}
if command -v docker >/dev/null 2>&1; then
  echo "docker present: $(docker --version)"
else
  echo "installing docker (docker.io + compose plugin from the distribution)"
  run_privileged apt-get update -qq
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git curl
fi
# Enabled at boot, always: a board that loses power and comes back without the
# stack is indistinguishable, from outside, from a board that is off.
run_privileged systemctl enable --now docker >/dev/null 2>&1 || true
systemctl is-enabled docker | sed 's/^/docker at boot: /'
# The login user must be able to talk to the docker socket without sudo --
# every later step and every pi-* target assumes it.
id -nG "$LOGIN" | tr ' ' '\n' | grep -qx docker || {
  run_privileged usermod -aG docker "$LOGIN"
  echo "added $LOGIN to the docker group (takes effect on the next login)"
}
docker compose version | sed 's/^/compose: /'
REMOTE
}
run_step "install or update docker" install_docker

# --- 4. The data directory -------------------------------------------------

# Created if missing, NEVER wiped. This is the half of the data-safety rule
# that keeps accounts and worlds across a re-provision.
ensure_data_dir() {
  pi_ssh "DATA=$(printf '%q' "$DATA") LOGIN=$(printf '%q' "$ORANGEPI_LOGIN") PW=$(printf '%q' "${ORANGEPI_PASSWORD:-}") bash -s" <<'REMOTE'
set -euo pipefail
run_privileged() {
  if sudo -n true 2>/dev/null; then sudo "$@";
  elif [ -n "$PW" ]; then printf '%s\n' "$PW" | sudo -S -p '' "$@";
  else echo "sudo needs a password and ORANGEPI_PASSWORD is empty" >&2; exit 1; fi
}
if [ -d "$DATA" ]; then
  # Deliberately not `du`: pgdata is 0700 and owned by postgres's uid, so an
  # unprivileged du reports a few kilobytes for a directory holding the whole
  # database -- a reassuring number that is wrong in the one direction that
  # matters here.
  if [ -d "$DATA/pgdata" ]; then
    echo "keeping the existing data directory $DATA (contains a postgres volume)"
  else
    echo "keeping the existing data directory $DATA (no postgres volume yet)"
  fi
else
  run_privileged mkdir -p "$DATA"
  run_privileged chown "$LOGIN:$LOGIN" "$DATA"
  echo "created $DATA"
fi
REMOTE
}
run_step "ensure the data directory exists" ensure_data_dir

# --- 5. The board's own .env ----------------------------------------------

# Lives in DATA_DIR, not APP_DIR, and follows from the data-safety rule: an
# .env in the app directory is destroyed on every re-provision, and a
# regenerated POSTGRES_PASSWORD locks the operator out of the existing
# database -- which presents as a corrupt cluster rather than as a lost file.
#
# Secrets are generated ON the board and never travel from the workstation.
ensure_board_env() {
  pi_ssh "DATA=$(printf '%q' "$DATA") APP_DIR=$(printf '%q' "$APP") REPO=$(printf '%q' "$GIT_REPOSITORY") BRANCH=$(printf '%q' "$ORANGEPI_BRANCH") bash -s" <<'REMOTE'
set -euo pipefail
ENV_FILE="$DATA/.env"
umask 077
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Key by key, not all-or-nothing. An existing .env is NEVER rewritten -- a new
# POSTGRES_PASSWORD against an existing pgdata volume is an authentication
# failure that reads like data loss -- but a key added to this list later must
# still reach a board that was provisioned before it existed. All-or-nothing
# would skip the whole file and the missing key would surface much later, as
# a service that will not start.
ensure_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    echo "  kept    ${key}"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  added   ${key}"
  fi
}

# For CONFIGURATION rather than secrets: the workstation is authoritative, so
# a changed repository or branch must actually propagate. ensure_key would
# keep the old value forever, which is right for a generated secret and wrong
# for a setting the operator just edited.
set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=${value}$" "$ENV_FILE"; then
    echo "  kept    ${key}"
  elif grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "  updated ${key}"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  added   ${key}"
  fi
}

if [ ! -s "$ENV_FILE" ]; then
  {
    echo "# Generated on the board by provision.sh. Never copied from the"
    echo "# workstation, never committed. Lives in the data directory because"
    echo "# provisioning empties the app directory."
  } > "$ENV_FILE"
fi

# Secrets are generated HERE and never travel from the workstation.
ensure_key POSTGRES_PASSWORD "$(openssl rand -hex 24)"
ensure_key JWT_SECRET "$(openssl rand -hex 32)"
ensure_key DEPLOY_HOOK_SECRET "$(openssl rand -hex 32)"
# Configuration the BOARD-SIDE deploy needs. The deploy hook runs deploy.sh
# inside a container whose only .env is this file, so anything deploy.sh
# requires has to be here -- the hook's first real deploy failed on a missing
# GIT_REPOSITORY for exactly this reason, and it failed AFTER verifying the
# signature, which is the confusing place to fail.
set_key ORANGEPI_DATA_DIR "$DATA"
set_key ORANGEPI_APP_DIR "${APP_DIR:-/app}"
set_key GIT_REPOSITORY "$REPO"
set_key ORANGEPI_BRANCH "$BRANCH"
# Same-origin: the bundle calls /api and /authority on whatever host served
# it, so a changed tunnel hostname needs no rebuild.
ensure_key PUBLIC_URL ""
REMOTE
}
PI_VERBOSE=1 run_step "ensure the board's .env has every key" ensure_board_env

# --- 6. The app directory --------------------------------------------------

# Emptied and re-cloned. Safe only because of the guard in step 1.
clone_app_dir() {
  pi_ssh "APP=$(printf '%q' "$APP") REPO=$(printf '%q' "$GIT_REPOSITORY") BRANCH=$(printf '%q' "$ORANGEPI_BRANCH") PW=$(printf '%q' "${ORANGEPI_PASSWORD:-}") LOGIN=$(printf '%q' "$ORANGEPI_LOGIN") bash -s" <<'REMOTE'
set -euo pipefail
run_privileged() {
  if sudo -n true 2>/dev/null; then sudo "$@";
  elif [ -n "$PW" ]; then printf '%s\n' "$PW" | sudo -S -p '' "$@";
  else echo "sudo needs a password and ORANGEPI_PASSWORD is empty" >&2; exit 1; fi
}
if [ -d "$APP" ]; then
  [ -w "$APP" ] || run_privileged chown -R "$LOGIN:$LOGIN" "$APP"
  # Empty the CONTENTS, do not remove the directory itself. Removing /app
  # needs write permission on its PARENT -- which is / -- so `rm -rf /app`
  # fails with "permission denied" for a user who owns /app outright. It also
  # keeps the directory's ownership and any mount on it intact, which
  # recreating it would quietly change.
  find "$APP" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null \
    || run_privileged find "$APP" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
else
  mkdir -p "$APP" 2>/dev/null || { run_privileged mkdir -p "$APP"; run_privileged chown "$LOGIN:$LOGIN" "$APP"; }
fi
# --depth 1: the board needs the working tree, not the history, and a shallow
# clone is a fraction of the bytes and of the flash writes. deploy.sh fetches
# the same way.
GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP"
git -C "$APP" log -1 --format='cloned %h %s'
# The clone url is anonymous https, so there is no credential in the remote to
# rewrite -- said out loud because the original design DID have one here.
git -C "$APP" remote get-url origin | sed 's/^/remote: /'
REMOTE
}
run_step "wipe and re-clone the app directory" clone_app_dir

# --- 7. Hand over to the deploy path --------------------------------------

# Images, migrations and start are deploy.sh's job, and it is the path a CI
# deploy takes every time. Duplicating it here would mean a provisioning run
# exercising code no deploy ever runs.
printf '\n%s--- handing over to deploy.sh (images, migrations, start) ---%s\n\n' "$C_DIM" "$C_OFF"
if ! bash "$(dirname "${BASH_SOURCE[0]}")/deploy.sh"; then
  STEP_NAMES+=("deploy (images, migrations, start)")
  STEP_STATUS+=("FAILED")
  STEP_TIMES+=("-")
  STEP_FAILED=$((STEP_FAILED + 1))
  finish "pi-provision"
  exit 1
fi
STEP_NAMES+=("deploy (images, migrations, start)")
STEP_STATUS+=("ok")
STEP_TIMES+=("-")

finish "pi-provision"

url="$(pi_tunnel_url)"
cat <<MSG

${C_BOLD}the board is provisioned.${C_OFF}
  public URL   ${url:-(no tunnel running -- start it with 'make pi-up')}
  status       make pi-status
  logs         make pi-logs

ORANGEPI_PASSWORD may now be blanked in .env: everything from here is
key-based, and the scoped sudo rule is already installed.
MSG
