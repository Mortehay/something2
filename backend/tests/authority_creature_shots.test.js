const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
function walledMap() { return { isWalkable: () => false, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;

function ranged(over = {}) {
  return {
    name: 'R', attackKind: 'ranged', attackRange: 340, attackCooldown: 1.8,
    projectileSpeed: 520, projectileRadius: 6, aggroRadius: 460, leashRadius: 800,
    chaseStyle: 'kite', preferredRange: 240, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

function sim(bh, mapFn = openMap, element = 'physical') {
  const s = new CreatureSim(mapFn(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'R', x: 100, y: 100, hp: 100,
    behavior: bh, attackElement: element, damage: 7 }]);
  return s;
}
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

test('a ranged creature emits a shot at a target in range', () => {
  const s = sim(ranged());
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  const shot = shots[0];
  assert.equal(shot.ownerId, 'c');
  assert.equal(shot.ownerFaction, 'hostile');
  assert.equal(shot.element, 'physical');
  assert.equal(shot.damage, 7);
  assert.equal(shot.speed, 520);
  // Aimed east, at the player.
  assert.ok(shot.nx > 0.9, `expected an eastward aim, got nx=${shot.nx}`);
  assert.ok(Math.abs(Math.hypot(shot.nx, shot.ny) - 1) < 1e-9, 'aim must be normalized');
});

test('a melee creature never emits a shot', () => {
  const s = sim(ranged({ attackKind: 'melee', attackRange: 400 }));
  const player = { userId: 'u1', x: 200, y: 100, width: 48, height: 48, hp: 500, mit: null };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('no shot without line of sight', () => {
  const s = sim(ranged(), walledMap);
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0, 'must not shoot through a wall');
});

test('no shot at a target beyond attack range', () => {
  const s = sim(ranged({ attackRange: 100, aggroRadius: 460 }));
  const player = { userId: 'u1', x: 400, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 0);
});

test('the cooldown gates the rate of fire', () => {
  const s = sim(ranged({ attackCooldown: 1.0 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  let total = 0;
  // 1.0s of ticks at 0.1s: one shot at t=0, and the cooldown is not yet clear
  // by the tenth tick.
  for (let i = 0; i < 10; i++) total += s.tick(0.1, active, [player], i * 0.1).shots.length;
  assert.equal(total, 1, `expected exactly one shot in 1.0s, got ${total}`);
});

test('a cast creature fires its own element, a ranged one always physical', () => {
  const cast = sim(ranged({ attackKind: 'cast' }), openMap, 'fire');
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  assert.equal(cast.tick(0.1, active, [player], 0).shots[0].element, 'fire');

  const arrow = sim(ranged({ attackKind: 'ranged' }), openMap, 'fire');
  assert.equal(arrow.tick(0.1, active, [player], 0).shots[0].element, 'physical',
    'a ranged rung fires physical even when the line has an element');
});

test('a hold creature fires without moving', () => {
  const s = sim(ranged({ chaseStyle: 'hold', attackRange: 380 }));
  const player = { userId: 'u1', x: 380, y: 100, width: 48, height: 48, hp: 500 };
  const { shots } = s.tick(0.1, active, [player], 0);
  assert.equal(shots.length, 1);
  assert.equal(s.all()[0].x, 100, 'hold must not move');
});
