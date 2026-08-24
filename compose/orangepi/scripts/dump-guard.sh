#!/usr/bin/env bash
# SOMET-485. The "is this actually a database dump?" check, in ONE place.
#
# Sourced, never executed, and deliberately free of side effects: restore.sh
# needs it BEFORE it decides which mode it is in, and must not pick up lib.sh's
# .env loading on the way (a DATABASE_URL arriving from .env would let a
# --into-local typo aim at the dev database, which is exactly what restore.sh's
# `${DATABASE_URL:?}` exists to prevent).
#
# WHY THIS IS NOT `gzip -dc "$f" | head -c N | grep -q 'CREATE TABLE'`.
#
# That is what backup.sh and restore.sh both used to run, under
# `set -o pipefail`. `grep -q` exits at its FIRST match and closes its side of
# the pipe; `head` is done too; `gzip` is still decompressing, takes SIGPIPE
# and exits 141; pipefail promotes that 141 to the pipeline's status. So a
# perfectly good dump was reported as "contains no CREATE TABLE" and the
# restore was refused -- reproducibly, 100 runs out of 100, on a 900 kB dump.
#
# The failure is size-dependent in the worst possible direction. A toy dump
# fits in the pipe buffer, gzip finishes before grep matches, and everything
# looks fine; a dump with real data in it is still streaming when grep quits,
# so the check fails precisely on the backups you would need in a recovery.
#
# THE SHAPE OF THE FIX. The head is read into a variable and matched in the
# shell, with the decompressor in a process substitution rather than a
# pipeline. Nothing downstream can close a pipe it is not a member of, and a
# process substitution's exit status never reaches pipefail, so the SIGPIPE
# window is gone by construction. The alternatives -- reading PIPESTATUS, or
# tolerating 141 "from the producer only" -- both keep the racy pipeline and
# then argue about which failures to forgive; a guard on a disaster-recovery
# path should not have a list of exit codes it ignores. The check itself is
# unchanged: no CREATE TABLE in the first 200 kB is still a refusal.

# How much of the decompressed dump to look at. pg_dump emits the schema
# before the data, so the first CREATE TABLE is near the top of any real dump;
# reading further would only slow the check down.
DUMP_GUARD_HEAD_BYTES="${DUMP_GUARD_HEAD_BYTES:-200000}"

# The first DUMP_GUARD_HEAD_BYTES bytes of the decompressed dump, on stdout.
# NULs are stripped because a valid gzip of NON-text (one of the shapes this
# guard is here to reject) would otherwise make bash write
# "ignored null byte in input" to stderr on its way to the correct answer.
dump_head() {
  head -c "$DUMP_GUARD_HEAD_BYTES" < <(gzip -dc "$1" 2>/dev/null) | tr -d '\000'
}

# 0 if the dump looks like a schema-carrying pg_dump, non-zero otherwise.
dump_has_create_table() {
  case "$(dump_head "$1")" in
    *'CREATE TABLE'*) return 0 ;;
    *) return 1 ;;
  esac
}
