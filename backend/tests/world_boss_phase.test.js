// backend/tests/world_boss_phase.test.js
// SOMET-603 (S1): phase transitions on a catalog-spawned boss; phase minions
// hydrate from the Elemental Guard catalog row for the boss's element.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const bossRow = {
  id: 901, name: 'zzMagma Boss', color: '#ff4757', hp: 12000, max_hp: 12000, defense: 25,
  resistances: {}, faction: 'hostile', gold_min: 500, gold_max: 500, attack_element: 'fire',
  vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
  xp_reward: 3500, base_damage: 42, display_width: 96, display_height: 96,
  behavior_name: null, abilities: null,
};
const minionRow = {
  // Distinct from the deleted hand-built minion stats (hp 1500, damage 25,
  // defense 15): a regression back to hand-built minions must turn RED.
  ...bossRow, id: 911, name: 'zzFire Guard', hp: 1700, max_hp: 1700, defense: 17,
  boss_tier: null, hitbox_size: null, xp_reward: null, base_damage: 31, gold_min: 0, gold_max: 0,
  display_width: null, display_height: null,
};

async function spawned(minions) {
  const m = new WorldBossManager({
    bossIntervalMs: 600000, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map(minions.map((r) => [r.element, r])) }),
  });
  await m.refreshCatalog();
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  const entry = { worldId: 'w1', row: { name: 'Molten Core', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  return { m, sim, worlds, now, boss: sim.get(m.bossCreatureId) };
}

test('phase 2 (Enraged) at 75% HP announces and speeds the boss up', async () => {
  const { m, worlds, now, boss } = await spawned([minionRow]);
  const before = boss.speed;
  boss.hp = 8000; // 66.6%
  const frames = [];
  m.tick(now + 1, worlds, (f) => frames.push(f));
  assert.equal(m.currentBoss.phase, 2);
  assert.equal(frames.find((f) => f.kind === 'world_boss_phase').phase, 2);
  assert.ok(boss.speed > before, `phase 2 must raise speed above ${before}, got ${boss.speed}`);
  // The phase multiplier scales the CATALOG damage (base_damage 42): 42 * 1.1.
  assert.equal(boss.damage, 46, 'phase 2 scales the catalog base_damage, not a fallback');
});

test('phase 3 at 50% HP spawns two minions hydrated from the element\'s catalog row', async () => {
  const { m, sim, worlds, now, boss } = await spawned([minionRow]);
  boss.hp = 6000;
  m.tick(now + 1, worlds, () => {});
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(boss.damage, 53, 'phase 3 scales the catalog base_damage: 42 * 1.25');
  const minions = sim.all().filter((c) => c.type === 'zzFire Guard');
  assert.equal(minions.length, 2);
  for (const c of minions) {
    assert.equal(c.maxHp, 1700);
    assert.equal(c.hp, 1700);
    assert.equal(c.damage, 31, 'minion damage is the catalog base_damage');
    assert.equal(c.bossTier, null, 'a minion is not a boss: its death must not end the event');
    assert.equal(c.width, 48);
    assert.equal(c.level, 80);
  }
});

// Review Focus 5.
test('a missing minion row spawns no minions and still advances the phase', async (t) => {
  const warns = t.mock.method(console, 'warn', () => {});
  const { m, sim, worlds, now, boss } = await spawned([]);
  boss.hp = 6000;
  assert.doesNotThrow(() => m.tick(now + 1, worlds, () => {}));
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(sim.count(), 1, 'only the boss itself');
  const minionLines = warns.mock.calls.filter((c) => /no minion row for element fire/.test(String(c.arguments[0])));
  assert.equal(minionLines.length, 1, 'one log line for the skipped phase');
});
