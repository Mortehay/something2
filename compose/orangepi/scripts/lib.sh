#!/usr/bin/env bash
# Shared transport and reporting for every pi-* target (SOMET-429).
#
# Sourced, never executed. Three things live here because every script needs
# all three and they must behave identically in each:
#
#   require_env   fail naming the MISSING VARIABLE, not with a bare error
#   pi_ssh        one ssh invocation style, one place to change it
#   run_step      status, duration, and the remote stderr of anything that failed
#
# The stderr half is the point. A deploy that reports `step 4 exited 1` tells
# you something broke; a deploy that prints what the board's docker actually
# said tells you what to fix. Capturing it costs one temp file per step.

set -euo pipefail

# --- Configuration ---------------------------------------------------------

# Every script runs from the repository root (the Makefile guarantees it), so
# .env is right here. Missing .env is not an error at this point: require_env
# below produces a far better message than a shell failing to read a file.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

# Reads .env WITHOUT overriding anything already in the environment, matching
# dotenv's behaviour, which the rest of this repository already depends on
# (see the note on DATABASE_URL in .env.example).
#
# `set -a; . .env` would be shorter and is what this originally did -- but it
# lets the file win over the environment, so
# `ORANGEPI_ADDRESS=other make pi-status` silently talked to the address in
# .env instead. The same override path is how CI and the deploy hook pass
# values, where there is no .env at all to correct the mistake.
#
# Not `source`d either: an .env is data, and sourcing it executes whatever it
# contains.
load_env_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *'='*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="${key#export }"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    # Only NAME-shaped keys; anything else is a malformed line, not a variable.
    case "$key" in
      [A-Za-z_][A-Za-z0-9_]*) ;;
      *) continue ;;
    esac
    # Strip one layer of matching quotes, the way dotenv does.
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
    [ -n "${!key:-}" ] && continue
    export "$key=$value"
  done < "$file"
}

load_env_file "$REPO_ROOT/.env"

: "${ORANGEPI_APP_DIR:=/app}"
: "${ORANGEPI_BRANCH:=orangepi}"
: "${ORANGEPI_SSH_KEY:=compose/orangepi/secrets/orangepi_ed25519}"

# The compose invocation used ON THE BOARD. The board's own .env lives in
# DATA_DIR, never in APP_DIR -- provisioning empties APP_DIR, and an .env kept
# there would be destroyed on every re-provision, taking POSTGRES_PASSWORD with
# it and locking the operator out of an otherwise healthy database.
PI_COMPOSE_FILE="compose/orangepi/docker-compose.yml"

# --- Colours ---------------------------------------------------------------
# Disabled when stdout is not a terminal, so `make pi-deploy > log` and CI logs
# stay readable instead of filling with escape codes.
if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''; C_OFF=''
fi

# --- Environment -----------------------------------------------------------

