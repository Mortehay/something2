#!/usr/bin/env bash
# `make pi-status` (SOMET-429): what is actually running on the board.
#
# The hard requirement here is that a DOWN stack reports as down instead of
# hanging. Every probe is bounded -- ssh has ConnectTimeout, curl has
# --max-time -- because the failure mode that matters is a board that is off,
# and a status command that blocks forever on it is worse than useless: it
# looks like the command is broken rather than the board being unreachable.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env

printf '%sboard%s      %s@%s\n' "$C_BOLD" "$C_OFF" "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS"
printf '%sapp dir%s    %s\n' "$C_BOLD" "$C_OFF" "$ORANGEPI_APP_DIR"
printf '%sdata dir%s   %s\n\n' "$C_BOLD" "$C_OFF" "$ORANGEPI_DATA_DIR"

# Reachability first, and it decides everything after it: probing containers on
# a board that is not answering produces a wall of identical ssh errors that
# say nothing the first one did not.
if ! pi_ssh true 2>/dev/null; then
  printf '%sBOARD UNREACHABLE%s -- no ssh to %s@%s\n' "$C_RED" "$C_OFF" "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS" >&2
  printf '  the board may be powered off, on another address, or the workstation key may not be installed.\n' >&2
  printf '  `make pi-keygen` installs the key; `ping %s` answers the first two.\n' "$ORANGEPI_ADDRESS" >&2
  exit 1
fi

# One ssh round trip for everything the board can answer locally. Each section
# is delimited so the workstation can present it without a second connection --
# on a link with 5ms latency that hardly matters, but each round trip is also
# another chance to hang.
report="$(pi_ssh "APP_DIR=$(printf %q "$ORANGEPI_APP_DIR") bash -s" <<'REMOTE' || true
set -u
compose_ps() {
  docker ps --filter 'name=something2-orangepi' \
    --format '{{.Names}}\t{{.Status}}' 2>/dev/null
}
echo "###CONTAINERS"
compose_ps
echo "###HEALTH"
# Straight at Caddy's published loopback port, which is the same path the
# tunnel takes into the stack -- so this checks the routing, not just the
# backend. --max-time keeps a wedged container from hanging the report.
curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/api/health 2>/dev/null || echo 000
echo
echo "###DISK"
df -h / | tail -1
echo "###MEMORY"
free -m | awk '/^Mem:/ {print $2" MB total, "$3" MB used, "$7" MB available"}'
echo "###UPTIME"
uptime -p 2>/dev/null || true
echo "###COMMIT"
git -C "${APP_DIR:-/app}" log -1 --format='%h %s' 2>/dev/null || echo "(not a git checkout -- provision.sh clones it)"
# Terminator for the section parser on the workstation. Without it the LAST
# section has no closing marker, and a range that runs to end-of-input loses
# its final line to the `$d` that strips the marker -- which shows up as an
# empty field rather than as an error.
echo "###END"
REMOTE
)"

section() { printf '%s\n' "$report" | sed -n "/^###$1\$/,/^###/p" | sed '1d;$d'; }

containers="$(section CONTAINERS)"
printf '%scontainers%s\n' "$C_BOLD" "$C_OFF"
if [ -z "$containers" ]; then
  # A reachable board with no containers is the normal "stack is down" state,
  # not a failure of this command -- say so plainly and keep going.
  printf '  %sSTACK DOWN%s -- no something2-orangepi containers are running\n' "$C_YELLOW" "$C_OFF"
else
  printf '%s\n' "$containers" | while IFS=$'\t' read -r name status; do
    case "$status" in
      Up*unhealthy*) colour="$C_RED" ;;
      Up*) colour="$C_GREEN" ;;
      *) colour="$C_YELLOW" ;;
    esac
    printf '  %s%-42s%s %s\n' "$colour" "$name" "$C_OFF" "$status"
  done
fi

code="$(section HEALTH | tr -d '[:space:]')"
printf '\n%shealth%s     ' "$C_BOLD" "$C_OFF"
case "$code" in
  200) printf '%sHTTP 200%s  (via caddy on 127.0.0.1:8080/api/health)\n' "$C_GREEN" "$C_OFF" ;;
  000|'') printf '%sDOWN%s      (nothing answering on 127.0.0.1:8080)\n' "$C_RED" "$C_OFF" ;;
  *) printf '%sHTTP %s%s  (caddy answered, but not with 200)\n' "$C_YELLOW" "$code" "$C_OFF" ;;
esac

printf '%sdisk%s       %s\n' "$C_BOLD" "$C_OFF" "$(section DISK)"
printf '%smemory%s     %s\n' "$C_BOLD" "$C_OFF" "$(section MEMORY)"
printf '%suptime%s     %s\n' "$C_BOLD" "$C_OFF" "$(section UPTIME)"
printf '%scommit%s     %s\n' "$C_BOLD" "$C_OFF" "$(section COMMIT)"

url="$(pi_tunnel_url)"
printf '%stunnel%s     ' "$C_BOLD" "$C_OFF"
if [ -n "$url" ]; then
  printf '%s\n' "$url"
else
  printf '%s(no tunnel running)%s -- start it with `make pi-up`, which includes the tunnel profile\n' "$C_DIM" "$C_OFF"
fi

# Exit code carries the headline so a script can gate on it: 0 only when the
# stack is actually serving. `make pi-status` printing a red DOWN and exiting 0
# would be a status command that lies to everything except a human reader.
[ "$code" = "200" ] || exit 1
