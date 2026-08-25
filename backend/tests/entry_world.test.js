const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { setEntryWorld, setEntryWorldByName } = require('../src/services/entryWorld.js');
const { withAdvisoryLock } = require('./helpers/advisoryLock.js');
const { ENTRY_LOCK_KEY } = require('./helpers/entryWorld.js');

// The single writer for worlds.is_entry (SOMET-265). The dev database has lost
// its entry world at least twice, and the loss is nearly invisible:
// pickEntryWorld returns null, autoJoinTarget returns null, and a player with
// no last world sits on the world list with nothing explaining why.

test('the update is ONE statement, and a no-op for an unknown target', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  await setEntryWorld(db, 'w1');

  assert.equal(calls.length, 1,
    'two statements reintroduce the window where nothing is the entry world');
  const { sql } = calls[0];
  // The clear and the set are the same assignment, not two.
  assert.match(sql, /SET is_entry = \(id = \$1\)/);
  // Without the EXISTS, an id that does not resolve matches only the
  // `is_entry = true` rows and sets every one of them false -- the exact loss
  // this module exists to prevent, achieved with no error raised.
  assert.match(sql, /EXISTS\s*\(\s*SELECT 1 FROM worlds/i,
    'an unknown id must change nothing rather than clearing the current entry');
  assert.doesNotMatch(sql, /is_entry = false/,
    'a bare "set everything false" is the shape being removed');
});

test('the by-name helper never issues an UPDATE for an unknown name', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push(sql);
      if (/SELECT id FROM worlds WHERE name/i.test(sql)) return { rows: [] };
      return { rowCount: 1 };
    },
  };
  assert.equal(await setEntryWorldByName(db, 'nope'), 0);
  assert.equal(calls.filter((s) => /UPDATE/i.test(s)).length, 0,
    'resolving to nothing must not touch is_entry at all');
});

// Source guards: the three call sites that used to hold their own copy of the
// clear-then-set idiom. Two of them were outright wrong, so the absence of the
// old shape is worth pinning rather than trusting.
test('no caller keeps its own clear-then-set pair', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  for (const f of ['src/index.js', 'scripts/seed-map.js', 'scripts/dungeon/restore-entry.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /UPDATE worlds SET is_entry = false WHERE is_entry = true/,
      `${f} still clears every entry world as its own statement`);
    assert.match(src, /setEntryWorld(ByName)?\(/, `${f} must go through the shared writer`);
  }
});

// The guard above scans three files under src/ and scripts/ -- and every
// instance of this bug that actually reached the dev database lived in
// tests/, which it never looked at. FOUR copies of withEntryPreserved existed
// while the shared helper's own comment said there were two; the two it missed
// (seed_map_portals, chests_integration_db) still carried the destructive
// COALESCE restore and wiped is_entry for weeks after the "fix".
//
// So this scans the whole test suite. Two things are banned outright:
//   1. the COALESCE clear-and-maybe-set restore, in any file
//   2. a local `function withEntryPreserved` -- the helper takes an advisory
//      lock, and a private copy silently opts out of the serialisation for
//      every OTHER file too, not just its own
test('no test file keeps its own entry-world save/restore', () => {
  const dir = __dirname;
  const offenders = { coalesce: [], localCopy: [] };
  const walk = (d) => {
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) { walk(p); continue; }
      if (!name.name.endsWith('.js')) continue;
      // The one legitimate definition.
      if (p === path.join(dir, 'helpers', 'entryWorld.js')) continue;
      // Comments stripped FIRST. Both bans are things worth explaining in
      // prose right where they were removed, and the first version of this
      // guard flagged its own explanatory comments -- a check that fires on
      // documentation is one someone eventually deletes instead of obeying.
      const src = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/is_entry\s*=\s*COALESCE\s*\(/i.test(src)) offenders.coalesce.push(name.name);
      // A definition, not a call: `require`ing the shared helper is the point.
      if (/(async\s+)?function\s+withEntryPreserved\s*\(/.test(src)) offenders.localCopy.push(name.name);
    }
  };
  walk(dir);

  assert.deepEqual(offenders.coalesce, [],
    'these files restore is_entry with the COALESCE form, which clears every row and sets none when the snapshot was null');
  assert.deepEqual(offenders.localCopy, [],
    'these files define their own withEntryPreserved instead of requiring tests/helpers/entryWorld.js, which bypasses its advisory lock');
});

// SOMET-505, the READER half of the same shared flag. Six live-join suites each
// picked their target world with
//
//     SELECT id FROM worlds WHERE is_entry = true LIMIT 1
//
// which names whichever world is holding the flag at that instant -- routinely a
// peer's throwaway fixture, which the peer then DELETES. Measured on a scratch
// database: class_pools_db.test.js snapshotted `zz Chest Integration World` and
// the row was gone 572ms later, failing all seven of its subtests with
// `unknown world`, in two of four traced full-suite runs.
//
// Banned by SOURCE TEXT rather than left to the six files to remember, for the
// same reason the two bans above are: this idiom spread by being copied, the
// copies all looked correct, and every one of them was a coin flip. The
// replacement is entryWorldForJoin() in tests/helpers/entryWorld.js.
//
// Narrow on purpose. `WHERE is_entry` on its own is legitimate -- this file,
// seed_map_db and villageScreenBudget_db all read it to assert ON the flag. It
// is `... = true LIMIT 1`, the "give me any entry world to use as a handle"
// spelling, that is always wrong in a concurrently-running test.
test('no test file picks a world to join out of the is_entry flag', () => {
  const dir = __dirname;
  const offenders = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) { walk(p); continue; }
      if (!name.name.endsWith('.js')) continue;
      // Comments stripped first: this ban is worth explaining in prose at the
      // call sites it was removed from, and a guard that fires on its own
      // documentation gets deleted rather than obeyed.
      const src = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/FROM worlds\s+WHERE is_entry\s*=\s*true\s+LIMIT 1/i.test(src)) {
        offenders.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);

  assert.deepEqual(offenders, [],
    'these files resolve a world through worlds.is_entry, which peer test files '
    + 'borrow onto throwaway worlds and then delete -- use entryWorldForJoin() '
    + 'from tests/helpers/entryWorld.js instead (SOMET-505)');
});

