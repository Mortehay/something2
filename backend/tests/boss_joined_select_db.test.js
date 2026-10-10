// backend/tests/boss_joined_select_db.test.js
// SOMET-603: the live per-chunk/per-id SELECT must carry the boss columns, or
// a boss-typed world_creatures row loads as an ordinary 48px creature with
// nothing failing. Read back through the EXACT CREATURE_JOINED_SELECT text,
// inside a transaction that is always rolled back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { CREATURE_JOINED_SELECT } = require('../src/authority/server.js');
const { CreatureSim, hydrateCreatureRow } = require('../src/authority/creatures.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

test('a boss-typed world_creatures row loads with its catalog hitbox, tier and element', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('zzBossJoinedSelect', 1) RETURNING id`);
    const ins = await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1, 'Ignis, the Magma Colossus', 500, 500, 12000, 'S', 100, 17, 25) RETURNING id`,
      [w.rows[0].id]);
    const q = await client.query(`${CREATURE_JOINED_SELECT} WHERE wc.id = $1`, [ins.rows[0].id]);
    assert.equal(q.rowCount, 1, 'precondition: the joined SELECT found the fixture row');
    // wc.damage (17) deliberately differs from Ignis's base_damage (42): the
    // persisted, level-scaled instance damage must survive hydration. If the
    // joined SELECT ever carried et.base_damage, hydrateCreatureRow would
    // replace 17 with 42 for every persisted boss instance.
    assert.equal('base_damage' in q.rows[0], false,
      'CREATURE_JOINED_SELECT must not select et.base_damage');

    const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
    sim.addCreatures(q.rows.map((r) => hydrateCreatureRow(r)));
    const c = sim.get(ins.rows[0].id);
    assert.equal(c.bossTier, 'world');
    assert.equal(c.element, 'fire');
    assert.equal(c.width, 96);
    assert.equal(c.height, 96);
    assert.equal(c.damage, 17, 'the persisted wc.damage survives, not the catalog base_damage');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
