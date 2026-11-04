#!/usr/bin/env bash
# `make pi-tunnel-start|pi-tunnel-stop NAME=cloudflare|ngrok` (SOMET-715), and
# the same script the admin tab's host helper calls.
#
#   tunnel.sh start  <name>   prints `url=<url>` and exits 0, or `error=<why>` and exits 1
#   tunnel.sh stop   <name>   removes the container and remembers that choice
#   tunnel.sh status <name>   prints state= url= verified= age=, one per line
#
# stdout carries ONLY those machine-read lines (plus an optional `note=`);
# progress goes to stderr so a caller can parse stdout without filtering.
#
# The choice is remembered on the board (see pi_tunnel_wanted in lib.sh), so a
# deploy or reboot does not undo it.
#
# WHY `stop` REMOVES THE CONTAINER: pi_tunnel_url reads the logs of a stopped
# container too, so a merely stopped tunnel would still report its old, dead
# address.
#
# The ngrok token is read from the WORKSTATION's .env and sent to the board on
# stdin. It must never appear in an argv: argv is visible in `ps` and in ssh
# and docker logs.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env

# Seconds to wait for the tunnel to print its address, and between probes.
# Overridable so the tests do not have to wait a real minute.
WAIT_SECS="${TUNNEL_WAIT_SECS:-60}"
POLL_SECS="${TUNNEL_POLL_SECS:-2}"

action="${1:-}"
name="${2:-}"
case "$name" in
  cloudflare) service="cloudflared" ;;
  ngrok) service="ngrok" ;;
  *) echo "usage: tunnel.sh start|stop|status cloudflare|ngrok" >&2; exit 2 ;;
esac
container="something2-orangepi-${service}-1"
DATA="$(printf '%q' "$ORANGEPI_DATA_DIR")"
OFF_FILE="$ORANGEPI_DATA_DIR/tunnel-cloudflare.off"
ON_FILE="$ORANGEPI_DATA_DIR/tunnel-ngrok.on"
COMPOSE="$(pi_compose_cmd)"
SKIP_HEADER='ngrok-skip-browser-warning: 1'

log() { printf '%s\n' "$*" >&2; }
fail() { printf 'error=%s\n' "$1"; exit 1; }

started_at() {
  pi_ssh "docker inspect -f '{{.State.StartedAt}}' $container 2>/dev/null" 2>/dev/null || true
}

# The address of the CURRENT run of the container; empty if none (yet).
current_url() {
  local started; started="$(started_at)"
  [ -n "$started" ] || return 0
  local logs="docker logs --since $(printf '%q' "$started") $container 2>&1"
  case "$name" in
    cloudflare)
      pi_ssh "$logs | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1" 2>/dev/null || true ;;
    ngrok)
      pi_ssh "$logs | grep 'started tunnel' | grep -oE 'url=https://[^ \"]+' | tail -1 | sed 's/^url=//'" 2>/dev/null || true ;;
  esac
}

# ngrok refuses with a code (ERR_NGROK_334: domain already online, 105: bad
# token, ...) and then crash-loops; the code is the useful part.
ngrok_error() {
  local started; started="$(started_at)"
  [ -n "$started" ] || return 0
  pi_ssh "docker logs --since $(printf '%q' "$started") $container 2>&1 | grep -oE 'ERR_NGROK_[0-9]+' | tail -1" 2>/dev/null || true
}

# 200 from /api/health THROUGH the public address, from here. A tunnel that
# has printed a hostname is not a tunnel that serves: the edge answers for
# hostnames whose origin is down.
health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "$SKIP_HEADER" "$1/api/health" 2>/dev/null || true
}

verify_url() {
  local url="$1" waited=0 code
  while :; do
    code="$(health_code "$url")"
    [ "$code" = "200" ] && return 0
    [ "$waited" -ge "$WAIT_SECS" ] && return 1
    sleep "$POLL_SECS"
    waited=$((waited + POLL_SECS))
  done
}

compose_up() {
  pi_ssh "$COMPOSE $(pi_profiles) up -d --no-deps --no-recreate $service" >&2
}

