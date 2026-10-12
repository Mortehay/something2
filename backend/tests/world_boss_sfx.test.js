// SOMET-605 (S2, spec §4.3/§4.4): the world boss's phase and enrage moments
// reach the creature sfx channel exactly once each, and the test-panel
// triggers drive the same code path the fight does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorldBossManager } = require('../src/authority/worldBoss');
const { CreatureSim } = require('../src/authority/creatures');

const bossRow = {
  id: 951, name: 'zzS2 Titan', color: '#ff4757', hp: 10000, max_hp: 10000, defense: 20,
  resistances: {}, faction: 'hostile', gold_min: 0, gold_max: 0, attack_element: 'fire',
  vfx: null, prompt: 'zz', boss_tier: 'world', element: 'fire', hitbox_size: 96, auras: null,
  xp_reward: 0, base_damage: 40, display_width: 96, display_height: 96, behavior_name: null, abilities: null,
};

async function fight({ lifetimeMs = 600000 } = {}) {
  const m = new WorldBossManager({
    bossIntervalMs: 600000, bossLifetimeMs: lifetimeMs, rng: () => 0,
    loadCatalog: async () => ({ bosses: [bossRow], minionsByElement: new Map() }),
  });
  await m.refreshCatalog();
  const sim = new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
  const entry = { worldId: 'w1', row: { name: 'Molten Core', width: 32, height: 32 }, waypoints: new Map(), world: { creatures: sim } };
  const worlds = new Map([['w1', entry]]);
  const now = Date.now();
  m.forceSpawn(now, worlds, {}, () => {});
  sim.sfx = []; // drop the spawn event (Task 4 covers it)
  return { m, sim, worlds, now, boss: sim.get(m.bossCreatureId) };
}
const events = (sim, e) => sim.sfx.filter((x) => x.e === e);

test('a phase transition emits one phase event at the boss centre', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 7000; // 70% -> phase 2
  m.tick(now + 1, worlds, () => {});
  const ph = events(sim, 'phase');
  assert.equal(ph.length, 1);
  assert.deepEqual(ph[0], { e: 'phase', c: 'zzS2 Titan', a: `c:${boss.id}`, x: Math.round(boss.x + 48), y: Math.round(boss.y + 48) });
  m.tick(now + 2, worlds, () => {});
  assert.equal(events(sim, 'phase').length, 1, 'no repeat while the phase holds');
});

test('a hit that skips from phase 1 to phase 3 emits ONE phase event', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 4000; // 40%
  m.tick(now + 1, worlds, () => {});
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(events(sim, 'phase').length, 1);
});

test('enrage fires once below 10% HP, not at 11%', async () => {
  const { m, sim, worlds, now, boss } = await fight();
  boss.hp = 1100; // 11%
  m.tick(now + 1, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 0);
  boss.hp = 900; // 9%
  const frames = [];
  m.tick(now + 2, worlds, (f) => frames.push(f));
  m.tick(now + 3, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 1, 'once per spawn');
  assert.equal(m.getStatus().enraged, true);
  assert.ok(frames.some((f) => f.kind === 'world_boss_enrage'));
});

test('enrage fires in the last 60 s of the lifetime, not at 70 s left', async () => {
  const { m, sim, worlds, now } = await fight({ lifetimeMs: 600000 });
  m.tick(now + 530000, worlds, () => {}); // 70 s left
  assert.equal(events(sim, 'enrage').length, 0);
  m.tick(now + 545000, worlds, () => {}); // 55 s left
  assert.equal(events(sim, 'enrage').length, 1);
  m.tick(now + 546000, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 1, 'never twice');
});

test('enrage by HP and then by timeout still fires only once', async () => {
  const { m, sim, worlds, now, boss } = await fight({ lifetimeMs: 600000 });
  boss.hp = 500;
  m.tick(now + 1, worlds, () => {});
  m.tick(now + 545000, worlds, () => {});
  assert.equal(events(sim, 'enrage').length, 1);
});

test('a lost boss re-placed by tick does not replay spawn', async () => {
  const { m, sim, worlds, now } = await fight();
  sim.remove(m.bossCreatureId);
  m.tick(now + 1, worlds, () => {});
  assert.ok(sim.get(m.bossCreatureId), 're-placed');
  assert.equal(events(sim, 'spawn').length, 0);
});

test('forcePhase advances exactly one phase through the real path, and stops at 4', async () => {
  const { m, sim, worlds } = await fight();
  const frames = [];
  assert.equal(m.forcePhase(worlds, (f) => frames.push(f)), true);
  assert.equal(m.currentBoss.phase, 2);
  assert.ok(frames.some((f) => f.kind === 'world_boss_phase' && f.phase === 2));
  assert.equal(m.forcePhase(worlds), true);
  assert.equal(m.currentBoss.phase, 3);
  assert.equal(m.forcePhase(worlds), true);
  assert.equal(m.currentBoss.phase, 4);
  assert.equal(m.forcePhase(worlds), false);
  assert.equal(events(sim, 'phase').length, 3);
});

test('forceEnrage enrages once; both triggers are false with no live boss', async () => {
  const { m, sim, worlds } = await fight();
  assert.equal(m.forceEnrage(worlds), true);
  assert.equal(m.forceEnrage(worlds), false);
  assert.equal(events(sim, 'enrage').length, 1);
  const idle = new WorldBossManager({ loadCatalog: async () => ({ bosses: [], minionsByElement: new Map() }) });
  assert.equal(idle.forcePhase(worlds), false);
  assert.equal(idle.forceEnrage(worlds), false);
});
