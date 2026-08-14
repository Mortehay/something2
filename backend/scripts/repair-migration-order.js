#!/usr/bin/env node
// SOMET-336 — repair the `pgmigrations` bookkeeping table when it disagrees
// with the migration files on disk, which is what makes `npm run migrate:up`
// refuse to run at all.
//
// WHAT GOES WRONG, AND WHY IT IS BOOKKEEPING RATHER THAN SCHEMA
// -------------------------------------------------------------------------
// node-pg-migrate reads the run list with
//
//   SELECT name FROM pgmigrations ORDER BY run_on, id
//
// and its checkOrder zips that list POSITIONALLY against the migration files
// sorted by filename, throwing at the first index where the two differ. Its
// error -- "Not run migration X is preceding already run migration Y" --
// assumes the only possible cause is a genuinely unrun migration. There are
// two other causes, and on a long-lived shared development database both are
// common:
//
//   1. OUT-OF-ORDER APPLICATION. Branch B (later timestamp) is applied to the
//      shared database before branch A (earlier timestamp) merges. Both have
//      run, but the recorded order is A-after-B while the filename order is
//      A-before-B, so the positional zip mismatches. Nothing is actually
//      missing.
//
//   2. A RENUMBERED MIGRATION. Two branches pick colliding timestamps and the
//      collision is resolved by renaming one file. The database still records
//      the OLD name, so the new name reads as never-run -- and re-running it
//      is not harmless: a `pgm.createTable` replays as
//      `relation "..." already exists` (42P07) against the table it created
//      the first time.
//
// In both cases the schema is correct and only the ledger is wrong, so the
// repair only ever touches the ledger.
//
// WHAT THIS SCRIPT WILL NOT DO
// -------------------------------------------------------------------------
// It never runs, re-runs or reverts a migration, and never inserts or deletes
// a pgmigrations row -- the set of recorded names coming out is exactly the
// set going in, modulo renames it reports. A migration file that has
// genuinely never run is REPORTED AND LEFT ALONE: that is the case checkOrder
// exists for, and `migrate:up` applying it is the correct outcome, not
// something to be silenced. Likewise a recorded name with no file (a
// migration applied from a branch that has not merged) is reported, never
// deleted -- deleting it would invite a second application of a migration
// whose schema changes are already present.
//
// This is also why `--no-check-order` is not the fix. It would hide case 1 and
// case 2 along with the real thing the check is there to catch.
//
// HONEST COST OF THE REORDER
// -------------------------------------------------------------------------
// The reorder does not invent timestamps: it takes the run_on values and the
// ids ALREADY in the table, sorts each, and assigns the i-th smallest of each
// to the i-th migration by filename. Both multisets come out identical to how
// they went in. What changes is WHICH row carries which timestamp -- so after
// a repair, `run_on` no longer tells you when that particular migration
// actually ran. That fidelity is genuinely lost, which is why every run
// writes a full backup of the table first, and why the default is a dry run.
//
// USAGE
//   node scripts/repair-migration-order.js              # dry run, prints the plan
//   node scripts/repair-migration-order.js --apply      # writes, inside one transaction
//
// Reads DATABASE_URL (or TEST_DATABASE_URL), defaulting to the local dev
// database.

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// The part of a migration name after its leading timestamp. Two names sharing
// a suffix are the SAME migration renumbered -- the only rename this project
// has ever performed, and the only one worth inferring.
function suffixOf(name) {
  const m = /^\d+_(.+)$/.exec(name);
  return m ? m[1] : null;
}

