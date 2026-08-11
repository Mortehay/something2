const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

// The five hub-vale fast-travel flags that the seeder cannot deliver
// (SOMET-273). See the migration's header for why a migration and not a spec.
const MIGRATION = '1714440164000_flag_hub_vale_fast_travel.js';
const mig = require(`../migrations/${MIGRATION}`);

function emitted(fn) {
  const out = [];
  fn({ sql: (s) => out.push(s), func: (s) => ({ __func: s }) });
  return out.join('\n');
}

// The migration hardcodes its world names so that editing the spec later cannot
// change what an already-applied migration did. That is the right call, and it
// is also exactly how the two lists drift apart -- so the drift is asserted
// rather than trusted. If the spec's classification changes, this fails and
// whoever changed it has to add a NEW migration deliberately.
test('the hardcoded names match the spec that classified them', () => {
  const spec = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../seeds/maps/hub-vale.map.json'), 'utf8'));
  const fromSpec = spec.worlds
    .filter((w) => w.allows_fast_travel === true).map((w) => w.name).sort();
  const src = fs.readFileSync(path.join(__dirname, '../migrations', MIGRATION), 'utf8');
  const fromMigration = [...src.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]).sort();

  assert.ok(fromSpec.length > 0, 'the spec must still classify some worlds, or this test is vacuous');
  assert.deepEqual(fromMigration, fromSpec);
});

test('up flags only the named worlds, and only if not already flagged', () => {
  const sql = emitted(mig.up);
  assert.match(sql, /UPDATE worlds SET allows_fast_travel = true/i);
  assert.match(sql, /WHERE name IN \(/i);
  // Re-running must be a no-op rather than rewriting 5 rows every deploy.
  assert.match(sql, /AND allows_fast_travel = false/i,
    're-running the migration must not touch already-flagged rows');
  // The blast radius is the point: an unscoped UPDATE here would make every
  // world in the game a travel target, including all 56 dungeon rooms.
  assert.doesNotMatch(sql, /UPDATE worlds SET allows_fast_travel = true\s*(;|$)/i);
});

test('down unsets exactly what up set', () => {
  const sql = emitted(mig.down);
  assert.match(sql, /UPDATE worlds SET allows_fast_travel = false/i);
  assert.match(sql, /WHERE name IN \(/i);
  assert.notEqual(emitted(mig.down).trim(), '', 'down must not be a silent no-op');
});

const url = process.env.TEST_DATABASE_URL;

test('against the live database', { skip: !url ? 'no TEST_DATABASE_URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const spec = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../seeds/maps/hub-vale.map.json'), 'utf8'));
  const names = spec.worlds.filter((w) => w.allows_fast_travel === true).map((w) => w.name);

  await t.test('every hub-vale travel target is flagged in the live rows', async () => {
    // The whole point of the migration. Without it these five are the gap
    // between "30 worlds classified" and "25 worlds actually reachable".
    const r = await pool.query(
      'SELECT name FROM worlds WHERE name = ANY($1::text[]) AND NOT allows_fast_travel',
      [names]);
    assert.deepEqual(r.rows.map((x) => x.name), []);
  });

  await t.test('the full classification is live: every spec-flagged world is flagged', async () => {
    // Across ALL specs, not just hub-vale -- this is the end-to-end statement
    // that the classification and the database agree, however each world's
    // flag got there (seeded for three specs, migrated for hub-vale).
    const dir = path.join(__dirname, '../seeds/maps');
    const wanted = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.map.json'))) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const w of s.worlds) if (w.allows_fast_travel === true) wanted.push(w.name);
    }
    const r = await pool.query(
      'SELECT name FROM worlds WHERE name = ANY($1::text[]) AND NOT allows_fast_travel',
      [wanted]);
    assert.deepEqual(r.rows.map((x) => x.name), [],
      'these worlds are classified as travel targets but are not flagged live');
  });
});
