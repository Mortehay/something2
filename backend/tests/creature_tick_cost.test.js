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

// `leaders` of the population are Beast Champions carrying the pack_leader
// aura (radius 260), the ONLY aura bound in the catalog and exactly what
// Slice B promotes pack masters into.
//
// SOMET-604 (S3): auras live on the ENTITY now. applyAuras reads only
// `c.auras`, which addCreatures stamps via resolveInstanceAuras from the
// loader row's `aura_names`/`aura_defs` (et.auras + AURAS_LATERAL in
// server.js's CREATURE_JOINED_SELECT). The leader rows below carry exactly
// that shape, with pack_leader's seeded values (1714440680000: radius 260,
// damage 1.25, defense 1.2, speed 1.1). The behaviour half of the row (below)
// is unchanged and still drives chase/attack cost.
//
// resolveInstanceBehavior(c) (src/authority/creatures.js) has three branches:
// a pre-resolved `c.behavior` object, a `c.behavior_name`-bearing row (routed
// through resolveBehavior in services/creatureBehaviors.js), or a
// faction-based fallback. `behavior_name` alone only supplies the `name`
// field, so the leader rows also carry the rest of the real Champion catalog
// row (migration 1714440080000_creature_behaviors.js), exercising
// resolveBehavior the same way the real per-chunk spawn loader's LEFT JOIN
// result does.
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
        aura_names: ['pack_leader'],
        aura_defs: [{ name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25,
          defense_mult: 1.2, speed_mult: 1.1, dot_dps: 0, dot_element: 'physical', tick_ms: 1000 }],
      } : {}),
    });
  }
  sim.addCreatures(list);

  // ASSERT THE FIXTURE, do not trust it. addCreatures stamps
  // `auras: resolveInstanceAuras(c)`, and if that does not read the fields
  // this fixture sets, every creature silently carries no aura -- the
  // benchmark then measures the cheap, chunk-scoped half of the tick and
  // reports a false all-clear, which is precisely the failure this task exists
  // to prevent. The check reads the SAME field applyAuras reads (`c.auras`,
  // allies side, radius > 0); checking anything else (e.g. the pre-S3
  // behavior.auraRadius) would stay green while applyAuras sees nothing.
  const actual = [...sim.creatures.values()]
    .filter((c) => Array.isArray(c.auras)
      && c.auras.some((a) => a.targetSide === 'allies' && a.radius > 0)).length;
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
  // so 8ms is the half-budget this asserts against.
  //
  // ONLY the leaders<=6 rows gate this task's cap decision -- 6 leaders is
  // today's realistic population (one Champion per pack, packCount 6 at
  // swarm), and MAX_WORLD_CREATURES was raised specifically on the 4500/6
  // row staying under budget. The 50- and 200-leader rows are measured to
  // INFORM Slice B's design (pack masters promoted to Champion, so leader
  // count scales with world size), not to gate this one, and they are
  // deliberately left unasserted:
  //
  //   - applyAuras is O(sources x all) and unscoped by the chunk gate, so
  //     its cost is dominated by leader count, not headcount -- 4500/50
  //     already spends most of the 8ms half-budget (~7-12ms observed,
  //     depending on machine load) and 4500/200 blows well past the WHOLE
  //     16ms frame budget (~26-41ms observed). Both numbers are real and
  //     load-bearing for Slice B: it must bound leader count or index
  //     applyAuras spatially before every pack gets an aura-carrying
  //     master, or the tick blows its budget long before MAX_WORLD_CREATURES
  //     is reached.
  //   - Asserting on them here would make this benchmark flake on machine
  //     load alone (the 50-leader row has been observed on both sides of
  //     8ms across repeated runs on a loaded dev machine) with no actual
  //     regression involved -- a flaking assertion trains people to ignore
  //     the whole benchmark, which is worse than not asserting at all.
  //
  // Do not "helpfully" restore an assertion on the 50/200-leader rows: their
  // job is to print a number for the next slice to design against, not to
  // pass or fail this one.
  for (const r of results.filter((x) => x.leaders <= 6)) {
    assert.ok(r.ms < 8,
      `${r.n} creatures / ${r.leaders} leaders cost ${r.ms.toFixed(3)} ms/tick, over the 8ms half-budget`);
  }
});

