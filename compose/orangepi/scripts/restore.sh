#!/usr/bin/env bash
# SOMET-400. Restore a dump taken by backup.sh.
#
# THIS IS DESTRUCTIVE. The dumps are taken with --clean --if-exists, so the
# restore DROPs every object it is about to recreate. Pointed at a live
# database it replaces the contents wholesale, which is the point, and is also
# why it refuses to run without an explicit target and confirmation.
#
#   restore.sh <dump.sql.gz> --into-local <database>   restore into a local database
#   restore.sh <dump.sql.gz> --into-board --yes-really-replace-live-data
#
# The local form is what makes the acceptance criterion "the restore is
# TESTED, not merely documented" checkable: tests/pi_backup_restore.test.js
# drives exactly this path -- dump, drop, restore, compare -- against a scratch
# database, so the flags and format are exercised rather than described.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Side-effect-free by design -- see the header of dump-guard.sh for why this is
# not lib.sh, which loads .env and would undermine the DATABASE_URL check below.
. "$HERE/dump-guard.sh"

DUMP="${1:-}"
MODE="${2:-}"
CONFIRM="${3:-}"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

[ -n "$DUMP" ] || usage
[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 66; }

# Verify before destroying anything. Restoring a corrupt dump over a working
# database turns a recoverable situation into an unrecoverable one.
gzip -t "$DUMP" 2>/dev/null || { echo "FATAL: $DUMP is not a valid gzip stream." >&2; exit 65; }
dump_has_create_table "$DUMP" \
  || { echo "FATAL: $DUMP contains no CREATE TABLE; refusing to restore it." >&2; exit 65; }

case "$MODE" in
  --into-local)
    DB="${CONFIRM:-}"
    [ -n "$DB" ] || { echo "--into-local needs a database name" >&2; exit 64; }
    : "${DATABASE_URL:?DATABASE_URL must point at the local server (the database name in it is ignored)}"
    # Reconstruct the server URL with the caller's database name substituted,
    # so a typo cannot silently restore into the dev database.
    base="${DATABASE_URL%/*}"
    echo "==> restoring $(basename "$DUMP") into local database '$DB'"
    gzip -dc "$DUMP" | psql "$base/$DB" -v ON_ERROR_STOP=1 -q
    echo "==> done"
    ;;
  --into-board)
    [ "$CONFIRM" = "--yes-really-replace-live-data" ] || {
      echo "Refusing: restoring onto the board replaces the LIVE database." >&2
      echo "Re-run with --yes-really-replace-live-data if that is what you mean." >&2
      exit 77
    }
    . "$HERE/lib.sh"
    require_pi_env
    COMPOSE="$(pi_compose_cmd)"
    echo "==> restoring $(basename "$DUMP") onto the BOARD (live data will be replaced)"
    # Stream compressed over the link and decompress on the far side.
    gzip -dc "$DUMP" | pi_ssh "$COMPOSE exec -T db sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -q'"
    echo "==> done. Restart the backend so it drops any cached world state:"
    echo "    make pi-restart"
    ;;
  *)
    usage
    ;;
esac
