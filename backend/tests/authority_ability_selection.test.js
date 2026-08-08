// SOMET-253 Task 2: which ability a creature actually uses on a given tick.
//
// Every test here asserts the LOSER as well as the winner. "The ready ability
// fired" passes against an implementation with no cooldown logic at all, and
// "something fired" passes against one that always picks slot 1 -- so each
// case is built so that a wrong pick produces a different, checkable outcome
// (a different damage number, a shot instead of a bite, or nothing at all).
const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;
const ACTIVE = new Set(['0,0', '0,1', '1,0', '1,1']);

function ability(over = {}) {
  return {
    slot: 1, name: 'A', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, element: null, damageMult: 1, knockback: 0,
    ...over,
  };
}

// `hold` so the creature never moves: every distance below is the distance the
// selection actually saw, not one the chase step already changed.
function behavior(abilities, over = {}) {
  return {
    name: 'T', abilities, aggroRadius: 900, leashRadius: 1200,
    chaseStyle: 'hold', preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

// Creature centre lands at (124,124) for a 48px creature at (100,100); the
// player is 48px too, so a player at x = 100 + d has its centre exactly d px
// east of the creature's.
function scenario(bh, playerX, { damage = 10, element = 'physical' } = {}) {
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100,
    behavior: bh, attackElement: element, damage }]);
  const player = { userId: 'u1', x: playerX, y: 100, width: 48, height: 48, hp: 1000, mit: null };
  return { s, player };
}

test('the lowest ready in-range slot wins', () => {
  // Both ready, both reach. Slot 1 deals 10 (mult 1), slot 2 would deal 30
  // (mult 3) -- so the hp delta names the winner rather than merely proving
  // "an attack happened".
  const bh = behavior([
    ability({ slot: 1, attackRange: 200, attackCooldown: 5, damageMult: 1 }),
    ability({ slot: 2, attackRange: 200, attackCooldown: 5, damageMult: 3 }),
  ]);
  const { s, player } = scenario(bh, 150);
  s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(player.hp, 990, 'slot 1 (10 damage) must win over slot 2 (30 damage)');
});

test('a slot on cooldown is skipped in favour of a higher slot', () => {
  // Slot 1: 4s cooldown, mult 1. Slot 2: 0.5s cooldown, mult 3.
  // Fire once (slot 1, -10), advance 0.6s -- longer than slot 2's cooldown,
  // far short of slot 1's. Slot 2 must fire, for -30.
  //
  // An implementation with ONE shared cooldown fires nothing on the second
  // tick (hp stays 990). One with no cooldown logic at all fires slot 1 again
  // (hp 980). Only per-slot cooldowns give 960.
  const bh = behavior([
    ability({ slot: 1, attackRange: 200, attackCooldown: 4, damageMult: 1 }),
    ability({ slot: 2, attackRange: 200, attackCooldown: 0.5, damageMult: 3 }),
  ]);
  const { s, player } = scenario(bh, 150);
  s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(player.hp, 990, 'the first tick must be slot 1');
  // 0.6s of ticks: slot 2 recovers (0.5), slot 1 does not (4.0). The first
  // tick past slot 2's recovery re-arms it, so exactly one extra hit lands.
  s.tick(0.6, ACTIVE, [player], 0.65);
  assert.equal(player.hp, 960,
    'slot 2 (30 damage) must fire while slot 1 is still recovering — '
    + '990 would mean one shared cooldown, 980 would mean no cooldown logic');
});

test('an out-of-range ability is skipped for one that reaches', () => {
  // Target at 200px: slot 1 is melee/90, slot 2 is cast/260. Slot 2 fires.
  const bh = behavior([
    ability({ slot: 1, attackKind: 'melee', attackRange: 90, attackCooldown: 1.2, damageMult: 5 }),
    ability({ slot: 2, attackKind: 'cast', attackRange: 260, attackCooldown: 2,
      projectileSpeed: 460, projectileRadius: 10, damageMult: 1 }),
  ]);
  const { s, player } = scenario(bh, 300, { element: 'fire' }); // centre-to-centre 200px
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots.length, 1, 'the reaching cast must fire');
  assert.equal(shots[0].speed, 460, 'the shot must carry slot 2\'s own projectile speed');
  assert.equal(shots[0].range, 260);
  assert.equal(shots[0].damage, 10, 'slot 2\'s mult is 1 — a 50 here would mean slot 1 was picked');
  assert.equal(player.hp, 1000, 'the melee slot must NOT have landed: it does not reach 200px');
});

test('when nothing qualifies the creature fires nothing', () => {
  // Both abilities out of range. It must NOT fall back to slot 1.
  const bh = behavior([
    ability({ slot: 1, attackRange: 60 }),
    ability({ slot: 2, attackKind: 'ranged', attackRange: 100, projectileSpeed: 400 }),
  ]);
  const { s, player } = scenario(bh, 500); // centre-to-centre 400px
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots.length, 0, 'no shot may be emitted');
  assert.equal(player.hp, 1000, 'no damage may be dealt');
  // And nothing may be put on cooldown for the attack that never happened.
  assert.equal(s.all()[0]._abilityCd.size, 0,
    'a refused selection must not stamp a cooldown');
});

