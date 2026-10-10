// SOMET-609 (S9). A real seeded Elite boss loads through ENTITY_CATALOG_SELECT
// and hydrates with its tier, size and RESOLVED ally aura -- the aura is inert
// if this path ever drops AURAS_LATERAL. An ordinary creature is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { CreatureSim } = require('../src/authority/creatures.js');
const { DungeonBossManager, loadDungeonBossRow } = require('../src/authority/dungeonBosses.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('Ossuary Warden hydrates as a dungeon_elite boss carrying ossuary_dread', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    assert.equal(await loadDungeonBossRow(pool, 'Wolf'), null, 'an ordinary creature is not a dungeon boss');
    const mgr = new DungeonBossManager({ pool });
    const entry = {
      worldId: 'zz-s9-row',
      row: { dungeon_boss: { entity: 'Ossuary Warden', x: 4850, y: 4850, respawn_s: 600 }, level_min: 1, level_max: 7 },
      world: { creatures: new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 32 }, () => 0.05) },
    };
    const c = await mgr.place(entry);
    assert.ok(c, 'placed');
    assert.equal(c.bossTier, 'dungeon_elite');
    assert.equal(c.level, 5);
    assert.equal(c.width, 72);
    assert.deepEqual({ x: c.x, y: c.y }, { x: 4850 - 36, y: 4850 - 36 }, 'stands on its post (ruling P1)');
    assert.equal(c.damage, 14, 'base_damage reaches the sim through hydrateCreatureRow');
    const aura = (c.auras || []).find((a) => a.name === 'ossuary_dread');
    assert.ok(aura, `ossuary_dread resolved (got ${JSON.stringify(c.auras)})`);
    assert.equal(aura.targetSide, 'allies');
    assert.equal(Math.round(aura.defenseMult * 100) / 100, 1.3);
  } finally {
    await pool.end();
  }
});
