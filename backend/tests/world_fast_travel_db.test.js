const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

// worlds.allows_fast_travel gates map-based travel (Plan B slice 1).
//
// The column's DEFAULT is the security property, so it is asserted against the
// live schema rather than inferred from the migration source: 7 creatures carry
// blocks_portal_id to gate dungeon entrances, and a world that became a travel
// target by default would let a character walk past them.

// A seeded column is only really wired if it appears in BOTH halves of the
// upsert. Present in the INSERT but missing from the ON CONFLICT SET is the
// classic half-wiring: it works on a fresh database and silently stops
// updating on every re-seed after that, which is exactly the shape that is
// hardest to notice.
test('seed-map writes the flag on insert AND on conflict', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/seed-map.js'), 'utf8');
  const insert = src.slice(src.indexOf('INSERT INTO worlds'), src.indexOf('RETURNING id'));
  assert.ok(insert.includes('allows_fast_travel'), 'missing from the INSERT column list');
  assert.match(insert, /allows_fast_travel\s*=\s*EXCLUDED\.allows_fast_travel/,
    'missing from the ON CONFLICT SET -- re-seeds would never update it');

  // Strict === true, so an absent or null key seeds false rather than
  // whatever Postgres makes of undefined.
  assert.match(src, /w\.allows_fast_travel === true/,
    'the bound value must be strict, so a missing key is false');
});

const url = process.env.TEST_DATABASE_URL;

test('worlds.allows_fast_travel', { skip: !url ? 'no TEST_DATABASE_URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('is a NOT NULL boolean defaulting to false', async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'worlds' AND column_name = 'allows_fast_travel'`);
    assert.equal(r.rows.length, 1, 'the column must exist');
    assert.equal(r.rows[0].data_type, 'boolean');
    assert.equal(r.rows[0].is_nullable, 'NO');
    assert.match(r.rows[0].column_default, /false/,
      'default must be false -- a world must never become a travel target by omission');
  });

  await t.test('a newly created world is not a travel target', async () => {
    // The property that matters: adding a world later must not silently make
    // it reachable. Created and removed inside this test.
    const name = `zzFastTravel-${process.pid}-${Date.now()}`;
    try {
      const r = await pool.query(
        'INSERT INTO worlds (name, seed) VALUES ($1, 1) RETURNING allows_fast_travel', [name]);
      assert.equal(r.rows[0].allows_fast_travel, false);
    } finally {
      await pool.query('DELETE FROM worlds WHERE name = $1', [name]).catch(() => {});
    }
  });

  await t.test('no existing world was silently flagged by the migration', async () => {
    // The migration deliberately backfills nothing. Classification is authored
    // in the map specs (slice 2), so until that lands the correct count is 0 --
    // and a non-zero count here means something set it outside the specs.
    // Content worlds only. Other files create flagged `zz`-prefixed fixture
    // worlds (join_policy_db.test.js needs one to test the flag at all), and
    // node --test runs files in parallel -- so an unscoped count here reads
    // another test's in-flight fixtures as live content and fails on them.
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM worlds WHERE allows_fast_travel AND name NOT LIKE 'zz%'");
    assert.equal(r.rows[0].n, 0,
      'no world should be a travel target until the specs classify them');
  });
});
