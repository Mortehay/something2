#!/usr/bin/env node
// A throwaway, freshly-migrated database for the test suite.
//
// WHY. The database tests run against whatever DATABASE_URL points at -- in development
// that is the live dev database. That is convenient and it is also the problem:
//   * a green run proves nothing about a CLEAN install (the dev database has accreted
//     rows and hand-applied schema over months; a migration that only works on top of
//     that state passes here and fails on a new machine);
//   * a failing migration ledger on the dev database (two branches, one shared
//     database) makes every test that touches a new column fail for a reason that has
//     nothing to do with the code;
//   * every test is one forgotten cleanup away from leaving rows in the shared game.
// This builds `game_test` from nothing -- every migration, in order -- runs the suite
// against it, and drops it.
//
// USAGE
//   node scripts/testdb.js run [--keep] [--no-seed] [-- <node --test args / files>]
//        recreate game_test, migrate it, seed it, run the tests against it, drop it
//        (unless --keep). With no files named, the files that cannot share a database
//        run afterwards on a copy, game_test_sync (see splitSuite)
//   node scripts/testdb.js reset      recreate, migrate and seed game_test, leave it in place
//   node scripts/testdb.js drop       drop game_test
//   node scripts/testdb.js url        print the connection string (for a manual psql)
//
// SAFETY. It only ever touches a database whose name contains "test" and differs from
// the one DATABASE_URL names; anything else is refused before a connection is made, so
// a typo in TEST_DB_NAME cannot drop game_db.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_NAME = 'game_test';

// One file's limit, there to catch a hang. Sized to a loaded machine: board_shutdown_db and
// board_maps_scope_db each build a whole private database (82 s and 129 s idle) and
// orangepi_scripts takes 235 s idle. All were killed at 420 s while still making progress,
// and a killed file takes every test it has left with it (SOMET-744).
const FILE_TIMEOUT_MS = 900000;

// Same server, different database. Pure, so the safety rules are testable.
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

// The database this script is allowed to create and destroy, or an Error saying why not.
function resolveTestTarget(env = process.env) {
  const base = env.DATABASE_URL;
  if (!base) return { error: new Error('DATABASE_URL is not set -- nothing to derive the test database from') };
  const name = env.TEST_DB_NAME || DEFAULT_NAME;
  if (!/^[a-z0-9_]+$/i.test(name)) return { error: new Error(`refusing database name "${name}": use letters, digits and underscores only`) };
  if (!/test/i.test(name)) return { error: new Error(`refusing database name "${name}": a test database's name must contain "test"`) };
  if (name === databaseName(base)) return { error: new Error(`refusing "${name}": it is the database DATABASE_URL points at`) };
  return { name, url: withDatabase(base, name), adminUrl: withDatabase(base, 'postgres') };
}

async function recreate(target) {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: target.adminUrl, connectionTimeoutMillis: 5000, max: 1 });
  try {
    // FORCE drops stragglers (an earlier run killed mid-test) instead of failing on them.
    await admin.query(`DROP DATABASE IF EXISTS "${target.name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${target.name}"`);
  } finally {
    await admin.end().catch(() => {});
  }
}

// A seeded copy, on the same server, for the files splitSuite isolates.
async function cloneDatabase(source, copy) {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: copy.adminUrl, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${copy.name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${copy.name}" TEMPLATE "${source.name}"`);
  } finally {
    await admin.end().catch(() => {});
  }
}

// Seed sync tests export and apply whole catalog tables. Run beside the other files, every
// write a peer makes to those tables reads as a stale preview or a changed asset, and an
// apply rewrites catalog rows under whichever peer is reading them. A lock cannot fix it:
// the peers are ordinary test files and real routes that have no reason to take one. So
// these run on their own copy of the seeded database. One at a time, because they export
// to the same tables as each other too. board_seed_scope_db belongs here for the mirror
// reason: it fingerprints whole player tables around a seed, so a peer's character or
// progression row reads as the seed having touched player data (SOMET-744).
// map_spec_export_db applies copies of the shipped specs holding the entry lock: 101 s
// idle, past the 90 s every peer waits, so beside them each of their guarded sections
// burned 90 s and whole files hit their timeout. Locks are per database, so here it
// blocks nobody. backfill_visited_worlds runs a migration's statement over all of
// world_players, so a peer deleting its character mid-statement is a foreign key error.
// village_reposition_db counts a village's whole stock, which createVillage builds from
// every item type, peers' fixture rows included. audio_catalog_db asserts one active
// provider per modality, and many peers commit one without its lock.
// describe_subjects_db cleans up with "every art_prompt_descriptions row newer than when I
// started", which beside a peer deletes that peer's rows, and counts the same range to
// prove a dry run wrote nothing (SOMET-744).
const ISOLATED_TEST_FILE = /^(seed_(sync|export)_.+|board_seed_scope_db|map_spec_export_db|backfill_visited_worlds|village_reposition_db|audio_catalog_db|describe_subjects_db)\.test\.js$/;

