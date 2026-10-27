// backend/tests/helpers/championAuraTrace.js
// Golden-trace parity for S3 (SOMET-604), modelled on creatureTrace.js. One
// scenario, two ways of saying "this creature is a Champion pack leader":
//   legacyBind -- pre-S3: aura on the BEHAVIOUR (creature_behaviors.aura_*)
//   entityBind -- S3: aura on the ENTITY (entity_types.auras -> aura_effects)
// The fixture is recorded ONCE with legacyBind on unchanged code. After S3,
// entityBind must reproduce it exactly, and legacyBind must NOT (the old
// source is dead).
const { CreatureSim } = require('../../src/authority/creatures.js');

const CHAMPION = { radius: 260, damage: 1.25, defense: 1.2, speed: 1.1 }; // literals, 1714440085000

function legacyBind(row) {
  return { ...row, behavior: { auraRadius: CHAMPION.radius, auraDamageMult: CHAMPION.damage,
    auraDefenseMult: CHAMPION.defense, auraSpeedMult: CHAMPION.speed, chaseStyle: 'hold', aggroRadius: 0 } };
}
function entityBind(row) {
  return { ...row, behavior: { chaseStyle: 'hold', aggroRadius: 0 },
    auras: [{ name: 'pack_leader', targetSide: 'allies', radius: CHAMPION.radius,
      damageMult: CHAMPION.damage, defenseMult: CHAMPION.defense, speedMult: CHAMPION.speed }] };
}

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

// Two Champions 100px apart (overlapping auras), a follower inside BOTH, one
// inside only L2, one outside both, a guard-faction creature inside both (must
// never be buffed), and a player the in-range followers chase and hit, so the
// damage AND speed buffs reach the trace through hp and position.
function scenario(bind) {
  const sim = new CreatureSim(stubMap(), () => 0.5);
  sim.addCreatures([
    bind({ id: 'L1', type: 'Beast Champion', x: 300, y: 300, hp: 80, damage: 5, faction: 'hostile' }),
    bind({ id: 'L2', type: 'Beast Champion', x: 400, y: 300, hp: 80, damage: 5, faction: 'hostile' }),
    { id: 'both', type: 'Wolf', x: 350, y: 380, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'oneL2', type: 'Wolf', x: 620, y: 300, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'out', type: 'Wolf', x: 300, y: 700, hp: 40, damage: 5, faction: 'hostile' },
    { id: 'guard', type: 'Village Guard', x: 360, y: 320, hp: 60, damage: 5, faction: 'guard',
      home_x: 360, home_y: 320 },
  ]);
  const player = { userId: 'u1', x: 470, y: 450, width: 48, height: 48, hp: 400, mit: null };
  return { sim, players: [player] };
}

const r4 = (n) => Number(Number(n).toFixed(4));
function runChampionTrace(bind, ticks = 80, dt = 0.05) {
  const { sim, players } = scenario(bind);
  const active = new Set(['0,0', '0,1', '1,0', '1,1']);
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    sim.tick(dt, active, players, i * dt);
    trace.push({
      creatures: sim.all().map((c) => ({
        id: c.id, x: r4(c.x), y: r4(c.y), hp: r4(c.hp), mode: c.mode,
        buff: [r4(c._buff.damageMult), r4(c._buff.defenseMult), r4(c._buff.speedMult)],
      })),
      playerHp: r4(players[0].hp),
    });
  }
  return trace;
}

module.exports = { runChampionTrace, legacyBind, entityBind };
