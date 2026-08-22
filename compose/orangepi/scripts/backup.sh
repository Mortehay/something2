#!/usr/bin/env bash
# SOMET-400. Pull a Postgres dump off the board, onto this workstation.
#
# WHY A PULL, NOT A PUSH. The acceptance criterion says "pushed off the
# device"; the outcome that matters is that the dump lands somewhere the card
# cannot take with it. A push would need the Pi to hold a credential for this
# machine and would need inbound access here. A pull runs over the SSH path
# that already exists, in the direction it already goes, and adds no secret to
# the box being backed up.
#
# WHAT THIS PROTECTS AGAINST. Flash plus an unannounced power cut corrupts
# Postgres, and the card wears out. Both are "when", not "if" -- see
# SOMET-398's sibling concern about the data directory.
#
# ATOMIC BY CONSTRUCTION. The dump streams to a .part file and is renamed only
# after pg_dump exits 0. An interrupted transfer therefore leaves a .part,
# never a truncated .sql.gz that looks exactly like a good backup until the day
# someone needs it.
#
#   backup.sh            take a backup now
#   backup.sh --status   report the newest backup's age, non-zero if stale
#
# Env:
#   ORANGEPI_BACKUP_DIR    where dumps land (default ~/something2-backups)
#   ORANGEPI_BACKUP_KEEP   how many to retain (default 14)
#   ORANGEPI_BACKUP_MAX_AGE_H  staleness threshold in hours (default 36)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BACKUP_DIR="${ORANGEPI_BACKUP_DIR:-$HOME/something2-backups}"
KEEP="${ORANGEPI_BACKUP_KEEP:-14}"
# 36 rather than 24: a nightly job plus a late run must not read as failure.
# Anything past a day and a half means a night was genuinely missed.
MAX_AGE_H="${ORANGEPI_BACKUP_MAX_AGE_H:-36}"

# --- status -----------------------------------------------------------------
#
# EXISTENCE IS NOT SUCCESS. A backup directory full of files from three weeks
# ago is the failure mode this criterion exists for: it looks fine in a
# listing, and it is trusted precisely because it is there. Age is the check.
if [ "${1:-}" = "--status" ]; then
  newest="$(ls -1t "$BACKUP_DIR"/something2-*.sql.gz 2>/dev/null | head -1 || true)"
  if [ -z "$newest" ]; then
    echo "BACKUP: NONE FOUND in $BACKUP_DIR"
    exit 1
  fi
  now=$(date +%s)
  mtime=$(date -r "$newest" +%s)
  age_h=$(( (now - mtime) / 3600 ))
  size="$(du -h "$newest" | cut -f1)"
  printf 'BACKUP: %s\n  age  %sh (threshold %sh)\n  size %s\n  count %s\n' \
    "$(basename "$newest")" "$age_h" "$MAX_AGE_H" "$size" \
    "$(ls -1 "$BACKUP_DIR"/something2-*.sql.gz 2>/dev/null | wc -l)"
  if [ "$age_h" -gt "$MAX_AGE_H" ]; then
    echo "  STALE — the newest backup is older than the threshold. Backups are not running."
    exit 1
  fi
  # A dump that is present, recent, and EMPTY is the other silent failure.
  if [ ! -s "$newest" ]; then
    echo "  EMPTY — the newest backup has no content."
    exit 1
  fi
  echo "  ok"
  exit 0
fi

# --- take a backup ----------------------------------------------------------

require_pi_env
mkdir -p "$BACKUP_DIR"

stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/something2-$stamp.sql.gz"
part="$out.part"

COMPOSE="$(pi_compose_cmd)"

# `exec -T` (no tty) so the stream is not mangled; pg_dump writes to stdout on
# the board and gzip runs THERE too, so the slow link carries compressed bytes.
# Postgres credentials come from the board's own .env via compose, never from
# this side.
#
# RUNNING pg_dump INSIDE THE CONTAINER IS LOAD-BEARING, not just convenient:
# it is the only way the pg_dump major version matches the server it is dumping.
# A dump taken with a NEWER pg_dump can be unrestorable to the older server it
# came from -- pg_dump 18 emits `SET transaction_timeout`, which a 15 server
# rejects, so the restore dies partway. Anyone "just running pg_dump" from a
# workstation with a current Postgres client hits this.
echo "==> dumping from the board into $(basename "$out")"
if ! pi_ssh "$COMPOSE exec -T db sh -c 'pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --clean --if-exists | gzip -c'" > "$part"; then
  rm -f "$part"
  echo "FATAL: pg_dump failed; no backup written." >&2
  exit 1
fi

# A gzip stream that decompresses is the cheapest real proof the transfer
# completed -- exit 0 from ssh is not, because a mid-stream disconnect can
# still close cleanly.
if ! gzip -t "$part" 2>/dev/null; then
  rm -f "$part"
  echo "FATAL: the downloaded dump is not a valid gzip stream; discarded." >&2
  exit 1
fi

# And a dump with no CREATE TABLE in it is a connection that succeeded and a
# database that was empty -- which must not overwrite yesterday's good backup
# silently.
if ! gzip -dc "$part" | head -c 200000 | grep -q 'CREATE TABLE'; then
  rm -f "$part"
  echo "FATAL: the dump contains no CREATE TABLE; refusing to keep it." >&2
  exit 1
fi

mv "$part" "$out"
echo "==> wrote $out ($(du -h "$out" | cut -f1))"

# Retention. Newest KEEP survive; the rest go. Guarded so a mis-set KEEP of 0
# or empty cannot delete everything.
if [ "${KEEP}" -gt 0 ] 2>/dev/null; then
  ls -1t "$BACKUP_DIR"/something2-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    echo "    pruning $(basename "$old")"
    rm -f "$old"
  done
fi

exec "$0" --status
