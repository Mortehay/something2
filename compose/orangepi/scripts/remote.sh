#!/usr/bin/env bash
# One compose command against the board (SOMET-428), so every pi-* make target
# stays a single line.
#
#   remote.sh compose <args...>     docker compose <args> on the board
#   remote.sh backend <cmd...>      run <cmd> in the backend container
#   remote.sh shell                 interactive shell in the backend container
#   remote.sh db-shell              interactive psql on the board
#   remote.sh tunnel-url            print the current public URL
#   remote.sh hook-secret           print the board's deploy-hook secret
#
# Why a wrapper rather than each target spelling out its own ssh: the board's
# compose invocation has three parts that must agree every time -- the app
# directory, the board's .env in the DATA directory, and the production
# compose file. A target that got any one of them wrong would still run, just
# against the wrong configuration.
#
# The local stack is unreachable from here BY CONSTRUCTION: every path runs
# through pi_ssh, so the worst a bug in this file can do is run the wrong
# command on the board. There is no branch that talks to a local docker.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env

COMPOSE="$(pi_compose_cmd)"
PROFILES="$(pi_profiles)"

# Interactive variants need a tty on the far side; pi_ssh is deliberately
# BatchMode-and-no-tty for everything that runs unattended.
pi_ssh_tty() {
  local key; key="$(pi_key_path)"
  local -a opts=(-t -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
  [ -f "$key" ] && opts+=(-i "$key" -o IdentitiesOnly=yes)
  ssh "${opts[@]}" "${ORANGEPI_LOGIN}@${ORANGEPI_ADDRESS}" "$@"
}

# Shell-quotes the caller's arguments so a map spec with a space, or a psql
# statement with quotes in it, arrives on the board as one argument rather
# than as several.
quote_args() {
  local out='' arg
  for arg in "$@"; do out+=" $(printf '%q' "$arg")"; done
  printf '%s' "$out"
}

mode="${1:-}"
[ $# -gt 0 ] && shift

case "$mode" in
  compose)
    # --profile tunnel on every lifecycle call, so `pi-up` brings the public
    # URL up with the stack and `pi-down` takes it down with it. Without it,
    # `down` leaves a cloudflared container pointing at a stack that is gone.
    pi_ssh "$COMPOSE $PROFILES$(quote_args "$@")"
    ;;
  backend)
    # -T: no tty, because this is how the seeding and migration targets run,
    # and they must work from a make target and from CI alike.
    pi_ssh "$COMPOSE exec -T backend$(quote_args "$@")"
    ;;
  shell)
    pi_ssh_tty "$COMPOSE exec backend sh"
    ;;
  db-shell)
    pi_ssh_tty "$COMPOSE exec db psql -U user -d game_db"
    ;;
  hook-secret)
    # Printed, deliberately. The secret is generated ON the board and has to
    # reach GitHub's Actions secrets somehow; `make pi-hook-register` pipes
    # this straight into `gh secret set` without it passing through a
    # terminal, and this subcommand is what an operator uses when doing it by
    # hand instead.
    secret="$(pi_ssh "sed -n 's/^DEPLOY_HOOK_SECRET=//p' $(printf '%q' "$ORANGEPI_DATA_DIR")/.env" | tail -1)"
    if [ -z "$secret" ]; then
      printf 'no DEPLOY_HOOK_SECRET on the board -- run `make pi-provision` to generate one.\n' >&2
      exit 1
    fi
    printf '%s\n' "$secret"
    ;;
  tunnel-url)
    url="$(pi_tunnel_url)"
    if [ -z "$url" ]; then
      printf 'no tunnel is running on the board.\n' >&2
      printf 'start the stack with `make pi-up` -- the tunnel is part of it.\n' >&2
      exit 1
    fi
    printf '%s\n' "$url"
    ;;
  *)
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
