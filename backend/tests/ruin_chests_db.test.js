// SOMET-774: guarded field chests in POI ruins, against a seeded test DB.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { ensureStructures } = require('../src/services/worldStructures');
const { generateRegion } = require('../src/services/mapService');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { loadTileTypes } = require('../src/services/tileTypes');
const { loadBiomes } = require('../src/services/biomes');
const { fetchVillages } = require('../src/services/villages');

function pool(t) {
  if (!process.env.TEST_DATABASE_URL) {
    if (process.env.CI) assert.fail('TEST_DATABASE_URL not set');
    t.skip('TEST_DATABASE_URL not set -- skipping to avoid mutating a real database');
    return null;
  }
  return new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
}
async function withTxn(t, fn) {
  const p = pool(t); if (!p) return;
  const c = await p.connect();
  try { await c.query('BEGIN'); await fn(c); } finally { await c.query('ROLLBACK'); c.release(); await p.end(); }
}
const { keyOf } = require('../src/services/ruinChests');
const ruinChests = (c, id) => c.query(
  'SELECT id, x, y, structure_key, guard_count, guard_creature_ids, state, kind FROM world_chests WHERE world_id = $1 AND structure_key IS NOT NULL ORDER BY structure_key', [id]);
const worldNamed = async (c, n) => (await c.query('SELECT * FROM worlds WHERE name = $1', [n])).rows[0];

test('every POI ruin gets one chest and an anchored pack on walkable ground; a second run changes nothing', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    const chests = (await ruinChests(c, w.id)).rows;
    assert.ok(chests.length > 0, 'Old Trailhead has at least one POI ruin');
    const row = await worldNamed(c, 'Old Trailhead');
    const cfg = buildWorldGenConfig({ row, tileTypes: await loadTileTypes(c), doorways: [], villages: await fetchVillages(c, w.id), biomes: await loadBiomes(c, row.biomes), links: [] });
    const grid = generateRegion(cfg, 0, 0, row.height, row.width);
    for (const ch of chests) {
      assert.equal(ch.kind, 'field');
      assert.equal(ch.state, 'locked');
      assert.ok(ch.guard_count >= 3 && ch.guard_count <= 5, `pack of ${ch.guard_count}`);
      assert.equal(ch.guard_creature_ids.length, ch.guard_count);
      const ruin = row.structures.find((s) => keyOf(s) === ch.structure_key);
      assert.ok(ruin, 'chest belongs to a stored ruin');
      const g = (await c.query('SELECT x, y, home_x, home_y FROM world_creatures WHERE id = ANY($1::uuid[])', [ch.guard_creature_ids])).rows;
      assert.equal(g.length, ch.guard_count);
      for (const cr of g) {
        assert.ok(cr.home_x !== null && cr.home_y !== null, 'guard is anchored (populateWorld spares it)');
        const tile = grid[Math.floor(cr.y / 100)][Math.floor(cr.x / 100)];
        assert.notEqual(cfg.tileTypes[tile] && cfg.tileTypes[tile].walkable, false, `guard on unwalkable ${tile}`);
      }
    }
    const again = await ensureStructures(c, w.id);
    assert.equal(again.chestsAdded, 0);
    assert.equal(again.chestsRemoved, 0);
    assert.deepEqual((await ruinChests(c, w.id)).rows.map((r) => r.id), chests.map((r) => r.id));
  });
});

test('a ruin that goes takes its chest and its living guards with it', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    const [ch] = (await ruinChests(c, w.id)).rows;
    const row = await worldNamed(c, 'Old Trailhead');
    const keep = row.structures.filter((s) => keyOf(s) !== ch.structure_key);
    await c.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify(keep), w.id]);
    const { reconcileRuinChests } = require('../src/services/ruinChests');
    const r = await reconcileRuinChests(c, w.id);
    assert.ok(r.removed >= 1);
    assert.equal((await c.query('SELECT 1 FROM world_chests WHERE id = $1', [ch.id])).rowCount, 0);
    assert.equal((await c.query('SELECT 1 FROM world_creatures WHERE id = ANY($1::uuid[])', [ch.guard_creature_ids])).rowCount, 0);
  });
});

