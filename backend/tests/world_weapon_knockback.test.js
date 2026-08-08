// SOMET-253 Task 9: player weapon knockback, applied in world.attack's melee
// branch (both the creature side and the player-vs-player loop). Mirrors
// Task 6's creature-ability knockback (authority_knockback_integration.test.js)
// but from the player's weapon instead of a creature's ability.
//
// No DB here -- World is exercised directly against a hand-built weapon
// catalog Map, same convention as authority_world_combat.test.js's TYPES/armWorld().
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

// All-grass map: every candidate tile is walkable, so a shove always lands
// at full distance and the test is purely about direction/gating, not the
// wall-fallback ladder (that ladder already has its own coverage in
// authority_knockback.test.js).
function armMap() {
  return { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
}

const KNOCKBACK_ID = 1;
const NO_KNOCKBACK_ID = 2;
const TYPES = new Map([
  // reach 80, arc wide enough to cover a target directly on the aim vector,
  // knockback 40 -- comfortably more than CREATURE_SIZE/PLAYER_W so the shove
  // is unambiguous against either target's own footprint.
  [KNOCKBACK_ID, { id: KNOCKBACK_ID, name: 'shove-dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 1.2, mana_cost: 0, element: null, knockback: 40 }],
  [NO_KNOCKBACK_ID, { id: NO_KNOCKBACK_ID, name: 'plain-dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 1.2, mana_cost: 0, element: null, knockback: 0 }],
]);

function armWorld(defaultWeaponId = KNOCKBACK_ID) {
  return new World(armMap(), TYPES, defaultWeaponId);
}

test("a melee swing shoves surviving creatures away from the player", () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }); // center 132,132
  // High-hp creature due east of u1, well within the swing's reach -- the
  // 8-damage dagger cannot kill it, so it survives to be shoved.
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 999, facing: 'S', color: '#f00' }]);
  const before = w.creatures.get('c1');
  const startX = before.x, startY = before.y;
  const { kills } = w.attack('u1', 1, 0); // aim due east
  assert.deepEqual(kills, []); // survived
  const after = w.creatures.get('c1');
  // Direction, not just displacement: shoved FURTHER east (away from the
  // player, along the same line), not just moved somewhere.
  assert.ok(after.x > startX, `expected creature pushed east, startX=${startX} after.x=${after.x}`);
  const dy = Math.abs(after.y - startY);
  assert.ok(dy < 5, `expected knockback to stay ~on the east line, dy=${dy}`);
});

test("a creature killed by the swing is not shoved", () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 });
  // Low-hp creature: the 8-damage dagger kills it outright.
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 1, facing: 'S', color: '#f00' }]);
  const { kills } = w.attack('u1', 1, 0);
  assert.deepEqual(kills, [{ id: 'c1', killerUserId: 'u1' }]);
  // The corpse must not exist to be shoved -- applyMeleeArc already deleted
  // it. If the implementation naively iterated meleeArcTargets (captured
  // BEFORE the swing) instead of targets-minus-killed, it would try to shove
  // an id no longer in the sim; get() must come back empty either way.
  assert.equal(w.creatures.get('c1'), undefined);
  assert.equal(w.creatures.has('c1'), false);
});

test("a weapon with knockback 0 moves nothing", () => {
  const w = armWorld(NO_KNOCKBACK_ID);
  w.addPlayer('u1', { x: 100, y: 100 });
  w.creatures.addCreatures([{ id: 'c1', type: 'wolf', x: 150, y: 108, hp: 999, facing: 'S', color: '#f00' }]);
  const before = w.creatures.get('c1');
  const startX = before.x, startY = before.y;
  const { kills } = w.attack('u1', 1, 0);
  assert.deepEqual(kills, []);
  const after = w.creatures.get('c1');
  // Guards against an implementation that applies some default/fallback
  // shove distance regardless of the weapon's own (zero) value.
  assert.equal(after.x, startX);
  assert.equal(after.y, startY);
});

test("a player hit by another player's swing is shoved", () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }); // attacker, center 132,132
  w.addPlayer('u2', { x: 150, y: 100 }); // target, center 182,132 -- due east, within reach 80... actually gap is 50 < 80
  const target = w.getPlayer('u2');
  const startX = target.x, startY = target.y;
  w.attack('u1', 1, 0); // aim due east
  // Took the swing's damage (sanity: the hit landed at all).
  assert.ok(target.hp < target.maxHp, 'expected the swing to have hit u2');
  assert.ok(target.x > startX, `expected u2 pushed east, startX=${startX} target.x=${target.x}`);
  const dy = Math.abs(target.y - startY);
  assert.ok(dy < 5, `expected knockback to stay ~on the east line, dy=${dy}`);
});
