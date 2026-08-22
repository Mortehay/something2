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

# On the BOARD, the authoritative configuration is the .env in the data
# directory -- the app directory is emptied on every provision, so it has no
# .env at all. Without this the deploy hook, which runs here with PI_LOCAL=1,
# depends entirely on the environment baked into its container when it was
# created -- and that container is deliberately never recreated, so it went
# on failing with "missing GIT_REPOSITORY" long after the value had been
# written to the board. Observed exactly that way.
#
# Guarded on PI_LOCAL because ORANGEPI_DATA_DIR names a path on the BOARD; a
# workstation that happened to have that path would otherwise read a stranger.
if [ -n "${PI_LOCAL:-}" ] && [ -n "${ORANGEPI_DATA_DIR:-}" ]; then
  load_env_file "$ORANGEPI_DATA_DIR/.env"
fi

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

# The board's identity, needed by every remote script. In PI_LOCAL mode there
# is no board to address -- the script IS on it -- so only the paths matter.
require_pi_env() {
  if [ -n "${PI_LOCAL:-}" ]; then
    require_env ORANGEPI_DATA_DIR
  else
    require_env ORANGEPI_ADDRESS ORANGEPI_LOGIN ORANGEPI_DATA_DIR
  fi
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
# PI_LOCAL=1 runs the command HERE instead of over ssh, which is how the same
# deploy.sh serves two callers: an operator on the workstation, and the deploy
# hook running on the board itself. The alternative was a second board-side
# copy of the deploy sequence -- two scripts that must stay in step, where the
# one CI actually uses is the one no operator ever runs.
#
# stdin is passed through untouched, so the heredoc callers work identically
# in both modes.
pi_ssh() {
  if [ -n "${PI_LOCAL:-}" ]; then
    bash -c "$*"
    return $?
  fi
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

# Which compose profiles the board should run. The tunnel is always part of
# the deployed stack -- a board nobody can reach is not deployed. The deploy
# hook joins it only when the board actually has a secret for it, which is
# what keeps "an internet-reachable deploy trigger" a thing you configure
# rather than a thing that appears.
pi_profiles() {
  local profiles="--profile tunnel"
  if pi_ssh "grep -qE '^DEPLOY_HOOK_SECRET=.+' $(printf '%q' "$ORANGEPI_DATA_DIR")/.env" 2>/dev/null; then
    profiles="$profiles --profile hook"
  fi
  printf '%s' "$profiles"
}

# Monotonic-ish nanoseconds, with a fallback for shells whose date lacks %N.
#
# `date +%s%N` is a GNU extension, and busybox handles its absence in more
# than one way. The deploy-hook container -- which is what every CI-driven
# deploy runs in -- SILENTLY DROPS the %N and returns a plain seconds stamp
# (`1787250806`), while other builds emit the seconds with a literal "N"
# glued on. The first is the dangerous one: the result is all digits, so it
# looks valid, and treating seconds as nanoseconds made every step report
# 0.0s -- including one that took thirteen.
#
# So the test is LENGTH, not shape: a nanosecond epoch stamp is 19 digits, a
# seconds stamp is 10. Anything short is seconds, whatever it looks like.
#
# (An earlier version of this checked only for the literal "N" -- and its
# test stubbed exactly that. Both passed; the board still reported 0.0s. A
# fix verified against a stub of the wrong failure mode is not a fix.)
now_ns() {
  local stamp; stamp="$(date +%s%N 2>/dev/null || true)"
  case "$stamp" in
    ''|*[!0-9]*) stamp='' ;;
  esac
  if [ -n "$stamp" ] && [ "${#stamp}" -ge 16 ]; then
    printf '%s' "$stamp"
  else
    printf '%s000000000' "$(date +%s)"
  fi
}

# Where to probe the stack from, which is NOT the same address in both
# transports and cost five CI deploys a false failure before it was noticed.
#
#   over ssh      the board's own loopback, where Caddy publishes 8080
#   PI_LOCAL      inside the deploy-hook CONTAINER, where 127.0.0.1 is the
#                 container's own loopback and nothing is listening on it.
#                 Caddy is reachable by service name on the compose network.
#
# The backend was healthy six seconds after every one of those deploys. The
# probe simply could not see it, and reported a working deploy as broken --
# which is worse than not checking, because it teaches an operator to ignore
# the one step that would tell them a deploy really did fail.
pi_health_url() {
  if [ -n "${PI_LOCAL:-}" ]; then
    printf 'http://caddy:80/api/health'
  else
    printf 'http://127.0.0.1:8080/api/health'
  fi
}

# --- Step reporting --------------------------------------------------------

STEP_INDEX=0
STEP_FAILED=0
STEP_NAMES=()
STEP_STATUS=()
STEP_TIMES=()

# run_step "label" cmd...
#
# NOTE FOR ANYONE WRITING A STEP FUNCTION: `set -e` does NOT apply inside the
# command this runs. It is invoked as part of a `|| rc=$?` list below, and
# bash disables errexit for the whole of such a construct -- so a step
# function keeps going after a failed command instead of aborting, and only
# its FINAL exit status is reported. A step that publishes, commits or
# deploys must therefore check its own intermediate results explicitly. That
# is not hypothetical: a step here once wrote an empty file, committed it,
# pushed it over a working page and reported ok.
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
  start=$(now_ns)
  # `|| rc=$?` rather than `set +e`: this file runs under `set -e`, and a
  # bare failing command inside a function would take the whole script down
  # before the failure could be reported at all.
  "$@" >"$out" 2>&1 || rc=$?
  end=$(now_ns)
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

# Records a step whose OUTCOME had to be known before it could be described.
# The pull-or-build decision is the case: "pulled from the registry" and "none
# published, building here" are different steps, not one step that failed --
# and run_step prints its label before it runs, so it cannot say which.
#
# Without this the pull was run through run_step and its bookkeeping patched
# up afterwards, which printed a red FAILED and then a green summary. An
# operator reading that has to know the script to know which half to believe.
record_step() {
  local label="$1" status="$2" seconds="$3"
  STEP_INDEX=$((STEP_INDEX + 1))
  STEP_NAMES+=("$label")
  STEP_STATUS+=("$status")
  STEP_TIMES+=("$seconds")
  if [ "$status" = "ok" ]; then
    printf '%s▶%s %s ... %sok%s %s(%ss)%s\n' "$C_BOLD" "$C_OFF" "$label" "$C_GREEN" "$C_OFF" "$C_DIM" "$seconds" "$C_OFF"
  else
    STEP_FAILED=$((STEP_FAILED + 1))
    printf '%s▶%s %s ... %s%s%s\n' "$C_BOLD" "$C_OFF" "$label" "$C_RED" "$status" "$C_OFF"
  fi
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

# The public URL, read from the cloudflared container's log.
#
# Scoped to the CURRENT container run, and this is not a detail: a quick
# tunnel takes a new random hostname on every restart, docker keeps the whole
# log across restarts, and the URL is printed once at startup. A plain
# `docker logs | tail -1` therefore returns the PREVIOUS hostname during the
# seconds between a restart and the new banner -- which is exactly when a
# deploy prints its summary. That was observed: a deploy reported a hostname
# that had already stopped existing.
#
# Retries because the banner takes a moment to appear. Empty output means "no
# tunnel running", which callers must treat as a state rather than an error.
pi_tunnel_url() {
  local attempts="${1:-10}" started url
  started="$(pi_ssh "docker inspect -f '{{.State.StartedAt}}' something2-orangepi-cloudflared-1 2>/dev/null" || true)"
  [ -n "$started" ] || return 0
  local i
  for i in $(seq 1 "$attempts"); do
    url="$(pi_ssh "docker logs --since $(printf '%q' "$started") something2-orangepi-cloudflared-1 2>&1 \
      | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1" 2>/dev/null || true)"
    [ -n "$url" ] && { printf '%s\n' "$url"; return 0; }
    sleep 2
  done
  return 0
}

# --- Status rendering ------------------------------------------------------
#
# Presentation lives here, next to the other reporting, and takes the board's
# report as DATA on stdin rather than fetching it. Transport (status.sh) and
# presentation are then separable: the interesting states -- a stack that is
# down, a health endpoint answering something other than 200 -- can be
# exercised for real without stopping a running board to produce them, which
# is not something a status command should require anybody to do.
#
# Sets STATUS_HEALTH_CODE and returns non-zero when the stack is not serving.
render_status() {
  local report; report="$(cat)"
  local section
  section() { printf '%s\n' "$report" | sed -n "/^###$1\$/,/^###/p" | sed '1d;$d'; }

  local containers; containers="$(section CONTAINERS)"
  printf '%scontainers%s\n' "$C_BOLD" "$C_OFF"
  if [ -z "$containers" ]; then
    # A reachable board with no containers is the normal "stack is down"
    # state, not a failure of this command -- say so plainly and keep going,
    # because the disk and memory numbers below are exactly what you want
    # when the stack will not start.
    printf '  %sSTACK DOWN%s -- no something2-orangepi containers are running\n' "$C_YELLOW" "$C_OFF"
  else
    local name status colour
    while IFS=$'\t' read -r name status; do
      [ -n "$name" ] || continue
      case "$status" in
        Up*unhealthy*) colour="$C_RED" ;;
        Up*) colour="$C_GREEN" ;;
        *) colour="$C_YELLOW" ;;
      esac
      printf '  %s%-42s%s %s\n' "$colour" "$name" "$C_OFF" "$status"
    done <<< "$containers"
  fi

  STATUS_HEALTH_CODE="$(section HEALTH | tr -d '[:space:]')"
  printf '\n%shealth%s     ' "$C_BOLD" "$C_OFF"
  case "$STATUS_HEALTH_CODE" in
    200) printf '%sHTTP 200%s  (via caddy on 127.0.0.1:8080/api/health)\n' "$C_GREEN" "$C_OFF" ;;
    000|'') printf '%sDOWN%s      (nothing answering on 127.0.0.1:8080)\n' "$C_RED" "$C_OFF" ;;
    *) printf '%sHTTP %s%s  (caddy answered, but not with 200)\n' "$C_YELLOW" "$STATUS_HEALTH_CODE" "$C_OFF" ;;
  esac

  printf '%sdisk%s       %s\n' "$C_BOLD" "$C_OFF" "$(section DISK)"
  printf '%smemory%s     %s\n' "$C_BOLD" "$C_OFF" "$(section MEMORY)"
  printf '%suptime%s     %s\n' "$C_BOLD" "$C_OFF" "$(section UPTIME)"
  printf '%scommit%s     %s\n' "$C_BOLD" "$C_OFF" "$(section COMMIT)"

  [ "$STATUS_HEALTH_CODE" = "200" ]
}

