const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, computeAuras } = require('../src/authority/creatures.js');

// SOMET-253 Task 5: pack-leader auras. Task 4 gave creature_behaviors its
// aura_radius/aura_damage_mult/aura_defense_mult/aura_speed_mult columns and a
// resolver that surfaces them as auraRadius/auraDamageMult/auraDefenseMult/
// auraSpeedMult -- nothing read them until now. This file pins three
// properties a plausible-but-wrong implementation gets wrong: a leader must
// not buff itself, two overlapping leaders must not compound (max, not
// multiply), and the buff must never be persisted onto the creature's own
// stats -- it is recomputed from scratch every tick and vanishes the instant
// its source does.

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const rng = () => 0.5; // deterministic, no roam redirect
function player(userId, x, y) {
  return { userId, x, y, width: 64, height: 64, hp: 100, maxHp: 100 };
}

// Minimal aura-bearing behaviour for the pure computeAuras tests below --
// computeAuras only ever reads these four fields off `c.behavior`, so this is
// deliberately NOT the full resolved-behaviour shape (no abilities, no
// chaseStyle): that shape belongs to the addCreatures/tick fixtures further
// down, which exercise the full sim instead of computeAuras directly.
function auraBehavior(over = {}) {
  return { auraRadius: 0, auraDamageMult: 1, auraDefenseMult: 1, auraSpeedMult: 1, ...over };
}

// Full resolved-behaviour fixture for the tick()-driven tests, mirroring the
// `behavior()` helper in authority_creature_styles.test.js: an ability half
// and a behaviour half, merged from a flat override bag.
const ABILITY_KEYS = new Set([
  'slot', 'attackKind', 'attackRange', 'attackCooldown',
  'projectileSpeed', 'projectileRadius', 'element', 'damageMult', 'knockback',
]);
function behavior(over = {}) {
  const ability = {
    slot: 1, name: 'Attack', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0,
  };
  const bh = {
    name: 'T', aggroRadius: 400, leashRadius: 800, chaseStyle: 'charge',
    preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    auraRadius: 0, auraDamageMult: 1, auraDefenseMult: 1, auraSpeedMult: 1,
    goldMin: 0, goldMax: 0,
  };
  for (const [k, v] of Object.entries(over)) {
    if (ABILITY_KEYS.has(k)) ability[k] = v; else bh[k] = v;
  }
  return { ...bh, abilities: [ability] };
}

