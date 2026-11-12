#!/usr/bin/env bash
# The board's .env, seen and written key by key (email accounts, Task 15). Run by the Pi helper for the ".env sync"
# box in the Orange Pi tab; this is how the mail settings (SMTP_*) reach the board.
#
#   env-sync.sh hashes      one `KEY <sha256 hex of the value>` line per key of the board's .env. The hashing runs
#                           ON THE BOARD: values never leave it, and nothing else is printed on stdout.
#   env-sync.sh write KEY   reads the value from stdin (one line) and sets KEY in the board's .env with
#                           pi_env_write_key, the same safe writer the deploy uses. The value never appears in an
#                           argv or in anything this prints.
#
# The value is parsed on the board exactly as tools/pi-helper/boardRunner.js parseEnvFile parses the PC's .env
# (trim, `export `, one layer of matching quotes), so the same value hashes the same on both sides.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { echo "usage: env-sync.sh hashes | env-sync.sh write KEY  (the value on stdin)" >&2; exit 2; }

[ $# -ge 1 ] || usage
require_pi_env

case "$1" in
  hashes)
    [ $# -eq 1 ] || usage
    rc=0
    pi_bash "$ORANGEPI_DATA_DIR" <<'REMOTE' || rc=$?
set -u
f="$1/.env"
[ -f "$f" ] && [ -r "$f" ] || { echo "the board's .env is missing or unreadable" >&2; exit 3; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is not available on the board" >&2; exit 4; }
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }
while IFS= read -r line || [ -n "$line" ]; do
  line="$(trim "$line")"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in [!=]*=*) ;; *) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in export[[:space:]]*) key="${key#export}" ;; esac
  key="$(trim "$key")"
  case "$key" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
  value="$(trim "$value")"
  if [ "${#value}" -ge 2 ]; then
    first="${value:0:1}"; last="${value: -1}"
    if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then value="${value:1:${#value}-2}"; fi
  fi
  h="$(printf '%s' "$value" | sha256sum)" || exit 4
  printf '%s %s\n' "$key" "${h%% *}"
done < "$f"
REMOTE
    exit "$rc"
    ;;
  write)
    [ $# -eq 2 ] || usage
    key="$2"
    # Under PI_LOCAL this runs inside the deploy hook, where the data directory is mounted read-only; copying is a
    # workstation action only.
    if [ -n "${PI_LOCAL:-}" ]; then echo "env-sync.sh write runs from the workstation only (PI_LOCAL is set)" >&2; exit 2; fi
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "refusing: '$key' is not an .env key name (A-Z, 0-9, _)" >&2; exit 2; }
    value=''
    IFS= read -r value || [ -n "$value" ] || { echo "no value on stdin for $key" >&2; exit 2; }
    value="${value%$'\r'}"
    # One line only: a second line would be a second .env entry.
    if IFS= read -r _extra || [ -n "${_extra:-}" ]; then echo "refusing: the value for $key must be one line" >&2; exit 2; fi
    [ -n "$value" ] || { echo "refusing: the value for $key is empty" >&2; exit 2; }
    rc=0
    pi_env_write_key "$key" replace "$value" || rc=$?
    if [ "$rc" -ne 0 ]; then echo "writing $key into the board's .env failed (exit $rc)" >&2; exit "$rc"; fi
    echo "wrote $key"
    ;;
  *) usage ;;
esac
