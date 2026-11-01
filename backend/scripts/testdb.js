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
//        (unless --keep)
//   node scripts/testdb.js reset      recreate, migrate and seed game_test, leave it in place
//   node scripts/testdb.js drop       drop game_test
//   node scripts/testdb.js url        print the connection string (for a manual psql)
//
// SAFETY. It only ever touches a database whose name contains "test" and differs from
// the one DATABASE_URL names; anything else is refused before a connection is made, so
// a typo in TEST_DB_NAME cannot drop game_db.

const { spawnSync } = require('node:child_process');

const DEFAULT_NAME = 'game_test';

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
  ['seed-map', ['scripts/seed-map.js'], { SPEC: 'vale-region' }],
];

function seed(target) {
  for (const [label, args, extraEnv = {}] of SEEDS) {
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit', cwd: require('node:path').join(__dirname, '..'),
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
  console.log(`==> running the suite against ${target.name}`);
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=420000', ...passthrough],
    {
      stdio: 'inherit',
      // Both variables: some tests read TEST_DATABASE_URL, the app code reads DATABASE_URL.
      env: { ...process.env, DATABASE_URL: target.url, TEST_DATABASE_URL: target.url, MIGRATE_ON_BOOT: 'false' },
    },
  );
  if (!keep) await drop(target).catch((e) => console.error(`could not drop ${target.name}: ${e.message}`));
  // The suite's own exit code is the answer -- never the exit code of the cleanup.
  process.exitCode = r.status === null ? 1 : r.status;
}

module.exports = { withDatabase, databaseName, resolveTestTarget, DEFAULT_NAME, SEEDS };

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
