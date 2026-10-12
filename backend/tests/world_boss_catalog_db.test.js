// backend/tests/world_boss_catalog_db.test.js
// SOMET-603 (S1, spec §7): the manager spawns from the real entity_types rows
// the seed migration wrote, through the real hydration into a real sim.
// Read-only against the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { WorldBossManager, loadWorldBossCatalog } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('the manager spawns world bosses from entity_types rows', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const catalog = await loadWorldBossCatalog(pool);
    assert.deepEqual(catalog.bosses.map((b) => b.name).sort(), [
      'Abyssor, the Voidreaver', 'Glacius, the Frost Leviathan',
      'Gorgon, the Thunder Titan', 'Ignis, the Magma Colossus',
    ]);
    assert.deepEqual([...catalog.minionsByElement.keys()].sort(), ['arcane', 'fire', 'ice', 'lightning']);

    const m = new WorldBossManager({ pool, rng: () => 0 });
    await m.refreshCatalog();
    const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
    const entry = { worldId: 'w1', row: { name: 'zz', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
    assert.equal(m.forceSpawn(Date.now(), new Map([['w1', entry]]), { bossName: 'Glacius, the Frost Leviathan' }), true);
    const c = sim.get(m.bossCreatureId);
    assert.equal(c.bossTier, 'world');
    assert.equal(c.element, 'ice');
    assert.equal(c.attackElement, 'ice');
    assert.equal(c.width, 96);
    assert.equal(c.maxHp, 14000);
    // Ruling P2: chaseStyle === 'charge' (or behavior.name === 'Line') cannot
    // fail -- Line IS DEFAULT_BEHAVIOR -- so assert on the joined row column,
    // which is null when the behaviour join misses.
    assert.ok(catalog.bosses.every((b) => b.behavior_name === 'Line'), 'every boss row carries its joined Line behaviour');
  } finally {
    await pool.end();
  }
});
