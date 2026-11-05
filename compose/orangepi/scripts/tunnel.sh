#!/usr/bin/env bash
# `make pi-tunnel-start|pi-tunnel-stop NAME=cloudflare|ngrok` (SOMET-715), and
# the same script the admin tab's host helper calls.
#
#   tunnel.sh start  <name>   prints `url=<url>` and exits 0, or `error=<why>` and exits 1
#   tunnel.sh stop   <name>   removes the container and remembers that choice
#   tunnel.sh switch <name>   starts <name>, and stops the other one only once
#                             <name> answers through its public address
#   tunnel.sh status <name>   prints state= url= verified= age=, one per line
#                             (ngrok adds out_bytes= requests=)
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
  *) echo "usage: tunnel.sh start|stop|switch|status cloudflare|ngrok" >&2; exit 2 ;;
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
      # The agent's local API, not its log: the agent logs nothing unless asked
      # to, and a log line can be rotated away while the tunnel keeps running.
      agent_tunnels | pi_ngrok_public_url ;;
  esac
}

agent_tunnels() {
  pi_ssh "docker exec $container wget -qO- -T3 http://127.0.0.1:4040/api/tunnels" 2>/dev/null || true
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

# ngrok's edge names its refusal in a header (ERR_NGROK_725: the monthly
# bandwidth is used up). Waiting cannot fix that, and the code is the useful part.
edge_error() {
  curl -s -o /dev/null -D - --max-time 10 -H "$SKIP_HEADER" "$1/api/health" 2>/dev/null \
    | tr -d '\r' | grep -i '^ngrok-error-code:' | awk '{print $2}' | tail -1 || true
}

# Sets VERIFY_ERROR when the edge refuses by name. Time is measured by clock: the
# ssh and curl calls inside a loop take longer than the sleep between them.
VERIFY_ERROR=""
verify_url() {
  local url="$1" deadline=$((SECONDS + WAIT_SECS)) code
  while :; do
    code="$(health_code "$url")"
    [ "$code" = "200" ] && return 0
    if [ "$name" = "ngrok" ] && [ "$code" != "000" ] && [ -n "$code" ]; then
      VERIFY_ERROR="$(edge_error "$url")"
      [ -n "$VERIFY_ERROR" ] && return 1
    fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep "$POLL_SECS"
  done
}

compose_up() {
  pi_ssh "$COMPOSE $(pi_profiles) up -d --no-deps --no-recreate $service" >&2
}

# Replaces the one NGROK_AUTHTOKEN line in the board's .env with the value read
# from stdin; the shared atomic rewrite lives in lib.sh (pi_env_write_key).
write_remote_token() {
  pi_env_write_key NGROK_AUTHTOKEN replace "$1"
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
    write_remote_token "$token" || fail env_write_failed
    pi_ssh "touch $DATA/tunnel-ngrok.on" || fail state_not_saved
  else
    pi_ssh "rm -f $DATA/tunnel-cloudflare.off" || fail state_not_saved
  fi

  log "starting $service"
  compose_up || fail_start compose_up_failed

  local deadline=$((SECONDS + WAIT_SECS)) url="" err=""
  while :; do
    url="$(current_url)"
    [ -n "$url" ] && break
    if [ "$name" = "ngrok" ]; then
      err="$(ngrok_error)"
      [ -n "$err" ] && fail_start "$err"
    fi
    [ "$SECONDS" -ge "$deadline" ] && fail_start no_url
    sleep "$POLL_SECS"
  done

  log "waiting for $url to serve /api/health"
  verify_url "$url" || fail_start "${VERIFY_ERROR:-not_answering}"

  # A switch does this itself, once the old link is gone: until then the old
  # link is still the one these would point at.
  [ -n "${TUNNEL_NO_FOLLOW:-}" ] || follow_link
  printf 'url=%s\n' "$url"
}

# The address changed, so the published page and CI's hook URL are stale.
# SOFT: the tunnel is up and serving whether or not this works, and failing the
# start over it would hide that. The caller still gets told.
follow_link() {
  local here out rc=0 notes=""
  here="$(dirname "${BASH_SOURCE[0]}")"
  out="$(bash "$here/reconcile-url.sh" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "$out"
    notes="reconcile-url.sh failed (exit $rc); the published address may be stale"
  fi
  rc=0
  # Unconditional: the secret cannot be read back, and the old address may still
  # answer for a while, so no check here could tell it is out of date.
  out="$(bash "$here/hook-register.sh" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "$out"
    notes="${notes:+$notes; }hook-register.sh failed (exit $rc); the next CI run may not reach the board"
  fi
  [ -z "$notes" ] || printf 'note=%s\n' "$notes"
}

# The new link must answer before the old one goes: a refused or failed new link
# (ngrok's monthly limit, a bad token) then costs nobody their connection.
do_switch() {
  local self other out rc=0 was_running
  self="${BASH_SOURCE[0]}"
  case "$name" in cloudflare) other=ngrok ;; ngrok) other=cloudflare ;; esac
  was_running="$(started_at)"
  log "starting $name; $other keeps running until it answers"
  out="$(TUNNEL_NO_FOLLOW=1 bash "$self" start "$name")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    # ngrok's failed start cleans up after itself. Cloudflare's stays on, because
    # it is on by default, which here would leave a second link nobody asked for.
    if [ "$name" = "cloudflare" ] && [ -z "$was_running" ]; then
      bash "$self" stop cloudflare >&2 || true
    fi
    printf '%s\n' "$out"
    exit 1
  fi
  printf '%s\n' "$out"
  if ! bash "$self" stop "$other" >&2; then
    printf 'note=the %s link could not be stopped, so both are running\n' "$other"
  fi
  follow_link
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
  local url verified=no age="" epoch extra=""
  if [ "$name" = "ngrok" ]; then
    # Read inside the board, never through the public address: the free plan
    # counts every request, and this runs once a minute (about 43,000 a month
    # against a limit of 20,000). The helper's rare latency probe is what notices
    # a refusal at ngrok's edge.
    local raw out_bytes requests
    raw="$(pi_ssh "docker exec $container sh -c 'wget -qO- -T3 http://127.0.0.1:4040/api/tunnels; echo; cat /sys/class/net/eth0/statistics/tx_bytes; wget -q -O /dev/null -T5 http://caddy/api/health && echo caddy_ok'" 2>/dev/null || true)"
    url="$(printf '%s\n' "$raw" | pi_ngrok_public_url)"
    out_bytes="$(printf '%s\n' "$raw" | grep -E '^[0-9]+$' | head -1 || true)"
    requests="$(printf '%s\n' "$raw" | grep -oE '"http":\{"count":[0-9]+' | grep -oE '[0-9]+$' | head -1 || true)"
    if [ -n "$url" ] && printf '%s\n' "$raw" | grep -q '^caddy_ok$'; then verified=yes; fi
    extra="out_bytes=$out_bytes"$'\n'"requests=$requests"$'\n'
  else
    url="$(current_url)"
    if [ -n "$url" ] && [ "$(health_code "$url")" = "200" ]; then verified=yes; fi
  fi
  # busybox date cannot parse nanoseconds or the T/Z form, so normalise first.
  epoch="$(date -u -d "$(printf '%s' "$started" | sed -E 's/\.[0-9]+Z$//; s/Z$//; s/T/ /')" +%s 2>/dev/null || true)"
  [ -n "$epoch" ] && age="$(( $(date -u +%s) - epoch ))"
  printf 'state=on\nurl=%s\nverified=%s\nage=%s\n%s' "$url" "$verified" "$age" "$extra"
}

case "$action" in
  start) do_start ;;
  stop) do_stop ;;
  switch) do_switch ;;
  status) do_status ;;
  *) echo "usage: tunnel.sh start|stop|switch|status cloudflare|ngrok" >&2; exit 2 ;;
esac
