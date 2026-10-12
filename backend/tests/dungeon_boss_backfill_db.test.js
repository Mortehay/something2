// SOMET-609 (S9, final review I-1). Runs migration 1714440702000's real up
// SQL against the live schema inside a transaction that is ALWAYS rolled
// back: with the six p5 worlds' dungeon_boss NULLed, up sets all six to the
// frozen literals; a world an admin already edited (non-NULL) is left alone.
// Needs the p5-descent worlds seeded on TEST_DATABASE_URL (scratch DB).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const migration = require('../migrations/1714440702000_backfill_worlds_dungeon_boss.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

function sqlOf(fn) {
  const out = [];
  fn({ sql: (s) => out.push(s) });
  return out;
}

test('backfill up sets dungeon_boss on all six p5 worlds and keeps an admin-edited value', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const names = migration.DUNGEON_BOSSES.map((b) => b.world);
    assert.equal(names.length, 6, 'migration names six worlds');
    const present = await client.query('SELECT name FROM worlds WHERE name = ANY($1::text[])', [names]);
    assert.equal(present.rows.length, 6, 'scratch DB must have the six p5 worlds seeded (make seed-map SPEC=p5-descent)');

    await client.query('UPDATE worlds SET dungeon_boss = NULL WHERE name = ANY($1::text[])', [names]);
    const edited = { entity: 'Ossuary Warden', x: 100, y: 200, respawn_s: 42 };
    const editedWorld = names[0];
    await client.query('UPDATE worlds SET dungeon_boss = $2::jsonb WHERE name = $1', [editedWorld, JSON.stringify(edited)]);

    const stmts = sqlOf(migration.up);
    assert.ok(stmts.length > 0, 'up must emit SQL');
    for (const s of stmts) await client.query(s);

    const rows = (await client.query('SELECT name, dungeon_boss FROM worlds WHERE name = ANY($1::text[])', [names])).rows;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.dungeon_boss]));
    for (const { world, boss } of migration.DUNGEON_BOSSES) {
      if (world === editedWorld) assert.deepEqual(byName[world], edited, `${world}: admin edit must survive`);
      else assert.deepEqual(byName[world], boss, `${world}: backfilled`);
    }

    // down only clears values equal to its own literal: the admin edit stays.
    for (const s of sqlOf(migration.down)) await client.query(s);
    const after = (await client.query('SELECT name, dungeon_boss FROM worlds WHERE name = ANY($1::text[])', [names])).rows;
    for (const r of after) {
      if (r.name === editedWorld) assert.deepEqual(r.dungeon_boss, edited, 'down must not clear an admin edit');
      else assert.equal(r.dungeon_boss, null, `${r.name}: down clears its own literal`);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