// SOMET-606 (S4): the enemies-side pass, gated on ITS OWN overhead. The whole
// sim tick with 20 players in aggro range costs far more than the aura pass
// (player-driven creature AI), so an absolute budget here measures the wrong
// thing and flakes on host load. Instead: same layout, same process,
// alternating enemy auras ON / OFF, best of N each, and assert the delta; plus
// the pass itself (applyEnemyAuras + chargeAuraDots) timed directly.
RUN('enemy-aura overhead with 20 players inside 6 enemy sources', () => {
  const { applyEnemyAuras, chargeAuraDots } = require('../src/authority/creatures');
  const active = activeKeys();
  // 50 ms steps: the creature pass (and so the aura pass) runs on every step.
  const ENEMY = { name: 'blight', targetSide: 'enemies', radius: 400, damageMult: 0.8, defenseMult: 0.8,
    speedMult: 0.7, dotDps: 0.001, dotElement: 'fire', tickMs: 1000 };
  function run(withAura) {
    const sim = buildSim(4500, 6);
    const src = [];
    for (const c of sim.creatures.values()) {
      if (src.length >= 6) break;
      if (c.auras && c.auras.length) continue;      // not one of the ally leaders
      if (withAura) c.auras = [{ ...ENEMY }];
      src.push(c);
    }
    const players = src.length === 6 ? [] : null;
    if (!players) throw new Error(`fixture built ${src.length} candidate sources, expected 6`);
    for (let k = 0; k < 20; k++) {
      const s = src[k % 6];
      players.push({ userId: `u${k}`, x: s.x + 20 + k, y: s.y, width: 64, height: 64, hp: 1e9, maxHp: 1e9, mit: null });
    }
    for (let i = 0; i < 20; i++) sim.tick(0.05, active, players, i * 50);
    const inside = players.every((p) => p._buff && p._buff.auras);
    if (withAura && !inside) throw new Error('fixture: players are not inside the enemy auras');
    if (!withAura && players.some((p) => p._buff && p._buff.auras)) throw new Error('control leaked an enemy aura');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 60; i++) sim.tick(0.05, active, players, (20 + i) * 50);
    const tickMs = Number(process.hrtime.bigint() - t0) / 1e6 / 60;
    let passMs = null;
    if (withAura) {
      const all = [...sim.creatures.values()];
      let best = Infinity;
      for (let r = 0; r < 5; r++) {
        const t1 = process.hrtime.bigint();
        for (let i = 0; i < 40; i++) {
          const d = applyEnemyAuras(all, players);
          for (const p of players) p._buff = d.get(p.userId) || p._buff;
          chargeAuraDots(players, (200 + r * 40 + i) * 50);
        }
        best = Math.min(best, Number(process.hrtime.bigint() - t1) / 1e6 / 40);
      }
      passMs = best;
    }
    return { tickMs, passMs };
  }
  let onBest = Infinity; let offBest = Infinity; let passBest = Infinity;
  for (let round = 0; round < 8; round++) {
    const off = run(false); const on = run(true);
    offBest = Math.min(offBest, off.tickMs);
    onBest = Math.min(onBest, on.tickMs);
    passBest = Math.min(passBest, on.passMs);
  }
  const delta = onBest - offBest;
  console.log(`[tick] enemy auras ON ${onBest.toFixed(3)} vs OFF ${offBest.toFixed(3)} ms/tick `
    + `(delta ${delta.toFixed(3)}); pass+dots alone ${passBest.toFixed(3)} ms; load ${require('os').loadavg()[0].toFixed(1)}`);
  assert.ok(delta < 2, `enemy auras add ${delta.toFixed(3)} ms/tick, over the 2ms budget`);
  assert.ok(passBest < 1, `applyEnemyAuras + chargeAuraDots cost ${passBest.toFixed(3)} ms, over the 1ms budget`);
});