const url = process.env.TEST_DATABASE_URL;

test('against the live database', { skip: !url ? 'no TEST_DATABASE_URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `zzEntry-${process.pid}`;
  // One after-hook: cleanup, THEN pool.end(). Registered as a pair because two
  // separate t.after hooks run in registration order and the pool closes out
  // from under the deletes -- that shape leaked fixtures into this very
  // database once already.
  t.after(async () => {
    try {
      await pool.query('DELETE FROM worlds WHERE name LIKE $1', [`${tag}-%`]);
    } catch (e) {
      console.error('entry_world cleanup failed -- fixtures left behind:', e.message);
    } finally {
      await pool.end();
    }
  });

  // SOMET-275: this test moves worlds.is_entry off the real entry world and
  // back, live, exactly like withEntryPreserved's own save/restore does --
  // but until now it did that WITHOUT taking withEntryPreserved's advisory
  // lock. Every applyMapSpec-based test in the suite (seed_map_db.test.js,
  // seed_map_portals.test.js, chests_integration_db.test.js, ...) wraps its
  // own is_entry save/restore in that lock specifically so no other file can
  // observe or clobber is_entry mid-window -- but "no other file" was never
  // true, because THIS file's live-database test was never converted to take
  // it. node --test runs files in parallel, so this test's window (real
  // entry world OFF, `a` ON, for however long the 'moving the entry world'
  // subtest takes to round-trip two queries) could and did interleave with
  // e.g. seed_map_db.test.js's "applying a spec twice produces identical
  // rows", which snapshots is_entry expecting to see either the real entry
  // world or its own zzTestAlpha -- landing on `a` mid-window (or restoring
  // to `a` after this test's own cleanup already deleted it) instead
  // reproduced that test's flake. Wrapping this test's whole is_entry-moving
  // section in the SAME ENTRY_LOCK_KEY closes the gap: it is now mutually
  // exclusive with every other file's window, the same as they already are
  // with each other.
  await withAdvisoryLock(pool, ENTRY_LOCK_KEY, async () => {
    const realEntry = (await pool.query('SELECT id, name FROM worlds WHERE is_entry')).rows[0];
    assert.ok(realEntry, 'precondition: the database must have an entry world for this test to protect');

    const a = (await pool.query(
      'INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING id', [`${tag}-a`])).rows[0].id;

    await t.test('an unknown id leaves the current entry world alone', async () => {
      // THE regression. The old code cleared first and asked questions later, so
      // a bad id was a guaranteed silent loss.
      const changed = await setEntryWorld(pool, '00000000-0000-0000-0000-000000000000');
      assert.equal(changed, 0);
      const after = await pool.query('SELECT id FROM worlds WHERE is_entry');
      assert.deepEqual(after.rows.map((r) => r.id), [realEntry.id],
        'the entry world must survive a write aimed at a world that does not exist');
    });

    await t.test('an unknown NAME leaves the current entry world alone', async () => {
      assert.equal(await setEntryWorldByName(pool, `${tag}-does-not-exist`), 0);
      const after = await pool.query('SELECT id FROM worlds WHERE is_entry');
      assert.deepEqual(after.rows.map((r) => r.id), [realEntry.id]);
    });

    await t.test('moving the entry world leaves exactly one, then restores', async () => {
      await setEntryWorld(pool, a);
      const moved = await pool.query('SELECT id FROM worlds WHERE is_entry');
      assert.deepEqual(moved.rows.map((r) => r.id), [a], 'exactly one, and it is the new one');

      // Put it back through the same helper, which is also the real recovery path
      // (scripts/dungeon/restore-entry.js).
      assert.equal(await setEntryWorldByName(pool, realEntry.name), 2,
        'two rows change: the old entry off, the real one back on');
      const back = await pool.query('SELECT id FROM worlds WHERE is_entry');
      assert.deepEqual(back.rows.map((r) => r.id), [realEntry.id]);
    });

    await t.test('the live database has exactly one entry world', async () => {
      // Detection, not prevention: nothing stops an admin deliberately unsetting
      // the last one, and the cause of the two observed losses is still unknown.
      // A suite run that ends with zero should say so loudly instead of leaving
      // auto-join quietly dead.
      const r = await pool.query('SELECT name FROM worlds WHERE is_entry');
      assert.equal(r.rows.length, 1,
        `expected exactly one entry world, found ${r.rows.length} -- `
        + 'auto-join is dead for every player with no last world when this is 0. '
        + 'Recover with: node scripts/dungeon/restore-entry.js "Old Trailhead"');
    });
  });
});