# Replaces the one NGROK_AUTHTOKEN line in the board's .env with the value
# read from stdin. Everything else in the file is kept, and the file is
# rewritten in place (cat >) so its owner and mode stay as provisioning set them.
write_remote_token() {
  pi_ssh "read -r tok; f=$DATA/.env; t=\"\$f.tmp\"; umask 077; touch \"\$f\"; \
    { grep -v '^NGROK_AUTHTOKEN=' \"\$f\" || true; } > \"\$t\"; \
    printf 'NGROK_AUTHTOKEN=%s\n' \"\$tok\" >> \"\$t\"; cat \"\$t\" > \"\$f\"; rm -f \"\$t\"" \
    <<<"$1"
}

# A start that got as far as running the container but never produced a serving
# tunnel. For ngrok the container is removed and the "on" mark cleared: left
# alone it crash-loops against ngrok under restart: unless-stopped, and every
# later deploy would keep it running. The code is captured by the caller
# BEFORE the container (and its logs) go away. Cloudflare is on by default, so
# its failure is left running and wanted rather than turned off.
fail_start() {
  local code="$1"
  if [ "$name" = "ngrok" ]; then
    log "ngrok did not come up ($code); removing it and clearing the remembered choice"
    pi_ssh "rm -f $DATA/tunnel-ngrok.on" >&2 || true
    pi_ssh "$COMPOSE --profile tunnel --profile ngrok rm -sf $service" >&2 || true
  fi
  fail "$code"
}

do_start() {
  if [ "$name" = "ngrok" ]; then
    local token="${NGROK_AUTHTOKEN:-}"
    [ -n "$token" ] || fail no_token
    log "sending the ngrok token to the board"
    write_remote_token "$token" || fail token_not_saved
    pi_ssh "touch $DATA/tunnel-ngrok.on" || fail state_not_saved
  else
    pi_ssh "rm -f $DATA/tunnel-cloudflare.off" || fail state_not_saved
  fi

  log "starting $service"
  compose_up || fail compose_up_failed

  local waited=0 url="" err=""
  while :; do
    url="$(current_url)"
    [ -n "$url" ] && break
    if [ "$name" = "ngrok" ]; then
      err="$(ngrok_error)"
      [ -n "$err" ] && fail_start "$err"
    fi
    [ "$waited" -ge "$WAIT_SECS" ] && fail_start no_url
    sleep "$POLL_SECS"
    waited=$((waited + POLL_SECS))
  done

  log "waiting for $url to serve /api/health"
  verify_url "$url" || fail_start not_answering

  if [ "$name" = "cloudflare" ]; then
    # The address changed, so the published page and CI's hook URL are stale.
    # SOFT: the tunnel is up and serving whether or not this works, and failing
    # the start over it would hide that. The caller still gets told.
    local out rc=0
    out="$(bash "$(dirname "${BASH_SOURCE[0]}")/reconcile-url.sh" 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      log "$out"
      printf 'note=reconcile-url.sh failed (exit %s); the published address may be stale\n' "$rc"
    fi
  fi
  printf 'url=%s\n' "$url"
}

do_stop() {
  if [ "$name" = "ngrok" ]; then
    pi_ssh "rm -f $DATA/tunnel-ngrok.on" || fail state_not_saved
  else
    pi_ssh "mkdir -p $DATA && touch $DATA/tunnel-cloudflare.off" || fail state_not_saved
  fi
  # Both profiles named explicitly: a profile that is no longer active would
  # hide the very service being removed.
  pi_ssh "$COMPOSE --profile tunnel --profile ngrok rm -sf $service" >&2 || fail compose_rm_failed
}

do_status() {
  local started; started="$(started_at)"
  if [ -z "$started" ]; then
    printf 'state=off\nurl=\nverified=no\nage=\n'
    return 0
  fi
  local url verified=no age="" epoch
  url="$(current_url)"
  if [ -n "$url" ] && [ "$(health_code "$url")" = "200" ]; then verified=yes; fi
  # busybox date cannot parse nanoseconds or the T/Z form, so normalise first.
  epoch="$(date -u -d "$(printf '%s' "$started" | sed -E 's/\.[0-9]+Z$//; s/Z$//; s/T/ /')" +%s 2>/dev/null || true)"
  [ -n "$epoch" ] && age="$(( $(date -u +%s) - epoch ))"
  printf 'state=on\nurl=%s\nverified=%s\nage=%s\n' "$url" "$verified" "$age"
}

case "$action" in
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  *) echo "usage: tunnel.sh start|stop|status cloudflare|ngrok" >&2; exit 2 ;;
esac
