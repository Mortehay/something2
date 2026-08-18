#!/usr/bin/env bash
# `make pi-keygen` (SOMET-436): establish password-free access to the board.
#
# Runs BEFORE pi-provision, and is the only script that ever uses
# ORANGEPI_PASSWORD. Everything afterwards is key-based, so no password is
# piped through `sudo -S` on the board, where it would be visible in the
# process list.
#
# ONE keypair, not two. An earlier draft of the design also generated a GitHub
# deploy key on the board; the repository is public, confirmed by an anonymous
# clone, so the board holds no git credential at all and that half is deleted.
#
# The rule that shapes this script: it NEVER regenerates an existing key.
# Silently replacing the workstation key would lock the operator out of the
# board -- the new public half is not in authorized_keys, and the old private
# half is gone -- and it would do so at the exact moment they were trying to
# fix access.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env ORANGEPI_ADDRESS ORANGEPI_LOGIN ORANGEPI_SSH_KEY

KEY="$(pi_key_path)"
PUB="${KEY}.pub"
TARGET="${ORANGEPI_LOGIN}@${ORANGEPI_ADDRESS}"

printf '%sboard%s   %s\n%skey%s     %s\n\n' "$C_BOLD" "$C_OFF" "$TARGET" "$C_BOLD" "$C_OFF" "$KEY"

# --- 1. The workstation key ------------------------------------------------

generate_key() {
  mkdir -p "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -N '' -C "something2-orangepi@$(hostname)" -f "$KEY" >/dev/null
  chmod 600 "$KEY"
}

# Which of the two happened is decided BEFORE the step, so it can be said in
# the step's label. run_step prints the output of a successful step only under
# PI_VERBOSE -- correct for docker's progress spew, wrong for this one line:
# "did it keep my key or replace it?" is the question this script exists to
# answer, and a normal run must answer it without being asked twice.
if [ -f "$KEY" ]; then
  # Not an error and not a warning: idempotence is the requirement, so a
  # second run reporting "kept" is the correct outcome.
  run_step "workstation key: keeping the existing one (never regenerated)" true
else
  run_step "workstation key: generating a new ed25519 keypair" generate_key
fi

# --- 2. Install the public half -------------------------------------------

# Already-working key auth is the common case on a re-run, and it must not
# require the password to be present in .env: ORANGEPI_PASSWORD is meant to be
# blanked after the first bootstrap.
key_auth_works() {
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
      -i "$KEY" -o IdentitiesOnly=yes "$TARGET" true 2>/dev/null
}

install_key() {
  if key_auth_works; then
    echo "the key already authenticates; authorized_keys is untouched"
    return 0
  fi
  if [ -z "${ORANGEPI_PASSWORD:-}" ]; then
    # Say what to do rather than failing with "permission denied". This is the
    # one moment in the module where a password is genuinely required.
    cat >&2 <<MSG
the key does not authenticate yet and ORANGEPI_PASSWORD is empty.

either set ORANGEPI_PASSWORD in .env for this one run (it can be blanked again
straight afterwards -- nothing else uses it), or install the key by hand:

    ssh-copy-id -i ${PUB} ${TARGET}
MSG
    return 1
  fi
  if ! command -v sshpass >/dev/null 2>&1; then
    cat >&2 <<MSG
sshpass is not installed, and it is what feeds ORANGEPI_PASSWORD to ssh
non-interactively. Either install it (apt-get install sshpass) or run:

    ssh-copy-id -i ${PUB} ${TARGET}
MSG
    return 1
  fi
  # ssh-copy-id is idempotent by itself: it will not append a key that is
  # already present, so a re-run cannot grow authorized_keys without bound.
  # ConnectTimeout matters here specifically: ssh-copy-id inherits ssh's
  # default TCP behaviour otherwise, so an unreachable board sits for minutes
  # on this one step while every other probe in the module gives up in ten
  # seconds -- and it does it right after asking for a password, which reads
  # as "the password is being checked" rather than "nothing is listening".
  sshpass -p "$ORANGEPI_PASSWORD" \
    ssh-copy-id -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
                -i "$PUB" "$TARGET"
}

run_step "install public key in authorized_keys" install_key

# --- 3. Prove it ----------------------------------------------------------

# The acceptance criterion is a password-free login that WORKS, not a copy
# command that exited 0. ssh-copy-id can succeed against the wrong account, or
# against a home directory whose permissions make sshd ignore authorized_keys
# entirely -- both of which look like success right up until provisioning.
verify_login() {
  key_auth_works || {
    cat >&2 <<MSG
the key was installed but a password-free login still fails.

the usual cause is permissions on the board: sshd ignores authorized_keys when
the home directory or ~/.ssh is group- or world-writable. on the board:

    chmod 755 ~ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
MSG
    return 1
  }
  echo "password-free login to $TARGET confirmed"
}

run_step "verify password-free login" verify_login

finish "pi-keygen"

cat <<MSG

next:
  * ORANGEPI_PASSWORD may now be blanked in .env -- nothing else reads it.
  * run 'make pi-provision' to take the board to a running stack.
MSG