function splitSuite(files) {
  return {
    shared: files.filter((f) => !ISOLATED_TEST_FILE.test(f)),
    isolated: files.filter((f) => ISOLATED_TEST_FILE.test(f)),
  };
}

async function drop(target) {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: target.adminUrl, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${target.name}" WITH (FORCE)`);
  } finally {
    await admin.end().catch(() => {});
  }
}

// What `make seed-all` loads that lives in the database alone (art and audio go to MinIO,
// which a throwaway database has no use for). Many tests assert against this content --
// the quests, the passive tree, the class and creature catalogs, the shipped map -- so a
// migrated-but-empty database fails them for a reason that has nothing to do with the code.
// Order matters: the catalogs first, everything else refers to them.
const SEEDS = [
  ['seed-catalogs', ['scripts/seed-catalogs.js']],
  ['seed-passive-tree', ['scripts/seed-passive-tree.js']],
  ['seed-quests', ['scripts/seed-quests.js']],
  // vale-region last: seeding p5-descent takes is_entry, the shipped map takes it back.
  ['seed-map p5-descent', ['scripts/seed-map.js'], { SPEC: 'p5-descent' }],
  ['seed-map', ['scripts/seed-map.js'], { SPEC: 'vale-region' }],
];

function seed(target) {
  for (const [label, args, extraEnv = {}] of SEEDS) {
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit', cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: target.url, TEST_DATABASE_URL: target.url, ...extraEnv },
    });
    if (r.status !== 0) throw new Error(`${label} failed on ${target.name} (exit ${r.status})`);
  }
}

function migrate(target) {
  const r = spawnSync(
    process.execPath,
    [require.resolve('node-pg-migrate/bin/node-pg-migrate'), 'up', '--ignore-pattern', '(?!.*\\.js$).*'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: target.url } },
  );
  if (r.status !== 0) throw new Error(`migrations failed on ${target.name} (exit ${r.status}) -- a clean install is broken`);
}

async function main() {
  const [cmd = 'run', ...rest] = process.argv.slice(2);
  const target = resolveTestTarget();
  if (target.error) { console.error(target.error.message); process.exitCode = 2; return; }

  if (cmd === 'url') { console.log(target.url); return; }
  if (cmd === 'drop') { await drop(target); console.log(`dropped ${target.name}`); return; }

  console.log(`==> recreating ${target.name}`);
  await recreate(target);
  console.log(`==> applying every migration to ${target.name}`);
  migrate(target);
  if (!rest.includes('--no-seed')) {
    console.log(`==> seeding ${target.name} (catalogs, passive tree, quests, map)`);
    seed(target);
  }
  if (cmd === 'reset') { console.log(`${target.name} is ready: ${target.url.replace(/:[^:@]*@/, ':***@')}`); return; }
  if (cmd !== 'run') { console.error(`unknown command "${cmd}"`); process.exitCode = 2; return; }

  const keep = rest.includes('--keep');
  const dash = rest.indexOf('--');
  const passthrough = dash >= 0 ? rest.slice(dash + 1) : [];
  const runNode = (db, args) => {
    const r = spawnSync(process.execPath, ['--test', `--test-timeout=${FILE_TIMEOUT_MS}`, ...args], {
      stdio: 'inherit',
      // Both variables: some tests read TEST_DATABASE_URL, the app code reads DATABASE_URL.
      env: { ...process.env, DATABASE_URL: db.url, TEST_DATABASE_URL: db.url, MIGRATE_ON_BOOT: 'false' },
    });
    return r.status === null ? 1 : r.status;
  };

  // Files named on the command line run as asked, on the one database.
  if (passthrough.length) {
    console.log(`==> running the given tests against ${target.name}`);
    const status = runNode(target, passthrough);
    if (!keep) await drop(target).catch((e) => console.error(`could not drop ${target.name}: ${e.message}`));
    process.exitCode = status;
    return;
  }

  const testsDir = path.join(__dirname, '..', 'tests');
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort();
  const { shared, isolated } = splitSuite(files);
  const inTests = (f) => path.join('tests', f);
  // Copied now, while nothing is connected: CREATE DATABASE ... TEMPLATE refuses a source in use.
  const clone = { name: `${target.name}_sync`, url: withDatabase(target.url, `${target.name}_sync`), adminUrl: target.adminUrl };
  await cloneDatabase(target, clone);

  console.log(`==> running ${shared.length} test files against ${target.name}`);
  const sharedStatus = runNode(target, shared.map(inTests));
  console.log(`==> running ${isolated.length} isolated test files, one at a time, against ${clone.name}`);
  const isolatedStatus = runNode(clone, ['--test-concurrency=1', ...isolated.map(inTests)]);
  if (!keep) {
    for (const db of [target, clone]) {
      await drop(db).catch((e) => console.error(`could not drop ${db.name}: ${e.message}`));
    }
  }
  // The suites' own exit codes are the answer -- never the exit code of the cleanup.
  process.exitCode = sharedStatus || isolatedStatus;
}

module.exports = { withDatabase, databaseName, resolveTestTarget, recreate, drop, migrate, seed, splitSuite, DEFAULT_NAME, SEEDS };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
