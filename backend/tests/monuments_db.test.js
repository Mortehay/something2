// SOMET-776: monuments through ensureStructures against a seeded test DB --
// the art gate, POI chests on the front tile, packs off the footprint.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { ensureStructures } = require('../src/services/worldStructures');
const { keyOf } = require('../src/services/ruinChests');
const { monumentFront } = require('../src/services/structureSites');
const { MONUMENT_TYPES } = require('../seeds/data/structureTypes.js');

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
const worldNamed = async (c, n) => (await c.query('SELECT * FROM worlds WHERE name = $1', [n])).rows[0];
const SPRITES = MONUMENT_TYPES.map((m) => m.sprite);
const giveArt = (c) => c.query(`UPDATE entity_types SET image = 'monument-test.png' WHERE name = ANY($1::text[])`, [SPRITES]);
const WORLD = 'Old Trailhead';

test('monument sprites are seeded as never-picked decorations', async (t) => {
  await withTxn(t, async (c) => {
    const { rows } = await c.query('SELECT name, walkable, spawn_tiles FROM entity_types WHERE name = ANY($1::text[]) ORDER BY name', [SPRITES]);
    assert.equal(rows.length, SPRITES.length);
    for (const r of rows) { assert.equal(r.walkable, false); assert.deepEqual(r.spawn_tiles, []); }
    const { loadDecorationDefs } = require('../src/services/decorationDefs');
    const defs = await loadDecorationDefs(c);
    assert.ok(!defs.some((d) => SPRITES.includes(d.name)), 'the clump pass never sees a monument');
  });
});

test('no approved sprite, no new monument (art gate)', async (t) => {
  await withTxn(t, async (c) => {
    await c.query(`UPDATE entity_types SET image = NULL WHERE name = ANY($1::text[])`, [SPRITES]);
    const w = await worldNamed(c, WORLD);
    await ensureStructures(c, w.id, { regenerate: true });
    const row = await worldNamed(c, WORLD);
    assert.equal(row.structures.filter((s) => s.kind === 'monument').length, 0);
  });
});

test('with art: monuments placed, each POI monument holds a chest on its front tile and a pack off its footprint; idempotent', async (t) => {
  await withTxn(t, async (c) => {
    await giveArt(c);
    const w = await worldNamed(c, WORLD);
    const monuments = MONUMENT_TYPES.map((m) => ({ ...m, poiChance: 1, biomes: [...new Set([...m.biomes, ...(w.biomes || []).map(String)])] }));
    const first = await ensureStructures(c, w.id, { monuments });
    const row = await worldNamed(c, WORLD);
    const mons = row.structures.filter((s) => s.kind === 'monument');
    assert.ok(mons.length > 0, `${WORLD} gets monuments (${JSON.stringify(first)})`);
    const { rows: chests } = await c.query('SELECT x, y, structure_key, guard_creature_ids FROM world_chests WHERE world_id = $1 AND structure_key IS NOT NULL', [w.id]);
    for (const m of mons) {
      const ch = chests.find((x) => x.structure_key === keyOf(m));
      if (!ch) continue; // a biome with no allowed creature stays scenery
      const f = monumentFront(m);
      assert.deepEqual([Math.floor(ch.y / 100), Math.floor(ch.x / 100)], [f.row, f.col], 'chest on the front tile');
      const { rows: g } = await c.query('SELECT x, y FROM world_creatures WHERE id = ANY($1::uuid[])', [ch.guard_creature_ids]);
      assert.ok(g.length >= 3);
      for (const cr of g) {
        const r = Math.floor(cr.y / 100), col = Math.floor(cr.x / 100);
        const on = r >= m.minRow && r < m.minRow + m.height && col >= m.minCol && col < m.minCol + m.width;
        assert.ok(!on, `guard inside ${m.type} footprint at ${r},${col}`);
      }
    }
    assert.ok(mons.some((m) => chests.some((x) => x.structure_key === keyOf(m))), 'at least one monument chest');
    // the seed-map order: ensure -> populate -> ensure. Re-laid creatures are
    // a new `avoid` set; the stored monuments must survive it unchanged.
    const { populateWorld } = require('../src/services/worldPopulation');
    await populateWorld(c, row, { rngSeed: Number(row.seed || 1) });
    const again = await ensureStructures(c, w.id, { monuments });
    assert.equal(again.changed, false);
    assert.equal(again.chestsAdded, 0);
    assert.equal(again.chestsRemoved, 0);
    // removing the art never moves a standing monument
    await c.query(`UPDATE entity_types SET image = NULL WHERE name = ANY($1::text[])`, [SPRITES]);
    assert.equal((await ensureStructures(c, w.id, { monuments })).changed, false);
  });
});