test('a leader buffs a same-faction creature in range', () => {
  const leader = {
    id: 'L', x: 100, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    behavior: auraBehavior({ auraRadius: 200, auraDamageMult: 1.25, auraDefenseMult: 1.2, auraSpeedMult: 1.1 }),
  };
  const follower = { id: 'F', x: 150, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile' };
  const buffs = computeAuras([leader, follower]);
  const b = buffs.get('F');
  assert.ok(b, 'follower must be buffed');
  assert.equal(b.damageMult, 1.25);
  assert.equal(b.defenseMult, 1.2);
  assert.equal(b.speedMult, 1.1);
});

test('a leader does not buff itself', () => {
  const leader = {
    id: 'L', x: 100, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    behavior: auraBehavior({ auraRadius: 200, auraDamageMult: 1.25, auraDefenseMult: 1.2, auraSpeedMult: 1.1 }),
  };
  const buffs = computeAuras([leader]);
  assert.equal(buffs.has('L'), false, 'a lone Champion must not buff itself');
});

test('a leader does not buff the other faction', () => {
  const leader = {
    id: 'L', x: 100, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    behavior: auraBehavior({ auraRadius: 200, auraDamageMult: 1.25, auraDefenseMult: 1.2, auraSpeedMult: 1.1 }),
  };
  const guard = { id: 'G', x: 150, y: 100, width: 48, height: 48, hp: 50, faction: 'guard' };
  const buffs = computeAuras([leader, guard]);
  assert.equal(buffs.has('G'), false, 'a hostile Champion must not strengthen guards');
});

test('two overlapping leaders do not stack — the strongest single value wins', () => {
  const mkLeader = (id, x) => ({
    id, x, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile',
    behavior: auraBehavior({ auraRadius: 300, auraDamageMult: 1.25, auraDefenseMult: 1.25, auraSpeedMult: 1.25 }),
  });
  const l1 = mkLeader('L1', 100);
  const l2 = mkLeader('L2', 150);
  const follower = { id: 'F', x: 125, y: 100, width: 48, height: 48, hp: 50, faction: 'hostile' };
  const buffs = computeAuras([l1, l2, follower]);
  const b = buffs.get('F');
  // Two 1.25x leaders must give 1.25x, NOT 1.5625x (1.25 * 1.25). Asserting
  // the exact literal is what fails an implementation that multiplies.
  assert.equal(b.damageMult, 1.25);
  assert.equal(b.defenseMult, 1.25);
  assert.equal(b.speedMult, 1.25);
});

test('an out-of-range creature is unbuffed', () => {
  const leader = {
    id: 'L', x: 0, y: 0, width: 48, height: 48, hp: 50, faction: 'hostile',
    behavior: auraBehavior({ auraRadius: 100, auraDamageMult: 1.25, auraDefenseMult: 1.2, auraSpeedMult: 1.1 }),
  };
  // Centers: leader (24,24), follower (224,24) -> 200px apart, outside the
  // 100px aura radius.
  const follower = { id: 'F', x: 200, y: 0, width: 48, height: 48, hp: 50, faction: 'hostile' };
  const buffs = computeAuras([leader, follower]);
  assert.equal(buffs.has('F'), false, 'a creature outside the radius must be unbuffed');
});

test("an aura never mutates the creature's base stats", () => {
  const s = new CreatureSim(stubMap(), rng);
  const leaderBh = behavior({
    chaseStyle: 'hold', auraRadius: 300,
    auraDamageMult: 1.25, auraDefenseMult: 1.25, auraSpeedMult: 1.25,
  });
  const followerBh = behavior({ chaseStyle: 'hold' });
  s.addCreatures([
    { id: 'L', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', behavior: leaderBh, damage: 5 },
    { id: 'F', type: 'T', x: 120, y: 100, hp: 100, faction: 'hostile', behavior: followerBh, damage: 5 },
  ]);
  const active = new Set(['0,0', '0,1', '1,0', '1,1']);

  // 30 ticks inside the aura. `hold` never moves or attacks with no player
  // present, so the ONLY thing that can touch c.damage/c.speed each tick is
  // the aura machinery itself -- a naive `c.damage *= mult` implementation
  // would compound this to roughly 5 * 1.25^30 (~4000), not stay at 5.
  for (let i = 0; i < 30; i++) s.tick(0.1, active, [], i * 0.1);
  let follower = s.all().find((c) => c.id === 'F');
  assert.equal(follower.damage, 5, 'base damage must be untouched while buffed');
  assert.equal(follower.speed, 40, 'base speed must be untouched while buffed');

  // Move the follower far outside the aura and tick 30 more times.
  follower.x = 1_000_000;
  for (let i = 0; i < 30; i++) s.tick(0.1, active, [], i * 0.1);
  follower = s.all().find((c) => c.id === 'F');
  assert.equal(follower.damage, 5, 'base damage must still be untouched once out of range');
  assert.equal(follower.speed, 40, 'base speed must still be untouched once out of range');
});

test('the buff vanishes the tick after the leader dies', () => {
  const s = new CreatureSim(stubMap(), rng);
  const leaderBh = behavior({
    // aggroRadius: 0 keeps the leader from ever acquiring the player as its
    // OWN target -- `hold` alone only stops movement, it still attacks once
    // a target is acquired, which would otherwise land a second, unbuffed
    // hit on the player and corrupt this test's damage arithmetic.
    chaseStyle: 'hold', aggroRadius: 0, auraRadius: 300,
    auraDamageMult: 1.25, auraDefenseMult: 1, auraSpeedMult: 1,
  });
  s.addCreatures([
    { id: 'L', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', behavior: leaderBh },
    // Default (charge/melee) behaviour, base damage 5, placed within contact
    // range of the player below so the very first tick lands a hit.
    { id: 'F', type: 'T', x: 100, y: 100, hp: 100, faction: 'hostile', damage: 5 },
  ]);
  const p = player('u1', 120, 100);
  const active = new Set(['0,0', '0,1', '1,0', '1,1']);

  s.tick(0.05, active, [p], 0);
  assert.equal(p.hp, 100 - 5 * 1.25, 'buffed hit while the leader is alive');

  const leader = s.all().find((c) => c.id === 'L');
  leader.hp = 0; // kill the leader

  // Advance past the ability cooldown so the follower attacks again this tick.
  s.tick(1, active, [p], 1);
  assert.equal(p.hp, 100 - 5 * 1.25 - 5, 'unbuffed hit the tick after the leader dies');
});