test('no allowed creature the biome also lists means no chest, the ruin stays scenery', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    await c.query(`UPDATE worlds SET allowed_creature_types = '["zz_no_such_creature"]'::jsonb WHERE id = $1`, [w.id]);
    const { reconcileRuinChests } = require('../src/services/ruinChests');
    await c.query('DELETE FROM world_chests WHERE world_id = $1 AND structure_key IS NOT NULL', [w.id]);
    await reconcileRuinChests(c, w.id);
    assert.equal((await ruinChests(c, w.id)).rowCount, 0);
  });
});

test('an opened ruin chest comes back with its whole pack', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    const [ch] = (await ruinChests(c, w.id)).rows;
    await c.query('DELETE FROM world_creatures WHERE id = ANY($1::uuid[])', [ch.guard_creature_ids]);
    await c.query("UPDATE world_chests SET state = 'opened', respawn_at = now() - interval '1 minute' WHERE id = $1", [ch.id]);
    const row = await worldNamed(c, 'Old Trailhead');
    const cfg = buildWorldGenConfig({ row, tileTypes: await loadTileTypes(c), doorways: [], villages: [], biomes: await loadBiomes(c, row.biomes), links: [] });
    const { respawnDueFieldChests } = require('../src/services/chests');
    await respawnDueFieldChests(c, { getWorld: async (id) => (id === w.id ? { ...cfg, id: w.id } : null) });
    const after = (await c.query('SELECT state, guard_creature_ids FROM world_chests WHERE id = $1', [ch.id])).rows[0];
    assert.equal(after.state, 'locked');
    assert.equal(after.guard_creature_ids.length, ch.guard_count, 'the whole pack respawned');
    assert.equal((await c.query('SELECT count(*)::int n FROM world_creatures WHERE id = ANY($1::uuid[]) AND home_x IS NOT NULL', [after.guard_creature_ids])).rows[0].n, ch.guard_count);
  });
});

// Review I1: two reconciles racing for the same ruin must not leave a pack
// with no chest (anchored guards are never cleaned up by anything else).
test('adding a ruin chest twice leaves one chest and one pack, no orphan guards', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    const [ch] = (await ruinChests(c, w.id)).rows;
    const row = await worldNamed(c, 'Old Trailhead');
    const st = row.structures.find((s) => keyOf(s) === ch.structure_key);
    const before = (await c.query('SELECT count(*)::int n FROM world_creatures WHERE world_id = $1', [w.id])).rows[0].n;
    const { addRuinChest } = require('../src/services/ruinChests');
    const r = await addRuinChest(c, row, st, { names: ['Slime'], cells: [{ row: st.minRow + 1, col: st.minCol + 2 }] });
    assert.equal(r, null, 'the loser of the race adds nothing');
    const after = (await c.query('SELECT count(*)::int n FROM world_creatures WHERE world_id = $1', [w.id])).rows[0].n;
    assert.equal(after, before, 'no orphan guards');
  });
});

// Review I2: a different ruin re-rolled at the same corner gets a new chest.
test('a different ruin at the same corner replaces the chest', async (t) => {
  await withTxn(t, async (c) => {
    const w = await worldNamed(c, 'Old Trailhead');
    await ensureStructures(c, w.id);
    const [ch] = (await ruinChests(c, w.id)).rows;
    const row = await worldNamed(c, 'Old Trailhead');
    const next = row.structures.map((s) => (keyOf(s) === ch.structure_key
      ? { ...s, width: s.width === 4 ? 5 : 4, poi: true } : s));
    await c.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify(next), w.id]);
    const { reconcileRuinChests } = require('../src/services/ruinChests');
    await reconcileRuinChests(c, w.id);
    assert.equal((await c.query('SELECT 1 FROM world_chests WHERE id = $1', [ch.id])).rowCount, 0, 'old chest gone');
  });
});
