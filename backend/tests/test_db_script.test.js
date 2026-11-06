// scripts/testdb.js builds and DROPS a database. The one thing that must never happen is
// that it drops the wrong one, so the safety rules are pinned here (they are pure: no
// connection is made).
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDatabase, databaseName, resolveTestTarget, splitSuite, DEFAULT_NAME, SEEDS } = require('../scripts/testdb.js');

const DEV = 'postgres://user:p%40ss@db:5432/game_db';

test('the test database lives on the same server under its own name', () => {
  const t = resolveTestTarget({ DATABASE_URL: DEV });
  assert.equal(t.name, DEFAULT_NAME);
  assert.equal(t.name, 'game_test');
  assert.equal(databaseName(t.url), 'game_test');
  assert.equal(databaseName(t.adminUrl), 'postgres', 'it connects to the maintenance database to create and drop');
  assert.equal(new URL(t.url).host, 'db:5432');
  assert.equal(new URL(t.url).username, 'user');
  assert.equal(decodeURIComponent(new URL(t.url).password), 'p@ss', 'credentials survive');
});

test('it refuses to touch the database DATABASE_URL points at', () => {
  assert.match(resolveTestTarget({ DATABASE_URL: DEV, TEST_DB_NAME: 'game_db' }).error.message, /must contain "test"/);
  // even a name that contains "test" is refused when it IS the configured database
  const t = resolveTestTarget({ DATABASE_URL: 'postgres://u:p@h:5432/my_test_db', TEST_DB_NAME: 'my_test_db' });
  assert.match(t.error.message, /points at/);
});

test('it refuses a name that is not clearly a test database', () => {
  for (const name of ['production', 'game', 'postgres', 'template1', 'testless_no']) {
    if (/test/i.test(name)) continue;
    assert.ok(resolveTestTarget({ DATABASE_URL: DEV, TEST_DB_NAME: name }).error, name);
  }
  assert.ok(resolveTestTarget({ DATABASE_URL: DEV, TEST_DB_NAME: 'game_db_test' }).name);
});

test('it refuses names that could break out of the quoted identifier', () => {
  for (const name of ['x"; DROP DATABASE game_db; --test', 'a test', 'game-test', 'game_test;', "t'est", '../test']) {
    assert.ok(resolveTestTarget({ DATABASE_URL: DEV, TEST_DB_NAME: name }).error, name);
  }
});

test('without DATABASE_URL there is nothing to derive from', () => {
  assert.match(resolveTestTarget({}).error.message, /DATABASE_URL is not set/);
});

test('withDatabase only swaps the database name', () => {
  assert.equal(withDatabase('postgres://u:p@h:5432/a?sslmode=disable', 'b'), 'postgres://u:p@h:5432/b?sslmode=disable');
});

test('the seeds are the database-only half of make seed-all, catalogs first', () => {
  assert.deepEqual(SEEDS.map((s) => s[0]), ['seed-catalogs', 'seed-passive-tree', 'seed-quests', 'seed-map p5-descent', 'seed-map']);
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [, [script]] of SEEDS) assert.ok(fs.existsSync(path.join(__dirname, '..', script)), script);
});

// `node --test` runs every file named test-*.js / *-test.js it finds, ANYWHERE (not just
// in tests/). The first version of this script was called test-db.js, so the suite ran
// it as a test, and it dropped and rebuilt the database in the middle of the run. The
// name is therefore load-bearing.
test('the seed sync files are split out, and no file is dropped by the split', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = fs.readdirSync(path.join(__dirname)).filter((f) => f.endsWith('.test.js')).sort();
  const { shared, isolated } = splitSuite(files);
  assert.deepEqual([...shared, ...isolated].sort(), files);
  for (const f of ['seed_sync_apply_db.test.js', 'seed_sync_groups_roundtrip_db.test.js', 'seed_export_routes_db.test.js']) {
    assert.ok(isolated.includes(f), `${f} must not share a database with the catalog writers`);
  }
  assert.ok(isolated.includes('board_seed_scope_db.test.js'), 'it fingerprints whole player tables');
  assert.ok(isolated.includes('map_spec_export_db.test.js'), 'it holds the entry lock past what peers wait');
  assert.ok(isolated.includes('backfill_visited_worlds.test.js'), 'it runs a statement over a whole table');
  assert.ok(isolated.includes('village_reposition_db.test.js'), 'it counts stock built from every item type');
  assert.ok(isolated.includes('audio_catalog_db.test.js'), 'it asserts on who is the active provider');
  assert.ok(isolated.includes('describe_subjects_db.test.js'), 'its cleanup deletes every newer row in a shared table');
  assert.ok(isolated.includes('seed_map_db.test.js'), 'one spec takes past its budget beside peers on a loaded host');
  // The prefix is narrower than "seed_": these are ordinary tests of other things.
  for (const f of ['seed_catalogs_db.test.js', 'test_db_script.test.js']) {
    assert.ok(shared.includes(f), f);
  }
});

test('no script outside tests/ has a name node --test would run as a test', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runnable = /^(test-.+|.+[.\-_]test|test)$/;
  for (const dir of ['scripts', 'src']) {
    const stack = [path.join(__dirname, '..', dir)];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { stack.push(path.join(d, e.name)); continue; }
        if (!/\.(c|m)?js$/.test(e.name)) continue;
        const base = e.name.replace(/\.(c|m)?js$/, '');
        assert.ok(!runnable.test(base), `${path.join(dir, e.name)} would be executed by node --test`);
      }
    }
  }
});