test('every ability on cooldown means nothing fires, even in range', () => {
  const bh = behavior([
    ability({ slot: 1, attackRange: 200, attackCooldown: 5, damageMult: 1 }),
    ability({ slot: 2, attackRange: 200, attackCooldown: 5, damageMult: 3 }),
  ]);
  const { s, player } = scenario(bh, 150);
  s.tick(0.05, ACTIVE, [player], 0);      // slot 1 fires
  assert.equal(player.hp, 990);
  s.tick(0.05, ACTIVE, [player], 0.05);   // slot 1 recovering
  assert.equal(player.hp, 960, 'slot 2 is still ready and must take the second tick');
  s.tick(0.05, ACTIVE, [player], 0.1);    // both recovering
  assert.equal(player.hp, 960, 'with both slots recovering the creature must fire nothing');
});

test('cooldowns are per-instance, not per-behaviour', () => {
  // ONE behaviour object shared by two creatures, exactly as loadCreatureTypes
  // hands one resolved profile to every creature of a type. A cooldown stored
  // on the shared object would silence the second creature.
  const shared = behavior([ability({ slot: 1, attackRange: 200, attackCooldown: 5, damageMult: 1 })]);
  const s = new CreatureSim(openMap(), noRedirect);
  s.addCreatures([
    { id: 'a', type: 'T', x: 100, y: 100, hp: 100, behavior: shared, damage: 10 },
    { id: 'b', type: 'T', x: 100, y: 100, hp: 100, behavior: shared, damage: 10 },
  ]);
  const player = { userId: 'u1', x: 250, y: 100, width: 48, height: 48, hp: 1000, mit: null };
  s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(player.hp, 980, 'both creatures must land their own hit on the same tick');
  const [a, b] = s.all();
  assert.notStrictEqual(a._abilityCd, b._abilityCd, 'the cooldown maps must not be the same object');
  assert.equal(a._abilityCd.get(1), 5);
  assert.equal(b._abilityCd.get(1), 5);
});

test('a cast ability\'s own element wins over the creature type\'s', () => {
  // Slot 1 is out of range so slot 2 is what fires — and slot 2 carries an
  // explicit element while the creature type is 'fire'.
  const bh = behavior([
    ability({ slot: 1, attackKind: 'melee', attackRange: 60 }),
    ability({ slot: 2, attackKind: 'cast', attackRange: 300, attackCooldown: 2,
      projectileSpeed: 420, element: 'ice' }),
  ]);
  const { s, player } = scenario(bh, 300, { element: 'fire' });
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots[0].element, 'ice', 'the ability\'s own element must win');
});

test('a cast ability with element null inherits the creature type\'s element', () => {
  const bh = behavior([
    ability({ slot: 1, attackKind: 'cast', attackRange: 300, attackCooldown: 2,
      projectileSpeed: 420, element: null }),
  ]);
  const { s, player } = scenario(bh, 300, { element: 'fire' });
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots[0].element, 'fire',
    'element null means "inherit the type\'s attack_element" — a hard \'physical\' '
    + 'default here would silently strip a Caster\'s fire');
});

test('a ranged ability fires physical regardless of its own element', () => {
  const bh = behavior([
    ability({ slot: 1, attackKind: 'ranged', attackRange: 300, attackCooldown: 2,
      projectileSpeed: 420, element: 'ice' }),
  ]);
  const { s, player } = scenario(bh, 300, { element: 'fire' });
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots[0].element, 'physical');
});

test('damageMult of 0 lands a real hit that deals nothing (a pure status rider)', () => {
  // The status-rider case the whole `num()`-not-`|| 1` treatment exists for.
  // The attack must still HAPPEN (cooldown stamped, shot emitted) — it just
  // carries no damage.
  const bh = behavior([
    ability({ slot: 1, attackKind: 'cast', attackRange: 300, attackCooldown: 2,
      projectileSpeed: 420, element: 'ice', damageMult: 0 }),
  ]);
  const { s, player } = scenario(bh, 300);
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots.length, 1, 'a 0-damage ability still fires');
  assert.equal(shots[0].damage, 0, 'a damageMult of 0 must survive — `|| 1` would make this 10');
  assert.equal(s.all()[0]._abilityCd.get(1), 2, 'and it still serves its cooldown');
});

test('damageMult scales a melee ability\'s damage', () => {
  const bh = behavior([ability({ slot: 1, attackRange: 200, damageMult: 2.5 })]);
  const { s, player } = scenario(bh, 150, { damage: 8 });
  s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(player.hp, 980, '8 damage at mult 2.5 is 20');
});

test('a damageOverride is multiplied by the ability, not replaced by it', () => {
  const bh = behavior([ability({ slot: 1, attackRange: 200, damageMult: 2 })],
    { damageOverride: 25 });
  const { s, player } = scenario(bh, 150, { damage: 8 });
  s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(player.hp, 950, 'the override (25) times the mult (2) is 50, not 25 and not 16');
});

test('a blocked shot stamps no cooldown, so the creature fires the instant it has a lane', () => {
  // The line-of-sight refusal must behave exactly like the canAct refusal:
  // the attack does not happen AND the slot is not put on cooldown.
  const walled = { isWalkable: () => false, speedAt: () => 1, chunkSize: 8 };
  const s = new CreatureSim(walled, noRedirect);
  const bh = behavior([ability({ slot: 1, attackKind: 'ranged', attackRange: 300,
    attackCooldown: 5, projectileSpeed: 400 })]);
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100, behavior: bh, damage: 10 }]);
  const player = { userId: 'u1', x: 300, y: 100, width: 48, height: 48, hp: 1000, mit: null };
  const { shots } = s.tick(0.05, ACTIVE, [player], 0);
  assert.equal(shots.length, 0, 'no line of sight, no shot');
  assert.equal(s.all()[0]._abilityCd.size, 0,
    'a shot refused for line of sight must NOT serve a cooldown');
});