# Fails with the NAME of every missing variable at once, and with the file to
# put it in. Reporting them one per run turns a five-variable gap into five
# failed runs.
require_env() {
  local missing=() name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("$name"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    printf '%s\n' "${C_RED}missing required .env variable(s):${C_OFF}" >&2
    printf '  %s\n' "${missing[@]}" >&2
    printf '%s\n' "set them in $REPO_ROOT/.env -- see .env.example for what each one means" >&2
    exit 2
  fi
}

# The board's identity, needed by every remote script.
require_pi_env() {
  require_env ORANGEPI_ADDRESS ORANGEPI_LOGIN ORANGEPI_DATA_DIR
}

# --- Transport -------------------------------------------------------------

# Absolute path to the workstation key, whether .env gave a relative or an
# absolute one. ssh resolves relative paths against the CWD, so a relative
# ORANGEPI_SSH_KEY would work from the repository root and mysteriously fail
# from anywhere else.
pi_key_path() {
  case "$ORANGEPI_SSH_KEY" in
    /*) printf '%s\n' "$ORANGEPI_SSH_KEY" ;;
    "~"/*) printf '%s\n' "${HOME}/${ORANGEPI_SSH_KEY#\~/}" ;;
    *) printf '%s\n' "$REPO_ROOT/$ORANGEPI_SSH_KEY" ;;
  esac
}

# One ssh style for the whole module.
#
#   BatchMode=yes            never sit at a password prompt inside a make
#                            target -- a hung prompt in a non-interactive run
#                            looks like a network stall for as long as you let
#                            it. Key-based access is a precondition, and
#                            `make pi-keygen` is what establishes it.
#   accept-new               trust an unknown host key once, refuse a CHANGED
#                            one. `no` would silently accept a substituted host.
#   ServerAliveInterval      a `docker build` on four A53 cores is long and
#                            silent; without this the session can be dropped
#                            mid-build by an idle timeout.
pi_ssh() {
  local key; key="$(pi_key_path)"
  local -a opts=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o ConnectTimeout=10
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=6
  )
  [ -f "$key" ] && opts+=(-i "$key" -o IdentitiesOnly=yes)
  ssh "${opts[@]}" "${ORANGEPI_LOGIN}@${ORANGEPI_ADDRESS}" "$@"
}

# Runs a script on the board with `bash -s`, so quoting is a heredoc problem
# rather than a nested-escaping one. Variables are passed as positional
# arguments, never interpolated into the script text.
pi_bash() {
  local quoted=''
  local arg
  for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
  # ssh forwards OUR stdin to the remote command, so the caller's heredoc
  # becomes the script `bash -s` reads. Arguments are passed positionally and
  # shell-quoted -- never interpolated into the script text, where a value
  # containing a space or a quote would rewrite the script instead of feeding
  # it.
  pi_ssh "bash -s --$quoted"
}

# The board-side compose command, as one string to be run remotely.
pi_compose_cmd() {
  printf 'cd %q && docker compose --project-directory . --env-file %q/.env -f %q' \
    "$ORANGEPI_APP_DIR" "$ORANGEPI_DATA_DIR" "$PI_COMPOSE_FILE"
}

# --- Step reporting --------------------------------------------------------

STEP_INDEX=0
STEP_FAILED=0
STEP_NAMES=()
STEP_STATUS=()
STEP_TIMES=()

# run_step "label" cmd...
#
# Output is captured rather than streamed, on purpose: a dozen steps each
# spilling docker's progress output buries the one line that matters. A step
# that FAILS prints everything it captured; a step that succeeds prints its
# status line only. Set PI_VERBOSE=1 to see the output of successful steps too.
run_step() {
  local label="$1"; shift
  local out rc=0 start end elapsed
  out="$(mktemp)"
  STEP_INDEX=$((STEP_INDEX + 1))
  printf '%s▶%s %s ... ' "$C_BOLD" "$C_OFF" "$label"
  start=$(date +%s%N)
  # `|| rc=$?` rather than `set +e`: this file runs under `set -e`, and a
  # bare failing command inside a function would take the whole script down
  # before the failure could be reported at all.
  "$@" >"$out" 2>&1 || rc=$?
  end=$(date +%s%N)
  elapsed=$(awk "BEGIN{printf \"%.1f\", ($end - $start)/1000000000}")
  STEP_NAMES+=("$label")
  STEP_TIMES+=("$elapsed")
  if [ "$rc" -eq 0 ]; then
    printf '%sok%s %s(%ss)%s\n' "$C_GREEN" "$C_OFF" "$C_DIM" "$elapsed" "$C_OFF"
    STEP_STATUS+=("ok")
    if [ -n "${PI_VERBOSE:-}" ] && [ -s "$out" ]; then
      sed 's/^/    /' "$out"
    fi
  else
    printf '%sFAILED%s %s(%ss, exit %s)%s\n' "$C_RED" "$C_OFF" "$C_DIM" "$elapsed" "$rc" "$C_OFF"
    STEP_STATUS+=("FAILED")
    STEP_FAILED=$((STEP_FAILED + 1))
    if [ -s "$out" ]; then
      printf '%s--- output of failed step: %s ---%s\n' "$C_YELLOW" "$label" "$C_OFF" >&2
      sed 's/^/    /' "$out" >&2
      printf '%s--- end of output ---%s\n' "$C_YELLOW" "$C_OFF" >&2
    else
      printf '%s    (the step produced no output)%s\n' "$C_DIM" "$C_OFF" >&2
    fi
  fi
  rm -f "$out"
  return "$rc"
}

# Like run_step, but a failure is recorded, reported, and the script carries
# on. For steps whose failure is informational (a status probe), never for
# steps a later step depends on.
run_step_soft() {
  run_step "$@" || true
}

# Prints every step with its status and duration, then exits non-zero if any
# step failed -- so `make pi-deploy && something-else` and a CI gate both do
# the right thing without parsing output.
finish() {
  local title="${1:-summary}" i
  printf '\n%s%s%s\n' "$C_BOLD" "$title" "$C_OFF"
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_STATUS[$i]}" = "ok" ]; then
      printf '  %sok%s      %-46s %s%ss%s\n' "$C_GREEN" "$C_OFF" "${STEP_NAMES[$i]}" "$C_DIM" "${STEP_TIMES[$i]}" "$C_OFF"
    else
      printf '  %sFAILED%s  %-46s %s%ss%s\n' "$C_RED" "$C_OFF" "${STEP_NAMES[$i]}" "$C_DIM" "${STEP_TIMES[$i]}" "$C_OFF"
    fi
  done
  if [ "$STEP_FAILED" -gt 0 ]; then
    printf '\n%s%s step(s) failed.%s\n' "$C_RED" "$STEP_FAILED" "$C_OFF" >&2
    exit 1
  fi
  printf '\n%sall %s step(s) ok.%s\n' "$C_GREEN" "${#STEP_NAMES[@]}" "$C_OFF"
}

# The public URL, read from the cloudflared container's log. Quick tunnels
# print it once at startup and never again, so this reads the whole log rather
# than tailing it. Empty output means "no tunnel running", which callers must
# treat as a state, not as an error.
pi_tunnel_url() {
  pi_ssh "docker logs something2-orangepi-cloudflared-1 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1" 2>/dev/null || true
}
