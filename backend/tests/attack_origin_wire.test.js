// SOMET-326 slice A, end to end on the SERVER side: an authored
// item_types.attack_origin becomes a resolved pixel anchor on the frames the
// client draws from.
//
// attackOrigin.js's own unit tests cover the resolver in isolation. What is
// under test HERE is the wiring -- that world.attack and ProjectileSim actually
// put the number on the wire. That distinction matters: the resolver being
// correct while nothing reads it is precisely the "column added, SELECT list
// not updated" inertness this repo has shipped three times.

const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { CREATURE_SIZE } = require('../src/authority/creatures.js');

// A 64px player at `middle` -- byte-for-byte the retired ISO_TILE_H/2 constant.
const PLAYER_MIDDLE = 32;
// A 48px creature at `middle`. The number the old shared constant got wrong.
const CREATURE_MIDDLE = 24;

const TYPES = new Map([
  [1, { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, attack_origin: null }],
  [2, { id: 2, name: 'javelin', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, attack_origin: 'head' }],
  [3, { id: 3, name: 'bow', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null, attack_origin: null }],
  [4, { id: 4, name: 'sling', category: 'weapon', kind: 'projectile', damage: 12, cooldown: 0.6, range: 700, projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, element: null, attack_origin: 'head' }],
]);

function armWorld() {
  return new World(
    { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] },
    TYPES, 1,
  );
}
const equip = (id, typeId) => ({ items: [{ id, typeId }], equipment: { main_hand: id } });

test('a melee swing carries its attacker body anchor on the wire', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  const { attacks } = w.attack('u1', 1, 0);
  assert.equal(attacks.length, 1);
  assert.equal(attacks[0].o, PLAYER_MIDDLE,
    'an unauthored weapon on a 64px player must be exactly the old constant (AC 3)');
});

test('an authored head origin launches higher than the default', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, equip('i2', 2));
  const { attacks } = w.attack('u1', 1, 0);
  assert.ok(attacks[0].o > PLAYER_MIDDLE,
    `head must sit above middle, got ${attacks[0].o} vs ${PLAYER_MIDDLE}`);
  assert.equal(attacks[0].o, Math.round(64 * 0.85));
});

test('an impact is anchored on the TARGET, not on the attacker', () => {
  // AC 2, and the most visible instance of the defect: a 48px creature struck
  // by a 64px player used to take its hit spark at the attacker's 32px
  // mid-body, which is 67% of the creature's own height -- floating at its
  // neck. The two numbers MUST differ here; equality is the bug.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  const { attacks, impacts } = w.attack('u1', 1, 0);
  assert.equal(impacts.length, 1, 'the swing must have connected for this test to mean anything');
  assert.equal(impacts[0].o, CREATURE_MIDDLE);
  assert.notEqual(impacts[0].o, attacks[0].o,
    'a creature impact must not inherit the player attacker anchor');
});

test('a head-origin weapon still lands its impact on the target body', () => {
  // Where a blow CONNECTS is a fact about who was hit; only where it launches
  // from is a fact about the weapon. A head-origin swing that also raised its
  // impact would put the spark above a creature's head.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, equip('i2', 2));
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 500, facing: 'S', color: '#f00' }]);
  const { impacts } = w.attack('u1', 1, 0);
  assert.equal(impacts[0].o, CREATURE_MIDDLE);
});

test('a projectile carries its launch anchor on every snapshot', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, equip('i3', 3));
  w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles[0].o, PLAYER_MIDDLE);
});

test('an authored origin reaches the projectile, not just the melee path', () => {
  // The projectile branch of attack() is a separate return path from the melee
  // branch, so it can (and initially did not) carry the anchor independently.
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, equip('i4', 4));
  w.attack('u1', 1, 0);
  assert.equal(w.snapshot().projectiles[0].o, Math.round(64 * 0.85));
});

test('a shot keeps its anchor after its shooter is gone', () => {
  // AC 4, and the reason a resolved NUMBER travels rather than an origin name:
  // there is no body left to measure a fraction against once the shooter is
  // removed, so a client-side resolution would have to guess or draw wrong.
  const w = armWorld();
  w.addPlayer('u1', { x: 0, y: 0 }, equip('i4', 4));
  w.attack('u1', 1, 0);
  const launched = w.snapshot().projectiles[0].o;
  w.removePlayer('u1');
  w.tickProjectiles(0.05);
  const inFlight = w.snapshot().projectiles;
  assert.equal(inFlight.length, 1, 'the shot must still be airborne for this to test anything');
  assert.equal(inFlight[0].o, launched);
});

test('the origin never moves what an attack actually hits', () => {
  // AC 6. The world is 2D; this is a render anchor. Two weapons identical in
  // every combat field but their origin must resolve the same kill.
  const kills = (typeId) => {
    const w = armWorld();
    w.addPlayer('u1', { x: 100, y: 100 }, equip('w', typeId));
    w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 5, facing: 'S', color: '#f00' }]);
    return w.attack('u1', 1, 0).kills;
  };
  assert.deepEqual(kills(1), kills(2));
  assert.deepEqual(kills(1), [{ id: 'c1', killerUserId: 'u1' }]);
});

test('CREATURE_SIZE is what the creature anchor is derived from', () => {
  // Guards the constant this file asserts against: if creatures stop being
  // 48px, CREATURE_MIDDLE above is stale and every assertion using it becomes
  // a test of a number nobody uses any more.
  assert.equal(CREATURE_SIZE, 48);
  assert.equal(Math.round(CREATURE_SIZE * 0.5), CREATURE_MIDDLE);
});