// Pure. Given the recorded rows (in any order) and the migration filenames,
// work out what would have to change. Separated from all I/O so the decision
// logic is testable without a database -- the part that can be wrong in a way
// that matters.
//
// Returns { renames, reorder, unrun, orphans, blocked, ok }:
//   renames  [{ from, to }]  recorded under an old name, present on disk under a new one
//   reorder  [{ name, id, run_on }] the target ledger, in filename order, or []
//            when the order is already correct
//   unrun    names of files that have genuinely never run (left for migrate:up)
//   orphans  recorded names with no file and no rename partner (left alone)
//   blocked  reasons the repair must NOT proceed at all
function planRepair({ recorded, files }) {
  const blocked = [];
  const recordedNames = recorded.map((r) => r.name);

  if (new Set(recordedNames).size !== recordedNames.length) {
    blocked.push('pgmigrations contains duplicate names -- this script will not guess which row is real');
  }

  const fileSet = new Set(files);
  const recordedSet = new Set(recordedNames);
  const recordedOnly = recordedNames.filter((n) => !fileSet.has(n));
  const fileOnly = files.filter((n) => !recordedSet.has(n));

  // Rename detection, deliberately conservative: a suffix must identify
  // EXACTLY ONE unmatched name on each side. Anything else is ambiguous, and
  // guessing here would rewrite the ledger to say a migration ran when it did
  // not.
  const renames = [];
  const bySuffixFile = new Map();
  for (const f of fileOnly) {
    const s = suffixOf(f);
    if (!s) continue;
    if (!bySuffixFile.has(s)) bySuffixFile.set(s, []);
    bySuffixFile.get(s).push(f);
  }
  const matchedFiles = new Set();
  const matchedRecorded = new Set();
  for (const r of recordedOnly) {
    const s = suffixOf(r);
    const candidates = s ? (bySuffixFile.get(s) || []) : [];
    const peers = recordedOnly.filter((o) => suffixOf(o) === s);
    if (candidates.length === 1 && peers.length === 1) {
      renames.push({ from: r, to: candidates[0] });
      matchedFiles.add(candidates[0]);
      matchedRecorded.add(r);
    } else if (candidates.length > 1 || peers.length > 1) {
      blocked.push(`ambiguous rename for suffix "${s}": recorded ${JSON.stringify(peers)} vs files ${JSON.stringify(candidates)}`);
    }
  }

  const unrun = fileOnly.filter((f) => !matchedFiles.has(f));
  const orphans = recordedOnly.filter((r) => !matchedRecorded.has(r));

  // The ledger as it would read after the renames.
  const renameMap = new Map(renames.map(({ from, to }) => [from, to]));
  const afterRename = recorded.map((r) => ({ ...r, name: renameMap.get(r.name) || r.name }));

  // Current order is what node-pg-migrate reads: ORDER BY run_on, id.
  const currentOrder = [...afterRename].sort(
    (a, b) => (a.run_on - b.run_on) || (a.id - b.id),
  ).map((r) => r.name);
  const targetOrder = [...afterRename].map((r) => r.name).sort();

  const alreadyOrdered = currentOrder.every((n, i) => n === targetOrder[i]);

  // Reassign the EXISTING ids and run_on values, each sorted ascending, onto
  // the name-sorted rows. Both multisets are preserved exactly; only which row
  // holds which value changes. Assigning ids as well as run_on matters because
  // run_on has duplicates on a real database (a bulk first run stamps dozens
  // of rows with one timestamp), and id is what breaks those ties.
  //
  // run_on is carried as a {ms, text} PAIR and permuted as a unit. `ms` exists
  // only to sort; `text` is the value actually written back, verbatim as
  // Postgres rendered it. An earlier version reconstructed the timestamp from
  // the epoch millis with to_timestamp(ms/1000), which returns a timestamptz --
  // assigning that to this column (`timestamp WITHOUT time zone`) converts to
  // the server's local zone and shifted every row by the UTC offset, 3 hours
  // on the machine this was written on. Caught by rehearsing on a throwaway
  // copy of the ledger; the multiset assertion below is what makes it stay
  // caught.
  const sortedIds = afterRename.map((r) => r.id).sort((a, b) => a - b);
  const sortedRunOn = afterRename
    .map((r) => ({ ms: r.run_on, text: r.run_on_text }))
    .sort((a, b) => a.ms - b.ms);
  const reorder = alreadyOrdered ? [] : targetOrder.map((name, i) => ({
    name, id: sortedIds[i], run_on: sortedRunOn[i].ms, run_on_text: sortedRunOn[i].text,
  }));

  return {
    renames,
    reorder,
    unrun,
    orphans,
    blocked,
    ok: blocked.length === 0,
    alreadyOrdered,
  };
}

function readMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, '')).sort();
}

