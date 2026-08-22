#!/usr/bin/env bash
# `make pi-reset CONFIRM=<address>` (SOMET-430): put the board's database back
# to a fresh, seeded world, so a broken playtest can be discarded rather than
# nursed.
#
# This is the most destructive command in the project, and the guard is built
# to be structural rather than careful:
#
#   * CONFIRM must equal ORANGEPI_ADDRESS exactly. Not "a confirmation" -- the
#     ADDRESS, so the thing you type is the thing you are about to wipe. A
#     yes/no prompt is answered by reflex; an address is not.
#   * every command runs through pi_ssh. There is no code path in this file
#     that can reach a local docker or a local psql, whatever CONFIRM says, so
#     pointing it at the development database is not a matter of care.
#
# A reviewer on this project has previously run DELETE FROM entity_types
# against the SHARED development database while testing a seeder, and wiped
# the catalog. That is the accident this shape is designed to make impossible
# rather than unlikely.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env

CONFIRM="${CONFIRM:-}"
SPEC="${SPEC:-}"

if [ -z "$CONFIRM" ]; then
  cat >&2 <<MSG
${C_RED}refusing to reset: CONFIRM is not set.${C_OFF}

this DROPS the board's database -- every account, character, world and item on
${ORANGEPI_ADDRESS} -- and re-seeds it from the map specs.

to go ahead, name the board you mean:

    make pi-reset CONFIRM=${ORANGEPI_ADDRESS}
MSG
  exit 2
fi

if [ "$CONFIRM" != "$ORANGEPI_ADDRESS" ]; then
  cat >&2 <<MSG
${C_RED}refusing to reset: CONFIRM does not match the configured board.${C_OFF}

  CONFIRM            $CONFIRM
  ORANGEPI_ADDRESS   $ORANGEPI_ADDRESS

nothing was touched. if you meant a different board, change ORANGEPI_ADDRESS
in .env -- this script only ever acts on the configured one.
MSG
  exit 2
fi

printf '%sresetting the database on %s@%s%s\n\n' "$C_BOLD" "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS" "$C_OFF"

REMOTE_SH="$(dirname "${BASH_SOURCE[0]}")/remote.sh"

# Stop the backend first. The authority holds live worlds in memory and
# flushes them to Postgres periodically, so a reset underneath a running
# backend races: the wipe succeeds, then a flush writes the old world back and
# the reset appears not to have worked.
run_step "stop the backend" bash "$REMOTE_SH" compose stop backend

drop_and_recreate() {
  # DROP SCHEMA rather than DROP DATABASE: `docker compose exec db` connects
  # to game_db, and Postgres will not drop a database that has an open
  # connection to it. The schema is the whole of the application's state.
  bash "$REMOTE_SH" compose exec -T db psql -U user -d game_db \
    -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;"
}
run_step "drop and recreate the schema" drop_and_recreate

# Migrations run against the empty schema with the backend still stopped, as a
# one-off container -- the same shape a deploy uses.
run_step "run migrations" bash "$REMOTE_SH" compose run --rm --no-deps backend npm run migrate:up
run_step "seed the catalogs" bash "$REMOTE_SH" compose run --rm --no-deps backend node scripts/seed-catalogs.js

if [ -n "$SPEC" ]; then
  run_step "seed the map: $SPEC" bash "$REMOTE_SH" compose run --rm --no-deps backend sh -c "SPEC=$SPEC node scripts/seed-map.js"
fi

run_step "start the backend" bash "$REMOTE_SH" compose up -d

# Exit code alone would report success for a stack that came back up with an
# empty world and no entry map -- which is precisely the state this command is
# most likely to leave behind if a seed step half-worked.
verify_playable() {
  bash "$REMOTE_SH" compose exec -T db psql -U user -d game_db -tA -c \
    "SELECT count(*) FILTER (WHERE is_entry), count(*) FROM worlds;" \
    | awk -F'|' '{
        if ($1 + 0 < 1) { print "no entry world exists after the reset -- the board is not playable"; exit 1 }
        printf "%s world(s) seeded, %s of them the entry world\n", $2, $1
      }'
}
run_step "verify a playable, seeded world exists" verify_playable

finish "pi-reset"

cat <<MSG

the board is back to a fresh world. every account on it is gone, including
admin -- recreate one by registering through the public URL.
MSG