# How long the current quick-tunnel hostname has been in service, in seconds.
#
# There is no TTL to read: nothing in the protocol exposes an expiry, and a
# quick tunnel has no published lifetime. What CAN be answered is how long
# this one has held -- and since the hostname only changes when cloudflared
# restarts, its age is the age of the banner line that announced it. Empty
# when there is no tunnel.
pi_tunnel_age_seconds() {
  local banner now
  banner="$(pi_ssh "docker logs --timestamps something2-orangepi-cloudflared-1 2>&1 \
    | grep -F 'trycloudflare.com  ' | tail -1 | cut -d' ' -f1" 2>/dev/null || true)"
  [ -n "$banner" ] || return 0
  banner="$(date -u -d "$banner" +%s 2>/dev/null || true)"
  [ -n "$banner" ] || return 0
  now="$(date -u +%s)"
  printf '%s' "$((now - banner))"
}

# "2d 3h", "4h 12m", "45s" -- an age is read at a glance or not at all.
format_duration() {
  local total="$1"
  if [ "$total" -ge 86400 ]; then printf '%dd %dh' "$((total / 86400))" "$(((total % 86400) / 3600))"
  elif [ "$total" -ge 3600 ]; then printf '%dh %dm' "$((total / 3600))" "$(((total % 3600) / 60))"
  elif [ "$total" -ge 60 ]; then printf '%dm' "$((total / 60))"
  else printf '%ds' "$total"; fi
}