async function main() {
  const { Pool } = require('pg');
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL
    || 'postgres://user:password@localhost:15432/game_db';
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    // run_on is read BOTH as a value (to sort by) and as Postgres's own text
    // rendering (to write back untouched). See the note in planRepair: any
    // round-trip through a timestamptz silently shifts this column by the
    // server's UTC offset.
    const recorded = (await pool.query(
      `SELECT id, name, run_on, to_char(run_on, 'YYYY-MM-DD HH24:MI:SS.US') AS run_on_text
         FROM pgmigrations`,
    )).rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      run_on: new Date(r.run_on).getTime(),
      run_on_text: r.run_on_text,
    }));
    const files = readMigrationFiles();

    // Written BEFORE anything is decided, let alone applied: the reorder loses
    // which row carried which timestamp, and this file is the only way back.
    // Kept in a gitignored directory rather than beside the source -- it is a
    // snapshot of one machine's database, never something to commit.
    const backupDir = path.join(__dirname, '..', '.migration-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `pgmigrations.${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(
      (await pool.query('SELECT id, name, run_on FROM pgmigrations ORDER BY id')).rows, null, 2,
    ));

    const plan = planRepair({ recorded, files });
    console.log(`recorded: ${recorded.length}   files: ${files.length}`);
    console.log(`backup:   ${backup}`);

    for (const r of plan.renames) console.log(`RENAME    ${r.from}  ->  ${r.to}`);
    for (const u of plan.unrun) console.log(`UNRUN     ${u}  (left for migrate:up -- this script never applies migrations)`);
    for (const o of plan.orphans) console.log(`ORPHAN    ${o}  (recorded but no file -- applied from an unmerged branch; left alone)`);
    for (const b of plan.blocked) console.log(`BLOCKED   ${b}`);

    if (!plan.ok) {
      console.error('\nRefusing to change anything.');
      process.exitCode = 1;
      return;
    }
    if (plan.alreadyOrdered && plan.renames.length === 0) {
      console.log('\nLedger already agrees with the files -- nothing to do.');
      return;
    }
    console.log(plan.alreadyOrdered
      ? '\nREORDER   not needed'
      : `\nREORDER   ${plan.reorder.length} rows renumbered into filename order`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { from, to } of plan.renames) {
        await client.query('UPDATE pgmigrations SET name = $2 WHERE name = $1', [from, to]);
      }
      if (plan.reorder.length) {
        // Two passes: ids are the primary key, so they are parked in a
        // disjoint negative range before the final values are written.
        // Otherwise assigning an id a sibling row still holds violates the PK
        // mid-statement.
        await client.query('UPDATE pgmigrations SET id = -id');
        for (const row of plan.reorder) {
          await client.query(
            'UPDATE pgmigrations SET id = $2, run_on = $3::timestamp WHERE name = $1',
            [row.name, row.id, row.run_on_text],
          );
        }
        await client.query(
          "SELECT setval('pgmigrations_id_seq', (SELECT max(id) FROM pgmigrations))",
        );
      }
      // Post-condition, inside the transaction so a violation rolls back: the
      // ledger must now read in filename order for the rows that have files.
      const after = (await client.query('SELECT name FROM pgmigrations ORDER BY run_on, id')).rows
        .map((r) => r.name);
      const withFiles = after.filter((n) => files.includes(n));
      const sorted = [...withFiles].sort();
      if (withFiles.some((n, i) => n !== sorted[i])) {
        throw new Error('post-condition failed: ledger is still out of order after the repair');
      }
      if (after.length !== recorded.length) {
        throw new Error(`post-condition failed: row count changed ${recorded.length} -> ${after.length}`);
      }
      // The reorder PERMUTES ids and run_on values; it must never alter one.
      // This is the assertion that would have caught the to_timestamp timezone
      // shift at apply time instead of in a rehearsal, so it is checked against
      // the live table rather than against the plan -- a plan can only be
      // self-consistent, while this compares what Postgres actually stored.
      const bag = (xs) => JSON.stringify([...xs].sort());
      const afterVals = (await client.query(
        `SELECT id, to_char(run_on, 'YYYY-MM-DD HH24:MI:SS.US') AS run_on_text FROM pgmigrations`,
      )).rows;
      if (bag(afterVals.map((r) => Number(r.id))) !== bag(recorded.map((r) => r.id))) {
        throw new Error('post-condition failed: the set of ids changed, it must only be permuted');
      }
      if (bag(afterVals.map((r) => r.run_on_text)) !== bag(recorded.map((r) => r.run_on_text))) {
        throw new Error('post-condition failed: run_on values were altered, they must only be permuted');
      }
      await client.query('COMMIT');
      console.log('\nApplied.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

module.exports = { planRepair, suffixOf, readMigrationFiles };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
