// SOMET-773: ensureStructures against a seeded test database.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { ensureStructures } = require('../src/services/worldStructures');

function requireTestDb(t) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return null;
  }
  return new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
}
const worldNamed = async (pool, sql) => (await pool.query(`SELECT id, name, width, height FROM worlds WHERE ${sql} ORDER BY name LIMIT 1`)).rows[0];
const cells = (s) => { const o = []; for (let r = s.minRow; r < s.minRow + s.height; r++) for (let c = s.minCol; c < s.minCol + s.width; c++) o.push([r, c]); return o; };

test('a second run keeps every ruin, writes nothing and keeps the chunk cache', async (t) => {
  const pool = requireTestDb(t); if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await worldNamed(client, "name = 'Old Trailhead'");
    assert.ok(w, 'Old Trailhead is seeded');
    await ensureStructures(client, w.id);
    const before = (await client.query('SELECT structures FROM worlds WHERE id = $1', [w.id])).rows[0].structures;
    assert.ok(before.length > 0, 'Old Trailhead got ruins');
    await client.query(`INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, 99, 99, '[]') ON CONFLICT DO NOTHING`, [w.id]);
    const r = await ensureStructures(client, w.id);
    assert.equal(r.changed, false);
    assert.equal(r.added, 0);
    assert.equal(r.kept, before.length);
    const chunk = await client.query('SELECT 1 FROM world_chunks WHERE world_id = $1 AND cx = 99 AND cy = 99', [w.id]);
    assert.equal(chunk.rowCount, 1, 'an unchanged world keeps its chunk cache');
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});

test('hub worlds are skipped', async (t) => {
  const pool = requireTestDb(t); if (!pool) return;
  try {
    const hub = await worldNamed(pool, "name LIKE '%: Hub' AND width IS NOT NULL");
    if (!hub) { t.skip('no hub world seeded'); return; }
    const r = await ensureStructures(pool, hub.id);
    assert.equal(r.skipped, true);
  } finally { await pool.end(); }
});

test('a stored ruin the terrain no longer supports is dropped and re-rolled; chunks are cleared', async (t) => {
  const pool = requireTestDb(t); if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await worldNamed(client, "name = 'Old Trailhead'");
    // On the map wall ring: never valid ground.
    const bad = { type: 'overgrown_hut', minRow: 0, minCol: 5, width: 4, height: 3, wallTile: 'mossy_wall', floorTile: 'rubble_floor', gaps: [[0, 6], [2, 7]], source: 'auto' };
    await client.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify([bad]), w.id]);
    await client.query(`INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, 98, 98, '[]') ON CONFLICT DO NOTHING`, [w.id]);
    const r = await ensureStructures(client, w.id);
    assert.equal(r.dropped, 1);
    assert.equal(r.changed, true);
    const after = (await client.query('SELECT structures FROM worlds WHERE id = $1', [w.id])).rows[0].structures;
    assert.ok(!after.some((s) => s.minRow === 0 && s.minCol === 5), 'the invalid ruin is gone');
    const chunk = await client.query('SELECT 1 FROM world_chunks WHERE world_id = $1 AND cx = 98', [w.id]);
    assert.equal(chunk.rowCount, 0, 'a changed world loses its cached chunks');
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});

test('regenerating never puts a ruin over a saved player position', async (t) => {
  const pool = requireTestDb(t); if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await worldNamed(client, "name = 'Old Trailhead'");
    await ensureStructures(client, w.id, { regenerate: true });
    const first = (await client.query('SELECT structures FROM worlds WHERE id = $1', [w.id])).rows[0].structures;
    assert.ok(first.length > 0);
    // Stand a player in the middle of the first ruin, then re-roll.
    const s = first[0];
    const px = (s.minCol + 1) * 100 + 50, py = (s.minRow + 1) * 100 + 50;
    const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'world_players' AND is_nullable = 'NO' AND column_default IS NULL")).rows.map((r) => r.column_name);
    if (cols.some((c) => !['world_id', 'x', 'y', 'character_id'].includes(c))) { t.skip(`world_players needs ${cols}`); return; }
    // Inside the rolled-back transaction: a throwaway user and character.
    const u = (await client.query(`INSERT INTO users (username, password_hash) VALUES ('zz_ruin_probe', 'x') RETURNING id`)).rows[0];
    const et = (await client.query('SELECT id FROM entity_types WHERE is_playable = true ORDER BY id LIMIT 1')).rows[0];
    const ch = (await client.query(`INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, 'zz_ruin_probe', $2) RETURNING id`, [u.id, et.id])).rows[0];
    await client.query('DELETE FROM world_players WHERE character_id = $1', [ch.id]);
    await client.query('INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, $3, $4)', [w.id, ch.id, px, py]);
    await ensureStructures(client, w.id, { regenerate: true });
    const after = (await client.query('SELECT structures FROM worlds WHERE id = $1', [w.id])).rows[0].structures;
    const pr = Math.floor(py / 100), pc = Math.floor(px / 100);
    for (const a of after) for (const [r, c] of cells(a)) assert.ok(Math.max(Math.abs(r - pr), Math.abs(c - pc)) > 2, 'ruin over a saved player');
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});