# --- The data-safety rule --------------------------------------------------
#
# Provisioning EMPTIES the app directory. That is only safe because game data
# is forbidden from living there:
#
#   APP_DIR   the clone and nothing else. Disposable, wiped without ceremony.
#   DATA_DIR  Postgres's volume, the board's own .env, sprite storage.
#             Provisioning never touches it.
#
# Without this check a second `make pi-provision` silently destroys every
# account and world on the board -- and it presents as database corruption
# rather than as the operator error it is, so it gets diagnosed in entirely
# the wrong place.
#
# The check runs ON THE BOARD, because that is where both paths mean
# something: /app on the workstation is not /app on the Pi, and a symlink that
# only exists on the board is exactly the case that a workstation-side string
# comparison would wave through.
# The resolver, kept as a string so the SAME code runs on the board over ssh
# and in the tests against real local symlinks. A guard whose interesting case
# -- a symlink that exists only on the board -- can only be exercised by
# provisioning a board is a guard nobody exercises.
#
# It resolves symlinks on the deepest EXISTING ancestor: neither directory
# need exist yet on a bare board, and `readlink -f` on a missing path resolves
# the name literally, which would quietly skip the symlink check this exists
# for.
PATH_RESOLVE_SCRIPT='
set -u
resolve() {
  p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  head="$(readlink -f "$p")"
  tail="${1#"$p"}"
  printf "%s\n" "${head%/}${tail}"
}
printf "%s\n%s\n" "$(resolve "$APP")" "$(resolve "$DATA")"
'

