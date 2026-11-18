// SOMET-780: worlds.clear_points follows the world's vault chest and
// waypoints through triggers -- every write path, no caller bookkeeping.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

async function withTxn(t, fn) {
  if (!process.env.TEST_DATABASE_URL) {
    if (process.env.CI) assert.fail('TEST_DATABASE_URL not set');
    t.skip('TEST_DATABASE_URL not set -- skipping to avoid mutating a real database');
    return;
  }
  const p = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const c = await p.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); await p.end(); }
}
const points = async (c, id) => (await c.query('SELECT clear_points, xmin::text AS v FROM worlds WHERE id = $1', [id])).rows[0];

test('vault chests and waypoints land in clear_points; moves, deletes and timed chests are handled; state changes never touch the world row', async (t) => {
  await withTxn(t, async (c) => {
    const { rows: [w] } = await c.query(
      `INSERT INTO worlds (name, seed, chunk_size, width, height) VALUES ('zzClearPts', 5, 64, 64, 64) RETURNING id`);
    assert.deepEqual((await points(c, w.id)).clear_points, []);
    const { rows: [g] } = await c.query('SELECT id FROM entity_types WHERE is_creature = true ORDER BY id LIMIT 1');
    const { rows: [ch] } = await c.query(
      `INSERT INTO world_chests (world_id, x, y, kind, state, guard_entity_type_id, guard_level, guard_creature_ids) VALUES ($1, 550, 750, 'vault', 'locked', $2, 1, '[]'::jsonb) RETURNING id`, [w.id, g.id]);
    assert.deepEqual((await points(c, w.id)).clear_points, [{ row: 7, col: 5 }]);

    await c.query('INSERT INTO waypoints (world_id, x, y, name) VALUES ($1, 3050, 1050, $2)', [w.id, 'zzStone']);
    assert.deepEqual((await points(c, w.id)).clear_points, [{ row: 7, col: 5 }, { row: 10, col: 30 }]);

    // a field chest and a timed (boss-death) vault chest are not authored points
    await c.query(`INSERT INTO world_chests (world_id, x, y, kind, state, guard_entity_type_id, guard_level, guard_creature_ids) VALUES ($1, 950, 950, 'field', 'locked', $2, 1, '[]'::jsonb)`, [w.id, g.id]);
    await c.query(`INSERT INTO world_chests (world_id, x, y, kind, state, expires_at, guard_entity_type_id, guard_level, guard_creature_ids) VALUES ($1, 1950, 1950, 'vault', 'locked', now() + interval '1 hour', $2, 1, '[]'::jsonb)`, [w.id, g.id]);
    assert.equal((await points(c, w.id)).clear_points.length, 2);

    // opening / relocking does not rewrite the world row
    const v0 = (await points(c, w.id)).v;
    await c.query(`UPDATE world_chests SET state = 'opened', opened_at = now() WHERE id = $1`, [ch.id]);
    assert.equal((await points(c, w.id)).v, v0, 'a state change rewrote worlds');

    await c.query('UPDATE world_chests SET x = 1250, y = 250 WHERE id = $1', [ch.id]);
    assert.deepEqual((await points(c, w.id)).clear_points, [{ row: 2, col: 12 }, { row: 10, col: 30 }]);
    await c.query('DELETE FROM waypoints WHERE world_id = $1', [w.id]);
    await c.query('DELETE FROM world_chests WHERE id = $1', [ch.id]);
    assert.deepEqual((await points(c, w.id)).clear_points, []);
  });
});

test('a waypoint re-homed to another world leaves the old list and joins the new one', async (t) => {
  await withTxn(t, async (c) => {
    const mk = async (n) => (await c.query(`INSERT INTO worlds (name, seed, chunk_size, width, height) VALUES ($1, 5, 64, 64, 64) RETURNING id`, [n])).rows[0].id;
    const a = await mk('zzClearA'), b = await mk('zzClearB');
    await c.query('INSERT INTO waypoints (world_id, x, y, name) VALUES ($1, 550, 550, $2)', [a, 'zzMover']);
    assert.deepEqual((await points(c, a)).clear_points, [{ row: 5, col: 5 }]);
    await c.query('UPDATE waypoints SET world_id = $1, x = 1550 WHERE name = $2', [b, 'zzMover']);
    assert.deepEqual((await points(c, a)).clear_points, []);
    assert.deepEqual((await points(c, b)).clear_points, [{ row: 5, col: 15 }]);
  });
});

