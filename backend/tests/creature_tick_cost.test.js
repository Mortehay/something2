const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures');

// A BUDGET measurement, gated behind an env var because it is slow and
// machine-sensitive:  MEASURE_TICK=1 npm test -- tests/creature_tick_cost.test.js
//
// Benchmarks CreatureSim directly rather than World, because CreatureSim is
// where the per-creature loops live and World would need weapons, projectiles,
// ground items and a player set to construct.
const RUN = process.env.MEASURE_TICK ? test : test.skip;

const CHUNK = 64;
const TILE = 100;

// A 224x224 world is 4 chunks of 64 tiles per side (224/64 = 3.5 -> 4).
// `active` is what a single player's neighbourhood covers: a 3x3 block of
// chunks. Everything outside it is frozen by the chunk gate.
function activeKeys() {
  const keys = new Set();
  for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) keys.add(`${cx},${cy}`);
  return keys;
}

// `leaders` of the population get the Champion behaviour (aura_radius 260),
// the ONLY aura-carrying behaviour in the catalog and exactly what Slice B
// promotes pack masters into.
//
// resolveInstanceBehavior(c) (src/authority/creatures.js) has three branches:
// a pre-resolved `c.behavior` object, a `c.behavior_name`-bearing row (routed
// through resolveBehavior in services/creatureBehaviors.js), or a
// faction-based fallback. `behavior_name` alone only supplies the `name`
// field -- resolveBehavior reads aura_radius/aura_damage_mult/
// aura_defense_mult/aura_speed_mult as SEPARATE row columns (num(row.aura_radius,
// DEFAULT_BEHAVIOR.auraRadius), etc.), not a lookup keyed off the name
// string. So `behavior_name: 'Champion'` with no aura_* columns resolves
// aura_radius to the DEFAULT_BEHAVIOR fallback of 0 -- a non-leader. The
// leader rows below therefore also carry the real Champion aura_* values
// (migration 1714440085000_behavior_auras.js: aura_radius 260, aura_damage_mult
// 1.25, aura_defense_mult 1.2, aura_speed_mult 1.1) alongside the rest of the
// real Champion catalog row (migration 1714440080000_creature_behaviors.js),
// so this fixture exercises resolveBehavior the same way the real per-chunk
// spawn loader's LEFT JOIN result does.
// CreatureSim's map interface (collision.js's resolveMove) needs isWalkable
// and speedAt, not just chunkSize -- an all-open stub matches every other
// CreatureSim fixture in this suite (e.g. authority_creature_auras.test.js's
// stubMap) and keeps movement cost in the measurement without touching a
// real ServerMap/database.
function stubMap() {
  return {
    chunkSize: CHUNK, width: 224, height: 224,
    isWalkable: () => true, speedAt: () => 1,
  };
}

function buildSim(n, leaders) {
  const sim = new CreatureSim(stubMap(), () => 0.5);
  const list = [];
  for (let i = 0; i < n; i++) {
    const isLeader = i < leaders;
    list.push({
      id: `c${i}`, type: 'Wolf',
      x: (i % 224) * TILE, y: Math.floor(i / 224) * TILE,
      hp: 10, level: 1, damage: 5, facing: 'S', faction: 'hostile',
      behavior_name: isLeader ? 'Champion' : 'Line',
      ...(isLeader ? {
        attack_kind: 'melee', attack_range: 65, attack_cooldown: 1.1,
        aggro_radius: 480, leash_radius: 900, chase_style: 'charge',
        preferred_range: 0, move_speed_mult: 1.05,
        aura_radius: 260, aura_damage_mult: 1.25, aura_defense_mult: 1.2, aura_speed_mult: 1.1,
      } : {}),
    });
  }
  sim.addCreatures(list);

  // ASSERT THE FIXTURE, do not trust it. addCreatures stamps
  // `behavior: resolveInstanceBehavior(c)`, and if that function does not read
  // the fields this fixture sets, every creature silently gets a non-aura
  // behaviour -- the benchmark then measures the cheap, chunk-scoped half of
  // the tick and reports a false all-clear, which is precisely the failure this
  // task exists to prevent.
  const actual = [...sim.creatures.values()]
    .filter((c) => c.behavior && c.behavior.auraRadius > 0).length;
  if (actual !== leaders) {
    throw new Error(
      `fixture built ${actual} aura-carrying creatures, expected ${leaders} -- `
      + 'the behaviour fields addCreatures reads do not match this fixture, so '
      + 'the benchmark would measure the wrong half of the tick');
  }
  return sim;
}

RUN('tick cost across population and leader count', () => {
  const active = activeKeys();
  const players = [{ userId: 'u1', x: 3200, y: 3200, width: 64, height: 64, hp: 100 }];
  const results = [];

  for (const [n, leaders] of [[2400, 6], [4500, 6], [4500, 50], [4500, 200]]) {
    const sim = buildSim(n, leaders);
    // Warm up so the JIT is not part of the measurement.
    for (let i = 0; i < 20; i++) sim.tick(1 / 60, active, players, i * 16);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 120; i++) sim.tick(1 / 60, active, players, i * 16);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 120;
    results.push({ n, leaders, ms });
    console.log(`[tick] ${n} creatures / ${leaders} leaders: ${ms.toFixed(3)} ms/tick`);
  }

  // The frame budget is 16ms and the creature sim is only one part of a tick,
  // so 8ms is the half-budget this asserts against. The 200-leader row is
  // EXPECTED to be the expensive one -- it is measured to inform Slice B, and
  // is deliberately not asserted on.
  for (const r of results.filter((x) => x.leaders <= 50)) {
    assert.ok(r.ms < 8,
      `${r.n} creatures / ${r.leaders} leaders cost ${r.ms.toFixed(3)} ms/tick, over the 8ms half-budget`);
  }
});