# Pure comparison, given two ALREADY-RESOLVED absolute paths. Returns 0 when
# data is inside app -- the refusing case.
#
# Both sides get a trailing slash. Bare prefix matching would call
# /srv/something2-data "inside" /srv/something2 and refuse a layout that is
# perfectly safe; a guard that cries wolf is a guard that gets disabled.
data_dir_is_inside_app_dir() {
  local app_real="${1%/}" data_real="${2%/}"
  case "${data_real}/" in
    "${app_real}/"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Runs the resolver ON THE BOARD, because that is where both paths mean
# something: /app on the workstation is not /app on the Pi, and a symlink that
# exists only on the board is exactly what a workstation-side string
# comparison waves through.
assert_data_dir_outside_app_dir() {
  local app="${1:-$ORANGEPI_APP_DIR}" data="${2:-$ORANGEPI_DATA_DIR}"
  local resolved
  resolved="$(pi_ssh "APP=$(printf '%q' "$app") DATA=$(printf '%q' "$data") bash -s" <<<"$PATH_RESOLVE_SCRIPT")" || {
    printf '%scould not resolve the app and data directories on the board%s\n' "$C_RED" "$C_OFF" >&2
    return 1
  }
  local app_real data_real
  app_real="$(printf '%s\n' "$resolved" | sed -n 1p)"
  data_real="$(printf '%s\n' "$resolved" | sed -n 2p)"

  if data_dir_is_inside_app_dir "$app_real" "$data_real"; then
    cat >&2 <<MSG
${C_RED}refusing to provision: the data directory is inside the app directory.${C_OFF}

  ORANGEPI_APP_DIR   $ORANGEPI_APP_DIR   -> $app_real
  ORANGEPI_DATA_DIR  $ORANGEPI_DATA_DIR  -> $data_real

provisioning EMPTIES the app directory. With this layout it would take the
Postgres volume with it -- every account and every world on the board -- and
the result would look like database corruption rather than an operator error.

point ORANGEPI_DATA_DIR somewhere outside ${app_real} (the default,
/srv/something2, is outside /app) and run this again.
MSG
    return 1
  fi
  printf '%s (app) and %s (data) are separate\n' "$app_real" "$data_real"
}

# --- The stable front door (SOMET-440) -------------------------------------
#
# Rendering lives here rather than in publish-url.sh for the same reason
# render_status does: the page is what a player actually sees, and it should
# be checkable without publishing anything to the internet to look at it.

render_front_door_page() {
  local target="$1" stamp="$2"
  # Three redirect mechanisms, deliberately: the meta refresh works with
  # JavaScript disabled, the script tag fires immediately, and the link is
  # there when both are blocked or the redirect is simply wrong -- in which
  # case a visitor can still see and copy the address rather than staring at
  # a blank page.
  #
  # noindex/nofollow because this points at a staging box whose registration
  # is open to anyone. A stable address is convenient for players and equally
  # convenient for a crawler; being in a search index is a different thing
  # from being reachable, and only the first is chosen here.
  cat <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>something2 — play</title>
<meta http-equiv="refresh" content="0; url=${target}">
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; text-align: center; padding: 2rem; }
  main { max-width: 34rem; }
  a.play { display: inline-block; margin: 1.5rem 0 1rem; padding: .8rem 1.6rem;
           border-radius: .5rem; background: #6d28d9; color: #fff;
           text-decoration: none; font-weight: 600; }
  code { word-break: break-all; opacity: .75; font-size: .9em; }
  p.note { opacity: .65; font-size: .9em; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <h1>something2</h1>
  <p>Taking you to the server&hellip;</p>
  <a class="play" href="${target}">Play</a>
  <p><code>${target}</code></p>
  <p class="note">
    The server runs on a small board at home behind a Cloudflare tunnel, and
    the tunnel takes a new address whenever it restarts. This page is updated
    to match, so this link is the one worth bookmarking. Last updated
    ${stamp}.
  </p>
</main>
<script>location.replace(${target@Q});</script>
</body>
</html>
HTML
}


# Would this file actually work as the front door? Checked before publishing,
# because the failure that prompted it published an EMPTY page over a working
# one and reported success.
front_door_page_is_sane() {
  local file="$1" url="$2"
  [ -s "$file" ] || return 1
  grep -qF "$url" "$file" || return 1
  grep -qi '<html' "$file" || return 1
}

# Given what the published page currently points at and what the board is
# actually serving, which of the three states are we in? Extracted so the
# STALE case -- the one that matters, and the one you cannot conjure on a
# live board without breaking the front door to do it -- is testable.
front_door_state() {
  local published="$1" live="$2"
  if [ -z "$published" ]; then printf 'missing'
  elif [ "$published" = "$live" ]; then printf 'current'
  else printf 'stale'; fi
}

# --- Where an installed timer may point (SOMET-442) -------------------------
#
# Agent sessions work in a throwaway git worktree under /tmp. A systemd unit
# whose ExecStart points into one keeps working perfectly until the machine
# reboots, and then fails every ten minutes forever -- silently, because the
# thing it was watching over is exactly the thing nobody looks at. Worse, the
# board's ssh key lived there too, so a reboot took the only way in with it.
path_is_ephemeral() {
  case "$1" in
    /tmp/*|/var/tmp/*|/dev/shm/*|/run/*|*/scratchpad/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The repository root that survives a reboot: this one if it already does,
# otherwise the main checkout this worktree hangs off (git-common-dir's
# parent). Prints nothing when neither qualifies -- callers must treat that as
# "refuse", never as "use the current directory anyway".
durable_repo_root() {
  local root="${1:-$REPO_ROOT}" common
  if ! path_is_ephemeral "$root"; then printf '%s\n' "$root"; return 0; fi
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  [ -n "$common" ] || return 0
  common="$(dirname "$common")"
  path_is_ephemeral "$common" && return 0
  printf '%s\n' "$common"
}
